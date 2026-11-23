export function websocketConfig(target = process.argv[2] ?? 'http://localhost:8799') {
    const token = process.env.WS_TOKEN;
    if (!token) throw new Error('Set WS_TOKEN to the Worker bearer token');
    const url = new URL('/ws', target);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('Expected an HTTP or WebSocket URL');
    if (url.username || url.password) throw new Error('Keep credentials in WS_TOKEN');
    if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        throw new Error('Use wss:// outside localhost to protect the bearer token');
    }
    return { url, headers: { Authorization: `Bearer ${token}` } };
}
