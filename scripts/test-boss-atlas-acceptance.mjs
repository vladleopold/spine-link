import assert from "node:assert/strict";
import { validateSpineRuntimeFiles } from "../lib/spine-asset-graph.js";
import previewHandler from "../api/github-preview.js";

const invalid=validateSpineRuntimeFiles(["boss_1.json","boss_1.png"]);
assert.equal(invalid.ok,false);
assert.equal(invalid.code,"INCOMPLETE_SPINE_ASSETS");
assert.deepEqual(invalid.missing,[".atlas"]);
assert.equal(validateSpineRuntimeFiles(["hero.json","hero.atlas","hero.png"]).ok,true);
assert.equal(validateSpineRuntimeFiles(["hero.skel","hero.atlas.txt","images/hero.dds"]).ok,true);
assert.equal(validateSpineRuntimeFiles(["hero.json","alien.atlas","hero.png","other.atlas"]).ok,false);
assert.equal(validateSpineRuntimeFiles(["hero.json","hero.atlas","hero.png","skin1.png"]).ok,true);
console.log("PASS file graph: rejects the exact missing-atlas boss_1 case while accepting genuine Spine runtime bundles");

const id="boss_1-2026-11-14T20-07-17-943Z";
const collection="library_02";
const directory=collection+"/"+id;
const entry={id,title:"boss_1",previewPath:directory,files:["boss_1.json","boss_1.png"],
  skeleton:"boss_1.json",atlas:"",textures:["boss_1.png"],webmStatus:"pending",webmPreview:""};
const fakeContent={encoding:"base64",content:Buffer.from(JSON.stringify([entry])).toString("base64")};
const oldFetch=globalThis.fetch,oldToken=process.env.GITHUB_TOKEN,oldBase=process.env.GITHUB_BASE_PATH;
process.env.GITHUB_TOKEN="test-placeholder-token";
process.env.GITHUB_BASE_PATH=collection;
let queried=[];
globalThis.fetch=async url=>{
  const route=new URL(String(url)),p=decodeURIComponent(route.pathname);
  queried.push(p);
  if(p.endsWith("/contents/") || p.endsWith("/contents"))
    return Response.json([{name:collection,type:"dir",path:collection}]);
  if(p.endsWith("/contents/"+collection+"/index.json"))return Response.json(fakeContent);
  if(p.endsWith("/contents/"+directory))return Response.json([
    {name:"boss_1.json",type:"file",path:directory+"/boss_1.json",sha:"synthetic-skel",size:1024},
    {name:"boss_1.png",type:"file",path:directory+"/boss_1.png",sha:"synthetic-art",size:1024},
  ]);
  return Response.json({message:"Not Found"},{status:404});
};
function fakeResponse(){
  return {statusCode:200,body:"",headers:{},
    setHeader(k,v){this.headers[k.toLowerCase()]=v;return this;},
    status(code){this.statusCode=code;return this;},
    send(content){this.body=String(content);return this;},
  };
}
try {
  const response=fakeResponse();
  await previewHandler({method:"GET",query:{entry:id},
    headers:{"x-forwarded-proto":"https","x-forwarded-host":"spine-link.vercel.app"}},response);
  assert.equal(response.statusCode,200,"Missing atlas preview must still resolve");
  assert.match(response.headers["content-type"],/text\/html/);
  assert.match(response.body,/Animation unavailable — incomplete Spine files/);
  assert.match(response.body,/original Spine atlas is missing/i);
  assert.match(response.body,/boss_1\.png/);
  assert.match(response.body,/boss_1\.json/);
  assert.doesNotMatch(response.body,/new SpinePlayer\s*\(/);
  assert.match(response.headers["x-robots-tag"],/noindex/i);
  console.log("PASS missing-atlas boss_1: HTML displays original image and source links, no fake playable animation");
  assert.ok(queried.some(p=>p.endsWith("/contents/"+directory)));
} finally {
  globalThis.fetch=oldFetch;
  if(oldToken===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=oldToken;
  if(oldBase===undefined)delete process.env.GITHUB_BASE_PATH;else process.env.GITHUB_BASE_PATH=oldBase;
}
