import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, basename } from 'node:path';
import { setImmediate } from 'node:timers';
import { PGlite } from '@electric-sql/pglite';
import { ERRNO_CODES } from '@electric-sql/pglite/basefs';
import { openNodeSync } from 'redb-js/node';
import { SingleFileFS, checkpoint } from '../src/index.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stage = (name, detail = {}) => console.log(JSON.stringify({ stage: name, ...detail }));
const immediate = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const idle = async fs => { for (let i = 0; i < 3; i++) { await immediate(); await fs.flush(); } };
const integrity = fs => assert.equal(fs.checkIntegrity(), true);
const paths = ['/case/a', '/case/b', '/case/c'];
const exists = (fs, path) => { try { fs.lstat(path); return true; } catch (error) { if (error.code === ERRNO_CODES.ENOENT) return false; throw error; } };

async function propertyTrace(input, image) {
  let fs = new SingleFileFS(image, { cacheBytes: 0 });
  fs.mkdir('/case');
  const reads = [];
  try {
    for (const op of input.operations) {
      const path = paths[op.file];
      if (op.kind === 'write') {
        if (!exists(fs, path)) fs.writeFile(path, new Uint8Array());
        const source = new Uint8Array(op.offset + op.length + 7).fill(0x7d);
        for (let i = 0; i < op.length; i++) source[op.offset + i] = (op.byte + i * op.salt) & 255;
        const fd = fs.open(path);
        const data = op.arrayBuffer ? source.buffer : op.signedView ? new Int8Array(source.buffer) : source;
        assert.equal(fs.write(fd, data, op.offset, op.length, op.position), op.length);
        fs.close(fd);
      } else if (op.kind === 'truncate') {
        if (!exists(fs, path)) fs.writeFile(path, new Uint8Array());
        fs.truncate(path, op.length);
      } else if (op.kind === 'rename') {
        if (exists(fs, path)) fs.rename(path, paths[op.target]);
      } else if (op.kind === 'delete') {
        if (exists(fs, path)) fs.unlink(path);
      } else if (op.kind === 'read') {
        if (exists(fs, path)) {
          const fd = fs.open(path), out = new Uint8Array(op.length + 6).fill(0xa5);
          const target = op.signedView ? new Int8Array(out.buffer) : out;
          const count = fs.read(fd, target, 3, op.length, op.position);
          assert.ok(out.subarray(0, 3).every(x => x === 0xa5));
          assert.ok(out.subarray(3 + count).every(x => x === 0xa5));
          reads.push({ count, hash: hash(out.subarray(3, 3 + count)) });
          fs.close(fd);
        } else reads.push(null);
      } else if (op.kind === 'reopen') {
        await fs.closeFs(); fs = new SingleFileFS(image, { cacheBytes: 0 });
      } else if (op.kind === 'sync') await fs.syncToFs(false);
      else throw new Error('Unknown trace operation');
    }
    await fs.closeFs(); fs = new SingleFileFS(image, { cacheBytes: 0 });
    const files = {};
    for (const path of paths) if (exists(fs, path)) {
      const size = fs.lstat(path).size, out = new Uint8Array(size), fd = fs.open(path);
      assert.equal(fs.read(fd, out, 0, size, 0), size); fs.close(fd);
      files[path] = { size, hash: hash(out) };
    }
    integrity(fs); return { reads, files };
  } finally { await fs.closeFs(); }
}

async function lifecycle(input, image) {
  for (const relaxedDurability of [false, true]) {
    const filename = image + '-' + relaxedDurability;
    for (let cycle = 0; cycle < input.cycles; cycle++) {
      const fs = new SingleFileFS(filename), db = await PGlite.create({ fs, relaxedDurability });
      try {
        await db.exec('CREATE TABLE IF NOT EXISTS entries(id INT PRIMARY KEY, value TEXT NOT NULL)');
        assert.equal((await db.query('SELECT count(*)::int AS n FROM entries')).rows[0].n, cycle * 2);
        await db.query('INSERT INTO entries VALUES ($1,$2)', [cycle * 2, 'individual-' + cycle]);
        await db.transaction(async tx => { await tx.query('INSERT INTO entries VALUES ($1,$2)', [cycle * 2 + 1, 'transaction-' + cycle]); });
        await assert.rejects(db.transaction(async tx => {
          await tx.query('INSERT INTO entries VALUES ($1,$2)', [10000 + cycle, 'rolled back']);
          throw new Error('intentional rollback');
        }), /intentional rollback/);
        assert.equal((await db.query('SELECT count(*)::int AS n FROM entries')).rows[0].n, (cycle + 1) * 2);
        await db.query('UPDATE entries SET value=$1 WHERE id=$2', ['updated-' + cycle, cycle * 2]);
        assert.equal((await db.query('SELECT value FROM entries WHERE id=$1', [cycle * 2])).rows[0].value, 'updated-' + cycle);
      } finally { await db.close(); }
      const verify = new SingleFileFS(filename); integrity(verify); await verify.closeFs();
      stage('lifecycle-cycle', { relaxedDurability, cycle: cycle + 1 });
    }
  }
  return { cyclesPerMode: input.cycles };
}

