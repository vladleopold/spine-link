import test from 'node:test';
import previewHandler from '../api/github-preview.js';
import assetHandler from '../api/github-asset.js';
import assert from 'node:assert/strict';
import {isValidSpineAtlasHeader, extractAtlasPageNames, atlasPageMatchesTexture, matchAtlasPagesToTextures} from '../lib/spine-atlas-integrity.js';
test('valid Spine 3.x and 4.x atlas page headers accepted',()=>{
 assert.equal(isValidSpineAtlasHeader('hero.png\nsize:2048,2048\nfilter:Linear,Linear\npma:true\nhero\nbounds:0,0,5,5'),true);
 assert.equal(isValidSpineAtlasHeader('hero.png\nsize:2048,2048\nformat:RGBA8888\nfilter:Linear,Linear\nrepeat:none'),true);
});
test('binary mislabeled atlas and metadata rejected',()=>{
 assert.equal(isValidSpineAtlasHeader('\\u001dKNPO>FjJS+9G\\u0005\\u000b\\u0018'),false);
 assert.equal(isValidSpineAtlasHeader('{\"defaultSkin\":\"Lamb\"}'),false);
 assert.equal(isValidSpineAtlasHeader(''),false);
});

test('every atlas page must map to one exact distinct source texture', async () => {
 const {matchAtlasPagesToTextures}=await import('../lib/spine-atlas-integrity.js');
 const textures=['body.png','face.png'];
 const exact=(texture,page)=>texture.toLowerCase()===page.toLowerCase();
 assert.deepEqual(matchAtlasPagesToTextures(['body.png','face.png'],textures,exact),textures);
 assert.equal(matchAtlasPagesToTextures(['body.png','missing.png'],textures,exact),null);
 assert.equal(matchAtlasPagesToTextures(['body.png','body.png'],textures,exact),null,
   'one texture must not silently stand in for two atlas pages');
 assert.equal(matchAtlasPagesToTextures(['body.png'],['body.png','BODY.PNG'],exact),null,
   'ambiguous case-insensitive matches must be blocked');
 assert.equal(matchAtlasPagesToTextures([],textures,exact),null);
});

