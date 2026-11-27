/** Pick a genuine Spine runtime skeleton; never confuse config.json with art.
 * Exact matching atlas basename wins. Other JSON metadata is not a skeleton.
 * Files can be browser File objects or GitHub content-list descriptors.
 */
export function runtimeVersionOverrideForSpineSkeleton(skeletonVersion, isBinary) {
  // The official 3.7 TypeScript/Web Player runtime cannot read binary SKEL.
  // Convert 3.7 binary skeleton + atlas assets to the current 4.3 format.
  if (isBinary && /^3\\.7(?:\\.|$)/.test(String(skeletonVersion || ''))) return '4.3';
  // Spine 3.8 changed the binary format. Keep 3.8 on its matching runtime.
  return '';
}

export function selectSpineRuntimeSkeleton(files, atlasName = '') {
  const items=(Array.isArray(files)?files:[]).filter(file => file &&
    typeof file.name === 'string' && /\.(?:skel|bytes|json)$/i.test(file.name));
  const atlas=String(atlasName||'').replace(/\.atlas(?:\.txt|\.docx)?$/i,'').toLowerCase();
  if(atlas){
    // The deployed legacy Spine 3.7 web player consumes JSON skeletons.
    // If an upload contains both formats with the atlas basename, prefer JSON
    // instead of selecting the binary .skel and leaving the preview blank.
    const exactJson=items.find(file=>/\.json$/i.test(file.name) &&
      file.name.replace(/\.json$/i,'').toLowerCase()===atlas);
    if(exactJson)return exactJson;
    const exact=items.find(file=>file.name.replace(/\.(?:skel|bytes|json)$/i,'').toLowerCase()===atlas);
    if(exact)return exact;
  }
  const binary=items.find(file=>/\.(?:skel|bytes)$/i.test(file.name));
  if(binary)return binary;
  const json=items.filter(file=>/\.json$/i.test(file.name) &&
    !/(?:^|\/)(?:config|metadata|manifest|settings|package|player-config)\.json$/i.test(file.name));
  return json.length===1?json[0]:json.find(file=>/spine|skeleton/i.test(file.name))||json[0]||null;
}
