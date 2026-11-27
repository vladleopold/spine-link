import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../api/github-preview.js', import.meta.url), 'utf8');

test('public preview embeds the tested automatic animation resolver', () => {
  assert.match(source, /import \{ choosePreviewAnimation \} from '\.\.\/scripts\/preview-animation-choice\.mjs';/);
  assert.match(source, /const choosePreviewAnimation = \$\{choosePreviewAnimation\.toString\(\)\};/);
});

test('the __SPINE_AUTO__ URL sentinel is resolved before Spine Player receives an animation name', () => {
  assert.match(source, /if \(queryAnimation === "__SPINE_AUTO__"\)\s*\{\s*return choosePreviewAnimation\(set\?\.animations \|\| \[\], queryAnimation, set\?\.animation \|\| ""\);/);
  assert.match(source, /const requestedAnimation = activeAnimation\.name;/);
});
