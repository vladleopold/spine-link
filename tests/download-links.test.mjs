import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../src/SpineApp.tsx',import.meta.url),'utf8');
const snippet=source.slice(source.indexOf('function buildAnimationDownloadUrl('),source.indexOf('\nfunction derivedLibraryAssetUrl('));
const build=new Function(ts.transpile(snippet,{target:ts.ScriptTarget.ES2022})+';return buildAnimationDownloadUrl;')();
for(const [format,key] of [['webm','webmPreview'],['mp4','mp4Preview'],['mov','movAlpha'],['gif','gifAlpha'],['png','pngAlpha']]){
 test(`${format}: all three sizes select their actual files`,()=>{
  const entry={allAnimationPreviews:{idle:{[key]:'high',[key+'Medium']:'medium',[key+'Low']:'low'}}};
  for(const q of ['high','medium','low'])assert.equal(build(entry,'idle',format,q),q);
 });
}
