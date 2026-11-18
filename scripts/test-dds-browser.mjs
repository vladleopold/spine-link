import assert from "node:assert/strict";
import { chromium } from "playwright";
const base="http://127.0.0.1:4173";
const browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
const page=await browser.newPage();
try{
  await page.goto(base+"/",{waitUntil:"domcontentloaded",timeout:30000});
  const outcome=await page.evaluate(async()=>{
    const {normalizeSpineTextureFiles}=await import("/src/dds-import.ts");
    const bytes=new Uint8Array(144),view=new DataView(bytes.buffer);
    bytes.set([68,68,83,32],0); // DDS
    view.setUint32(4,124,true);view.setUint32(12,4,true);view.setUint32(16,4,true);
    view.setUint32(76,32,true);bytes.set([68,88,84,53],84);
    bytes[128]=255;bytes[129]=0;
    view.setUint16(136,0xf800,true);view.setUint16(138,0x001f,true);
    const f=new File([bytes],"titan.dds",{type:"application/octet-stream"});
    const atlas=new File(["titan.dds\nsize: 4,4\nformat: RGBA8888\nfilter: Linear,Linear\n"],"titan.atlas");
    const normalized=await normalizeSpineTextureFiles([f,atlas]);
    const png=normalized.files.find(x=>x.name==="titan.png");
    const fixedAtlas=normalized.files.find(x=>x.name==="titan.atlas");
    if(!png||!fixedAtlas)throw Error("DDS was not accepted as PNG atlas image");
    const converted=new Uint8Array(await png.arrayBuffer());
    if(!converted.slice(0,8).every((v,i)=>v===[137,80,78,71,13,10,26,10][i]))throw Error("Not a real PNG");
    const img=await createImageBitmap(png);
    const canvas=document.createElement("canvas");
    canvas.width=4;canvas.height=4;const ctx=canvas.getContext("2d");
    ctx.drawImage(img,0,0);
    const rgba=[...ctx.getImageData(0,0,1,1).data];
    const atlasText=await fixedAtlas.text();
    const noDds=normalized.files.every(x=>!x.name.endsWith(".dds"));
    let invalidRejected=false,missingRejected=false;
    try{await normalizeSpineTextureFiles([new File([bytes.slice(0,130)],"bad.dds"),atlas]);}
    catch{invalidRejected=true;}
    try{await normalizeSpineTextureFiles([atlas]);}
    catch{missingRejected=true;}
    return {fileNames:normalized.files.map(x=>x.name),originals:normalized.originalDdsFiles.length,
      pages:normalized.convertedPages,rgba,atlasText,noDds,invalidRejected,missingRejected};
  });
  assert.equal(outcome.originals,1);
  assert.equal(outcome.pages,1);
  assert.equal(outcome.noDds,true);
  assert.deepEqual(outcome.rgba,[255,0,0,255]);
  assert.match(outcome.atlasText,/^titan\.png\nsize: 4,4/m);
  assert.equal(outcome.invalidRejected,true);
  assert.equal(outcome.missingRejected,true);
  console.log("PASS real Chromium DDS file acceptance, atlas rewrite and RGBA decoder");
  console.log("PASS reject truncated DDS and missing atlas page; source remains in original file list");
}finally{await browser.close();}
