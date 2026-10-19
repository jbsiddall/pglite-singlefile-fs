import { PGlite } from '@electric-sql/pglite';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
// @ts-expect-error example transport is JavaScript
import { authorizationError, DatabaseAccess, ProtocolSession } from '../examples/cloudflare-do/src/ws-transport.mjs';
// @ts-expect-error example import state is JavaScript
import { ImportState } from '../examples/cloudflare-do/src/import-state.mjs';
// @ts-expect-error example response helper is JavaScript
import { finishRequest } from '../examples/cloudflare-do/src/http-response.mjs';

const encoder = new TextEncoder();
function packet(type: string, body = new Uint8Array()) {
  const result = new Uint8Array(body.length + 5);
  result[0] = type.charCodeAt(0);
  new DataView(result.buffer).setUint32(1, body.length + 4);
  result.set(body, 5);
  return result;
}
const query = (sql: string) => packet('Q', encoder.encode(sql + '\0'));
function startup() {
  const body = encoder.encode('user\0postgres\0database\0postgres\0\0');
  const bytes = new Uint8Array(body.length + 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length); view.setUint32(4, 196608);
  bytes.set(body, 8);
  return bytes;
}
function socket() {
  return { sent: [] as Uint8Array[], closed: [] as number[],
    send(data: Uint8Array) { this.sent.push(new Uint8Array(data)); },
    close(code: number) { this.closed.push(code); } };
}

