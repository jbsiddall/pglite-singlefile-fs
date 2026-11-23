# Recorded benchmark snapshots

These files preserve complete measured reports, not selected best timings. They are snapshots of the recorded host and revision, not universal performance guarantees.

## Current (`redb-js` WebAssembly backend)

### Node.js: `SingleFileFS` vs built-in `NodeFS`

- [Raw JSON](node23-macos-arm64.json): Node.js v23.1.0, Apple M2 macOS (`darwin/arm64`), 1 excluded warm-up + 3 alternating fresh-process runs per variant.
- Workloads: `initdb` + startup, 10,000-row batch reads/inserts/updates, 500 individual lookups/inserts/updates, cold reopen + scan, host file count, raw closed size, and post-close compacted size.
- Configured page-cache budget: **100 MiB total** — `NodeFS` 100 MiB PostgreSQL `shared_buffers`; `SingleFileFS` 92 MiB PostgreSQL `shared_buffers` + 8 MiB `redb` cache (adapter clean cache disabled). Not a whole-process RAM cap.
- Durability disclosure: built-in `NodeFS` runs PostgreSQL with `fsync=off`. `SingleFileFS (strict)` executes hardware `F_FULLFSYNC` on every query on macOS (~4.1 ms/call vs Linux `fdatasync` ~0.05–0.3 ms/call). `SingleFileFS (relaxed)` writes atomic CoW commits to the OS page cache (`SIGKILL`-safe) and hardware-syncs on `flush()` / `close()`.

Reproduce standard strict `NodeFS` vs `SingleFileFS` sampling with `npm run bench:sample`.

### Browser OPFS: `SingleFileFS` vs built-in `OpfsAhpFS`

Reproduce directly inside headless Chrome with `npm run test:browser` (Chrome 157.0.8103.80 Dedicated Web Worker, 2,000-row batch / 100 frequent operations, 8 MiB `redb` cache, single run per variant; results summarized in the top-level [README.md](../../README.md#browser-wasm-opfs-singlefilefs-vs-built-in-opfsahpfs)).

---

## Historical v0.1.0 snapshots (superseded)

The files below were recorded during the initial v0.1.0 release (prior to migrating to `redb-js` for single-file server + Browser OPFS support) and are retained unchanged for historical traceability:

- [v0.1.0 six-operation Node 24 Linux report (JSON)](node24-linux-x64.json) · [HTML](node24-linux-x64.html)
- [v0.1.0 5 GiB large-database join report (JSON)](node24-linux-x64-large.json) · [HTML](node24-linux-x64-large.html)
- [v0.1.0 initial 15-lane CI matrix snapshot](initial-ci-matrix.json) · [GitHub run](https://github.com/jbsiddall/pglite-singlefile-fs/actions/runs/37041731782)
- [v0.1.0 Bun 1.2.23 `JSC_useWasmOSR=false` local experiment](bun12-linux-x64-wasm-osr-disabled.json)
- [v0.1.0 historical Bun native-control abort evidence](historical-bun-native-abort.md)
- [v0.1.0 validation receipt](../VALIDATION.md)

At v0.1.0, the container backend used each server runtime's built-in SQLite interface (`synchronous=FULL`, 2 MiB cache vs 100 MiB NodeFS with `fsync=off`). CI continues to retain the narrow historical Bun 1.2.23 advisory engine-crash policy verified in [scripts/ci-benchmark-policy-check.mjs](../../scripts/ci-benchmark-policy-check.mjs), while all correctness tests, assertions, backend errors, and unknown failures remain fatal.
