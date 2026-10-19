// Runs initdb in Node, then uploads the resulting files to a running dev server's Durable Object.
import { PGlite } from '@electric-sql/pglite';
import { SingleFileFS } from '../../../src/index.mjs';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';

const target = process.argv[2] ?? 'http://localhost:8799';
const token = process.env.WS_TOKEN;
if (!token) throw new Error('Set WS_TOKEN to the Worker bearer token before seeding');
const file = '.seed.sqlite';
for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
const db = await PGlite.create({ fs: new SingleFileFS(file) });
await db.close();

const sqlite = new DatabaseSync(file, { readOnly: true });
const nodes = sqlite.prepare('SELECT ino,path,mode,size,mtime FROM nodes').all().map(n => Object.values(n));
const chunks = sqlite.prepare('SELECT ino,page,data FROM chunks').all().map(c => [c.ino, c.page, Buffer.from(c.data).toString('base64')]);
const post = async body => {
    const response = await fetch(`${target}/import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Import failed: HTTP ${response.status}`);
    return response.json();
};
console.log(await post({ nodes, chunks: [] }));
for (let i = 0; i < chunks.length; i += 200) await post({ nodes: [], chunks: chunks.slice(i, i + 200) });
console.log('uploaded', nodes.length, 'nodes', chunks.length, 'chunks');
