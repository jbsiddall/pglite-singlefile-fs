# PGlite Singlefile FS

[![CI](https://github.com/jbsiddall/pglite-singlefile-fs/actions/workflows/ci.yml/badge.svg)](https://github.com/jbsiddall/pglite-singlefile-fs/actions/workflows/ci.yml)
[Latest release](https://github.com/jbsiddall/pglite-singlefile-fs/releases/latest)

**Embedded PostgreSQL. One portable database file — on Server and Browser OPFS.**

A virtual filesystem for [PGlite](https://github.com/electric-sql/pglite) backed by [`redb-js`](https://github.com/jbsiddall/redb-js) (Copy-on-Write ACID B-tree in WebAssembly) that keeps all PostgreSQL files inside **strictly one single file** with **zero `-wal` or `-shm` sidecars**, even while open. PGlite still runs the SQL, indexes, transactions, and supported extensions; this adapter changes where its file bytes live.

The goal is **the power of PostgreSQL in a single portable database file**, easy to embed in **Node.js, Deno, Bun, and Browsers (OPFS)**.

> Early-stage library. Treat the format and API as pre-stable, back up important data, and read the durability and concurrency limits below.

## What changes?

| PGlite's native filesystem | Singlefile FS (`redb-js`) |
| --- | --- |
| A data directory (`pgdata/`) or multi-file OPFS pool (`OpfsAhpFS`) | Strictly **one** file (`postgres.pglite`) on disk or in Browser OPFS |
| PostgreSQL files under `base/`, `global/`, and `pg_wal/` | The same logical files stored as trimmed 8 KiB chunks inside one `redb` CoW container |
| Numerous host files and directories | Zero `-wal` / `-shm` sidecars even while open |
| Move or back up the whole PostgreSQL directory | Close cleanly, then copy or move the single file (portable between Node.js, Bun, Deno, and Browser OPFS) |

**Do not copy the file while an active writer is running.** Always await `db.close()` before copying or moving the image.

## Quick start

### Node.js, Bun, and Deno

```js
import { PGlite } from '@electric-sql/pglite';
import { SingleFileFS } from 'pglite-singlefile-fs';

const db = await PGlite.create({
  fs: new SingleFileFS('./postgres.pglite'),
  // Optional: coalesce back-to-back writes into atomic redb commits (~1.07x of native NodeFS):
  // relaxedDurability: true,
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

```js
import { PGlite } from '@electric-sql/pglite';
import { SingleFileFS } from 'pglite-singlefile-fs/browser';

// Persists to strictly ONE file in Origin Private File System (OPFS)
const fs = await SingleFileFS.open('postgres.pglite');
const db = await PGlite.create({ fs });

await db.exec('CREATE TABLE IF NOT EXISTS notes(id INT PRIMARY KEY, body TEXT NOT NULL)');
await db.query("INSERT INTO notes VALUES (1, 'Persisted in Browser OPFS!')");
await db.close();
```

For ephemeral or exportable in-memory images (browser main thread or server):

```js
const fs = await SingleFileFS.open(':memory:');
const db = await PGlite.create({ fs });
// ...
await db.close();
const portableBytes = fs.exportBytes(); // Uint8Array openable directly in Node.js, Bun, Deno, or Browser OPFS
```

## Durability, checkpoints, and compaction

- **`durable: true` (default)**: Every `commitChanges()` runs an atomic `redb` Copy-on-Write transaction with `Durability::Immediate` (`fs.fsyncSync` on Node/Bun/Deno, `syncHandle.flush()` on Browser OPFS). An abrupt crash (`SIGKILL`) mid-transaction recovers cleanly to the previous committed root with zero corruption.
- **`relaxedDurability: true` (PGlite option)**: Keeps full atomic `redb` `Durability::Immediate` commits on every background flush, while allowing back-to-back queries to coalesce into a single `fsync` commit (~25× faster on frequent single-row writes on macOS, ~1.07× of native `nodefs`). An abrupt crash before the background flush completes may roll back only the most recent un-flushed queries cleanly to the previous committed state.
- **`durable: false`**: Uses `redb` `Durability::None` (explicit unsafe mode; skips `fsync`).

For an explicit coordinated checkpoint and compaction:

```js
import { SingleFileFS, checkpoint } from 'pglite-singlefile-fs';

const filesystem = new SingleFileFS('./postgres.pglite');
const db = await PGlite.create({ fs: filesystem });

await checkpoint(db, filesystem, { mode: 'TRUNCATE' }); // runs PG CHECKPOINT, flushes, and compacts
await db.close();
```

## Memory and storage controls

```js
const filesystem = new SingleFileFS('./postgres.pglite', {
  cacheBytes: 0,                    // Optional adapter clean-page cache (default: 0)
  redbCacheBytes: 2 * 1024 * 1024,  // In-memory redb page cache (default: 2 MiB)
  pageSize: 8192,                   // Logical chunk size for new images (default: 8 KiB)
  compression: 'sparse',            // 'sparse' / 'zerobytemask' (default), 'bitsparse32', 'bitsparse16', 'lz4', or 'none'
});
```

PGlite's PostgreSQL `shared_buffers` remains the primary data cache. Transient dirty buffers are held in memory until `flush()` / `syncToFs()`. Each chunk carries a self-describing codec tag byte, so images can be reopened seamlessly under any `compression` setting.

## Performance

### Server-side: `redb-js` (WASM) vs SQLite (`node:sqlite`, Native C)

Measured on **Node.js v23.1.0, Apple Silicon macOS** — 1 warm-up + 3 alternating measured runs per variant, **with `fsync` disabled on both engines** (`durable: false` / `synchronous=OFF`, 98 MiB PostgreSQL `shared_buffers` + 2 MiB container cache) so filesystem sync does not skew engine speed.

| Metric | SQLite (`sync=OFF`, native C) | **`redb` `zerobytemask` (default)** | **`redb` `bitsparse32`** | **`redb` `lz4`** |
| --- | ---: | ---: | ---: | ---: |
| **`initdb` + startup** | 593.8 ms | **566.5 ms (`0.95×`)** | **568.0 ms (`0.96×`)** | 718.6 ms (`1.20×`) |
| `batchRead` (10,000 rows) | 21.8 ms | **21.8 ms (`1.00×`)** | **21.7 ms (`1.00×`)** | 22.2 ms (`1.02×`) |
| `batchInsert` (10,000 rows) | 18.4 ms | 19.8 ms (`1.08×`) | **19.0 ms (`1.03×`)** | 32.0 ms (`1.72×`) |
| `batchUpdate` (10,000 rows) | 28.5 ms | 30.9 ms (`1.08×`) | **30.3 ms (`1.06×`)** | 45.9 ms (`1.60×`) |
| `frequentRead` (500 lookups) | 72.7 ms | **72.8 ms (`1.00×`)** | 73.0 ms (`1.00×`) | **71.5 ms (`1.00×`)** |
| `frequentInsert` (500 inserts) | 77.0 ms | 78.1 ms (`1.01×`) | **78.0 ms (`1.01×`)** | 86.6 ms (`1.12×`) |
| `frequentUpdate` (500 updates) | 82.3 ms | 82.8 ms (`1.01×`) | **82.4 ms (`1.00×`)** | 91.5 ms (`1.13×`) |
| **Cold Reopen + Scan** | 60.5 ms | **50.5 ms (`0.83×`)** | **49.7 ms (`0.82×`)** | 63.4 ms (`1.03×`) |
| **Raw Closed File Size** | 34.52 MB | 35.66 MB (`1.03×`) | 35.66 MB (`1.03×`) | **17.83 MB (`0.52×`)** |
| **Compacted File Size** | 34.52 MB | **24.24 MB (`0.70×`)** | **27.60 MB (`0.80×`)** | **15.65 MB (`0.45×`)** |

### Browser OPFS: `SingleFileFS` (`redb-js`) vs PGlite Built-in `OpfsAhpFS`

Measured inside a **Headless Chrome Dedicated Web Worker** (2,000 batch / 100 frequent rows):

| Variant | `initMs` | `batchRead` | `batchInsert` | `batchUpdate` | `frequentRead` | `frequentInsert` | `frequentUpdate` | OPFS Files | OPFS Size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `OpfsAhpFS` (strict) | 827.6 ms | 5.5 ms | 4.7 ms | 7.8 ms | 12.1 ms | 60.8 ms | 33.3 ms | **1,079** | 40.54 MB |
| `OpfsAhpFS` (relaxed) | 807.3 ms | 5.0 ms | 3.7 ms | 6.0 ms | 9.2 ms | 10.9 ms | 12.2 ms | **1,071** | 40.54 MB |
| **`redb` `bitsparse16` (strict)** | **609.1 ms** | 5.5 ms | 8.3 ms | 10.8 ms | **8.7 ms** | 106.1 ms | 108.2 ms | **1** | **20.76 MB** |
| **`redb` `bitsparse16` (relaxed)** | **475.6 ms** | 5.6 ms | 7.2 ms | 9.9 ms | **9.1 ms** | **9.5 ms** | **11.4 ms** | **1** | **20.73 MB** |
| **`redb` `bitsparse16` (no-flush)** | **566.5 ms** | 5.1 ms | 4.5 ms | 7.0 ms | **8.7 ms** | **10.0 ms** | **10.8 ms** | **1** | **20.77 MB** |
| **`redb` `zerobytemask` (no-flush)** | **583.8 ms** | 5.1 ms | 4.7 ms | 7.2 ms | **8.8 ms** | **10.3 ms** | 13.0 ms | **1** | **19.02 MB** |
| **`redb` `lz4` (no-flush)** | **678.7 ms** | **5.0 ms** | 6.7 ms | 10.0 ms | **8.5 ms** | 11.9 ms | 13.3 ms | **1** | **17.83 MB** |

## Tests and benchmarks

```sh
npm run build         # TypeScript type-check
npm test              # Vitest suite (property traces, PGlite lifecycle, durability, SIGKILL crash recovery)
npm run test:browser  # Headless Chrome Browser OPFS persistence + OpfsAhpFS benchmark
npm run bench:sample  # Sampled NodeFS vs SingleFileFS benchmark + HTML report
npm run bench         # Vitest benchmark suite
```

## License

Apache License 2.0. See [LICENSE](LICENSE).
