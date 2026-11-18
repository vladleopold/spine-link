import assert from "node:assert/strict";
import { attachmentRegions,reconstructAtlas } from "../lib/atlas-inference.js";
import { pngAlpha } from "../lib/png-alpha-node.js";
import { encodeRgbaPng } from "../lib/dds-png.js";

const skeleton={
  skeleton:{spine:"3.8.99"},bones:[{name:"root"}],
  slots:[{name:"slot-a",bone:"root"}],
  skins:{default:{
    "slot-a":{body:{type:"region",width:3,height:3},
      arm:{path:"arm",width:2,height:3,type:"region"},
      hitbox:{type:"boundingbox",vertices:[0,0,2,2]}}
  }},
  animations:{idle:{}}
};
assert.deepEqual(attachmentRegions(skeleton).map(x=>x.name),["body","arm"]);
const direct=reconstructAtlas(skeleton,[
  {name:"body.png",width:3,height:3},
  {name:"arm.png",width:2,height:3}
]);
assert.equal(direct.confidence,"matched");
assert.equal(direct.matched,2);
assert.match(direct.atlas,/body\.png\nsize: 3,3[\s\S]*body\n  rotate: false/);
assert.match(direct.atlas,/arm\.png\nsize: 2,3[\s\S]*arm\n  rotate: false/);

const width=12,height=6,rgba=new Uint8ClampedArray(width*height*4);
function fillRect(x0,y0,w,h){
  for(let y=y0;y<y0+h;y++)for(let x=x0;x<x0+w;x++){
    const i=(y*width+x)*4;
    rgba[i]=180;rgba[i+1]=80;rgba[i+2]=30;rgba[i+3]=255;
  }
}
fillRect(1,1,3,3);fillRect(8,1,2,3);
const image=pngAlpha(encodeRgbaPng({width,height,rgba}));
assert.equal(image.width,width);assert.equal(image.height,height);
const reconstructed=reconstructAtlas(skeleton,[{name:"packed.png",...image}]);
assert.equal(reconstructed.confidence,"inferred");
assert.equal(reconstructed.alphaAssigned,2);
assert.equal(reconstructed.unverified,0);
assert.match(reconstructed.atlas,/xy: 1, 1/);
assert.match(reconstructed.atlas,/xy: 8, 1/);
assert.match(reconstructed.atlas,/body\n  rotate: false/);
assert.match(reconstructed.atlas,/arm\n  rotate: false/);

const extra={...skeleton,skins:{default:{
  "slot-a":{...skeleton.skins.default["slot-a"],tail:{width:6,height:3}}
}}};
const low=reconstructAtlas(extra,[{name:"packed.png",...image}]);
assert.equal(low.confidence,"low");
assert.ok(low.unverified>0);
assert.match(low.atlas,/tail\n  rotate: false/);
const version4={skins:[{name:"default",attachments:{
  hand:{attachment:{type:"mesh",path:"images\/hand",width:8,height:8}},
}}]};
assert.equal(attachmentRegions(version4)[0].name,"images/hand");
assert.throws(()=>reconstructAtlas({},[{name:"x.png",width:4,height:4}]),/no region/i);
assert.throws(()=>reconstructAtlas(skeleton,[{name:"x.png",width:50000,height:50000}]),/Invalid PNG/i);
console.log("PASS atlas inference direct image filenames, alpha islands, packed geometry and low-confidence guard");
console.log("PASS PNG RGBA alpha scan, JSON 3.8 and 4.x skins, mesh paths and safe limits");
