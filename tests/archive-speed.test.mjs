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
    assert.ok(card.includes('data-player-url="/p/card-000?animation=walk"'),
      'the card click target must preserve the exact selected animation');
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
  assert.match(workflow,/commits\/\$deploy_sha\/status/,
    'deduplication must inspect the exact source commit, not a workflow conclusion');
  assert.match(workflow,/context == "vercel\/production" and \.state == "success"/,
    'only an explicit successful production deployment status may deduplicate a commit');
  assert.match(workflow,/name: Record verified production deployment on commit/,
    'a production status may be written only after deploy and production smoke steps pass');
  assert.match(workflow,/statuses:\s*write/,
    'the deploy workflow needs permission to record its verified production status');
  assert.doesNotMatch(workflow,/last_success=.*status=success/,
    'a skipped workflow run must never be mistaken for a production deployment');
  assert.ok(workflow.includes('actions/runs?head_sha=$deploy_sha&per_page=100'),
    'release readiness must be checked against the exact source SHA');
  assert.ok(workflow.includes('for required in "Spine-Link Agent API CI" "Spine archive WebP-first performance regression"'),
    'a push affecting both release surfaces must wait for both CI workflows');
  assert.ok(workflow.includes('completed/success|not-triggered'),
    'only successful applicable workflows or path-filtered workflows may allow deployment');
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
  ];
  const log=[];
  globalThis.fetch=stubFetch(log,source);
  process.env.GITHUB_TOKEN='test-only-placeholder';
  process.env.GITHUB_BRANCH='test-no-animation-substitution';
  try{
    const res=response();
    await handler({method:'GET',headers:{host:'spine-link.vercel.app'},query:{feed:'archive',offset:'0',limit:'12'}},res);
    assert.equal(res.code,200);
    assert.equal(res.body.entries.length,2);
    for(const item of res.body.entries){
      assert.equal(item.poster,'','no other animation may supply a poster');
      assert.equal(item.video,'','no other animation may supply WebM');
      assert.equal(item.quality,'','unselected animation must remain blocked');
    }
  }finally{
    globalThis.fetch=originalFetch;
    if(originalToken===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=originalToken;
    if(originalBranch===undefined)delete process.env.GITHUB_BRANCH;else process.env.GITHUB_BRANCH=originalBranch;
  }
});


