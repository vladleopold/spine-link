import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { preserveInferredAtlases } from "./preserve-inferred-atlas.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "spine-atlas-preserve-"));
try {
  const uploadId = "upload-test-1";
  const previewRelative = "library/upload-test-1";
  const previewDir = path.join(root, previewRelative);
  const setDir = path.join(previewDir, "hero");
  const backupDir = path.join(root, "runner-temp", "atlas-backup");
  const atlasName = "hero.atlas";
  const receiptName = "hero-atlas-inference-receipt.json";
  const atlasContents = "hero.png\nsize: 128, 128\n";

  await fs.mkdir(setDir, { recursive: true });
  await fs.mkdir(path.join(root, "library"), { recursive: true });
  await fs.writeFile(
    path.join(root, "library", "index.json"),
    JSON.stringify([{ id: uploadId, previewPath: previewRelative }])
  );
  await fs.writeFile(path.join(setDir, "hero.json"), JSON.stringify({ bones: [] }));
  await fs.writeFile(path.join(setDir, "hero.png"), "synthetic texture");
  await fs.writeFile(path.join(setDir, atlasName), atlasContents);
  await fs.writeFile(
    path.join(previewDir, receiptName),
    JSON.stringify({ source: "reconstructed-from-json-and-images", confidence: 0.8 })
  );

  const backup = await preserveInferredAtlases({ repoRoot: root, uploadId, backupDir });
  assert.deepEqual(backup, { mode: "backup", sets: 1, atlasFiles: 1 });

  // Simulate the workflow's git reset --hard: inferred files vanish from checkout.
  await fs.rm(path.join(setDir, atlasName));
  await fs.rm(path.join(previewDir, receiptName));

  const restore = await preserveInferredAtlases({
    repoRoot: root,
    uploadId,
    backupDir,
    mode: "restore",
  });
  assert.deepEqual(restore, { mode: "restore", sets: 1, atlasFiles: 1 });
  assert.equal(await fs.readFile(path.join(setDir, atlasName), "utf8"), atlasContents);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(previewDir, receiptName), "utf8")).source,
    "reconstructed-from-json-and-images"
  );

  console.log("PASS inferred atlas and receipt survive a clean-branch reset");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
