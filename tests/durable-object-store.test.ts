import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { DurableObjectStore, SingleFileFS, type DurableObjectSql } from 'pglite-singlefile-fs';

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < len; i++) {
    const d = a[i] - b[i];
    if (d !== 0) return d;
  }
  return a.byteLength - b.byteLength;
}

function toHex(u8: Uint8Array): string {
  let out = '';
  for (let i = 0; i < u8.byteLength; i++) out += u8[i].toString(16).padStart(2, '0');
  return out;
}

function cloneBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/**
 * Pure-JS in-memory mock of Cloudflare Durable Object `ctx.storage.sql` + `transactionSync`.
 * Enforces DO SQLite rules without `node:sqlite` (works identically across Node 22/24/26, Bun, Deno):
 * - Rejects BEGIN / COMMIT / SAVEPOINT / ROLLBACK / PRAGMA statements.
 * - Rejects ArrayBufferView bindings (requires standalone ArrayBuffer).
 * - Returns BLOB values as ArrayBuffer.
 * - Preserves unsigned lexicographic byte ordering on PRIMARY KEY (tbl, k).
 * - Rolls back all writes atomically if `transactionSync` throws mid-statement or after callback.
 */
class FakeDurableObjectBackend {
  kv = new Map<string, Map<string, { k: Uint8Array; v: Uint8Array }>>();
  control = new Set<string>();

  cloneState() {
    const kv = new Map<string, Map<string, { k: Uint8Array; v: Uint8Array }>>();
    for (const [tbl, rows] of this.kv) {
      const copy = new Map<string, { k: Uint8Array; v: Uint8Array }>();
      for (const [hex, entry] of rows) {
        copy.set(hex, { k: entry.k.slice(), v: entry.v.slice() });
      }
      kv.set(tbl, copy);
    }
    return { kv, control: new Set(this.control) };
  }

  restoreState(saved: { kv: Map<string, Map<string, { k: Uint8Array; v: Uint8Array }>>; control: Set<string> }) {
    this.kv = saved.kv;
    this.control = saved.control;
  }

