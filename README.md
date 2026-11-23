<div align="center">

# PGlite Singlefile FS

**Embedded PostgreSQL in one portable file — Node.js, Bun, Deno, Browser OPFS, and Cloudflare Durable Objects.**

[![CI](https://github.com/jbsiddall/pglite-singlefile-fs/actions/workflows/ci.yml/badge.svg)](https://github.com/jbsiddall/pglite-singlefile-fs/actions/workflows/ci.yml)
[![Latest Release](https://img.shields.io/github/v/release/jbsiddall/pglite-singlefile-fs?label=release)](https://github.com/jbsiddall/pglite-singlefile-fs/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

<p>
  <a href="#why-singlefilefs">Why SingleFileFS</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#benchmarks">Benchmarks</a> ·
  <a href="#durability--limits">Durability &amp; Limits</a>
</p>

</div>

A [`BaseFilesystem`](src/single-file-fs.mjs) for [PGlite](https://github.com/electric-sql/pglite) backed by [`redb-js`](https://github.com/jbsiddall/redb-js) (a Copy-on-Write ACID B-tree in WebAssembly). Keep full PostgreSQL inside **strictly 1 file** with **zero `-wal` or `-shm` sidecars**.

> [!NOTE]
> Pre-stable library. Back up important data and review [Durability &amp; Limits](#durability--limits) before production use.

---

## Why SingleFileFS?

| | PGlite `NodeFS` / `OpfsAhpFS` | PGlite `IdbFs` (IndexedDB) | **`SingleFileFS`** |
| --- | --- | --- | --- |
| **Files / handles** | ~977–1,079 files | Whole-file blobs + full `MEMFS` | **1 file / 1 handle** |
| **Safari &amp; iOS** | Fails 252 OPFS handle cap | Loads entire DB into tab RAM | **1 OPFS handle + 8 MiB cache**\* |
| **Sidecars while open** | Multi-file dir / pool | IndexedDB store | **None** (no `-wal` / `-shm`) |
| **Closed size** | 40.8–42.3 MB | Whole-file blobs | **17.3–26.1 MB** (38–59% smaller) |
| **Portability** | Directory / browser-bound | Browser-only | **Copy 1 file** (OPFS ↔ Server) |

- **Works within Safari OPFS &amp; mobile memory limits:** Built-in `OpfsAhpFS` is unsupported in Safari ([PGlite docs](https://pglite.dev/docs/filesystems)) because `initdb` opens ~970–1,079 files, exceeding Safari's 252 `FileSystemSyncAccessHandle` cap and Linux Chromium's 1,024 soft FD default ([pglite#1064](https://github.com/electric-sql/pglite/pull/1064)). The `IdbFs` fallback ([Emscripten `IDBFS`](https://emscripten.org/docs/api_reference/Filesystem-API.html)) loads the entire DB into `MEMFS` RAM on boot, risking iOS/iPadOS [Jetsam](https://developer.apple.com/documentation/xcode/identifying-high-memory-use-with-jetsam-event-reports) tab kills. `SingleFileFS` opens **1** [OPFS handle](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle) ([WebKit](https://webkit.org/blog/12257/the-file-system-access-api-with-origin-private-file-system/)) and pages 8 KiB blocks on demand via an 8 MiB cache.\*
- **Strictly 1 file, full PostgreSQL:** [`redb`](https://github.com/cberner/redb) Copy-on-Write commits avoid `-wal` / `-shm` sidecars even while open ([SQLite WAL](https://www.sqlite.org/wal.html), [`tests/crash.test.ts`](tests/crash.test.ts)). Startup, reads, cold reopen, and `relaxedDurability` writes match or beat built-in PGlite VFS (tradeoffs: 10k-row batch writes are `1.4–1.9×` `NodeFS`; single-writer only).
- **Portable across runtimes:** One `PGSF` v3 format ([`src/container-format.mjs`](src/container-format.mjs)) across Node.js, Bun, Deno, Browser OPFS, and `:memory:` (`exportBytes()`). Call `await db.close()`, copy the file from OPFS to a server (or vice versa), and open directly.
- **38–59% smaller:** Default `'sparse'` encoding elides PostgreSQL zero holes ([`src/chunk-codec.mjs`](src/chunk-codec.mjs)) — **18.2 MB** vs **40.8 MB** `OpfsAhpFS` ([browser test](scripts/browser-pglite-test.mjs)) and **26.1 MB** (**17.3 MB** `lz4`) vs **42.3 MB** `NodeFS` ([raw JSON](docs/benchmarks/node23-macos-arm64.json)).

<sub>\* Automated browser CI currently verifies single-handle OPFS persistence in headless Chrome (<code>scripts/browser-pglite-test.mjs</code>); automated Safari/WebKit CI is not yet configured.</sub>

---

## Quick Start

Requires Node.js `>=18`, Bun, Deno, or a browser Dedicated Web Worker with OPFS `FileSystemSyncAccessHandle` (zero native addons; peer dep `@electric-sql/pglite ^0.5.8`).

```sh
npm install pglite-singlefile-fs @electric-sql/pglite
```

### Node.js, Bun, and Deno

```js
import { PGlite } from '@electric-sql/pglite';
import { SingleFileFS } from 'pglite-singlefile-fs';

const fs = new SingleFileFS('./postgres.pglite');
const db = await PGlite.create({
  fs,
  relaxedDurability: true, // optional: SIGKILL-safe CoW commits; hardware-synced on flush()/close()
  startParams: [...PGlite.defaultStartParams, ...SingleFileFS.recommendedStartParams], // full_page_writes=off
});

await db.exec('CREATE TABLE IF NOT EXISTS notes (id INT PRIMARY KEY, body TEXT NOT NULL)');
await db.query('INSERT INTO notes VALUES ($1, $2)', [1, 'Hello, PostgreSQL']);
await db.close();
```

### Browser OPFS (Dedicated Web Worker)

```js
import { PGlite } from '@electric-sql/pglite';
import { SingleFileFS } from 'pglite-singlefile-fs/browser';

const fs = await SingleFileFS.open('postgres.pglite');
const db = await PGlite.create({ fs, relaxedDurability: true });

await db.exec('CREATE TABLE IF NOT EXISTS notes (id INT PRIMARY KEY, body TEXT NOT NULL)');
await db.query("INSERT INTO notes VALUES (1, 'Persisted in Browser OPFS')");
await db.close();
```

<details>
<summary><strong>More usage: <code>:memory:</code> export, checkpoints/compaction, Cloudflare Durable Objects &amp; options</strong></summary>

#### In-memory export (`exportBytes()`)
```js
const fs = await SingleFileFS.open(':memory:');
const db = await PGlite.create({ fs });
await db.exec('CREATE TABLE t (id INT PRIMARY KEY)');
await db.close();
const bytes = fs.exportBytes(); // portable .pglite container bytes
```

#### Checkpoint &amp; compaction
```js
import { checkpoint } from 'pglite-singlefile-fs';
await checkpoint(db, fs, { compact: true }); // CHECKPOINT + flush + compact
await fs.closeFs({ compact: true });         // smallest closed file before archiving
```

#### Cloudflare Durable Objects (`DurableObjectStore`)
Pass a [`DurableObjectStore`](src/durable-object-store.mjs) via `options.store` (skips `redb` WASM loading inside Workers; persists to a single DO-legal `_pgsf_kv` table). See [`examples/cloudflare-do/README.md`](examples/cloudflare-do/README.md) for the Worker, authenticated PostgreSQL `/ws` bridge (`psql`, Drizzle, Prisma), and [`docs/CLOUDFLARE-COMPARISON.md`](docs/CLOUDFLARE-COMPARISON.md).

#### Options (`SingleFileFSOptions`)
```js
new SingleFileFS('./postgres.pglite', {
  durable: true,                   // Hardware sync contract (default: true)
  redbCacheBytes: 8 * 1024 * 1024, // In-memory redb page cache (default: 8 MiB)
  cacheBytes: 0,                   // Optional adapter clean-page cache (default: 0)
  pageSize: 8192,                  // Logical chunk size for new images (default: 8 KiB)
  compression: 'sparse',           // 'sparse' (default), 'bitsparse32', 'bitsparse16', 'lz4', 'none'
});
```

</details>

---

## Benchmarks

Compared directly against PGlite's built-in `NodeFS` and `OpfsAhpFS` with verified row counts and checksums (Apple M2 macOS; raw receipts &amp; methodology in [`docs/benchmarks/README.md`](docs/benchmarks/README.md)).

### Node.js (`v23.1.0`, 100 MiB cache budget, 3 alternating runs — [JSON](docs/benchmarks/node23-macos-arm64.json))

| Metric | `NodeFS` (`fsync=off`) | `SingleFileFS` (`relaxed`) | `SingleFileFS lz4` (`relaxed`) | `SingleFileFS` (`strict`) |
| --- | ---: | ---: | ---: | ---: |
| **`initdb` + startup** | 669.4 ms | **536.9 ms (`0.80×`)** | **531.5 ms (`0.79×`)** | **622.4 ms (`0.93×`)** |
| `batchRead` (10k rows) | 24.0 ms | 24.1 ms (`1.00×`) | **23.6 ms (`0.98×`)** | **22.7 ms (`0.95×`)** |
| `batchInsert` (10k rows) | 16.2 ms | 30.6 ms (`1.89×`) | 31.8 ms (`1.96×`) | 31.7 ms (`1.96×`) |
| `batchUpdate` (10k rows) | 25.8 ms | 39.0 ms (`1.51×`) | 45.0 ms (`1.74×`) | 40.0 ms (`1.55×`) |
| `frequentRead` (500 ops) | 75.2 ms | **71.6 ms (`0.95×`)** | **71.7 ms (`0.95×`)** | **73.3 ms (`0.97×`)** |
| `frequentInsert` (500 ops) | 71.1 ms | 73.0 ms (`1.03×`) | 72.8 ms (`1.02×`) | 2,118.7 ms (`29.8×`)\* |
| `frequentUpdate` (500 ops) | 77.0 ms | 77.3 ms (`1.00×`) | 77.8 ms (`1.01×`) | 2,230.0 ms (`29.0×`)\* |
| **Cold reopen + scan** | 60.1 ms | **51.3 ms (`0.85×`)** | 60.3 ms (`1.00×`) | 76.9 ms (`1.28×`) |
| **Host files / compacted size** | 977 / 42.25 MB | **1 / 26.05 MB (`0.62×`)** | **1 / 17.29 MB (`0.41×`)** | **1 / 26.10 MB (`0.62×`)** |

<sub>\* <code>NodeFS</code> runs with <code>fsync=off</code>; <code>SingleFileFS (strict)</code> calls macOS <code>F_FULLFSYNC</code> (~4.1 ms/call; Linux <code>fdatasync</code> is typically ~0.05–0.3 ms). With <code>full_page_writes=off</code>, <code>SingleFileFS (relaxed)</code> compacts to <strong>23.62 MB (<code>0.56×</code>)</strong> and reopens in <strong>50.4 ms</strong>.</sub>

### Browser OPFS (Chrome `157.0.8103.80` Worker, `pglite@0.5.17` — [script](scripts/browser-pglite-test.mjs))

| Metric | `OpfsAhpFS` (`relaxed`) | `SingleFileFS` (`relaxed`) | `SingleFileFS lz4` (`relaxed`) | `SingleFileFS` (`strict`) |
| --- | ---: | ---: | ---: | ---: |
| **`initdb` + startup** | 795.9 ms | **453.9 ms (`0.57×`)** | **450.4 ms (`0.57×`)** | **571.8 ms (`0.72×`)** |
| `batchRead` (2k rows) | 5.3 ms | 5.4 ms (`1.02×`) | **5.0 ms (`0.94×`)** | **5.2 ms (`0.98×`)** |
| `batchInsert` (2k rows) | 3.3 ms | 5.1 ms (`1.55×`) | 6.8 ms (`2.06×`) | 5.4 ms (`1.64×`) |
| `batchUpdate` (2k rows) | 5.5 ms | 7.1 ms (`1.29×`) | 9.4 ms (`1.71×`) | 7.4 ms (`1.35×`) |
| `frequentRead` (100 ops) | 5.4 ms | **5.1 ms (`0.94×`)** | **4.8 ms (`0.89×`)** | **5.2 ms (`0.96×`)** |
| `frequentInsert` (100 ops) | 7.3 ms | 7.7 ms (`1.05×`) | **5.9 ms (`0.81×`)** | 101.9 ms\* |
| `frequentUpdate` (100 ops) | 7.6 ms | **6.2 ms (`0.82×`)** | **6.2 ms (`0.82×`)** | 96.6 ms\* |
| **OPFS files / total size** | 1,071 / 40.76 MB | **1 / 18.19 MB (`0.45×`)** | **1 / 17.83 MB (`0.44×`)** | **1 / 18.20 MB (`0.45×`)** |

<sub>\* Strict mode calls per-query <code>syncHandle.flush()</code> (vs 44.8 ms / 32.4 ms on <code>OpfsAhpFS strict</code>, which uses 1,079 files / 40.76 MB).</sub>

---

## Durability &amp; Limits

| Mode | Commit path | Crash / power-loss guarantee |
| --- | --- | --- |
| **Strict** *(default)* | Per-query CoW commit + hardware `fdatasync` / `fsync` / OPFS `flush()` | Survives `SIGKILL` and sudden power loss |
| **Relaxed** (`relaxedDurability: true`) | Coalesced CoW commits to OS/OPFS; hardware sync on `flush()` / `close()` | Survives `SIGKILL` / tab crashes; power loss rolls back only the unsynced window cleanly |
| **Unsafe** (`durable: false`) | `redb` `Durability::None` (skips commit flushes) | Not crash-safe; disposable scratch use only |

- **Single writer only:** Do not open the same `.pglite` file concurrently from multiple processes, workers, or browser tabs.
- **Close before copying:** Always `await db.close()` before copying, uploading, or moving the file.
- **Foreign-file safety:** Non-`PGSF` files (including unclean foreign `redb` files) are rejected untouched ([`src/container-format.mjs`](src/container-format.mjs)).

<details>
<summary><strong>Tests, verification receipts &amp; local benchmarks</strong></summary>

```sh
npm run build         # TypeScript declaration check
npm test              # Vitest: property traces, lifecycle, durability, SIGKILL, Durable Objects & WS
npm run test:browser  # Headless Chrome OPFS persistence across restart + OpfsAhpFS benchmark
npm run bench:sample  # Fresh-process alternating NodeFS vs SingleFileFS benchmark + HTML report
```

See [`docs/VALIDATION.md`](docs/VALIDATION.md) and [`docs/benchmarks/README.md`](docs/benchmarks/README.md) for raw receipts and CI diagnostics.

</details>

---

[Roadmap (issue #1)](https://github.com/jbsiddall/pglite-singlefile-fs/issues/1) · Supervised by Joseph Siddall · [Apache License 2.0](LICENSE)
