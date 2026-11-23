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
  <a href="#durability--limits">Durability &amp; Limits</a> ·
  <a href="#cloudflare-durable-objects">Cloudflare DO</a>
</p>

</div>

A [`BaseFilesystem`](src/single-file-fs.mjs) adapter for [PGlite](https://github.com/electric-sql/pglite) backed by [`redb-js`](https://github.com/jbsiddall/redb-js) (a Copy-on-Write ACID B-tree in WebAssembly). PostgreSQL runs SQL, indexes, transactions, and extensions as usual; `SingleFileFS` stores the entire cluster as self-describing 8 KiB blocks inside **strictly one file** with **zero `-wal` or `-shm` sidecar files**.

> [!NOTE]
> **Pre-stable library.** Back up important data and review the [durability and single-writer limits](#durability--limits) before production use.

---

## Why SingleFileFS?

| Property | PGlite `NodeFS` / `OpfsAhpFS` | PGlite `IdbFs` (IndexedDB) | **`SingleFileFS`** |
| --- | --- | --- | --- |
| **Files / open handles** | ~977–1,079 host or OPFS files | Whole-file blobs + full `MEMFS` | **1 file / 1 handle** |
| **Safari & iOS browsers** | Unsupported on Safari ([docs](https://pglite.dev/docs/filesystems)) | Loads full DB into tab RAM | **1 OPFS handle + 8 MiB cache**\* |
| **Sidecars while open** | Multi-file directory / pool | IndexedDB object store | **None** (no `-wal` / `-shm`) |
| **Closed cluster size** | 40.8–42.3 MB | Whole-file blobs | **17.3–26.1 MB** (38–59% smaller) |
| **Cross-runtime format** | Directory or browser-specific | Browser-only | **1 portable file** (OPFS ↔ Server) |

<table>
<tr>
<td width="50%" valign="top">

### 1. Fits Safari OPFS &amp; mobile RAM limits

- PGlite's built-in `OpfsAhpFS` is unsupported in Safari ([PGlite Filesystems docs](https://pglite.dev/docs/filesystems)): `initdb` opens ~970–1,079 files, exceeding **Safari's 252 open `FileSystemSyncAccessHandle` limit** and even Linux Chromium's 1,024 soft FD default ([electric-sql/pglite#1064](https://github.com/electric-sql/pglite/pull/1064)).
- PGlite's `IdbFs` fallback wraps [Emscripten `IDBFS`](https://emscripten.org/docs/api_reference/Filesystem-API.html), syncing the whole database into in-memory `MEMFS` on boot. On iOS/iPadOS Safari, per-process [Jetsam memory limits](https://developer.apple.com/documentation/xcode/identifying-high-memory-use-with-jetsam-event-reports) scale with device RAM and are shared with your app and WASM heap, putting medium/large databases at risk of tab reloads.
- `SingleFileFS` opens **1** OPFS [`FileSystemSyncAccessHandle`](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle) ([WebKit OPFS](https://webkit.org/blog/12257/the-file-system-access-api-with-origin-private-file-system/)) and pages 8 KiB blocks on demand through a bounded page cache (default `8 MiB`).

</td>
<td width="50%" valign="top">

### 2. Strictly 1 file, zero sidecars, full Postgres

- Even while open, every table, index, and WAL segment stays inside **1 file** — no `-wal` or `-shm` sidecar files ([SQLite WAL docs](https://www.sqlite.org/wal.html)), backed by [`redb`](https://github.com/cberner/redb) Copy-on-Write transactions (verified in [`tests/crash.test.ts`](tests/crash.test.ts) and [`scripts/runtime-worker.mjs`](scripts/runtime-worker.mjs)).
- You keep full PostgreSQL (JSONB, CTEs, partial/GIN indexes, constraints, extensions) with startup, warm-read, reopen, and `relaxedDurability` write speeds **on par with or faster than** PGlite's built-in VFS ([benchmarks](#benchmarks)).
- **Tradeoffs to weigh:** 10k-row batch writes are `1.43–1.89×` `NodeFS`, strict macOS `F_FULLFSYNC` adds ~4 ms/commit, and PGlite + `redb` remain single-writer only.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 3. Byte-for-byte portable across runtimes

- Uses one `PGSF` v3 binary layout ([`src/container-format.mjs`](src/container-format.mjs)) across Node.js, Bun, Deno, Browser OPFS, and `:memory:` (`exportBytes()`).
- Call `await db.close()`, copy the single `.pglite` file from Browser OPFS to a server (or pre-seed a `.pglite` image on a server and ship it to clients), and open it directly without conversion (verified in [`tests/filesystem.property.test.ts`](tests/filesystem.property.test.ts) and [`scripts/browser-pglite-test.mjs`](scripts/browser-pglite-test.mjs)).
- Also includes [`DurableObjectStore`](src/durable-object-store.mjs) for Cloudflare Durable Objects with redb-to-DO seeding ([`examples/cloudflare-do`](examples/cloudflare-do/README.md)).

</td>
<td width="50%" valign="top">

### 4. 38–59% smaller on disk and in OPFS

- Default `'sparse'` encoding strips PostgreSQL's empty page holes and pre-zeroed WAL/relation blocks with minimal CPU cost ([`src/chunk-codec.mjs`](src/chunk-codec.mjs)); optional `'lz4'` shrinks files further.
- **Browser OPFS** ([`browser-pglite-test.mjs`](scripts/browser-pglite-test.mjs)): **18.19 MB** (`sparse`) / **17.83 MB** (`lz4`) vs **40.76 MB** for `OpfsAhpFS` (**55–56% smaller**).
- **Node.js** ([`node23-macos-arm64.json`](docs/benchmarks/node23-macos-arm64.json)): **26.05 MB** compacted (`23.62 MB` with `full_page_writes=off`, **17.29 MB** with `lz4`) vs **42.25 MB** for `NodeFS` (**38–59% smaller**).

</td>
</tr>
</table>

<sub>\* <strong>Verification note:</strong> Automated browser CI currently verifies single-handle OPFS persistence across restarts in headless Chrome (<code>scripts/browser-pglite-test.mjs</code> — 1 OPFS file vs 1,071–1,079 for <code>OpfsAhpFS</code>). Automated Safari/WebKit CI is not yet configured; Safari OPFS compatibility relies on WebKit's single-handle <code>FileSystemSyncAccessHandle</code> support.</sub>

---

## Quick Start

**Requirements:** Node.js `>=18`, Bun, or Deno (zero native addons); modern browsers with OPFS `FileSystemSyncAccessHandle` in a Dedicated Web Worker (or `:memory:` on the main thread); peer dependency `@electric-sql/pglite` (`^0.5.8`).

```sh
npm install pglite-singlefile-fs @electric-sql/pglite
# or directly from GitHub:
npm install git+https://github.com/jbsiddall/pglite-singlefile-fs.git @electric-sql/pglite
```

### Node.js, Bun, and Deno

```js
import { PGlite } from '@electric-sql/pglite';
import { SingleFileFS } from 'pglite-singlefile-fs';

const fs = new SingleFileFS('./postgres.pglite');
const db = await PGlite.create({
  fs,
  // Optional: SIGKILL-safe CoW commits without per-query fsync (synced on flush() / close())
  relaxedDurability: true,
  // Optional: safe on CoW SingleFileFS because torn 8 KiB pages cannot occur
  startParams: [...PGlite.defaultStartParams, ...SingleFileFS.recommendedStartParams],
});

await db.exec('CREATE TABLE IF NOT EXISTS notes (id INT PRIMARY KEY, body TEXT NOT NULL)');
await db.query('INSERT INTO notes VALUES ($1, $2)', [1, 'Hello, PostgreSQL']);
console.log((await db.query('SELECT * FROM notes')).rows);
await db.close();
```

### Browser OPFS (Dedicated Web Worker)

```js
import { PGlite } from '@electric-sql/pglite';
import { SingleFileFS } from 'pglite-singlefile-fs/browser';

// Persists to strictly 1 OPFS file via 1 FileSystemSyncAccessHandle
const fs = await SingleFileFS.open('postgres.pglite');
const db = await PGlite.create({
  fs,
  relaxedDurability: true, // matches OpfsAhpFS relaxed speed using 1 file
});

await db.exec('CREATE TABLE IF NOT EXISTS notes (id INT PRIMARY KEY, body TEXT NOT NULL)');
await db.query("INSERT INTO notes VALUES (1, 'Persisted in Browser OPFS')");
await db.close();
```

<details>
<summary><strong>In-memory export (<code>exportBytes()</code>) &amp; portable transfer</strong></summary>

Works on the browser main thread or on servers:

```js
import { PGlite } from '@electric-sql/pglite';
import { SingleFileFS } from 'pglite-singlefile-fs/browser'; // or 'pglite-singlefile-fs'

const fs = await SingleFileFS.open(':memory:');
const db = await PGlite.create({ fs });
await db.exec('CREATE TABLE t (id INT PRIMARY KEY)');
await db.query('INSERT INTO t VALUES (1)');
await db.close();

// Standard single-file container bytes — openable in Node.js, Bun, Deno, or Browser OPFS
const bytes = fs.exportBytes();
```

</details>

<details>
<summary><strong>Checkpoints &amp; compaction</strong></summary>

```js
import { PGlite } from '@electric-sql/pglite';
import { SingleFileFS, checkpoint } from 'pglite-singlefile-fs';

const fs = new SingleFileFS('./postgres.pglite');
const db = await PGlite.create({ fs });

// Runs PostgreSQL CHECKPOINT, flushes durably, and compacts free redb pages
await checkpoint(db, fs, { compact: true });
await db.close();
```

`db.close()` writes a final PostgreSQL shutdown checkpoint. For the smallest closed file before archiving or uploading, compact on close (`await fs.closeFs({ compact: true })`) or reopen and call `fs.compact()`.

</details>

## Cloudflare Durable Objects

`SingleFileFS` accepts an external KV store via `options.store` (skipping `redb` WASM loading inside Workers). [`DurableObjectStore`](src/durable-object-store.mjs) adapts Cloudflare's `ctx.storage.sql` and `ctx.storage.transactionSync` using a single DO-legal `_pgsf_kv (tbl, k, v) WITHOUT ROWID` table.

<details>
<summary><strong>Durable Object usage &amp; authenticated PostgreSQL WebSocket example</strong></summary>

```js
import { PGlite } from '@electric-sql/pglite';
import { SingleFileFS, DurableObjectStore } from 'pglite-singlefile-fs/browser';

const store = new DurableObjectStore(
  this.ctx.storage.sql,
  fn => this.ctx.storage.transactionSync(fn),
);
const fs = new SingleFileFS('do', { store });
const db = await PGlite.create({ fs /* + precompiled Worker WASM/data assets */ });
```

See [`examples/cloudflare-do/README.md`](examples/cloudflare-do/README.md) for the complete Worker, authenticated PostgreSQL `/ws` transport (`psql`, Drizzle, Prisma), redb-to-DO seeding script, and [`docs/CLOUDFLARE-COMPARISON.md`](docs/CLOUDFLARE-COMPARISON.md) for production probe limits.

</details>

---

## Benchmarks

All measurements compare `SingleFileFS` directly against PGlite's built-in persistent filesystems (`NodeFS` on server, `OpfsAhpFS` in Browser OPFS) with verified row counts and checksums. Timings reflect the recorded hardware, not cross-machine guarantees; raw JSON snapshots and methodology live in [`docs/benchmarks/README.md`](docs/benchmarks/README.md).

### Node.js: `SingleFileFS` vs built-in `NodeFS`

**Environment:** Node.js `v23.1.0`, Apple M2 macOS (`darwin/arm64`) — 1 excluded warm-up + 3 alternating fresh-process runs, **100 MiB total page-cache budget** (`NodeFS`: 100 MiB `shared_buffers`; `SingleFileFS`: 92 MiB `shared_buffers` + 8 MiB `redb` cache), 10,000-row batch / 500 single-row frequent ops including `flush()`. Raw receipt: [`docs/benchmarks/node23-macos-arm64.json`](docs/benchmarks/node23-macos-arm64.json).

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
| **Host files on disk** | 977 | **1** | **1** | **1** |
| **Compacted closed size** | 42.25 MB | **26.05 MB (`0.62×`)** | **17.29 MB (`0.41×`)** | **26.10 MB (`0.62×`)** |

<sub>\* <strong>Durability disclosure:</strong> Built-in <code>NodeFS</code> runs PostgreSQL with <code>fsync=off</code> (0 hardware syncs). <code>SingleFileFS (strict)</code> runs 500 <code>redb</code> <code>Durability::Immediate</code> commits with macOS <code>F_FULLFSYNC</code> (~4.1 ms/call on Apple NVMe; Linux <code>fdatasync</code> is typically ~0.05–0.3 ms/call). <code>SingleFileFS (relaxed)</code> commits atomically to the OS page cache (SIGKILL-safe) and hardware-syncs on <code>flush()</code> / <code>close()</code>.</sub>

<details>
<summary><strong>Additional Node.js variant: <code>relaxed + full_page_writes=off</code> &amp; raw uncompacted sizes</strong></summary>

With `startParams: [...PGlite.defaultStartParams, ...SingleFileFS.recommendedStartParams]` (`full_page_writes=off`, safe because `redb` CoW eliminates torn 8 KiB pages):
- `initdb`: **534.2 ms** (`0.80×`), `batchUpdate`: **37.0 ms** (`1.43×`), cold reopen: **50.4 ms** (`0.84×`), compacted size: **23.62 MB** (`0.56×`).
- Raw uncompacted closed sizes: `sparse` **35.66 MB** (`0.84×`), `lz4` **17.83 MB** (`0.42×`) vs `NodeFS` **42.25 MB**.

</details>

### Browser WASM OPFS: `SingleFileFS` vs built-in `OpfsAhpFS`

**Environment:** Headless Chrome `157.0.8103.80` Dedicated Web Worker on Apple M2 macOS, `@electric-sql/pglite@0.5.17`, single un-warmed run per variant via [`scripts/browser-pglite-test.mjs`](scripts/browser-pglite-test.mjs) (2,000-row batch / 100 single-row frequent ops, default 8 MiB `redb` cache, including `flush()` settle time).

| Metric | `OpfsAhpFS` (`relaxed`) | `SingleFileFS` (`relaxed`) | `SingleFileFS lz4` (`relaxed`) | `SingleFileFS` (`strict`) |
| --- | ---: | ---: | ---: | ---: |
| **`initdb` + startup** | 795.9 ms | **453.9 ms (`0.57×`)** | **450.4 ms (`0.57×`)** | **571.8 ms (`0.72×`)** |
| `batchRead` (2k rows) | 5.3 ms | 5.4 ms (`1.02×`) | **5.0 ms (`0.94×`)** | **5.2 ms (`0.98×`)** |
| `batchInsert` (2k rows) | 3.3 ms | 5.1 ms (`1.55×`) | 6.8 ms (`2.06×`) | 5.4 ms (`1.64×`) |
| `batchUpdate` (2k rows) | 5.5 ms | 7.1 ms (`1.29×`) | 9.4 ms (`1.71×`) | 7.4 ms (`1.35×`) |
| `frequentRead` (100 ops) | 5.4 ms | **5.1 ms (`0.94×`)** | **4.8 ms (`0.89×`)** | **5.2 ms (`0.96×`)** |
| `frequentInsert` (100 ops) | 7.3 ms | 7.7 ms (`1.05×`) | **5.9 ms (`0.81×`)** | 101.9 ms\* |
| `frequentUpdate` (100 ops) | 7.6 ms | **6.2 ms (`0.82×`)** | **6.2 ms (`0.82×`)** | 96.6 ms\* |
| **OPFS files created** | 1,071 | **1** | **1** | **1** |
| **Total OPFS size** | 40.76 MB | **18.19 MB (`0.45×`)** | **17.83 MB (`0.44×`)** | **18.20 MB (`0.45×`)** |

<sub>\* In strict mode, per-query <code>syncHandle.flush()</code> accounts for ~85% of single-row write latency (vs 44.8 ms / 32.4 ms on <code>OpfsAhpFS strict</code>).</sub>

<details>
<summary><strong>Full 6-variant Browser OPFS table (including <code>OpfsAhpFS strict</code> &amp; <code>no-flush</code>)</strong></summary>

| Metric | `OpfsAhpFS` (`strict`) | `SingleFileFS` (`no-flush`) |
| --- | ---: | ---: |
| `initdb` + startup | 865.7 ms | 522.0 ms |
| `batchRead` / `batchInsert` / `batchUpdate` | 5.5 / 4.6 / 7.0 ms | 5.0 / 3.7 / 6.2 ms |
| `frequentRead` / `frequentInsert` / `frequentUpdate` | 7.7 / 44.8 / 32.4 ms | 5.1 / 6.4 / 7.8 ms |
| OPFS files / size | 1,079 / 40.76 MB | 1 / 18.19 MB |

</details>

---

## Durability & Limits

### Durability modes

| Mode | Commit path | Crash &amp; power-loss behavior |
| --- | --- | --- |
| **Strict** (`durable: true`, `relaxedDurability: false`) — *default* | Per-query atomic `redb` CoW commit + hardware `fdatasync` / `fsync` / OPFS `flush()` | Survives `SIGKILL` and sudden power loss; recovers cleanly to the last committed root |
| **Relaxed** (`durable: true`, `relaxedDurability: true`) — *recommended for interactive apps* | Coalesced atomic `redb` CoW commits to OS page cache / OPFS; hardware sync on `flush()` / `close()` | Survives `SIGKILL` and tab crashes with zero corruption; power loss before `flush()`/`close()` rolls back only the unsynced window cleanly |
| **Unsafe** (`durable: false`) | `redb` `Durability::None` (skips commit flushes and hardware syncs) | Not crash-safe; for disposable scratch databases only |

### Operational limits

- **Single writer only:** PGlite is single-connection embedded PostgreSQL and `redb` enforces a single-writer file lock. Do not open the same `.pglite` file concurrently across processes, workers, or browser tabs.
- **Close before copying:** Always `await db.close()` before copying, uploading, or moving the database file.
- **Foreign file protection:** Opening an existing non-empty file validates the `redb` header and `PGSF` v3 schema without mutating the file (unclean foreign `redb` files are inspected in a RAM-only overlay) and rejects unrecognized files untouched ([`src/container-format.mjs`](src/container-format.mjs)).

<details>
<summary><strong>Configuration options (<code>SingleFileFSOptions</code>)</strong></summary>

```js
const fs = new SingleFileFS('./postgres.pglite', {
  durable: true,                   // Hardware-sync durability contract (default: true)
  redbCacheBytes: 8 * 1024 * 1024, // In-memory redb page cache in WASM (default: 8 MiB)
  cacheBytes: 0,                   // Optional adapter clean-page cache (default: 0)
  pageSize: 8192,                  // Logical chunk size for new images (default: 8 KiB)
  compression: 'sparse',           // 'sparse' (default), 'bitsparse32', 'bitsparse16', 'lz4', or 'none'
});
```

- PostgreSQL's `shared_buffers` remains the primary SQL cache; `redbCacheBytes` bounds `redb` B-tree caching inside WASM.
- Every stored chunk carries a self-describing codec tag byte, so an existing image can be reopened under any `compression` setting.

</details>

<details>
<summary><strong>Tests, verification receipts &amp; local benchmarks</strong></summary>

```sh
npm run build         # TypeScript declaration check (src/index.d.ts + tests)
npm test              # Vitest: property traces, PGlite lifecycle, durability, SIGKILL recovery, Durable Objects & WS
npm run test:browser  # Headless Chrome OPFS persistence across restart + OpfsAhpFS benchmark
npm run bench:sample  # Fresh-process alternating NodeFS vs SingleFileFS benchmark + HTML report
npm run bench         # Vitest benchmark suite
npm run bench:big     # Opt-in 5 GiB two-table join benchmark (needs ~12 GiB free disk)
```

Verification receipts and historical CI diagnostics live in [`docs/VALIDATION.md`](docs/VALIDATION.md) and [`docs/benchmarks/README.md`](docs/benchmarks/README.md).

</details>

---

## Roadmap &amp; License

- **Roadmap:** Align with [PGlite](https://github.com/electric-sql/pglite) so single-file storage is straightforward to adopt or provide upstream ([issue #1](https://github.com/jbsiddall/pglite-singlefile-fs/issues/1)).
- **Maintenance:** Supervised by Joseph Siddall. Issues and pull requests from humans and AI coding agents are welcome; maintainers vet all changes for correctness, durability, and evidence.
- **License:** [Apache License 2.0](LICENSE).
