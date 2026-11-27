/** Convert legacy Spine binary exports into a format understood by the current web player. */
let converterPromise;

async function loadConverter() {
  if (!converterPromise) {
    converterPromise = import("spine-converter")
      .then(({ Converter }) => Converter.load())
      .catch((error) => {
        converterPromise = null;
        throw error;
      });
  }
  return converterPromise;
}

/**
 * Convert Spine 3.7 binary skeletons and their atlases to Spine 4.3.
 * The official Spine 3.7 TypeScript runtime does not implement binary loading.
 * The converter reports any data it must approximate or drop.
 */
export async function convertLegacySpineAsset(buffer, kind, suppliedConverter) {
  if (!(buffer instanceof Uint8Array) || buffer.length === 0) {
    throw new TypeError("A non-empty Spine asset buffer is required.");
  }
  if (kind !== "skeleton" && kind !== "atlas") {
    throw new TypeError("Spine asset kind must be skeleton or atlas.");
  }

  const converter = suppliedConverter || await loadConverter();
  const input = Uint8Array.from(buffer);
  const detected = converter.detect(input);

  if (kind === "skeleton") {
    if (detected.format !== "binary" || !/^3\.7(?:\.|$)/.test(detected.version)) {
      throw new Error("Only Spine 3.7 binary skeletons can use this conversion path.");
    }
  } else if (detected.format !== "atlas") {
    throw new Error("The supplied file is not a Spine texture atlas.");
  }

  const result = converter.convert(input, {
    targetVersion: "4.3",
    targetFormat: kind === "skeleton" ? "json" : "atlas",
    failOnLoss: true,
  });

  const lossCount = Number(result.lossCount) || 0;
  if (lossCount > 0) {
    const impact = String(result.maxImpact || "unknown");
    throw new Error(`Spine conversion rejected lossy output (${lossCount} loss events; max impact: ${impact}).`);
  }

  if (!(result.data instanceof Uint8Array) || result.data.length === 0) {
    throw new Error("Spine conversion returned an empty asset.");
  }

  return {
    buffer: Buffer.from(result.data),
    sourceVersion: detected.version,
    targetVersion: "4.3",
    lossCount,
    maxImpact: String(result.maxImpact || "none"),
    report: Array.isArray(result.report) ? result.report : [],
  };
}
