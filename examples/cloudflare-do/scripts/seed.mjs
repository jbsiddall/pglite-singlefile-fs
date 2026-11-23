// Runs initdb in Node, then uploads the resulting SingleFileFS KV tables to a running dev server's Durable Object.
import { PGlite } from '@electric-sql/pglite';
import { SingleFileFS } from '../../../src/index.mjs';
import { rmSync } from 'node:fs';

const target = process.argv[2] ?? 'http://localhost:8799';
const token = process.env.WS_TOKEN;
if (!token) throw new Error('Set WS_TOKEN to the Worker bearer token before seeding');
const file = '.seed.pglite';
rmSync(file, { force: true });
const db = await PGlite.create({ fs: new SingleFileFS(file) });
await db.close();

const ro = new SingleFileFS(file);
const b64 = bytes => Buffer.from(bytes).toString('base64');
const { meta, nodes, chunks } = ro.store.readTransaction(rtx => ({
    meta: rtx.scan('meta').map(({ key, value }) => [b64(key), b64(value)]),
    nodes: rtx.scan('nodes').map(({ key, value }) => [b64(key), b64(value)]),
    chunks: rtx.scan('chunks').map(({ key, value }) => [b64(key), b64(value)]),
}));
await ro.closeFs();

const post = async body => {
    const response = await fetch(`${target}/import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Import failed: HTTP ${response.status}`);
    return response.json();
};
console.log(await post({ meta, nodes, chunks: [] }));
for (let i = 0; i < chunks.length; i += 200) await post({ meta: [], nodes: [], chunks: chunks.slice(i, i + 200) });
console.log('uploaded', meta.length, 'meta', nodes.length, 'nodes', chunks.length, 'chunks');
