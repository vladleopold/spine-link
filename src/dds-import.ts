import { decodeDds } from "../lib/dds-texture.js";

const DDS_EXT=/\.dds$/i;
const PNG_EXT=/\.png$/i;
const PNG_MAGIC=[137,80,78,71,13,10,26,10];

function fileName(file: File) {
  return file.name.replace(/\\/g,"/").split("/").pop()||"";
}
function pngName(name: string) { return name.replace(DDS_EXT,".png"); }
function isPngBytes(bytes: Uint8Array) {
  return bytes.length>=8 && PNG_MAGIC.every((n,i)=>bytes[i]===n);
}
async function fileAsPng(file: File): Promise<{file:File; original?:File}> {
  const input=new Uint8Array(await file.arrayBuffer());
  const outputName=pngName(fileName(file));
  // A previously saved .dds URL may already be transcoded to image/png by
  // the server. Do not try to decode PNG as though it were DDS.
  if(isPngBytes(input))return {file:new File([input],outputName,{type:"image/png",lastModified:file.lastModified})};
  let decoded;
  try {
    decoded=decodeDds(input);
  } catch(e) {
    throw new Error("Cannot import "+fileName(file)+": "+(e instanceof Error?e.message:"Invalid DDS texture"));
  }
  const canvas=document.createElement("canvas");
  canvas.width=decoded.width;canvas.height=decoded.height;
  const ctx=canvas.getContext("2d");
  if(!ctx)throw new Error("Canvas not available for DDS texture conversion");
  const rgba=new Uint8ClampedArray(decoded.rgba);
  ctx.putImageData(new ImageData(rgba,decoded.width,decoded.height),0,0);
  const blob=await new Promise<Blob>((resolve,reject)=>
    canvas.toBlob((next)=>next?resolve(next):reject(new Error("DDS PNG encoding failed")),"image/png"));
  if(!blob.size)throw new Error("DDS PNG encoding produced an empty texture");
  canvas.width=0;canvas.height=0;
  return {file:new File([blob],outputName,{type:"image/png",lastModified:file.lastModified}),original:file};
}

function rewriteAtlasDdsPages(text:string) {
  const lines=text.split(/\r?\n/);
  const refs:string[]=[];
  for(let i=0;i+1<lines.length;i++){
    const name=lines[i].trim();
    // Only rewrite ATLAS PAGE declarations. Region names may legally end
    // with '.dds' too; do not touch those.
    if(/^\S.*\.dds$/i.test(name) && /^(size|format|filter|repeat|pma)\s*:/i.test(lines[i+1].trim())){
      refs.push(name);
      lines[i]=lines[i].replace(DDS_EXT,".png");
    }
  }
  return {text:lines.join("\n"),refs};
}

/**
 * Import DDS alongside JSON/SKEL + .atlas as a native input. Convert only the
 * browser rendering copy to PNG; return the original immutable DDS separately
 * for source-preserving publishing and checksum validation.
 */
export async function normalizeSpineTextureFiles(files:File[]): Promise<{
  files:File[];
  originalDdsFiles:File[];
  convertedPages:number;
}> {
  const byName=new Map<string,File>();
  for(const file of files){
    const name=fileName(file).toLowerCase();
    if(byName.has(name) && byName.get(name)!==file)
      throw new Error("Ambiguous duplicate Spine filename: "+fileName(file));
    byName.set(name,file);
  }
  const dds=files.filter(f=>DDS_EXT.test(f.name));
  const converted=await Promise.all(dds.map(fileAsPng));
  const existingPng=new Set(files.filter(f=>PNG_EXT.test(f.name)).map(f=>fileName(f).toLowerCase()));
  const originals:File[]=[];
  const output:File[]=files.filter(f=>!DDS_EXT.test(f.name));
  for(const result of converted){
    if(!existingPng.has(result.file.name.toLowerCase())){
      output.push(result.file);
      existingPng.add(result.file.name.toLowerCase());
    }
    if(result.original)originals.push(result.original);
  }
  let convertedPages=0;
  for(let i=0;i<output.length;i++){
    const file=output[i];
    if(!/\.atlas(?:\.txt)?$/i.test(file.name))continue;
    const source=await file.text();
    const changed=rewriteAtlasDdsPages(source);
    for(const ref of changed.refs){
      if(!existingPng.has(pngName(fileName({name:ref} as File)).toLowerCase()))
        throw new Error("Atlas page "+ref+" has no matching .dds or .png texture");
    }
    if(!changed.refs.length)continue;
    convertedPages+=changed.refs.length;
    output[i]=new File([changed.text],file.name,{type:"text/plain",lastModified:file.lastModified});
  }
  return {files:output,originalDdsFiles:originals,convertedPages};
}
