import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../api/github-preview.js',import.meta.url),'utf8');
const snippet=source.slice(source.indexOf('async function resolveEntryRecord('),source.indexOf('export default async function handler('));
const entry={id:'legacy-work',previewPath:'legacy-work',allAnimationPreviews:{idle:{mp4Preview:'https://example.test/idle.mp4'}}};
const resolve=new Function('cleanRepoPath','libraryCollectionPaths','githubText',snippet+';return resolveEntryRecord;')(v=>String(v||'').replace(/^\/+|\/+$/g,''),async()=>['library','library_02'],async(_settings,path)=>JSON.stringify(path==='library_02/index.json'?[entry]:[]));
test('root-level assets retain collection metadata and Download exports',async()=>{
 const found=await resolve({},'legacy-work');assert.equal(found.basePath,'library_02');assert.equal(found.previewPath,'legacy-work');assert.equal(found.entry.allAnimationPreviews.idle.mp4Preview,'https://example.test/idle.mp4');
});
