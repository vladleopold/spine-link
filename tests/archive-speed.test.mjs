import test from 'node:test';
import fs from 'node:fs';
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
  webmPreviewMedium:'https://spine-link.vercel.app/assets/library_02/card-'+i+'/preview-medium.webm',
  webmPreviewLow:'https://spine-link.vercel.app/assets/library_02/card-'+i+'/preview-low.webm',
  webpPosterLow:'https://spine-link.vercel.app/assets/library_02/card-'+i+'/preview-low.webp',
  webpPosterMedium:'https://spine-link.vercel.app/assets/library_02/card-'+i+'/preview-medium.webp',
  thumbnailPoster:'https://spine-link.vercel.app/assets/library_02/card-'+i+'/preview.webp',
  webmStatus:'ready',previewStatus:'ready',
  animations:['walk'],
  defaultAnimation:'walk',
  allAnimationPreviews:{walk:{
    webmPreview:'https://spine-link.vercel.app/assets/library_02/card-'+i+'/preview.webm',
    webmPreviewMedium:'https://spine-link.vercel.app/assets/library_02/card-'+i+'/preview-medium.webm',
    webmPreviewLow:'https://spine-link.vercel.app/assets/library_02/card-'+i+'/preview-low.webm',
    webpPoster:'https://spine-link.vercel.app/assets/library_02/card-'+i+'/preview.webp',
    webpPosterMedium:'https://spine-link.vercel.app/assets/library_02/card-'+i+'/preview-medium.webp',
    webpPosterLow:'https://spine-link.vercel.app/assets/library_02/card-'+i+'/preview-low.webp',
    previewDuration:2.5,
  }},
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

test('source textures and guessed posters never unlock archive WebM or render a fallback',async()=>{
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
    webmPreviewMedium:'',
    webmPreviewLow:'https://spine-link.vercel.app/assets/library_02/card-000/preview-low.webm',
    webmStatus:'ready',previewStatus:'ready',
    allAnimationPreviews:{},
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
    assert.match(card,/data-preview-status="blocked-no-webm-poster"/);
    assert.doesNotMatch(card,/<img|<video|feed-placeholder|Preview unavailable|SPINE|texture\.(?:png|webp)|preview\.webp|data:image\/webp|data-video-src=|data-fallback-src=/,
      'without a matching video/poster pair the card must render no visual substitute');
    assert.ok(html.includes("if(!poster||!poster.complete||poster.naturalWidth<=0)"),
      'WebM must wait for a decoded first-frame poster');
    assert.ok(html.includes('preview-medium|preview-low'),
      'only medium/low generated WebP posters may unlock playback');
    assert.ok(log.length<=6);
  }finally{
    globalThis.fetch=originalFetch;
    if(originalToken===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=originalToken;
    if(originalBranch===undefined)delete process.env.GITHUB_BRANCH;else process.env.GITHUB_BRANCH=originalBranch;
  }
});

