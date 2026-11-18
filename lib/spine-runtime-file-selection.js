/** Pick a genuine Spine runtime skeleton; never confuse config.json with art.
 * Exact matching atlas basename wins. Other JSON metadata is not a skeleton.
 * Files can be browser File objects or GitHub content-list descriptors.
 */
export function selectSpineRuntimeSkeleton(files, atlasName = '') {
  const items=(Array.isArray(files)?files:[]).filter(file => file &&
    typeof file.name === 'string' && /\.(?:skel|bytes|json)$/i.test(file.name));
  const atlas=String(atlasName||'').replace(/\.atlas(?:\.txt|\.docx)?$/i,'').toLowerCase();
  if(atlas){
    const exact=items.find(file=>file.name.replace(/\.(?:skel|bytes|json)$/i,'').toLowerCase()===atlas);
    if(exact)return exact;
  }
  const binary=items.find(file=>/\.(?:skel|bytes)$/i.test(file.name));
  if(binary)return binary;
  const json=items.filter(file=>/\.json$/i.test(file.name) &&
    !/(?:^|\/)(?:config|metadata|manifest|settings|package|player-config)\.json$/i.test(file.name));
  return json.length===1?json[0]:json.find(file=>/spine|skeleton/i.test(file.name))||json[0]||null;
}
