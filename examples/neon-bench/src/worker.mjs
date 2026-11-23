import { neon } from '@neondatabase/serverless';

// Same API as examples/cloudflare-do: POST SQL text to /sql, get { rows }. Connection string comes from the NEON_URL secret.
export default {
    async fetch(request, env) {
        if (request.method !== 'POST') return new Response('POST SQL to /sql', { status: 405 });
        try {
            return Response.json({ rows: await neon(env.NEON_URL).query(await request.text()) });
        } catch (e) {
            return Response.json({ error: String(e) }, { status: 400 });
        }
    },
};