class GateFS extends SingleFileFS {
  arm() { this.gate = { called: deferred(), release: deferred() }; return this.gate; }
  syncToFs(relaxed) {
    if (this.gate && !relaxed) {
      const gate = this.gate; this.gate = null; gate.called.resolve(false);
      return gate.release.promise.then(() => super.syncToFs(false));
    }
    return super.syncToFs(relaxed);
  }
  waitForFlush() {
    if (this.gate) { const gate = this.gate; this.gate = null; gate.called.resolve(true); return gate.release.promise; }
    return super.waitForFlush();
  }
  commitChanges() { if (this.failFlush) throw new Error('Injected flush failure'); return super.commitChanges(); }
}

async function durability(input, image) {
  for (const durable of [true, false]) for (const relaxed of [false, true]) {
    const filename = image + '-' + durable + '-' + relaxed;
    const fs = new GateFS(filename, { durable });
    const db = await PGlite.create({ fs, relaxedDurability: relaxed });
    await db.exec('CREATE TABLE durable(id INT PRIMARY KEY)'); await idle(fs);
    assert.equal(fs.durable, durable);
    fs.resetCounters(); const gate = fs.arm(); let queryDone = false;
    const query = db.query('INSERT INTO durable VALUES (1)').then(() => { queryDone = true; });
    assert.equal(await gate.called.promise, relaxed); await immediate();
    assert.equal(queryDone, relaxed, 'strict queries wait; relaxed queries may return before flush');
    assert.equal(fs.counters.commits, 0, 'gated flush must not commit early');
    if (!relaxed) { gate.release.resolve(); await query; assert.ok(fs.counters.commits > 0); await db.close(); }
    else {
      await query; let closeDone = false;
      const closing = db.close().then(() => { closeDone = true; });
      await immediate(); assert.equal(closeDone, false, 'close drains pending relaxed persistence');
      gate.release.resolve(); await closing;
    }
    const reopenedFs = new SingleFileFS(filename, { durable });
    const reopened = await PGlite.create({ fs: reopenedFs, relaxedDurability: relaxed });
    assert.deepEqual((await reopened.query('SELECT * FROM durable')).rows, [{ id: 1 }]);
    await reopened.close(); stage('durability-mode', { durable, relaxed });
  }
  const fs = new GateFS(image + '-failure'), db = await PGlite.create({ fs, relaxedDurability: true });
  await db.exec('CREATE TABLE fail_test(id INT)'); await idle(fs);
  fs.failFlush = true; await db.query('INSERT INTO fail_test VALUES(1)');
  await assert.rejects(fs.flush(), /Injected flush failure/);
  assert.throws(() => fs.lstat('/'), /Injected flush failure/);
  await assert.rejects(db.close(), /Injected flush failure/);
  assert.equal(fs.closed, true);
  return { modes: 4, backgroundFailureObserved: true };
}

async function walCheckpoint(input, image) {
  const fs = new SingleFileFS(image);
  const db = await PGlite.create({ fs });
  try {
    await db.exec('CREATE TABLE checkpoint_rows(id INT PRIMARY KEY, payload TEXT NOT NULL)');
    const before = (await db.query('SELECT checkpoint_lsn::text AS lsn FROM pg_control_checkpoint()')).rows[0].lsn;
    await db.exec("INSERT INTO checkpoint_rows SELECT i, repeat('payload-' || i::text,100) FROM generate_series(1,3000) i");
    await fs.flush();
    // Strictly one single file even while open — zero WAL/SHM sidecar files.
    assert.deepEqual(readdirSync(dirname(image)), [basename(image)], 'redb container must stay strictly one single file');
    const result = await checkpoint(db, fs, { mode: 'TRUNCATE' });
    assert.equal(result.busy, 0, 'maintenance must not report a blocked checkpoint');
    assert.deepEqual(readdirSync(dirname(image)), [basename(image)], 'still strictly one single file after checkpoint');
    const after = (await db.query('SELECT checkpoint_lsn::text AS lsn FROM pg_control_checkpoint()')).rows[0].lsn;
    assert.notEqual(after, before, 'real PostgreSQL checkpoint advances checkpoint_lsn');
    integrity(fs); stage('coordinated-checkpoint', { before, after, container: result });
  } finally { await db.close(); }
  const reopenedFs = new SingleFileFS(image), reopened = await PGlite.create({ fs: reopenedFs });
  try {
    assert.equal((await reopened.query('SELECT count(*)::int AS n FROM checkpoint_rows')).rows[0].n, 3000);
    await reopened.query("INSERT INTO checkpoint_rows VALUES (3001,'still writable')");
    assert.equal((await reopened.query('SELECT count(*)::int AS n FROM checkpoint_rows')).rows[0].n, 3001);
  } finally { await reopened.close(); }
  return { rowsBeforeReopen: 3000, rowsAfterInsert: 3001 };
}

