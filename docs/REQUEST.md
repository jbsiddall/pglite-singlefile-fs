# Repository setup request

Publish `pglite-singlefile-fs` as a maintained PGlite virtual filesystem whose goal is the power of PostgreSQL in one portable database file. The current container implementation may use SQLite, but the project identity should focus on the outcome. Explain the implementation openly without making it the headline.

## Implementation and validation

- Bring the existing proof of concept into a usable repository and push it to GitHub.
- Support Node.js, Deno, and Bun through each runtime's built-in SQLite interface. Support Linux x86-64 and ARM64, and macOS ARM64.
- Add TypeScript property tests with `fast-check`, focused basic integration tests, and repeated persistence/reopen tests.
- Test coordinated PostgreSQL and container-WAL checkpointing. PostgreSQL may recycle its WAL segments, so do not infer checkpoints solely from file deletion or truncation.
- Add Vitest benchmarks comparing this adapter with PGlite's native Node filesystem for large batch reads, inserts, and updates, and small frequent reads, writes, and updates.
- Add a separate large benchmark with two tables and about 5 GB of data. Compare joins with and without indexes against the native filesystem. Keep the run reproducible and record actual sizes and results.
- Check runtime compatibility and performance across the latest published non-prerelease runtime and representative preceding major or minor release lines. Do not claim those lines cover 80% of users without usage evidence. Avoid redundant patch-version combinations.

## CI and releases

- Run tests and record benchmarks for pull-request updates and pushes.
- Retain downloadable HTML test reports and benchmark results as CI artifacts, and make those artifacts discoverable from the pull request.
- On integration into the default branch, use semantic versioning to create a tagged release and attach the corresponding test report and benchmark results. Prevent untrusted pull requests from accessing release credentials.
- Do not ship by disabling tests or ignoring unexplained benchmark regressions.

## Documentation and governance

- Write an informative README with source setup, API examples, durability and portability limits, a filesystem comparison, concise measured benchmarks, and an implementation FAQ.
- Explain that built-in SQLite interfaces avoid distributing an additional native C binding. Do not claim every runtime statically links SQLite; packaging differs by runtime and platform.
- State that AI coding agents are supervised by Joseph Siddall. Welcome useful AI-generated issues and pull requests, with repository owners responsible for vetting quality.
- Give the README one roadmap goal: upstream PGlite provides official single-file storage or adopts this filesystem so it is easy for everyone to use.
- Put timeless ownership instructions in `AGENTS.md`: reliability, integrity, security, semantic versioning, compatibility, honest reporting, and a delegated reproduce–test–fix–review–CI–merge working loop.
- Track all requested work in a checklist and distinguish verified results from planned work.
- Open an upstream-alignment issue to make the code follow PGlite's filesystem conventions so upstream adoption is straightforward.
