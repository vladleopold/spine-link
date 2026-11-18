/**
 * Strict DDS BC1/BC2/BC3 texture decoder for browser previews and server-side
 * original-file acceptance. Does not write back to any source artwork.
 * Supports DXT1/DXT3/DXT5 (including non-4-pixel dimensions and alpha).
 * DX10, BC4+, uncompressed DDS, cubemaps and volume textures fail closed.
 */
const MAX_PIXELS = 24 * 1024 * 1024;
const HEADER_BYTES = 128;

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new Error("DDS data must be binary");
}
function color565(value) {
  const r = (value >>> 11) & 31, g = (value >>> 5) & 63, b = value & 31;
  return [Math.round(r * 255 / 31), Math.round(g * 255 / 63), Math.round(b * 255 / 31)];
}
function palette(c0, c1, allowTransparency) {
  const a = color565(c0), b = color565(c1);
  const mix = (x, y, n, den) => Math.round((x * (den - n) + y * n) / den);
  if (allowTransparency && c0 <= c1) {
    return [[...a, 255], [...b, 255],
      [mix(a[0],b[0],1,2),mix(a[1],b[1],1,2),mix(a[2],b[2],1,2),255],
      [0,0,0,0]];
  }
  return [[...a,255],[...b,255],
    [mix(a[0],b[0],1,3),mix(a[1],b[1],1,3),mix(a[2],b[2],1,3),255],
    [mix(a[0],b[0],2,3),mix(a[1],b[1],2,3),mix(a[2],b[2],2,3),255]];
}
export function parseDdsHeader(input) {
  const bytes=asBytes(input);
  if(bytes.length<HEADER_BYTES || String.fromCharCode(...bytes.slice(0,4))!=="DDS ")
    throw new Error("Invalid DDS header (expected DDS magic and 128-byte header)");
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(view.getUint32(4,true)!==124 || view.getUint32(76,true)!==32)
    throw new Error("Invalid DDS header sizes");
  const width=view.getUint32(16,true),height=view.getUint32(12,true);
  if(!width || !height || width>16384 || height>16384 || width*height>MAX_PIXELS)
    throw new Error("DDS dimensions exceed safe preview limits");
  const caps2=view.getUint32(112,true);
  if(caps2 & (0x200 | 0xfc00 | 0x200000))
    throw new Error("DDS cubemap and volume textures are not supported");
  const fourCC=String.fromCharCode(...bytes.slice(84,88));
  const formats={DXT1:8,DXT3:16,DXT5:16};
  const blockSize=formats[fourCC];
  if(!blockSize)
    throw new Error("Unsupported DDS compression "+(fourCC==="DX10"?"DX10 (BCn)":fourCC)+"; expected DXT1, DXT3 or DXT5");
  const blocksWide=Math.ceil(width/4),blocksHigh=Math.ceil(height/4);
  const requiredBytes=HEADER_BYTES+blocksWide*blocksHigh*blockSize;
  if(bytes.length<requiredBytes) throw new Error("DDS texture data truncated");
  return {width,height,fourCC,blockSize,blocksWide,blocksHigh,requiredBytes};
}
export function decodeDds(input) {
  const bytes=asBytes(input),hdr=parseDdsHeader(bytes);
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const pixels=new Uint8ClampedArray(hdr.width*hdr.height*4);
  let block=HEADER_BYTES;
  for(let by=0;by<hdr.blocksHigh;by++)for(let bx=0;bx<hdr.blocksWide;bx++){
    const offset=hdr.fourCC==="DXT1"?0:8;
    const c0=v.getUint16(block+offset,true),c1=v.getUint16(block+offset+2,true);
    const colors=palette(c0,c1,hdr.fourCC==="DXT1");
    const bits=v.getUint32(block+offset+4,true);
    const alpha=new Uint8Array(16);
    alpha.fill(255);
    if(hdr.fourCC==="DXT3"){
      for(let i=0;i<16;i++){
        const byte=bytes[block+(i>>1)];
        alpha[i]=((i&1)?byte>>4:byte&15)*17;
      }
    } else if(hdr.fourCC==="DXT5"){
      const a0=bytes[block],a1=bytes[block+1];
      const table=[a0,a1];
      if(a0>a1){
        for(let i=1;i<=6;i++)table.push(Math.round(((7-i)*a0+i*a1)/7));
      }else{
        for(let i=1;i<=4;i++)table.push(Math.round(((5-i)*a0+i*a1)/5));
        table.push(0,255);
      }
      for(let i=0;i<16;i++){
        let index=0;
        for(let bit=0;bit<3;bit++){
          const absolute=i*3+bit;
          index|=((bytes[block+2+(absolute>>3)]>>(absolute&7))&1)<<bit;
        }
        alpha[i]=table[index];
      }
    }
    for(let py=0;py<4;py++)for(let px=0;px<4;px++){
      const x=bx*4+px,y=by*4+py;
      if(x>=hdr.width || y>=hdr.height)continue;
      const i=py*4+px,ci=(bits>>>(2*i))&3,rgba=colors[ci];
      const o=(y*hdr.width+x)*4;
      pixels[o]=rgba[0];pixels[o+1]=rgba[1];pixels[o+2]=rgba[2];
      pixels[o+3]=hdr.fourCC==="DXT1"?rgba[3]:alpha[i];
    }
    block+=hdr.blockSize;
  }
  return {width:hdr.width,height:hdr.height,format:hdr.fourCC,rgba:pixels};
}
