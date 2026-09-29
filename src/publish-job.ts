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
const BATCH_BYTES = 3_000_000;
// The entry, source proof and settings ride along in every batch request, so
// they are subtracted from the payload budget instead of pushing the body past
// the platform's request size limit.
const BATCH_OVERHEAD = 500_000;
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

async function postPublish(job: PublishJob, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const body = JSON.stringify({
    action: "publish-entry",
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

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch("/api/github-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.ok) return result;
      const message = typeof result?.error === "string" ? result.error : `Upload API ${response.status}`;
      // Only server faults are worth replaying; a rejected payload fails the
      // same way every time and waiting just delays the visible error.
      if (response.status < 500 && response.status !== 429) throw new Error(message);
      lastError = new Error(message);
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /Upload API 4\d\d/.test(error.message)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
  }
  throw lastError instanceof Error ? lastError : new Error("Publishing failed");
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

    const fileLimit = Math.max(200_000, BATCH_BYTES - BATCH_OVERHEAD);
    const oversize = job.files.filter((file) => file.contentBase64.length > fileLimit);
    const regular = job.files.filter((file) => file.contentBase64.length <= fileLimit);

    const assembles: Array<{ path: string; chunkCount: number }> = [];
    for (const file of oversize) {
      const chunkCount = Math.ceil(file.contentBase64.length / fileLimit);
      for (let index = 0; index < chunkCount; index += 1) {
        await postPublish(job, {
          stageChunks: [
            {
              path: file.path,
              index,
              contentBase64: file.contentBase64.slice(index * fileLimit, (index + 1) * fileLimit),
            },
          ],
        });
        sentBytes += fileLimit;
        report("Saving files");
      }
      assembles.push({ path: file.path, chunkCount });
    }

    const groups = groupFiles(regular, fileLimit);
    if (groups.length) {
      for (let index = 0; index < groups.length; index += 1) {
        const isLast = index === groups.length - 1;
        await postPublish(
          job,
          isLast ? { files: groups[index], assembles, entry: job.entry } : { files: groups[index] },
        );
        sentBytes += groups[index].reduce((total, file) => total + file.contentBase64.length, 0);
        report(isLast ? "Writing source proof anchor" : "Saving files");
      }
    } else {
      await postPublish(job, { assembles, entry: job.entry });
      sentBytes = totalBytes;
      report("Writing source proof anchor");
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
