// usage: node bench.mjs http://localhost:PORT [label]
const base = process.argv[2], label = process.argv[3] ?? base;
const headers = process.env.WS_TOKEN ? { Authorization: `Bearer ${process.env.WS_TOKEN}` } : {};
const sql = async text => {
    const t = performance.now();
    const res = await fetch(`${base}/sql`, { method: 'POST', headers, body: text });
    const body = await res.json();
    if (body.error || !res.ok) throw new Error(`${text.slice(0, 60)} -> ${JSON.stringify(body).slice(0, 200)}`);
    return { ms: performance.now() - t, body };
};
const stats = a => { const s = [...a].sort((x, y) => x - y); return { n: s.length, medianMs: +s[s.length >> 1].toFixed(2), p95Ms: +s[Math.floor(s.length * 0.95)].toFixed(2), totalMs: +s.reduce((x, y) => x + y, 0).toFixed(1) }; };
const results = {};
const run = async (name, texts) => {
    const times = []; let read = 0, written = 0;
    for (const t of texts) { const r = await sql(t); times.push(r.ms); read += r.body.rowsRead ?? 0; written += r.body.rowsWritten ?? 0; }
    results[name] = { ...stats(times), rowsRead: read, rowsWritten: written };
};
await sql('drop table if exists bench');
await sql('create table bench(id serial primary key, v text, n int)');
await run('insert_single_x100', Array.from({ length: 100 }, (_, i) => `insert into bench(v,n) values ('row ${i}', ${i})`));
await run('insert_bulk_20000_rows', ['insert into bench(v,n) select md5(g::text), g from generate_series(1,20000) g']);
await run('select_point_x200', Array.from({ length: 200 }, (_, i) => `select * from bench where id = ${1 + ((i * 97) % 20000)}`));
await run('select_scan_x5', Array.from({ length: 5 }, () => 'select count(*), sum(n), max(v) from bench'));
await run('update_single_x100', Array.from({ length: 100 }, (_, i) => `update bench set n = n + 1 where id = ${1 + ((i * 193) % 20000)}`));
await run('update_bulk_20000_rows', ['update bench set n = n + 1']);
await run('metadata_create_truncate_drop_x20', Array.from({ length: 20 }, (_, i) => [
    `create table bench_metadata_${i}(id integer, value text)`,
    `insert into bench_metadata_${i} select g, md5(g::text) from generate_series(1,100) g`,
    `truncate bench_metadata_${i}`,
    `drop table bench_metadata_${i}`,
]).flat());
console.log(JSON.stringify({ label, results }, null, 2));
