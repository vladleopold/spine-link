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

function response(strictHeaders = false) {
  const headers=new Map();
  let sent=false;
  return {
    statusCode:200,headers,body:null,
    setHeader(k,v){
      if(strictHeaders) assert.equal(sent,false,"Response headers must be set before send");
      headers.set(k.toLowerCase(),String(v));return this;
    },
    getHeader(k){return headers.get(k.toLowerCase())},
    status(n){this.statusCode=n;return this},
    send(v){this.body=v;sent=true;return this},
    end(){this.body=Buffer.alloc(0);sent=true;return this},
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
const get=async(path,method="GET",headers={},version="synthetic-v1",strictHeaders=false)=>{
  const res=response(strictHeaders);
  await assetHandler({method,headers,query:{path,v:version}},res);
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
  // A warm memory cache can serve accurate transcoded PNG byte length on HEAD.
  const headLength=head.getHeader("content-length");
  assert.ok(headLength===undefined || Number(headLength)===dds.body.length);
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

const originalAssetEnv = {
  owner: process.env.GITHUB_OWNER,
  repo: process.env.GITHUB_REPO,
  branch: process.env.GITHUB_BRANCH,
};
process.env.GITHUB_OWNER = "vladleopold";
process.env.GITHUB_REPO = "spine";
process.env.GITHUB_BRANCH = "main";
process.env.GITHUB_TOKEN = "synthetic-test-token";
const webpBytes = Buffer.from([0x52,0x49,0x46,0x46,0x08,0x00,0x00,0x00,0x57,0x45,0x42,0x50]);
try {
  for (const [status, assetPath, version] of [
    [403, "library/synthetic/preview-medium.webp", "raw-403"],
    [429, "library/synthetic/preview-low.webp", "raw-429"],
  ]) {
    const expectedPath = assetPath.split("/").map(encodeURIComponent).join("/");
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).includes("/contents/")) {
        return new Response(JSON.stringify({ message: "synthetic API rate limit" }), { status });
      }
      assert.equal(
        String(url),
        `https://raw.githubusercontent.com/vladleopold/spine/main/${expectedPath}`,
      );
      assert.equal(options.method || "GET", "GET");
      return new Response(webpBytes, {
        status: 200,
        headers: { etag: `"raw-${version}"`, "content-length": String(webpBytes.length) },
      });
    };
    const recovered = await get(assetPath, "GET", {}, version, true);
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.getHeader("content-type"), "image/webp");
    assert.equal(recovered.getHeader("x-spine-link-asset-source"), "raw-public");
    assert.equal(recovered.getHeader("x-spine-link-asset-cache"), "raw-fallback");
    assert.deepEqual(recovered.body, webpBytes);
  }

  // Contents metadata can succeed even when its download_url is rate-limited.
  // The asset route must retry the same exact raw path without the rejected token.
  const downloadUrl = "https://raw.githubusercontent.com/vladleopold/spine/main/library/synthetic/download-url-403/preview-medium.webp";
  const downloadAttempts = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/contents/")) {
      return Response.json({
        sha: "synthetic-download-403",
        size: webpBytes.length,
        content: "",
        encoding: "none",
        download_url: downloadUrl,
      });
    }
    assert.equal(String(url), downloadUrl);
    downloadAttempts.push(Boolean(options.headers?.Authorization));
    if (options.headers?.Authorization) {
      return new Response("synthetic download_url forbidden", { status: 403 });
    }
    return new Response(webpBytes, {
      status: 200,
      headers: { etag: '"raw-download-403"', "content-length": String(webpBytes.length) },
    });
  };
  const recoveredFromDownload403 = await get(
    "library/synthetic/download-url-403/preview-medium.webp",
    "GET", {}, "download-url-403", true,
  );
  assert.equal(recoveredFromDownload403.statusCode, 200);
  assert.equal(recoveredFromDownload403.getHeader("content-type"), "image/webp");
  assert.equal(recoveredFromDownload403.getHeader("x-spine-link-asset-source"), "raw-public");
  assert.equal(recoveredFromDownload403.getHeader("x-spine-link-asset-cache"), "raw-fallback");
  assert.deepEqual(recoveredFromDownload403.body, webpBytes);
  assert.deepEqual(downloadAttempts, [true, false],
    "retry the identical raw URL without the rejected GitHub API token");

  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/contents/")) {
      return new Response(JSON.stringify({ message: "synthetic API forbidden" }), { status: 403 });
    }
    assert.ok(String(url).startsWith("https://raw.githubusercontent.com/"));
    assert.equal(options.method, "HEAD");
    return new Response(null, {
      status: 200,
      headers: { etag: '"raw-head"', "content-length": "37" },
    });
  };
  const headFallback = await get("library/synthetic/preview-medium.webp", "HEAD", {}, "raw-head", true);
  assert.equal(headFallback.statusCode, 200);
  assert.equal(headFallback.getHeader("content-length"), "37");
  assert.equal(headFallback.getHeader("x-spine-link-asset-source"), "raw-public");
  assert.equal(headFallback.body.length, 0);

  const rangeBytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/contents/")) {
      return new Response(JSON.stringify({ message: "synthetic API rate limit" }), { status: 429 });
    }
    assert.ok(String(url).startsWith("https://raw.githubusercontent.com/"));
    assert.equal(options.headers.Range, "bytes=0-3");
    return new Response(rangeBytes, {
      status: 206,
      headers: {
        etag: '"raw-range"',
        "content-range": "bytes 0-3/100",
        "content-length": "4",
      },
    });
  };
  const ranged = await get("library/synthetic/preview.webm", "GET", { range: "bytes=0-3" }, "raw-range", true);
  assert.equal(ranged.statusCode, 206);
  assert.equal(ranged.getHeader("content-range"), "bytes 0-3/100");
  assert.deepEqual(ranged.body, rangeBytes);

  // The raw-public retry must preserve the same transformations as the
  // Contents API path: DDS becomes a real PNG, atlas page URLs are versioned,
  // and embedded data URLs are stripped from the public library index.
  const rawDds = fixture("DXT5");
  const rawAtlas = Buffer.from("hero.dds\nsize: 4,4\nformat: RGBA8888\nfilter: Linear,Linear\n", "utf8");
  const rawIndex = Buffer.from(JSON.stringify([{
    id: "synthetic-public-entry",
    thumbnail: "data:image/webp;base64,AA==",
    thumbnailPoster: "data:image/webp;base64,BB==",
    webmPreview: "data:video/webm;base64,CC==",
  }]), "utf8");
  const rawObjects = new Map([
    ["library/synthetic/raw/hero.dds", rawDds],
    ["library/synthetic/raw/hero.atlas", rawAtlas],
    ["library/index.json", rawIndex],
  ]);
  globalThis.fetch = async (url, options = {}) => {
    const requested = String(url);
    if (requested.includes("/contents/")) {
      return new Response(JSON.stringify({ message: "synthetic API forbidden" }), { status: 403 });
    }
    const match = [...rawObjects.entries()].find(([assetPath]) =>
      requested === "https://raw.githubusercontent.com/vladleopold/spine/main/" +
        assetPath.split("/").map(encodeURIComponent).join("/"));
    assert.ok(match, "raw recovery must request the exact original asset path");
    assert.equal(options.method || "GET", "GET");
    return new Response(match[1], {
      status: 200,
      headers: { etag: '"raw-transformed"', "content-length": String(match[1].length) },
    });
  };

  const recoveredDds = await get("library/synthetic/raw/hero.dds", "GET", {}, "raw-dds", true);
  assert.equal(recoveredDds.statusCode, 200);
  assert.equal(recoveredDds.getHeader("content-type"), "image/png");
  assert.equal(recoveredDds.getHeader("x-spine-link-texture-transcoded"), "DXT-to-PNG-v1");
  assert.deepEqual([...recoveredDds.body.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(recoveredDds.body, ddsToPng(rawDds));

  const recoveredAtlas = await get("library/synthetic/raw/hero.atlas", "GET", {}, "raw-atlas", true);
  assert.equal(recoveredAtlas.statusCode, 200);
  assert.match(recoveredAtlas.body.toString("utf8"), /hero\.dds\?v=raw-atlas&dds=png-v1/);

  const recoveredIndex = await get("library/index.json", "GET", {}, "raw-index", true);
  assert.equal(recoveredIndex.statusCode, 200);
  const sanitizedEntries = JSON.parse(recoveredIndex.body.toString("utf8"));
  assert.equal(sanitizedEntries[0].thumbnail, "");
  assert.equal(sanitizedEntries[0].thumbnailPoster, "");
  assert.equal(sanitizedEntries[0].webmPreview, "");
  console.log("PASS exact-path raw recovery preserves DDS conversion, atlas versioning and index sanitization");
} finally {
  globalThis.fetch = origFetch;
  for (const [key, value] of Object.entries(originalAssetEnv)) {
    const envKey = key === "owner" ? "GITHUB_OWNER" : key === "repo" ? "GITHUB_REPO" : "GITHUB_BRANCH";
    if (value === undefined) delete process.env[envKey]; else process.env[envKey] = value;
  }
  if (origToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = origToken;
}

console.log("ALL DDS PIXEL + API ACCEPTANCE TESTS PASSED");
