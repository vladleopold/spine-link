import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const compiled = ts.transpile(fs.readFileSync(new URL('../src/upload-request.ts', import.meta.url), 'utf8'), {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022});
const exports = {};
const sleeps = [];
new Function('exports', 'setTimeout', compiled)(exports, (fn, ms) => { sleeps.push(ms); fn(); });
const { uploadRequest } = exports;
for (const status of [400, 401, 403, 404, 409, 413, 422]) {
 test(`HTTP ${status} retains server response without retry`, async () => {
  let count = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = async () => { count++; return new Response('original error', {status}); };
  try { const r = await uploadRequest('/upload', {}); assert.equal(r.status,status); assert.equal(await r.text(),'original error'); assert.equal(count,1); }
  finally { globalThis.fetch = saved; }
 });
}
test('network failure, 503 and successful retry', async () => {
 let count=0; const saved=globalThis.fetch;
 globalThis.fetch=async()=>{if(++count===1)throw new TypeError('network');return new Response('{}',{status:count===2?503:200});};
 try { assert.equal((await uploadRequest('/upload',{})).status,200); assert.equal(count,3); } finally {globalThis.fetch=saved;}
});
test('429 honors Retry-After and keeps final response readable', async()=>{
 let count=0; const saved=globalThis.fetch;sleeps.length=0;
 globalThis.fetch=async()=>new Response('{"ok":true}',{status:++count===1?429:200,headers:{'Retry-After':'2'}});
 try{assert.equal(await(await uploadRequest('/upload',{})).text(),'{"ok":true}');assert.deepEqual(sleeps,[2000]);}finally{globalThis.fetch=saved;}
});
test('temporary failures stop at retry limit',async()=>{
 let count=0;const saved=globalThis.fetch;globalThis.fetch=async()=>{count++;return new Response('unavailable',{status:503});};
 try{assert.equal((await uploadRequest('/upload',{})).status,503);assert.equal(count,3);}finally{globalThis.fetch=saved;}
});

test('browser storage failure does not stop transfer; duplicate recovery is ignored; selected collection is retained', async () => {
 const main=fs.readFileSync(new URL('../src/main.tsx',import.meta.url),'utf8');
 const snippet=main.slice(main.indexOf('const activeBackgroundUploads ='),main.indexOf('\nasync function finalizeBackgroundUpload('));
 let uploads=0, finalized=0, finalPath=''; let release;
 const gate=new Promise(resolve=>{release=resolve;});
 const deps={
  getAnonymousAccount:()=>({id:'anon_test'}), window:{location:{origin:'https://example.test'}},
  getBackgroundUploads:()=>[], addBackgroundUpload:()=>({id:'job'}),
  uploadBackgroundFilesFast:async()=>{uploads++;await gate;return 'library_03/work';},
  finishBackgroundUpload:async()=>{finalized++;},
  updateBackgroundUpload:(_id,value)=>{if(value.uploadPath)finalPath=value.uploadPath;},showBackgroundPopup:()=>{},
  pendingUploadPut:async()=>{throw new Error('Quota exceeded');},
  isSpineProjectFile:()=>false, projectFilePath:(file)=>file.name,
  rememberProjectFilePath:()=>{}, console:{warn:()=>{}}
 };
 const code=ts.transpile(snippet,{target:ts.ScriptTarget.ES2022});
 const start=new Function('deps',`const {${Object.keys(deps).join(',')}}=deps;${code};return startBackgroundUpload;`)(deps);
 const job={id:'job',uploadId:'work',uploadPath:'work',uploadedAt:'2026-11-07T00:00:00Z',title:'test'};
 start([{name:'frame.png'}],job);start([{name:'frame.png'}],job);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(uploads,1);
 release();await new Promise(resolve=>setImmediate(resolve));assert.equal(finalized,1);assert.equal(finalPath,'library_03/work');
 // A new job attempts persistence, fails quota, and must still transfer.
 start([{name:'frame.png'}]);await new Promise(resolve=>setImmediate(resolve));assert.equal(uploads,2);assert.equal(finalized,2);
});
