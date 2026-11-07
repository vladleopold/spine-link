// Collections are read newest first. Missing legacy fields survive rotation;
// explicit values in the newer entry, including visibility, always win.
export function mergeCollectionEntries(collections) {
  const entries = new Map();
  for (const collection of collections) {
    for (const entry of collection.entries || []) {
      if (!entry || !entry.id) continue;
      const current = entries.get(String(entry.id));
      entries.set(String(entry.id), current ? { ...entry, ...current } : { ...entry });
    }
  }
  return [...entries.values()];
}
