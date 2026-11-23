// Adapts a Cloudflare Durable Object's `ctx.storage.sql` (and optional
// `ctx.storage.transactionSync`) to the redb-compatible KV store interface
// expected by SingleFileFS. All SQL is strictly Durable-Object-legal (no
// BEGIN/COMMIT/SAVEPOINT/ROLLBACK/PRAGMA, ArrayBuffer-only blob bindings).

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const KV_SCHEMA = `CREATE TABLE IF NOT EXISTS _pgsf_kv (
  tbl TEXT NOT NULL,
  k BLOB NOT NULL,
  v BLOB NOT NULL,
  PRIMARY KEY (tbl, k)
) WITHOUT ROWID`;

function toU8(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return textEncoder.encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('Expected string, Uint8Array, ArrayBuffer, or ArrayBufferView');
}

function toArrayBuffer(value) {
  const u8 = toU8(value);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

function bindSqlArg(value) {
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  return value;
}

function unwrapRow(record) {
  const out = {};
  for (const key in record) {
    const val = record[key];
    out[key] = val instanceof ArrayBuffer ? new Uint8Array(val) : val;
  }
  return out;
}

function compareBytes(a, b) {
  const len = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < len; i++) {
    const diff = a[i] - b[i];
    if (diff !== 0) return diff;
  }
  return a.byteLength - b.byteLength;
}

function toHex(u8) {
  let out = '';
  for (let i = 0; i < u8.byteLength; i++) {
    out += u8[i].toString(16).padStart(2, '0');
  }
  return out;
}

export class DurableObjectStore {
  /**
   * @param sql `ctx.storage.sql` from a SQLite-backed Durable Object
   * @param transactionSync Optional `ctx.storage.transactionSync`, so a failed flush rolls back atomically
   */
  constructor(sql, transactionSync) {
    if (!sql || typeof sql.exec !== 'function') {
      throw new TypeError('DurableObjectStore requires a Durable Object sql object with exec()');
    }
    this.sql = sql;
    this._transactionSync = typeof transactionSync === 'function' ? transactionSync : null;
    this.sql.exec(KV_SCHEMA).toArray();
  }

  _listTables() {
    return this.sql.exec('SELECT DISTINCT tbl FROM _pgsf_kv ORDER BY tbl').toArray().map(r => r.tbl);
  }

  _get(table, key) {
    const rows = this.sql
      .exec('SELECT v FROM _pgsf_kv WHERE tbl = ? AND k = ?', table, toArrayBuffer(key))
      .toArray();
    return rows.length > 0 ? toU8(rows[0].v) : undefined;
  }

  _getText(table, key) {
    const raw = this._get(table, key);
    return raw === undefined ? undefined : textDecoder.decode(raw);
  }

  _scan(table, options = {}) {
    const { start, end, limit } = options ?? {};
    if (limit === 0) return [];
    let query = 'SELECT k, v FROM _pgsf_kv WHERE tbl = ?';
    const args = [table];
    if (start !== undefined) {
      query += ' AND k >= ?';
      args.push(toArrayBuffer(start));
    }
    if (end !== undefined) {
      query += ' AND k < ?';
      args.push(toArrayBuffer(end));
    }
    query += ' ORDER BY k ASC';
    if (limit !== undefined) {
      query += ' LIMIT ?';
      args.push(limit);
    }
    return this.sql.exec(query, ...args).toArray().map(r => ({
      key: toU8(r.k),
      value: toU8(r.v),
    }));
  }

  _scanEach(table, options, callback) {
    const rows = this._scan(table, options);
    for (let i = 0; i < rows.length; i++) {
      callback(rows[i].key, rows[i].value);
    }
  }

  _setDirect(table, key, value) {
    this.sql
      .exec(
        'INSERT OR REPLACE INTO _pgsf_kv (tbl, k, v) VALUES (?, ?, ?)',
        table,
        toArrayBuffer(key),
        toArrayBuffer(value)
      )
      .toArray();
  }

  _deleteDirect(table, key) {
    this.sql
      .exec('DELETE FROM _pgsf_kv WHERE tbl = ? AND k = ?', table, toArrayBuffer(key))
      .toArray();
  }

  listTables() {
    return this._listTables();
  }

  get(table, key) {
    return this._get(table, key);
  }

  getText(table, key) {
    return this._getText(table, key);
  }

  scan(table, options) {
    return this._scan(table, options);
  }

