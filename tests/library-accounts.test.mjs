import {createHash} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/github-upload.js';
import {mergeCollectionEntries} from '../lib/library-accounts.js';

test('new collection values win while missing ownership survives rotation',()=>{
 const entries=mergeCollectionEntries([{entries:[{id:'old',hiddenFromPublicLibrary:true}]},{entries:[{id:'old',ownerEmail:'owner@example.test',hiddenFromPublicLibrary:false}]}]);
 assert.equal(entries.length,1);assert.equal(entries[0].ownerEmail,'owner@example.test');assert.equal(entries[0].hiddenFromPublicLibrary,true);
});
test('signed-in portfolio and anonymous merge include every collection, with owner checks',async()=>{
 const saved=globalThis.fetch,oldToken=process.env.GITHUB_TOKEN,oldClient=process.env.GOOGLE_CLIENT_ID;
 process.env.GITHUB_TOKEN='test-only';process.env.GOOGLE_CLIENT_ID='test.apps.googleusercontent.com';
 const indexes={library_03:[{id:'new',ownerEmail:'owner@example.test'},{id:'foreign',ownerEmail:'other@example.test'}],library_02:[{id:'old',ownerEmail:'owner@example.test',hiddenFromPublicLibrary:true},{id:'anon-old',ownerAnonId:'anon_test'}],library_01:[{id:'oldest',ownerEmail:'owner@example.test'},{id:'original-google',ownerEmailSha256:createHash('sha256').update('owner@example.test').digest('hex')},{id:'foreign-google',ownerEmailSha256:createHash('sha256').update('other@example.test').digest('hex')}],library:[{id:'original',ownerEmail:'owner@example.test'},{id:'anon-original',ownerAnonId:'anon_test'},{id:'linked-other',ownerAnonId:'anon_test',ownerEmail:'other@example.test'}]};
 const writes=[];
 globalThis.fetch=async(url,options={})=>{
  if(String(url).startsWith('https://oauth2.googleapis.com/tokeninfo?id_token='))return new Response(JSON.stringify({aud:'test.apps.googleusercontent.com',email_verified:true,email:'owner@example.test',name:'Owner'}));
  const path=new URL(url).pathname;
  if(path.endsWith('/contents/'))return new Response(JSON.stringify(Object.keys(indexes).map(name=>({type:'dir',name}))));
  const name=decodeURIComponent(path.split('/contents/')[1]||'').split('/')[0];
  if(path.includes('/contents/')&&path.endsWith('/index.json')){
   if(options.method==='PUT'){indexes[name]=JSON.parse(Buffer.from(JSON.parse(options.body).content,'base64').toString());writes.push(name);return new Response('{}');}
   return new Response(JSON.stringify({sha:'sha',encoding:'base64',content:Buffer.from(JSON.stringify(indexes[name]||[])).toString('base64')}));
  }
  throw Error('Unexpected request '+url);
 };
 const call=async action=>{
  let status,result;const response={setHeader(){},status(v){status=v;return this;},json(v){result=v;return this;}};
  await handler({method:'POST',headers:{host:'localhost'},body:{action,scope:'mine',settings:{basePath:'library_03'},googleIdToken:'test-token',anonymousAccount:{id:'anon_test'}}},response);
  assert.equal(status,200,JSON.stringify(result));return result;
 };
 try{
  const own=await call('get-index');
  for(const id of ['new','old','oldest','original','original-google'])assert.ok(own.entries.some(e=>e.id===id));
  assert.ok(!own.entries.some(e=>e.id==='foreign'));assert.ok(!own.entries.some(e=>e.id==='linked-other'));assert.ok(!own.entries.some(e=>e.id==='foreign-google'));assert.equal(own.entries.find(e=>e.id==='old').hiddenFromPublicLibrary,true);
  assert.ok(own.entries.every(e=>e.canEdit===true&&!('ownerEmail' in e)&&!('ownerAnonId' in e)));
  const merged=await call('merge-anonymous-account');assert.equal(merged.merged,true);assert.deepEqual(writes.sort(),['library','library_02']);
  assert.equal(indexes.library.find(e=>e.id==='linked-other').ownerEmail,'other@example.test');
  assert.equal(indexes.library.find(e=>e.id==='anon-original').ownerEmail,'owner@example.test');assert.ok(merged.entries.every(e=>e.canEdit===true));
 }finally{globalThis.fetch=saved;for(const[key,value]of [['GITHUB_TOKEN',oldToken],['GOOGLE_CLIENT_ID',oldClient]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
