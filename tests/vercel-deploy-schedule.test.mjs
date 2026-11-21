import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/vercel-deploy-and-alias.yml', import.meta.url), 'utf8');

test('automatic Vercel quota recovery is checked hourly without retrying inside the 24-hour hold', () => {
  assert.match(workflow, /schedule:\s*\n\s*- cron:\s*'15 \* \* \* \*'/);
  assert.match(workflow, /age=\$\(\(now - failed_at\)\)/);
  assert.match(workflow, /-lt 86400/);
  assert.match(workflow, /latest_conclusion.*failure/);
  assert.match(workflow, /steps\.quota_recovery\.outputs\.skip != 'true'/);
  assert.match(workflow, /concurrency:[\s\S]*?cancel-in-progress:\s*false/);
});

test('manual deployment remains available while scheduled and CI-triggered retries honor cooldown', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_run'/);
});

test('quota recovery regression is an exact path in both push and pull-request filters', () => {
  const pushPaths = workflow.match(/push:[\\s\\S]*?paths:\\s*\\n([\\s\\S]*?)(?=\\n  pull_request:)/)?.[1] || '';
  const pullRequestPaths = workflow.match(/pull_request:\\s*\\n\\s*paths:\\s*\\n([\\s\\S]*?)(?=\\n  workflow_dispatch:)/)?.[1] || '';
  assert.match(pushPaths, /^\\s*- tests\\/vercel-deploy-schedule\\.test\\.mjs\\s*$/m);
  assert.match(pullRequestPaths, /^\\s*- tests\\/vercel-deploy-schedule\\.test\\.mjs\\s*$/m);
  assert.doesNotMatch(workflow, /tests\\/spine-atlas-integrity\\.test\\.mjs tests\\/vercel-deploy-schedule\\.test\\.mjs/);
});
