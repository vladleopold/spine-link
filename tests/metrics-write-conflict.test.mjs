import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../api/github-upload.js', import.meta.url), 'utf8');
const start = source.indexOf('async function mutateMetrics(');
const end = source.indexOf('\nfunction compareLibraryEntries', start);
assert.ok(start >= 0 && end > start, 'mutateMetrics source must remain available for conflict regression');
const declaration = source.slice(start, end);
function buildMutateMetrics({readMetrics,putGitHubContent,delays,cacheEvents=[]}) {
  const githubMetricsCache = {
    set: (...args) => cacheEvents.push(['set', ...args]),
    invalidate: (...args) => cacheEvents.push(['invalidate', ...args]),
  };
  return new Function(
    'readMetrics','putGitHubContent','textToBase64','setTimeout','Math','githubMetricsCache',
    declaration + '\nreturn mutateMetrics;'
  )(
    readMetrics,putGitHubContent,value=>value,
    (resolve,ms)=>{delays.push(ms);resolve();},
    {min:Math.min,floor:Math.floor,random:()=>0},
    githubMetricsCache
  );
}

test('metrics 409 re-reads the latest SHA and retries with bounded backoff',async()=>{
  let reads=0,writes=0;
  const delays=[],writtenShas=[],cacheEvents=[];
  const mutateMetrics=buildMutateMetrics({
    readMetrics:async()=>({current:{sha:'sha-'+(++reads)},metrics:{views:0}}),
    putGitHubContent:async(_settings,_path,_content,_message,sha)=>{
      writes++;writtenShas.push(sha);
      if(writes<3) throw Object.assign(new Error('GitHub contents SHA conflict'),{status:409});
    },
    delays,
    cacheEvents
  });
  const result=await mutateMetrics({},'metrics.json','track view',metrics=>{metrics.views++;return true;});
  assert.equal(result.changed,true);
  assert.equal(reads,3);
  assert.equal(writes,3);
  assert.deepEqual(writtenShas,['sha-1','sha-2','sha-3']);
  assert.deepEqual(delays,[150,300]);
  assert.equal(cacheEvents.filter(([event])=>event==='invalidate').length,2);
  assert.equal(cacheEvents.filter(([event])=>event==='set').length,1);
});

test('metrics non-conflict errors are not retried',async()=>{
  let reads=0,writes=0;
  const delays=[];
  const mutateMetrics=buildMutateMetrics({
    readMetrics:async()=>({current:{sha:'sha-'+(++reads)},metrics:{views:0}}),
    putGitHubContent:async()=>{writes++;throw Object.assign(new Error('Forbidden'),{status:403});},
    delays
  });
  await assert.rejects(()=>mutateMetrics({},'metrics.json','track view',metrics=>{metrics.views++;return true;}),/Forbidden/);
  assert.equal(reads,1);
  assert.equal(writes,1);
  assert.deepEqual(delays,[]);
});
