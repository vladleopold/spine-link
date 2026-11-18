import { inflateSync } from "node:zlib";

const SIGNATURE=[137,80,78,71,13,10,26,10];
const MAX_PIXELS=18*1024*1024;
const MAX_COMPRESSED=48*1024*1024;
function check(buffer){
  if(buffer.length<33||SIGNATURE.some((v,i)=>buffer[i]!==v))
    throw Error("Invalid PNG signature");
  const width=buffer.readUInt32BE(16),height=buffer.readUInt32BE(20);
  if(!width||!height||width*height>MAX_PIXELS||width>16384||height>16384)
    throw Error("PNG dimensions exceed atlas inference limits");
  return {width,height};
}
export function pngDimensions(data){
  const b=Buffer.from(data.buffer||data,data.byteOffset||0,data.byteLength||data.length);
  return check(b);
}
const paeth=(a,b,c)=>{
  const p=a+b-c,da=Math.abs(p-a),db=Math.abs(p-b),dc=Math.abs(p-c);
  return da<=db&&da<=dc?a:db<=dc?b:c;
};
export function pngAlpha(data){
  const b=Buffer.from(data.buffer||data,data.byteOffset||0,data.byteLength||data.length);
  const {width,height}=check(b);
  const bitDepth=b[24],color=b[25],interlace=b[28];
  const channels={0:1,2:3,3:1,4:2,6:4}[color];
  if(bitDepth!==8||!channels||interlace!==0||b[26]!==0||b[27]!==0)
    throw Error("PNG alpha inference requires non-interlaced 8-bit PNG");
  const parts=[];let palette=null,transparency=null,length=0;
  for(let offset=8;offset+12<=b.length;){
    const size=b.readUInt32BE(offset),type=b.toString("ascii",offset+4,offset+8);
    if(size>MAX_COMPRESSED||offset+12+size>b.length)
      throw Error("Corrupt PNG chunk length");
    const chunk=b.subarray(offset+8,offset+8+size);
    if(type==="IDAT"){length+=size;if(length>MAX_COMPRESSED)throw Error("PNG IDAT too large");parts.push(chunk);}
    if(type==="PLTE")palette=chunk;
    if(type==="tRNS")transparency=chunk;
    offset+=size+12;
    if(type==="IEND")break;
  }
  if(!parts.length)throw Error("PNG missing compressed pixel data");
  const rowSize=width*channels,byteCount=(rowSize+1)*height;
  const uncompressed=inflateSync(Buffer.concat(parts),{maxOutputLength:byteCount+1});
  if(uncompressed.length!==byteCount)throw Error("PNG scanline size mismatch");
  const alpha=new Uint8Array(width*height),last=new Uint8Array(rowSize);
  let pos=0,prev=last;
  for(let y=0;y<height;y++){
    const mode=uncompressed[pos++],row=new Uint8Array(rowSize);
    if(mode>4)throw Error("Unsupported PNG filter");
    for(let x=0;x<rowSize;x++){
      const left=x>=channels?row[x-channels]:0,up=prev[x];
      const corner=x>=channels?prev[x-channels]:0;
      const delta=mode===0?0:mode===1?left:mode===2?up:
        mode===3?Math.floor((left+up)/2):paeth(left,up,corner);
      row[x]=(uncompressed[pos++]+delta)&255;
    }
    for(let x=0;x<width;x++){
      const at=x*channels;
      let a=color===6?row[at+3]:color===4?row[at+1]:255;
      if(color===3)a=transparency?.[row[at]]??255;
      if(color===0 && transparency && transparency.length>=2 &&
        row[at]===transparency[1])a=0;
      if(color===2 && transparency && transparency.length>=6 &&
        row[at]===transparency[1]&&row[at+1]===transparency[3]&&row[at+2]===transparency[5])a=0;
      alpha[y*width+x]=a;
    }
    prev=row;
  }
  return {width,height,alpha};
}
