// Use the SQLite implementation shipped with the host runtime. Bun's
// statements expose the same positional-bind API as node:sqlite (also Deno),
// so the filesystem does not need a downloaded native binding.
const sqliteModule = globalThis.Bun
    ? await import('bun:sqlite')
    : await import('node:sqlite');
export function openDatabase(filename) {
    return globalThis.Bun
        ? new sqliteModule.Database(filename, { create: true, strict: true })
        : new sqliteModule.DatabaseSync(filename);
}

// Apple's system SQLite (used by Bun on macOS) keeps WAL sidecars by default.
// Ask SQLite itself to disable persistence; never remove these files manually.
// Old Bun versions without fileControl need a DELETE journal transition at
// clean close, after the final truncating checkpoint.
export function disablePersistentWal(store) {
    if (!globalThis.Bun) return false;
    const operation = sqliteModule.constants?.SQLITE_FCNTL_PERSIST_WAL;
    if (typeof store.fileControl === 'function' && typeof operation === 'number') {
        const status = store.fileControl(operation, 0);
        if (status !== 0) throw new Error('SQLite could not disable persistent WAL');
        return false;
    }
    return true;
}
