import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/github-archive.js';

function response() {
  return {
    headers:{},code:200,body:null,
    setHeader(k,v){this.headers[k.toLowerCase()]=v;return this;},
    status(v){this.code=v;return this;},
    send(v){this.body=v;return this;},
    json(v){this.body=v;return this;},
    end(){return this;},
  };
}
const entries=Array.from({length:80},(_,i)=>({
  id:'card-'+String(i).padStart(3,'0'),
  uploadedAt:new Date(Date.UTC(2026,0,1,0,i)).toISOString(),
  title:'Card '+i,
  previewPath:'library_02/card-'+i,
  skeleton:'skeleton-'+i+'.skel',
  webmPreview:'https://spine-link.vercel.app/assets/library_02/card-'+i+'/preview.webm',
  webmPreviewLow:'https://spine-link.vercel.app/assets/library_02/card-'+i+'/preview-low.webm',
  webpPosterLow:'https://spine-link.vercel.app/assets/library_02/card-'+i+'/preview-low.webp',
  webpPosterMedium:'https://spine-link.vercel.app/assets/library_02/card-'+i+'/preview-medium.webp',
  thumbnailPoster:'https://spine-link.vercel.app/assets/library_02/card-'+i+'/preview.webp',
  webmStatus:'ready',previewStatus:'ready',
  animations:['walk'],
  previewWidth:960,previewHeight:720,
}));
const originalFetch=globalThis.fetch;
const originalToken=process.env.GITHUB_TOKEN;
const originalBranch=process.env.GITHUB_BRANCH;
function stubFetch(log, sourceEntries=entries){
  return async input=>{
    const url=String(input);log.push(url);
    const json=value=>({ok:true,status:200,json:async()=>value});
    const text=value=>({ok:true,status:200,text:async()=>value});
    if(url.includes('/contents/?ref=')) return json([
      {type:'dir',name:'library'},
      {type:'dir',name:'library_02'},
    ]);
    if(url.includes('/contents/library_02/index.json?'))return json({
      encoding:'base64',content:Buffer.from(JSON.stringify(sourceEntries)).toString('base64'),
    });
    if(url.includes('/contents/library/index.json?'))return {ok:false,status:404};
    if(url.includes('/contents/library/'))return {ok:false,status:404};
    throw Error('Unexpected per-card remote request '+url);
  };
}
test('archive feed paginates without probing every media card, caches public responses',async()=>{
  const log=[];
  globalThis.fetch=stubFetch(log);
  process.env.GITHUB_TOKEN='test-only-placeholder';
  try{
    const res=response();
    await handler({method:'GET',headers:{host:'spine-link.vercel.app'},query:{feed:'archive',offset:'12',limit:'12'}},res);
    assert.equal(res.code,200);
    assert.equal(res.body.entries.length,12);
    assert.equal(res.body.hasMore,true);
    assert.match(res.headers['cache-control'],/max-age/);
    assert.ok(!/no-store/.test(res.headers['cache-control']));
    assert.ok(log.length<=6,'unexpected GitHub request fanout: '+log.length);
    assert.ok(log.every(u=>!u.includes('/card-')),'card asset metadata lookup on feed');
  }finally{
    globalThis.fetch=originalFetch;
    if(originalToken===undefined)delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN=originalToken;
  }
});

