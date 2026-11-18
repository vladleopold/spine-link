/* Preview-only Spine atlas inference from JSON attachments + PNG images.
 * No original packed UV/rotation claim: confidence is reported separately. */
const MAX_PARTS=1024,MAX_PIXELS=18*1024*1024;
const safeName = x => String(x||"").replace(/\\/g,"/").replace(/[\x00-\x1f]/g,"").trim().slice(0,500);
const stem=x=>(safeName(x).split("/").filter(Boolean).pop()||"").replace(/\.(png|jpe?g|webp|dds)$/i,"").toLowerCase();
const positive=x=>Number.isFinite(Number(x)) && Number(x)>0?Number(x):0;

export function attachmentRegions(doc) {
  if(!doc||typeof doc!=="object")return [];
  const skins=Array.isArray(doc.skins)?doc.skins.map(x=>x?.attachments):Object.values(doc.skins||{});
  const result=new Map();
  for(const skin of skins){
    if(!skin||typeof skin!=="object")continue;
    for(const attachments of Object.values(skin)){
      if(!attachments||typeof attachments!=="object")continue;
      for(const [key,part] of Object.entries(attachments)){
        if(!part||typeof part!=="object")continue;
        const type=String(part.type||"region").toLowerCase();
        if(!["region","mesh","linkedmesh"].includes(type))continue;
        const name=safeName(part.path||part.name||key);
        if(!name)continue;
        if(!result.has(name))result.set(name,{name,type,width:positive(part.width),height:positive(part.height)});
        if(result.size>MAX_PARTS)throw Error("Too many Spine texture regions");
      }
    }
  }
  return [...result.values()];
}

function components(image){
  const {alpha,width:w,height:h}=image;
  if(!alpha||alpha.length!==w*h)return [];
  if(w*h>MAX_PIXELS)throw Error("Texture exceeds safe inference dimensions");
  const seen=new Uint8Array(w*h),stack=new Int32Array(w*h),result=[];
  for(let start=0;start<alpha.length;start++){
    if(seen[start]||alpha[start]<8)continue;
    let front=0,tail=1,count=0,minX=w,minY=h,maxX=-1,maxY=-1;
    seen[start]=1;stack[0]=start;
    while(front<tail){
      const p=stack[front++],x=p%w,y=(p/w)|0;
      count++;minX=Math.min(minX,x);minY=Math.min(minY,y);
      maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);
      // Process each neighbour without allocating one array per pixel.
      if(x>0&&!seen[p-1]&&alpha[p-1]>=8){seen[p-1]=1;stack[tail++]=p-1;}
      if(x+1<w&&!seen[p+1]&&alpha[p+1]>=8){seen[p+1]=1;stack[tail++]=p+1;}
      if(y>0&&!seen[p-w]&&alpha[p-w]>=8){seen[p-w]=1;stack[tail++]=p-w;}
      if(y+1<h&&!seen[p+w]&&alpha[p+w]>=8){seen[p+w]=1;stack[tail++]=p+w;}
    }
    if(count>=8&&maxX>minX&&maxY>minY)
      result.push({x:minX,y:minY,width:maxX-minX+1,height:maxY-minY+1,pixels:count});
    if(result.length>MAX_PARTS*4)break;
  }
  return result.sort((a,b)=>b.pixels-a.pixels);
}
function score(region,box){
  if(!region.width||!region.height)return 0;
  const aspect=Math.abs(Math.log((region.width/region.height)/(box.width/box.height)));
  const area=Math.abs(Math.log(Math.max(1,region.width*region.height)/(box.width*box.height)));
  return aspect+0.12*area;
}
function fitParts(regions,image){
  const parts=components(image);
  if(parts.length!==regions.length||!parts.length)return null;
  const scores=[];
  for(let i=0;i<regions.length;i++)for(let j=0;j<parts.length;j++)
    scores.push({i,j,score:score(regions[i],parts[j])});
  scores.sort((a,b)=>a.score-b.score||a.i-b.i||a.j-b.j);
  const usedI=new Set(),usedJ=new Set(),out=new Array(regions.length);
  for(const p of scores){
    if(usedI.has(p.i)||usedJ.has(p.j))continue;
    out[p.i]=parts[p.j];usedI.add(p.i);usedJ.add(p.j);
  }
  return out.every(Boolean)?out:null;
}
function whole(image){return{x:0,y:0,width:image.width,height:image.height};}
function writePage(image,regions){
  const lines=[safeName(image.name),"size: "+image.width+","+image.height,
    "format: RGBA8888","filter: Linear,Linear","repeat: none","pma: false",""];
  for(const r of regions){
    const b=r.rect,ow=Math.max(b.width,Math.round(r.width||b.width));
    const oh=Math.max(b.height,Math.round(r.height||b.height));
    lines.push(safeName(r.name),"  rotate: false",
      "  xy: "+b.x+", "+b.y,"  size: "+b.width+", "+b.height,
      "  orig: "+ow+", "+oh,"  offset: 0, 0","  index: -1","");
  }
  return lines.join("\n");
}

/** Confidence: matched / inferred (alpha islands) / low (ambiguous). */
export function reconstructAtlas(doc,images){
  const regions=attachmentRegions(doc);
  if(!regions.length)throw Error("Spine JSON contains no region or mesh attachments");
  if(!Array.isArray(images)||!images.length)throw Error("PNG textures missing");
  if(images.some(i=>!i||!safeName(i.name)||!Number.isInteger(i.width)||!Number.isInteger(i.height)||
    i.width<1||i.height<1||i.width*i.height>MAX_PIXELS))
    throw Error("Invalid PNG dimensions");
  const positions=new Map();let matched=0,alphaAssigned=0,unverified=0;
  for(const region of regions){
    const hits=images.filter(im=>stem(im.name)===stem(region.name));
    if(hits.length===1){
      positions.set(region.name,{image:hits[0],rect:whole(hits[0])});matched++;
    }
  }
  const missing=regions.filter(r=>!positions.has(r.name));
  if(missing.length&&images.length===1){
    const fitted=fitParts(missing,images[0]);
    if(fitted)missing.forEach((region,i)=>{
      positions.set(region.name,{image:images[0],rect:fitted[i]});alphaAssigned++;
    });
  }
  for(const region of regions){
    if(positions.has(region.name))continue;
    positions.set(region.name,{image:images[0],rect:whole(images[0])});
    unverified++;
  }
  const pages=[];
  for(const image of images){
    const matching=regions.filter(r=>positions.get(r.name).image===image)
      .map(r=>({...r,rect:positions.get(r.name).rect}));
    if(matching.length)pages.push(writePage(image,matching));
  }
  return {
    atlas:pages.join("\n\n").trimEnd()+"\n",
    confidence:unverified?"low":alphaAssigned?"inferred":"matched",
    regionCount:regions.length,matched,alphaAssigned,unverified,
    pages:images.filter(im=>regions.some(r=>positions.get(r.name).image===im)).map(im=>im.name),
    details:unverified?"Ambiguous packed regions; preview only, artistic proof required":
      alphaAssigned?"Alpha islands matched; trim and rotation need visual approval":
      "Texture page names match JSON attachment paths",
  };
}
