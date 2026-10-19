import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
// @ts-expect-error untyped fake
import { DurableObjectStore, SingleFileFS } from '../src/index.mjs';

// Mimics the Durable Object sql API's strictness: no transaction statements,
// no PRAGMAs, ArrayBuffer-only blob bindings, blobs returned as ArrayBuffer.
function fakeDurableObjectSql(db: DatabaseSync) {
  return {
    exec(query: string, ...bindings: unknown[]) {
      if (/^\s*(BEGIN|COMMIT|SAVEPOINT|ROLLBACK|PRAGMA)/i.test(query)) throw new Error('not allowed in Durable Objects: ' + query);
      for (const b of bindings) if (ArrayBuffer.isView(b)) throw new Error('bind ArrayBuffer, not a view');
      const args = bindings.map(b => b instanceof ArrayBuffer ? new Uint8Array(b) : b) as any[];
      const stmt = db.prepare(query);
      const rows = /^\s*(SELECT|INSERT[^]*RETURNING)/i.test(query)
        ? (stmt.all(...args) as any[]).map(r => Object.fromEntries(Object.entries(r).map(([k, v]) =>
            [k, v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v])))
        : (stmt.run(...args), []);
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  };
}

function harness() {
  const backing = new DatabaseSync(':memory:');
  const failure = { statement: 0, afterCallback: false };
  let inTransaction = false;
  const open = (cacheBytes = 0) => {
    const sql = fakeDurableObjectSql(backing);
    const store = new DurableObjectStore({
      exec(query: string, ...bindings: unknown[]) {
        if (inTransaction && failure.statement && --failure.statement === 0) throw new Error('injected SQL failure');
        return sql.exec(query, ...bindings);
      },
    }, (callback: () => unknown) => {
      backing.exec('BEGIN');
      inTransaction = true;
      try {
        const result = callback();
        if (failure.afterCallback) throw new Error('injected transaction failure');
        backing.exec('COMMIT');
        return result;
      } catch (error) {
        backing.exec('ROLLBACK');
        throw error;
      } finally { inTransaction = false; }
    });
    return new SingleFileFS('do', { store, cacheBytes });
  };
  const snapshot = () => ({
    nodes: backing.prepare('SELECT * FROM nodes ORDER BY ino').all(),
    chunks: backing.prepare('SELECT ino,page,data FROM chunks ORDER BY ino,page').all().map(({ data, ...row }) =>
      ({ ...row, hash: createHash('sha256').update(data as Uint8Array).digest('hex') })),
  });
  return { backing, failure, open, snapshot };
}

function read(fs: any, path: string, position: number, length: number) {
  const fd = fs.open(path, 'r');
  try {
    const bytes = new Uint8Array(length);
    expect(fs.read(fd, bytes, 0, length, position)).toBe(length);
    return bytes;
  } finally { fs.close(fd); }
}

describe('Durable Object store', () => {
  it('keeps node operations and chunks pending until one atomic flush', async () => {
    const { backing, open, snapshot } = harness();
    const fs = open();
    fs.mkdir('/dir');
    fs.writeFile('/dir/file', 'source');
    fs.writeFile('/target', 'old target');
    fs.writeFile('/trim', new Uint8Array(16384).fill(7));
    await fs.syncToFs();
    const before = snapshot();
    const held = fs.open('/target', 'r');
    fs.rename('/dir', '/moved');
    fs.rename('/moved/file', '/target');
    fs.truncate('/trim', 0);
    fs.chmod('/target', 0o640);
    fs.utimes('/target', 0, 1234);
    fs.writeFile('/new', 'first');
    const firstInode = fs.lstat('/new').ino;
    fs.unlink('/new');
    fs.writeFile('/new', 'second');
    expect(fs.lstat('/new').ino).toBeGreaterThan(firstInode);
    const oldBytes = new Uint8Array(10);
    expect(fs.read(held, oldBytes, 0, 10, 0)).toBe(10);
    expect(new TextDecoder().decode(oldBytes)).toBe('old target');
    fs.close(held);
    await Promise.resolve();
    expect(snapshot()).toEqual(before);
    await fs.syncToFs();
    const reopened = open();
    expect(new TextDecoder().decode(read(reopened, '/target', 0, 6))).toBe('source');
    expect(reopened.lstat('/target')).toMatchObject({ mode: 0o100640, mtime: 1234 });
    expect(reopened.lstat('/trim').size).toBe(0);
    expect(reopened.readdir('/moved')).toEqual(['.', '..']);
    expect(new TextDecoder().decode(read(reopened, '/new', 0, 6))).toBe('second');
    backing.close();
  });

  for (const cacheBytes of [0, 32768]) it(`masks trimmed chunks before flush with ${cacheBytes} cache bytes`, async () => {
    const { backing, open, snapshot } = harness();
    const fs = open(cacheBytes);
    fs.writeFile('/file', new Uint8Array(32768).fill(7));
    await fs.syncToFs();
    const before = snapshot();
    read(fs, '/file', 16384, 8192);
    fs.truncate('/file', 8193);
    fs.truncate('/file', 32768);
    expect(read(fs, '/file', 8192, 8192)).toEqual(Uint8Array.from({ length: 8192 }, (_, i) => i === 0 ? 7 : 0));
    expect(read(fs, '/file', 16384, 8192)).toEqual(new Uint8Array(8192));
    expect(read(fs, '/file', 8193, 24575)).toEqual(new Uint8Array(24575));
    const fd = fs.open('/file', 'r+');
    fs.write(fd, new Uint8Array([9]), 0, 1, 20000);
    fs.close(fd);
    const expected = new Uint8Array(32768);
    expected.fill(7, 0, 8193);
    expected[20000] = 9;
    expect(read(fs, '/file', 0, 32768)).toEqual(expected);
    expect(read(fs, '/file', 16384, 8192)).toEqual(expected.subarray(16384, 24576));
    expect(snapshot()).toEqual(before);
    await fs.syncToFs();
    expect(read(open(), '/file', 0, 32768)).toEqual(expected);
    backing.close();
  });

  for (const afterCallback of [false, true]) it(`rolls back the whole flush on ${afterCallback ? 'transaction completion' : 'SQL'} failure`, async () => {
    const { backing, failure, open, snapshot } = harness();
    const fs = open();
    fs.writeFile('/file', new Uint8Array(16384).fill(7));
    await fs.syncToFs();
    const before = snapshot();
    fs.truncate('/file', 0);
    fs.writeFile('/file', new Uint8Array(16384).fill(9));
    fs.writeFile('/new', 'pending');
    failure.afterCallback = afterCallback;
    failure.statement = afterCallback ? 0 : 4;
    await expect(fs.syncToFs()).rejects.toThrow('injected');
    expect(snapshot()).toEqual(before);
    expect(fs.dirty.size).toBeGreaterThan(0);
    expect(fs.pending).toBe(true);
    expect(() => fs.lstat('/file')).toThrow('injected');
    failure.afterCallback = false;
    failure.statement = 0;
    expect(read(open(), '/file', 0, 16384)).toEqual(new Uint8Array(16384).fill(7));
    backing.close();
  });

  it('retains pending pages when the transaction fails after its callback succeeds', async () => {
    const { backing, failure, open, snapshot } = harness();
    const fs = open();
    fs.writeFile('/file', new Uint8Array(8192).fill(7));
    await fs.syncToFs();
    const before = snapshot();
    const fd = fs.open('/file', 'r+');
    fs.write(fd, new Uint8Array([9]), 0, 1, 0);
    fs.close(fd);
    failure.afterCallback = true;
    await expect(fs.syncToFs()).rejects.toThrow('injected transaction failure');
    expect(snapshot()).toEqual(before);
    expect(fs.dirty.size).toBe(1);
    expect(fs.dirtyNodes.size).toBe(1);
    expect(fs.pending).toBe(true);
    backing.close();
  });

  it('persists PostgreSQL data across reopen using only DO-legal SQL', async () => {
    const backing = new DatabaseSync(':memory:'); // stands in for the object's persistent SQLite
    const open = () => PGlite.create({ fs: new SingleFileFS('do', { store: new DurableObjectStore(fakeDurableObjectSql(backing)) }) });
    let db = await open();
    await db.exec('CREATE TABLE t (id int primary key, body text)');
    await db.query('INSERT INTO t VALUES (1, $1), (2, $2)', ['one', 'two']);
    await db.close();
    db = await open();
    expect((await db.query('SELECT body FROM t ORDER BY id')).rows).toEqual([{ body: 'one' }, { body: 'two' }]);
    await db.close();
  }, 120_000);
});
