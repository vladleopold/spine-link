#!/usr/bin/env node
// Back up inferred atlases outside the checkout while the export job refreshes main.
// Re-applying them after each refresh keeps recovery output explicit and durable.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { entryForUpload } from "./resolve-library.mjs";

const RECEIPT_SUFFIX = "-atlas-inference-receipt.json";
const isAtlas = (name) => /\.atlas(?:\.txt|\.docx)?$/i.test(name);

function resolveInside(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Refusing a path outside the repository: " + relativePath);
  }
  return resolved;
}

export async function preserveInferredAtlases({
  repoRoot = process.cwd(),
  uploadId,
  backupDir,
  mode = "backup",
}) {
  if (!uploadId || !/^[\w.-]+$/.test(uploadId)) {
    throw new Error("Invalid upload id");
  }
  if (!backupDir) throw new Error("backupDir is required");

  const found = entryForUpload(repoRoot, uploadId);
  if (!found) throw new Error("Upload not found: " + uploadId);

  const previewRelative = found.entry.previewPath || path.posix.join(found.basePath, uploadId);
  const previewDir = resolveInside(path.resolve(repoRoot), previewRelative);
  const backupRoot = path.resolve(backupDir);
  const manifestPath = path.join(backupRoot, "manifest.json");

  if (mode === "backup") {
    await fs.rm(backupRoot, { recursive: true, force: true });
    await fs.mkdir(backupRoot, { recursive: true });
    const receipts = (await fs.readdir(previewDir).catch(() => []))
      .filter((name) => name.endsWith(RECEIPT_SUFFIX));
    const sets = [];

    for (const receiptName of receipts) {
      const setName = receiptName.slice(0, -RECEIPT_SUFFIX.length);
      if (!setName || path.basename(setName) !== setName) continue;

      const receiptPath = path.join(previewDir, receiptName);
      let receipt;
      try {
        receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
      } catch {
        continue;
      }
      if (receipt?.source !== "reconstructed-from-json-and-images") continue;

      const setDir = path.join(previewDir, setName);
      const setFiles = await fs.readdir(setDir).catch(() => []);
      const atlasFiles = setFiles.filter(isAtlas);
      if (!atlasFiles.length) continue;

      for (const atlasFile of atlasFiles) {
        const source = path.join(setDir, atlasFile);
        const destination = path.join(backupRoot, "sets", setName, atlasFile);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(source, destination);
      }

      const receiptBackup = path.join(backupRoot, "receipts", receiptName);
      await fs.mkdir(path.dirname(receiptBackup), { recursive: true });
      await fs.copyFile(receiptPath, receiptBackup);
      sets.push({ setName, atlasFiles, receiptName });
    }

    const manifest = {
      version: 1,
      uploadId,
      previewRelative,
      sets,
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    return { mode, sets: sets.length, atlasFiles: sets.reduce((n, s) => n + s.atlasFiles.length, 0) };
  }

  if (mode !== "restore") throw new Error("Mode must be backup or restore");

  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (
    manifest?.version !== 1 ||
    manifest.uploadId !== uploadId ||
    manifest.previewRelative !== previewRelative ||
    !Array.isArray(manifest.sets)
  ) {
    throw new Error("Inferred atlas backup manifest does not match this upload");
  }

  for (const set of manifest.sets) {
    if (!set || path.basename(set.setName) !== set.setName || !Array.isArray(set.atlasFiles)) {
      throw new Error("Invalid set entry in inferred atlas backup manifest");
    }

    for (const atlasFile of set.atlasFiles) {
      if (path.basename(atlasFile) !== atlasFile || !isAtlas(atlasFile)) {
        throw new Error("Invalid atlas filename in inferred atlas backup manifest");
      }
      const source = path.join(backupRoot, "sets", set.setName, atlasFile);
      const destination = path.join(previewDir, set.setName, atlasFile);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
    }

    if (typeof set.receiptName === "string" && path.basename(set.receiptName) === set.receiptName) {
      const source = path.join(backupRoot, "receipts", set.receiptName);
      const destination = path.join(previewDir, set.receiptName);
      await fs.mkdir(previewDir, { recursive: true });
      await fs.copyFile(source, destination);
    }
  }

  return { mode, sets: manifest.sets.length, atlasFiles: manifest.sets.reduce((n, s) => n + s.atlasFiles.length, 0) };
}

function argument(name) {
  const prefix = "--" + name + "=";
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || "";
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const result = await preserveInferredAtlases({
    uploadId: argument("upload-id"),
    backupDir: argument("backup-dir"),
    mode: argument("mode") || "backup",
  });
  console.log(
    "[inferred-atlas] " + result.mode +
    ": " + result.sets + " set(s), " + result.atlasFiles + " atlas file(s)"
  );
}