test('source PNG/WebP textures and guessed poster URLs never unlock archive WebM',async()=>{
  const source=[{
    ...entries[0],
    previewPath:'library_02/card-000',
    files:['texture.png','texture.webp'],
    webpPosterLow:'',
    webpPosterMedium:'data:image/webp;base64,VEVYVFVSRQ==',
    webpPoster:'https://spine-link.vercel.app/assets/library_02/card-000/texture.webp',
    thumbnailPoster:'https://spine-link.vercel.app/assets/library_02/card-000/texture.png',
    thumbnail:'data:image/webp;base64,VEVYVFVSRQ==',
    webmPreview:'https://spine-link.vercel.app/assets/library_02/card-000/preview.webm',
    webmPreviewLow:'https://spine-link.vercel.app/assets/library_02/card-000/preview-low.webm',
    webmStatus:'ready',
    previewStatus:'ready',
  }];
  const log=[];
  globalThis.fetch=stubFetch(log,source);
  process.env.GITHUB_TOKEN='test-only-placeholder';
  process.env.GITHUB_BRANCH='test-webp-poster-isolation';
  try{
    const res=response();
    await handler({method:'GET',headers:{host:'spine-link.vercel.app'},query:{}},res);
    assert.equal(res.code,200);
    const html=String(res.body);
    const card=html.match(/<article class="feed-card"[\s\S]*?<\/article>/)?.[0]||'';
    assert.ok(card,'initial card must be rendered');
    assert.match(card,/data-preview-status="blocked-no-webp-poster"/);
    assert.match(card,/Preview unavailable/);
    assert.doesNotMatch(card,/texture\.(?:png|webp)|preview\.webp|data:image\/webp|data-video-src=/,
      'source textures, data-URI thumbnails, and guessed same-work paths are not generated posters');
    assert.ok(html.includes("if(!poster||!poster.complete||poster.naturalWidth<=0)"),
      'WebM must wait for a decoded, non-empty poster');
    assert.ok(html.includes('isGeneratedPosterUrl')&&html.includes('preview-medium|generated-preview'),
      'lazy playback must require a generated WebP poster');
    const embedded=html.match(/<script type="application\/json" id="archive-next-page">([^<]+)<\/script>/);
    assert.ok(embedded);
    const batch=JSON.parse(embedded[1]);
    assert.equal(batch.entries.length,0);
    assert.ok(log.length<=6);
  }finally{
    globalThis.fetch=originalFetch;
    if(originalToken===undefined)delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN=originalToken;
    if(originalBranch===undefined)delete process.env.GITHUB_BRANCH;
    else process.env.GITHUB_BRANCH=originalBranch;
  }
});

test('only an explicit same-work generated WebP poster unlocks a lazy WebM',async()=>{
  const source=[{
    ...entries[0],
    previewPath:'library_02/card-000',
    webpPosterMedium:'https://spine-link.vercel.app/assets/library_02/card-000/preview-medium.webp',
    webpPoster:'https://spine-link.vercel.app/assets/library_02/card-000/preview.webp',
    thumbnailPoster:'https://spine-link.vercel.app/assets/library_02/card-000/texture.webp',
    thumbnail:'https://spine-link.vercel.app/assets/library_02/card-000/texture.webp',
    webmPreview:'https://spine-link.vercel.app/assets/library_02/card-000/preview.webm',
    webmPreviewLow:'https://spine-link.vercel.app/assets/library_02/card-000/preview-low.webm',
    webmStatus:'ready',
    previewStatus:'ready',
  }];
  const log=[];
  globalThis.fetch=stubFetch(log,source);
  process.env.GITHUB_TOKEN='test-only-placeholder';
  process.env.GITHUB_BRANCH='test-webp-poster-ready';
  try{
    const res=response();
    await handler({method:'GET',headers:{host:'spine-link.vercel.app'},query:{}},res);
    assert.equal(res.code,200);
    const html=String(res.body);
    const card=html.match(/<article class="feed-card"[\s\S]*?<\/article>/)?.[0]||'';
    assert.match(card,/data-preview-status="poster-pending"/,
      'a URL is pending until the browser decodes the actual image bytes');
    assert.match(card,/src="https:\/\/spine-link\.vercel\.app\/assets\/library_02\/card-000\/preview-medium\.webp/,
      'the primary poster must be the generated medium WebP for this work');
    assert.match(card,/data-fallback-src="https:\/\/spine-link\.vercel\.app\/assets\/library_02\/card-000\/preview\.webp/,
      'fallback must be a second generated still from the same work');
    assert.match(card,/data-video-src="https:\/\/spine-link\.vercel\.app\/assets\/library_02\/card-000\/preview-low\.webm/,
      'WebM is only attached after a generated poster is present');
    assert.doesNotMatch(card,/texture\.webp/,
      'a WebP texture page must never be selected as a poster');
    assert.ok(html.includes("card.dataset.previewStatus!=='ready-poster-lazy-video'"),
      'client playback must wait for a decoded poster');
    assert.ok(log.length<=6);
  }finally{
    globalThis.fetch=originalFetch;
    if(originalToken===undefined)delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN=originalToken;
    if(originalBranch===undefined)delete process.env.GITHUB_BRANCH;
    else process.env.GITHUB_BRANCH=originalBranch;
  }
});

