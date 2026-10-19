import assert from 'node:assert/strict';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaNeon } from '@prisma/adapter-neon';
import { neonConfig } from '@neondatabase/serverless';
import WebSocket from 'ws';
import { PrismaClient } from '../generated/prisma/client.ts';
import { websocketConfig } from './ws-config.mjs';

const port = Number(process.env.PGPORT ?? 5433);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PGPORT');
const directWebSocket = process.argv[2] === '--ws';
if (directWebSocket) {
    const { url, headers } = websocketConfig(process.argv[3]);
    neonConfig.webSocketConstructor = class extends WebSocket {
        constructor(address: string | URL) {
            super(address, { headers, handshakeTimeout: 10_000 });
        }
    };
    neonConfig.wsProxy = `${url.host}${url.pathname}`;
    neonConfig.useSecureWebSocket = url.protocol === 'wss:';
    neonConfig.forceDisablePgSSL = true;
    neonConfig.pipelineConnect = false;
    neonConfig.poolQueryViaFetch = false;
}
const createClient = () => new PrismaClient({ adapter: directWebSocket
    ? new PrismaNeon({ host: 'pglite', port: 5432, user: 'postgres', database: 'postgres', ssl: false,
        max: 1, connectionTimeoutMillis: 10_000, query_timeout: 15_000 })
    : new PrismaPg({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', ssl: false,
        max: 1, connectionTimeoutMillis: 10_000, query_timeout: 15_000 }),
});
let client = createClient();
const quoted = "Prisma's parameter'; DROP TABLE prisma_smoke; --";
try {
    await client.$executeRaw`CREATE TABLE prisma_smoke (id serial PRIMARY KEY, name text UNIQUE NOT NULL, value text NOT NULL)`;
    const row = await client.prismaSmoke.create({ data: { name: quoted, value: 'created' } });
    assert.equal((await client.prismaSmoke.findUniqueOrThrow({ where: { name: quoted } })).id, row.id);
    assert.equal((await client.prismaSmoke.update({ where: { id: row.id }, data: { value: 'updated' } })).value, 'updated');
    await client.$transaction(async transaction => {
        await transaction.prismaSmoke.create({ data: { name: 'transaction committed', value: 'kept' } });
        assert.equal(await transaction.prismaSmoke.count(), 2);
    });
    await assert.rejects(client.$transaction(async transaction => {
        await transaction.prismaSmoke.create({ data: { name: 'transaction rolled back', value: 'discarded' } });
        throw new Error('Intentional rollback');
    }), /Intentional rollback/);
    assert.equal(await client.prismaSmoke.count({ where: { name: 'transaction rolled back' } }), 0);
    await assert.rejects(client.prismaSmoke.create({ data: { name: quoted, value: 'duplicate' } }),
        (error: unknown) => (error as { code?: string }).code === 'P2002');
    assert.equal(await client.prismaSmoke.count(), 2);
    await client.$disconnect();
    client = createClient();
    assert.equal(await client.prismaSmoke.count(), 2);
    assert.equal((await client.prismaSmoke.delete({ where: { id: row.id } })).name, quoted);
    assert.equal(await client.prismaSmoke.count(), 1);
    await client.$executeRaw`DROP TABLE prisma_smoke`;
    console.log(`Prisma ${directWebSocket ? 'adapter-neon direct WebSocket' : 'adapter-pg TCP bridge'}: generated TypeScript CRUD, parameters, commit, rollback, unique error recovery and reconnect passed`);
} finally {
    await client.$disconnect();
}
