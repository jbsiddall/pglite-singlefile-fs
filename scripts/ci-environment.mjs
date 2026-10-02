import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const runtime = process.env.TEST_RUNTIME || 'node';
if (!['node', 'deno', 'bun'].includes(runtime)) throw new Error('Unknown runtime');
if (process.env.EXPECTED_ARCH && process.arch !== process.env.EXPECTED_ARCH) {
  throw new Error(`Expected ${process.env.EXPECTED_ARCH}, got ${process.arch}`);
}
const version = execFileSync(runtime, ['--version'], { encoding: 'utf8' }).trim();
const expected = process.env.TEST_RUNTIME_VERSION;
if (expected && !version.split(/\s+/).some(part => part.replace(/^v/, '') === expected)) {
  throw new Error(`Expected ${runtime} ${expected}, got ${version}`);
}
const environment = {
  runtime, version, coordinator: process.version, platform: process.platform,
  architecture: process.arch, osRelease: os.release(), cpus: os.cpus().length,
  runtimeFlags: process.env.JSC_useWasmOSR === undefined ? {} : { JSC_useWasmOSR: process.env.JSC_useWasmOSR },
  cpuModel: os.cpus()[0]?.model, totalMemoryBytes: os.totalmem(),
  commit: process.env.GITHUB_SHA || null, runId: process.env.GITHUB_RUN_ID || null,
  note: 'Hosted-runner timings are observations, not controlled hardware comparisons.',
};
mkdirSync('reports', { recursive: true });
writeFileSync('reports/environment.json', JSON.stringify(environment, null, 2) + '\n');
console.log(JSON.stringify(environment, null, 2));
