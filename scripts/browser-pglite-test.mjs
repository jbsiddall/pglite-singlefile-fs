import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.json': 'application/json',
};

const workerScript = `
import { PGlite } from '/node_modules/@electric-sql/pglite/dist/index.js';
import { OpfsAhpFS } from '/node_modules/@electric-sql/pglite/dist/fs/opfs-ahp.js';
import { SingleFileFS } from '/src/browser.mjs';

async function measureOpfsUsage(dirHandle) {
  let files = 0;
  let bytes = 0;
  for await (const [, handle] of dirHandle.entries()) {
    if (handle.kind === 'file') {
      files++;
      const f = await handle.getFile();
      bytes += f.size;
    } else if (handle.kind === 'directory') {
      const sub = await measureOpfsUsage(handle);
      files += sub.files;
      bytes += sub.bytes;
    }
  }
  return { files, bytes };
}

async function runBench(label, setupFn, cleanupFn) {
  const tInit = performance.now();
  const { db, settle, statsEntry } = await setupFn();
  const initMs = Number((performance.now() - tInit).toFixed(1));
  const rows = 2000;
  const freq = 100;
  await db.exec('CREATE TABLE orders(id BIGSERIAL PRIMARY KEY, product TEXT NOT NULL, amount INTEGER NOT NULL)');
  await db.query("INSERT INTO orders(product,amount) SELECT 'product-'||(g%100),g%1000 FROM generate_series(1,$1::int)g", [rows]);
  await db.exec('CHECKPOINT');
  await settle();
  await db.query('SELECT count(*)::int AS n FROM orders');
  await db.query('SELECT amount FROM orders WHERE id=$1', [1]);
  await settle();

  const timings = { initMs };
  const measure = async (name, fn) => {
    const t0 = performance.now();
    await fn();
    await settle();
    timings[name] = Number((performance.now() - t0).toFixed(1));
  };

  await measure('batchRead', () => db.query('SELECT id,product,amount FROM orders ORDER BY id'));
  await measure('batchInsert', () => db.query("INSERT INTO orders(product,amount) SELECT 'batch',g%1000 FROM generate_series(1,$1::int)g", [rows]));
  await measure('batchUpdate', () => db.query('UPDATE orders SET amount=amount+1 WHERE id<=$1', [rows]));
  await measure('frequentRead', async () => { for (let i = 1; i <= freq; i++) await db.query('SELECT amount FROM orders WHERE id=$1', [i]); });
  await measure('frequentInsert', async () => { for (let i = 0; i < freq; i++) await db.query("INSERT INTO orders(product,amount) VALUES('single',$1)", [i]); });
  await measure('frequentUpdate', async () => { for (let i = 1; i <= freq; i++) await db.query('UPDATE orders SET amount=amount+1 WHERE id=$1', [i]); });

  const count = (await db.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
  await db.close();

  const root = await navigator.storage.getDirectory();
  let opfsFiles = 0;
  let opfsBytes = 0;
  if (statsEntry.kind === 'file') {
    const fh = await root.getFileHandle(statsEntry.name);
    opfsFiles = 1;
    opfsBytes = (await fh.getFile()).size;
  } else {
    const dh = await root.getDirectoryHandle(statsEntry.name);
    const u = await measureOpfsUsage(dh);
    opfsFiles = u.files;
    opfsBytes = u.bytes;
  }

  await cleanupFn(root).catch(() => {});
  return {
    variant: label,
    ...timings,
    opfsFiles,
    sizeMB: Number((opfsBytes / 1e6).toFixed(2)),
    count,
  };
}

async function phase1() {
  // 1. Persistence + transaction + rollback test on single-file OPFS redb
  const sfs = await SingleFileFS.open('pgvault.pglite');
  const db = await PGlite.create({ fs: sfs });
  await db.exec('CREATE TABLE notes(id INT PRIMARY KEY, body TEXT NOT NULL)');
  await db.query("INSERT INTO notes VALUES (1, 'hello-browser-opfs')");
  try {
    await db.transaction(async tx => {
      await tx.query("INSERT INTO notes VALUES (2, 'rolled-back')");
      throw new Error('rollback');
    });
  } catch {}
  const rows = (await db.query('SELECT * FROM notes ORDER BY id')).rows;
  const integrity = sfs.checkIntegrity();
  await db.close();

  const root = await navigator.storage.getDirectory();
  const entries = [];
  for await (const [name, handle] of root.entries()) {
    entries.push({ name, kind: handle.kind });
  }

  // 2. Comprehensive Browser OPFS Benchmark: PGlite OpfsAhpFS vs SingleFileFS (redb-js)
  const benchRows = [];

  benchRows.push(await runBench(
    'OpfsAhpFS (strict)',
    async () => {
      const ahp = new OpfsAhpFS('bench-ahp-strict');
      const bDb = await PGlite.create({ fs: ahp, relaxedDurability: false });
      return { db: bDb, settle: () => Promise.resolve(), statsEntry: { name: 'bench-ahp-strict', kind: 'directory' } };
    },
    r => r.removeEntry('bench-ahp-strict', { recursive: true })
  ));

  benchRows.push(await runBench(
    'OpfsAhpFS (relaxed)',
    async () => {
      const ahp = new OpfsAhpFS('bench-ahp-rel');
      const bDb = await PGlite.create({ fs: ahp, relaxedDurability: true });
      return { db: bDb, settle: () => Promise.resolve(), statsEntry: { name: 'bench-ahp-rel', kind: 'directory' } };
    },
    r => r.removeEntry('bench-ahp-rel', { recursive: true })
  ));

  for (const [label, opts, relaxed] of [
    ['SingleFileFS sparse (strict)', { compression: 'sparse', durable: true }, false],
    ['SingleFileFS sparse (relaxed)', { compression: 'sparse', durable: true }, true],
    ['SingleFileFS sparse (no-flush)', { compression: 'sparse', durable: false }, false],
    ['SingleFileFS lz4 (relaxed)', { compression: 'lz4', durable: true }, true],
  ]) {
    const fname = 'bench-' + label.replace(/[^a-z0-9]+/gi, '-') + '.pglite';
    benchRows.push(await runBench(
      label,
      async () => {
        const bFs = await SingleFileFS.open(fname, opts);
        const bDb = await PGlite.create({ fs: bFs, relaxedDurability: relaxed });
        return { db: bDb, settle: () => bFs.flush(), statsEntry: { name: fname, kind: 'file' } };
      },
      r => r.removeEntry(fname)
    ));
  }

  return { rows, integrity, opfsEntries: entries, benchRows };
}

async function phase2() {
  const sfs = await SingleFileFS.open('pgvault.pglite');
  const db = await PGlite.create({ fs: sfs });
  const before = (await db.query('SELECT * FROM notes ORDER BY id')).rows;
  await db.query("INSERT INTO notes VALUES (3, 'after-chrome-restart')");
  const after = (await db.query('SELECT * FROM notes ORDER BY id')).rows;
  const integrity = sfs.checkIntegrity();
  await db.close();

  // Keep Phase 2 OPFS verification scoped to pgvault.pglite (ignore any unclosed OpfsAhpFS temp dir)
  const root = await navigator.storage.getDirectory();
  const entries = [];
  for await (const [name, handle] of root.entries()) {
    if (!name.startsWith('bench-')) entries.push({ name, kind: handle.kind });
  }
  return { before, after, integrity, opfsEntries: entries };
}

self.onmessage = async (ev) => {
  try {
    const data = ev.data.phase === 1 ? await phase1() : await phase2();
    self.postMessage({ ok: true, data });
  } catch (err) {
    self.postMessage({ ok: false, error: err?.stack || String(err) });
  }
};
`;

