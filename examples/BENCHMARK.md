# Benchmark: PGlite on a Durable Object vs Neon

Both Workers expose the same API (`POST /sql`, body is one SQL statement), so one script benchmarks both from your machine.

## 1. Deploy the PGlite Worker
```sh
cd examples/cloudflare-do
npm install && npm run prepare-assets
npx wrangler deploy
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
