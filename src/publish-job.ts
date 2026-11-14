import { uploadRequest } from "./upload-request";
// Background publishing.
//
// Saving an animation used to live entirely inside the React component that
// started it: progress was component state and every file went out as its own
// request. Leaving the page killed both - the popup vanished and the upload
// died halfway. This module owns the job instead of the component:
//
//   * progress is a module store mirrored into localStorage, so every page can
//     render the same top-left popup and keep it up to date;
//   * the payload is written to IndexedDB before the first request, so a
//     navigation can be resumed by whichever page loads next;
//   * the file writes are batched into as few requests as the platform allows
//     (one commit on GitHub instead of one per file).

export type PublishProgressStatus = "idle" | "running" | "done" | "failed";

export type PublishProgress = {
  open: boolean;
  value: number;
  label: string;
  kicker: string;
  status: PublishProgressStatus;
  permalink: string;
  error: string;
  jobId: string;
  updatedAt: number;
};

export type PublishJobFile = { path: string; contentBase64: string };

export type PublishJob = {
  id: string;
  permalink: string;
  kicker: string;
  settings: { owner: string; repo: string; branch: string; basePath: string; title: string };
  commitPrefix: string;
  entry: Record<string, unknown> & { id?: string; previewPath?: string; uploadedAt?: string };
  files: PublishJobFile[];
  sourceProof?: Record<string, unknown> & { proofPath?: string; proofUrl?: string };
  anchorPath: string;
  googleIdToken?: string;
  anonymousAccount?: { id: string; fingerprint: string } | Record<string, unknown>;
  startedAt: number;
  attempts: number;
};

const PROGRESS_KEY = "__spinePublishProgress";
const DB_NAME = "spine-publish-jobs";
const STORE = "jobs";
const MAX_ATTEMPTS = 5;
const JOB_MAX_AGE_MS = 30 * 60 * 1000;
// Vercel refuses request bodies over 4.5MB, and the JSON envelope costs a few
// kilobytes on top of the payload, so a batch stops well below the cap.
const BATCH_BYTES = 4_000_000;
// The entry, source proof and settings ride along in every batch request, so
// they are subtracted from the payload budget instead of pushing the body past
// the platform's request size limit.
const BATCH_OVERHEAD = 500_000;
// The Git Blob staging endpoint accepts at most this many Base64 characters
// per request, leaving plenty of headroom below Vercel's 4.5 MB body limit.
const STAGE_BYTES = 3_200_000;
const PARALLEL_STAGE_REQUESTS = 4;
const DONE_HIDE_AFTER_MS = 15_000;

const IDLE: PublishProgress = {
  open: false,
  value: 0,
  label: "",
  kicker: "Creating page",
  status: "idle",
  permalink: "",
  error: "",
  jobId: "",
  updatedAt: 0,
};

function readPersistedProgress(): PublishProgress {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) return { ...IDLE };
    const parsed = JSON.parse(raw) as Partial<PublishProgress>;
    if (!parsed || typeof parsed !== "object") return { ...IDLE };
    // A state older than this is history, not something to keep nagging about.
    if (Date.now() - Number(parsed.updatedAt || 0) > 10 * 60 * 1000) return { ...IDLE };
    return { ...IDLE, ...parsed };
  } catch {
    return { ...IDLE };
  }
}

let snapshot: PublishProgress = typeof localStorage === "undefined" ? { ...IDLE } : readPersistedProgress();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(snapshot));
  } catch {
    /* storage can be unavailable in private mode; the popup still works in-tab */
  }
}

function notify() {
  snapshot = { ...snapshot, updatedAt: Date.now() };
  persist();
  try {
    window.dispatchEvent(new CustomEvent("spine-publish-progress", { detail: snapshot }));
  } catch {
    /* no window during module preload */
  }
  listeners.forEach((listener) => listener());
}

