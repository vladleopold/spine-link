import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../src/SpineApp.tsx', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../api/github-upload.js', import.meta.url), 'utf8');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing source section: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing source section end: ${end}`);
  return source.slice(from, to);
}

test('new public source proofs contain only uploader category, not device or account fingerprints', () => {
  const type = section(app, 'type SourceProof =', 'type GitHubProofReceipt =');
  for (const field of ['googleEmailSha256', 'anonymousAccountId', 'anonymousFingerprint', 'browserFingerprintSha256', 'browserEnvironmentHashSha256', 'browserEnvironment']) {
    assert.doesNotMatch(type, new RegExp(`\\b${field}\\b`), `SourceProof must not expose ${field}`);
  }

  const create = section(app, 'async function createSourceProof(', 'function editEntryIdFromLocation()');
  for (const field of ['browserFingerprint', 'browserEnvironment', 'googleEmailSha256', 'anonymousAccountId', 'anonymousFingerprint']) {
    assert.doesNotMatch(create, new RegExp(`\\b${field}\\b`), `new proofs must not collect or serialize ${field}`);
  }
  assert.match(create, /version: 2 as const/);
  assert.match(create, /privacy:/);
});

test('new anonymous accounts use random identifiers instead of device fingerprints', () => {
  const create = section(app, 'function createAnonymousAccount()', 'function getStoredAnonymousAccount()');
  assert.match(create, /crypto\.randomUUID\(\)/);
  assert.doesNotMatch(create, /browserFingerprint/);
  assert.doesNotMatch(create, /navigator\./);
});

test('public library responses remove private account and ownership identifiers', () => {
  const publicEntry = section(api, 'export function publicLibraryEntry(', 'function publicLibraryEntries(');
  for (const field of ['ownerEmail', 'ownerEmailSha256', 'ownerAccountId', 'ownerAnonId', 'ownerAnonFingerprint', 'apiKeyId']) {
    assert.match(publicEntry, new RegExp(`delete next\\.${field}\\b`), `public API must omit ${field}`);
  }
});

test('public blockchain anchors do not persist device fingerprints or raw browser environment', () => {
  const anchor = section(api, 'async function createBlockchainAnchor(', 'function derivedMediaFromFiles(');
  for (const field of ['googleEmailSha256', 'anonymousAccountId', 'anonymousFingerprint', 'browserFingerprintSha256', 'browserEnvironmentHashSha256', 'browserEnvironment']) {
    assert.doesNotMatch(anchor, new RegExp(`\\b${field}\\b`), `blockchain anchor must not expose ${field}`);
  }
  assert.match(anchor, /privacy:/);
});
