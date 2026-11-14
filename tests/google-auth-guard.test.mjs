import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyGoogleToken } from '../api/github-upload.js';

const prevFetch = globalThis.fetch;
const prevClient = process.env.GOOGLE_CLIENT_ID;
process.env.GOOGLE_CLIENT_ID = 'expected-spine-link-client';

const request = {headers:{authorization:'Bearer valid-google-access'}};
const results = [];
function setMocks({aud='expected-spine-link-client',azp='',sub='subject-1',userinfoSub='subject-1',tokenStatus=200}={}) {
  let tokenGets=0, userinfoGets=0;
  globalThis.fetch=async url=>{
    const value=String(url);
    if (value.includes('tokeninfo?id_token=')) {
      return {ok:false,status:400,json:async()=>({error:'invalid_token'})};
    }
    if (value.includes('tokeninfo?access_token=')) {
      tokenGets++;
      return {ok:tokenStatus===200,status:tokenStatus,
        json:async()=>({aud,azp,sub})};
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

test('missing token introspection cannot fall back to userinfo only',async()=>{
  const counts=setMocks({tokenStatus:400});
  await assert.rejects(()=>verifyGoogleToken(request,{}),/audience/);
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
