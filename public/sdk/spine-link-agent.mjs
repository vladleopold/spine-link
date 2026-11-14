/**
 * Spine-Link Agent SDK 1.0
 * Server-side ESM for Node.js 20+. Zero dependencies.
 * Never bundle this client with an API key into website/browser JavaScript.
 *
 * import { SpineLinkAgent } from './spine-link-agent.mjs';
 * const api = new SpineLinkAgent({ apiKey: process.env.SPINE_LINK_AGENT_API_KEY });
 * const result = await api.publish({
 *   title: 'Walk', format: 'runtime',
 *   files: [{ path: 'actor.json', bytes: jsonBytes }, ...]
 * });
 * console.log(result.pageUrl);
 */
const ENDPOINT = 'https://spine-link.vercel.app/api/agent-animation';
const PART_BYTES = 2_100_000;
const SMALL_BYTES = 512_000;
const BATCH_BYTES = 2_000_000;
const MAX_FILES = 250;
const MAX_FILE_BYTES = 95_000_000;

export class SpineLinkApiError extends Error {
  constructor(status, message) {
    super(String(message || 'Spine-Link API request failed'));
    this.name = 'SpineLinkApiError';
    this.status = status;
  }
}

export function normalizeAgentFile(file) {
  const path = String(file?.path || file?.name || '').replace(/\\/g, '/');
  if (!path || path.startsWith('/') || path.length > 400 ||
      path.split('/').some(p => !p || p === '..' || p === '.' ||
        p.startsWith('.') || /[\x00-\x1f?#<>:"|*]/.test(p))) {
    throw new TypeError('Invalid relative Spine asset path');
  }
  let bytes = file?.bytes ?? file?.data;
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('Provide a Uint8Array or Buffer for ' + path);
  }
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) {
    throw new RangeError('File size outside allowed range for ' + path);
  }
  return { path, bytes };
}

function encodeBase64(bytes) {
  if (typeof Buffer === 'undefined') throw new Error('Use this SDK in a Node.js server');
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class SpineLinkAgent {
  constructor({ apiKey, endpoint = ENDPOINT, fetchImpl = globalThis.fetch, timeoutMs = 60000 } = {}) {
    if (typeof apiKey !== 'string' || !apiKey) throw new TypeError('Server-side API key is required');
    let target;
    try { target = new URL(endpoint); } catch { throw new TypeError('Invalid API endpoint'); }
    if (target.protocol !== 'https:' || !target.pathname.endsWith('/api/agent-animation') ||
        target.search || target.hash || target.username || target.password) {
      throw new TypeError('Expected HTTPS /api/agent-animation endpoint');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    this.apiKey = apiKey;
    this.endpoint = target.href;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(body, { retries = 0 } = {}) {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + this.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (attempt < retries) { await sleep(250 * 2 ** attempt); continue; }
        throw error;
      }
      let payload = {};
      try { payload = await response.json(); } catch {}
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < retries) {
          const retryAfter = Number(response.headers?.get?.('Retry-After')) || 0;
          await sleep(Math.min(5000, retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt));
          continue;
        }
        throw new SpineLinkApiError(response.status, payload.error || ('HTTP ' + response.status));
      }
      return payload;
    }
  }

  createJob({ title = 'Agent animation', format = 'runtime' } = {}) {
    if (!['runtime', 'spine-project'].includes(format)) throw new TypeError('Invalid Spine format');
    return this.request({ action: 'create', title, format });
  }

  stage(jobToken, path, bytes) {
    return this.request({
      action: 'stage', jobToken, name: path, contentBase64: encodeBase64(bytes),
    }, { retries: 2 }).then(result => result.receipt);
  }

  stageBatch(jobToken, files) {
    if (!files.length || files.length > 8) throw new RangeError('Batch must contain 1–8 assets');
    return this.request({
      action: 'stage-batch',
      jobToken,
      files: files.map(file => ({ name: file.path, contentBase64: encodeBase64(file.bytes) })),
    }, { retries: 2 }).then(result => {
      if (!Array.isArray(result.receipts) || result.receipts.length !== files.length) {
        throw new Error('Incomplete batch receipt set');
      }
      return result.receipts;
    });
  }

  status({ id, collection, jobToken } = {}) {
    if (!jobToken && (!id || !collection)) throw new TypeError('Provide jobToken or id and collection');
    // POST instead of URL query keeps signed job tokens out of proxy history.
    return this.request({ action: 'status', ...(jobToken ? { jobToken } : { id, collection }) }, { retries: 2 });
  }

  async publish({
    title = 'Agent animation', format = 'runtime', files,
    defaultAnimation = '', agentName = 'Animation Agent', public: isPublic = false,
  } = {}) {
    if (!Array.isArray(files) || files.length < 2 || files.length > MAX_FILES) {
      throw new RangeError('Spine animation requires 2–250 files');
    }
    const normalized = files.map(normalizeAgentFile);
    const names = new Set();
    let total = 0;
    for (const file of normalized) {
      if (names.has(file.path)) throw new TypeError('Duplicate file: ' + file.path);
      names.add(file.path);
      total += file.bytes.length;
    }
    if (total > 200_000_000) throw new RangeError('Animation exceeds 200 MB upload limit');
    if (!['runtime', 'spine-project'].includes(format)) throw new TypeError('Unknown Spine format');
    const job = await this.createJob({ title, format });
    const receipts = [], assemblies = [];
    let batch = [], batchBytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      receipts.push(...await this.stageBatch(job.jobToken, batch));
      batch = [];
      batchBytes = 0;
    };
    for (const file of normalized) {
      if (file.bytes.length <= SMALL_BYTES) {
        if (batch.length >= 8 || batchBytes + file.bytes.length > BATCH_BYTES) await flush();
        batch.push(file);
        batchBytes += file.bytes.length;
      } else {
        await flush();
        if (file.bytes.length <= PART_BYTES) {
          receipts.push(await this.stage(job.jobToken, file.path, file.bytes));
        } else {
          const parts = [];
          for (let offset = 0; offset < file.bytes.length; offset += PART_BYTES) {
            parts.push(await this.stage(job.jobToken, file.path, file.bytes.subarray(offset, offset + PART_BYTES)));
          }
          assemblies.push({ name: file.path, parts });
        }
      }
    }
    await flush();
    // A publish may commit even if its HTTP response is lost; do not blindly
    // retry "complete". A consumer can call status with id/collection afterward.
    const result = await this.request({
      action: 'complete', jobToken: job.jobToken,
      files: receipts, assemblies, agentName, defaultAnimation, public: isPublic,
    });
    return { ...result, collection: job.uploadPath.split('/')[0], uploadId: job.id };
  }

  async waitReady(job, { intervalMs = 5000, timeoutMs = 12 * 60_000 } = {}) {
    if (!job?.id || !job?.collection) throw new TypeError('Expected published job id and collection');
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const current = await this.status({ id: job.id, collection: job.collection });
      if (current.state === 'ready' || current.state === 'failed') return current;
      if (Date.now() >= deadline) throw new Error('Spine export status polling exceeded timeout');
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    }
  }
}
