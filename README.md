# PGlite Singlefile FS

[![CI](https://github.com/jbsiddall/pglite-singlefile-fs/actions/workflows/ci.yml/badge.svg)](https://github.com/jbsiddall/pglite-singlefile-fs/actions/workflows/ci.yml)

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

New images use 8 KiB logical chunks and an 8 KiB container page size. Existing images retain their recorded layout. Advanced creation options include `pageSize`, `chunkTable`, `journalMode`, and `lockingMode`; changing them can affect space, concurrency, and performance. `durable: false` is an explicit unsafe mode and must not be represented as equivalent to durable storage.

## Performance

The useful question is how much the portable container costs compared with PGlite's native filesystem. The benchmark suite measures both backends under the same declared PostgreSQL workload and records the configuration, raw samples, and results. There is no universal performance ratio: batching, cache state, checkpoints, storage, and durability settings matter.

**The default durability settings differ:** the container uses SQLite `synchronous=FULL`, while PGlite's native Node filesystem runs PostgreSQL with `fsync=off`. These timings do not establish equal protection against hardware or power failure. The small suite warms its reads and uses a fixed 100 MiB configured page-cache budget: 100 MiB for native PGlite, or 98 MiB for PGlite plus 2 MiB for the container. The adapter clean-page cache is disabled. Operating-system caches are not cleared.

The compact README comparison covers six operations on Node's current LTS line:

| Operation | What the comparison measures |
| --- | --- |
| Large batch read | Return all rows from an explicitly warmed table |
| Large batch insert | Insert many rows in one batch |
| Large batch update | Update many rows in one batch |
| Small frequent read | Repeated indexed lookups |
| Small frequent insert | Individual inserts |
| Small frequent update | Individual indexed updates |

Measured ratios and report links will be added once the repository's benchmark run completes. Historical proof-of-concept timings used different workloads and are not substituted for this suite.

A separate large benchmark builds two tables with at least 5 GiB of PostgreSQL relation storage and compares joins with and without indexes. Container file size is measured separately. The joins read keys and amounts rather than the entire payload, so this is a large-database join check, not a full 5 GiB payload scan. Its setup, measured size, cache conditions, and completion status must accompany any reported results; defining the benchmark is not evidence of a completed large run.

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

CI runs tests and records benchmarks on pull-request updates and pushes to the default branch. It uploads an HTML test report and benchmark results, with links from pull requests. After the default-branch matrix passes, the release workflow creates a semver tag and attaches reports from that exact run. Large benchmarks have a separate manual workflow because they are unsuitable for every PR update.

Vitest coordinates the suite on Node.js. The database workers execute under the runtime being tested, so a Bun or Deno matrix entry exercises that runtime's database and filesystem behavior rather than only changing a label.

Runtime coverage selects the latest published non-prerelease release and representative preceding release lines, rather than redundant patch versions. The requested platform targets are Linux x86-64, Linux ARM64, and macOS ARM64. Check [Actions](https://github.com/jbsiddall/pglite-singlefile-fs/actions) for what has actually passed.

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

## Contributing and AI transparency

This project is developed with AI coding agents supervised by **Joseph Siddall**. Human supervision does not replace tests, review, or truthful reporting.

Useful issues and pull requests from AI agents are welcome, just like human contributions. Repository owners and their coding agents are responsible for vetting quality, security, correctness, and usefulness. Include a reproducer or clear evidence, explain behavior changes, and disclose meaningful validation limits.

See [the setup checklist](TODO.md) for the requested work and its completion status, and [the concise project request](docs/REQUEST.md) for its scope.

## License

Apache License 2.0. See [LICENSE](LICENSE).
