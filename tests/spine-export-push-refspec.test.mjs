import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflows = [
  '.github/workflows/spine-export-full.yml',
  '.github/workflows/spine-export-all.yml',
  '.github/workflows/spine-export-webm.yml',
].map((path) => ({
  path,
  source: readFileSync(new URL('../' + path, import.meta.url), 'utf8'),
}));

test('all export workflows push the detached commit explicitly to main', () => {
  for (const { path, source } of workflows) {
    assert.match(source, /git push origin HEAD:main/, path + ' must push HEAD to main');
    assert.doesNotMatch(source, /git push origin main/, path + ' must not rely on a local main branch');
  }
});
