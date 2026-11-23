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


test('restored pre-rotation archive works also resolve from /p links', async () => {
  const recoveryStart = source.indexOf('async function resolveEntryRecord(');
  const recoveryEnd = source.indexOf('// The asset directory', recoveryStart);
  const recoverySnippet = source.slice(recoveryStart, recoveryEnd).trim();
  const recoveredIds = [
    '1036_1-2026-07-24T21-06-04-535Z',
    '8000021-2026-07-02T04-52-57-380Z',
    '8000021-2026-07-02T04-43-24-403Z',
  ];
  const snapshot = recoveredIds.map((id) => ({
    id,
    previewPath: `library/${id}`,
    thumbnail: `https://spine-link.vercel.app/assets/library/${id}/preview.webp`,
    sourceProof: { github: { previewPath: `library/${id}` } },
    files: ['skeleton-folder'],
  }));
  const snapshotRef = 'f4e51c6c420d4ff1f4d2028c12492b04153cc862';
  const snapshotReads = [];
  const resolveRecovered = new Function(
    'cleanRepoPath',
    'libraryCollectionPaths',
    'githubText',
    `${recoverySnippet}; return resolveEntryRecord;`,
  )(
    (value) => String(value || '').split('/').filter(Boolean).join('/'),
    async () => ['library_02', 'library_01'],
    async (settings, path) => {
      if (settings.branch === snapshotRef && path === 'library/index.json') {
        snapshotReads.push(path);
        return JSON.stringify(snapshot);
      }
      return '[]';
    },
  );
  for (const id of recoveredIds) {
    const found = await resolveRecovered({ branch: 'main', basePath: 'library' }, id);
    assert.equal(found?.basePath, 'library_01');
    assert.equal(found?.previewPath, `library_01/${id}`);
    assert.ok(found.entry.thumbnail.includes(`/assets/library_01/${id}/`));
    assert.equal(found.entry.sourceProof.github.previewPath, `library_01/${id}`);
    assert.equal(found.entries.length, 3);
  }
  assert.equal(snapshotReads.length, recoveredIds.length);
  const unknown = await resolveRecovered({ branch: 'main', basePath: 'library' }, 'not-a-recovered-work');
  assert.equal(unknown, null);
  assert.equal(snapshotReads.length, recoveredIds.length);
});
