import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { decodeDds, parseDdsHeader } from "../lib/dds-texture.js";
import { ddsToPng } from "../lib/dds-png.js";
import assetHandler from "../api/github-asset.js";

function fixture(format="DXT5", width=4, height=4) {
  const blockBytes=format==="DXT1"?8:16;
  const blocks=Math.ceil(width/4)*Math.ceil(height/4);
  const file=Buffer.alloc(128+blocks*blockBytes);
  file.write("DDS ",0,"ascii");
  file.writeUInt32LE(124,4);
  file.writeUInt32LE(height,12);
  file.writeUInt32LE(width,16);
  file.writeUInt32LE(32,76);
  file.write(format,84,"ascii");
  for(let b=0;b<blocks;b++){
    const at=128+b*blockBytes;
    if(format==="DXT5"){file[at]=255;file[at+1]=0;}
    if(format==="DXT3")for(let n=0;n<8;n++)file[at+n]=255;
    const color=at+(format==="DXT1"?0:8);
    file.writeUInt16LE(0xf800,color); // red RGB565
    file.writeUInt16LE(0x001f,color+2); // blue
    file.writeUInt32LE(0,color+4); // all pixels red
  }
  return file;
}
function pngDecodedBytes(buf) {
  assert.deepEqual([...buf.subarray(0,8)],[137,80,78,71,13,10,26,10]);
  const width=buf.readUInt32BE(16),height=buf.readUInt32BE(20);
  const chunks=[];
  let pos=8;
  while(pos<buf.length){
    const len=buf.readUInt32BE(pos),kind=buf.toString("ascii",pos+4,pos+8);
    if(kind==="IDAT")chunks.push(buf.subarray(pos+8,pos+8+len));
    pos+=12+len;
    if(kind==="IEND")break;
  }
  const inflated=inflateSync(Buffer.concat(chunks));
  return {width,height,scanlines:inflated};
}
for(const f of ["DXT1","DXT3","DXT5"]){
  const input=fixture(f),header=parseDdsHeader(input),out=decodeDds(input);
  assert.equal(header.fourCC,f);
  assert.equal(out.width,4);assert.equal(out.height,4);
  assert.deepEqual([...out.rgba.subarray(0,4)],[255,0,0,255]);
  assert.deepEqual([...out.rgba.subarray(60,64)],[255,0,0,255]);
  const p=pngDecodedBytes(ddsToPng(input));
  assert.equal(p.width,4);assert.equal(p.height,4);
  assert.equal(p.scanlines[0],0);
  assert.deepEqual([...p.scanlines.subarray(1,5)],[255,0,0,255]);
  console.log("PASS "+f+" RGBA and standalone PNG exact pixel acceptance");
}
const odd=decodeDds(fixture("DXT5",5,3));
assert.equal(odd.rgba.length,5*3*4);
assert.deepEqual([...odd.rgba.subarray(-4)],[255,0,0,255]);
console.log("PASS non-multiple-of-four dimensions");
assert.throws(()=>decodeDds(fixture("DXT5").subarray(0,127)),/header/);
assert.throws(()=>decodeDds(fixture("DXT5").subarray(0,139)),/truncated/);
const bad=fixture("DXT5");bad.write("DX10",84,"ascii");
assert.throws(()=>decodeDds(bad),/Unsupported DDS compression/);
const bomb=fixture("DXT5");bomb.writeUInt32LE(20000,16);
assert.throws(()=>decodeDds(bomb),/dimensions exceed safe preview limits/);
console.log("PASS invalid files, truncated mip data, DX10, unsafe dimensions fail closed");

function response() {
  const headers=new Map();
  return {
    statusCode:200,headers,body:null,
    setHeader(k,v){headers.set(k.toLowerCase(),String(v));return this},
    getHeader(k){return headers.get(k.toLowerCase())},
    status(n){this.statusCode=n;return this},
    send(v){this.body=v;return this},
    end(){this.body=Buffer.alloc(0);return this},
  };
}
const origFetch=globalThis.fetch;
const origToken=process.env.GITHUB_TOKEN;
process.env.GITHUB_TOKEN="synthetic-test-token";
globalThis.fetch=async (url)=>{
  const p=String(url);
  if(p.includes("/contents/")){
    const payload=p.includes(".atlas?")
      ? Buffer.from("hero.dds\nsize: 4,4\nformat: RGBA8888\nfilter: Linear,Linear\n","utf8")
      : p.includes("bad.dds")
        ? Buffer.from("invalid")
        : fixture("DXT5");
    return Response.json({sha:"synthetic-"+(p.includes(".atlas?")?"atlas":"texture"),
      size:payload.length,content:payload.toString("base64"),encoding:"base64"});
  }
  throw Error("Unexpected external request");
};
const get=async(path,method="GET")=>{
  const res=response();
  await assetHandler({method,headers:{},query:{path,v:"synthetic-v1"}},res);
  return res;
};
try{
  const dds=await get("library/synthetic/hero.dds");
  assert.equal(dds.statusCode,200);
  assert.equal(dds.getHeader("content-type"),"image/png");
  assert.equal(dds.getHeader("x-spine-link-texture-transcoded"),"DXT-to-PNG-v1");
  assert.deepEqual([...dds.body.subarray(0,8)],[137,80,78,71,13,10,26,10]);
  const head=await get("library/synthetic/hero.dds","HEAD");
  assert.equal(head.statusCode,200);
  assert.equal(head.getHeader("content-type"),"image/png");
  assert.equal(head.getHeader("content-length"),undefined);
  const atlas=await get("library/synthetic/hero.atlas");
  assert.equal(atlas.statusCode,200);
  assert.match(atlas.body.toString("utf8"),/hero\.dds\?v=synthetic-v1&dds=png-v1/);
  const invalid=await get("library/synthetic/bad.dds");
  assert.equal(invalid.statusCode,415);
  console.log("PASS GET/HEAD DDS asset acceptance, album atlas cache bust and HTTP 415 invalid file");
} finally {
  globalThis.fetch=origFetch;
  if(origToken===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=origToken;
}
console.log("ALL DDS PIXEL + API ACCEPTANCE TESTS PASSED");
