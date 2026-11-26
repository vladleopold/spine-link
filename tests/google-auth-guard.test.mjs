import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyGoogleToken } from '../api/github-upload.js';
import { hasUsableGoogleSession } from '../lib/google-session.js';

const prevFetch = globalThis.fetch;
const prevClient = process.env.GOOGLE_CLIENT_ID;
process.env.GOOGLE_CLIENT_ID = 'expected-spine-link-client';

const request = {headers:{authorization:'Bearer valid-google-access'}};
const results = [];
function setMocks({aud='expected-spine-link-client',azp='',issuedTo='',audience='',sub='subject-1',userinfoSub='subject-1',tokenStatus=200}={}) {
  let tokenGets=0, userinfoGets=0;
  globalThis.fetch=async url=>{
    const value=String(url);
    if (value.includes('tokeninfo?id_token=')) {
      return {ok:false,status:400,json:async()=>({error:'invalid_token'})};
    }
    if (value.includes('tokeninfo?access_token=')) {
      tokenGets++;
      return {ok:tokenStatus===200,status:tokenStatus,
        json:async()=>({aud,azp,issued_to:issuedTo,audience,sub})};
    }
    if (value.endsWith('/userinfo')) {
      userinfoGets++;
      return {ok:true,status:200,json:async()=>({
        sub:userinfoSub,email:'email@test.invalid',email_verified:true
      })};
    }
    throw new Error('Unexpected external request');
  };
  return ()=>({tokenGets,userinfoGets});
}

test('only an access token issued to this Google OAuth client can edit or delete',async()=>{
  const counts=setMocks();
  const profile=await verifyGoogleToken(request,{});
  assert.equal(profile.sub,'subject-1');
  assert.deepEqual(counts(),{tokenGets:1,userinfoGets:1});
});

test('foreign Google access token is rejected even if userinfo would verify email',async()=>{
  const counts=setMocks({aud:'evil-other-client'});
  await assert.rejects(()=>verifyGoogleToken(request,{}),/audience/);
  assert.deepEqual(counts(),{tokenGets:1,userinfoGets:0});
});

test('access-token tokeninfo issued_to claim is accepted for this OAuth client',async()=>{
  const counts=setMocks({aud:'',azp:'',issuedTo:'expected-spine-link-client'});
  const profile=await verifyGoogleToken(request,{});
  assert.equal(profile.sub,'subject-1');
  assert.deepEqual(counts(),{tokenGets:1,userinfoGets:1});
});

test('access-token tokeninfo audience field is accepted for this OAuth client',async()=>{
  const counts=setMocks({aud:'',azp:'',audience:'expected-spine-link-client'});
  const profile=await verifyGoogleToken(request,{});
  assert.equal(profile.sub,'subject-1');
  assert.deepEqual(counts(),{tokenGets:1,userinfoGets:1});
});

test('foreign access-token issued_to claim remains rejected',async()=>{
  const counts=setMocks({aud:'',azp:'',issuedTo:'evil-other-client',audience:'evil-other-client'});
  await assert.rejects(()=>verifyGoogleToken(request,{}),/audience/);
  assert.deepEqual(counts(),{tokenGets:1,userinfoGets:0});
});

test('audience mismatch diagnostics expose client claims but never the bearer token',async()=>{
  const logs=[];
  const oldWarn=console.warn;
  console.warn=(...args)=>logs.push(args);
  setMocks({aud:'',azp:'',issuedTo:'legacy-client-id',audience:'legacy-client-id'});
  try{
    await assert.rejects(()=>verifyGoogleToken(request,{}),/audience/);
    assert.equal(logs.length,1);
    assert.equal(logs[0][0],'[AUTH] Google access-token audience mismatch');
    assert.deepEqual(logs[0][1],{
      status:200,
      expectedClientId:'expected-spine-link-client',
      issued_to:'legacy-client-id',
      audience:'legacy-client-id',
      aud:null,
      azp:null,
    });
    assert.equal(JSON.stringify(logs).includes('valid-google-access'),false);
  }finally{console.warn=oldWarn;}
});

test('invalid or expired access tokens are not mislabeled as an audience mismatch',async()=>{
  const counts=setMocks({tokenStatus:400});
  await assert.rejects(()=>verifyGoogleToken(request,{}),/expired or invalid/);
  assert.equal(counts().userinfoGets,0);
});

test('token and Google profile subject mismatch is rejected',async()=>{
  setMocks({userinfoSub:'different-account'});
  await assert.rejects(()=>verifyGoogleToken(request,{}),/subject/);
});

test('authorized-party claim allows tokens where audience differs legitimately',async()=>{
  setMocks({aud:'some-other-audience',azp:'expected-spine-link-client'});
  const profile=await verifyGoogleToken(request,{});
  assert.equal(profile.sub,'subject-1');
});

test.after(()=>{
  globalThis.fetch=prevFetch;
  if(prevClient===undefined)delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID=prevClient;
});


test('stored Google access tokens are reused only for the OAuth client that issued them', () => {
  const now = 1_000_000;
  const valid = {
    user: { email: 'email@test.invalid' },
    accessToken: 'valid-token',
    clientId: 'expected-spine-link-client',
    expiresAt: now + 3_600_000,
  };

  assert.equal(hasUsableGoogleSession(valid, 'expected-spine-link-client', now), true);
  assert.equal(hasUsableGoogleSession({ ...valid, clientId: 'old-google-client' }, 'expected-spine-link-client', now), false);
  assert.equal(hasUsableGoogleSession({ ...valid, clientId: undefined }, 'expected-spine-link-client', now), false);
  assert.equal(hasUsableGoogleSession({ ...valid, expiresAt: now + 30_000 }, 'expected-spine-link-client', now), false);
  assert.equal(hasUsableGoogleSession(valid, '', now), false);
});
