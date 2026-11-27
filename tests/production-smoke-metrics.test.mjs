import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
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

test("all production preview smoke contexts isolate metrics writes", () => {
  const workflow = readFileSync(new URL("../.github/workflows/spine-link-browser-smoke.yml", import.meta.url), "utf8");
  const binarySmoke = readFileSync(new URL("./spine37-binary-preview.e2e.mjs", import.meta.url), "utf8");

  assert.match(workflow, /createProductionSmokeMetricsResponse/);
  assert.match(workflow, /await isolateProductionSmokeMetrics\\(page\\)/);
  assert.match(workflow, /await isolateProductionSmokeMetrics\\(playbackPage\\)/);
  assert.match(workflow, /await isolateProductionSmokeMetrics\\(convertedPage\\)/);
  assert.match(binarySmoke, /createProductionSmokeMetricsResponse/);
  assert.match(binarySmoke, /page\\.route\\('\\*\\*\\/api\\/github-upload'/);
});