  beginRead() {
    return {
      listTables: () => this._listTables(),
      get: (table, key) => this._get(table, key),
      getView: (table, key) => this._get(table, key),
      getText: (table, key) => this._getText(table, key),
      scan: (table, options) => this._scan(table, options),
      scanEach: (table, options, cb) => this._scanEach(table, options, cb),
      close() {},
    };
  }

  readTransaction(fn) {
    const rtx = this.beginRead();
    try {
      return fn(rtx);
    } finally {
      rtx.close();
    }
  }

  writeTransaction(fn) {
    const tx = {
      listTables: () => this._listTables(),
      get: (table, key) => this._get(table, key),
      getView: (table, key) => this._get(table, key),
      getText: (table, key) => this._getText(table, key),
      scan: (table, options) => this._scan(table, options),
      scanEach: (table, options, cb) => this._scanEach(table, options, cb),
      set: (table, key, value) => this._setDirect(table, key, value),
      delete: (table, key) => this._deleteDirect(table, key),
    };
    return this._transactionSync ? this._transactionSync(() => fn(tx)) : fn(tx);
  }

  beginWrite() {
    const ops = [];
    /** @type {Map<string, Map<string, { key: Uint8Array, value: Uint8Array | null }>>} */
    const overlay = new Map();
    let done = false;

    const ensureActive = () => {
      if (done) throw new Error('Write transaction is already closed');
    };

    const tableOverlay = table => {
      let map = overlay.get(table);
      if (!map) {
        map = new Map();
        overlay.set(table, map);
      }
      return map;
    };

    return {
      set: (table, key, value) => {
        ensureActive();
        const k = toU8(key).slice();
        const v = toU8(value).slice();
        ops.push({ op: 'set', table, key: k, value: v });
        tableOverlay(table).set(toHex(k), { key: k, value: v });
      },
      delete: (table, key) => {
        ensureActive();
        const k = toU8(key).slice();
        ops.push({ op: 'delete', table, key: k });
        tableOverlay(table).set(toHex(k), { key: k, value: null });
      },
      get: (table, key) => {
        ensureActive();
        const k = toU8(key);
        const map = overlay.get(table);
        if (map) {
          const entry = map.get(toHex(k));
          if (entry !== undefined) return entry.value ?? undefined;
        }
        return this._get(table, k);
      },
      scan: (table, options = {}) => {
        ensureActive();
        const { start, end, limit } = options ?? {};
        if (limit === 0) return [];
        const map = overlay.get(table);
        if (!map || map.size === 0) return this._scan(table, options);
        const startU8 = start !== undefined ? toU8(start) : undefined;
        const endU8 = end !== undefined ? toU8(end) : undefined;
        const base = this._scan(table, { start: startU8, end: endU8 });
        const merged = new Map();
        for (const row of base) merged.set(toHex(row.key), row);
        for (const [hex, entry] of map) {
          if (startU8 && compareBytes(entry.key, startU8) < 0) continue;
          if (endU8 && compareBytes(entry.key, endU8) >= 0) continue;
          if (entry.value === null) merged.delete(hex);
          else merged.set(hex, { key: entry.key, value: entry.value });
        }
        const sorted = Array.from(merged.values()).sort((a, b) => compareBytes(a.key, b.key));
        return limit !== undefined ? sorted.slice(0, limit) : sorted;
      },
      commit: () => {
        ensureActive();
        done = true;
        const apply = () => {
          for (let i = 0; i < ops.length; i++) {
            const item = ops[i];
            if (item.op === 'set') this._setDirect(item.table, item.key, item.value);
            else this._deleteDirect(item.table, item.key);
          }
        };
        if (this._transactionSync) this._transactionSync(apply);
        else apply();
        ops.length = 0;
        overlay.clear();
      },
      abort: () => {
        done = true;
        ops.length = 0;
        overlay.clear();
      },
    };
  }

  sync() {}

  compact() {
    return false;
  }

  checkIntegrity() {
    return true;
  }

  close() {}

  /** Execute DO-legal auxiliary SQL on the underlying Durable Object handle (e.g. control tables). */
  exec(text, ...bindings) {
    return this.sql.exec(text, ...bindings.map(bindSqlArg)).toArray();
  }

  /** Lightweight statement helper for auxiliary DO-legal SQL queries. */
  prepare(text) {
    const { sql } = this;
    const run = args => sql.exec(text, ...args.map(bindSqlArg));
    return {
      run: (...args) => {
        run(args).toArray();
        return {};
      },
      get: (...args) => {
        const rows = run(args).toArray();
        return rows.length > 0 ? unwrapRow(rows[0]) : undefined;
      },
      all: (...args) => run(args).toArray().map(unwrapRow),
    };
  }
}
