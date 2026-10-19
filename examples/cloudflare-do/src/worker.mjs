import { DurableObject } from 'cloudflare:workers';
import { PGlite } from '@electric-sql/pglite';
import { SingleFileFS, DurableObjectStore } from '../../../src/index.mjs';
import { authorizationError, DatabaseAccess, ProtocolSession } from './ws-transport.mjs';
import { ImportState } from './import-state.mjs';
import { finishRequest } from './http-response.mjs';
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
    access = new DatabaseAccess();
    sql = new DurableObjectStore(counting(this.ctx.storage.sql, this.totals), fn => this.ctx.storage.transactionSync(fn));
    importState = new ImportState(this.sql);

    // Postgres's initdb loads .so side modules, which Workers cannot compile, so the cluster is seeded from Node instead.
    start() {
        return this.started ??= (async () => {
            this.importState.markStarted();
            this.fs = new SingleFileFS('do', { store: this.sql });
            this.db = await PGlite.create({ fs: this.fs, pgliteWasmModule: pgliteWasm, initdbWasmModule: initdbWasm, fsBundle: new Blob([fsBundle]) });
        })();
    }

    async fetch(request) {
        return finishRequest(request, await this.handleRequest(request));
    }

    async handleRequest(request) {
        const unauthorized = authorizationError(request, this.env.WS_TOKEN);
        if (unauthorized) return unauthorized;
        const url = new URL(request.url);
        const methods = { '/import': 'POST', '/sql': 'POST', '/stats': 'GET', '/ws': 'GET' };
        if (!Object.hasOwn(methods, url.pathname)) return new Response('Not found', { status: 404 });
        if (request.method !== methods[url.pathname]) return new Response('Method not allowed', { status: 405, headers: { Allow: methods[url.pathname] } });
        if (url.pathname === '/ws' && request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket upgrade required', { status: 426 });
        const lease = this.access.acquire();
        if (!lease) return new Response(this.access.failed ? 'Database session cleanup failed; restart this object' : 'Database connection is in use', { status: this.access.failed ? 503 : 409 });
        let socketOwnsLease = false;
        try {
            if (url.pathname === '/import') {
                if (this.importState.hasStarted()) return new Response('Import before starting PostgreSQL', { status: 409 });
                new SingleFileFS('do', { store: this.sql });
                const { nodes, chunks } = await request.json();
                for (const n of nodes) this.sql.prepare('INSERT OR REPLACE INTO nodes(ino,path,mode,size,mtime) VALUES (?,?,?,?,?)').run(...n);
                for (const [ino, page, data] of chunks) this.sql.prepare('INSERT OR REPLACE INTO chunks(ino,page,data) VALUES (?,?,?)').run(ino, page, Uint8Array.from(atob(data), c => c.charCodeAt(0)));
                return Response.json({ nodes: nodes.length, chunks: chunks.length });
            }
            const query = url.pathname === '/sql' ? await request.text() : null;
            const started = performance.now();
            await this.start();
            if (url.pathname === '/ws') {
                try {
                    await this.db.exec('ROLLBACK');
                    await this.db.exec('DISCARD ALL');
                } catch (e) {
                    this.access.poison();
                    throw e;
                }
                const [client, server] = Object.values(new WebSocketPair());
                server.accept();
                server.binaryType = 'arraybuffer';
                const session = new ProtocolSession(this.db, server, {
                    onClose: () => this.access.release(lease),
                    onFatal: () => this.access.poison(),
                });
                server.addEventListener('message', event => { this.ctx.waitUntil(session.receive(event.data)); });
                server.addEventListener('close', () => { this.ctx.waitUntil(session.close()); });
                server.addEventListener('error', () => { this.ctx.waitUntil(session.close(1011, 'WebSocket failed')); });
                socketOwnsLease = true;
                return new Response(null, { status: 101, webSocket: client });
            }
            if (url.pathname === '/stats') return Response.json({ bootMs: this.bootMs ??= Math.round(performance.now() - started), rows: this.totals, counters: this.fs.counters });
            const before = { ...this.totals };
            const result = await this.db.query(query);
            return Response.json({ rows: result.rows, rowsRead: this.totals.read - before.read, rowsWritten: this.totals.written - before.written });
        } catch (e) {
            return Response.json({ error: String(e) }, { status: 400 });
        } finally {
            if (!socketOwnsLease) this.access.release(lease);
        }
    }

}

export default {
    fetch: (request, env) =>
        env.DB.get(env.DB.idFromName('main')).fetch(request),
};
