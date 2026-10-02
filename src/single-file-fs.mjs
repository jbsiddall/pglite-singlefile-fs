import { openDatabase, disablePersistentWal } from './sqlite.mjs';
import { assertContainerFormat, markContainerFormat } from './container-format.mjs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { setImmediate } from 'node:timers';
import { BaseFilesystem, ERRNO_CODES } from '@electric-sql/pglite/basefs';
const PAGE = 8192;
const bytes = value => {
    if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer))
        return new Uint8Array(value);
    // Emscripten supplies HEAP8 (Int8Array); retain its underlying byte view.
    if (ArrayBuffer.isView(value))
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return value;
};
const fail = (code, message) => { throw Object.assign(new Error(message), { code: ERRNO_CODES[code] }); };
const validateIo = (buffer, offset, length, position) => {
    if (!(buffer instanceof Uint8Array))
        throw new TypeError('buffer must be a Uint8Array or ArrayBuffer');
    if (![offset, length, position].every(n => Number.isSafeInteger(n) && n >= 0) ||
        offset + length > buffer.length || !Number.isSafeInteger(position + length)) {
        throw new RangeError('Invalid filesystem byte range');
    }
};
// PostgreSQL remains the SQL engine. SQLite stores opaque file bytes. Missing
// chunks and omitted zero suffixes read as zeros; no PostgreSQL parsing needed.
export class SingleFileFS extends BaseFilesystem {
    constructor(filename, { durable = true, cacheBytes = 0, journalMode, pageSize, chunkTable, lockingMode = 'NORMAL', sqliteCacheKiB = 2000, walAutoCheckpointBytes = 32 * 1024 * 1024 } = {}) {
        super();
        if (typeof filename !== 'string' || !filename.length)
            throw new TypeError('filename must be a non-empty string');
        if (typeof durable !== 'boolean')
            throw new TypeError('durable must be a boolean');
        if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0)
            throw new RangeError('cacheBytes must be a non-negative integer');
        this.filename = filename === ':memory:' ? filename : path.resolve(filename);
        this.durable = durable;
        journalMode ??= durable ? 'WAL' : 'MEMORY';
        if (!['NORMAL', 'EXCLUSIVE'].includes(lockingMode))
            throw new Error('Unsupported lockingMode');
        if (!['DELETE', 'WAL', 'MEMORY'].includes(journalMode))
            throw new Error('Unsupported journalMode');
        if (durable && journalMode === 'MEMORY')
            throw new Error('MEMORY journal cannot provide durable persistence');
        if (pageSize !== undefined && ![4096, 8192, 16384, 32768, 65536].includes(pageSize))
            throw new Error('Unsupported pageSize');
        if (chunkTable !== undefined && !['rowid', 'without-rowid'].includes(chunkTable))
            throw new Error('Unsupported chunkTable');
        if (sqliteCacheKiB !== undefined && (!Number.isInteger(sqliteCacheKiB) || sqliteCacheKiB <= 0))
            throw new Error('sqliteCacheKiB must be positive');
        if (!Number.isSafeInteger(walAutoCheckpointBytes) || walAutoCheckpointBytes <= 0)
            throw new Error('walAutoCheckpointBytes must be positive');
        this.store = openDatabase(this.filename);
        try {
            assertContainerFormat(this.store);
            // Page size and layout are creation choices. Never silently rebuild an
            // existing image when requested options disagree with its persisted format.
            const schema = this.store.prepare("SELECT sql FROM sqlite_schema WHERE name='chunks'").get();
            const requestedPageSize = pageSize ?? (schema ? undefined : 8192);
            if (requestedPageSize !== undefined)
                this.store.exec('PRAGMA page_size=' + requestedPageSize);
            this.pageSize = this.store.prepare('PRAGMA page_size').get().page_size;
            if (pageSize !== undefined && this.pageSize !== pageSize)
                throw new Error('Existing image has a different pageSize');
            this.chunkTable = schema ? (/WITHOUT\s+ROWID/i.test(schema.sql) ? 'without-rowid' : 'rowid') : (chunkTable ?? 'rowid');
            if (schema && chunkTable !== undefined && this.chunkTable !== chunkTable)
                throw new Error('Existing image has a different chunkTable layout');
            // WAL+FULL retains SQLite protection independently of PostgreSQL WAL.
            // DELETE+EXTRA remains selectable; explicit fast mode is NOT crash-safe.
            this.store.exec(`PRAGMA locking_mode=${lockingMode}; PRAGMA mmap_size=0; PRAGMA journal_mode=${journalMode};
      PRAGMA synchronous=${durable ? (journalMode === 'WAL' ? 'FULL' : 'EXTRA') : 'OFF'}; PRAGMA temp_store=MEMORY;
      CREATE TABLE IF NOT EXISTS nodes (
        ino INTEGER PRIMARY KEY, path TEXT UNIQUE, mode INTEGER NOT NULL,
        size INTEGER NOT NULL DEFAULT 0, mtime INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (
        ino INTEGER NOT NULL, page INTEGER NOT NULL, data BLOB NOT NULL,
        PRIMARY KEY (ino,page)) ${this.chunkTable === 'without-rowid' ? 'WITHOUT ROWID' : ''};
      INSERT OR IGNORE INTO nodes(path,mode,mtime) VALUES ('/',16832,0);
      DELETE FROM chunks WHERE ino IN (SELECT ino FROM nodes WHERE path IS NULL);
      DELETE FROM nodes WHERE path IS NULL;`);
            this.journalMode = this.store.prepare('PRAGMA journal_mode').get().journal_mode;
            if (durable && this.journalMode !== journalMode.toLowerCase())
                throw new Error('Storage could not enable the requested durable journal mode');
            markContainerFormat(this.store);
            this.closeWithDeleteJournal = this.journalMode === 'wal' && disablePersistentWal(this.store);
            if (sqliteCacheKiB !== undefined)
                this.store.exec('PRAGMA cache_size=-' + sqliteCacheKiB);
            if (this.journalMode === 'wal')
                this.store.exec('PRAGMA wal_autocheckpoint=' + Math.max(1, Math.floor(walAutoCheckpointBytes / this.pageSize)));
            const prepare = sql => this.store.prepare(sql);
            this.sql = {
                begin: prepare('BEGIN'),
                commit: prepare('COMMIT'),
                create: prepare('INSERT INTO nodes(path,mode,mtime) VALUES (?,?,?)'),
                size: prepare('UPDATE nodes SET size=?,mtime=? WHERE ino=?'),
                mode: prepare('UPDATE nodes SET mode=? WHERE ino=?'),
                time: prepare('UPDATE nodes SET mtime=? WHERE ino=?'),
                rename: prepare('UPDATE nodes SET path=? WHERE ino=?'),
                get: prepare('SELECT data FROM chunks WHERE ino=? AND page=?'),
                range: prepare('SELECT page,data FROM chunks WHERE ino=? AND page>=? AND page<=?'),
                put: prepare('INSERT INTO chunks VALUES (?,?,?) ON CONFLICT(ino,page) DO UPDATE SET data=excluded.data'),
                remove: prepare('DELETE FROM chunks WHERE ino=? AND page=?'),
                trim: prepare('DELETE FROM chunks WHERE ino=? AND page>=?'),
                deleteNode: prepare('DELETE FROM nodes WHERE ino=?'),
            };
            this.checkpointStatements = Object.fromEntries(['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE']
                .map(mode => [mode, prepare('PRAGMA wal_checkpoint(' + mode + ')')]));
            this.nodes = new Map();
            this.inodes = new Map();
            for (const n of this.store.prepare('SELECT * FROM nodes').all()) {
                n.persistedSize = n.size;
                this.nodes.set(n.path, n);
                this.inodes.set(n.ino, n);
            }
            this.fds = new Map();
            this.fdFlags = new Map();
            this.nextFd = 1;
            this.dirty = new Map();
            this.dirtyNodes = new Set();
            this.cache = new Map();
            this.cachePages = Math.max(0, Math.floor(cacheBytes / PAGE));
            this.pending = false;
            this.closed = false;
            this.flushPromise = null;
            this.flushError = null;
            this.resetCounters();
        }
        catch (error) {
            this.store.close();
            throw error;
        }
    }
    resetCounters() {
        this.counters = { cacheHits: 0, cacheMisses: 0, coalescedWrites: 0, blobPuts: 0,
            zeroChunks: 0, trimmedBytes: 0, storedBytes: 0, metadataUpdates: 0, commits: 0, relaxedSyncs: 0, strictSyncs: 0 };
    }
    check() { if (this.flushError)
        throw this.flushError; if (this.closed)
        throw new Error('Filesystem is closed'); }
    norm(p) { return path.posix.resolve('/', p); }
    node(p) { this.check(); const n = this.nodes.get(this.norm(p)); if (!n)
        fail('ENOENT', p); return n; }
    fd(fd) { this.check(); const n = this.inodes.get(this.fds.get(fd)); if (!n)
        fail('EBADF', String(fd)); return n; }
    change() { this.check(); if (!this.pending) {
        this.sql.begin.run();
        this.pending = true;
    } }
    key(ino, page) { return ino + ':' + page; }
    cachePage(key, data) {
        if (!this.cachePages)
            return;
        this.cache.delete(key);
        this.cache.set(key, data);
        while (this.cache.size > this.cachePages)
            this.cache.delete(this.cache.keys().next().value);
    }
    page(ino, page) {
        const key = this.key(ino, page), dirty = this.dirty.get(key), cached = this.cache.get(key);
        if (dirty) {
            this.counters.cacheHits++;
            return dirty.data;
        }
        if (cached) {
            this.counters.cacheHits++;
            this.cachePage(key, cached);
            return cached;
        }
        this.counters.cacheMisses++;
        const data = new Uint8Array(PAGE), row = this.sql.get.get(ino, page);
        if (row)
            data.set(row.data);
        this.cachePage(key, data);
        return data;
    }
    savePage(n, page, data) {
        const key = this.key(n.ino, page);
        if (this.dirty.has(key))
            this.counters.coalescedWrites++;
        this.dirty.set(key, { ino: n.ino, page, data });
        this.cachePage(key, data);
    }
    commitChanges() {
        this.check();
        if (this.dirty.size || this.dirtyNodes.size)
            this.change();
        if (!this.pending)
            return;
        for (const { ino, page, data } of this.dirty.values()) {
            let end = data.length;
            while (end && data[end - 1] === 0)
                end--;
            this.counters.trimmedBytes += PAGE - end;
            if (end) {
                this.sql.put.run(ino, page, data.subarray(0, end));
                this.counters.blobPuts++;
                this.counters.storedBytes += end;
            }
            else {
                this.counters.zeroChunks++;
                if (page * PAGE < this.inodes.get(ino).persistedSize)
                    this.sql.remove.run(ino, page);
            }
        }
        for (const ino of this.dirtyNodes) {
            const n = this.inodes.get(ino);
            this.sql.size.run(n.size, n.mtime, ino);
            this.counters.metadataUpdates++;
        }
        this.sql.commit.run();
        this.pending = false;
        this.counters.commits++;
        for (const ino of this.dirtyNodes)
            this.inodes.get(ino).persistedSize = this.inodes.get(ino).size;
        this.dirty.clear();
        this.dirtyNodes.clear();
    }
    syncToFs(relaxed = false) {
        // PGlite decides whether its query awaits this Promise. Keep it alive until
        // persistence completes, so its own sync mutex covers the whole operation.
        if (this.closed)
            return Promise.resolve();
        if (!relaxed)
            this.counters.strictSyncs++;
        else
            this.counters.relaxedSyncs++;
        if (this.flushError)
            return relaxed ? Promise.resolve() : Promise.reject(this.flushError);
        if (this.flushPromise)
            return relaxed ? this.flushPromise : this.flushPromise.then(() => { if (this.flushError)
                throw this.flushError; });
        if (!relaxed) {
            try {
                this.commitChanges();
                return Promise.resolve();
            }
            catch (e) {
                this.flushError = e;
                return Promise.reject(e);
            }
        }
        this.flushPromise = this.waitForFlush().then(() => this.commitChanges())
            .catch(error => { this.flushError = error; }) // PGlite fire-and-forgets relaxed syncs.
            .finally(() => { this.flushPromise = null; });
        return this.flushPromise;
    }
    waitForFlush() { return new Promise(resolve => setImmediate(resolve)); }
    async flush() {
        if (this.flushPromise)
            await this.flushPromise;
        if (this.flushError)
            throw this.flushError;
        if (!this.closed)
            this.commitChanges();
    }
    async checkpointWal(mode = 'PASSIVE') {
        if (!['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'].includes(mode))
            throw new Error('Unsupported WAL checkpoint mode');
        await this.flush();
        this.check();
        // Independent of PostgreSQL's checkpoint: this copies container pages from
        // SQLite WAL to its main file, including bytes representing PostgreSQL WAL.
        return this.checkpointStatements[mode].get();
    }
    async checkpointPostgres(db, mode = 'TRUNCATE') {
        if (!['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'].includes(mode))
            throw new Error('Unsupported WAL checkpoint mode');
        this.check();
        if (this.pg && this.pg !== db)
            throw new Error('Checkpoint database must use this filesystem');
        await db.exec('CHECKPOINT');
        return this.checkpointWal(mode);
    }
    async closeFs() {
        if (this.closed)
            return;
        if (this.closePromise)
            return this.closePromise;
        this.closePromise = this.closeStorage();
        return this.closePromise;
    }
    async closeStorage() {
        let quitError;
        try {
            this.pg?.Module.FS.quit();
        } catch (error) {
            // Still drain pending writes if descriptor cleanup fails.
            quitError = error;
        }
        try {
            await this.flush();
            if (this.journalMode === 'wal') {
                const result = this.checkpointStatements.TRUNCATE.get();
                if (result.busy !== 0) throw new Error('Cannot close a portable image while SQLite WAL checkpoint is busy');
                if (this.closeWithDeleteJournal) {
                    const mode = this.store.prepare('PRAGMA journal_mode=DELETE').get().journal_mode;
                    if (mode !== 'delete') throw new Error('SQLite could not clean up persistent WAL');
                }
            }
        }
        finally {
            this.closed = true;
            this.store.close();
        }
        if (quitError) throw quitError;
    }
    stats(n) {
        return { dev: 0, ino: n.ino, mode: n.mode, nlink: n.path === null ? 0 : 1, uid: 0, gid: 0, rdev: 0,
            size: n.size, blksize: PAGE, blocks: Math.ceil(n.size / 512), atime: n.mtime, mtime: n.mtime, ctime: n.mtime };
    }
    lstat(p) { return this.stats(this.node(p)); }
    fstat(fd) { return this.stats(this.fd(fd)); }
    chmod(p, mode) { const n = this.node(p); this.change(); n.mode = (n.mode & 0o170000) | (mode & 0o7777); this.sql.mode.run(n.mode, n.ino); }
    utimes(p, atime, mtime) { const n = this.node(p); this.change(); n.mtime = mtime; this.sql.time.run(mtime, n.ino); }
    create(p, mode) {
        this.change();
        const result = this.sql.create.run(p, mode, Date.now());
        const n = { ino: Number(result.lastInsertRowid), path: p, mode, size: 0, persistedSize: 0, mtime: Date.now() };
        this.nodes.set(p, n);
        this.inodes.set(n.ino, n);
        return n;
    }
    mkdir(p, { recursive = false, mode = 0o700 } = {}) {
        p = this.norm(p);
        if (this.nodes.has(p)) {
            if (recursive) {
                if (!(this.node(p).mode & 0o40000))
                    fail('ENOTDIR', p);
                return;
            }
            fail('EEXIST', p);
        }
        const parent = path.posix.dirname(p);
        if (recursive && !this.nodes.has(parent))
            this.mkdir(parent, { recursive, mode });
        if (!(this.node(parent).mode & 0o40000))
            fail('ENOTDIR', parent);
        this.create(p, 0o40000 | (mode & 0o7777));
    }
    readdir(p) {
        p = this.norm(p);
        if (!(this.node(p).mode & 0o40000))
            fail('ENOTDIR', p);
        const prefix = p === '/' ? '/' : p + '/';
        return ['.', '..', ...[...this.nodes.keys()].filter(s => s.startsWith(prefix)).map(s => s.slice(prefix.length)).filter(s => s && !s.includes('/'))];
    }
    open(p, flags = 'r+', mode = 0o600) {
        this.check();
        if (typeof flags !== 'string' || !/^(r|r\+|rs|rs\+|w|wx|w\+|wx\+|a|ax|a\+|ax\+)$/.test(flags))
            fail('EINVAL', String(flags));
        p = this.norm(p);
        let n = this.nodes.get(p);
        if (n && flags.includes('x'))
            fail('EEXIST', p);
        if (!n && /[wa]/.test(flags)) {
            if (!(this.node(path.posix.dirname(p)).mode & 0o40000))
                fail('ENOTDIR', p);
            n = this.create(p, 0o100000 | (mode & 0o7777));
        }
        if (!n)
            fail('ENOENT', p);
        if (n.mode & 0o40000)
            fail('EISDIR', p);
        if (flags.startsWith('w'))
            this.truncate(p, 0);
        const fd = this.nextFd++;
        this.fds.set(fd, n.ino);
        this.fdFlags.set(fd, flags);
        return fd;
    }
    close(fd) {
        const n = this.fd(fd);
        this.fds.delete(fd);
        this.fdFlags.delete(fd);
        if (n.path === null && ![...this.fds.values()].includes(n.ino))
            this.remove(n);
    }
    read(fd, buffer, offset, length, position) {
        const n = this.fd(fd), target = bytes(buffer);
        if (!this.fdFlags.get(fd).startsWith('r') && !this.fdFlags.get(fd).includes('+'))
            fail('EBADF', String(fd));
        validateIo(target, offset, length, position);
        length = Math.max(0, Math.min(length, n.size - position));
        target.fill(0, offset, offset + length);
        if (!length)
            return 0;
        const first = Math.floor(position / PAGE), last = Math.floor((position + length - 1) / PAGE);
        if (last > first) {
            // PostgreSQL 18 issues multi-page reads. One range query replaces one
            // SQLite statement per 8 KiB page; dirty pages overlay persisted bytes.
            for (const row of this.sql.range.all(n.ino, first, last)) {
                const begin = Math.max(position, row.page * PAGE), end = Math.min(position + length, row.page * PAGE + row.data.length);
                if (end > begin)
                    target.set(row.data.subarray(begin - row.page * PAGE, end - row.page * PAGE), offset + begin - position);
            }
            for (const { ino, page, data } of this.dirty.values())
                if (ino === n.ino && page >= first && page <= last) {
                    const begin = Math.max(position, page * PAGE), end = Math.min(position + length, (page + 1) * PAGE);
                    target.set(data.subarray(begin - page * PAGE, end - page * PAGE), offset + begin - position);
                }
        }
        else
            target.set(this.page(n.ino, first).subarray(position % PAGE, position % PAGE + length), offset);
        return length;
    }
    write(fd, buffer, offset, length, position) {
        const n = this.fd(fd), source = bytes(buffer), flags = this.fdFlags.get(fd);
        if (flags.startsWith('r') && !flags.includes('+'))
            fail('EBADF', String(fd));
        if (flags.startsWith('a'))
            position = n.size;
        validateIo(source, offset, length, position);
        if (!length)
            return 0;
        for (let done = 0; done < length;) {
            const at = position + done, page = Math.floor(at / PAGE), start = at % PAGE, count = Math.min(PAGE - start, length - done);
            const data = start === 0 && count === PAGE ? new Uint8Array(PAGE) : this.page(n.ino, page).slice();
            data.set(source.subarray(offset + done, offset + done + count), start);
            this.savePage(n, page, data);
            done += count;
        }
        n.size = Math.max(n.size, position + length);
        n.mtime = Date.now();
        this.dirtyNodes.add(n.ino);
        return length;
    }
    discard(ino, first) {
        for (const [key, d] of this.dirty)
            if (d.ino === ino && d.page >= first)
                this.dirty.delete(key);
        for (const key of this.cache.keys()) {
            const [i, p] = key.split(':').map(Number);
            if (i === ino && p >= first)
                this.cache.delete(key);
        }
    }
    truncate(p, len = 0) {
        const n = this.node(p);
        if (!Number.isSafeInteger(len) || len < 0)
            throw new RangeError('length must be a non-negative integer');
        if (n.mode & 0o40000)
            fail('EISDIR', p);
        this.change();
        this.sql.trim.run(n.ino, Math.ceil(len / PAGE));
        this.discard(n.ino, Math.ceil(len / PAGE));
        if (len < n.size && len % PAGE) {
            const page = Math.floor(len / PAGE), data = this.page(n.ino, page).slice();
            data.fill(0, len % PAGE);
            this.savePage(n, page, data);
        }
        n.size = len;
        n.mtime = Date.now();
        this.dirtyNodes.add(n.ino);
    }
    writeFile(p, data, { mode = 0o600, encoding = 'utf8', flag = 'w' } = {}) {
        p = this.norm(p);
        const b = typeof data === 'string' ? Buffer.from(data, encoding) : bytes(data);
        if (!(b instanceof Uint8Array))
            throw new TypeError('data must be a string, Uint8Array or ArrayBuffer');
        const fd = this.open(p, flag, mode);
        try {
            this.write(fd, b, 0, b.length, 0);
        }
        finally {
            this.close(fd);
        }
    }
    remove(n) {
        if ([...this.fds.values()].includes(n.ino)) {
            this.change();
            this.sql.rename.run(null, n.ino);
            this.nodes.delete(n.path);
            n.path = null;
            return;
        }
        this.change();
        this.sql.trim.run(n.ino, 0);
        this.sql.deleteNode.run(n.ino);
        this.discard(n.ino, 0);
        this.dirtyNodes.delete(n.ino);
        this.nodes.delete(n.path);
        this.inodes.delete(n.ino);
    }
    unlink(p) { const n = this.node(p); if (n.mode & 0o40000)
        fail('EISDIR', p); this.remove(n); }
    rmdir(p) { const n = this.node(p); if (n.path === '/')
        fail('EBUSY', p); if (!(n.mode & 0o40000))
        fail('ENOTDIR', p); if (this.readdir(p).length > 2)
        fail('ENOTEMPTY', p); this.remove(n); }
    rename(from, to) {
        from = this.norm(from);
        to = this.norm(to);
        const n = this.node(from);
        if (from === to)
            return;
        if (from === '/' || to === '/')
            fail('EBUSY', from);
        if ((n.mode & 0o40000) && to.startsWith(from + '/'))
            fail('EINVAL', to);
        if (!(this.node(path.posix.dirname(to)).mode & 0o40000))
            fail('ENOTDIR', to);
        const old = this.nodes.get(to);
        if (old) {
            if ((n.mode & 0o40000) && !(old.mode & 0o40000))
                fail('ENOTDIR', to);
            if (!(n.mode & 0o40000) && (old.mode & 0o40000))
                fail('EISDIR', to);
        }
        this.change();
        if (old) {
            if (old.mode & 0o40000)
                this.rmdir(to);
            else
                this.unlink(to);
        }
        const moved = [n, ...[...this.nodes.values()].filter(c => c.path.startsWith(from + '/'))];
        for (const child of moved) {
            const newPath = to + child.path.slice(from.length);
            this.sql.rename.run(newPath, child.ino);
            this.nodes.delete(child.path);
            child.path = newPath;
            this.nodes.set(newPath, child);
        }
    }
}
