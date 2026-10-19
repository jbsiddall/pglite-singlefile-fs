import assert from 'node:assert/strict';
import { Client, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import WebSocket from 'ws';
import { websocketConfig } from './ws-config.mjs';

const { url, headers } = websocketConfig();
neonConfig.webSocketConstructor = class extends WebSocket {
    constructor(address) {
        super(address, { headers, handshakeTimeout: 10_000 });
    }
};
neonConfig.wsProxy = `${url.host}${url.pathname}`;
neonConfig.useSecureWebSocket = url.protocol === 'wss:';
neonConfig.forceDisablePgSSL = true;
neonConfig.pipelineConnect = false;
const client = new Client({
    host: 'pglite', port: 5432, user: 'postgres', database: 'postgres',
    ssl: false, connectionTimeoutMillis: 10_000, query_timeout: 10_000,
});
client.on('error', error => console.error(`PostgreSQL connection error: ${error.message}`));
try {
    await client.connect();
    const db = drizzle(client);
    const result = await db.execute(sql`SELECT ${42}::integer AS answer`);
    assert.equal(result.rows[0].answer, 42);
    await db.execute(sql`CREATE TEMP TABLE ws_drizzle_smoke (id integer PRIMARY KEY, value text)`);
    await db.transaction(async transaction => {
        await transaction.execute(sql`INSERT INTO ws_drizzle_smoke VALUES (${1}, ${'via Drizzle'})`);
        const selected = await transaction.execute(sql`SELECT value FROM ws_drizzle_smoke WHERE id = ${1}`);
        assert.equal(selected.rows[0].value, 'via Drizzle');
    });
    await assert.rejects(db.execute(sql`SELECT * FROM ws_drizzle_missing_table`));
    assert.equal((await db.execute(sql`SELECT 1::integer AS alive`)).rows[0].alive, 1);
    console.log('Drizzle neon-serverless: parameters, transaction, query error and recovery passed');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    let timer;
    try {
        await Promise.race([
            client.end(),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('PostgreSQL connection shutdown timed out')), 2_000);
            }),
        ]);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    } finally {
        clearTimeout(timer);
    }
}
