import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runWorker, runtime } from './runtime.js';

describe(`process crash recovery (${runtime})`, () => {
  for (const journalMode of ['DELETE', 'WAL']) for (const commit of [false, true]) {
    it(`recovers ${commit ? 'committed' : 'pre-transaction'} bytes after SIGKILL with ${journalMode}`, async () => {
      const directory = mkdtempSync(tmpdir() + '/pglite-singlefile-crash-');
      const input = { mode: 'crash', image: directory + '/database.pglite', journalMode, commit };
      try {
        expect(await runWorker({ ...input, action: 'seed' })).toEqual({ seeded: true });
        expect(await runWorker({ ...input, action: 'mutate' }, 30_000, true)).toEqual({ killedAtBarrier: true });
        expect(await runWorker({ ...input, action: 'verify' })).toEqual({ integrity: 'ok', recoveredCommit: commit });
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }, 60_000);
  }
});