test('a generated WebP URL from another work is rejected',async()=>{
  const source=[{
    ...entries[0],
    previewPath:'library_02/card-000',
    webpPosterMedium:'https://spine-link.vercel.app/assets/library_02/other-work/preview-medium.webp',
    webpPoster:'https://spine-link.vercel.app/assets/library_02/other-work/preview.webp',
    thumbnailPoster:'',
    thumbnail:'',
    webmPreview:'https://spine-link.vercel.app/assets/library_02/card-000/preview.webm',
    webmStatus:'ready',
    previewStatus:'ready',
  }];
  const log=[];
  globalThis.fetch=stubFetch(log,source);
  process.env.GITHUB_TOKEN='test-only-placeholder';
  process.env.GITHUB_BRANCH='test-webp-poster-cross-work';
  try{
    const res=response();
    await handler({method:'GET',headers:{host:'spine-link.vercel.app'},query:{}},res);
    const html=String(res.body);
    const card=html.match(/<article class="feed-card"[\s\S]*?<\/article>/)?.[0]||'';
    assert.match(card,/data-preview-status="blocked-no-webp-poster"/);
    assert.doesNotMatch(card,/other-work|data-video-src=/,
      'poster and video must belong to the same archive work');
  }finally{
    globalThis.fetch=originalFetch;
    if(originalToken===undefined)delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN=originalToken;
    if(originalBranch===undefined)delete process.env.GITHUB_BRANCH;
    else process.env.GITHUB_BRANCH=originalBranch;
  }
});

test('gallery server-HTML puts WebP before any WebM network request',async()=>{
  const log=[];
  globalThis.fetch=stubFetch(log);
  process.env.GITHUB_TOKEN='test-only-placeholder';
  try{
    const res=response();
    await handler({method:'GET',headers:{host:'spine-link.vercel.app'},query:{}},res);
    assert.equal(res.code,200);
    const html=String(res.body);
    assert.ok(html.includes('<img src="https://spine-link.vercel.app/assets/library_02/'));
    assert.ok(!html.includes('<video src="'), 'eager WebM would block WebP posters');
    assert.ok(html.includes('data-video-src='),'video URL must be deferred on each card');
    assert.ok(html.includes('prefetchNext()'),'next page should be fetched before reaching sentinel');
    const embedded=html.match(/<script type="application\/json" id="archive-next-page">([^<]+)<\/script>/);
    assert.ok(embedded,'First lazy batch must be embedded in server HTML');
    const batch=JSON.parse(embedded[1]);
    assert.equal(batch.entries.length,68,'all remaining cards must be embedded for instant pagination');
    assert.equal(batch.hasMore,false,'no follow-on cold API requests needed');
    assert.ok(html.includes('const batch=embeddedEntries.slice(start,start+pageSize)'),
      'client must paginate in-memory rather than waiting for a feed API request');
    assert.ok(batch.entries.every(e=>e.poster&&e.video),'Next batch has WebP poster metadata');
    assert.match(batch.entries[0].poster,/preview-medium\.webp/,'Prefer the supported medium WebP poster');
    assert.match(batch.entries[0].posterFallback,/preview\.webp/,'Fallback to another still for the same work');
    assert.doesNotMatch(batch.entries[0].poster,/preview-low\.webp/,'Never request the intentionally disabled low poster');
    assert.notEqual(batch.entries[0].poster,batch.entries[0].posterFallback,'Poster fallback must not repeat broken URL');
    assert.ok(html.includes('const warmedPosters=new Map()'),'Keep warmed images alive through pagination');
    assert.ok(html.includes('slice(0,pageSize)'),'Warm all next-page WebP cards before scroll');
    assert.ok(html.includes("video.preload='none'"),'dynamic video should never preload offscreen');
    const section=html.slice(html.indexOf('<script>\n      (() => {')+8,html.indexOf('</script>',html.indexOf('<script>\n      (() => {')));
    assert.doesNotThrow(()=>new Function(section),'gallery client code must parse');
    assert.ok(log.length<=6,'unexpected excessive index calls');
  }finally{
    globalThis.fetch=originalFetch;
    if(originalToken===undefined)delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN=originalToken;
  }
});
