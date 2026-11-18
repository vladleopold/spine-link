import { deflateSync } from "node:zlib";
import { decodeDds } from "./dds-texture.js";

const PNG_SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);
const crcTable=new Uint32Array(256);
for(let n=0;n<256;n++){
  let c=n;
  for(let k=0;k<8;k++)c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);
  crcTable[n]=c>>>0;
}
function crc32(buffer){
  let c=0xffffffff;
  for(const b of buffer)c=crcTable[(c^b)&255]^(c>>>8);
  return (c^0xffffffff)>>>0;
}
function chunk(type,body){
  const kind=Buffer.from(type,"ascii"),len=Buffer.alloc(4),crc=Buffer.alloc(4);
  len.writeUInt32BE(body.length,0);
  crc.writeUInt32BE(crc32(Buffer.concat([kind,body])),0);
  return Buffer.concat([len,kind,body,crc]);
}
export function encodeRgbaPng({width,height,rgba}){
  if(!Number.isInteger(width)||!Number.isInteger(height)||!width||!height||
     !rgba||rgba.length!==width*height*4)
    throw new Error("Invalid RGBA dimensions");
  const header=Buffer.alloc(13);
  header.writeUInt32BE(width,0);
  header.writeUInt32BE(height,4);
  header[8]=8;header[9]=6;header[10]=0;header[11]=0;header[12]=0;
  const stride=width*4,scanlines=Buffer.alloc((stride+1)*height);
  for(let y=0;y<height;y++){
    const src=y*stride,dst=y*(stride+1);
    scanlines[dst]=0; // Lossless PNG filter: none
    scanlines.set(rgba.subarray(src,src+stride),dst+1);
  }
  return Buffer.concat([PNG_SIGNATURE,chunk("IHDR",header),
    chunk("IDAT",deflateSync(scanlines,{level:6})),chunk("IEND",Buffer.alloc(0))]);
}
export function ddsToPng(buffer){
  return encodeRgbaPng(decodeDds(buffer));
}