test('preview runtime never injects a transparent placeholder for an unmatched atlas page', async () => {
 const {readFileSync}=await import('node:fs');
 const source=readFileSync(new URL('../api/github-preview.js',import.meta.url),'utf8');
 assert.match(source,/matchAtlasPagesToTextures\(\s*atlasPages,\s*textures,/);
 assert.match(source,/SPINE_ATLAS_TEXTURE_SET_INCOMPLETE/);
 assert.doesNotMatch(source,/data:image\/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB/);
});

test('manual Spine import blocks incomplete or ambiguous atlas textures instead of inventing transparent pages', async () => {
 const {readFileSync}=await import('node:fs');
 const source=readFileSync(new URL('../src/SpineApp.tsx',import.meta.url),'utf8');
 assert.match(source,/matchAtlasPagesToTextures\(\s*atlasPages,\s*images,/);
 assert.match(source,/SPINE_ATLAS_TEXTURE_SET_INCOMPLETE/);
 assert.match(source,/const matchedImage = textureMatches\[pageIndex\]/);
 assert.match(source,/return atlasPageMatchesTexture\(imageName,\s*pageName\)/);
 assert.doesNotMatch(source,/transparentPngDataUri/);
});

test('atlas page parser ignores region names that happen to end in image extensions', () => {
 const atlas = [
  'page.png', 'size:1024,1024', 'format:RGBA8888', 'filter:Linear,Linear', 'repeat:none', '',
  'region.png', 'rotate:false', 'xy:0,0', 'size:32,32', 'orig:32,32', 'offset:0,0', 'index:-1',
 ].join('\n');
 assert.deepEqual(extractAtlasPageNames(atlas), ['page.png']);
});

test('server upload acceptance requires every atlas page to have one unique exact texture', async () => {
 const texturePaths = ['images/body.png', 'images/face.png'];
 const exact = (texture, page) => atlasPageMatchesTexture(texture, page);
 assert.deepEqual(matchAtlasPagesToTextures(['body.png', 'face.png'], texturePaths, exact), texturePaths);
 assert.equal(matchAtlasPagesToTextures(['body.png', 'missing.png'], texturePaths, exact), null);
 assert.equal(matchAtlasPagesToTextures(['body.png', 'face.png'], ['images/body.png'], exact), null);
 const {readFileSync}=await import('node:fs');
 const upload=readFileSync(new URL('../api/github-upload.js',import.meta.url),'utf8');
 assert.match(upload,/matchAtlasPagesToTextures\(\s*atlasPages,\s*texturePaths,/);
 assert.match(upload,/rejected-incomplete-atlas-texture-set/);
});


function mockHttpResponse() {
 return {
  headers:{},code:200,body:null,
  setHeader(name,value){this.headers[name.toLowerCase()]=value;return this;},
  status(value){this.code=value;return this;},
  send(value){this.body=value;return this;},
  json(value){this.body=value;return this;},
  end(){return this;},
 };
}
function saveGitHubEnvironment() {
 const keys=['GITHUB_TOKEN','GITHUB_OWNER','GITHUB_REPO','GITHUB_BRANCH','GITHUB_BASE_PATH'];
 return Object.fromEntries(keys.map(key=>[key,process.env[key]]));
}
function restoreGitHubEnvironment(saved) {
 for(const [key,value] of Object.entries(saved)){
  if(value===undefined)delete process.env[key];else process.env[key]=value;
 }
}

test('a /p page recovers its indexed source set from public raw files when Contents API returns 403',async()=>{
 const oldFetch=globalThis.fetch,saved=saveGitHubEnvironment(),branch='test-preview-403-fallback';
 const entry={id:'api-403-preview',title:'API 403 regression',uploadedAt:'2026-11-22T00:00:00.000Z',
  previewPath:'library_02/api-403-preview',files:['hero.json','hero.atlas','hero.png'],
  skeleton:'hero.json',atlas:'hero.atlas',textures:['hero.png'],animations:['walk'],defaultAnimation:'walk',
  webmStatus:'blocked',previewStatus:'blocked'};
 const atlas=['hero.png','size:64,64','format:RGBA8888','filter:Linear,Linear','repeat:none','','hero','bounds:0,0,64,64'].join(String.fromCharCode(10));
 const skeleton=JSON.stringify({skeleton:{spine:'4.2',x:0,y:0,width:64,height:64},bones:[{name:'root'}],slots:[],skins:{default:{}},animations:{walk:{}}});
 const requests=[];
 globalThis.fetch=async input=>{
  const url=String(input);requests.push(url);
  if(url.startsWith('https://api.github.com/'))return new Response('rate limited',{status:403});
  if(url.startsWith('https://raw.githubusercontent.com/')){
   const path=new URL(url).pathname;
   if(path.endsWith('/library_02/index.json'))return new Response(JSON.stringify([entry]));
   if(path.endsWith('/api-403-preview/hero.atlas'))return new Response(atlas);
   if(path.endsWith('/api-403-preview/hero.json'))return new Response(skeleton);
   if(path.endsWith('/library/archive-exclusions.json'))return new Response(JSON.stringify({rules:[],allow:[]}));
   if(path.endsWith('/library/metrics.json')||path.endsWith('/library/censorship.json'))return new Response('{}');
   return new Response('not found',{status:404});
  }
  return new Response('not found',{status:404});
 };
 process.env.GITHUB_TOKEN='test-token';process.env.GITHUB_OWNER='vladleopold';process.env.GITHUB_REPO='spine';
 process.env.GITHUB_BRANCH=branch;process.env.GITHUB_BASE_PATH='library';
 try{
  const res=mockHttpResponse();
  await previewHandler({method:'GET',headers:{host:'spine-link.vercel.app'},query:{entry:entry.id}},res);
  assert.equal(res.code,200);
  const html=String(res.body);
  assert.ok(html.includes('/assets/library_02/api-403-preview/hero.png'));
  assert.ok(html.includes('walk'));
  assert.ok(!html.includes('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'),
   '403 recovery must not inject a transparent texture placeholder');
  assert.ok(requests.some(url=>url.startsWith('https://raw.githubusercontent.com/')&&url.endsWith('/library_02/index.json')));
  assert.ok(requests.some(url=>url.startsWith('https://raw.githubusercontent.com/')&&url.endsWith('/api-403-preview/hero.atlas')));
 }finally{globalThis.fetch=oldFetch;restoreGitHubEnvironment(saved);}
});

test('asset delivery uses the exact raw source on Contents API 403 and preserves byte ranges',async()=>{
 const oldFetch=globalThis.fetch,saved=saveGitHubEnvironment(),branch='test-asset-403-fallback';
 const webpBytes=Buffer.from([0x52,0x49,0x46,0x46,0x04,0x00,0x00,0x00,0x57,0x45,0x42,0x50]);
 const webmChunk=Buffer.from([0x1a,0x45,0xdf,0xa3]);
 let seenRange='';
 globalThis.fetch=async(input,init={})=>{
  const url=String(input);
  if(url.startsWith('https://api.github.com/'))return new Response('rate limited',{status:403});
  if(url.startsWith('https://raw.githubusercontent.com/')){
   if(url.endsWith('/preview-medium.webp'))return new Response(webpBytes,{status:200,headers:{etag:'"raw-webp"','content-length':String(webpBytes.length)}});
   if(url.endsWith('/preview.webm')){
    seenRange=init.headers?.Range||'';
    return new Response(webmChunk,{status:206,headers:{etag:'"raw-webm"','content-range':'bytes 0-3/100','content-length':'4'}});
   }
  }
  return new Response('not found',{status:404});
 };
 process.env.GITHUB_TOKEN='test-token';process.env.GITHUB_OWNER='vladleopold';process.env.GITHUB_REPO='spine';
 process.env.GITHUB_BRANCH=branch;
 try{
  const imageResponse=mockHttpResponse();
  await assetHandler({method:'GET',headers:{host:'spine-link.vercel.app'},query:{path:'library_02/api-403-preview/preview-medium.webp'}},imageResponse);
  assert.equal(imageResponse.code,200);
  assert.equal(imageResponse.headers['content-type'],'image/webp');
  assert.deepEqual(imageResponse.body,webpBytes);
  const videoResponse=mockHttpResponse();
  await assetHandler({method:'GET',headers:{host:'spine-link.vercel.app',range:'bytes=0-3'},query:{path:'library_02/api-403-preview/preview.webm'}},videoResponse);
  assert.equal(videoResponse.code,206);
  assert.equal(videoResponse.headers['content-range'],'bytes 0-3/100');
  assert.equal(seenRange,'bytes=0-3');
  assert.deepEqual(videoResponse.body,webmChunk);
 }finally{globalThis.fetch=oldFetch;restoreGitHubEnvironment(saved);}
});