test('only a matching medium WebM and its own medium first-frame WebP unlock a card',async()=>{
  const source=[{
    ...entries[0],
    previewPath:'library_02/card-000',
    webpPosterMedium:'https://spine-link.vercel.app/assets/library_02/card-000/preview-medium.webp',
    webpPosterLow:'https://spine-link.vercel.app/assets/library_02/card-000/preview-low.webp',
    webpPoster:'https://spine-link.vercel.app/assets/library_02/card-000/preview.webp',
    thumbnailPoster:'https://spine-link.vercel.app/assets/library_02/card-000/texture.webp',
    thumbnail:'https://spine-link.vercel.app/assets/library_02/card-000/texture.webp',
    webmPreview:'https://spine-link.vercel.app/assets/library_02/card-000/preview.webm',
    webmPreviewMedium:'https://spine-link.vercel.app/assets/library_02/card-000/preview-medium.webm',
    webmPreviewLow:'https://spine-link.vercel.app/assets/library_02/card-000/preview-low.webm',
    webmStatus:'ready',previewStatus:'ready',
    allAnimationPreviews:{walk:{
      webmPreviewMedium:'https://spine-link.vercel.app/assets/library_02/card-000/preview-medium.webm',
      webmPreviewLow:'https://spine-link.vercel.app/assets/library_02/card-000/preview-low.webm',
      webpPosterMedium:'https://spine-link.vercel.app/assets/library_02/card-000/preview-medium.webp',
      webpPosterLow:'https://spine-link.vercel.app/assets/library_02/card-000/preview-low.webp',
    }},
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
    assert.match(card,/data-preview-status="poster-pending"/);
    assert.match(card,/src="https:\/\/spine-link\.vercel\.app\/assets\/library_02\/card-000\/preview-medium\.webp/,
      'poster is the medium WebP extracted from the medium video');
    assert.match(card,/data-video-src="https:\/\/spine-link\.vercel\.app\/assets\/library_02\/card-000\/preview-medium\.webm/,
      'video and poster must be the same quality tier');
    assert.doesNotMatch(card,/data-fallback-src=|data-video-fallback=|preview-low\.webm|preview\.webm/,
      'no image/video fallback and no quality mismatch');
    assert.ok(html.includes("card.dataset.previewStatus!=='ready-poster-lazy-video'"));
    assert.ok(log.length<=6);
  }finally{
    globalThis.fetch=originalFetch;
    if(originalToken===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=originalToken;
    if(originalBranch===undefined)delete process.env.GITHUB_BRANCH;else process.env.GITHUB_BRANCH=originalBranch;
  }
});

test('a generated WebP URL from another work is rejected without a card fallback',async()=>{
  const source=[{
    ...entries[0],
    previewPath:'library_02/card-000',
    webpPosterMedium:'https://spine-link.vercel.app/assets/library_02/other-work/preview-medium.webp',
    webpPosterLow:'',
    webpPoster:'https://spine-link.vercel.app/assets/library_02/other-work/preview.webp',
    thumbnailPoster:'',
    // A source texture keeps the work in the archive index, but is never a preview.
    thumbnail:'https://spine-link.vercel.app/assets/library_02/card-000/texture.png',
    webmPreview:'',
    webmPreviewMedium:'https://spine-link.vercel.app/assets/library_02/card-000/preview-medium.webm',
    webmPreviewLow:'',
    webmStatus:'ready',previewStatus:'ready',
    allAnimationPreviews:{walk:{
      webmPreviewMedium:'https://spine-link.vercel.app/assets/library_02/card-000/preview-medium.webm',
      webpPosterMedium:'https://spine-link.vercel.app/assets/library_02/other-work/preview-medium.webp',
    }},
  }];
  const log=[];
  globalThis.fetch=stubFetch(log,source);
  process.env.GITHUB_TOKEN='test-only-placeholder';
  process.env.GITHUB_BRANCH='test-webp-poster-cross-work';
  try{
    const res=response();
    await handler({method:'GET',headers:{host:'spine-link.vercel.app'},query:{feed:'archive',offset:'0',limit:'12'}},res);
    assert.equal(res.code,200);
    assert.equal(res.body.total,1,'the source-texture-backed work must remain in the archive index');
    assert.equal(res.body.entries.length,1);
    assert.equal(res.body.entries[0].poster,'','a poster from a different work must be rejected');
    assert.equal(res.body.entries[0].video,'','the matching WebM cannot play without its own generated poster');
    assert.equal(res.body.entries[0].quality,'');
    assert.doesNotMatch(JSON.stringify(res.body.entries[0]),/other-work|preview-medium\\.(?:webp|webm)/,
      'cross-work poster and unpaired video URLs must never be serialized into the feed');
  }finally{
    globalThis.fetch=originalFetch;
    if(originalToken===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=originalToken;
    if(originalBranch===undefined)delete process.env.GITHUB_BRANCH;else process.env.GITHUB_BRANCH=originalBranch;
  }
});

test('low quality is allowed only as its exact installed WebM/WebP pair',async()=>{
  const source=[{
    ...entries[0],
    previewPath:'library_02/card-000',
    webmPreview:'',webmPreviewMedium:'',
    webpPoster:'',webpPosterMedium:'',
    webmPreviewLow:'https://spine-link.vercel.app/assets/library_02/card-000/preview-low.webm',
    webpPosterLow:'https://spine-link.vercel.app/assets/library_02/card-000/preview-low.webp',
    webmStatus:'ready',previewStatus:'ready',
    allAnimationPreviews:{walk:{
      webmPreviewLow:'https://spine-link.vercel.app/assets/library_02/card-000/preview-low.webm',
      webpPosterLow:'https://spine-link.vercel.app/assets/library_02/card-000/preview-low.webp',
    }},
  }];
  const log=[];
  globalThis.fetch=stubFetch(log,source);
  process.env.GITHUB_TOKEN='test-only-placeholder';
  process.env.GITHUB_BRANCH='test-low-poster-paired';
  try{
    const res=response();
    await handler({method:'GET',headers:{host:'spine-link.vercel.app'},query:{}},res);
    assert.equal(res.code,200);
    const html=String(res.body);
    const card=html.match(/<article class="feed-card"[\s\S]*?<\/article>/)?.[0]||'';
    assert.match(card,/data-preview-status="poster-pending"/);
    assert.match(card,/src="https:\/\/spine-link\.vercel\.app\/assets\/library_02\/card-000\/preview-low\.webp/);
    assert.match(card,/data-video-src="https:\/\/spine-link\.vercel\.app\/assets\/library_02\/card-000\/preview-low\.webm/);
    assert.doesNotMatch(card,/preview-medium\.(?:webp|webm)|preview\.webp|data-fallback-src=|data-video-fallback=|feed-placeholder|Preview unavailable|SPINE/,
      'low quality is allowed only as the exact paired original media; no substitute');
    const assetRoute=fs.readFileSync(new URL('../api/github-asset.js',import.meta.url),'utf8');
    assert.match(assetRoute,/const assetPath = path;/,'asset proxy must preserve the exact requested low poster path');
    assert.doesNotMatch(assetRoute,/path\.replace\([^;]*preview\.webp/,'low poster must never be rewritten to another quality');
  }finally{
    globalThis.fetch=originalFetch;
    if(originalToken===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=originalToken;
    if(originalBranch===undefined)delete process.env.GITHUB_BRANCH;else process.env.GITHUB_BRANCH=originalBranch;
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
    assert.equal(batch.entries.length,28,'only the next 28 cards should be embedded to bound initial HTML');
    assert.equal(batch.hasMore,true,'later archive pages must remain available through the paginated API');
    assert.ok(html.includes('const batch=embeddedEntries.slice(start,start+pageSize)'),
      'the first 40 cards must paginate in-memory without waiting for a feed API request');
    assert.ok(html.includes('const embeddedEnd=')&&html.includes('offset<embeddedEnd'),
      'after the bounded embedded batch, later cards must continue through the API');
    assert.ok(batch.entries.every(e=>e.poster&&e.video),'Next batch has WebP poster metadata');
    assert.match(batch.entries[0].poster,/preview-medium\.webp/,'Prefer the medium WebP first-frame poster');
    assert.match(batch.entries[0].video,/preview-medium\.webm/,'Pair the poster with its medium WebM');
    assert.equal(batch.entries[0].posterFallback,undefined,'No image fallback is permitted');
    assert.equal(batch.entries[0].videoFallback,undefined,'No video fallback is permitted');
    assert.ok(batch.entries.every(e=>e.quality==='medium'),'Use medium quality when installed');
    assert.doesNotMatch(html,/data-video-fallback|data-fallback-src|feed-placeholder|Preview unavailable/,'No feed fallback may be emitted');
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


test('production deploys are queued instead of cancelled by later workflow_run completions',()=>{
  const workflow=fs.readFileSync(new URL('../.github/workflows/vercel-deploy-and-alias.yml',import.meta.url),'utf8');
  assert.match(workflow,/concurrency:\s*\n\s+group:\s*spine-link-production\s*\n\s+cancel-in-progress:\s*false/,
    'a later skipped/failed workflow_run must not cancel an already validated deployment');
  assert.match(workflow,/github\.event\.workflow_run\.conclusion == 'success' && github\.event\.workflow_run\.head_branch == 'main'/,
    'only successful main-branch CI may deploy');
  assert.match(workflow,/Ensure source has not changed since the successful CI run/,
    'queued deploys must still reject stale tested source');
  assert.match(workflow,/last_success=.*status=success/,
    'repeated successful workflow_run events for one SHA must be deduplicated');
});

test('preview sidebar keeps all supporting panels below the animation picker on desktop',()=>{
  const preview=fs.readFileSync(new URL('../api/github-preview.js',import.meta.url),'utf8');
  assert.equal((preview.match(/@media\s*\(max-width:\s*1024px\)/g)||[]).length,0,
    'responsive layout must switch at 1000px, not hide desktop behavior at 1024px');
  assert.match(preview,/@media \(max-width: 1000px\)/);
  assert.match(preview,/#sidebar > #animation-card\s*\{\s*order:\s*1;\s*\}/);
  assert.match(preview,/#sidebar > \.animation-download-block\s*\{\s*order:\s*2;\s*\}/);
  assert.match(preview,/#sidebar > \.video-watch-panel--below-list\s*\{\s*order:\s*3;\s*\}/);
  assert.match(preview,/#sidebar > \.proof-card\s*\{\s*order:\s*4;\s*\}/);
  assert.match(preview,/#sidebar > #owner-library\s*\{\s*order:\s*5;\s*\}/);
  assert.match(preview,/#sidebar > #set-card,\s*#sidebar > \.note-card\s*\{\s*order:\s*6;\s*\}/);
  assert.match(preview,/@media \(min-width: 1001px\)[\s\S]*#sidebar > #animation-card\s*\{\s*flex:\s*0 0 auto;\s*\}/,
    'the long animation picker must not flex-shrink below the player height');
});


test('archive never substitutes another animation when defaultAnimation is absent or unavailable',async()=>{
  const source=[
    {...entries[0],defaultAnimation:'',allAnimationPreviews:entries[0].allAnimationPreviews},
    {...entries[1],id:'missing-default',previewPath:'library_02/missing-default',defaultAnimation:'missing',allAnimationPreviews:entries[1].allAnimationPreviews},
    {...entries[2],id:'failed-default',previewPath:'library_02/failed-default',defaultAnimation:'walk',webmStatus:'failed',previewStatus:'failed',allAnimationPreviews:{}},
  ];
  const log=[];
  globalThis.fetch=stubFetch(log,source);
  process.env.GITHUB_TOKEN='test-only-placeholder';
  process.env.GITHUB_BRANCH='test-no-animation-substitution';
  try{
    const res=response();
    await handler({method:'GET',headers:{host:'spine-link.vercel.app'},query:{feed:'archive',offset:'0',limit:'12'}},res);
    assert.equal(res.code,200);
    assert.equal(res.body.entries.length,3);
    const byId=new Map(res.body.entries.map(item=>[item.id,item]));
    for(const id of ['card-000','missing-default']){
      const item=byId.get(id);
      assert.ok(item,'expected source entry '+id);
      assert.equal(item.poster,'','no other animation may supply a poster');
      assert.equal(item.video,'','no other animation may supply WebM');
      assert.equal(item.quality,'','unselected animation must remain blocked');
      assert.equal(item.sourceWebmStatus,'blocked-no-exact-animation-preview');
      assert.equal(item.sourcePreviewStatus,'blocked');
    }
    const failed=byId.get('failed-default');
    assert.ok(failed,'explicit failed source entry must remain visible as failed');
    assert.equal(failed.poster,'');
    assert.equal(failed.video,'');
    assert.equal(failed.quality,'');
    assert.equal(failed.sourceWebmStatus,'failed','an explicit failure must remain failed');
    assert.equal(failed.sourcePreviewStatus,'failed');
  }finally{
    globalThis.fetch=originalFetch;
    if(originalToken===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=originalToken;
    if(originalBranch===undefined)delete process.env.GITHUB_BRANCH;else process.env.GITHUB_BRANCH=originalBranch;
  }
});


test('first four eligible archive posters reach the initial DOM after fifty-five blocked cards',async()=>{
  const blocked=Array.from({length:55},(_,i)=>({
    ...entries[0],
    id:'blocked-'+i,
    uploadedAt:new Date(Date.UTC(2026,10,19,0,i)).toISOString(),
    skeleton:'blocked-'+i+'.skel',
    previewPath:'library_02/blocked-'+i,
    defaultAnimation:'',
    webmStatus:'blocked-missing',
    previewStatus:'blocked',
    allAnimationPreviews:{},
  }));
  const ready=Array.from({length:7},(_,i)=>{
    const id='ready-'+i;
    const base='https://spine-link.vercel.app/assets/library_02/'+id+'/';
    return {
      ...entries[0],
      id,
      uploadedAt:new Date(Date.UTC(2026,10,18,0,7-i)).toISOString(),
      skeleton:id+'.skel',
      previewPath:'library_02/'+id,
      defaultAnimation:'walk',
      webmStatus:'ready',
      previewStatus:'ready',
      allAnimationPreviews:{walk:{
        webmPreview:base+'preview.webm',
        webmPreviewMedium:base+'preview-medium.webm',
        webmPreviewLow:base+'preview-low.webm',
        webpPoster:base+'preview.webp',
        webpPosterMedium:base+'preview-medium.webp',
        webpPosterLow:base+'preview-low.webp',
        previewDuration:2.5,
      }},
    };
  });
  const log=[];
  globalThis.fetch=stubFetch(log,[...blocked,...ready]);
  process.env.GITHUB_TOKEN='test-only-placeholder';
  process.env.GITHUB_BRANCH='test-first-eligible-poster-priority';
  try{
    const res=response();
    await handler({method:'GET',headers:{host:'spine-link.vercel.app'},query:{}},res);
    assert.equal(res.code,200);
    const html=String(res.body);
    const cards=[...html.matchAll(/<article class="feed-card"[\s\S]*?<\/article>/g)].map(match=>match[0]);
    assert.equal(cards.length,59,'include the first four eligible cards after fifty-five blocked records');
    for(const card of cards.slice(0,55)){
      assert.doesNotMatch(card,/<img|<video|data-video-src=/,
        'blocked cards must not gain a fabricated poster or video');
    }
    for(let i=0;i<4;i++){
      assert.match(cards[55+i],/<img /,'the first eligible cards must be in the initial DOM');
      assert.match(cards[55+i],/data-video-src=/,'each initial poster must retain its exact paired lazy WebM');
    }
    const embedded=html.match(/<script type="application\/json" id="archive-next-page">([^<]+)<\/script>/);
    assert.ok(embedded,'the remaining compact card records must be embedded in HTML');
    const batch=JSON.parse(embedded[1]);
    assert.equal(batch.entries.length,3,'the remaining three ready works follow the initial four');
    for(let i=0;i<3;i++){
      assert.equal(batch.entries[i].id,'ready-'+(i+4));
      assert.ok(batch.entries[i].poster&&batch.entries[i].video);
    }
    const preloads=[...html.matchAll(/<link rel="preload" as="image" href="([^"]+)" fetchpriority="([^"]+)"/g)];
    assert.equal(preloads.length,4,'preload the first four eligible WebP posters from the bounded embedded window');
    assert.deepEqual(preloads.map(match=>new URL(match[1]).pathname.split('/').at(-2)),
      ['ready-0','ready-1','ready-2','ready-3']);
    assert.deepEqual(preloads.map(match=>match[2]),['high','high','low','low']);
    const source=fs.readFileSync(new URL('../api/github-archive.js',import.meta.url),'utf8');
    assert.match(source,/card\.dataset\.sourceWebmStatus=item\.sourceWebmStatus\|\|''/);
    assert.match(source,/card\.dataset\.sourcePreviewStatus=item\.sourcePreviewStatus\|\|''/);
    assert.match(source,/const posterIndex=item\.poster&&item\.video\?eligiblePosterIndex\+\+:-1/);
    assert.match(source,/image\.loading=posterIndex>=0&&posterIndex<4\?'eager':'lazy'/);
    assert.match(source,/image\.fetchPriority=posterIndex>=0&&posterIndex<2\?'high':'low'/);
    assert.ok(html.includes('const pageSize=48'));
    assert.ok(html.includes("rootMargin:'5200px'"));
    assert.ok(html.includes('new MutationObserver'),
      'optional enhancements must wait for a real poster without blocking card insertion');
    assert.ok(!html.includes('<video src='),'initial archive HTML must never request WebM');
    assert.ok(log.length<=6,'poster priority must not add per-card GitHub requests');
  }finally{
    globalThis.fetch=originalFetch;
    if(originalToken===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=originalToken;
    if(originalBranch===undefined)delete process.env.GITHUB_BRANCH;else process.env.GITHUB_BRANCH=originalBranch;
  }
});

test('hourly archive proof traverses every public page and verifies media beyond the embedded batch',()=>{
  const workflow=fs.readFileSync(new URL('../.github/workflows/archive-live-speed.yml',import.meta.url),'utf8');
  assert.match(workflow,/schedule:\s*\n\s+- cron: '\d+ \* \* \* \*'/,
    'the production archive audit must run hourly');
  assert.match(workflow,/group: spine-archive-live-proof[\s\S]*cancel-in-progress:\s*false/,
    'hourly audits must not cancel an in-progress full-library scan');
  assert.match(workflow,/const offset=Number\(requestUrl\.searchParams\.get\('offset'\)\|\|0\)/);
  assert.match(workflow,/if\(offset<40\)[\s\S]*route\.abort\(\)[\s\S]*allowedApiRequests\+\+[\s\S]*route\.continue\(\)/,
    'only the already embedded first 40 cards may avoid the paginated API');
  assert.match(workflow,/End of archive/);
  assert.match(workflow,/if\(allCards\.length!==totalEntries\)failures\.push\('archive-final-card-count-mismatch'\)/,
    'a truncated archive must be recorded as a hard failure');
  assert.match(workflow,/assert\.equal\(failures\.length,0/,
    'recorded full-library audit failures must fail the job');
  assert.match(workflow,/ARCHIVE_ALL_PAGES_EVIDENCE/);
  assert.match(workflow,/probeWebm/);
  assert.match(workflow,/const decodeLimit=Number\.MAX_SAFE_INTEGER/);
  assert.match(workflow,/const posterStatusTargets=allPairs/,
    'desktop and mobile must validate HTTP status for every eligible poster');
  assert.match(workflow,/const webmTargets=allPairs/,
    'desktop and mobile must validate real WebM response headers for every eligible card');
  assert.match(workflow,/const sampleCount=Math\.min\(8,allPairs\.length\)/,
    'both viewports must play a representative set including archive boundaries');
  assert.match(workflow,/const batchLimit=Math\.max\(1,totalEntries\)/,
    'pagination cap must handle the live production page size, not assume 48-card PR batches');
  assert.match(workflow,/await page\.emulateMedia\(\{reducedMotion:'no-preference'\}\)/,
    'video playback audit must explicitly test the non-reduced-motion path');
  assert.match(workflow,/scrollIntoView\(\{block:'start',inline:'nearest',behavior:'instant'\}\)/,
    'each playback sample must be the primary visible card before testing lazy video');
  assert.match(workflow,/video\.readyState>=2/);
});
