import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const app = read('../src/SpineApp.tsx');
const upload = read('../api/github-upload.js');
const agent = read('../lib/agent-animation.js');
const science = read('../lib/spine-data-science.js');
const exporter = read('../scripts/spine-export-webm.mjs');
const cloudExport = read('../scripts/spine-project-cloud-export.mjs');
const exportWorkflow = read('../.github/workflows/spine-export-webm.yml');
const exportWorkflow = read('../.github/workflows/spine-export-webm.yml');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('new uploads require a user-selected animation instead of an implicit idle/first track', () => {
  const loadFiles = section(app, 'const preparedSets = (', 'if (preparedSets.length === 0)');
  assert.match(loadFiles, /const defaultAnimation = ""/);
  assert.doesNotMatch(loadFiles, /animationNames\.find|animationNames\s*\[\s*0\s*\]/);
});

test('player startup, replay, modal and extra players never replace the selected animation', () => {
  assert.doesNotMatch(app, /Automatic preview fallback after publish\/save/);
  assert.doesNotMatch(app, /publishToGitHub\(preparedSpine, animations, fallback\)/);
  assert.doesNotMatch(app, /(?:names|animationsRef\.current|nextAnimations)\s*\[\s*0\s*\]/);
  assert.doesNotMatch(app, /names\.find\(\(animationName\)/);
  assert.match(app, /const requestedAnimation = typeof configuredSpine\.defaultAnimation === "string" \? configuredSpine\.defaultAnimation : ""/);
  assert.match(app, /if \(!names\.includes\(requestedAnimation\)\)/);
  assert.match(app, /Preview blocked\. The selected animation is unavailable; no alternate animation was selected\./);
  assert.match(app, /function clearPlayerAnimation\(/);
  assert.match(app, /animation: ""/);
});

test('upload dispatch does not choose animations[0] and preserves an explicit name verbatim', () => {
  const dispatch = section(upload, 'async function dispatchSpineExportWebm(', 'export function publicLibraryEntry(');
  assert.match(dispatch, /typeof entry\?\.defaultAnimation === 'string' \? entry\.defaultAnimation : ''/);
  assert.match(dispatch, /NO_DEFAULT_SPINE_ANIMATION/);
  assert.doesNotMatch(dispatch, /animations\s*\[\s*0\s*\]/);
});

test('agent uploads preserve the exact requested name and block when none was supplied', () => {
  assert.match(agent, /const preferred = typeof body\.defaultAnimation === 'string' \? body\.defaultAnimation : ''/);
  assert.match(agent, /animations, defaultAnimation: preferred/);
  assert.match(agent, /blocked-no-default-animation/);
  assert.doesNotMatch(agent, /animations\s*\[\s*0\s*\]/);
});

test('data-science and project export metadata never invent a first-track default', () => {
  assert.match(science, /defaultAnimation: typeof entry\?\.defaultAnimation === 'string' \? entry\.defaultAnimation : ''/);
  assert.doesNotMatch(science, /animations\s*\[\s*0\s*\]/);
  assert.match(cloudExport, /defaultAnimation:typeof existing\.defaultAnimation==='string'\?existing\.defaultAnimation:''/);
  assert.doesNotMatch(cloudExport, /animations\s*\[\s*0\s*\]/);
});

test('WebM exporter fails the exact missing animation and never changes animation or skin', () => {
  assert.match(exporter, /NO_DEFAULT_SPINE_ANIMATION/);
  assert.match(exporter, /SELECTED_SPINE_ANIMATION_UNAVAILABLE/);
  assert.match(exporter, /const targetAnimation = requestedAnimation/);
  assert.match(exporter, /window\.__selectedAnimation =/);
  assert.match(exporter, /SELECTED_SPINE_ANIMATION_NOT_ACTIVE/);
  assert.match(exporter, /SELECTED_SPINE_ANIMATION_RENDERED_NO_VISIBLE_CONTENT/);
  assert.match(exporter, /if \(framePeak < FRAME_PEAK_MIN\)/);
  assert.doesNotMatch(exporter, /availableAnimations\s*\[\s*0\s*\]/);
  assert.doesNotMatch(exporter, /scenarioCycle|scenarioEntry|scenarioExit|__spineScenario/);
  assert.match(exporter, /const skinCandidates = Object\.freeze\(\[null\]\)/);
  assert.doesNotMatch(exporter, /skinNames\.filter/);
  assert.doesNotMatch(exporter, /msg\.text\(\)|JSON\.stringify\(\{ \.\.\.meta, ok: true, path:/);
});


test('preview workflow keeps upload identifiers and animation names out of public logs', () => {
  assert.doesNotMatch(exportWorkflow, /echo "Upload ID:|echo "Animation:|Collection folder for \$uploadId|Auto-export media for \$\{uploadId\}|Dispatched spine-export-full for/);
  assert.doesNotMatch(exportWorkflow, /--upload-id="\$\{\{ github\.event\.client_payload\.uploadId \}\}"/);
  assert.doesNotMatch(exportWorkflow, /--animation="\$\{\{ github\.event\.client_payload\.animation \}\}"/);
  assert.match(exportWorkflow, /UPLOAD_ID: \$\{\{ github\.event\.client_payload\.uploadId \}\}/);
  assert.match(exportWorkflow, /ANIMATION: \$\{\{ github\.event\.client_payload\.animation \}\}/);
  assert.match(exportWorkflow, /git commit -m "Auto-export preview media"/);
  assert.match(exportWorkflow, /payload=\$\(jq -n/);
});


test('preview workflow keeps upload identifiers and animation names out of public logs', () => {
  assert.doesNotMatch(exportWorkflow, /echo "Upload ID:|echo "Animation:|Collection folder for \$uploadId|Auto-export media for \$\{uploadId\}|Dispatched spine-export-full for/);
  assert.doesNotMatch(exportWorkflow, /--upload-id="\$\{\{ github\.event\.client_payload\.uploadId \}\}"/);
  assert.doesNotMatch(exportWorkflow, /--animation="\$\{\{ github\.event\.client_payload\.animation \}\}"/);
  assert.match(exportWorkflow, /UPLOAD_ID: \$\{\{ github\.event\.client_payload\.uploadId \}\}/);
  assert.match(exportWorkflow, /ANIMATION: \$\{\{ github\.event\.client_payload\.animation \}\}/);
  assert.match(exportWorkflow, /git commit -m "Auto-export preview media"/);
  assert.match(exportWorkflow, /payload=\$\(jq -n/);
});
