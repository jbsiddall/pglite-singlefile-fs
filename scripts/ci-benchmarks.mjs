import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { classifyBenchmark, historicalReason } from './ci-benchmark-policy.mjs';

const runtime = process.env.BENCH_RUNTIME || 'node';
const version = process.env.BENCH_RUNTIME_VERSION || null;
const advisory = runtime === 'bun' && version === '1.2.23';
const reason = advisory ? historicalReason : null;
const readJson = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
const testResults = readJson('reports/tests/results.json');
const checks = {
  runtime, version, commit: process.env.GITHUB_SHA || null,
  tests: { outcome: process.env.CI_TEST_OUTCOME || 'unknown',
    total: testResults?.numTotalTests ?? null, passed: testResults?.numPassedTests ?? null,
    failed: testResults?.numFailedTests ?? null },
  advisory: { enabled: advisory, reason },
  benchmarks: { vitest: { outcome: 'not_started' }, sampled: { outcome: 'not_started' } },
};
mkdirSync('reports', { recursive: true });
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function save() {
  writeFileSync('reports/checks.json.tmp', JSON.stringify(checks, null, 2) + '\n');
  renameSync('reports/checks.json.tmp', 'reports/checks.json');
  const rows = Object.entries(checks.benchmarks).map(([name, c]) => `<tr><td>${escape(name)}</td><td>${escape(c.outcome)}</td><td>${escape(c.exitCode)}</td><td>${escape(c.signal)}</td><td>${escape(c.classification)}</td></tr>`).join('');
  writeFileSync('reports/checks.html', `<!doctype html><html lang="en"><meta charset="utf-8"><title>CI check outcomes</title><style>body{font:16px system-ui;max-width:900px;margin:3rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}td,th{padding:.6rem;border:1px solid #aaa;text-align:left}</style><h1>CI check outcomes</h1><p>${escape(runtime)} ${escape(version)} · commit ${escape(checks.commit)}</p><p>Correctness tests: <strong>${escape(checks.tests.outcome)}</strong>; ${escape(checks.tests.passed)} passed, ${escape(checks.tests.failed)} failed.</p><p>${advisory ? escape(reason) : 'Both benchmark commands are mandatory. Timing ratios have no pass/fail threshold.'}</p><table><thead><tr><th>Benchmark</th><th>Outcome</th><th>Exit code</th><th>Signal</th><th>Classification</th></tr></thead><tbody>${rows}</tbody></table><p>Download contains separate Vitest HTML, raw measurements and any partial progress or failures. Failed attempts are never labelled passed.</p></html>`);
}
save();
for (const [name, script] of [['vitest', 'bench'], ['sampled', 'bench:sample']]) {
  checks.benchmarks[name] = { outcome: 'running', startedAt: new Date().toISOString() };
  save();
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: process.env, timeout: 600_000, maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = result.stdout || '', stderr = result.stderr || '';
  process.stdout.write(stdout); process.stderr.write(stderr);
  writeFileSync(`reports/benchmark-${name}.log`, stdout + '\n' + stderr);
  const classification = classifyBenchmark({ runtime, version, status: result.status, signal: result.signal, error: result.error?.message, output: stdout + '\n' + stderr });
  checks.benchmarks[name] = {
    ...checks.benchmarks[name], classification, outcome: result.status === 0 && !result.error ? 'success' : 'failure',
    exitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
    completedAt: new Date().toISOString(),
  };
  save();
}
console.log(JSON.stringify(checks, null, 2));
// Real subprocess failures stay in the manifest. Only the exact engine signature is advisory.
if (Object.values(checks.benchmarks).some(c => c.classification === 'fatal_failure')) process.exitCode = 1;
