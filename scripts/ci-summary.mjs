import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const target = process.env.GITHUB_STEP_SUMMARY;
const label = process.env.CI_REPORT_LABEL || 'Local run';
const url = process.env.REPORT_URL;
const checks = existsSync('reports/checks.json') ? JSON.parse(readFileSync('reports/checks.json', 'utf8')) : null;
const testOutcome = checks?.tests.outcome || process.env.CI_TEST_OUTCOME || 'unknown';
const lines = [
  `### ${label}`, '',
  `Correctness tests: **${testOutcome}**.`, '',
  ...(checks ? Object.entries(checks.benchmarks).map(([name, c]) => `- ${name} benchmark: **${c.outcome}** (exit ${c.exitCode ?? 'none'}${c.signal ? `, signal ${c.signal}` : ''}; ${c.classification || 'unclassified'}).`) : ['Benchmark outcomes were not recorded; inspect the job logs.']), '',
  ...(checks?.advisory.enabled ? [`**Advisory benchmark lane:** ${checks.advisory.reason}`, ''] : ['Both benchmark commands gate this lane; timing ratios have no pass/fail threshold.', '']),
  url ? `[Download test HTML, raw benchmark results and environment](${url})` : 'Report upload did not complete; inspect the job logs.', '',
];
if (target) appendFileSync(target, lines.join('\n'));
