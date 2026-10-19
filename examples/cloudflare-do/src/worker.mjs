import { DurableObject } from 'cloudflare:workers';
import { PGlite } from '@electric-sql/pglite';
import { SingleFileFS, DurableObjectStore } from '../../../src/index.mjs';
import pgliteWasm from '../assets/pglite.wasm';
import initdbWasm from '../assets/initdb.wasm';
import fsBundle from '../assets/pglite.data';
import trampoline0 from '../assets/trampoline-0.wasm';
import trampoline1 from '../assets/trampoline-1.wasm';
import trampolineKeys from '../assets/trampolines.json';

// Workers forbid compiling wasm from bytes. Emscripten does that for each callback stub,
// so hand back the same stubs precompiled at build time (scripts/capture-trampolines.mjs).
const trampolines = new Map(trampolineKeys.map((key, i) => [key, [trampoline0, trampoline1][i]]));
WebAssembly.Module = new Proxy(WebAssembly.Module, {
    construct(target, args) {
        const [bytes] = args;
        const key = bytes?.byteLength < 200 && [...new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength)].map(b => b.toString(16).padStart(2, '0')).join('');
        return trampolines.get(key) ?? new target(...args);
    },
});

// Emscripten sees nodejs_compat's process.versions.node and calls process.binding, which workerd lacks.
process.binding = () => ({ fs: {} });

// Wraps ctx.storage.sql to total rows read/written, the units Cloudflare bills.
function counting(sql, totals) {
    return {
        exec(query, ...bindings) {
            const cursor = sql.exec(query, ...bindings), rows = cursor.toArray();
            totals.read += cursor.rowsRead; totals.written += cursor.rowsWritten;
            return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
        },
    };
}

export class Db extends DurableObject {
    totals = { read: 0, written: 0 };
    sql = new DurableObjectStore(counting(this.ctx.storage.sql, this.totals), fn => this.ctx.storage.transactionSync(fn));

    // Postgres's initdb loads .so side modules, which Workers cannot compile, so the cluster is seeded from Node instead.
    start() {
        return this.started ??= (async () => {
            this.fs = new SingleFileFS('do', { store: this.sql });
            this.db = await PGlite.create({ fs: this.fs, pgliteWasmModule: pgliteWasm, initdbWasmModule: initdbWasm, fsBundle: new Blob([fsBundle]) });
        })();
    }

    async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/import') {
            new SingleFileFS('do', { store: this.sql });
            const { nodes, chunks } = await request.json();
            for (const n of nodes) this.sql.prepare('INSERT OR REPLACE INTO nodes(ino,path,mode,size,mtime) VALUES (?,?,?,?,?)').run(...n);
            for (const [ino, page, data] of chunks) this.sql.prepare('INSERT OR REPLACE INTO chunks(ino,page,data) VALUES (?,?,?)').run(ino, page, Uint8Array.from(atob(data), c => c.charCodeAt(0)));
            return Response.json({ nodes: nodes.length, chunks: chunks.length });
        }
        const started = performance.now();
        await this.start();
        if (url.pathname === '/stats') return Response.json({ bootMs: this.bootMs ??= Math.round(performance.now() - started), rows: this.totals, counters: this.fs.counters });
        if (request.method !== 'POST') return new Response('POST SQL to /sql', { status: 405 });
        const before = { ...this.totals };
        try {
            const result = await this.db.query(await request.text());
            return Response.json({ rows: result.rows, rowsRead: this.totals.read - before.read, rowsWritten: this.totals.written - before.written });
        } catch (e) {
            return Response.json({ error: String(e) }, { status: 400 });
        }
    }
}

export default {
    fetch: (request, env) =>
        env.DB.get(env.DB.idFromName('main')).fetch(request),
};
