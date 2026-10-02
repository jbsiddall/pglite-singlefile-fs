# Repository setup checklist

Check an item only when the implementation or result is available. A configured CI job is not evidence that its runtime or platform has passed.

## Code and tests

- [ ] Import and organize the existing filesystem proof of concept.
- [ ] Use built-in SQLite interfaces for Node.js, Deno, and Bun.
- [ ] Validate Linux x86-64, Linux ARM64, and macOS ARM64.
- [ ] Add TypeScript property tests for filesystem behavior.
- [ ] Add basic PGlite integration tests.
- [ ] Repeat close/reopen/read/insert tests.
- [ ] Verify strict and relaxed durability behavior.
- [ ] Verify recovery after interruption and errors.
- [ ] Verify PostgreSQL and container-WAL coordinated checkpointing.
- [ ] Review the implementation adversarially and resolve material findings.

## Benchmarks

- [ ] Add Vitest benchmarks against PGlite's native filesystem.
- [ ] Cover large batch reads, inserts, and updates.
- [ ] Cover small frequent reads, writes, and updates.
- [ ] Record raw results, settings, actual workload sizes, and reproducible commands.
- [ ] Compare like-for-like durability and explicit cache budgets; disclose differences.
- [ ] Add the separate approximately 5 GB, two-table join benchmark, with and without indexes.
- [ ] Run the large benchmark and publish its actual outcome.
- [ ] Add concise measured Node LTS benchmark results to the README.

## Automation

- [ ] Configure tests and recorded benchmarks for PR updates and pushes.
- [ ] Cover representative released Node.js, Deno, and Bun lines.
- [ ] Avoid prerelease versions and redundant patch-version combinations.
- [ ] Retain HTML test reports and benchmark artifacts.
- [ ] Link CI reports from pull requests.
- [ ] Generate semver tags and releases on integration into the default branch.
- [ ] Attach test reports and benchmark results to releases.
- [ ] Keep privileged release work separate from untrusted PR execution.
- [ ] Observe the configured CI matrix passing; document any unavailable checks.

## Documentation and publication

- [x] Write a concise rewrite of the original instructions.
- [x] Write timeless Codex ownership and maintenance instructions.
- [x] Document the goal, source setup, filesystem comparison, and durability limits.
- [x] Explain the current container backend and runtime packaging accurately.
- [x] Document human supervision and welcome useful AI contributions.
- [x] State the single upstream adoption roadmap goal.
- [ ] Open the upstream-alignment GitHub issue.
- [ ] Push the repository to GitHub.
- [ ] Confirm release artifacts are available on GitHub.
