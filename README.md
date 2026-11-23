# PGlite Singlefile FS

[![CI](https://github.com/jbsiddall/pglite-singlefile-fs/actions/workflows/ci.yml/badge.svg)](https://github.com/jbsiddall/pglite-singlefile-fs/actions/workflows/ci.yml)
[Latest release](https://github.com/jbsiddall/pglite-singlefile-fs/releases/latest)

**Embedded PostgreSQL in one portable file — on Node.js, Bun, Deno, and Browser OPFS.**

A virtual filesystem for [PGlite](https://github.com/electric-sql/pglite) backed by [`redb-js`](https://github.com/jbsiddall/redb-js) (a Copy-on-Write ACID B-tree in WebAssembly) that keeps an entire PostgreSQL cluster inside **strictly one single file** with **zero `-wal` or `-shm` sidecar files**, even while open. PGlite runs PostgreSQL SQL, indexes, transactions, and extensions as usual; this adapter controls where the filesystem bytes live.

> Pre-stable library. Back up important data and read the durability and concurrency limits below before production use.

## What changes?

| PGlite built-in filesystems (`NodeFS` / `OpfsAhpFS`) | `SingleFileFS` (`redb-js`) |
| --- | --- |
| ~1,000 files in a data directory (`pgdata/`) or OPFS pool (`OpfsAhpFS`) | Strictly **1 file** (`postgres.pglite`) on disk or in Browser OPFS |
| Separate host files under `base/`, `global/`, and `pg_wal/` | Same logical files stored as self-describing 8 KiB chunks in one `redb` CoW B-tree |
| Multi-file directory / pool layout | Zero `-wal` / `-shm` sidecars even while open |
| Copy or move an entire directory | Close cleanly, then copy or move one file (portable across Node.js, Bun, Deno, and Browser OPFS) |

## Installation & runtime support

- **Server runtimes:** Node.js `>=18`, Bun, Deno (zero native C/N-API addons)
- **Browsers:** Modern browsers supporting OPFS `FileSystemSyncAccessHandle` inside a Dedicated Web Worker (Chrome, Firefox, Safari, Edge), or `:memory:` on the main thread
- **Peer dependency:** `@electric-sql/pglite` (`^0.5.8`)

```sh
npm install pglite-singlefile-fs @electric-sql/pglite
```

Or install directly from GitHub:

```sh
npm install git+https://github.com/jbsiddall/pglite-singlefile-fs.git @electric-sql/pglite
```

## Quick start

### Node.js, Bun, and Deno

```js
import { PGlite } from '@electric-sql/pglite';
import { SingleFileFS } from 'pglite-singlefile-fs';

const fs = new SingleFileFS('./postgres.pglite');
const db = await PGlite.create({
  fs,
  // Optional: coalesce back-to-back writes into SIGKILL-safe atomic CoW commits
  // without per-query fsync (hardware-synced on flush() and close()):
  relaxedDurability: true,
  // Optional: safe on Copy-on-Write SingleFileFS because torn 8 KiB pages cannot occur:
  startParams: [...PGlite.defaultStartParams, ...SingleFileFS.recommendedStartParams],
});

await db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    body text NOT NULL
  );
`);
await db.query('INSERT INTO notes (body) VALUES ($1)', ['Hello, PostgreSQL']);
console.log((await db.query('SELECT * FROM notes ORDER BY id')).rows);
await db.close();
```

### Browser (OPFS inside a Dedicated Web Worker)

Use the `pglite-singlefile-fs/browser` entry point (automatically selected via package `"browser"` exports in bundlers) inside a Dedicated Web Worker:

```js
import { PGlite } from '@electric-sql/pglite';
import { SingleFileFS } from 'pglite-singlefile-fs/browser';

// Persists to strictly 1 file in Origin Private File System (OPFS)
const fs = await SingleFileFS.open('postgres.pglite');
const db = await PGlite.create({
  fs,
  relaxedDurability: true, // optional: matches OpfsAhpFS relaxed speed with 1 file
});

await db.exec('CREATE TABLE IF NOT EXISTS notes (id INT PRIMARY KEY, body TEXT NOT NULL)');
await db.query("INSERT INTO notes VALUES (1, 'Persisted in Browser OPFS!')");
await db.close();
```

### In-memory & portable export

Works identically on the browser main thread or on servers:

```js
import { PGlite } from '@electric-sql/pglite';
import { SingleFileFS } from 'pglite-singlefile-fs'; // or 'pglite-singlefile-fs/browser'

const fs = await SingleFileFS.open(':memory:');
const db = await PGlite.create({ fs });
await db.exec('CREATE TABLE t (id INT PRIMARY KEY)');
await db.query('INSERT INTO t VALUES (1)');
await db.close();

// Standard single-file container bytes — openable in Node.js, Bun, Deno, or Browser OPFS
const bytes = fs.exportBytes();
```

## Durability, checkpoints, compaction, and concurrency limits

### Durability modes

- **`durable: true` + `relaxedDurability: false` (strict default):** Every query commits an atomic `redb` Copy-on-Write transaction with `Durability::Immediate` and calls hardware sync (`fs.fdatasyncSync` when file size is unchanged, `fs.fsyncSync` on growth/resize on Node/Bun/Deno; `syncHandle.flush()` on Browser OPFS). An abrupt `SIGKILL` or power cut mid-transaction recovers cleanly to the previous committed root with zero corruption.
- **`durable: true` + `relaxedDurability: true` (recommended for interactive / high-frequency writes):** Coalesces back-to-back queries and commits atomic `redb` CoW transactions (`Durability::Immediate`) directly to the OS page cache / OPFS handle without blocking every query on a hardware `fsync`/`flush`. Committed writes survive `SIGKILL` and browser tab crashes with zero container corruption, and `await fs.flush()` / `await db.close()` perform a full hardware sync. A sudden power cut before `flush()` or `close()` can roll back only the un-synced window cleanly to the last checksum-valid root.
- **`durable: false` (explicit unsafe mode):** Uses `redb` `Durability::None` (skips per-commit flushes and hardware syncs; not crash-safe).

### Checkpoints and compaction

```js
import { PGlite } from '@electric-sql/pglite';
import { SingleFileFS, checkpoint } from 'pglite-singlefile-fs';

const fs = new SingleFileFS('./postgres.pglite');
const db = await PGlite.create({ fs });

// Runs PostgreSQL CHECKPOINT, flushes durably, and compacts free pages in the container
await checkpoint(db, fs, { compact: true });
await db.close();
```

Note that `db.close()` writes a final PostgreSQL shutdown checkpoint. If you want the minimum possible closed file size before archiving or transferring the image, compact after closing (or call `await fs.closeFs({ compact: true })` when closing the filesystem directly).

### Concurrency limits

- **Single writer only:** PGlite itself is single-connection embedded PostgreSQL, and `redb` enforces a single-writer lock on the container file. Do not open the same `.pglite` file concurrently from multiple processes, workers, or browser tabs.
- **Do not copy while open:** Always `await db.close()` before copying, uploading, or moving the database file.
- **Foreign file protection:** Opening an existing non-empty file validates the `redb` header and `PGSF` container schema without modifying the file (even for uncleanly closed foreign `redb` databases, which are inspected inside a RAM-only overlay) and rejects unrecognized files untouched.

## Memory and storage controls

```js
const fs = new SingleFileFS('./postgres.pglite', {
  durable: true,                    // Hardware-sync durability contract (default: true)
  redbCacheBytes: 8 * 1024 * 1024,  // In-memory redb page cache (default: 8 MiB)
  cacheBytes: 0,                    // Optional adapter clean-page cache (default: 0)
  pageSize: 8192,                   // Logical chunk size for new images (default: 8 KiB)
  compression: 'sparse',            // 'sparse' / 'zerobytemask' (default), 'bitsparse32', 'bitsparse16', 'lz4', or 'none'
});
```

- PGlite's PostgreSQL `shared_buffers` remains the primary data cache; `redbCacheBytes` (default `8 MiB`) buffers `redb` B-tree pages and dirty writes inside WASM.
- Each stored chunk carries a self-describing codec tag byte, so an image can be reopened under any `compression` setting.
- `'sparse'` (alias `'zerobytemask'`, default) uses a hybrid PostgreSQL page-hole elider + 2-level zero-byte bitmask, automatically skipping all-zero pages and splitting incompressible chunks larger than `8,170 B` to avoid `redb`'s 16 KiB leaf-page allocation cliff.

## Performance

All benchmarks compare `SingleFileFS` directly against PGlite's built-in persistent filesystems (`NodeFS` on server, `OpfsAhpFS` in Browser OPFS) using verified row counts and checksums. Timings are observations on the recorded hardware, not cross-machine guarantees; full raw snapshots and methodology live in [docs/benchmarks/README.md](docs/benchmarks/README.md).

### Node.js: `SingleFileFS` vs built-in `NodeFS`

Measured on **Node.js v23.1.0, Apple M2 macOS (`darwin/arm64`)** — 1 excluded warm-up + 3 alternating fresh-process runs per variant, **100 MiB total configured page-cache budget** (`NodeFS`: 100 MiB `shared_buffers`; `SingleFileFS`: 92 MiB `shared_buffers` + 8 MiB `redb` cache, adapter clean cache disabled), warm reads, 10,000-row batch / 500 single-row frequent operations, including `flush()` settle time. Raw JSON: [node23-macos-arm64.json](docs/benchmarks/node23-macos-arm64.json).

| Metric | Built-in `NodeFS` (`fsync=off`) | `SingleFileFS` (`strict`) | `SingleFileFS` (`relaxed`) | `SingleFileFS` (`relaxed` + `fpw=off`) | `SingleFileFS` `lz4` (`relaxed`) |
| --- | ---: | ---: | ---: | ---: | ---: |
| **`initdb` + startup** | 669.4 ms | **622.4 ms (`0.93×`)** | **536.9 ms (`0.80×`)** | **534.2 ms (`0.80×`)** | **531.5 ms (`0.79×`)** |
| `batchRead` (10,000 rows) | 24.0 ms | **22.7 ms (`0.95×`)** | 24.1 ms (`1.00×`) | 24.1 ms (`1.00×`) | **23.6 ms (`0.98×`)** |
| `batchInsert` (10,000 rows) | 16.2 ms | 31.7 ms (`1.96×`) | 30.6 ms (`1.89×`) | 30.0 ms (`1.85×`) | 31.8 ms (`1.96×`) |
| `batchUpdate` (10,000 rows) | 25.8 ms | 40.0 ms (`1.55×`) | 39.0 ms (`1.51×`) | 37.0 ms (`1.43×`) | 45.0 ms (`1.74×`) |
| `frequentRead` (500 lookups) | 75.2 ms | **73.3 ms (`0.97×`)** | **71.6 ms (`0.95×`)** | **72.2 ms (`0.96×`)** | **71.7 ms (`0.95×`)** |
| `frequentInsert` (500 inserts) | 71.1 ms | 2,118.7 ms (`29.8×`)\* | **73.0 ms (`1.03×`)** | **73.3 ms (`1.03×`)** | **72.8 ms (`1.02×`)** |
| `frequentUpdate` (500 updates) | 77.0 ms | 2,230.0 ms (`29.0×`)\* | **77.3 ms (`1.00×`)** | **78.4 ms (`1.02×`)** | **77.8 ms (`1.01×`)** |
| **Cold reopen + scan** | 60.1 ms | 76.9 ms (`1.28×`) | **51.3 ms (`0.85×`)** | **50.4 ms (`0.84×`)** | 60.3 ms (`1.00×`) |
| **Host files on disk** | 977 | **1** | **1** | **1** | **1** |
| **Raw closed size** | 42.25 MB | **35.66 MB (`0.84×`)** | **35.66 MB (`0.84×`)** | **35.66 MB (`0.84×`)** | **17.83 MB (`0.42×`)** |
| **Compacted closed size** | 42.25 MB | **26.10 MB (`0.62×`)** | **26.05 MB (`0.62×`)** | **23.62 MB (`0.56×`)** | **17.29 MB (`0.41×`)** |

\* **Durability disclosure:** Built-in `NodeFS` runs PostgreSQL with `fsync=off` (0 hardware syncs). `SingleFileFS (strict)` runs 500 `redb` `Durability::Immediate` commits with macOS `F_FULLFSYNC` (~4.1 ms/call on Apple NVMe; Linux `fdatasync` is typically ~0.05–0.3 ms/call). `SingleFileFS (relaxed)` writes every CoW commit to the OS page cache (`SIGKILL`-safe) and hardware-syncs on `flush()` / `close()`, matching `NodeFS` on frequent writes (`1.00×–1.03×`) while starting 20% faster and using 1 file instead of 977.

### Browser WASM OPFS: `SingleFileFS` vs built-in `OpfsAhpFS`

Measured inside a **Headless Chrome 157.0.8103.80 Dedicated Web Worker** on Apple M2 macOS (single un-warmed run per variant via `npm run test:browser`, 2,000-row batch / 100 single-row frequent operations, default 8 MiB `redb` cache, including `flush()` settle time):

| Variant | `initMs` | `batchRead` | `batchInsert` | `batchUpdate` | `frequentRead` | `frequentInsert` | `frequentUpdate` | OPFS Files | OPFS Size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Built-in `OpfsAhpFS` (strict) | 830.5 ms | 5.4 ms | 4.4 ms | 7.5 ms | 11.5 ms | 45.3 ms | 37.2 ms | 1,079 | 40.54 MB |
| Built-in `OpfsAhpFS` (relaxed) | 820.7 ms | 5.3 ms | 3.7 ms | 6.0 ms | 9.1 ms | 10.3 ms | 12.9 ms | 1,071 | 40.54 MB |
| **`SingleFileFS` `sparse` (strict)** | **666.5 ms** | 5.7 ms | 5.4 ms | 7.7 ms | **9.5 ms** | 103.1 ms | 103.0 ms | **1** | **18.00 MB** |
| **`SingleFileFS` `sparse` (relaxed)** | **489.7 ms** | 5.7 ms | 5.0 ms | 7.5 ms | **8.7 ms** | **10.2 ms** | **11.2 ms** | **1** | **17.98 MB** |
| **`SingleFileFS` `sparse` (no-flush)** | **562.7 ms** | **5.0 ms** | 4.0 ms | 6.6 ms | **8.7 ms** | 10.4 ms | **11.0 ms** | **1** | **17.99 MB** |
| **`SingleFileFS` `lz4` (relaxed)** | **520.3 ms** | **5.0 ms** | 7.4 ms | 11.6 ms | **8.6 ms** | **9.9 ms** | **10.4 ms** | **1** | **17.83 MB** |

In Chrome OPFS, `SingleFileFS` replaces **1,071–1,079 OPFS files** (`40.54 MB`) with **1 file** (`17.83–18.00 MB`, **56% smaller**), starts **20–40% faster**, and matches or beats `OpfsAhpFS (relaxed)` on frequent reads and writes while flushing durably at settle time. In strict mode, per-query `syncHandle.flush()` accounts for ~80% of single-row write latency.

## Tests and benchmarks

```sh
npm run build         # TypeScript declaration check
npm test              # Vitest suite: property traces, PGlite lifecycle, durability, foreign-file safety, SIGKILL recovery
npm run test:browser  # Headless Chrome Browser OPFS persistence across restart + OpfsAhpFS benchmark
npm run bench:sample  # Fresh-process alternating NodeFS vs SingleFileFS benchmark + HTML report
npm run bench         # Vitest benchmark suite
npm run bench:big     # Opt-in 5 GiB two-table join benchmark (needs ~12 GiB free disk)
```

## Roadmap & governance

- **Roadmap:** Align with [PGlite](https://github.com/electric-sql/pglite) so single-file storage is straightforward to adopt or provide officially upstream ([issue #1](https://github.com/jbsiddall/pglite-singlefile-fs/issues/1)).
- **Maintenance:** Supervised by Joseph Siddall. Useful issues and pull requests from both humans and AI coding agents are welcome; maintainers vet all changes for correctness, durability, and honesty.

## License

Apache License 2.0. See [LICENSE](LICENSE).
