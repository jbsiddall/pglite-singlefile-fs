# Repository checklist

Check an item only when the implementation or result is verified. A configured CI job is not evidence that its runtime or platform has passed.

## Current (`redb-js` WebAssembly backend)

- [x] Single-file Copy-on-Write ACID container powered by [`redb-js`](https://github.com/jbsiddall/redb-js) (WebAssembly) with zero `-wal` / `-shm` sidecar files.
- [x] Universal runtime support: Node.js (`>=18`), Bun, Deno, Browser OPFS (`pglite-singlefile-fs/browser` inside a Dedicated Web Worker), and portable `:memory:` buffers (`exportBytes()`).
- [x] Self-describing chunk codecs tuned for PostgreSQL 8 KiB pages (`sparse`/`zerobytemask` + `PGHOLE` default, `bitsparse32`, `bitsparse16`, `lz4`, `none`) and `> 8,170 B` split-chunk storage to avoid `redb`'s 16 KiB leaf-page cliff.
- [x] TypeScript property tests (`fast-check`), PGlite strict/relaxed durability & lifecycle tests, foreign-file protection (including uncleanly closed foreign `redb` images), coordinated `CHECKPOINT` + compaction tests, and `SIGKILL` pre-commit / post-commit crash recovery tests.
- [x] Headless Chrome Browser OPFS persistence test across full browser restarts (`npm run test:browser`), verifying strictly one OPFS file and benchmarking against PGlite's built-in `OpfsAhpFS`.
- [x] Reproducible comparative benchmarks against PGlite's built-in `NodeFS` (`npm run bench:sample`, `npm run bench`, `npm run bench:big`) and `OpfsAhpFS` (`npm run test:browser`), with raw snapshots retained under `docs/benchmarks/`.
- [x] Automated 15-lane CI matrix (Node.js, Deno, Bun across Linux x86-64, Linux ARM64, macOS ARM64) and SemVer GitHub release automation attaching exact-run reports.

## Roadmap

- [ ] Upstream alignment with [PGlite](https://github.com/electric-sql/pglite) so single-file storage is easy to use or provided officially upstream ([issue #1](https://github.com/jbsiddall/pglite-singlefile-fs/issues/1)).

---

## Historical v0.1.0 release receipt

The initial v0.1.0 release (superseded by the `redb-js` backend) validated the original CI matrix, SemVer release automation, and 15-lane report artifacts; see [docs/VALIDATION.md](docs/VALIDATION.md) and [docs/REQUEST.md](docs/REQUEST.md) for the preserved v0.1.0 records.
