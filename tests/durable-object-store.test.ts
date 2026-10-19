import { DatabaseSync } from 'node:sqlite';
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

describe('Durable Object store', () => {
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
