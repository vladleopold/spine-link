import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/SpineApp.tsx", import.meta.url), "utf8");

test("public Spine player mobile height leaves the first animation control in view", () => {
  assert.match(css, /public-player-mobile-fit/);
  assert.match(css, /height:\s*clamp\([^;]+svh/);
  assert.match(css, /@media\s*\(max-width:\s*1023px\)/);
});

test("desktop player sidebar limits related user video previews to seven in a two-column grid", () => {
  assert.match(app, /related-user-animations/);
  assert.match(app, /\.slice\(0,\s*7\)/);
  assert.match(css, /related-user-animations-grid[\s\S]*?grid-template-columns:\s*repeat\(2,/);
});

test("related video previews pause outside the viewport and loop while visible", () => {
  assert.match(app, /IntersectionObserver/);
  assert.match(app, /related-user-animation-video/);
  assert.match(app, /video\.pause\(\)/);
  assert.match(app, /video\.play\(\)/);
});

test("related works are fetched from the public owner index without exposing private source metadata", () => {
  const api = readFileSync(new URL("../api/github-library.js", import.meta.url), "utf8");
  assert.match(app, /api\/github-library\?user=.*format=json/);
  assert.match(api, /request\.query\?\.format/);
  assert.match(api, /showOwnerLibrary !== false/);
  assert.match(api, /webmPreviewMedium/);
  const publicPayload = api.slice(api.indexOf("const publicEntries ="), api.indexOf("const entriesWithFallback"));
  assert.doesNotMatch(publicPayload, /ownerEmail|ownerAccountId|skeleton:|atlas:/);
});
