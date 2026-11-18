import { reconstructAtlas, attachmentRegions } from "../lib/atlas-inference.js";

export type AtlasRecovery = {
  skeleton:string;
  generatedAtlas:string;
  confidence:"matched"|"inferred"|"low";
  regionCount:number;
  unverified:number;
  details:string;
};

const isJson=(f:File)=>/\.json$/i.test(f.name);
const isImage=(f:File)=>/\.(png|jpe?g|webp)$/i.test(f.name);
const basename=(value:string)=>value.replace(/\\/g,"/").split("/").pop()||"";
const stem=(value:string)=>basename(value).replace(/\.(?:json|skel|atlas(?:\.txt)?|png|jpe?g|webp)$/i,"").toLowerCase();

async function imageGeometry(file:File,needsAlpha:boolean) {
  const bitmap=await createImageBitmap(file);
  try {
    if(bitmap.width*bitmap.height>18*1024*1024)
      throw new Error("PNG exceeds safe atlas reconstruction size");
    const image:{name:string;width:number;height:number;alpha?:Uint8Array}={
      name:basename(file.name),width:bitmap.width,height:bitmap.height,
    };
    if(needsAlpha){
      const canvas=document.createElement("canvas");
      canvas.width=bitmap.width;canvas.height=bitmap.height;
      const ctx=canvas.getContext("2d",{willReadFrequently:true});
      if(!ctx)throw Error("Canvas alpha analysis unavailable");
      ctx.drawImage(bitmap,0,0);
      const pixels=ctx.getImageData(0,0,bitmap.width,bitmap.height).data;
      const alpha=new Uint8Array(bitmap.width*bitmap.height);
      for(let i=0;i<alpha.length;i++)alpha[i]=pixels[i*4+3];
      image.alpha=alpha;
      canvas.width=0;canvas.height=0;
    }
    return image;
  }finally{bitmap.close();}
}

/**
 * Create virtual atlas FILES for JSON+PNG selection, preserving originals.
 * An atlas with uncertain packing is never represented as a verified export.
 */
export async function recoverMissingAtlasFiles(files:File[]):Promise<{
  files:File[];
  reports:Map<string,AtlasRecovery>;
}> {
  const reports=new Map<string,AtlasRecovery>();
  const output=[...files];
  const images=files.filter(isImage);
  const atlasStems=new Set(files.filter(f=>/\.atlas(?:\.txt)?$/i.test(f.name)).map(f=>stem(f.name)));
  const jsons=files.filter(isJson);
  for(const jsonFile of jsons){
    const name=stem(jsonFile.name);
    if(atlasStems.has(name))continue;
    // Preserve compatibility with a single differently named supplied atlas.
    if(jsons.length===1 && files.some(f=>/\.atlas(?:\.txt)?$/i.test(f.name)))continue;
    if(!images.length)continue;
    let skeleton:unknown;
    try{skeleton=JSON.parse(await jsonFile.text());}
    catch{continue;}
    const regions=attachmentRegions(skeleton);
    if(!regions.length)continue;
    const geometry=await Promise.all(images.map(f=>
      imageGeometry(f,images.length===1 && regions.length>1)));
    const recovered=reconstructAtlas(skeleton,geometry);
    const generatedAtlas=basename(jsonFile.name).replace(/\.json$/i,".atlas");
    output.push(new File([recovered.atlas],generatedAtlas,{
      type:"text/plain",lastModified:jsonFile.lastModified,
    }));
    reports.set(name,{
      skeleton:jsonFile.name,generatedAtlas,
      confidence:recovered.confidence,regionCount:recovered.regionCount,
      unverified:recovered.unverified,details:recovered.details,
    });
    atlasStems.add(name);
  }
  return {files:output,reports};
}
