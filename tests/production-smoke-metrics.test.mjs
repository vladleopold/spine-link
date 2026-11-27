import assert from "node:assert/strict";
import test from "node:test";
import { createProductionSmokeMetricsResponse } from "../scripts/lib/production-smoke-metrics.mjs";

test("production smoke returns empty metrics without reading or writing the live metrics store", () => {
  assert.deepEqual(createProductionSmokeMetricsResponse({
    action: "get-metrics",
    ids: ["work-a", "work-b"],
  }), {
    status: 200,
    body: { ok: true, metrics: {} },
  });
});

test("production smoke acknowledges view events without mutating production metrics", () => {
  assert.deepEqual(createProductionSmokeMetricsResponse({
    action: "track-metric",
    metricAction: "view",
    entryId: "work-a",
  }), {
    status: 200,
    body: { ok: true, metric: null, deferred: true },
  });
});

test("production smoke does not intercept likes or unrelated API actions", () => {
  assert.equal(createProductionSmokeMetricsResponse({
    action: "track-metric",
    metricAction: "like",
    entryId: "work-a",
  }), null);
  assert.equal(createProductionSmokeMetricsResponse({
    action: "stage-blob",
    path: "library_02/work-a/hero.spine",
  }), null);
});
