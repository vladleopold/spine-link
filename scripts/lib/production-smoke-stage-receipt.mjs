import { createHash } from "node:crypto";

const MOCK_BLOB_SHA = "a".repeat(40);
const MOCK_SIGNATURE = "production-smoke-test-only";

export function createProductionSmokeStageReceipt(payload) {
  const path = typeof payload?.path === "string" ? payload.path : "";
  const uploadPath = typeof payload?.uploadPath === "string" ? payload.uploadPath : "";
  const encoded = typeof payload?.contentBase64 === "string" ? payload.contentBase64 : "";
  const validBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

  if (!path || !uploadPath || !encoded || !validBase64.test(encoded)) {
    throw new TypeError("A valid mocked stage request is required");
  }

  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length) throw new TypeError("Mocked stage content must not be empty");

  return {
    ok: true,
    path,
    uploadPath,
    blobSha: MOCK_BLOB_SHA,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    signature: MOCK_SIGNATURE,
  };
}
