import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

test('only the reviewed, lockfile-pinned esbuild install script is approved', () => {
  const version = lock.packages['node_modules/esbuild']?.version;
  assert.equal(version, '0.28.1');
  assert.equal(pkg.allowScripts?.[`esbuild@${version}`], true);
  assert.equal(Object.keys(pkg.allowScripts || {}).length, 1);
});

test('Vercel installs the exact dependency tree from package-lock.json', () => {
  assert.equal(vercel.installCommand, 'npm ci');
});
