import { attachmentRegions,reconstructAtlas } from "./atlas-inference.js";
import { pngDimensions,pngAlpha } from "./png-alpha-node.js";

/**
 * Server adapter, invoked only for a real JSON skeleton missing its .atlas.
 * The output is an in-memory preview atlas and never alters private PNG/JSON.
 * Each image carries {name, bytes}; alpha is extracted only for a single
 * likely packed sprite sheet with multiple attachments.
 */
export function reconstructAtlasFromPngBytes(skeleton,images) {
  const doc=typeof skeleton==="string"?JSON.parse(skeleton):skeleton;
  const regions=attachmentRegions(doc);
  if(!regions.length)throw Error("No JSON attachment paths to reconstruct");
  const needAlpha=images.length===1&&regions.length>1;
  const mapped=images.map(im=>{
    const bytes=im.bytes;
    let meta;
    if(needAlpha){
      try{meta=pngAlpha(bytes);}
      catch{meta=pngDimensions(bytes);} // explicitly low-confidence fallback
    }else meta=pngDimensions(bytes);
    return {name:im.name,...meta};
  });
  return reconstructAtlas(doc,mapped);
}