test('archive feed includes per-animation-only entries and blocks absent or unmatched selected animations',async()=>{
  const makeEntry=(id,defaultAnimation,mapAnimation)=>{
    const workPath='library_02/'+id;
    const asset='https://spine-link.vercel.app/assets/'+workPath;
    return {
      ...entries[0],
      id,
      skeleton:id+'.skel',
      previewPath:workPath,
      webmPreview:'',
      webmPreviewMedium:'',
      webmPreviewLow:'',
      webpPoster:'',
      webpPosterMedium:'',
      webpPosterLow:'',
      thumbnail:'',
      thumbnailPoster:'',
      defaultAnimation,
      webmStatus:'ready',
      previewStatus:'ready',
      allAnimationPreviews:{
        [mapAnimation]:{
          webmPreviewMedium:asset+'/preview-medium.webm',
          webpPosterMedium:asset+'/preview-medium.webp',
          previewDuration:2.5,
        },
      },
    };
  };
  const source=[
    makeEntry('map-only-selected','walk','walk'),
    makeEntry('map-only-no-default','','run'),
    makeEntry('map-only-unmatched','missing','run'),
  ];
  const log=[];
  globalThis.fetch=stubFetch(log,source);
  process.env.GITHUB_TOKEN='test-only-placeholder';
  process.env.GITHUB_BRANCH='test-map-only-selected-animation';
  try{
    const res=response();
    await handler({method:'GET',headers:{host:'spine-link.vercel.app'},query:{feed:'archive',offset:'0',limit:'48'}},res);
    assert.equal(res.code,200);
    assert.equal(res.body.total,3,'map-only entries must not disappear before selected-media validation');
    const byId=Object.fromEntries(res.body.entries.map(item=>[item.id,item]));
    const selected=byId['map-only-selected'];
    assert.ok(selected);
    assert.equal(selected.quality,'medium');
    assert.ok(selected.video.startsWith('https://spine-link.vercel.app/assets/library_02/map-only-selected/preview-medium.webm?v='));
    assert.ok(selected.poster.startsWith('https://spine-link.vercel.app/assets/library_02/map-only-selected/preview-medium.webp?v='));
    for(const id of ['map-only-no-default','map-only-unmatched']){
      assert.ok(byId[id],'unavailable exact selections remain visible as blocked cards');
      assert.equal(byId[id].video,'','another map key must never be substituted');
      assert.equal(byId[id].poster,'','another map key must never be substituted');
      assert.equal(byId[id].quality,'');
    }
    assert.ok(log.length<=6,'map-only feed must not add per-card GitHub requests');
  }finally{
    globalThis.fetch=originalFetch;
    if(originalToken===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=originalToken;
    if(originalBranch===undefined)delete process.env.GITHUB_BRANCH;else process.env.GITHUB_BRANCH=originalBranch;
  }
});

test('archive WebM starts only after its exact poster decode succeeds',()=>{
  const archive=fs.readFileSync(new URL('../api/github-archive.js',import.meta.url),'utf8');
  const startIndex=archive.indexOf('async function startVideo(card)');
  const endIndex=archive.indexOf('function updateAutoplay()',startIndex);
  assert.ok(startIndex>=0&&endIndex>startIndex,'archive autoplay function boundaries must be present');
  const start=archive.slice(startIndex,endIndex);
  assert.ok(start.includes('await poster.decode()'),'video attachment must await successful poster decode');
  assert.ok(start.indexOf('await poster.decode()')<start.indexOf('video.src=card.dataset.videoSrc'),
    'WebM network activity must begin only after the paired WebP decode resolves');
  assert.match(start,/starting\.has\(card\)/,'concurrent visibility updates must not start duplicate video loads');
  assert.match(start,/blocked-poster-decode-failed/,'a decode failure must block the same preview without substitution');

  const workflow=fs.readFileSync(new URL('../.github/workflows/archive-live-speed.yml',import.meta.url),'utf8');
  assert.match(workflow,/__archivePosterDecodeAt/,'live browser proof must capture actual poster decode completion');
  assert.match(workflow,/decodedPosterByPath/,'live browser proof must pair each WebM with its own poster decode');
  assert.match(workflow,/decodedAt>request\.at/,'live browser proof must reject WebM requests before poster decode');
});

test('live production proof fails closed when upstream skipped the actual Vercel deploy',()=>{
  const workflow=fs.readFileSync(new URL('../.github/workflows/archive-live-speed.yml',import.meta.url),'utf8');
  const gate=workflow.slice(workflow.indexOf('id: inspect'),workflow.indexOf('chromium:'));
  assert.match(gate,/select\(\.name == "Deploy to Vercel" and \.conclusion == "success"\)/);
  assert.match(gate,/if \[ "\$deployed" != "true" \]; then/);
  assert.match(gate,/PRODUCTION_BROWSER_PROOF_BLOCKED_NO_REAL_DEPLOYMENT/);
  assert.match(gate,/exit 1/,'a skipped deploy must fail the production-proof workflow instead of making it green');
});

test('live archive acceptance requires a real exact-animation WebM and playback sample',()=>{
  const workflow=fs.readFileSync(new URL('../.github/workflows/archive-live-speed.yml',import.meta.url),'utf8');
  assert.match(workflow,/assert\.ok\(videoUrls\.length>0,/,
    'an all-blocked archive must not pass media acceptance');
  assert.match(workflow,/assert\.ok\(videoSamples>0,/,
    'at least one real WebM must reach advancing decoded playback');
  assert.doesNotMatch(workflow,/videoUrls\.length===0/,
    'zero media must never be treated as a successful playback check');
});

test('archive detail, video and home feeds use one exact same-work WebM/WebP quality pair',async()=>{
  const asset=(id,name)=>'https://spine-link.vercel.app/assets/library_02/'+id+'/'+name;
  const makeEntry=(id,previews,status='ready')=>({
    ...entries[0],id,skeleton:id+'.skel',previewPath:'library_02/'+id,
    defaultAnimation:'walk',webmStatus:status,previewStatus:status,
    previewDuration:2.5,previewFrameCount:60,previewWidth:960,previewHeight:720,
    webmPreview:asset(id,'preview.webm'),
    webmPreviewMedium:asset(id,'preview-medium.webm'),
    webmPreviewLow:asset(id,'preview-low.webm'),
    webpPoster:asset(id,'preview.webp'),
    webpPosterMedium:asset(id,'preview-medium.webp'),
    webpPosterLow:asset(id,'preview-low.webp'),
    allAnimationPreviews:{walk:previews},
  });
  const medium=makeEntry('pair-medium',{
    webmPreview:asset('pair-medium','preview.webm'),
    webpPoster:asset('pair-medium','preview.webp'),
    webmPreviewMedium:asset('pair-medium','preview-medium.webm'),
    webpPosterMedium:asset('pair-medium','preview-medium.webp'),
    webmPreviewLow:asset('pair-medium','preview-low.webm'),
    webpPosterLow:asset('pair-medium','preview-low.webp'),
  });
  // A wrong-work medium poster must invalidate that tier; the valid low pair
  // is the next candidate and must not be combined with the full video.
  const low=makeEntry('pair-low',{
    webmPreview:asset('pair-low','preview.webm'),
    webpPoster:asset('pair-low','preview.webp'),
    webmPreviewMedium:asset('pair-low','preview-medium.webm'),
    webpPosterMedium:asset('other-work','preview-medium.webp'),
    webmPreviewLow:asset('pair-low','preview-low.webm'),
    webpPosterLow:asset('pair-low','preview-low.webp'),
  });
  const blocked=makeEntry('pair-blocked',{
    webmPreview:asset('pair-blocked','preview.webm'),
    webpPoster:asset('pair-blocked','preview.webp'),
    webmPreviewMedium:asset('pair-blocked','preview-medium.webm'),
    webpPosterMedium:asset('pair-blocked','preview-medium.webp'),
    webmPreviewLow:asset('pair-blocked','preview-low.webm'),
    webpPosterLow:asset('pair-blocked','preview-low.webp'),
  },'blocked-missing-animation-selection');
  const source=[medium,low,blocked];
  const log=[];
  globalThis.fetch=stubFetch(log,source);
  process.env.GITHUB_TOKEN='test-only-placeholder';
  process.env.GITHUB_BRANCH='test-archive-quality-paired-media';
  try{
    const home=response();
    await handler({method:'GET',headers:{host:'spine-link.vercel.app'},query:{feed:'home'}},home);
    assert.equal(home.code,200);
    const homeById=new Map(home.body.entries.map(item=>[item.id,item]));
    assert.ok(homeById.get('pair-medium')?.webmPreview.includes(asset('pair-medium','preview-medium.webm')));
    assert.ok(homeById.get('pair-medium')?.thumbnailPoster.includes(asset('pair-medium','preview-medium.webp')));
    assert.ok(homeById.get('pair-low')?.webmPreview.includes(asset('pair-low','preview-low.webm')));
    assert.ok(homeById.get('pair-low')?.thumbnailPoster.includes(asset('pair-low','preview-low.webp')));
    assert.equal(homeById.has('pair-blocked'),false,'blocked media must not enter the moving home feed');

    const mediumDetail=response();
    await handler({method:'GET',headers:{host:'spine-link.vercel.app'},query:{id:'pair-medium'}},mediumDetail);
    assert.equal(mediumDetail.code,200);
    const mediumHtml=String(mediumDetail.body);
    assert.ok(mediumHtml.includes('poster="'+asset('pair-medium','preview-medium.webp')));
    assert.ok(mediumHtml.includes('data-video-src="'+asset('pair-medium','preview-medium.webm')));
    assert.ok(mediumHtml.includes('src="'+asset('pair-medium','preview-medium.webm')));
    const mediumVideoTag=mediumHtml.match(/<video\b[^>]*>/)?.[0]||'';
    assert.ok(mediumVideoTag.includes('preload="none"'),'detail WebM must remain lazy');
    assert.ok(mediumVideoTag.includes('data-video-src='));
    assert.ok(!/\ssrc=/.test(mediumVideoTag),'WebM src must be attached only after the poster decodes');
    assert.ok(!mediumHtml.includes('poster="'+asset('pair-medium','preview-medium.webp')+'" src="'+asset('pair-medium','preview.webm')));

    const lowDetail=response();
    await handler({method:'GET',headers:{host:'spine-link.vercel.app'},query:{id:'pair-low'}},lowDetail);
    assert.equal(lowDetail.code,200);
    const lowHtml=String(lowDetail.body);
    assert.ok(lowHtml.includes('poster="'+asset('pair-low','preview-low.webp')));
    assert.ok(lowHtml.includes('data-video-src="'+asset('pair-low','preview-low.webm')));
    assert.ok(lowHtml.includes('src="'+asset('pair-low','preview-low.webm')));
    assert.ok(!lowHtml.includes('preview-medium.webp'));
    assert.ok(!lowHtml.includes('src="'+asset('pair-low','preview.webm')));

    const videoPage=response();
    await handler({method:'GET',headers:{host:'spine-link.vercel.app'},query:{id:'pair-low',view:'video'}},videoPage);
    assert.equal(videoPage.code,200);
    const videoHtml=String(videoPage.body);
    assert.ok(videoHtml.includes('<video src="'+asset('pair-low','preview-low.webm')+'?v=') && videoHtml.includes('poster="'+asset('pair-low','preview-low.webp')));

    const blockedDetail=response();
    await handler({method:'GET',headers:{host:'spine-link.vercel.app'},query:{id:'pair-blocked'}},blockedDetail);
    assert.equal(blockedDetail.code,200);
    assert.doesNotMatch(String(blockedDetail.body),/<video|<img/,'blocked status must not expose stale media');
    assert.ok(log.length<=24,'unexpected GitHub request fanout: '+log.length);
  }finally{
    globalThis.fetch=originalFetch;
    if(originalToken===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=originalToken;
    if(originalBranch===undefined)delete process.env.GITHUB_BRANCH;else process.env.GITHUB_BRANCH=originalBranch;
  }
});

