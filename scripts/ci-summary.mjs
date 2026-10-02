import { appendFileSync } from 'node:fs';

const target = process.env.GITHUB_STEP_SUMMARY;
const label = process.env.CI_REPORT_LABEL || 'Local run';
const url = process.env.REPORT_URL;
if (target) appendFileSync(target, `### ${label}\n\n${url ? `[Download test HTML, raw benchmark results and environment](${url})` : 'Report upload did not complete; inspect the job logs.'}\n\nBenchmark timings are not pass/fail thresholds. Tests and benchmark correctness checks must pass.\n`);
