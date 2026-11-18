export type AtlasInferenceMetrics = {
  inferred: boolean;
  confidence: number;
  coverage: number;
  matched: number;
  total: number;
};

export function assertAtlasInferenceUsable(result: AtlasInferenceMetrics): number;
