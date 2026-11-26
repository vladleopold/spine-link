import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPublicUploaderEvidence } from "../lib/source-proof-privacy.js";

test("anonymous public proof contains no stable browser or device identifier", () => {
  const evidence = createPublicUploaderEvidence({
    mode: "anonymous-browser",
    anonymousAccountId: "anon_device_fingerprint_random",
    anonymousFingerprint: "device-fingerprint",
    browserFingerprintSha256: "a".repeat(64),
    browserEnvironmentHashSha256: "b".repeat(64),
    browserEnvironment: {
      userAgent: "Private browser string",
      screen: { width: 2560, height: 1440 },
      timezone: "Europe/Kyiv",
    },
  });

  assert.deepEqual(evidence, { mode: "anonymous-browser" });
});

test("Google public proof records the sign-in mode without exposing an email digest or device telemetry", () => {
  const evidence = createPublicUploaderEvidence({
    mode: "google-account",
    googleEmailSha256: "c".repeat(64),
    anonymousAccountId: "must-not-appear",
    browserEnvironment: { userAgent: "must-not-appear" },
  });

  assert.deepEqual(evidence, { mode: "google-account" });
});

test("new client proofs use v2 and only the privacy-safe uploader projection", async () => {
  const source = await readFile(new URL("../src/SpineApp.tsx", import.meta.url), "utf8");
  const start = source.indexOf("async function createSourceProof(");
  const end = source.indexOf("\nfunction editEntryIdFromLocation", start);
  assert.ok(start >= 0 && end > start, "source proof builder must be present");
  const builder = source.slice(start, end);

  assert.match(builder, /version: 2 as const/);
  assert.match(builder, /uploader: createPublicUploaderEvidence/);
  for (const field of ["anonymousAccountId:", "anonymousFingerprint:", "browserFingerprintSha256:", "browserEnvironmentHashSha256:", "browserEnvironment:"]) {
    assert.equal(builder.includes(field), false, `new proof must not publish ${field}`);
  }
});

test("server blockchain anchors project uploader data through the privacy-safe allowlist", async () => {
  const source = await readFile(new URL("../api/github-upload.js", import.meta.url), "utf8");
  const start = source.indexOf("async function createBlockchainAnchor(");
  const end = source.indexOf("\nfunction derivedMediaFromFiles", start);
  assert.ok(start >= 0 && end > start, "blockchain anchor builder must be present");
  const builder = source.slice(start, end);

  assert.match(builder, /version: 2/);
  assert.match(builder, /uploader: createPublicUploaderEvidence/);
  for (const field of ["anonymousAccountId:", "anonymousFingerprint:", "browserFingerprintSha256:", "browserEnvironmentHashSha256:", "browserEnvironment:"]) {
    assert.equal(builder.includes(field), false, `public anchor must not publish ${field}`);
  }
});
