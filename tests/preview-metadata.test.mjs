import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { indexedFilePath, previewIndexPath } from '../lib/github-preview-index.js';
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
    'previewIndexPath',
    'joinRepoPath',
    'githubList',
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
    previewIndexPath,
    (...parts) => parts.filter(Boolean).join('/'),
    async () => [],
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

test('legacy indexed skeleton/atlas/texture fields bypass a throttled directory listing', async () => {
  const start = source.indexOf('async function findSpineSetDirectories(');
  const end = source.indexOf('// Download buttons for the work page sidebar', start);
  assert.ok(start >= 0 && end > start, 'findSpineSetDirectories source must exist');
  const helper = source.slice(start, end).trim();
  let directoryReads = 0;
  const findDirectories = new Function(
    'cleanRepoPath', 'isSkeleton', 'isAtlas', 'isImage', 'joinRepoPath', 'githubList', 'indexedFilePath',
    helper + '; return findSpineSetDirectories;',
  )(
    value => String(value || '').replace(/^\/+|\/+$/g, ''),
    name => /\.(?:json|skel|bytes)$/i.test(String(name || '')),
    name => /\.atlas$/i.test(String(name || '')),
    name => /\.(?:png|webp|jpe?g|dds)$/i.test(String(name || '')),
    (...parts) => parts.filter(Boolean).join('/'),
    async () => { directoryReads += 1; throw new Error('GitHub Contents API temporarily unavailable'); },
    indexedFilePath,
  );
  const result = await findDirectories({}, 'library_02/legacy-work', 3, {
    uploadedAt: '2026-10-24T21:46:51.258Z',
    skeleton: '276-Spine(2014).json',
    atlas: '276-Spine(2014).atlas',
    textures: ['276-Spine(2014).png', 'preview.webp'],
  });
  assert.equal(directoryReads, 0, 'indexed legacy files must not depend on a live directory listing');
  assert.equal(result.length, 1);
  assert.ok(result[0].items.some(item => item.name === '276-Spine(2014).json'));
  assert.ok(result[0].items.some(item => item.name === '276-Spine(2014).atlas'));
  assert.ok(result[0].items.some(item => item.name === '276-Spine(2014).png'));
});
