import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
  createRecoverySecret,
  normalizeRecoverySecret,
  hashRecoverySecret,
  addRecoveryHashToOwnedEntries,
  recoverEntriesByRecoveryHash,
  revokeRecoveryHashFromOwnedEntries,
  stripPrivateOwnerMetadata,
} from '../lib/anonymous-recovery.js';

test('recovery keys are 256-bit base64url secrets with no padding', () => {
  const secret = createRecoverySecret();
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(secret, 'base64url').length, 32);
  assert.equal(normalizeRecoverySecret(secret), secret);
});

test('recovery key validation rejects malformed and low-entropy values', () => {
  for (const value of ['', 'password', 'abc', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(43) + '=']) {
    assert.equal(normalizeRecoverySecret(value), null);
  }
});

test('only a SHA-256 digest is stored for the recovery key', () => {
  const secret = createRecoverySecret();
  assert.equal(hashRecoverySecret(secret), createHash('sha256').update(secret).digest('hex'));
  assert.equal(hashRecoverySecret('not-a-recovery-key'), null);
});

test('recovery hash attaches only to entries owned by the current anonymous account', () => {
  const entries = [
    {id:'a',ownerAnonId:'anon_owner',ownerAnonFingerprint:'legacy'},
    {id:'b',ownerAnonId:'anon_other'},
    {id:'c',ownerAnonId:'anon_owner',ownerAccountId:'google-owner'},
  ];
  const hash = 'a'.repeat(64);
  const result = addRecoveryHashToOwnedEntries(entries, 'anon_owner', hash, '2026-11-26T00:00:00.000Z');
  assert.equal(result.changed, 1);
  assert.equal(result.entries[0].ownerRecoveryHash, hash);
  assert.equal(result.entries[0].ownerRecoveryCreatedAt, '2026-11-26T00:00:00.000Z');
  assert.equal(result.entries[0].recoverySecret, undefined);
  assert.equal(result.entries[1].ownerRecoveryHash, undefined);
  assert.equal(result.entries[2].ownerRecoveryHash, undefined);
});

test('a valid recovery hash transfers every matching entry to the new random anonymous ID', () => {
  const hash = 'b'.repeat(64);
  const entries = [
    {id:'a',ownerAnonId:'anon_old',ownerRecoveryHash:hash,ownerAnonFingerprint:'legacy'},
    {id:'b',ownerAnonId:'anon_old',ownerRecoveryHash:hash},
    {id:'c',ownerAnonId:'anon_other',ownerRecoveryHash:'c'.repeat(64)},
  ];
  const result = recoverEntriesByRecoveryHash(entries, hash, 'anon_new');
  assert.equal(result.changed, 2);
  assert.equal(result.entries[0].ownerAnonId, 'anon_new');
  assert.equal(result.entries[0].ownerAnonFingerprint, undefined);
  assert.equal(result.entries[0].ownerRecoveryHash, hash);
  assert.equal(result.entries[1].ownerAnonId, 'anon_new');
  assert.equal(result.entries[2].ownerAnonId, 'anon_other');
});

test('revocation removes recovery hashes only from the current anonymous account', () => {
  const entries = [
    {id:'a',ownerAnonId:'anon_owner',ownerRecoveryHash:'a'.repeat(64),ownerRecoveryCreatedAt:'now',ownerAnonFingerprint:'legacy'},
    {id:'b',ownerAnonId:'anon_other',ownerRecoveryHash:'b'.repeat(64)},
  ];
  const result = revokeRecoveryHashFromOwnedEntries(entries, 'anon_owner');
  assert.equal(result.changed, 1);
  assert.equal(result.entries[0].ownerRecoveryHash, undefined);
  assert.equal(result.entries[0].ownerRecoveryCreatedAt, undefined);
  assert.equal(result.entries[0].ownerAnonFingerprint, undefined);
  assert.equal(result.entries[1].ownerRecoveryHash, 'b'.repeat(64));
});

