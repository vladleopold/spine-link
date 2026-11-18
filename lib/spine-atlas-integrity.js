/** Conservative text-atlas integrity gate. Never decode a random binary blob as
 * a Spine page filename: this caused bogus control-character URLs on 019.atlas.
 * This check is intentionally not a replacement for native rendering.
 */
export function isValidSpineAtlasHeader(text) {
  const source=String(text||'').replace(/^\uFEFF/,'');
  if(!source||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(source))return false;
  const lines=source.replace(/\r\n?/g,'\n').split('\n').map(x=>x.trim());
  return lines.some((line,i)=>{
    if(!/\.(png|jpg|jpeg|webp|dds)$/i.test(line)||line.includes('/')&&line.startsWith('http'))return false;
    const following=lines.slice(i+1,i+8).join('\n');
    return /(?:size|format|filter|repeat|pma)\s*:/i.test(following);
  });
}
