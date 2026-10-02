import { describe, expect, it } from 'vitest';
import { runWorker, runtime } from './runtime.js';

describe(`PGlite lifecycle and durability (${runtime})`, () => {
  it('reopens and remains writable across repeated strict and relaxed SQL transactions', async () => {
    expect(await runWorker({ mode: 'lifecycle', cycles: 3 })).toEqual({ cyclesPerMode: 3 });
  }, 240_000);
  it('honors strict/relaxed query completion, drains close, and exposes background persistence errors', async () => {
    expect(await runWorker({ mode: 'durability' }, 240_000)).toEqual({ modes: 4, backgroundFailureObserved: true });
  }, 270_000);
  it('coordinates a real PostgreSQL checkpoint with container WAL truncation and writable recovery', async () => {
    expect(await runWorker({ mode: 'checkpoint' })).toEqual({ rowsBeforeReopen: 3000, rowsAfterInsert: 3001 });
  }, 210_000);
});