describe('Cloudflare PostgreSQL WebSocket transport', () => {
  it('finishes rejected request bodies before returning the response', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
    const request = new Request('https://example.test/import', { method: 'POST', body, duplex: 'half' } as RequestInit);
    const refusal = new Response('Unauthorized', { status: 401 });
    let finished = false;
    const response = finishRequest(request, refusal).then((result: Response) => { finished = true; return result; });
    stream.enqueue(new Uint8Array(1024));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(finished).toBe(false);
    stream.enqueue(new Uint8Array(1024));
    stream.close();
    expect(await response).toBe(refusal);
    expect(request.bodyUsed).toBe(true);
    expect(await finishRequest(request, refusal)).toBe(refusal);
    expect(await finishRequest(new Request('https://example.test/stats'), refusal)).toBe(refusal);
  });
  it('remembers the import cutoff after the object is reconstructed', () => {
    const sqlite = new DatabaseSync(':memory:');
    try {
      const before = new ImportState(sqlite);
      expect(before.hasStarted()).toBe(false);
      before.markStarted();
      const after = new ImportState(sqlite);
      expect(after.hasStarted()).toBe(true);
      after.markStarted();
      expect(after.hasStarted()).toBe(true);
    } finally { sqlite.close(); }
  });
  it('fails closed without a secret and requires a bearer header', () => {
    const request = (headers = {}) => new Request('https://example.test/ws?address=localhost:5432', { headers });
    expect(authorizationError(request(), undefined)?.status).toBe(503);
    expect(authorizationError(request(), 'secret')?.status).toBe(401);
    expect(authorizationError(request({ Authorization: 'Bearer wrong' }), 'secret')?.status).toBe(401);
    expect(authorizationError(request({ Authorization: 'Bearer secret' }), 'secret')).toBeNull();
  });

  it('reserves the whole session synchronously, including HTTP requests and cleanup', async () => {
    const access = new DatabaseAccess();
    const first = access.acquire();
    expect(first).not.toBeNull();
    expect(access.acquire()).toBeNull();
    access.release({});
    expect(access.acquire()).toBeNull();
    access.release(first);
    expect(access.acquire()).not.toBeNull();
  });

  it('reassembles startup and query packets across frames and refuses SSL', async () => {
    const seen: Uint8Array[] = [];
    const db = { runExclusive: (fn: () => Promise<void>) => fn(),
      execProtocolRawStream: async (data: Uint8Array, options: { onRawData: (v: Uint8Array) => void }) => {
        seen.push(data); options.onRawData(new Uint8Array([90]));
      }, exec: async () => {} };
    const ws = socket();
    const session = new ProtocolSession(db, ws);
    const ssl = new Uint8Array(8);
    const view = new DataView(ssl.buffer);
    view.setUint32(0, 8); view.setUint32(4, 80877103);
    await session.receive(ssl.subarray(0, 3));
    await session.receive(ssl.subarray(3));
    expect(ws.sent[0]).toEqual(new Uint8Array([78]));
    const bytes = new Uint8Array([...startup(), ...query('SELECT 1'), ...query('SELECT 2')]);
    await session.receive(bytes.subarray(0, 6));
    expect(seen).toHaveLength(0);
    await session.receive(bytes.subarray(6));
    expect(seen).toEqual([startup(), query('SELECT 1'), query('SELECT 2')]);
    await session.close();
  });

  it('rejects invalid packet lengths and text frames without entering PGlite', async () => {
    let calls = 0;
    const db = { runExclusive: (fn: () => Promise<void>) => fn(),
      execProtocolRawStream: async () => { calls++; }, exec: async () => {} };
    const ws = socket();
    const session = new ProtocolSession(db, ws);
    await session.receive(new Uint8Array([255, 255, 255, 255]));
    await session.close();
    expect(ws.closed).toContain(1009);
    expect(calls).toBe(0);
    const textWs = socket();
    const textSession = new ProtocolSession(db, textWs);
    await textSession.receive('SELECT 1');
    await textSession.close();
    expect(textWs.closed).toContain(1003);
  });

  it('drains an in-flight query before cleanup and drops queued messages on disconnect', async () => {
    let finish!: () => void;
    let entered!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const operations: string[] = [];
    const access = new DatabaseAccess();
    const lease = access.acquire();
    const db = { runExclusive: (fn: () => Promise<void>) => fn(),
      execProtocolRawStream: async (bytes: Uint8Array) => {
        if (bytes[0] === 81) { operations.push('query'); entered(); await gate; }
        if (bytes[0] === 83) operations.push('sync');
      }, exec: async (sql: string) => { operations.push(sql); } };
    const session = new ProtocolSession(db, socket(), { onClose: () => access.release(lease) });
    await session.receive(startup());
    const first = session.receive(query('SELECT 1'));
    await running;
    const second = session.receive(query('SELECT 2'));
    const closing = session.close();
    expect(access.acquire()).toBeNull();
    expect(operations).toEqual(['query']);
    finish();
    await Promise.all([first, second, closing]);
    expect(operations).toEqual(['query', 'sync', 'ROLLBACK', 'DISCARD ALL']);
    expect(access.acquire()).not.toBeNull();
  });

  it('sends protocol completion only after persistence and withholds it on failure', async () => {
    for (const fail of [false, true]) {
      let finish!: () => void;
      let emitted!: () => void;
      const emission = new Promise<void>(resolve => { emitted = resolve; });
      const persistence = new Promise<void>(resolve => { finish = resolve; });
      const ws = socket();
      const db = { runExclusive: (fn: () => Promise<void>) => fn(), exec: async () => {},
        execProtocolRawStream: async (bytes: Uint8Array, options: { onRawData: (v: Uint8Array) => void }) => {
          if (bytes[0] !== 81) return;
          options.onRawData(new Uint8Array([90, 0, 0, 0, 5, 73]));
          emitted();
          await persistence;
          if (fail) throw new Error('disk full');
        } };
      const session = new ProtocolSession(db, ws);
      await session.receive(startup());
      const queryFinished = session.receive(query('COMMIT'));
      await emission;
      expect(ws.sent).toHaveLength(0);
      finish();
      await queryFinished;
      expect(ws.sent).toHaveLength(fail ? 0 : 1);
      await session.close();
    }
  });

  it('rolls back disconnects, resets session state and preserves the backend on Terminate', async () => {
    const db = await PGlite.create();
    try {
      await db.exec('CREATE TABLE ws_test (id integer)');
      const access = new DatabaseAccess();
      const lease = access.acquire();
      const session = new ProtocolSession(db, socket(), {
        onClose: () => access.release(lease), onFatal: () => access.poison(),
      });
      await session.receive(startup());
      await session.receive(query("SET application_name = 'private'; CREATE TEMP TABLE private_state(id int); BEGIN; INSERT INTO ws_test VALUES (1)"));
      expect(access.acquire()).toBeNull();
      const closing = session.close();
      expect(access.acquire()).toBeNull();
      await closing;
      expect(access.acquire()).not.toBeNull();
      expect((await db.query('SELECT * FROM ws_test')).rows).toEqual([]);
      expect((await db.query("SELECT current_setting('application_name') AS name, to_regclass('pg_temp.private_state') AS temp")).rows).toEqual([{ name: '', temp: null }]);
      const next = new ProtocolSession(db, socket());
      await next.receive(startup());
      await next.receive(query('INSERT INTO ws_test VALUES (2)'));
      await next.receive(packet('X'));
      await next.close();
      expect((await db.query('SELECT * FROM ws_test')).rows).toEqual([{ id: 2 }]);
      const interrupted = new ProtocolSession(db, socket());
      await interrupted.receive(startup());
      await interrupted.receive(query('BEGIN; INSERT INTO ws_test VALUES (3)'));
      await interrupted.receive(packet('P', new Uint8Array([...encoder.encode('broken\0SELECT FROM\0'), 0, 0])));
      await interrupted.close();
      expect((await db.query('SELECT * FROM ws_test')).rows).toEqual([{ id: 2 }]);
    } finally { await db.close(); }
  });

  it('stops admitting sessions if cleanup fails', async () => {
    const access = new DatabaseAccess();
    const lease = access.acquire();
    const db = { runExclusive: (fn: () => Promise<void>) => fn(), exec: async () => { throw new Error('reset failed'); } };
    const session = new ProtocolSession(db, socket(), {
      onClose: () => access.release(lease), onFatal: () => access.poison(),
    });
    await session.close();
    expect(access.acquire()).toBeNull();
  });
});
