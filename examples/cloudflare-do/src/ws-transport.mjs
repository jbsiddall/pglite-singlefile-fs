import { timingSafeEqual } from 'node:crypto';

const encoder = new TextEncoder();
const MAX_PACKET_BYTES = 1024 * 1024;
const MAX_BUFFER_BYTES = 4 * MAX_PACKET_BYTES;

export function authorizationError(request, token) {
    if (!token) return new Response('Configure the WS_TOKEN secret', { status: 503 });
    const header = request.headers.get('Authorization') ?? '';
    const expected = encoder.encode(`Bearer ${token}`);
    const supplied = encoder.encode(header);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
        return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
    }
    return null;
}

export class DatabaseAccess {
    owner = null;
    failed = false;
    acquire() {
        if (this.owner || this.failed) return null;
        return this.owner = {};
    }
    release(owner) {
        if (this.owner === owner) this.owner = null;
    }
    poison() { this.failed = true; }
}

export class ProtocolSession {
    buffer = new Uint8Array();
    tail = Promise.resolve();
    pendingBytes = 0;
    startup = true;
    closed = false;

    constructor(db, socket, { onClose = () => {}, onFatal = () => {} } = {}) {
        this.db = db;
        this.socket = socket;
        this.onClose = onClose;
        this.onFatal = onFatal;
    }

    receive(data) {
        if (this.closed) return this.tail;
        if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
            return this.close(1003, 'Binary PostgreSQL protocol required');
        }
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (this.pendingBytes + this.buffer.length + bytes.length > MAX_BUFFER_BYTES) {
            return this.close(1009, 'Protocol buffer limit exceeded');
        }
        this.pendingBytes += bytes.length;
        this.tail = this.tail.then(async () => {
            if (!this.closed) await this.process(bytes);
        }).catch(() => {
            void this.close(1011, 'PostgreSQL protocol failed');
        }).finally(() => { this.pendingBytes -= bytes.length; });
        return this.tail;
    }

    async process(bytes) {
        const buffer = new Uint8Array(this.buffer.length + bytes.length);
        buffer.set(this.buffer); buffer.set(bytes, this.buffer.length);
        this.buffer = buffer;
        while (!this.closed) {
            const minimum = this.startup ? 4 : 5;
            if (this.buffer.length < minimum) return;
            const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.length);
            const length = this.startup ? view.getUint32(0) : 1 + view.getUint32(1);
            if (length < (this.startup ? 8 : 5) || length > MAX_PACKET_BYTES) {
                void this.close(1009, 'Invalid PostgreSQL packet length');
                return;
            }
            if (this.buffer.length < length) return;
            const message = this.buffer.slice(0, length);
            this.buffer = this.buffer.slice(length);
            if (this.startup) {
                const version = new DataView(message.buffer).getUint32(4);
                if (length === 8 && (version === 80877103 || version === 80877104)) {
                    this.socket.send(new Uint8Array([78]));
                    continue;
                }
                if (version !== 196608) {
                    void this.close(1008, 'Only PostgreSQL protocol 3.0 is supported; cancellation is unavailable');
                    return;
                }
                this.startup = false;
            } else if (message[0] === 88) {
                if (length !== 5) throw new Error('Invalid Terminate packet');
                void this.close();
                return;
            }
            const output = [];
            let outputBytes = 0;
            await this.db.runExclusive(() => this.db.execProtocolRawStream(message, {
                onRawData: data => {
                    outputBytes += data.length;
                    if (outputBytes <= MAX_BUFFER_BYTES && data.length) output.push(new Uint8Array(data));
                },
            }));
            if (outputBytes > MAX_BUFFER_BYTES) {
                void this.close(1009, 'PostgreSQL response exceeds 4 MiB; operation may have committed');
                return;
            }
            // A successful protocol response must wait for PGlite's persistence promise.
            if (!this.closed) for (const data of output) this.socket.send(data);
        }
    }

    close(code = 1000, reason = '') {
        if (this.closing) return this.closing;
        this.closed = true;
        try { this.socket.close(code, reason); } catch {}
        this.closing = this.tail.then(async () => {
            this.buffer = new Uint8Array();
            // Sync clears an interrupted extended-query exchange before session cleanup.
            if (!this.startup) await this.db.runExclusive(() => this.db.execProtocolRawStream(new Uint8Array([83, 0, 0, 0, 4]), { onRawData() {} }));
            await this.db.exec('ROLLBACK');
            await this.db.exec('DISCARD ALL');
        }).catch(() => {
            this.onFatal();
        }).finally(() => { this.onClose(); });
        return this.closing;
    }
}
