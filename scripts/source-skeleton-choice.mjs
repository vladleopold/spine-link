function normalizedFileName(value) {
  let source = String(value || '').trim();
  if (!source) return '';
  try {
    source = new URL(source, 'https://spine-source.invalid').pathname;
  } catch {}
  try {
    source = decodeURIComponent(source);
  } catch {}
  return source.replace(/\\\\/g, '/').split('/').filter(Boolean).pop() || '';
}

function stem(value) {
  return normalizedFileName(value).replace(/\\.(?:skel|json)$/i, '').toLowerCase();
}

// Preserve the indexed source skeleton. A converted JSON or same-stem binary
// alias is allowed; another skeleton in the same directory is never guessed.
export function chooseSourceSkeleton(requested, files, isValidJson = () => false) {
  const names = Array.isArray(files) ? files.map(String) : [];
  const wanted = normalizedFileName(requested);
  if (wanted) {
    const wantedStem = stem(wanted);
    const exact = names.find((name) => normalizedFileName(name) === wanted);
    if (exact && /\\.json$/i.test(exact) && isValidJson(exact)) return exact;
    if (/\\.skel$/i.test(wanted)) {
      const converted = names.find((name) => stem(name) === wantedStem && /\\.json$/i.test(name) && isValidJson(name));
      if (converted) return converted;
    }
    if (/\\.json$/i.test(wanted)) {
      const alias = names.find((name) => stem(name) === wantedStem && /\\.skel$/i.test(name));
      if (alias) return alias;
    }
    if (exact && /\\.skel$/i.test(exact)) return exact;
    throw new Error('SOURCE_SKELETON_MISSING_OR_AMBIGUOUS');
  }

  const validJson = names.filter((name) => /\\.json$/i.test(name) && isValidJson(name));
  if (validJson.length === 1) return validJson[0];
  const binary = names.filter((name) => /\\.skel$/i.test(name));
  if (validJson.length === 0 && binary.length === 1) return binary[0];
  throw new Error('SOURCE_SKELETON_MISSING_OR_AMBIGUOUS');
}