async function safety(input, image) {
  for (const options of [{ durable: 'yes' }, { pageSize: 123 }, { redbCacheBytes: -1 }, { storage: 'invalid' }, { cacheBytes: -1 }]) {
    assert.throws(() => new SingleFileFS(image + '-invalid', options));
  }
  const fs = new SingleFileFS(image); fs.mkdir('/nested'); fs.writeFile('/nested/file', new Uint8Array([1, 2, 3]));
  const fd = fs.open('/nested/file'); fs.rename('/nested/file', '/nested/moved');
  assert.equal(fs.fstat(fd).size, 3, 'open descriptors retain inode across rename');
  assert.throws(() => fs.rmdir('/nested'), 'cannot remove nonempty directory');
  fs.close(fd); assert.throws(() => fs.fstat(fd), 'closed descriptor is invalid');
  const readOnly = fs.open('/nested/moved', 'r');
  assert.throws(() => fs.write(readOnly, new Uint8Array([9]), 0, 1, 0)); fs.close(readOnly);
  const append = fs.open('/nested/moved', 'a+');
  fs.write(append, new Uint8Array([4, 5]), 0, 2, 0);
  const appended = new Uint8Array(5); assert.equal(fs.read(append, appended, 0, 5, 0), 5);
  assert.deepEqual([...appended], [1, 2, 3, 4, 5], 'append ignores supplied file position');
  fs.unlink('/nested/moved'); assert.throws(() => fs.lstat('/nested/moved'));
  const retained = new Uint8Array(5); assert.equal(fs.read(append, retained, 0, 5, 0), 5);
  assert.deepEqual(retained, appended, 'unlink retains bytes through open descriptor');
  assert.equal(fs.fstat(append).nlink, 0);
  fs.write(append, new Uint8Array([6]), 0, 1, 0);
  assert.equal(fs.fstat(append).size, 6, 'unlinked open descriptor remains writable');
  fs.writeFile('/nested/moved', new Uint8Array([8, 9])); fs.close(append);
  await fs.closeFs();
  const recovery = new SingleFileFS(image), recreated = recovery.open('/nested/moved');
  const replacement = new Uint8Array(2); assert.equal(recovery.read(recreated, replacement, 0, 2, 0), 2);
  assert.deepEqual([...replacement], [8, 9], 'same-name replacement survives orphan cleanup and reopen');
  recovery.close(recreated); await recovery.closeFs();
  await assert.rejects(fs.checkpointWal('INVALID')); await fs.closeFs();
  assert.throws(() => fs.lstat('/'), /closed/); await fs.closeFs();
  return { invalidOptionsRejected: true, renameDescriptorPreserved: true };
}

