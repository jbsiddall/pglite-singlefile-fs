import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import { ERRNO_CODES } from '@electric-sql/pglite/basefs';
import { SingleFileFS, checkpoint } from '../src/index.mjs';
import { openDatabase } from '../src/sqlite.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stage = (name, detail = {}) => console.log(JSON.stringify({ stage: name, ...detail }));
const immediate = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const idle = async fs => { for (let i = 0; i < 3; i++) { await immediate(); await fs.flush(); } };
const integrity = fs => assert.equal(fs.store.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
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
        const input = op.arrayBuffer ? source.buffer : op.signedView ? new Int8Array(source.buffer) : source;
        assert.equal(fs.write(fd, input, op.offset, op.length, op.position), op.length);
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
  for (const journalMode of ['DELETE', 'WAL']) for (const relaxed of [false, true]) {
    const filename = image + '-' + journalMode + '-' + relaxed, fs = new GateFS(filename, { journalMode });
    const db = await PGlite.create({ fs, relaxedDurability: relaxed });
    await db.exec('CREATE TABLE durable(id INT PRIMARY KEY)'); await idle(fs);
    assert.equal(fs.store.prepare('PRAGMA synchronous').get().synchronous, journalMode === 'WAL' ? 2 : 3);
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
    const reopenedFs = new SingleFileFS(filename, { journalMode });
    const reopened = await PGlite.create({ fs: reopenedFs, relaxedDurability: relaxed });
    assert.deepEqual((await reopened.query('SELECT * FROM durable')).rows, [{ id: 1 }]);
    await reopened.close(); stage('durability-mode', { journalMode, relaxed });
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
  const fs = new SingleFileFS(image, { walAutoCheckpointBytes: 512 * 1024 * 1024 });
  const db = await PGlite.create({ fs });
  try {
    await db.exec('CREATE TABLE checkpoint_rows(id INT PRIMARY KEY, payload TEXT NOT NULL)');
    const before = (await db.query('SELECT checkpoint_lsn::text AS lsn FROM pg_control_checkpoint()')).rows[0].lsn;
    await db.exec("INSERT INTO checkpoint_rows SELECT i, repeat('payload-' || i::text,100) FROM generate_series(1,3000) i");
    await fs.flush();
    assert.ok(statSync(image + '-wal').size > 0, 'container WAL must have frames before maintenance');
    const result = await checkpoint(db, fs, { mode: 'TRUNCATE' });
    assert.equal(result.busy, 0, 'maintenance must not report a blocked checkpoint');
    assert.equal(statSync(image + '-wal').size, 0, 'coordinated maintenance truncates SQLite WAL');
    const after = (await db.query('SELECT checkpoint_lsn::text AS lsn FROM pg_control_checkpoint()')).rows[0].lsn;
    assert.notEqual(after, before, 'real PostgreSQL checkpoint advances checkpoint_lsn');
    integrity(fs); stage('coordinated-checkpoint', { before, after, sqlite: result });
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
  for (const options of [{ durable: true, journalMode: 'MEMORY' }, { pageSize: 123 }, { sqliteCacheKiB: -1 }, { lockingMode: 'INVALID' }]) {
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
  const foreign = openDatabase(image + '-foreign');
  foreign.exec("CREATE TABLE important(value TEXT); INSERT INTO important VALUES ('keep me'); PRAGMA user_version=7;");
  const beforePragmas = ['application_id', 'user_version', 'page_size', 'journal_mode'].map(name => foreign.prepare('PRAGMA ' + name).get());
  const beforeSchema = foreign.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all().map(row => ({ ...row }));
  foreign.close(); const originalBytes = hash(readFileSync(image + '-foreign'));
  assert.throws(() => new SingleFileFS(image + '-foreign'), /SQLite|container|recogniz|schema|format/i);
  assert.equal(hash(readFileSync(image + '-foreign')), originalBytes, 'foreign SQLite file must remain byte-for-byte unchanged');
  const check = openDatabase(image + '-foreign');
  assert.deepEqual(check.prepare('SELECT * FROM important').all().map(row => ({ ...row })), [{ value: 'keep me' }]);
  assert.deepEqual(check.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all().map(row => ({ ...row })), beforeSchema);
  assert.deepEqual(['application_id', 'user_version', 'page_size', 'journal_mode'].map(name => check.prepare('PRAGMA ' + name).get()), beforePragmas);
  check.close();
  const legacy = openDatabase(image + '-legacy');
  legacy.exec(`CREATE TABLE nodes(ino INTEGER PRIMARY KEY,path TEXT UNIQUE,mode INTEGER NOT NULL,size INTEGER NOT NULL DEFAULT 0,mtime INTEGER NOT NULL);
    CREATE TABLE chunks(ino INTEGER NOT NULL,page INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(ino,page));
    INSERT INTO nodes(path,mode,mtime) VALUES ('/',16832,0);`);
  legacy.close();
  const collision = openDatabase(image + '-collision');
  collision.exec(`CREATE TABLE nodes(ino INTEGER PRIMARY KEY,path TEXT UNIQUE,mode INTEGER NOT NULL,size INTEGER NOT NULL DEFAULT 0,mtime INTEGER NOT NULL);
    CREATE TABLE chunks(ino INTEGER NOT NULL,page INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(ino,page));
    INSERT INTO nodes(path,mode,mtime) VALUES (NULL,33152,0);`);
  collision.close(); const collisionBytes = hash(readFileSync(image + '-collision'));
  assert.throws(() => new SingleFileFS(image + '-collision'), /SQLite|container|recogniz|schema|format|root/i);
  assert.equal(hash(readFileSync(image + '-collision')), collisionBytes, 'matching schema without a valid root is not a legacy container');
  const collisionCheck = openDatabase(image + '-collision');
  assert.equal(collisionCheck.prepare('SELECT count(*) AS n FROM nodes WHERE path IS NULL').get().n, 1);
  collisionCheck.close();
  const fs = new SingleFileFS(image + '-legacy');
  fs.writeFile('/legacy', new Uint8Array([11, 12])); await fs.closeFs();
  const reopened = new SingleFileFS(image + '-legacy'), fd = reopened.open('/legacy'), bytes = new Uint8Array(2);
  assert.equal(reopened.read(fd, bytes, 0, 2, 0), 2); assert.deepEqual([...bytes], [11, 12]);
  integrity(reopened); reopened.close(fd); await reopened.closeFs();
  return { foreignDatabaseUnchanged: true, legacyImageAccepted: true };
}

async function crash(input) {
  const size = 1024 * 1024, fs = new SingleFileFS(input.image, { journalMode: input.journalMode });
  if (input.action === 'seed') { fs.writeFile('/file', new Uint8Array(size).fill(0x11)); await fs.closeFs(); return { seeded: true }; }
  if (input.action === 'verify') {
    const fd = fs.open('/file'), out = new Uint8Array(size);
    assert.equal(fs.read(fd, out, 0, size, 0), size);
    assert.ok(out.every(x => x === (input.commit ? 0x33 : 0x11)), 'recovery preserves committed bytes only');
    fs.close(fd); integrity(fs); await fs.closeFs(); return { integrity: 'ok', recoveredCommit: input.commit };
  }
  fs.store.exec('PRAGMA cache_size=8');
  const fd = fs.open('/file'), data = new Uint8Array(size).fill(input.commit ? 0x33 : 0x22);
  fs.write(fd, data, 0, size, 0);
  if (!input.commit) {
    const put = fs.sql.put, original = put.run.bind(put); let calls = 0;
    fs.sql.put = { run(...args) {
      const result = original(...args);
      if (++calls === 30) { stage('kill-ready', { committed: false }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
      return result;
    } };
  }
  await fs.syncToFs(false); stage('kill-ready', { committed: true });
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
