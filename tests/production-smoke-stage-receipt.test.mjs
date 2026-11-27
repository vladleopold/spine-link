import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createProductionSmokeStageReceipt } from "../scripts/lib/production-smoke-stage-receipt.mjs";

test("production smoke stage receipt satisfies the client contract without a real Git write", () => {
  const content = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const payload = {
    action: "stage-blob",
    path: "library_02/test-upload/images/texture.png",
    uploadPath: "library_02/test-upload",
    contentBase64: content.toString("base64"),
  };

  assert.deepEqual(createProductionSmokeStageReceipt(payload), {
    ok: true,
    path: payload.path,
    uploadPath: payload.uploadPath,
    blobSha: "a".repeat(40),
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
    signature: "production-smoke-test-only",
  });
});

test("production smoke stage receipt rejects incomplete or malformed requests", () => {
  assert.throws(() => createProductionSmokeStageReceipt({}), /valid mocked stage request/);
  assert.throws(() => createProductionSmokeStageReceipt({
    path: "library_02/test-upload/hero.spine",
    uploadPath: "library_02/test-upload",
    contentBase64: "not base64!",
  }), /valid mocked stage request/);
  assert.throws(() => createProductionSmokeStageReceipt({
    path: "library_02/test-upload/empty.png",
    uploadPath: "library_02/test-upload",
    contentBase64: "",
  }), /valid mocked stage request/);
});
