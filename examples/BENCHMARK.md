# Benchmark: PGlite on a Durable Object vs Neon

Both Workers expose the same API (`POST /sql`, body is one SQL statement), so one script benchmarks both from your machine.

## 1. Deploy the PGlite Worker
```sh
cd examples/cloudflare-do
npm install && npm run prepare-assets
npx wrangler deploy
npx wrangler secret put WS_TOKEN # use a long random bearer token
# Set WS_TOKEN in this shell to the same value without committing it.
node scripts/seed.mjs https://<your-pglite-worker>.workers.dev
```
`seed.mjs` runs initdb in Node and uploads the files once; Workers cannot run initdb themselves.

## 2. Deploy the Neon Worker
```sh
cd examples/neon-bench
npm install
npx wrangler deploy
npx wrangler secret put NEON_URL   # paste the Neon connection string when prompted
```
Pick a Neon region near the Cloudflare location you test from. Keep the connection string out of git.

## 3. Run
```sh
node examples/bench.mjs https://<your-pglite-worker>.workers.dev pglite
node examples/bench.mjs https://<your-neon-worker>.workers.dev neon
```
Run each a few times; the first run of the PGlite Worker includes cold start.

The PGlite Worker requires `Authorization: Bearer <WS_TOKEN>` on all routes. The seed and benchmark scripts read `WS_TOKEN` from the environment; the benchmark also works without it for the Neon Worker. See [the Durable Object example](cloudflare-do/README.md) for authenticated WebSocket, psql and Drizzle clients and the limits of local measurements.

## Local deferred-write comparison

[Complete results and conditions](../docs/benchmarks/cloudflare-do-local-atomicity.json), recorded on 2026-10-19 with Node 24.19.0, PGlite 0.5.8 and Wrangler 4.151.1. Both local workerd instances used identical Worker code, dependencies and seed image; only `SingleFileFS` differed. The baseline filesystem is from `b5d1b85`. Three suites per variant ran in the order before/after, after/before, before/after. Each engine was started before timing. Storage was fresh once per variant, reused between its suites, and OS caches were not cleared.

These are medians of the three per-suite medians, in milliseconds per HTTP request:

| Workload | Before | Deferred writes | After / before |
| --- | ---: | ---: | ---: |
| Individual insert | 5.67 | 5.47 | 0.96× |
| Insert 20,000 rows | 128.09 | 140.29 | 1.10× |
| Point select | 4.82 | 4.76 | 0.99× |
| Aggregate scan | 8.27 | 8.05 | 0.97× |
| Individual update | 4.81 | 4.81 | 1.00× |
| Update all 20,100 rows | 157.86 | 163.55 | 1.04× |
| Create/insert/truncate/drop mix | 7.44 | 6.78 | 0.91× |

The metadata workload repeats 20 cycles of four separate requests; its median mixes those operations. Bulk operations have only one sample per suite. Three local runs show a roughly 10% bulk-insert increase here, but do not establish a universal cost or a significant speedup for the faster cases. Keeping metadata and page changes in one transaction is a correctness choice. These results establish neither production memory feasibility nor real Cloudflare latency. No Neon comparison was run.
