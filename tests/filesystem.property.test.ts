import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { runWorker, runtime } from './runtime.js';

const file = fc.integer({ min: 0, max: 2 });
const position = fc.oneof(fc.constantFrom(0, 1, 8191, 8192, 8193, 16383, 16384), fc.integer({ min: 0, max: 30_000 }));
const length = fc.oneof(fc.constantFrom(0, 1, 8191, 8192, 8193, 16384), fc.integer({ min: 0, max: 20_000 }));
const operation = fc.oneof(
  fc.record({ kind: fc.constant('write'), file, position, length, offset: fc.integer({ min: 0, max: 7 }), byte: fc.integer({ min: 0, max: 255 }), salt: fc.integer({ min: 0, max: 17 }), arrayBuffer: fc.boolean(), signedView: fc.boolean() }),
  fc.record({ kind: fc.constant('truncate'), file, length: fc.integer({ min: 0, max: 35_000 }) }),
  fc.record({ kind: fc.constant('read'), file, position, length, signedView: fc.boolean() }),
  fc.record({ kind: fc.constant('rename'), file, target: file }),
  fc.record({ kind: fc.constant('delete'), file }),
  fc.constant({ kind: 'reopen' }),
  fc.constant({ kind: 'sync' }),
);
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const paths = ['/case/a', '/case/b', '/case/c'];
function model(operations: any[]) {
  const files = new Map<string, Uint8Array>(), reads: any[] = [];
  for (const op of operations) {
    const path = paths[op.file], old = files.get(path);
    if (op.kind === 'write') {
      const previous = old ?? new Uint8Array();
      const next = new Uint8Array(op.length === 0 ? previous.length : Math.max(previous.length, op.position + op.length));
      next.set(previous);
      for (let i = 0; i < op.length; i++) next[op.position + i] = (op.byte + i * op.salt) & 255;
      files.set(path, next);
    } else if (op.kind === 'truncate') {
      const next = new Uint8Array(op.length); if (old) next.set(old.subarray(0, op.length)); files.set(path, next);
    } else if (op.kind === 'rename' && old && path !== paths[op.target]) {
      files.set(paths[op.target], old); files.delete(path);
    } else if (op.kind === 'delete') files.delete(path);
    else if (op.kind === 'read') {
      const out = old?.subarray(op.position, op.position + op.length);
      reads.push(out ? { count: out.length, hash: hash(out) } : null);
    }
  }
  return { reads, files: Object.fromEntries([...files].map(([path, data]) => [path, { size: data.length, hash: hash(data) }])) };
}

describe(`independent filesystem model (${runtime})`, () => {
  it('covers sparse page boundaries, trim/extend, overwrite rename and persisted zero bytes', async () => {
    const write = (file: number, position: number, length: number, byte: number) => ({ kind: 'write', file, position, length, byte, salt: 3, offset: 5, arrayBuffer: false, signedView: true });
    const operations = [
      write(0, 8191, 20000, 4), { kind: 'sync' },
      write(0, 16383, 8193, 0), { kind: 'truncate', file: 0, length: 16385 },
      { kind: 'truncate', file: 0, length: 35000 }, { kind: 'reopen' },
      { kind: 'read', file: 0, position: 8000, length: 20000, signedView: true },
      write(1, 0, 8192, 7), { kind: 'rename', file: 0, target: 1 },
      { kind: 'reopen' }, { kind: 'read', file: 1, position: 0, length: 20000 },
      { kind: 'delete', file: 1 }, write(2, 30000, 0, 0), { kind: 'reopen' },
    ];
    expect(await runWorker({ mode: 'property', operations })).toEqual(model(operations));
  });
  it('matches generated cross-page mutation traces, including persisted reopen', async () => {
    await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 10, maxLength: 30 }), async operations => {
      expect(await runWorker({ mode: 'property', operations }, 30_000)).toEqual(model(operations));
    }), {
      numRuns: Number(process.env.FC_RUNS ?? 25),
      ...(process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {}),
      ...(process.env.FC_PATH ? { path: process.env.FC_PATH } : {}),
      verbose: true,
    });
  }, 180_000);
  it('protects unrelated SQLite databases and accepts recognized legacy container images', async () => {
    expect(await runWorker({ mode: 'identity' })).toEqual({ foreignDatabaseUnchanged: true, legacyImageAccepted: true });
  });
  it('rejects unsafe options and preserves file descriptors through rename', async () => {
    expect(await runWorker({ mode: 'safety' })).toEqual({ invalidOptionsRejected: true, renameDescriptorPreserved: true });
  });
});
