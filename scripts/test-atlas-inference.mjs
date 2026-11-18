import assert from "node:assert/strict";
import { reconstructAtlas } from "../lib/atlas-inference.js";
import { assertAtlasInferenceUsable } from "../lib/atlas-inference-acceptance.js";

function image(w,h,rectangles){
  const rgba=new Uint8ClampedArray(w*h*4);
  for(const [x,y,rw,rh] of rectangles)
    for(let yy=y;yy<y+rh;yy++)for(let xx=x;xx<x+rw;xx++){
      const i=(yy*w+xx)*4;rgba[i]=255;rgba[i+3]=255;
    }
  return {name:"hero.png",width:w,height:h,rgba};
}
const skeleton={bones:[{name:"root"}],slots:[],skins:{
  default:{slotA:{a:{type:"region",width:20,height:12}},
    slotB:{b:{type:"region",width:12,height:18}},
    slotC:{c:{type:"mesh",width:16,height:22,uvs:[0,0,1,0,0,1]}}}
}};
const im=image(55,35,[[1,1,10,6],[18,2,9,6],[32,8,8,11]]);
const result=reconstructAtlas(skeleton,[im]);
assert.equal(result.total,3);
assert.equal(result.matched,3);
assert.equal(result.scale,.5);
assert.ok(result.coverage>.98);
assert.ok(result.confidence>.95);
assert.equal((result.text.match(/  rotate:/g)||[]).length,3);
assert.match(result.text,/hero\.png\nsize: 55,35/);
assert.match(result.text,/a\n  rotate: false/);
assert.match(result.text,/b\n  rotate: true/);
assert.match(result.text,/c\n  rotate: false/);
assert.ok(result.regions.every(r=>r.box));
assert.throws(()=>reconstructAtlas(skeleton,[image(2,2,[])]),/no visible parts/i);
assert.doesNotThrow(()=>assertAtlasInferenceUsable(result));

// The measured boss_1 candidate had 13/18 strong matches, 73.57% confidence,
// and 94.18% alpha coverage. The export path must accept the same result as
// the browser importer rather than requiring 18/18 perfect matches.
const boss1Metrics={
  inferred:true,confidence:.7357,coverage:.9418,matched:13,total:18
};
assert.ok(Math.abs(assertAtlasInferenceUsable(boss1Metrics)-(13/18))<1e-12);
assert.throws(()=>assertAtlasInferenceUsable({...boss1Metrics,matched:10}),/Cannot infer a reliable atlas/i);
assert.throws(()=>assertAtlasInferenceUsable({...boss1Metrics,confidence:.51}),/Cannot infer a reliable atlas/i);
assert.throws(()=>assertAtlasInferenceUsable({...boss1Metrics,coverage:.74}),/Cannot infer a reliable atlas/i);
assert.throws(()=>assertAtlasInferenceUsable({...boss1Metrics,total:0}),/invalid confidence metrics/i);
assert.doesNotThrow(()=>assertAtlasInferenceUsable({
  inferred:false,confidence:1,coverage:1,matched:18,total:18
}));

console.log("PASS infer atlas: 3/3 source regions, alpha coverage, rotation and UV bounds");
console.log("PASS shared confidence gate: measured 13/18 case accepted; weak and invalid results rejected");
