import { createHash, randomBytes } from 'node:crypto';

const RECOVERY_SECRET_BYTES = 32;
const RECOVERY_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PRIVATE_LIBRARY_FIELDS = [
  'ownerEmail',
  'ownerEmailSha256',
  'ownerAccountId',
  'ownerAnonId',
  'ownerAnonFingerprint',
  'ownerRecoveryHash',
  'ownerRecoveryCreatedAt',
  'apiKeyId',
];

export function createRecoverySecret() {
  let secret = '';
  do {
    secret = randomBytes(RECOVERY_SECRET_BYTES).toString('base64url');
  } while (new Set(secret).size < 8);
  return secret;
}

export function normalizeRecoverySecret(value) {
  const secret = String(value ?? '').trim();
  if (!RECOVERY_SECRET_PATTERN.test(secret) || new Set(secret).size < 8) return null;
  const bytes = Buffer.from(secret, 'base64url');
  if (bytes.length !== RECOVERY_SECRET_BYTES || bytes.toString('base64url') !== secret) return null;
  return secret;
}

export function hashRecoverySecret(value) {
  const secret = normalizeRecoverySecret(value);
  if (!secret) return null;
  return createHash('sha256').update(secret).digest('hex');
}

export function addRecoveryHashToOwnedEntries(entries, ownerId, recoveryHash, createdAt = new Date().toISOString()) {
  const normalizedOwnerId = String(ownerId || '').trim().toLowerCase();
  if (!Array.isArray(entries) || !normalizedOwnerId || !/^[a-f0-9]{64}$/i.test(String(recoveryHash || ''))) {
    return { entries: Array.isArray(entries) ? entries : [], changed: 0 };
  }

  let changed = 0;
  const nextEntries = entries.map((entry) => {
    if (String(entry?.ownerAnonId || '').trim().toLowerCase() !== normalizedOwnerId ||
        entry?.ownerEmail || entry?.ownerAccountId) return entry;
    changed += 1;
    const next = { ...entry, ownerRecoveryHash: String(recoveryHash).toLowerCase(), ownerRecoveryCreatedAt: createdAt };
    delete next.ownerAnonFingerprint;
    return next;
  });
  return { entries: nextEntries, changed };
}

export function recoverEntriesByRecoveryHash(entries, recoveryHash, newOwnerId) {
  const hash = String(recoveryHash || '').trim().toLowerCase();
  const ownerId = String(newOwnerId || '').trim();
  if (!Array.isArray(entries) || !/^[a-f0-9]{64}$/.test(hash) || !/^anon_[a-z0-9_-]{3,96}$/i.test(ownerId)) {
    return { entries: Array.isArray(entries) ? entries : [], changed: 0 };
  }

  let changed = 0;
  const nextEntries = entries.map((entry) => {
    if (String(entry?.ownerRecoveryHash || '').toLowerCase() !== hash ||
        entry?.ownerEmail || entry?.ownerAccountId) return entry;
    changed += 1;
    const next = { ...entry, ownerAnonId: ownerId };
    delete next.ownerAnonFingerprint;
    return next;
  });
  return { entries: nextEntries, changed };
}

export function revokeRecoveryHashFromOwnedEntries(entries, ownerId) {
  const normalizedOwnerId = String(ownerId || '').trim().toLowerCase();
  if (!Array.isArray(entries) || !normalizedOwnerId) {
    return { entries: Array.isArray(entries) ? entries : [], changed: 0 };
  }

  let changed = 0;
  const nextEntries = entries.map((entry) => {
    if (String(entry?.ownerAnonId || '').trim().toLowerCase() !== normalizedOwnerId ||
        !entry?.ownerRecoveryHash) return entry;
    changed += 1;
    const next = { ...entry };
    delete next.ownerRecoveryHash;
    delete next.ownerRecoveryCreatedAt;
    delete next.ownerAnonFingerprint;
    return next;
  });
  return { entries: nextEntries, changed };
}

export function stripPrivateOwnerMetadata(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const next = { ...entry };
  for (const field of PRIVATE_LIBRARY_FIELDS) delete next[field];
  return next;
}