test('public library projections omit anonymous IDs, recovery hashes and email metadata', () => {
  const entry = stripPrivateOwnerMetadata({
    id:'a',ownerAnonId:'anon_owner',ownerAnonFingerprint:'legacy',
    ownerRecoveryHash:'a'.repeat(64),ownerRecoveryCreatedAt:'now',
    ownerEmail:'private@example.invalid',ownerEmailSha256:'b'.repeat(64),
    ownerAccountId:'private-account',apiKeyId:'private-key',title:'Public work',
  });
  for (const field of ['ownerAnonId','ownerAnonFingerprint','ownerRecoveryHash','ownerRecoveryCreatedAt','ownerEmail','ownerEmailSha256','ownerAccountId','apiKeyId']) {
    assert.equal(entry[field], undefined, `public projection must omit ${field}`);
  }
  assert.equal(entry.title, 'Public work');
});

const apiSource = fs.readFileSync(new URL('../api/github-upload.js', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../src/SpineApp.tsx', import.meta.url), 'utf8');

test('API exposes create, restore and revoke actions without persisting plaintext recovery secrets', () => {
  assert.match(apiSource, /action === 'create-anonymous-recovery-key'/);
  assert.match(apiSource, /action === 'recover-anonymous-library'/);
  assert.match(apiSource, /action === 'revoke-anonymous-recovery-key'/);
  assert.match(apiSource, /addRecoveryHashToOwnedEntries\(entries, anonymousAccount\.id, recoveryHash/);
  assert.match(apiSource, /recoverEntriesByRecoveryHash\(entries, recoveryHash, anonymousAccount\.id\)/);
  assert.doesNotMatch(apiSource, /ownerRecoveryHash\s*:\s*recoverySecret/);
  assert.match(apiSource, /Cache-Control', 'no-store, private/);
  assert.match(appSource, /cache: "no-store"/);
});

test('Google-linked uploads never write raw email or unkeyed email hashes to the public index', () => {
  assert.doesNotMatch(apiSource, /\\.ownerEmail\\s*=/);
  assert.doesNotMatch(apiSource, /\\bownerEmail\\s*:/);
  assert.doesNotMatch(apiSource, /\\.ownerEmailSha256\\s*=/);
  assert.doesNotMatch(apiSource, /\\bownerEmailSha256\\s*:/);
  assert.match(apiSource, /function googleOwnerAccountId\(googlePayload\)/);
  assert.match(apiSource, /ownerAccountId = googleOwnerAccountId\(googlePayload\)/);
});

test('public library authorization is calculated before private owner fields are stripped', () => {
  const start = apiSource.indexOf('function accountLibraryEntries(');
  const end = apiSource.indexOf('const archiveAdminEmails', start);
  assert.ok(start >= 0 && end > start);
  const projection = apiSource.slice(start, end);
  assert.match(projection, /canEditEntry\(entry, googlePayload, anonymousAccount\)/);
  assert.match(projection, /publicLibraryEntry\(origin, entry\)/);
});

test('updates to existing library entries require the current owner', () => {
  assert.match(apiSource, /if \(existingEntry && !canEditEntry\(existingEntry, googlePayload, anonymousAccount\)\)/);
  assert.match(apiSource, /if \(existing && !canEditEntry\(existing, googlePayload, anonymousAccount\)\)/);
});

test('browser upload payloads do not include Google emails or anonymous owner IDs', () => {
  assert.doesNotMatch(appSource, /ownerEmail\\s*:/);
  assert.doesNotMatch(appSource, /ownerAnonId\\s*:/);
  assert.doesNotMatch(appSource, /user\\?\.email\s*\|\|\s*anonymousAccount\.id/);
  assert.match(appSource, /function publicOwnerIdFor\(_user: GoogleUser \| null, anonymousAccount: AnonymousAccount\)/);
});
