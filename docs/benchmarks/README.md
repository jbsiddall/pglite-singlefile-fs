# Recorded benchmark snapshots

These files preserve complete measured reports, not selected best timings. They are snapshots of this host and revision, not universal performance guarantees.

## Six operations

- [Raw JSON](node24-linux-x64.json): Node.js 24.21.0 LTS, Linux x86-64, AMD EPYC 9V74.
- [HTML report](node24-linux-x64.html): the same data in a readable report.
- Five measured fresh-process suites per backend and one excluded warm-up. The execution order alternates between native PGlite NodeFS and SingleFileFS.
- 10,000-row batch reads, inserts, and updates; 500 individual lookups, inserts, and updates.
- The table compares the ratio of each backend's median settled operation time. Startup and verification are excluded; pending persistence is included.
- Configured page-cache budget: native PostgreSQL 100 MiB; SingleFileFS PostgreSQL 98 MiB plus SQLite 2 MiB. Adapter clean cache is disabled. This is not a whole-process RAM cap.
- Reads are explicitly warm and made zero filesystem reads. Operating-system caches are not cleared, and no NVMe-specific result is claimed.
- Durability differs: SingleFileFS uses SQLite `synchronous=FULL`; upstream NodeFS runs PostgreSQL with `fsync=off`. These are default-backend comparisons, not equal power-loss durability comparisons.

Reproduce from the repository with `npm run bench:sample`. CI also records its own runtime/platform reports; inspect those separately from this local snapshot.

## Initial hosted matrix

[Complete raw matrix snapshot](initial-ci-matrix.json) · [GitHub run and artifacts](https://github.com/jbsiddall/pglite-singlefile-fs/actions/runs/37041731782)

All 15 lanes passed 11 tests and six Vitest benchmarks. Fourteen completed the separate sampled benchmark; Bun 1.2.23 Linux failed during a later native-filesystem worker iteration. Its partial data and failure remain in the report, and no final ratios are invented for that lane.

The hosted Node.js 24.21.0 Linux ratios differ materially from the local run: **2.60×** individual inserts and **2.42×** individual updates, versus **1.04×** and **1.05×** locally. Bun 1.4.2 on Linux x86-64 measured **9.15×** and **8.33×** for those operations. All matrix results are retained; selecting only the favorable local measurements would misrepresent the current cost.

Runtime and host conditions vary, and SQLite FULL versus native PostgreSQL `fsync=off` remains an important durability difference. This report does not isolate one cause for the variation. The tested head and merge commits are recorded in the raw matrix snapshot.

The Bun 1.2.23 startup failure subsequently reproduced with upstream PGlite NodeFS and no adapter imports. An explicitly set `JSC_useWasmOSR=false` passed repeated fresh-process reproductions locally, but the [flagged hosted follow-up](https://github.com/jbsiddall/pglite-singlefile-fs/actions/runs/37043190555) still crashed during a Vitest benchmark. It is not a reliable fix. All 15 correctness-test lanes passed again; benchmark success remained incomplete. [Bun issue #26366](https://github.com/oven-sh/bun/issues/26366) is related; an identical root cause has not been established.

The [separate flagged local Bun 1.2.23 report](bun12-linux-x64-wasm-osr-disabled.json) completed five measured suites and one warm-up per backend. Its environment metadata records `JSC_useWasmOSR=false`. This is limited local evidence, not a replacement for either failed hosted run or a general compatibility guarantee.

The [next default-settings run](https://github.com/jbsiddall/pglite-singlefile-fs/actions/runs/37044661943) passed all 15 correctness-test lanes and Bun's six Vitest benchmarks, but the older Bun sampled benchmark failed in a WASM callback with out-of-bounds memory access. That failed run is preserved too.

CI retains default settings and attempts both Vitest and sampled benchmarks. Only observed historical Bun 1.2.23 engine-crash signatures are advisory: segmentation-fault panics, or `getWasmTableEntry`/`t(r,a)` WASM callbacks failing with null references or out-of-bounds memory access. The callback out-of-bounds diagnostic initially occurred during SingleFileFS initialization; the [final PR run](https://github.com/jbsiddall/pglite-singlefile-fs/actions/runs/37045613316) also recorded that exact diagnostic during native NodeFS initialization. A shared historical runtime problem is supported, but its exact cause remains unproven. Correctness tests and benchmark assertions/checksums still gate every lane; SQLite/filesystem errors, timeouts, unknown failures, and other runtime crashes are fatal. Failure manifests and partial artifacts are retained, and releases disclose any classified advisory crash. Prefer current Bun versions; a passing required-check result must not be described as every benchmark passing.

The final PR run passed all 15 required matrix jobs and all 11 correctness tests per lane. The older Bun Vitest lane had one advisory engine crash and five passing cases; its sampled benchmark completed. All 15 report artifacts were uploaded.

The separate [first default-branch run](https://github.com/jbsiddall/pglite-singlefile-fs/actions/runs/37046099579) passed all 15 required jobs and published [v0.1.0 with 15 report ZIPs](https://github.com/jbsiddall/pglite-singlefile-fs/releases/tag/v0.1.0). Both historical Bun benchmark phases failed with classified advisory engine crashes in that release run. Its release assets retain those failures; the completed PR sampled run is not a substitute for release results. [Validation receipt](../VALIDATION.md).

## Large database

The opt-in large benchmark is defined by `npm run bench:big`. It creates two application tables, reaches at least 5 GiB of PostgreSQL relation storage including TOAST, and measures a selective customer join before and after adding the event join-key index. Join plans and physical backend sizes are recorded separately.

The run completed on the same Node LTS host with 960,000 events and 10,000 customers. Both backends reached 5.006 GiB of relation storage. The selective join matched 96 events with the same amount sum on both; the query returns one aggregate record. Three measured samples follow one excluded warm-up per phase.

- [Raw JSON with plans, settings, and sizes](node24-linux-x64-large.json).
- [HTML report](node24-linux-x64-large.html).
- Join without the event join-key index: **1.60×** native elapsed time.
- Join with that index: **1.03×** native elapsed time.
- After closing: **6.034 GiB** native data directory versus **10.216 GiB** container file, or **1.69×** storage.

The joins read keys and amounts, not the complete payload. Operating-system caches are not cleared and the backends run sequentially, so this is not a cold full-payload scan or an order-independent benchmark. Observed storage/WAL peaks in the raw report are sampled at load batch boundaries, not guaranteed overall peaks.
