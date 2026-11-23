import { createServer } from 'node:net';
import WebSocket, { createWebSocketStream } from 'ws';
import { websocketConfig } from './ws-config.mjs';

const { url, headers } = websocketConfig();
const port = Number(process.env.PGPORT ?? 5433);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PGPORT');
const connections = new Set();
const server = createServer(socket => {
    const websocket = new WebSocket(url, { headers, handshakeTimeout: 10_000 });
    const stream = createWebSocketStream(websocket);
    const cleanup = () => {
        connections.delete(socket);
        socket.destroy();
        stream.destroy();
    };
    connections.add(socket);
    socket.setNoDelay(true);
    socket.on('error', cleanup);
    stream.on('error', error => {
        console.error(`WebSocket connection failed: ${error.message}`);
        cleanup();
    });
    socket.on('close', cleanup);
    stream.on('close', cleanup);
    socket.pipe(stream).pipe(socket);
});
server.on('error', error => {
    console.error(error.message);
    process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log(`PostgreSQL bridge listening on 127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        server.close();
        for (const socket of connections) socket.destroy();
    });
}
