# Repository setup checklist

Check an item only when the implementation or result is available. A configured CI job is not evidence that its runtime or platform has passed.

## Code and tests

- [x] Import and organize the existing filesystem proof of concept.
- [x] Use built-in SQLite interfaces for Node.js, Deno, and Bun.
- [x] Validate Linux x86-64, Linux ARM64, and macOS ARM64 in the configured test matrix.
- [x] Add TypeScript property tests for filesystem behavior.
- [x] Add basic PGlite integration tests.
- [x] Repeat close/reopen/read/insert tests.
- [x] Verify strict and relaxed durability behavior.
- [x] Verify recovery after interruption and errors.
- [x] Verify PostgreSQL and container-WAL coordinated checkpointing.
- [x] Review the implementation adversarially and resolve material findings.

Local evidence: all 11 tests passed on Linux x86-64 under Node.js 24.19.0, Bun 1.4.2, and Deno 2.9.6. This includes generated filesystem traces, strict/relaxed reopen cycles, checkpoint/reopen checks, and pending/committed crash recovery in DELETE and WAL modes. The [initial hosted run](https://github.com/jbsiddall/pglite-singlefile-fs/actions/runs/37041731782) passed these 11 tests in all 15 runtime/platform lanes, including Linux ARM64 and macOS ARM64. Its separate sampled benchmark still failed on Bun 1.2.23; the complete workflow is not yet green.

## Benchmarks

- [x] Add Vitest benchmarks against PGlite's native filesystem.
- [x] Cover large batch reads, inserts, and updates.
- [x] Cover small frequent reads, writes, and updates.
- [x] Record raw results, settings, actual workload sizes, and reproducible commands.
- [x] Use explicit cache budgets and disclose the durability difference between default backends.
- [x] Add the separate approximately 5 GB, two-table join benchmark, with and without indexes.
- [x] Run the large benchmark and publish its actual outcome.
- [x] Add concise measured Node LTS benchmark results to the README.

Small-suite evidence: five measured samples per backend plus excluded warm-ups, Node.js 24.21.0 on Linux x86-64. Large-suite evidence: each backend reached 5.006 GiB of PostgreSQL relations; joins ran three measured samples per phase. All raw samples, plans, and sizes are retained under `docs/benchmarks/`. The README reports the 1.60× unindexed slowdown and 1.69× closed-storage overhead alongside the other results.

Hosted evidence is also retained in `docs/benchmarks/initial-ci-matrix.json`. The README shows the hosted Node LTS column and larger Bun write costs; local ratios are not presented as representative of every runtime or machine.

## Automation

- [x] Configure tests and recorded benchmarks for PR updates and pushes.
- [x] Configure representative released Node.js, Deno, and Bun lines.
- [x] Avoid prerelease versions and redundant patch-version combinations.
- [x] Retain HTML test reports and benchmark artifacts.
- [x] Link CI reports from pull requests.
- [ ] Generate semver tags and releases on integration into the default branch.
- [ ] Attach test reports and benchmark results to releases.
- [x] Keep privileged release work separate from untrusted PR execution.
- [ ] Observe the configured CI matrix passing; document any unavailable checks.

Initial-run artifacts are uploaded and linked from PR #2. Bun 1.2.23's default sampled benchmark failed with an upstream-reproducible WASM startup error. The older lane now uses the explicitly recorded `JSC_useWasmOSR=false` workaround for both backends; default compatibility is not claimed, and complete rerun/release status remains unchecked.

## Documentation and publication

- [x] Write a concise rewrite of the original instructions.
- [x] Write timeless Codex ownership and maintenance instructions.
- [x] Document the goal, source setup, filesystem comparison, and durability limits.
- [x] Explain the current container backend and runtime packaging accurately.
- [x] Document human supervision and welcome useful AI contributions.
- [x] State the single upstream adoption roadmap goal.
- [x] Open the [upstream-alignment GitHub issue](https://github.com/jbsiddall/pglite-singlefile-fs/issues/1).
- [x] Push the repository to GitHub in [PR #2](https://github.com/jbsiddall/pglite-singlefile-fs/pull/2).
- [ ] Confirm release artifacts are available on GitHub.
