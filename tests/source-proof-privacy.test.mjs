import test from "node:test";
import assert from "node:assert/strict";
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
