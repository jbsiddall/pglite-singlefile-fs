# PGlite on a SQLite-backed Durable Object

Run commands in this directory after installing the repository's dependencies with `npm ci` at its root. Node.js 22.13 or later is required for seeding.

```sh
npm ci
npm run prepare-assets
```

Create an ignored `.dev.vars` file containing `WS_TOKEN=<a long random token>`, then start and seed the local Worker:

```sh
npx wrangler dev --local --port 8799 --persist-to .state
# In another terminal:
node --env-file=.dev.vars scripts/seed.mjs
```

Seeding runs initdb in Node and uploads its file rows. Workers cannot compile the extension modules needed by initdb. Use a fresh database. The first PostgreSQL startup attempt permanently closes imports, including across restarts; after a failed startup, recover using a fresh Durable Object rather than overwriting the image.

All routes require `Authorization: Bearer <WS_TOKEN>`. Without a configured secret the Worker refuses requests. For a deployment, set `WS_TOKEN` through `npx wrangler secret put WS_TOKEN`; keep it, account IDs, API tokens and connection strings out of tracked files. Local `.dev.vars`, generated assets, `.state` and `.seed.sqlite` are ignored.

Rejected HTTP request bodies are streamed and discarded before responding. This works around a reproduced local workerd forwarding failure; slow uploads delay rejection responses.

HTTP endpoints are `POST /sql` (one SQL statement), `GET /stats`, and `POST /import` (seed file rows). The benchmark sends the bearer header when `WS_TOKEN` is set:

```sh
node --env-file=.dev.vars ../bench.mjs http://localhost:8799 local-do
```

## PostgreSQL over WebSocket

`GET /ws` upgrades to a binary WebSocket carrying PostgreSQL wire-protocol bytes. It authenticates the upgrade using the same bearer header. Database user/password fields in PostgreSQL startup do not replace bearer authentication. The Durable Object holds one PGlite session: a second WebSocket and HTTP queries are refused while it is connected. Closing the socket rolls back an open transaction and resets session state.

The transport uses PGlite's `execProtocolRawStream` API and the message framing used by `@electric-sql/pglite-socket`. It buffers incomplete PostgreSQL messages across WebSocket frames. PostgreSQL TLS and cancellation are unsupported; use WSS for network encryption. The Node clients below require WSS except on loopback.

Each frontend protocol message is limited to 1 MiB, queued input to 4 MiB, and each message's response to 4 MiB. Responses wait for PGlite's persistence step before transmission. An oversized response closes the socket with code 1009; its SQL operation may already have committed, so do not blindly retry it.

Seeded catalogs do not make every extension available: a local `DO` block failed loading `plpgsql.so` because Workers forbid compiling its WASM side module. Queries requiring unloaded side modules need additional support.

### psql through a local bridge

The bridge listens only on `127.0.0.1`, forwards bytes with stream backpressure, and supplies the bearer header. Anyone able to connect to its local port gets the bridge's database access.

```sh
node --env-file=.dev.vars scripts/ws-bridge.mjs http://localhost:8799
# In another terminal:
PGSSLMODE=disable psql -h 127.0.0.1 -p 5433 -U postgres -d postgres \
  -c 'select version()'
```

Set `PGPORT` to change the bridge's listening port. To reach a deployed Worker, pass `https://<worker>.workers.dev` and set `WS_TOKEN` in your environment. Stop the bridge after use.

### Drizzle with neon-serverless (Node)

```sh
node --env-file=.dev.vars scripts/drizzle-smoke.mjs http://localhost:8799
```

The script uses Drizzle's `neon-serverless` adapter, an authenticated Node `ws` constructor, and `neonConfig.wsProxy = '<host>/ws'`. Neon appends `?address=pglite:5432`; this Worker ignores that address and always uses its bound database. The script disables Neon's password pipeline (`pipelineConnect = false`) because PGlite does not request password authentication, and disables PostgreSQL TLS inside the WebSocket. It checks parameterized queries, a transaction, and recovery after a SQL error. Close psql first to release the single session.

Browser WebSocket constructors cannot supply an Authorization header. This example supports Node clients; keep the bearer token in a trusted server or local bridge.

## Limits

A real Cloudflare deployment started, completed the HTTP benchmark, and passed psql/Drizzle WebSocket smoke checks with this example's settings: `shared_buffers=16MB`, `work_mem=1MB`, `maintenance_work_mem=16MB`, and `max_connections=10`, appended to PGlite's default startup parameters. Default PGlite settings failed startup with HTTP 400 and `RangeError: Invalid typed array length: 197722112`. [Recorded results](../../docs/benchmarks/cloudflare-do-production.json) cover these workloads and persistence across a clean redeployment. This does not guarantee that arbitrary queries fit Cloudflare's 128 MB memory limit. Local workerd results do not establish production memory usage, cold-start timings, or durable commit latency.

With a supplied store, filesystem metadata and chunks now flush together. This example supplies `ctx.storage.transactionSync`, so a throwing flush rolls back the entire batch; omitting that callback does not provide exception rollback. Tests cover interruption before flush, rollback on failure, and reads after truncate/extend. These checks do not prove recovery from every PostgreSQL crash scenario. No multi-connection PostgreSQL server behavior is promised.
