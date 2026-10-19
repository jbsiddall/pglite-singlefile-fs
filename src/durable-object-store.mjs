// Adapts a Cloudflare Durable Object's `ctx.storage.sql` to the small
// statement API SingleFileFS expects (prepare/run/get/all/exec/close).
// The Durable Object owns durability and journaling, so BEGIN/COMMIT and the
// WAL checkpoint pragma are no-ops here. Writes made in one synchronous block
// are committed atomically by the runtime.
const NOOP = /^\s*(BEGIN|COMMIT)\s*$/i;
const CHECKPOINT = /^\s*PRAGMA\s+wal_checkpoint/i;

const bind = value => value instanceof Uint8Array
    ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    : value;
const row = r => {
    for (const k in r) if (r[k] instanceof ArrayBuffer) r[k] = new Uint8Array(r[k]);
    return r;
};

export class DurableObjectStore {
    /** @param sql `ctx.storage.sql` from a SQLite-backed Durable Object */
    /** @param transactionSync `ctx.storage.transactionSync`, so a failed commit rolls back as a whole */
    constructor(sql, transactionSync) { this.sql = sql; if (transactionSync) this.transaction = transactionSync; }
    exec(text) { this.sql.exec(text).toArray(); }
    close() {}
    prepare(text) {
        const { sql } = this;
        const run = args => sql.exec(text, ...args.map(bind));
        if (NOOP.test(text)) return { run() {} };
        if (CHECKPOINT.test(text)) return { get: () => ({ busy: 0, log: 0, checkpointed: 0 }) };
        const insert = /^\s*INSERT/i.test(text);
        return {
            run(...args) {
                run(args).toArray();
                return insert ? { lastInsertRowid: sql.exec('SELECT last_insert_rowid() AS id').one().id } : {};
            },
            get: (...args) => { const [first] = run(args); return first && row(first); },
            all: (...args) => run(args).toArray().map(row),
        };
    }
}