const makeHtml = phase => `<!doctype html>
<meta charset="utf-8" />
<script type="module">
const w = new Worker('/__worker.mjs', { type: 'module' });
w.onmessage = (ev) => fetch('/__report', { method: 'POST', body: JSON.stringify(ev.data) });
w.onerror = (err) => fetch('/__report', { method: 'POST', body: JSON.stringify({ ok: false, error: err.message || String(err) }) });
w.postMessage({ phase: ${phase} });
</script>`;

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('Could not find Chrome/Chromium binary (set CHROME_BIN)');
}

async function runChromePhase(chromeBin, profileDir, url, waitForReport) {
  const proc = spawn(
    chromeBin,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profileDir}`,
      url,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stderr = '';
  proc.stderr.on('data', d => (stderr += d.toString()));
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Browser test timed out on ${url}\n${stderr}`)), 90_000);
  });
  try {
    return await Promise.race([waitForReport, timeout]);
  } finally {
    clearTimeout(timer);
    proc.kill('SIGTERM');
    await new Promise(r => proc.once('exit', r));
  }
}

function rewriteBareImports(source) {
  return source
    .replaceAll("from '@electric-sql/pglite/basefs'", "from '/node_modules/@electric-sql/pglite/dist/fs/base.js'")
    .replaceAll('from "@electric-sql/pglite/basefs"', 'from "/node_modules/@electric-sql/pglite/dist/fs/base.js"')
    .replaceAll("from 'redb-js'", "from '/node_modules/redb-js/src/index.js'")
    .replaceAll('from "redb-js"', 'from "/node_modules/redb-js/src/index.js"');
}

