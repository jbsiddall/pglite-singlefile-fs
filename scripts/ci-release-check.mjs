import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const releaseScript = new URL('./release-github.mjs', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'pglite-semver-'));
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  git('init', '-b', 'main');
  git('config', 'user.name', 'Release script test');
  git('config', 'user.email', 'test@example.invalid');
  git('remote', 'add', 'origin', dir);
  const report = join(dir, 'release-reports', 'reports-node-24.21.0-ubuntu-24.04');
  mkdirSync(report, { recursive: true });
  for (const [message, expected] of [
    ['feat: initial library', 'v0.1.0'],
    ['fix: preserve bytes', 'v0.1.1'],
    ['feat: additive option', 'v0.2.0'],
    ['feat!: deliberate API change', 'v1.0.0'],
    ['docs: clarify usage', 'v1.0.1'],
  ]) {
    git('commit', '--allow-empty', '-m', message);
    const sha = git('rev-parse', 'HEAD');
    writeFileSync(join(report, 'environment.json'), JSON.stringify({ commit: sha, runtime: 'node', version: 'v24.21.0' }));
    writeFileSync(join(report, 'checks.json'), JSON.stringify({ commit: sha, runtime: 'node', version: '24.21.0',
      tests: { outcome: 'success', total: 1, passed: 1, failed: 0 }, advisory: { enabled: false },
      benchmarks: Object.fromEntries(['vitest', 'sampled'].map(phase => [phase, { outcome: 'success', exitCode: 0, signal: null, error: null, classification: 'success' }])) }));
    for (const phase of ['vitest', 'sampled']) writeFileSync(join(report, `benchmark-${phase}.log`), '');
    const output = execFileSync(process.execPath, [releaseScript], {
      cwd: dir, encoding: 'utf8', env: { ...process.env,
        GITHUB_REPOSITORY: 'test/example', GITHUB_SHA: sha,
        GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push',
        GH_TOKEN: 'dry-run-never-sent', RELEASE_DRY_RUN: '1',
      }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(JSON.parse(output.trim()).version, expected);
    git('tag', expected);
  }
  console.log('Release version checks passed: first release, patch, minor and breaking major.');
} finally { rmSync(dir, { recursive: true, force: true }); }
