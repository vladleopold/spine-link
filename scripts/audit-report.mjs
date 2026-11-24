import { spawnSync } from 'node:child_process';

const result = spawnSync('npm', ['audit', '--json'], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
});

let report;
try {
  report = JSON.parse(result.stdout || '');
} catch {
  console.error('NPM_AUDIT_REPORT_UNAVAILABLE');
  if (result.stderr) console.error(result.stderr.slice(-4000));
  process.exit(0);
}

const counts = report.metadata?.vulnerabilities || {};
console.log('NPM_AUDIT_COUNTS ' + JSON.stringify(counts));
for (const [name, item] of Object.entries(report.vulnerabilities || {})) {
  const via = (item.via || []).map(v => typeof v === 'string' ? v : `${v.name}: ${v.title} [${v.range}]`);
  console.log('NPM_AUDIT_PACKAGE ' + JSON.stringify({
    name,
    severity: item.severity,
    isDirect: item.isDirect,
    range: item.range,
    fixAvailable: item.fixAvailable,
    via,
  }));
}
console.log('NPM_AUDIT_EXIT_CODE ' + result.status);
