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
  webpPosterMedium:'https://spine-link.vercel.app/assets/library_02/card-'+i+'/preview-medium.webp',
  thumbnailPoster:'https://spine-link.vercel.app/assets/library_02/card-'+i+'/preview.webp',
  animations:['walk'],
  previewWidth:960,previewHeight:720,
}));
const originalFetch=globalThis.fetch;
const originalToken=process.env.GITHUB_TOKEN;
function stubFetch(log){
  return async input=>{
    const url=String(input);log.push(url);
    const json=value=>({ok:true,status:200,json:async()=>value});
    const text=value=>({ok:true,status:200,text:async()=>value});
    if(url.includes('/contents/?ref=')) return json([
      {type:'dir',name:'library'},
      {type:'dir',name:'library_02'},
    ]);
    if(url.includes('/contents/library_02/index.json?'))return json({
      encoding:'base64',content:Buffer.from(JSON.stringify(entries)).toString('base64'),
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
    assert.match(batch.entries[0].poster,/preview-low\\.webp/,'Prefer the low-bitrate WebP poster');
    assert.match(batch.entries[0].posterFallback,/preview-medium\\.webp/,'Fallback to a different still for the same work');
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
