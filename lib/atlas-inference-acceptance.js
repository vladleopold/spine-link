const MIN_CONFIDENCE = 0.52;
const MIN_COVERAGE = 0.75;
const MIN_MATCH_RATIO = 0.6;

/**
 * Apply the same fail-closed threshold to browser imports and server exports.
 * Named texture pages are exact matches; packed sheets are accepted only when
 * enough JSON regions match the source PNG geometry with adequate coverage.
 */
export function assertAtlasInferenceUsable(result) {
  const confidence = result?.confidence;
  const coverage = result?.coverage;
  const matched = result?.matched;
  const total = result?.total;

  if (
    !result ||
    typeof result.inferred !== "boolean" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1 ||
    !Number.isFinite(coverage) ||
    coverage < 0 ||
    coverage > 1 ||
    !Number.isSafeInteger(matched) ||
    !Number.isSafeInteger(total) ||
    total < 1 ||
    matched < 0 ||
    matched > total
  ) {
    throw new Error("Atlas inference returned invalid confidence metrics");
  }

  const matchRatio = matched / total;
  if (
    result.inferred &&
    (confidence < MIN_CONFIDENCE ||
      coverage < MIN_COVERAGE ||
      matchRatio < MIN_MATCH_RATIO)
  ) {
    throw new Error(
      "Cannot infer a reliable atlas: " +
        matched +
        "/" +
        total +
        " regions, confidence " +
        Math.round(confidence * 100) +
        "%, coverage " +
        Math.round(coverage * 100) +
        "%. Original JSON and texture files are preserved."
    );
  }

  return matchRatio;
}
