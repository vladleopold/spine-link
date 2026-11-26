const queues = new Map();

/**
 * Serialize mutations for the same resource within a warm serverless instance.
 * GitHub Contents writes use optimistic SHA checks; this queue prevents
 * concurrent requests handled by one instance from racing on the same file.
 */
export function runSerializedWrite(key, operation) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) throw new TypeError('A non-empty write-queue key is required');
  if (typeof operation !== 'function') throw new TypeError('A write operation is required');

  const previous = queues.get(normalizedKey) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  queues.set(normalizedKey, gate);

  return previous.catch(() => {}).then(operation).finally(() => {
    release();
    if (queues.get(normalizedKey) === gate) queues.delete(normalizedKey);
  });
}
