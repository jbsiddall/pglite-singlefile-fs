# Initial publication validation

This receipt records verified outcomes separately from configured automation. It does not replace raw reports or imply that every benchmark passed.

## Integration

- [PR #2](https://github.com/jbsiddall/pglite-singlefile-fs/pull/2) merged into the default branch after the [final PR run](https://github.com/jbsiddall/pglite-singlefile-fs/actions/runs/37045613316).
- All **15 required runtime/platform jobs passed**.
- All **11 correctness tests passed in every lane**, including Linux x86-64, Linux ARM64, and macOS ARM64 coverage.
- **15 report artifacts** were uploaded.
- Historical Bun 1.2.23 had **one advisory Vitest engine crash and five passing benchmark cases**. Its separate sampled benchmark completed. This is not a claim that every benchmark passed.

The exception is restricted to observed historical Bun engine-crash signatures. Assertion/checksum failures, SQLite/filesystem errors, timeouts, and unknown errors remain blocking. The exact WASM callback out-of-bounds diagnostic was also recorded during native NodeFS initialization in the final run. The shared runtime interpretation is supported; an exact underlying cause has not been established.

## Retained earlier failures

| Run | Recorded result |
| --- | --- |
| [Initial matrix](https://github.com/jbsiddall/pglite-singlefile-fs/actions/runs/37041731782) | All correctness tests passed; older Bun failed its sampled benchmark. [Raw matrix snapshot](benchmarks/initial-ci-matrix.json). |
| [Flagged follow-up](https://github.com/jbsiddall/pglite-singlefile-fs/actions/runs/37043190555) | All correctness tests passed; disabling WASM OSR did not prevent a hosted Vitest crash. |
| [Next default-settings run](https://github.com/jbsiddall/pglite-singlefile-fs/actions/runs/37044661943) | All correctness tests passed; older Bun sampled benchmark failed with a WASM callback out-of-bounds error. |
| [Documentation follow-up](https://github.com/jbsiddall/pglite-singlefile-fs/actions/runs/37047017697) | All correctness tests passed; older Bun sampled worker setup failed with `RuntimeError: Aborted(). Build with -sASSERTIONS for more info.` No subsequent release success is implied. |

The [successful flagged local experiment](benchmarks/bun12-linux-x64-wasm-osr-disabled.json) remains limited local evidence. It is not presented as a reliable fix or a substitute for the failed hosted runs.

The follow-up worker-setup abort diagnostic and PGlite `abort` frame also reproduced on a native NodeFS control that imported the adapter module but did not instantiate SingleFileFS. That exact control is not a zero-adapter-import reproduction and does not isolate module-initialization effects. The [sanitized native-control evidence](benchmarks/historical-bun-native-abort.md) preserves the diagnostic and those limitations. Benchmark worker setup covers database creation, seeding, a checkpoint, and warm reads; its exact failing substage and cause remain unknown. The historical advisory policy includes this observed PGlite worker-setup abort signature; all verification failures and unknown errors remain blocking.

## Reproducible local measurements

- [Six-operation Node LTS report](benchmarks/node24-linux-x64.json): five measured suites per backend, all workloads and warm-ups retained.
- [Large-database report](benchmarks/node24-linux-x64-large.json): both backends reached 5.006 GiB of PostgreSQL relation storage; join plans and physical sizes retained.
- The README includes hosted results as well as local results, the slower Bun write cases, unequal default hardware durability, the 1.60× large unindexed join ratio, and the 1.69× storage amplification.

## Release status

The [first default-branch workflow](https://github.com/jbsiddall/pglite-singlefile-fs/actions/runs/37046099579), for the merged `92208ad` revision, passed all 15 required matrix jobs. Its release job validated all 15 report manifests and published **[v0.1.0](https://github.com/jbsiddall/pglite-singlefile-fs/releases/tag/v0.1.0)** as a non-draft release.

All **15 report ZIP assets** were verified uploaded, each larger than 620 KB. They contain the corresponding tests, benchmarks, and phase-outcome manifests from that exact main-branch run.

In this release run, **both historical Bun 1.2.23 benchmark phases failed with classified advisory engine crashes**. The PR's completed older-Bun sampled run must not be substituted for the release-run outcome. All correctness tests remained mandatory, and both advisory failures remain visible in the release reports. The release's successful required checks do not mean every benchmark passed.

This receipt verifies the first published release, v0.1.0. Later releases and documentation-only follow-ups have their own workflows and assets; they are not assumed verified by this receipt.

## Later historical callback diagnostic

[Policy-review run 37048806910](https://github.com/jbsiddall/pglite-singlefile-fs/actions/runs/37048806910) passed all eleven correctness tests in every lane; fourteen matrix jobs passed and the historical Bun job failed. Bun's Vitest phase recorded two advisory out-of-bounds callbacks, and its sampled phase failed during single-file worker setup with `RuntimeError: call_indirect to a signature that does not match`, evaluating `getWasmTableEntry(e)(t, r, a, o, _, s)`, with an `invoke_viiiiii` frame in PGlite's distribution. That newly observed variant initially blocked CI and remains visible in the retained run. It is now included in the narrow historical callback diagnostic policy. Its exact underlying cause and a matching native-storage or zero-adapter-import reproduction have not been established. No runtime workaround or production-code change was made; assertions, unrelated diagnostics and mixed errors remain fatal.