async function identity(input, image) {
  // 1. Foreign non-redb binary file (e.g. a SQLite header) must remain byte-for-byte unchanged.
  const foreignBinary = image + '-foreign-sqlite';
  writeFileSync(foreignBinary, Buffer.from('SQLite format 3\0important-user-data-do-not-touch'));
  const origBinHash = hash(readFileSync(foreignBinary));
  assert.throws(() => new SingleFileFS(foreignBinary), /container|format|header/i);
  assert.equal(hash(readFileSync(foreignBinary)), origBinHash, 'foreign non-redb file must remain byte-for-byte unchanged');

  // 2. Foreign redb database with unrelated tables must remain byte-for-byte unchanged.
  const foreignRedb = image + '-foreign-redb';
  const foreignDb = openNodeSync(foreignRedb);
  foreignDb.set('important', 'key', 'keep me');
  foreignDb.close();
  const origRedbHash = hash(readFileSync(foreignRedb));
  assert.throws(() => new SingleFileFS(foreignRedb), /container|recogniz|schema|format/i);
  assert.equal(hash(readFileSync(foreignRedb)), origRedbHash, 'foreign redb file must remain byte-for-byte unchanged');
  const check = openNodeSync(foreignRedb, { readOnly: true });
  assert.equal(check.getText('important', 'key'), 'keep me');
  check.close();

  // 3. redb database with matching table names but invalid format/root must be rejected unchanged.
  const collisionPath = image + '-collision';
  const collisionDb = openNodeSync(collisionPath);
  collisionDb.writeTransaction(tx => {
    tx.set('meta', 'format', JSON.stringify({ magic: 'WRONG', version: 2, pageSize: 8192 }));
    tx.set('nodes', new Uint8Array([0, 0, 0, 1]), JSON.stringify({ ino: 1, path: null, mode: 33152, size: 0, mtime: 0 }));
  });
  collisionDb.close();
  const collisionHash = hash(readFileSync(collisionPath));
  assert.throws(() => new SingleFileFS(collisionPath), /container|recogniz|format|root/i);
  assert.equal(hash(readFileSync(collisionPath)), collisionHash, 'collision redb file must remain byte-for-byte unchanged');

  // 4. Memory <-> Node.js byte-for-byte image portability & mixed chunk codecs (zerobytemask / bitsparse32 / bitsparse16 / lz4 / none).
  const memFs = await SingleFileFS.open(':memory:', { compression: 'zerobytemask' });
  const pgLike = new Uint8Array(16384);
  pgLike.set([1, 2, 3, 4, 5, 6, 7, 8], 0);
  pgLike.set([9, 10, 11, 12, 13, 14, 15, 16], 8100);
  pgLike.set(new TextEncoder().encode('repeat-'.repeat(400)), 8192);
  memFs.writeFile('/zerobytemask', pgLike);
  await memFs.closeFs();
  const exported = memFs.exportBytes();
  const portablePath = image + '-portable';
  writeFileSync(portablePath, exported);

  for (const codec of ['bitsparse32', 'bitsparse16', 'lz4', 'none']) {
    const fsCodec = new SingleFileFS(portablePath, { compression: codec });
    fsCodec.writeFile('/' + codec, pgLike);
    await fsCodec.closeFs();
  }

  const verifyFs = new SingleFileFS(portablePath);
  for (const p of ['/zerobytemask', '/bitsparse32', '/bitsparse16', '/lz4', '/none']) {
    const fd = verifyFs.open(p);
    const out = new Uint8Array(pgLike.length);
    assert.equal(verifyFs.read(fd, out, 0, out.length, 0), pgLike.length);
    assert.equal(hash(out), hash(pgLike));
    verifyFs.close(fd);
  }
  integrity(verifyFs);
  await verifyFs.closeFs();
  return { foreignDatabaseUnchanged: true, portableImageAccepted: true };
}

async function crash(input) {
  const size = 1024 * 1024;
  const fs = new SingleFileFS(input.image, { durable: true });
  if (input.action === 'seed') {
    fs.writeFile('/file', new Uint8Array(size).fill(0x11));
    await fs.closeFs();
    assert.deepEqual(readdirSync(dirname(input.image)), [basename(input.image)]);
    return { seeded: true };
  }
  if (input.action === 'verify') {
    assert.deepEqual(readdirSync(dirname(input.image)), [basename(input.image)]);
    const fd = fs.open('/file'), out = new Uint8Array(size);
    assert.equal(fs.read(fd, out, 0, size, 0), size);
    assert.ok(out.every(x => x === (input.commit ? 0x33 : 0x11)), 'recovery preserves committed bytes only');
    fs.close(fd); integrity(fs); await fs.closeFs();
    return { integrity: 'ok', recoveredCommit: input.commit };
  }
  const fd = fs.open('/file'), data = new Uint8Array(size).fill(input.commit ? 0x33 : 0x22);
  fs.write(fd, data, 0, size, 0);
  if (!input.commit) {
    const original = fs._writeChunk.bind(fs);
    let calls = 0;
    fs._writeChunk = (tx, ino, page, chunk) => {
      original(tx, ino, page, chunk);
      if (++calls === 30) {
        stage('kill-ready', { committed: false });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    };
  }
  await fs.syncToFs(false);
  stage('kill-ready', { committed: true });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

let source = '';
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source), dir = input.mode === 'crash' ? null : mkdtempSync(tmpdir() + '/pglite-singlefile-test-');
try {
  const operations = { property: propertyTrace, lifecycle, durability, checkpoint: walCheckpoint, safety, identity, crash };
  assert.ok(operations[input.mode], 'Known worker mode required');
  stage('runtime', { runtime: typeof Bun !== 'undefined' ? 'bun' : typeof Deno !== 'undefined' ? 'deno' : 'node', version: typeof Bun !== 'undefined' ? Bun.version : typeof Deno !== 'undefined' ? Deno.version.deno : process.version });
  const result = await operations[input.mode](input, dir + '/database.pglite');
  stage('result', { result });
} finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
