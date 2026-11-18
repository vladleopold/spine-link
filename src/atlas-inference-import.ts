import { reconstructAtlas } from "../lib/atlas-inference.js";
import { assertAtlasInferenceUsable } from "../lib/atlas-inference-acceptance.js";

export type InferredAtlasReceipt = {
  kind: "named-pages" | "inferred-packed-sheet";
  confidence: number; coverage: number; matched: number; total: number; scale: number;
};
const isAtlas=(file:File)=>/\.atlas(?:\.(?:txt|docx))?$/i.test(file.name);
const isSkeleton=(file:File)=>/\.json$/i.test(file.name);
const isTexture=(file:File)=>/\.(?:png|jpe?g|webp)$/i.test(file.name);
async function imageData(file:File){
  const bmp=await createImageBitmap(file);
  if(bmp.width*bmp.height>16*1024*1024){bmp.close();throw Error("Atlas image too large for safe inference");}
  const canvas=document.createElement("canvas");
  canvas.width=bmp.width;canvas.height=bmp.height;
  const ctx=canvas.getContext("2d",{willReadFrequently:true});
  if(!ctx){bmp.close();throw Error("Canvas 2D is not available");}
  ctx.drawImage(bmp,0,0);bmp.close();
  const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
  const result={name:file.name,width:canvas.width,height:canvas.height,rgba:pixels.data};
  canvas.width=0;canvas.height=0;
  return result;
}
/** Infer an absent atlas locally before normal Spine file acceptance.
 * The exact original source files are untouched. An inferred atlas is NOT
 * equivalent to a hand-authorized source atlas or native artistic approval.
 */
export async function supplyMissingAtlas(files:File[]):Promise<{
  files:File[]; receipt:InferredAtlasReceipt|null
}>{
  if(files.some(isAtlas))return {files,receipt:null};
  const jsonFiles=files.filter(isSkeleton);
  const imageFiles=files.filter(isTexture);
  if(!jsonFiles.length||!imageFiles.length)return {files,receipt:null};
  if(jsonFiles.length!==1)
    throw Error("Ambiguous Spine skeleton set without an atlas; import each project separately.");
  let skeleton:unknown;
  try{skeleton=JSON.parse(await jsonFiles[0].text());}
  catch {throw Error("The missing-atlas source skeleton is not valid JSON");}
  if(!skeleton||typeof skeleton!=="object"||!Array.isArray((skeleton as any).bones))
    return {files,receipt:null};
  const images=await Promise.all(imageFiles.map(imageData));
  const result=reconstructAtlas(skeleton as Record<string,unknown>,images);
  assertAtlasInferenceUsable(result);
  const atlasName=jsonFiles[0].name.replace(/\.json$/i,".atlas");
  const atlas=new File([result.text],atlasName,{type:"text/plain",
    lastModified:Date.now()});
  return {files:[...files,atlas],receipt:{
    kind:result.kind,confidence:result.confidence,coverage:result.coverage,
    matched:result.matched,total:result.total,scale:result.scale
  }};
}