async function main() {
  const chromeBin = findChrome();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-redb-chrome-'));
  let resolveReport = null;
  const resetReport = () => new Promise(res => { resolveReport = res; });

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, 'http://127.0.0.1');
    if (reqUrl.pathname === '/__phase1.html') {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(makeHtml(1));
      return;
    }
    if (reqUrl.pathname === '/__phase2.html') {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(makeHtml(2));
      return;
    }
    if (reqUrl.pathname === '/__worker.mjs') {
      res.writeHead(200, { 'content-type': MIME['.mjs'] });
      res.end(workerScript);
      return;
    }
    if (reqUrl.pathname === '/__report' && req.method === 'POST') {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        if (resolveReport) resolveReport(JSON.parse(body));
      });
      return;
    }

    const safePath = path.normalize(reqUrl.pathname).replace(/^(\.\.[/\\])+/, '');
    const absPath = path.resolve(repoRoot, safePath.replace(/^[/\\]+/, ''));
    if (!absPath.startsWith(repoRoot) || !fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(absPath);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    if (ext === '.mjs') {
      res.end(rewriteBareImports(fs.readFileSync(absPath, 'utf8')));
    } else {
      fs.createReadStream(absPath).pipe(res);
    }
  });

  await new Promise(res => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    console.log('Phase 1: Running PGlite on Browser OPFS (redb-js SingleFileFS) + full OpfsAhpFS benchmark...');
    const p1 = await runChromePhase(chromeBin, profileDir, `${baseUrl}/__phase1.html`, resetReport());
    assert.equal(p1.ok, true, p1.error);
    assert.deepEqual(p1.data.rows, [{ id: 1, body: 'hello-browser-opfs' }]);
    assert.equal(p1.data.integrity, true);
    assert.deepEqual(p1.data.opfsEntries, [{ name: 'pgvault.pglite', kind: 'file' }]);
    console.log('  Phase 1 OK. OPFS entries:', p1.data.opfsEntries);
    console.log('  Browser OPFS Benchmark (2000 batch / 100 frequent):');
    console.table(p1.data.benchRows.map(({ count, ...rest }) => rest));

    console.log('Phase 2: Restarting Chrome and verifying durable single-file PGlite OPFS persistence...');
    const p2 = await runChromePhase(chromeBin, profileDir, `${baseUrl}/__phase2.html`, resetReport());
    assert.equal(p2.ok, true, p2.error);
    assert.deepEqual(p2.data.before, [{ id: 1, body: 'hello-browser-opfs' }]);
    assert.deepEqual(p2.data.after, [
      { id: 1, body: 'hello-browser-opfs' },
      { id: 3, body: 'after-chrome-restart' },
    ]);
    assert.equal(p2.data.integrity, true);
    assert.deepEqual(p2.data.opfsEntries, [{ name: 'pgvault.pglite', kind: 'file' }]);
    console.log('  Phase 2 OK. OPFS entries:', p2.data.opfsEntries);
    console.log('PASS: Browser OPFS PGlite single-file persistence & benchmark verified!');
  } finally {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
