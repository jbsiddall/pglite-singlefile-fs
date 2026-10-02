# PGlite Singlefile FS

[![CI](https://github.com/jbsiddall/pglite-singlefile-fs/actions/workflows/ci.yml/badge.svg)](https://github.com/jbsiddall/pglite-singlefile-fs/actions/workflows/ci.yml)
[Latest release](https://github.com/jbsiddall/pglite-singlefile-fs/releases/latest)

**Embedded PostgreSQL. One portable database file.**

A virtual filesystem for [PGlite](https://github.com/electric-sql/pglite) that keeps its PostgreSQL files inside one container instead of a directory containing hundreds of files. PGlite still runs the SQL, indexes, transactions, and supported extensions; this adapter changes where its file bytes live.

The goal is **the power of PostgreSQL in a single portable database file**, easy to embed in Node.js, Deno, and Bun applications.

> Early-stage library. Treat the format and API as pre-stable, back up important data, and read the durability and concurrency limits below. Runtime and platform coverage is established by the actual CI results, not by the existence of a matrix configuration.

## What changes?

| PGlite's native filesystem | Singlefile FS |
| --- | --- |
| A data directory such as `pgdata/` | One main file such as `postgres.db` |
| PostgreSQL files under `base/`, `global/`, and `pg_wal/` | The same logical files stored inside the container |
| Numerous host files and directories | Temporary `postgres.db-wal` and `postgres.db-shm` sidecars while open in WAL mode |
| Move or back up the whole PostgreSQL data directory correctly | Close cleanly, then move the main database file |

**One main file does not mean safe to copy while open.** An active database may have committed data in its WAL sidecar. Do not copy only the main file during a running session or after a crash. Close cleanly first, or use a separately verified backup procedure that preserves a consistent image and recovery data.

## Start from source

The repository is usable from source. These instructions do not imply a package has already been published to npm.

```sh
git clone https://github.com/jbsiddall/pglite-singlefile-fs.git
cd pglite-singlefile-fs
npm ci
```

Create a script in the repository:

```js
import { PGlite } from '@electric-sql/pglite';
import { SingleFileFS } from './src/index.mjs';

const db = await PGlite.create({
  fs: new SingleFileFS('./postgres.db'),
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

Reopen with the same filename to query existing rows and continue writing. Always await `db.close()` before moving the image.

## Durability and checkpoints

The default container uses WAL with full synchronization. Its durability settings remain distinct from PostgreSQL's own settings. PGlite's `relaxedDurability` controls whether queries wait for persistence; relaxed mode permits an outstanding flush, and clean shutdown must drain it.

For an explicit coordinated checkpoint:

```js
import { checkpoint } from './src/index.mjs';

const filesystem = new SingleFileFS('./postgres.db');
const db = await PGlite.create({ fs: filesystem });

// After the application has finished the relevant writes:
const status = await checkpoint(db, filesystem);
if (status.busy !== 0) throw new Error('Container checkpoint is incomplete');
await db.close();
```

This requests a PostgreSQL checkpoint, flushes pending container changes, and asks SQLite to checkpoint and truncate its WAL. The returned checkpoint status must show success; a busy result means truncation is incomplete. PostgreSQL can recycle its WAL segments, so deletion or truncation of `pg_wal` files is not a reliable automatic checkpoint signal. Automatic PostgreSQL and container checkpoints otherwise remain independent.

## Memory and storage controls

```js
const filesystem = new SingleFileFS('./postgres.db', {
  cacheBytes: 0,                    // No adapter clean-page cache.
  sqliteCacheKiB: 2000,             // Small container pager cache.
  walAutoCheckpointBytes: 32 * 1024 * 1024,
});
```

PGlite's PostgreSQL page cache remains the primary data cache. The adapter reuses prepared statements and filesystem metadata, and temporarily holds dirty chunks until a flush. The pager limit is not a whole-process RAM cap: PostgreSQL memory, runtime memory, dirty buffers, metadata, and the operating system's page cache are additional.

**Transient dirty buffers are currently unbounded.** A single very large query or transaction can accumulate many changed chunks before its persistence boundary and use much more memory than `sqliteCacheKiB` suggests. Batch large imports into bounded transactions; do not treat the cache controls as a guarantee that a giant transaction fits a small RAM budget.

New images use 8 KiB logical chunks and an 8 KiB container page size. Existing images retain their recorded layout. Advanced creation options include `pageSize`, `chunkTable`, `journalMode`, and `lockingMode`; changing them can affect space, concurrency, and performance. `durable: false` is an explicit unsafe mode and must not be represented as equivalent to durable storage.

## Performance

The useful question is how much the portable container costs compared with PGlite's native filesystem. The benchmark suite measures both backends under the same declared PostgreSQL workload and records the configuration, raw samples, and results. There is no universal performance ratio: batching, cache state, checkpoints, storage, and durability settings matter.

**The default durability settings differ:** the container uses SQLite `synchronous=FULL`, while PGlite's native Node filesystem runs PostgreSQL with `fsync=off`. These timings do not establish equal protection against hardware or power failure. The small suite warms its reads and uses a fixed 100 MiB configured page-cache budget: 100 MiB for native PGlite, or 98 MiB for PGlite plus 2 MiB for the container. The adapter clean-page cache is disabled. Operating-system caches are not cleared.

Recorded on **Node.js 24.21.0 LTS, Linux x86-64**, both locally on an AMD EPYC 9V74 host and on a GitHub-hosted Ubuntu runner. Each backend gets one excluded warm-up and five measured suites in fresh processes/databases; backend order alternates. Ratios compare median settled operation times, including pending adapter flushes. **Lower is better; 1.00× equals the native filesystem.**

| Operation | Workload | Local time ratio | Hosted CI time ratio |
| --- | --- | ---: | ---: |
| Large batch read | Return all 10,000 warmed rows | **1.04×** | **0.98×** |
| Large batch insert | Insert 10,000 rows in one statement | **1.10×** | **1.34×** |
| Large batch update | Update 10,000 rows in one statement | **1.09×** | **1.37×** |
| Small frequent read | 500 indexed lookups | **0.94×** | **0.99×** |
| Small frequent insert | 500 individual inserts | **1.04×** | **2.60×** |
| Small frequent update | 500 indexed updates | **1.05×** | **2.42×** |

**Frequent durable writes can cost materially more than the local results suggest.** Runtime and host differences matter: the initial Bun 1.4.2 Linux x86-64 lane measured **9.15×** for individual inserts and **8.33×** for individual updates. The current adapter is not a negligible-overhead replacement for every workload. Inspect the [complete initial CI matrix and raw samples](docs/benchmarks/initial-ci-matrix.json), including slower results and the incomplete Bun 1.2.23 lane, before choosing it.

The local warmed read phases made zero filesystem reads, so they measure behavior served by PostgreSQL's cache rather than container read throughput. Sub-1.00× read results are measurements from these runs, not general speedup guarantees. [Local raw samples and settings](docs/benchmarks/node24-linux-x64.json) · [Local HTML report](docs/benchmarks/node24-linux-x64.html) · [Initial CI run and downloadable reports](https://github.com/jbsiddall/pglite-singlefile-fs/actions/runs/37041731782). Historical proof-of-concept timings used different workloads and are not substituted for this suite.

The separate large run completed on the same local Node LTS host: **960,000 events plus 10,000 customers**, with **5.006 GiB of PostgreSQL relation storage** including TOAST on each backend. Three measured joins follow one excluded warm-up per phase. Customers retain their primary-key index; the second phase adds the events' customer join-key index.

| Large-database operation | Singlefile / native time |
| --- | ---: |
| Selective join without the event join-key index | **1.60×** |
| Same join with the event join-key index | **1.03×** |

**Storage overhead is substantial in the current layout:** after clean shutdown, the native data directory occupied **6.034 GiB**, while the single main container file occupied **10.216 GiB**, or **1.69×** as much space. Portable packaging is not free.

The joins read keys and amounts rather than the complete payload, so this is a large-database join check, not a full 5 GiB payload scan. Backends run sequentially, OS caches are not cleared, and the indexed result is a short warm query. [Large-run raw samples, query plans, and sizes](docs/benchmarks/node24-linux-x64-large.json) · [HTML report](docs/benchmarks/node24-linux-x64-large.html).

```sh
npm run bench:sample  # Recorded operation timings and an HTML comparison.
npm run bench        # Vitest benchmark suite.
npm run bench:big    # Separate large run: budget disk, memory, and time.
```

The operation run writes `reports/benchmark-results.json` and `reports/benchmark-report.html`. The large run writes `reports/benchmark-large-results.json` and `reports/benchmark-large-report.html`. Raw samples remain part of the report so reviewers can inspect variance rather than relying on a selected timing.

## Tests and CI

Validation includes filesystem property tests, PGlite integration, repeated persistence/reopen behavior, durability and recovery checks, and coordinated checkpointing.

```sh
npm run build
npm test
```

CI runs tests and records benchmarks on pull-request updates and pushes to the default branch. It uploads an HTML test report and benchmark results, with links from pull requests. All correctness tests gate every lane. Benchmarks also gate CI, with one narrow exception: observed historical Bun 1.2.23 engine-crash signatures are advisory. These include Bun segmentation-fault panics and observed WASM callback failures involving `getWasmTableEntry` or `t(r,a)`: null references or out-of-bounds memory access. Assertion or checksum failures, SQLite/filesystem errors, timeouts, and unknown failures remain fatal, including on old Bun. Both benchmark runs are still attempted, failures and partial reports are retained, and release reports disclose any classified advisory crash. After the required default-branch checks pass, the release workflow creates a semver tag and attaches reports from that exact run. A green required-check result does not mean every advisory benchmark succeeded. Large benchmarks have a separate manual workflow because they are unsuitable for every PR update.

Vitest coordinates the suite on Node.js. The database workers execute under the runtime being tested, so a Bun or Deno matrix entry exercises that runtime's database and filesystem behavior rather than only changing a label.

Runtime coverage selects the latest published non-prerelease release and representative preceding release lines, rather than redundant patch versions. The requested platform targets are Linux x86-64, Linux ARM64, and macOS ARM64. Check [Actions](https://github.com/jbsiddall/pglite-singlefile-fs/actions) for what has actually passed.

Initial local validation passed all 11 tests on Linux x86-64 using Node.js 24.19.0, Bun 1.4.2, and Deno 2.9.6. This does not establish the full hosted runtime/platform matrix; ARM and macOS results remain separate checks.

In the [initial hosted run](https://github.com/jbsiddall/pglite-singlefile-fs/actions/runs/37041731782), all 15 runtime/platform lanes passed the 11 tests and six Vitest benchmarks. Fourteen lanes completed the separate sampled benchmark; the Bun 1.2.23 Linux lane failed during a later native-filesystem benchmark iteration with a WASM error. In the [flagged hosted follow-up](https://github.com/jbsiddall/pglite-singlefile-fs/actions/runs/37043190555), all 15 correctness-test lanes again passed, but Bun 1.2.23 crashed during a Vitest benchmark. The [next default-settings run](https://github.com/jbsiddall/pglite-singlefile-fs/actions/runs/37044661943) passed all 15 correctness-test lanes and Bun's six Vitest benchmarks, but its sampled benchmark failed with an out-of-bounds WASM callback error. These failed runs remain available; none establishes complete benchmark success.

### Older Bun benchmark instability

**Prefer a current Bun release.** Historical Bun 1.2.23 has unstable PGlite benchmark behavior, including failures with PGlite's native filesystem and no adapter imports. Its correctness tests still gate CI. Only the narrowly classified reproduced engine crashes are advisory and visible in reports; failed benchmark verification or any unrelated failure still blocks CI.

This process setting improved local reproductions:

```sh
JSC_useWasmOSR=false bun your-script.mjs
```

Disabling JavaScriptCore's WASM OSR setting passed ten fresh upstream reproductions and a complete local benchmark with five measured suites plus a warm-up per backend. [Flagged local raw results](docs/benchmarks/bun12-linux-x64-wasm-osr-disabled.json) retain the process setting explicitly. **It did not resolve hosted instability:** the flagged follow-up crashed during a Vitest batch-read benchmark. This is limited empirical evidence, not a reliable fix or required launch configuration. CI retains default-settings coverage; the library does not change this setting automatically.

[Bun issue #26366](https://github.com/oven-sh/bun/issues/26366) describes a related JavaScriptCore WASM OSR issue. Our reproducer and workaround do not prove that it has the identical root cause. The initial failed matrix snapshot remains available above.

The callback out-of-bounds error was initially observed during SingleFileFS initialization. A subsequent hosted run also recorded that exact diagnostic during native NodeFS initialization. This supports a shared historical Bun/PGlite runtime problem, but the exact underlying cause remains unproven. All correctness tests remain mandatory.

### Verified integration

[PR #2](https://github.com/jbsiddall/pglite-singlefile-fs/pull/2) was merged after the [final PR run](https://github.com/jbsiddall/pglite-singlefile-fs/actions/runs/37045613316) passed all 15 required matrix jobs, including all 11 correctness tests in every lane, and uploaded 15 report artifacts. The older Bun Vitest run still had one classified advisory engine crash; five benchmark cases passed and its separate sampled run completed.

The separate [first default-branch run](https://github.com/jbsiddall/pglite-singlefile-fs/actions/runs/37046099579) passed all 15 required jobs and published [v0.1.0](https://github.com/jbsiddall/pglite-singlefile-fs/releases/tag/v0.1.0), with **15 downloadable report ZIPs**. In that main-branch run, both historical Bun benchmark phases failed with classified advisory engine crashes. This is required-check success with disclosed benchmark exceptions, not every benchmark passing. See the [validation receipt](docs/VALIDATION.md) for the evidence and retained failed runs.

## FAQ

### Why use SQLite rather than a basic archive or tiny filesystem?

The adapter needs random-access edits, durable commits, recovery, and efficient reads, not just a compressed bundle of files. SQLite provides those building blocks, and Node.js, Deno, and Bun provide SQLite interfaces within their runtimes. That avoids distributing another native C binding or a separately packaged filesystem library.

Packaging differs: it is inaccurate to say all three runtimes statically link SQLite on every platform. Bun, for example, can use the system SQLite on macOS. Supported runtime versions still need compatibility tests.

### Is SQLite executing my application queries?

No. PostgreSQL inside PGlite executes your application SQL. SQLite stores opaque virtual-file metadata and byte chunks. It is the current means of packaging the database, and could be replaced by another container implementation in the future.

### Is this full PostgreSQL without limitations?

It preserves the PGlite engine rather than turning it into another SQL dialect. PGlite's own supported features, extension availability, and constraints still apply. This adapter adds its own filesystem and persistence limits; it does not promise every feature of a separately deployed PostgreSQL server.

### Can several processes share one image?

That is not a supported claim. The adapter keeps filesystem state in memory and does not establish multi-process or multi-writer safety. Use one active PGlite instance per image. SQLite locking alone does not make independent PGlite engines safe to share PostgreSQL data.

### Is this a general-purpose POSIX filesystem?

No. It implements the filesystem surface required by the supported PGlite workloads. Do not assume complete POSIX behavior, arbitrary external filesystem access, or every unlink-while-open edge case has been implemented and verified.

## Roadmap

**Make single-file storage an official PGlite capability:** upstream releases its own implementation or adopts this filesystem, making portable embedded PostgreSQL easy for everyone to use.

The [upstream alignment issue](https://github.com/jbsiddall/pglite-singlefile-fs/issues/1) tracks matching PGlite's filesystem conventions to make adoption straightforward.

## Contributing and AI transparency

This project is developed with AI coding agents supervised by **Joseph Siddall**. Human supervision does not replace tests, review, or truthful reporting.

Useful issues and pull requests from AI agents are welcome, just like human contributions. Repository owners and their coding agents are responsible for vetting quality, security, correctness, and usefulness. Include a reproducer or clear evidence, explain behavior changes, and disclose meaningful validation limits.

See [the setup checklist](TODO.md) for the requested work and its completion status, and [the concise project request](docs/REQUEST.md) for its scope.

## License

Apache License 2.0. See [LICENSE](LICENSE).
