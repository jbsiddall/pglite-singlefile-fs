# Historical Bun native-storage abort receipt

This preserves an existing local diagnostic, recorded on 2 October 2026. No new experiment was run to produce this receipt.

The control used Bun 1.2.23, PGlite 0.5.8 and PGlite's built-in Node filesystem backend. Its Node.js coordinator was v24.19.0. It selected `backend: 'nodefs'` and did not instantiate `SingleFileFS`, **but its worker imported the adapter module**. This is a native-storage baseline, **not a zero-adapter-import control**.

One full baseline suite completed. The following fresh worker failed during its `initialize/setup` request:

```text
complete baseline 0
Error: baseline iteration 1: Error: [bun/nodefs/initialize/setup] RuntimeError: Aborted(). Build with -sASSERTIONS for more info.
    at abort (<workspace>/node_modules/@electric-sql/pglite/dist/index.js:1:78246)
    at unknown
    at unknown
    at unknown
    at unknown
    at unknown
    at unknown
    at unknown
    at unknown
    at unknown
    at Interface.<anonymous> (<workspace>/scripts/benchmark-client.mjs:22:38)
    ... coordinator transport frames omitted ...
Node.js v24.19.0
```

Absolute workspace paths were replaced with `<workspace>`; the diagnostic, immediate abort frame and unknown frames are preserved. The source was the existing local `pglite-bun12-baseline-repro.log` and its native-backend coordinator script.

`initialize/setup` includes PGlite creation, schema creation, initial inserts, a checkpoint and warm queries. The exact failing substage and underlying cause were not independently established. This receipt therefore supports an **observed setup-abort signature**, not a claim that the adapter is uninvolved or that an engine defect is proven.

The same diagnostic appeared in the single-file setup during [main CI run 37047017697](https://github.com/jbsiddall/pglite-singlefile-fs/actions/runs/37047017697), job `110970852657`, after all eleven correctness tests passed. That failed attempt remains recorded.

CI's historical exception requires the exact Bun version, explicit `initialize/setup` context, exact `Aborted(). Build with -sASSERTIONS for more info.` message and an immediate abort frame in PGlite's distribution. Assertions, checksum mismatches, SQLite/filesystem diagnostics, timeouts, other phases and other modules remain fatal.