export function subscribePublishProgress(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPublishProgress(): PublishProgress {
  return snapshot;
}

export function setPublishProgress(patch: Partial<PublishProgress>) {
  const next = { ...snapshot, ...patch };
  if (
    next.open === snapshot.open &&
    next.value === snapshot.value &&
    next.label === snapshot.label &&
    next.kicker === snapshot.kicker &&
    next.status === snapshot.status &&
    next.permalink === snapshot.permalink &&
    next.error === snapshot.error &&
    next.jobId === snapshot.jobId
  ) {
    return;
  }
  snapshot = next;
  notify();
}

export function hidePublishProgress() {
  snapshot = { ...IDLE };
  notify();
}

function scheduleDoneHide(jobId: string) {
  window.setTimeout(() => {
    const current = getPublishProgress();
    if (current.status === "done" && current.jobId === jobId && current.open) hidePublishProgress();
  }, DONE_HIDE_AFTER_MS);
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise<T | null>((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function saveJob(job: PublishJob) {
  await withStore("readwrite", (store) => store.put(job));
}

async function listJobs(): Promise<PublishJob[]> {
  const rows = await withStore<PublishJob[]>("readonly", (store) => store.getAll());
  return Array.isArray(rows) ? rows : [];
}

async function removeJob(id: string) {
  await withStore("readwrite", (store) => store.delete(id));
}

const activeJobs = new Set<string>();
let resumePromise: Promise<void> | null = null;

function abortMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "Saving was interrupted";
  return error instanceof Error ? error.message : String(error || "Publishing error");
}

async function postPublish(job: PublishJob, payload: Record<string, unknown>, action = "publish-entry"): Promise<Record<string, unknown>> {
  const body = JSON.stringify({
    action,
    googleIdToken: job.googleIdToken || "",
    anonymousAccount: job.anonymousAccount,
    settings: job.settings,
    commitPrefix: job.commitPrefix,
    anchorPath: job.anchorPath,
    sourceProof: job.sourceProof,
    uploadPath: job.entry?.previewPath || "",
    proofPath: job.sourceProof?.proofPath || "",
    proofUrl: job.sourceProof?.proofUrl || "",
    entryId: job.entry?.id || job.id,
    title: job.settings.title,
    uploadedAt: job.entry?.uploadedAt || "",
    ...payload,
  });

  const response = await uploadRequest("/api/github-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Upload API ${response.status}`);
  return result;
}

function groupFiles(files: PublishJobFile[], limit: number): PublishJobFile[][] {
  const groups: PublishJobFile[][] = [];
  let current: PublishJobFile[] = [];
  let size = 0;
  for (const file of files) {
    const nextSize = size + file.contentBase64.length + file.path.length + 64;
    if (current.length && nextSize > limit) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += file.contentBase64.length + file.path.length + 64;
  }
  if (current.length) groups.push(current);
  return groups;
}

export async function runPublishJob(job: PublishJob): Promise<void> {
  if (activeJobs.has(job.id)) return;
  activeJobs.add(job.id);

  const totalBytes = job.files.reduce((total, file) => total + file.contentBase64.length, 0) || 1;
  let sentBytes = 0;
  const report = (label: string) => {
    setPublishProgress({
      open: true,
      status: "running",
      jobId: job.id,
      kicker: job.kicker,
      permalink: job.permalink,
      error: "",
      label,
      value: Math.max(6, Math.min(94, Math.round((sentBytes / totalBytes) * 84) + 8)),
    });
  };

  try {
    report("Saving files");

    // Small Spine projects publish in one request and one commit, without any
    // staging round trip. For larger projects stage all assets independently,
    // in up to four simultaneous network requests, and commit them once.
    const directLimit = Math.max(200_000, BATCH_BYTES - BATCH_OVERHEAD);
    if (totalBytes <= directLimit) {
      await postPublish(job, { files: job.files, entry: job.entry });
      sentBytes = totalBytes;
      report("Writing source proof anchor");
    } else {
      type StageReceipt = {
        path: string; blobSha: string; bytes: number; sha256: string; signature: string;
      };
      const tasks: Array<{ path: string; contentBase64: string }> = [];
      for (const file of job.files) {
        for (let index = 0; index < file.contentBase64.length; index += STAGE_BYTES) {
          tasks.push({ path: file.path, contentBase64: file.contentBase64.slice(index, index + STAGE_BYTES) });
        }
      }
      const receipts: StageReceipt[] = new Array(tasks.length);
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(PARALLEL_STAGE_REQUESTS, tasks.length) }, async () => {
        while (cursor < tasks.length) {
          const index = cursor++;
          const task = tasks[index];
          const result = await postPublish(job, task, "stage-blob");
          if (typeof result.blobSha !== "string" || typeof result.signature !== "string" ||
              result.path !== task.path) {
            throw new Error("Server did not acknowledge the staged Spine asset");
          }
          receipts[index] = result as StageReceipt;
          sentBytes += task.contentBase64.length;
          report("Uploading files in parallel");
        }
      }));
      const groups = new Map<string, StageReceipt[]>();
      for (const receipt of receipts) {
        const existing = groups.get(receipt.path) || [];
        existing.push(receipt);
        groups.set(receipt.path, existing);
      }
      const stagedBlobs: StageReceipt[] = [];
      const stagedAssemblies: Array<{ path: string; parts: StageReceipt[] }> = [];
      for (const [path, parts] of groups) {
        if (parts.length === 1) stagedBlobs.push(parts[0]);
        else stagedAssemblies.push({ path, parts });
      }
      report("Publishing all files in one commit");
      await postPublish(job, { stagedBlobs, stagedAssemblies, entry: job.entry });
    }

    const permalink = job.permalink;
    setPublishProgress({
      open: true,
      status: "done",
      value: 100,
      label: "Permanent link ready",
      kicker: job.kicker,
      permalink,
      error: "",
      jobId: job.id,
    });
    try {
      localStorage.setItem("__spineUploadComplete", JSON.stringify({ url: permalink, timestamp: Date.now() }));
    } catch {
      /* ignore */
    }
    try {
      window.dispatchEvent(new CustomEvent("spine-upload-complete", { detail: { url: permalink } }));
      window.dispatchEvent(
        new CustomEvent("spine-publish-complete", { detail: { url: permalink, jobId: job.id, entry: job.entry } }),
      );
    } catch {
      /* ignore */
    }
    await removeJob(job.id);
    scheduleDoneHide(job.id);
    // The published URL is usable after the server acknowledges the final batch.
    // Clipboard writes may be blocked outside a user gesture; the result link remains visible.
    try { await navigator.clipboard.writeText(permalink); } catch { /* user can copy manually */ }
    window.setTimeout(() => { window.location.assign(permalink); }, 950);
  } catch (error) {
    const message = abortMessage(error);
    const attempts = Number(job.attempts || 0) + 1;
    const exhausted = attempts >= MAX_ATTEMPTS;
    if (exhausted) await removeJob(job.id);
    else await saveJob({ ...job, attempts });
    setPublishProgress({
      open: true,
      status: "failed",
      label: "Saving failed",
      kicker: job.kicker,
      permalink: job.permalink,
      error: message,
      jobId: job.id,
    });
  } finally {
    activeJobs.delete(job.id);
  }
}

/** Persists the job first: a navigation one second later still has the payload. */
export async function startPublishJob(job: PublishJob): Promise<void> {
  const record: PublishJob = { ...job, startedAt: job.startedAt || Date.now(), attempts: Number(job.attempts || 0) };
  await saveJob(record);
  setPublishProgress({
    open: true,
    status: "running",
    jobId: record.id,
    kicker: record.kicker,
    permalink: record.permalink,
    error: "",
    label: "Preparing files",
    value: 6,
  });
  await runPublishJob(record);
}

/**
 * Continues whatever a previous page started. Called once per document by both
 * the boot shell and the mounted app; the active-job set keeps them from
 * running the same record twice.
 */
export function resumePendingJobs(): Promise<void> {
  if (resumePromise) return resumePromise;
  resumePromise = (async () => {
    const jobs = await listJobs();
    const now = Date.now();
    for (const job of jobs) {
      if (activeJobs.has(job.id)) continue;
      if (Number(job.attempts || 0) >= MAX_ATTEMPTS || now - Number(job.startedAt || 0) > JOB_MAX_AGE_MS) {
        await removeJob(job.id);
        continue;
      }
      void runPublishJob(job);
    }
    if (!jobs.length) {
      const current = getPublishProgress();
      if (current.status === "running" && now - current.updatedAt > 15_000) {
        setPublishProgress({ status: "failed", label: "Saving failed", error: "Saving was interrupted" });
      } else if (current.status === "done" && current.open) {
        scheduleDoneHide(current.jobId);
      }
    }
  })();
  return resumePromise;
}
