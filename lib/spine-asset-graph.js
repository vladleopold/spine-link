/** Deterministic acceptance of a complete Spine runtime file graph.
 * A lone JSON and thumbnail PNG is not a playable animation.
 * No image bytes or private filenames are logged by this validator.
 */
const leaf = value => String(value || '').replace(/\\/g,'/').split('/').pop().toLowerCase();
const isSkeleton = n => /\.(json|skel)$/i.test(n);
const isAtlas = n => /\.atlas(?:\.(?:txt|docx))?$/i.test(n);
const isTexture = n => /\.(png|jpe?g|webp|dds)$/i.test(n);
export function validateSpineRuntimeFiles(files = []) {
  const names=Array.isArray(files) ? files.map(leaf).filter(Boolean) : [];
  const skels=names.filter(isSkeleton);
  const atlases=names.filter(isAtlas);
  const textures=names.filter(isTexture);
  const missing=[];
  if (!skels.length) missing.push('JSON/SKEL skeleton');
  if (!atlases.length) missing.push('.atlas');
  if (!textures.length) missing.push('texture page PNG/JPG/WEBP/DDS');
  if (missing.length) return {ok:false,code:'INCOMPLETE_SPINE_ASSETS',missing};
  // An arbitrary atlas from another upload is not an acceptable substitute.
  // Multiple atlas/skeleton combinations must share at least one stem.
  const basename=n=>n.replace(/\.atlas(?:\.(?:txt|docx))?$/i,'').replace(/\.(?:json|skel)$/i,'');
  if (atlases.length>1 || skels.length>1) {
    const skeletonStems=new Set(skels.map(basename));
    if (!atlases.some(a=>skeletonStems.has(basename(a))))
      return {ok:false,code:'MISMATCHED_SPINE_ASSETS',missing:['atlas matching skeleton']};
  }
  return {ok:true,code:'COMPLETE_SPINE_ASSET_TRIAD',missing:[]};
}
