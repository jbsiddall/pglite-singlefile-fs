// Emscripten's addFunction compiles a tiny wasm module at runtime, which Workers forbid.
// Run PGlite once in Node, record those modules, and save them for the Worker to import precompiled.
import { PGlite } from '@electric-sql/pglite';
import { writeFileSync, mkdirSync } from 'node:fs';

const seen = new Map();
WebAssembly.Module = new Proxy(WebAssembly.Module, {
    construct(target, args) {
        const [bytes] = args;
        if (bytes?.byteLength < 200) seen.set(Buffer.from(bytes).toString('hex'), Buffer.from(bytes));
        return new target(...args);
    },
});
let db; try { db = await PGlite.create(); } catch (e) { console.error("FAILED:", String(e.message).slice(0, 300), e.stack?.split("\n").slice(1, 4).join("\n").slice(0, 400)); process.exit(1); }
await db.close();
mkdirSync('assets', { recursive: true });
const files = [...seen.values()].map((bytes, i) => (writeFileSync(`assets/trampoline-${i}.wasm`, bytes), `trampoline-${i}.wasm`));
writeFileSync('assets/trampolines.json', JSON.stringify([...seen.keys()]));
console.log('captured', files);
