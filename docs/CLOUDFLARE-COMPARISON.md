# Cloudflare prototype: provider comparisons and capacity

Checked on 2026-10-19. These are evidence and limits of this prototype, not a claim that it replaces either managed service.

Our [production receipt](benchmarks/cloudflare-do-production.json) records one warmed, sequential HTTP suite through the managed environment proxy and Cloudflare Access: median point reads 46.17 ms, inserts 76.76 ms, updates 69.63 ms and aggregate scans 51.55 ms. Bulk insert took 529.96 ms and bulk update 407.40 ms, each with one sample. The [local workerd per-row timings around 5 ms](../examples/BENCHMARK.md) exclude the production network path and cannot substitute for those results.

There is no controlled head-to-head Neon or Supabase run. Our single PGlite session also cannot establish the concurrent throughput or connection-pool capacity of those services. A Durable Object has one location at a time; deploying its front-end Worker globally does not replicate this PostgreSQL database near every client.

| Published evidence | Reported result | Why it differs from our suite |
| --- | --- | --- |
| [Neon, July 2023](https://neon.com/blog/sub-10ms-postgres-queries-for-vercel-edge-functions) | Same-region reads in single-digit milliseconds using SQL-over-HTTP. | Small one-shot reads, favorable regional placement and proxy connection caching; historical marketing, not a latency SLA. |
| [Neon methodology, June 2024](https://neon.com/blog/how-to-minimise-the-impact-of-database-latency) | Regional benchmark targets SQL executing in under 1 ms. | Excludes database/function cold starts; measures the backend-to-database path rather than our complete client path. |
| [Supabase Supavisor, August 2023](https://supabase.com/blog/supavisor-1-million) | Read median 2 ms / p95 3 ms at 5,000 QPS; median 18.4 ms at 20,000 QPS. | Tiny synthetic reads on vendor-controlled infrastructure with large compute and connection pools. It is not a public internet REST benchmark. |
| [Supabase, October 2026](https://supabase.com/blog/select-2026-scale-without-limits), [DBArena methodology](https://dbarena.com/methodology) | Markets OrioleDB throughput up to 1.8 times heap Postgres. DBArena publishes transaction throughput and latency. | Supabase-sponsored, not independent. TPC-C-derived transactions over direct TLS, multi-client concurrency, long warmup and measurements, three runs; different SQL and metric from our HTTP statement medians. |
| [DevOps Daily, June 2026](https://devops-daily.com/posts/neon-vs-supabase-free-tier-benchmarks), [public harness](https://github.com/The-DevOps-Daily/serverless-postgres-benchmarks) | Reports roughly 25–30 ms medians across Neon/Supabase connection paths; Neon suspended-compute wake 568 ms median / 1.06 s p95. | Independent published experiment, not our reproduction. Same-region Frankfurt client, free plans, 50 connect/TLS/auth/`SELECT 1`/disconnect samples per latency path; 20 actual wake samples. Different query, placement and transport. |

These sources show that both services can post lower numbers under suitable conditions. They do not measure a speed ratio against this prototype. A fair comparison needs the same SQL, data, client location, transport, transaction boundaries, durability guarantees and sample counts, with cold starts and concurrency tested separately. Our cold request observation and vendor compute-resume timings are also different measurements.

Firsthand public reports are mixed and not a representative survey:

| Report | What the author experienced | Evidential limit |
| --- | --- | --- |
| [Hacker News, August 2024](https://news.ycombinator.com/item?id=41223327) | One developer reported improvement moving an application from Supabase to Neon-backed Vercel Postgres. Another reported a Prisma transaction improving from about 3 s to 1 s after moving away from Neon to a colocated database. | No controlled workload or matching regions. Opposite experiences in the same discussion; location and sequential ORM round trips matter. |
| [Supabase user, June 2025](https://www.reddit.com/r/Supabase/comments/1lfdfj9/is_supabase_not_ready_for_production_or_for_not/) | Reports satisfactory operation with hundreds of millions of rows, larger instances and replicas. | Positive production anecdote, without comparable latency/load measurements. |
| [Supabase user, July 2025](https://www.reddit.com/r/Supabase/comments/1m5siz0/expected_performance_on_the_free_tier/) | Reports about 100 ms for 20 rows and 200–300 ms with relations despite about 20 ms SQL execution. | Application/Prisma/network timing, not raw database execution. |
| [Supabase user, December 2024](https://www.reddit.com/r/Supabase/comments/1hegak6/exploring_db_options/) | Initially reports about 20 s for 1,000 rows; later reports parity after changing connection configuration. | Demonstrates why an initial slow report need not describe an inherent database limit. |

The defensible description of our current evidence is a working Cloudflare prototype with measured warmed latency on the tested path. Neither vendor marketing nor these anecdotes establishes that ours is faster, more reliable or cheaper.

Prisma Client 7.10.1 passed on Node 24.19.0 against both local workerd and real Cloudflare, using `@prisma/adapter-neon` directly over authenticated WSS and `@prisma/adapter-pg` through the local TCP/WebSocket bridge. [The four-path receipt](benchmarks/cloudflare-do-prisma.json) records generated TypeScript CRUD, parameters, interactive commit/rollback, unique-error recovery and reconnect persistence. Each client pool uses one connection. This confirms those client operations, not Prisma Migrate, arbitrary schema features, browser authentication or Prisma execution inside a Worker. [Runnable instructions](../examples/cloudflare-do/README.md#prisma-client-node--typescript) accompany the example.

Cloudflare capacity is a backing-store quota, not a tested PostgreSQL payload capacity:

| Constraint | What can be stated |
| --- | --- |
| SQLite-backed Durable Object on Workers Paid | [10 GB per object](https://developers.cloudflare.com/durable-objects/platform/limits/), decimal GB. This includes the backing SQLite database, its rows and indexes, rather than 10 GB of user table payload. |
| Workers Free | The same page's explicit storage-full FAQ says 1 GB per object; its main table says 10 GB with a 5 GB Free-account total footnote. The current documentation conflicts. Conservatively budget 1 GB/object and 5 GB/account until Cloudflare clarifies it; we have not exercised either boundary. |
| Resident memory | [128 MB per Worker isolate](https://developers.cloudflare.com/workers/platform/limits/), including JavaScript and WASM. This is not a 128 MB stored-database limit: our filesystem reads pages from storage instead of loading the entire database into memory. Large queries, transaction dirty pages and inode metadata can still exhaust memory before storage fills. |
| WASM addressing | PGlite 0.5.8's configured maximum heap is 2 GiB, not a total database size cap. Bounded local sparse-file controls passed through actual WASM read/write syscalls above 4 GiB. [These controls](benchmarks/cloudflare-do-capacity-controls.json) allocate only a few stored chunks; they are not multi-gigabyte PostgreSQL database tests. |
| What we tested | The native Node adapter has a [5.006 GiB PostgreSQL relation benchmark](benchmarks/node24-linux-x64-large.json). Its closed SQLite container was 10,969,530,368 bytes, already above the Cloudflare paid quota; the host-store layout can have different overhead. Cloudflare has only the much smaller production suite: 20,100 benchmark rows. A subsequent query reported `pg_database_size(current_database()) = 11706491` bytes and `pg_total_relation_size('bench') = 4030464` bytes. Those PostgreSQL measurements exclude other cluster/SQLite overhead and do not certify a maximum. |

The current example routes every request to the same Durable Object. More objects can host separate databases, but do not automatically enlarge one PostgreSQL database. Usable capacity depends on data, indexes, chunk encoding and filesystem/SQLite overhead. Production behavior near the storage quota and recovery after a quota-exhausted write remain unverified.
