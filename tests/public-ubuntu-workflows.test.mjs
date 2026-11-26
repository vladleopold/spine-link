import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('all GitHub Actions workflows use public Ubuntu 24.04 runners and current core actions', () => {
  const workflowDir = path.resolve('.github', 'workflows');
  const files = fs.readdirSync(workflowDir).filter((name) => /\.ya?ml$/i.test(name));
  assert.ok(files.length > 0, 'expected GitHub Actions workflow files');
  const sources = files.map((name) => ({
    name,
    source: fs.readFileSync(path.join(workflowDir, name), 'utf8'),
  }));
  const runners = sources.flatMap(({ name, source }) => [...source.matchAll(/^\s*runs-on:\s*(.+)$/gm)]
    .map((match) => ({ workflow: name, runner: match[1].trim() })));
  assert.ok(runners.length > 0, 'expected workflow jobs');
  assert.deepEqual(runners.filter(({ runner }) => runner !== 'ubuntu-24.04'), [],
    'all workflow jobs must use GitHub-hosted ubuntu-24.04');
  assert.deepEqual(sources.filter(({ source }) => /runs-on:\s*[^\n]*self-hosted/i.test(source)), [],
    'private/self-hosted runners are prohibited');
  assert.deepEqual(sources.flatMap(({ name, source }) => [...source.matchAll(/uses:\s*actions\/(?:checkout|setup-node)@v([1-6])\b/g)]
    .map((match) => ({ workflow: name, version: match[1] }))), [],
    'checkout and setup-node must use current v7 releases');
});
