export function createProductionSmokeMetricsResponse(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  if (payload.action === "get-metrics") {
    return {
      status: 200,
      body: { ok: true, metrics: {} },
    };
  }

  if (payload.action === "track-metric" && payload.metricAction === "view") {
    return {
      status: 200,
      body: { ok: true, metric: null, deferred: true },
    };
  }

  return null;
}
