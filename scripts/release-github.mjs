import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

// GitHub releases only: no package publication, credentials or PR code execution.
const repository = process.env.GITHUB_REPOSITORY;
const sha = process.env.GITHUB_SHA;
const token = process.env.GH_TOKEN;
const apiRoot = process.env.GITHUB_API_URL || 'https://api.github.com';
if (!repository?.match(/^[\w.-]+\/[\w.-]+$/) || !sha?.match(/^[a-f0-9]{40}$/) || !token) {
  throw new Error('Missing release environment');
}
if (process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_EVENT_NAME !== 'push') {
  throw new Error('Releases are allowed only from successful main push workflows');
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git('rev-parse', 'HEAD') !== sha) throw new Error('Checkout does not match the tested commit');
git('fetch', '--tags', 'origin');
const parse = tag => tag.slice(1).split('.').map(Number);
const compare = (a, b) => {
  const av = parse(a), bv = parse(b);
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] - bv[i];
  return 0;
};
const ancestor = (a, b) => {
  try { execFileSync('git', ['merge-base', '--is-ancestor', a, b]); return true; }
  catch (error) { if (error.status === 1) return false; throw error; }
};
const tags = git('tag', '--list').split('\n').filter(t => /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(t)).sort(compare);
const newest = tags.at(-1);
if (newest && git('rev-list', '-n', '1', newest) !== sha && ancestor(sha, newest)) {
  console.log('A newer tested commit has already been released; skipping stale run.');
  process.exit(0);
}
if (newest && !ancestor(newest, sha)) throw new Error('Latest release is not an ancestor of this commit');
const existing = tags.find(t => git('rev-list', '-n', '1', t) === sha);
const previous = existing ? tags.filter(t => compare(t, existing) < 0).at(-1) : newest;
const range = previous ? `${previous}..${sha}` : sha;
const commits = git('log', '--format=%B%x00', range).split('\0').map(s => s.trim()).filter(Boolean);
let bump = 'patch';
if (commits.some(c => /^[a-z][\w-]*(?:\([^\r\n]*\))?!:/mi.test(c) || /^BREAKING[ -]CHANGE:/m.test(c))) bump = 'major';
else if (commits.some(c => /^feat(?:\([^\r\n]*\))?:/m.test(c))) bump = 'minor';
let version;
if (existing) version = existing;
else if (!previous) version = 'v0.1.0';
else {
  let [major, minor, patch] = parse(previous);
  if (bump === 'major') { major++; minor = 0; patch = 0; }
  else if (bump === 'minor') { minor++; patch = 0; }
  else patch++;
  version = `v${major}.${minor}.${patch}`;
}

const reportRoot = resolve('release-reports');
const reports = readdirSync(reportRoot, { withFileTypes: true })
  .filter(e => e.isDirectory() && /^reports-(node|deno|bun)-[\d.]+-(ubuntu-24\.04(?:-arm)?|macos-14)$/.test(e.name));
if (!reports.length) throw new Error('No CI reports to attach');
for (const report of reports) {
  const environmentFile = join(reportRoot, report.name, 'environment.json');
  if (!existsSync(environmentFile)) throw new Error(`Missing environment for ${report.name}`);
  if (JSON.parse(readFileSync(environmentFile, 'utf8')).commit !== sha) throw new Error('Report commit mismatch');
}
if (process.env.RELEASE_DRY_RUN === '1') {
  console.log(JSON.stringify({ version, bump, commit: sha, reportCount: reports.length }));
  process.exit(0);
}
const assetsDir = resolve('release-assets');
mkdirSync(assetsDir, { recursive: true });
for (const report of reports) {
  execFileSync('zip', ['-q', '-r', join(assetsDir, `${report.name}.zip`), '.'], { cwd: join(reportRoot, report.name) });
}
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' };
async function api(path, options = {}, allow404 = false) {
  const response = await fetch(`${apiRoot}/repos/${repository}${path}`, { ...options, headers: { ...headers, ...options.headers } });
  if (allow404 && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub ${options.method || 'GET'} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}
if (!existing) {
  const annotated = await api('/git/tags', { method: 'POST', body: JSON.stringify({
    tag: version, message: `${version}: CI-verified release`, object: sha, type: 'commit'
  }) });
  await api('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/tags/${version}`, sha: annotated.sha }) });
}
const runUrl = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const notes = `All runtime/platform test and benchmark jobs passed for commit \`${sha}\`.\n\n[Exact CI run](${runUrl}). Attached ZIPs contain test HTML, raw benchmark results, benchmark HTML and environment metadata. Download and open HTML locally.\n\nBenchmarks are observations on hosted runners; timings are not guarantees or release pass/fail thresholds.\n\n${commits.map(c => '- ' + c.split('\n')[0].replace(/[<>]/g, '')).join('\n')}`;
let release = await api(`/releases/tags/${version}`, {}, true);
if (!release) release = await api('/releases', { method: 'POST', body: JSON.stringify({
  tag_name: version, target_commitish: sha, name: version, body: notes,
  draft: true, prerelease: false
}) });
const uploaded = await api(`/releases/${release.id}/assets`);
for (const file of readdirSync(assetsDir).filter(name => name.endsWith('.zip'))) {
  if (uploaded.some(asset => asset.name === file)) continue;
  const url = `${release.upload_url.split('{')[0]}?name=${encodeURIComponent(file)}`;
  const response = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/zip' }, body: readFileSync(join(assetsDir, file)) });
  if (!response.ok) throw new Error(`Uploading ${file}: ${response.status} ${await response.text()}`);
}
if (release.draft) release = await api(`/releases/${release.id}`, {
  method: 'PATCH', body: JSON.stringify({ draft: false })
});
console.log(`Released ${release.html_url}`);
