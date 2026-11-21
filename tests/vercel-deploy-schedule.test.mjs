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