  sql(): DurableObjectSql {
    const self = this;
    return {
      exec(query: string, ...bindings: unknown[]) {
        if (/^\s*(BEGIN|COMMIT|SAVEPOINT|ROLLBACK|PRAGMA)/i.test(query)) {
          throw new Error('not allowed in Durable Objects: ' + query);
        }
        for (const b of bindings) {
          if (ArrayBuffer.isView(b)) throw new Error('bind ArrayBuffer, not a view');
        }
        const q = query.replace(/\s+/g, ' ').trim();
        let rows: Record<string, unknown>[] = [];

        if (/^CREATE TABLE IF NOT EXISTS _pgsf_kv\b/i.test(q)) {
          // Schema creation no-op
        } else if (/^CREATE TABLE IF NOT EXISTS _pglite_control\b/i.test(q)) {
          // Control table creation no-op
        } else if (/^INSERT OR IGNORE INTO _pglite_control VALUES \('started'\)$/i.test(q)) {
          self.control.add('started');
        } else if (/^SELECT key FROM _pglite_control WHERE key = 'started'$/i.test(q)) {
          if (self.control.has('started')) rows = [{ key: 'started' }];
        } else if (/^SELECT DISTINCT tbl FROM _pgsf_kv ORDER BY tbl$/i.test(q)) {
          rows = Array.from(self.kv.entries())
            .filter(([, m]) => m.size > 0)
            .map(([tbl]) => tbl)
            .sort()
            .map(tbl => ({ tbl }));
        } else if (/^SELECT v FROM _pgsf_kv WHERE tbl = \? AND k = \?$/i.test(q)) {
          const tbl = bindings[0] as string;
          const k = new Uint8Array(bindings[1] as ArrayBuffer);
          const hit = self.kv.get(tbl)?.get(toHex(k));
          if (hit) rows = [{ v: cloneBuffer(hit.v) }];
        } else if (/^INSERT OR REPLACE INTO _pgsf_kv \(tbl, k, v\) VALUES \(\?, \?, \?\)$/i.test(q)) {
          const tbl = bindings[0] as string;
          const k = new Uint8Array(bindings[1] as ArrayBuffer).slice();
          const v = new Uint8Array(bindings[2] as ArrayBuffer).slice();
          let map = self.kv.get(tbl);
          if (!map) {
            map = new Map();
            self.kv.set(tbl, map);
          }
          map.set(toHex(k), { k, v });
        } else if (/^DELETE FROM _pgsf_kv WHERE tbl = \? AND k = \?$/i.test(q)) {
          const tbl = bindings[0] as string;
          const k = new Uint8Array(bindings[1] as ArrayBuffer);
          self.kv.get(tbl)?.delete(toHex(k));
        } else if (/^SELECT k, v FROM _pgsf_kv WHERE tbl = \?/i.test(q)) {
          let argIdx = 0;
          const tbl = bindings[argIdx++] as string;
          const hasStart = /AND k >= \?/i.test(q);
          const hasEnd = /AND k < \?/i.test(q);
          const hasLimit = /LIMIT \?/i.test(q);
          const start = hasStart ? new Uint8Array(bindings[argIdx++] as ArrayBuffer) : undefined;
          const end = hasEnd ? new Uint8Array(bindings[argIdx++] as ArrayBuffer) : undefined;
          const limit = hasLimit ? (bindings[argIdx++] as number) : undefined;
          const map = self.kv.get(tbl);
          if (map) {
            const matched = Array.from(map.values())
              .filter(e => (!start || compareBytes(e.k, start) >= 0) && (!end || compareBytes(e.k, end) < 0))
              .sort((a, b) => compareBytes(a.k, b.k));
            const sliced = limit !== undefined ? matched.slice(0, limit) : matched;
            rows = sliced.map(e => ({ k: cloneBuffer(e.k), v: cloneBuffer(e.v) }));
          }
        } else {
          throw new Error(`Unsupported mock SQL: ${q}`);
        }

        return {
          toArray: () => rows,
          one: () => rows[0],
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      },
    };
  }

  snapshot() {
    const out: Record<string, Array<{ k: string; hash: string }>> = {};
    for (const tbl of Array.from(this.kv.keys()).sort()) {
      const map = this.kv.get(tbl)!;
      const sorted = Array.from(map.values()).sort((a, b) => compareBytes(a.k, b.k));
      out[tbl] = sorted.map(e => ({
        k: toHex(e.k),
        hash: createHash('sha256').update(e.v).digest('hex'),
      }));
    }
    return out;
  }
}

function harness() {
  const backing = new FakeDurableObjectBackend();
  const failure = { statement: 0, afterCallback: false };
  let inTransaction = false;
  const open = (cacheBytes = 0) => {
    const sql = backing.sql();
    const store = new DurableObjectStore(
      {
        exec(query: string, ...bindings: unknown[]) {
          if (inTransaction && failure.statement && --failure.statement === 0) {
            throw new Error('injected SQL failure');
          }
          return sql.exec(query, ...bindings);
        },
      },
      <T>(callback: () => T): T => {
        const saved = backing.cloneState();
        inTransaction = true;
        try {
          const result = callback();
          if (failure.afterCallback) throw new Error('injected transaction failure');
          return result;
        } catch (error) {
          backing.restoreState(saved);
          throw error;
        } finally {
          inTransaction = false;
        }
      }
    );
    return new SingleFileFS('do', { store, cacheBytes });
  };
  return { backing, failure, open, snapshot: () => backing.snapshot() };
}

function read(fs: SingleFileFS, path: string, position: number, length: number) {
  const fd = fs.open(path, 'r');
  try {
    const bytes = new Uint8Array(length);
    expect(fs.read(fd, bytes, 0, length, position)).toBe(length);
    return bytes;
  } finally {
    fs.close(fd);
  }
}

describe('Durable Object store', () => {
  it('keeps node operations and chunks pending until one atomic flush', async () => {
    const { open, snapshot } = harness();
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
  });

  for (const cacheBytes of [0, 32768]) {
    it(`masks trimmed chunks before flush with ${cacheBytes} cache bytes`, async () => {
      const { open, snapshot } = harness();
      const fs = open(cacheBytes);
      fs.writeFile('/file', new Uint8Array(32768).fill(7));
      await fs.syncToFs();
      const before = snapshot();
      read(fs, '/file', 16384, 8192);
      fs.truncate('/file', 8193);
      fs.truncate('/file', 32768);
      expect(read(fs, '/file', 8192, 8192)).toEqual(Uint8Array.from({ length: 8192 }, (_, i) => (i === 0 ? 7 : 0)));
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
    });
  }

  for (const afterCallback of [false, true]) {
    it(`rolls back the whole flush on ${afterCallback ? 'transaction completion' : 'SQL'} failure`, async () => {
      const { failure, open, snapshot } = harness();
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
      expect((fs as any).dirty.size).toBeGreaterThan(0);
      expect(fs.pending).toBe(true);
      expect(() => fs.lstat('/file')).toThrow('injected');
      failure.afterCallback = false;
      failure.statement = 0;
      expect(read(open(), '/file', 0, 16384)).toEqual(new Uint8Array(16384).fill(7));
    });
  }

  it('retains pending pages and metadata when the transaction fails after its callback succeeds', async () => {
    const { failure, open, snapshot } = harness();
    const fs = open();
    fs.writeFile('/file', new Uint8Array(8192).fill(7));
    await fs.syncToFs();
    const before = snapshot();
    const fd = fs.open('/file', 'r+');
    fs.write(fd, new Uint8Array([9]), 0, 1, 0);
    fs.close(fd);
    fs.chmod('/file', 0o640);
    failure.afterCallback = true;
    await expect(fs.syncToFs()).rejects.toThrow('injected transaction failure');
    expect(snapshot()).toEqual(before);
    expect((fs as any).dirty.size).toBe(1);
    expect((fs as any).dirtyNodes.size).toBe(1);
    expect(fs.pending).toBe(true);
  });

  it('handles beginWrite overlay reads, scans, and abort cleanly', () => {
    const backing = new FakeDurableObjectBackend();
    const store = new DurableObjectStore(backing.sql(), fn => fn());
    store.writeTransaction(tx => {
      tx.set('chunks', new Uint8Array([0, 1]), new Uint8Array([10]));
      tx.set('chunks', new Uint8Array([0, 2]), new Uint8Array([20]));
      tx.set('chunks', new Uint8Array([0, 3]), new Uint8Array([30]));
    });
    const tx = store.beginWrite();
    tx.delete('chunks', new Uint8Array([0, 2]));
    tx.set('chunks', new Uint8Array([0, 4]), new Uint8Array([40]));
    expect(tx.scan('chunks').map(r => r.key[1])).toEqual([1, 3, 4]);
    tx.abort();
    expect(store.scan('chunks').map(r => r.key[1])).toEqual([1, 2, 3]);
  });

  it('persists PostgreSQL data across reopen using only DO-legal SQL', async () => {
    const backing = new FakeDurableObjectBackend();
    const open = () =>
      PGlite.create({
        fs: new SingleFileFS('do', {
          store: new DurableObjectStore(backing.sql(), fn => {
            const saved = backing.cloneState();
            try {
              return fn();
            } catch (error) {
              backing.restoreState(saved);
              throw error;
            }
          }),
        }),
      });
    let db = await open();
    await db.exec('CREATE TABLE t (id int primary key, body text)');
    await db.query('INSERT INTO t VALUES (1, $1), (2, $2)', ['one', 'two']);
    await db.close();
    db = await open();
    expect((await db.query('SELECT body FROM t ORDER BY id')).rows).toEqual([{ body: 'one' }, { body: 'two' }]);
    await db.close();
  }, 120_000);

  it('imports a seeded redb SingleFileFS cluster into DurableObjectStore and runs SQL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'singlefile-do-seed-'));
    const file = join(dir, 'seed.pglite');
    try {
      const seedDb = await PGlite.create({ fs: new SingleFileFS(file) });
      await seedDb.exec('CREATE TABLE seeded (id int primary key, label text)');
      await seedDb.query('INSERT INTO seeded VALUES (42, $1)', ['from-redb']);
      await seedDb.close();

      const ro = new SingleFileFS(file);
      const dump = (ro as any).store.readTransaction((rtx: any) => ({
        meta: rtx.scan('meta'),
        nodes: rtx.scan('nodes'),
        chunks: rtx.scan('chunks'),
      }));
      await ro.closeFs();

      const backing = new FakeDurableObjectBackend();
      const doStore = new DurableObjectStore(backing.sql(), fn => fn());
      doStore.writeTransaction(tx => {
        for (const { key, value } of dump.meta) tx.set('meta', key, value);
        for (const { key, value } of dump.nodes) tx.set('nodes', key, value);
        for (const { key, value } of dump.chunks) tx.set('chunks', key, value);
      });

      const doDb = await PGlite.create({ fs: new SingleFileFS('do', { store: doStore }) });
      try {
        expect((await doDb.query('SELECT id, label FROM seeded')).rows).toEqual([{ id: 42, label: 'from-redb' }]);
      } finally {
        await doDb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
