import test from 'node:test';
import assert from 'node:assert/strict';
import { isAmbiguous404ConsoleMessage } from '../scripts/lib/preview-console-errors.mjs';

test('recognizes browser console 404 messages whose URL is omitted', () => {
  assert.equal(
    isAmbiguous404ConsoleMessage('Failed to load resource: the server responded with a status of 404 ()'),
    true,
  );
});

test('does not suppress non-404 browser console errors', () => {
  assert.equal(
    isAmbiguous404ConsoleMessage('Failed to load resource: the server responded with a status of 500 ()'),
    false,
  );
  assert.equal(isAmbiguous404ConsoleMessage('Uncaught TypeError: player is undefined'), false);
  assert.equal(isAmbiguous404ConsoleMessage(''), false);
});
