import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
try{
 const page=await browser.newPage({viewport:{width:1280,height:800}});
 await page.goto("http://127.0.0.1:4173/",{waitUntil:"domcontentloaded",timeout:30000});
 const result=await page.evaluate(async()=>{
   const {supplyMissingAtlas}=await import("/src/atlas-inference-import.ts");
   const canvas=document.createElement("canvas");canvas.width=55;canvas.height=35;
   const ctx=canvas.getContext("2d");
   for(const [x,y,w,h] of [[1,1,10,6],[18,2,9,6],[32,8,8,11]]) {
      ctx.fillStyle="#f00";ctx.fillRect(x,y,w,h);
   }
   const png=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));
   const image=new File([png],"hero.png",{type:"image/png"});
   const skel=new File([JSON.stringify({
     bones:[{name:"root"}],skins:{default:{a:{r0:{width:20,height:12},r1:{width:12,height:18},
       r2:{type:"mesh",width:16,height:22,uvs:[0,0,1,0,0,1]}}}}
   })],"hero.json",{type:"application/json"});
   const inferred=await supplyMissingAtlas([skel,image]);
   const generated=inferred.files.find(f=>f.name==="hero.atlas");
   return {files:inferred.files.map(x=>x.name),receipt:inferred.receipt,
     atlas:generated?await generated.text():"",originalSize:image.size};
 });
 assert.deepEqual(result.files.sort(),["hero.atlas","hero.json","hero.png"]);
 assert.equal(result.receipt?.matched,3);
 assert.equal(result.receipt?.scale,.5);
 assert.ok(result.receipt.confidence>.95);
 assert.match(result.atlas,/hero\.png\nsize: 55,35/);
 console.log("PASS Chromium file-drop JSON+PNG -> valid inferred .atlas + original source files");
}finally{await browser.close();}
