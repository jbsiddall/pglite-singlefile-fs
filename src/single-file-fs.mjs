import { BaseFilesystem, ERRNO_CODES } from '@electric-sql/pglite/basefs';
import { posixResolve, posixDirname } from './posix-path.mjs';
import {
  CONTAINER_MAGIC,
  FORMAT_VERSION,
  assertBackendIsRedbOrEmpty,
  assertContainerFormat,
  wrapReadOnlyNonClosing,
} from './container-format.mjs';
import {
  encodeChunk,
  decodeChunkInto,
  encodeNodeBinary,
  decodeNodeBinary,
  isAllZero,
} from './chunk-codec.mjs';

const DEFAULT_PAGE_SIZE = 8192;
const DEFAULT_REDB_CACHE_BYTES = 2 * 1024 * 1024; // 2 MiB default container page cache
const VALID_PAGE_SIZES = [4096, 8192, 16384, 32768, 65536];
const VALID_COMPRESSIONS = ['sparse', 'bitsparse32', 'bitsparse16', 'zerobytemask', 'lz4', 'none'];
const HAS_SAB = typeof SharedArrayBuffer !== 'undefined';

const textEncoder = new TextEncoder();

const bytes = value => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer || (HAS_SAB && value instanceof SharedArrayBuffer)) {
    return new Uint8Array(value);
  }
  // Emscripten supplies HEAP8 (Int8Array); retain its underlying byte view.
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return value;
};

function encodeString(str, encoding = 'utf8') {
  const enc = String(encoding || 'utf8').toLowerCase();
  if (enc === 'utf8' || enc === 'utf-8') {
    return textEncoder.encode(str);
  }
  if (enc === 'latin1' || enc === 'binary' || enc === 'ascii') {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }
  if (enc === 'hex') {
    const len = Math.floor(str.length / 2);
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = parseInt(str.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  if (enc === 'base64') {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  throw new Error(`Unsupported encoding: ${encoding}`);
}

const fail = (code, message) => {
  throw Object.assign(new Error(message), { code: ERRNO_CODES[code] });
};

const validateIo = (buffer, offset, length, position) => {
  if (!(buffer instanceof Uint8Array)) {
    throw new TypeError('buffer must be a Uint8Array or ArrayBuffer');
  }
  if (
    offset < 0 ||
    length < 0 ||
    position < 0 ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    !Number.isSafeInteger(position) ||
    offset + length > buffer.length ||
    !Number.isSafeInteger(position + length)
  ) {
    throw new RangeError('Invalid filesystem byte range');
  }
};

function encodeNodeKey(ino, out = new Uint8Array(4)) {
  out[0] = (ino >>> 24) & 0xff;
  out[1] = (ino >>> 16) & 0xff;
  out[2] = (ino >>> 8) & 0xff;
  out[3] = ino & 0xff;
  return out;
}

function encodeChunkKey(ino, page, out = new Uint8Array(8)) {
  out[0] = (ino >>> 24) & 0xff;
  out[1] = (ino >>> 16) & 0xff;
  out[2] = (ino >>> 8) & 0xff;
  out[3] = ino & 0xff;
  out[4] = (page >>> 24) & 0xff;
  out[5] = (page >>> 16) & 0xff;
  out[6] = (page >>> 8) & 0xff;
  out[7] = page & 0xff;
  return out;
}

function decodeChunkPage(key) {
  return ((key[4] << 24) | (key[5] << 16) | (key[6] << 8) | key[7]) >>> 0;
}

function normalizeOptions(filename, options = {}) {
  if (typeof filename !== 'string' || !filename.length) {
    throw new TypeError('filename must be a non-empty string');
  }
  const {
    durable = true,
    cacheBytes = 0,
    pageSize,
    redbCacheBytes,
    cacheSize,
    compression = 'sparse',
    storage = 'auto',
    backend,
    wasm,
    initialBytes,
    _store,
    _format,
    _resolvedFilename,
  } = options;

  if (typeof durable !== 'boolean') {
    throw new TypeError('durable must be a boolean');
  }
  if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0) {
    throw new RangeError('cacheBytes must be a non-negative integer');
  }
  if (pageSize !== undefined && !VALID_PAGE_SIZES.includes(pageSize)) {
    throw new Error('Unsupported pageSize');
  }
  if (!VALID_COMPRESSIONS.includes(compression)) {
    throw new Error('Unsupported compression mode');
  }
  if (!['auto', 'node', 'opfs', 'memory'].includes(storage)) {
    throw new Error('Unsupported storage mode');
  }

  const effectiveRedbCache = redbCacheBytes ?? cacheSize ?? DEFAULT_REDB_CACHE_BYTES;
  if (!Number.isSafeInteger(effectiveRedbCache) || effectiveRedbCache <= 0) {
    throw new Error('redbCacheBytes must be positive');
  }

  return {
    durable,
    cacheBytes,
    pageSize,
    redbCacheBytes: effectiveRedbCache,
    compression,
    storage,
    backend,
    wasm,
    initialBytes,
    _store,
    _format,
    _resolvedFilename,
  };
}

let defaultPlatform = null;

export function setPlatformAdapter(adapter) {
  defaultPlatform = adapter;
}

/**
 * Inspect an existing backend read-only before opening it read-write.
 * Works across Node.js, Bun, Deno, Browser OPFS, and Memory backends.
 * Returns parsed format metadata, null if empty, or `{ needsRepair: true }`
 * when a redb image needs crash repair after an unclean shutdown (SIGKILL).
 */
export function verifyBackendSync(RedbClass, backend, options) {
  const nonEmpty = assertBackendIsRedbOrEmpty(backend);
  if (!nonEmpty) return null;
  let roDb;
  try {
    roDb = RedbClass.openSync(wrapReadOnlyNonClosing(backend), {
      readOnly: true,
      cacheSize: 64 * 1024,
      wasm: options.wasm,
    });
  } catch (error) {
    if (/repair aborted/i.test(String(error?.message ?? error))) {
      return { needsRepair: true };
    }
    throw error;
  }
  try {
    return assertContainerFormat(roDb);
  } finally {
    roDb.close();
  }
}

export async function verifyBackendAsync(RedbClass, backend, options) {
  const nonEmpty = assertBackendIsRedbOrEmpty(backend);
  if (!nonEmpty) return null;
  let roDb;
  try {
    roDb = await RedbClass.open(wrapReadOnlyNonClosing(backend), {
      readOnly: true,
      cacheSize: 64 * 1024,
      wasm: options.wasm,
    });
  } catch (error) {
    if (/repair aborted/i.test(String(error?.message ?? error))) {
      return { needsRepair: true };
    }
    throw error;
  }
  try {
    return assertContainerFormat(roDb);
  } finally {
    roDb.close();
  }
}

// PostgreSQL remains the SQL engine. redb (Copy-on-Write ACID B-tree in WASM)
// stores opaque virtual-file metadata and self-describing sparse/compressed
// 8 KiB chunks in strictly ONE portable file across Node.js, Bun, Deno, and Browser OPFS.
export class SingleFileFS extends BaseFilesystem {
  constructor(filename, options = {}) {
    super();
    const norm = normalizeOptions(filename, options);

    let store = norm._store;
    let existingFormat = norm._format ?? null;
    let resolvedFilename = norm._resolvedFilename ?? filename;

    if (!store) {
      if (!defaultPlatform?.openSync) {
        throw new Error(
          'Synchronous SingleFileFS constructor requires a server runtime or pre-opened store; use await SingleFileFS.open(filename, options) in browsers'
        );
      }
      const opened = defaultPlatform.openSync(filename, norm);
      store = opened.store;
      existingFormat = opened.format;
      resolvedFilename = opened.filename;
    }

    this.filename = resolvedFilename;
    this.durable = norm.durable;
    this.redbCacheBytes = norm.redbCacheBytes;
    this.compression = norm.compression;
    this.store = store;

    try {
      if (existingFormat?.needsRepair) {
        existingFormat = assertContainerFormat(this.store);
      }
      if (existingFormat) {
        if (norm.pageSize !== undefined && existingFormat.pageSize !== norm.pageSize) {
          throw new Error('Existing image has a different pageSize');
        }
        this.pageSize = existingFormat.pageSize;
      } else {
        this.pageSize = norm.pageSize ?? DEFAULT_PAGE_SIZE;
      }

      this._keyBuf = new Uint8Array(8);
      this._startKeyBuf = new Uint8Array(8);
      this._endKeyBuf = new Uint8Array(8);
      this._nodeKeyBuf = new Uint8Array(4);
      this._nodeBuf = new Uint8Array(512);
      this._encBuf = new Uint8Array(this.pageSize + 1024);
      this._decBuf = new Uint8Array(this.pageSize + 1024);
      this._readPageBuf = new Uint8Array(this.pageSize);

      this.nodes = new Map();
      this.inodes = new Map();
      this.nextIno = 2;

      const orphaned = [];
      const needsInit = existingFormat === null;

      if (!needsInit) {
        this.store.readTransaction(rtx => {
          const nextInoRaw = rtx.getText('meta', 'next_ino');
          const entries = rtx.scan('nodes');
          let maxIno = 1;
          for (const { value } of entries) {
            const n = decodeNodeBinary(value);
            if (n.ino > maxIno) maxIno = n.ino;
            if (n.path === null) {
              orphaned.push(n);
            } else {
              n.persistedSize = n.size;
              n.persistedMtime = n.mtime;
              n.persistedMode = n.mode;
              n.persistedPath = n.path;
              n.persisted = true;
              this.nodes.set(n.path, n);
              this.inodes.set(n.ino, n);
            }
          }
          const parsedNext = nextInoRaw ? Number(nextInoRaw) : maxIno + 1;
          this.nextIno = Math.max(parsedNext, maxIno + 1, 2);
        });
      }

      if (needsInit || orphaned.length > 0) {
        this.store.writeTransaction(
          tx => {
            if (needsInit) {
              const root = { ino: 1, path: '/', mode: 16832, size: 0, mtime: 0 };
              tx.set(
                'meta',
                'format',
                JSON.stringify({
                  magic: CONTAINER_MAGIC,
                  version: FORMAT_VERSION,
                  pageSize: this.pageSize,
                })
              );
              tx.set('meta', 'next_ino', '2');
              tx.set('nodes', encodeNodeKey(1, this._nodeKeyBuf), encodeNodeBinary(root, this._nodeBuf));
              root.persistedSize = 0;
              root.persistedMtime = 0;
              root.persistedMode = 16832;
              root.persistedPath = '/';
              root.persisted = true;
              this.nodes.set('/', root);
              this.inodes.set(1, root);
              this.nextIno = 2;
            }
            for (const orphan of orphaned) {
              this._deletePersistedChunks(tx, orphan.ino, 0, orphan.size);
              tx.delete('nodes', encodeNodeKey(orphan.ino, this._nodeKeyBuf));
            }
          },
          { durable: this.durable }
        );
      }

      this.fds = new Map();
      this.fdFlags = new Map();
      this.nextFd = 1;
      this.dirty = new Map();
      this.dirtyNodes = new Set();
      this.deletedNodes = new Map(); // ino -> persistedSize
      this.truncates = new Map(); // ino -> lowest fromPage truncated since last commit
      this.metaDirty = false;
      this.cache = new Map();
      this.cachePages = Math.max(0, Math.floor(norm.cacheBytes / this.pageSize));
      this.rtx = null;
      this.closed = false;
      this.flushPromise = null;
      this.flushError = null;
      this.resetCounters();
    } catch (error) {
      try {
        this.store.close();
      } catch {}
      throw error;
    }
  }

  /**
   * Universal async factory that works in Node.js, Bun, Deno, and Browser OPFS / Memory.
   * Inside a Browser Dedicated Web Worker, automatically uses a single OPFS file via
   * FileSystemSyncAccessHandle unless `filename === ':memory:'` or `options.backend` is given.
   */
  static async open(filename, options = {}) {
    const norm = normalizeOptions(filename, options);
    if (!defaultPlatform?.openAsync) {
      throw new Error('No platform storage adapter registered');
    }
    const opened = await defaultPlatform.openAsync(filename, norm);
    return new SingleFileFS(filename, {
      ...options,
      _store: opened.store,
      _format: opened.format,
      _resolvedFilename: opened.filename,
    });
  }

  resetCounters() {
    this.counters = {
      cacheHits: 0,
      cacheMisses: 0,
      coalescedWrites: 0,
      blobPuts: 0,
      zeroChunks: 0,
      trimmedBytes: 0,
      storedBytes: 0,
      metadataUpdates: 0,
      commits: 0,
      relaxedSyncs: 0,
      strictSyncs: 0,
    };
  }

  check() {
    if (this.flushError) throw this.flushError;
    if (this.closed) throw new Error('Filesystem is closed');
  }

  norm(p) {
    return posixResolve(p);
  }

  node(p) {
    this.check();
    const n = this.nodes.get(this.norm(p));
    if (!n) fail('ENOENT', p);
    return n;
  }

  fd(fd) {
    this.check();
    const n = this.inodes.get(this.fds.get(fd));
    if (!n) fail('EBADF', String(fd));
    return n;
  }

  key(ino, page) {
    // Packed numeric key (safe integer for ino < 2^21 and page < 2^32) — zero string allocation
    return ino * 0x100000000 + page;
  }

  _hasOpenFd(ino) {
    for (const v of this.fds.values()) {
      if (v === ino) return true;
    }
    return false;
  }

  _getReadTx() {
    if (!this.rtx) {
      this.rtx = this.store.beginRead();
    }
    return this.rtx;
  }

  _closeReadTx() {
    if (this.rtx) {
      const rtx = this.rtx;
      this.rtx = null;
      rtx.close();
    }
  }

  cachePage(key, data) {
    if (!this.cachePages) return;
    this.cache.delete(key);
    this.cache.set(key, data);
    while (this.cache.size > this.cachePages) {
      this.cache.delete(this.cache.keys().next().value);
    }
  }

  /**
   * Load a persisted clean page from redb directly into `dst` (which must be length pageSize).
   */
  _loadCleanPageInto(ino, page, dst, zeroDst = true) {
    if (zeroDst) dst.fill(0);
    const n = this.inodes.get(ino);
    const truncLimit = this.truncates.get(ino);
    const canExistOnDisk =
      n?.persisted &&
      page * this.pageSize < n.persistedSize &&
      (truncLimit === undefined || page < truncLimit);
    if (canExistOnDisk) {
      const rtx = this._getReadTx();
      const encLen = rtx.getInto('chunks', encodeChunkKey(ino, page, this._keyBuf), this._decBuf, 0);
      if (encLen > 0) {
        decodeChunkInto(this._decBuf.subarray(0, encLen), dst, false);
      }
    }
  }

  page(ino, page) {
    const key = this.key(ino, page);
    const dirty = this.dirty.get(key);
    if (dirty) {
      this.counters.cacheHits++;
      return dirty.data;
    }
    const cached = this.cache.get(key);
    if (cached) {
      this.counters.cacheHits++;
      this.cachePage(key, cached);
      return cached;
    }
    this.counters.cacheMisses++;
    const data = new Uint8Array(this.pageSize);
    this._loadCleanPageInto(ino, page, data, false);
    this.cachePage(key, data);
    return data;
  }

  savePage(n, page, data) {
    const key = this.key(n.ino, page);
    if (this.dirty.has(key)) this.counters.coalescedWrites++;
    this.dirty.set(key, { ino: n.ino, page, data });
    this.cachePage(key, data);
  }

  hasPendingChanges() {
    return (
      this.dirty.size > 0 ||
      this.dirtyNodes.size > 0 ||
      this.deletedNodes.size > 0 ||
      this.truncates.size > 0 ||
      this.metaDirty
    );
  }

  _deletePersistedChunks(tx, ino, fromPage, persistedSize) {
    const persistedPages = Math.ceil(persistedSize / this.pageSize);
    if (fromPage >= persistedPages) return;
    const span = persistedPages - fromPage;
    if (span <= 4096) {
      for (let p = fromPage; p < persistedPages; p++) {
        tx.delete('chunks', encodeChunkKey(ino, p, this._keyBuf));
      }
      return;
    }
    const start = encodeChunkKey(ino, fromPage, new Uint8Array(8));
    const end = encodeChunkKey(ino + 1, 0, new Uint8Array(8));
    const rows = tx.scan('chunks', { start, end });
    for (let i = 0; i < rows.length; i++) {
      tx.delete('chunks', rows[i].key);
    }
  }

  /**
   * Hookable chunk write helper (also used by crash-recovery tests to verify
   * atomicity when SIGKILL arrives mid-WriteTransaction before commit).
   */
  _writeChunk(tx, ino, page, data) {
    tx.set('chunks', encodeChunkKey(ino, page, this._keyBuf), data);
  }

  commitChanges() {
    this.check();
    if (!this.hasPendingChanges()) return;

    // Close any open ReadTransaction BEFORE committing so redb can immediately
    // reclaim and reuse freed pages without growing the single file.
    this._closeReadTx();

    const tx = this.store.beginWrite({ durable: this.durable });
    try {
      for (const [ino, persistedSize] of this.deletedNodes) {
        if (persistedSize > 0) {
          this._deletePersistedChunks(tx, ino, 0, persistedSize);
        }
        tx.delete('nodes', encodeNodeKey(ino, this._nodeKeyBuf));
      }

      for (const [ino, fromPage] of this.truncates) {
        if (this.deletedNodes.has(ino)) continue;
        const n = this.inodes.get(ino);
        if (n?.persisted && n.persistedSize > 0) {
          this._deletePersistedChunks(tx, ino, fromPage, n.persistedSize);
        }
      }

      let dirtyList;
      if (this.dirty.size > 1) {
        // Insert dirty chunks in sorted (ino, page) numeric key order for optimal B-tree leaf locality
        const keys = [...this.dirty.keys()].sort((a, b) => a - b);
        dirtyList = new Array(keys.length);
        for (let i = 0; i < keys.length; i++) dirtyList[i] = this.dirty.get(keys[i]);
      } else {
        dirtyList = this.dirty.values();
      }

      for (const { ino, page, data } of dirtyList) {
        if (this.deletedNodes.has(ino)) continue;
        const encoded = encodeChunk(data, this.compression, this._encBuf);
        const encLen = encoded.byteLength;
        if (encLen > 0) {
          this.counters.trimmedBytes += Math.max(0, this.pageSize - encLen);
          this._writeChunk(tx, ino, page, encoded);
          this.counters.blobPuts++;
          this.counters.storedBytes += encLen;
        } else {
          this.counters.trimmedBytes += this.pageSize;
          this.counters.zeroChunks++;
          const n = this.inodes.get(ino);
          const truncLimit = this.truncates.get(ino);
          if (
            n?.persisted &&
            page * this.pageSize < n.persistedSize &&
            (truncLimit === undefined || page < truncLimit)
          ) {
            tx.delete('chunks', encodeChunkKey(ino, page, this._keyBuf));
          }
        }
      }

      for (const ino of this.dirtyNodes) {
        if (this.deletedNodes.has(ino)) continue;
        const n = this.inodes.get(ino);
        if (!n) continue;
        // lazytime: keep live mtime in RAM for lstat/fstat and only rewrite the
        // `nodes` B-tree on structural changes (create/size/mode/path), explicit
        // utimes(), or clean closeFs(). Avoids touching a 2nd B-tree on every WAL write.
        if (
          n.persisted &&
          n.size === n.persistedSize &&
          n.mode === n.persistedMode &&
          n.path === n.persistedPath &&
          !n.mtimeExplicit &&
          !this._flushingClose
        ) {
          continue;
        }
        if (
          n.persisted &&
          n.size === n.persistedSize &&
          n.mtime === n.persistedMtime &&
          n.mode === n.persistedMode &&
          n.path === n.persistedPath
        ) {
          n.mtimeExplicit = false;
          continue;
        }
        tx.set('nodes', encodeNodeKey(ino, this._nodeKeyBuf), encodeNodeBinary(n, this._nodeBuf));
        this.counters.metadataUpdates++;
        n.mtimeExplicit = false;
        n._nodeWritten = true;
      }

      if (this.metaDirty) {
        tx.set('meta', 'next_ino', String(this.nextIno));
      }

      tx.commit();
    } catch (error) {
      try {
        tx.abort();
      } catch {}
      throw error;
    }

    this.counters.commits++;
    for (const ino of this.dirtyNodes) {
      const n = this.inodes.get(ino);
      if (n && n._nodeWritten) {
        n._nodeWritten = false;
        n.persisted = true;
        n.persistedSize = n.size;
        n.persistedMtime = n.mtime;
        n.persistedMode = n.mode;
        n.persistedPath = n.path;
      }
    }
    this.dirty.clear();
    this.dirtyNodes.clear();
    this.deletedNodes.clear();
    this.truncates.clear();
    this.metaDirty = false;
  }

  syncToFs(relaxed = false) {
    // PGlite decides whether its query awaits this Promise. Keep it alive until
    // persistence completes, so its own sync mutex covers the whole operation.
    if (this.closed) return Promise.resolve();
    if (!relaxed) this.counters.strictSyncs++;
    else this.counters.relaxedSyncs++;

    if (this.flushError) {
      return relaxed ? Promise.resolve() : Promise.reject(this.flushError);
    }
    if (this.flushPromise) {
      return relaxed
        ? this.flushPromise
        : this.flushPromise.then(() => {
            if (this.flushError) throw this.flushError;
          });
    }
    if (!relaxed) {
      try {
        this.commitChanges();
        return Promise.resolve();
      } catch (e) {
        this.flushError = e;
        return Promise.reject(e);
      }
    }
    this.flushPromise = this.waitForFlush()
      .then(() => this.commitChanges())
      .catch(error => {
        this.flushError = error;
      }) // PGlite fire-and-forgets relaxed syncs.
      .finally(() => {
        this.flushPromise = null;
      });
    return this.flushPromise;
  }

  waitForFlush() {
    if (typeof globalThis.setImmediate === 'function') {
      return new Promise(resolve => globalThis.setImmediate(resolve));
    }
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  async flush() {
    if (this.flushPromise) await this.flushPromise;
    if (this.flushError) throw this.flushError;
    if (!this.closed) this.commitChanges();
  }

  async checkpointWal(mode = 'PASSIVE') {
    if (!['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'].includes(mode)) {
      throw new Error('Unsupported WAL checkpoint mode');
    }
    await this.flush();
    this.check();
    // redb uses Copy-on-Write commits in a single file with no WAL sidecar.
    // On TRUNCATE, compact free pages at the tail of the single file.
    if (mode === 'TRUNCATE') {
      this._closeReadTx();
      this.store.compact();
    }
    return { busy: 0, log: 0, checkpointed: 0 };
  }

  async checkpointPostgres(db, mode = 'TRUNCATE') {
    if (!['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'].includes(mode)) {
      throw new Error('Unsupported WAL checkpoint mode');
    }
    this.check();
    if (this.pg && this.pg !== db) {
      throw new Error('Checkpoint database must use this filesystem');
    }
    await db.exec('CHECKPOINT');
    return this.checkpointWal(mode);
  }

  /**
   * Compact unused pages in the single redb container file.
   */
  compact() {
    this.check();
    this.commitChanges();
    this._closeReadTx();
    return this.store.compact();
  }

  /**
   * Run redb's full B-tree and checksum integrity verification.
   */
  checkIntegrity() {
    this.check();
    this._closeReadTx();
    return this.store.checkIntegrity();
  }

  /**
   * Export the complete single-file image bytes when backed by MemoryBackend.
   */
  exportBytes() {
    if (typeof this.store?.backend?.toUint8Array !== 'function') {
      throw new Error('exportBytes() is only supported on memory-backed SingleFileFS instances');
    }
    if (!this.closed) this.commitChanges();
    return this.store.backend.toUint8Array();
  }

  async closeFs() {
    if (this.closed) return;
    if (this.closePromise) return this.closePromise;
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
      this._flushingClose = true;
      for (const n of this.inodes.values()) {
        if (n.mtime !== n.persistedMtime) this.dirtyNodes.add(n.ino);
      }
      await this.flush();
    } finally {
      this._flushingClose = false;
      this._closeReadTx();
      this.closed = true;
      this.store.close();
    }
    if (quitError) throw quitError;
  }

  stats(n) {
    return {
      dev: 0,
      ino: n.ino,
      mode: n.mode,
      nlink: n.path === null ? 0 : 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      size: n.size,
      blksize: this.pageSize,
      blocks: Math.ceil(n.size / 512),
      atime: n.mtime,
      mtime: n.mtime,
      ctime: n.mtime,
    };
  }

  lstat(p) {
    return this.stats(this.node(p));
  }

  fstat(fd) {
    return this.stats(this.fd(fd));
  }

  chmod(p, mode) {
    const n = this.node(p);
    n.mode = (n.mode & 0o170000) | (mode & 0o7777);
    this.dirtyNodes.add(n.ino);
  }

  utimes(p, atime, mtime) {
    const n = this.node(p);
    n.mtime = mtime;
    n.mtimeExplicit = true;
    this.dirtyNodes.add(n.ino);
  }

  create(p, mode) {
    this.check();
    const ino = this.nextIno++;
    this.metaDirty = true;
    const now = Date.now();
    const n = {
      ino,
      path: p,
      mode,
      size: 0,
      persistedSize: 0,
      persistedMtime: -1,
      persistedMode: -1,
      persistedPath: undefined,
      persisted: false,
      mtime: now,
    };
    this.nodes.set(p, n);
    this.inodes.set(ino, n);
    this.dirtyNodes.add(ino);
    return n;
  }

  mkdir(p, { recursive = false, mode = 0o700 } = {}) {
    p = this.norm(p);
    if (this.nodes.has(p)) {
      if (recursive) {
        if (!(this.node(p).mode & 0o40000)) fail('ENOTDIR', p);
        return;
      }
      fail('EEXIST', p);
    }
    const parent = posixDirname(p);
    if (recursive && !this.nodes.has(parent)) {
      this.mkdir(parent, { recursive, mode });
    }
    if (!(this.node(parent).mode & 0o40000)) fail('ENOTDIR', parent);
    this.create(p, 0o40000 | (mode & 0o7777));
  }

  readdir(p) {
    p = this.norm(p);
    if (!(this.node(p).mode & 0o40000)) fail('ENOTDIR', p);
    const prefix = p === '/' ? '/' : p + '/';
    return [
      '.',
      '..',
      ...[...this.nodes.keys()]
        .filter(s => s.startsWith(prefix))
        .map(s => s.slice(prefix.length))
        .filter(s => s && !s.includes('/')),
    ];
  }

  open(p, flags = 'r+', mode = 0o600) {
    this.check();
    if (typeof flags !== 'string' || !/^(r|r\+|rs|rs\+|w|wx|w\+|wx\+|a|ax|a\+|ax\+)$/.test(flags)) {
      fail('EINVAL', String(flags));
    }
    p = this.norm(p);
    let n = this.nodes.get(p);
    if (n && flags.includes('x')) fail('EEXIST', p);
    if (!n && /[wa]/.test(flags)) {
      if (!(this.node(posixDirname(p)).mode & 0o40000)) fail('ENOTDIR', p);
      n = this.create(p, 0o100000 | (mode & 0o7777));
    }
    if (!n) fail('ENOENT', p);
    if (n.mode & 0o40000) fail('EISDIR', p);
    if (flags.startsWith('w')) this.truncate(p, 0);
    const fd = this.nextFd++;
    this.fds.set(fd, n.ino);
    this.fdFlags.set(fd, flags);
    return fd;
  }

  close(fd) {
    const n = this.fd(fd);
    this.fds.delete(fd);
    this.fdFlags.delete(fd);
    if (n.path === null && !this._hasOpenFd(n.ino)) {
      this.remove(n);
    }
  }

  read(fd, buffer, offset, length, position) {
    const n = this.fd(fd);
    const target = bytes(buffer);
    const flags = this.fdFlags.get(fd);
    if (!flags.startsWith('r') && !flags.includes('+')) fail('EBADF', String(fd));
    validateIo(target, offset, length, position);
    length = Math.max(0, Math.min(length, n.size - position));
    if (!length) return 0;

    const PAGE = this.pageSize;
    const first = Math.floor(position / PAGE);
    const last = Math.floor((position + length - 1) / PAGE);

    if (last > first) {
      target.fill(0, offset, offset + length);
      // Multi-page read: one zero-copy redb range scan decoding into reusable _readPageBuf,
      // then overlay dirty pages.
      if (n.persisted && n.persistedSize > 0) {
        const truncLimit = this.truncates.get(n.ino);
        const maxDiskPage = Math.ceil(n.persistedSize / PAGE) - 1;
        let scanLast = Math.min(last, maxDiskPage);
        if (truncLimit !== undefined) scanLast = Math.min(scanLast, truncLimit - 1);
        if (scanLast >= first) {
          const rtx = this._getReadTx();
          const startKey = encodeChunkKey(n.ino, first, this._startKeyBuf);
          const endKey =
            scanLast === 0xffffffff
              ? encodeChunkKey(n.ino + 1, 0, this._endKeyBuf)
              : encodeChunkKey(n.ino, scanLast + 1, this._endKeyBuf);
          const pageBuf = this._readPageBuf;
          rtx.scanEach('chunks', { start: startKey, end: endKey }, (k, v) => {
            const pg = decodeChunkPage(k);
            const pageStart = pg * PAGE;
            const begin = Math.max(position, pageStart);
            const end = Math.min(position + length, pageStart + PAGE);
            if (end > begin) {
              decodeChunkInto(v, pageBuf, true);
              target.set(pageBuf.subarray(begin - pageStart, end - pageStart), offset + begin - position);
            }
          });
        }
      }
      if (this.dirty.size > 0) {
        if (last - first + 1 <= this.dirty.size) {
          for (let pg = first; pg <= last; pg++) {
            const d = this.dirty.get(this.key(n.ino, pg));
            if (!d) continue;
            const pageStart = pg * PAGE;
            const begin = Math.max(position, pageStart);
            const end = Math.min(position + length, pageStart + PAGE);
            target.set(d.data.subarray(begin - pageStart, end - pageStart), offset + begin - position);
          }
        } else {
          for (const { ino, page, data } of this.dirty.values()) {
            if (ino === n.ino && page >= first && page <= last) {
              const pageStart = page * PAGE;
              const begin = Math.max(position, pageStart);
              const end = Math.min(position + length, pageStart + PAGE);
              target.set(data.subarray(begin - pageStart, end - pageStart), offset + begin - position);
            }
          }
        }
      }
    } else {
      const pStart = position % PAGE;
      const key = this.key(n.ino, first);
      const dirty = this.dirty.get(key);
      if (dirty) {
        this.counters.cacheHits++;
        target.set(dirty.data.subarray(pStart, pStart + length), offset);
      } else if (this.cachePages === 0) {
        // Zero-allocation clean single-page read via reusable scratch page
        this.counters.cacheMisses++;
        const pageBuf = this._readPageBuf;
        this._loadCleanPageInto(n.ino, first, pageBuf, true);
        target.set(pageBuf.subarray(pStart, pStart + length), offset);
      } else {
        target.set(this.page(n.ino, first).subarray(pStart, pStart + length), offset);
      }
    }
    return length;
  }

  write(fd, buffer, offset, length, position) {
    const n = this.fd(fd);
    const source = bytes(buffer);
    const flags = this.fdFlags.get(fd);
    if (flags.startsWith('r') && !flags.includes('+')) fail('EBADF', String(fd));
    if (flags.startsWith('a')) position = n.size;
    validateIo(source, offset, length, position);
    if (!length) return 0;

    const PAGE = this.pageSize;
    for (let done = 0; done < length; ) {
      const at = position + done;
      const page = Math.floor(at / PAGE);
      const start = at % PAGE;
      const count = Math.min(PAGE - start, length - done);
      const key = this.key(n.ino, page);
      const existingDirty = this.dirty.get(key);

      if (existingDirty) {
        // Mutate already-dirty page in place (zero 8 KiB allocation/copy).
        existingDirty.data.set(source.subarray(offset + done, offset + done + count), start);
        this.counters.coalescedWrites++;
      } else {
        if (start === 0 && count === PAGE) {
          // Fast-path: PostgreSQL pre-zeroes 16 MiB WAL segments & relation extensions.
          // Skip allocating an 8 KiB zero buffer if the page has no persisted non-zero bytes.
          const truncLimit = this.truncates.get(n.ino);
          const existsOnDisk =
            n.persisted &&
            page * PAGE < n.persistedSize &&
            (truncLimit === undefined || page < truncLimit);
          if (!existsOnDisk && isAllZero(source, offset + done, PAGE)) {
            this.counters.zeroChunks++;
            this.counters.trimmedBytes += PAGE;
            done += count;
            continue;
          }
          const data = new Uint8Array(PAGE);
          data.set(source.subarray(offset + done, offset + done + PAGE), 0);
          this.dirty.set(key, { ino: n.ino, page, data });
          this.cachePage(key, data);
        } else {
          let data;
          if (this.cachePages === 0) {
            this.counters.cacheMisses++;
            data = new Uint8Array(PAGE);
            this._loadCleanPageInto(n.ino, page, data, false);
          } else {
            const cached = this.cache.get(key);
            if (cached) {
              this.counters.cacheHits++;
              data = cached.slice();
            } else {
              this.counters.cacheMisses++;
              data = new Uint8Array(PAGE);
              this._loadCleanPageInto(n.ino, page, data, false);
            }
          }
          data.set(source.subarray(offset + done, offset + done + count), start);
          this.dirty.set(key, { ino: n.ino, page, data });
          this.cachePage(key, data);
        }
      }
      done += count;
    }
    const nextSize = Math.max(n.size, position + length);
    if (nextSize !== n.size || !n.persisted) {
      n.size = nextSize;
      this.dirtyNodes.add(n.ino);
    }
    n.mtime = Date.now();
    return length;
  }

  discard(ino, first) {
    const minKey = ino * 0x100000000 + first;
    const maxKey = (ino + 1) * 0x100000000;
    for (const key of this.dirty.keys()) {
      if (key >= minKey && key < maxKey) this.dirty.delete(key);
    }
    if (this.cache.size > 0) {
      for (const key of this.cache.keys()) {
        if (key >= minKey && key < maxKey) this.cache.delete(key);
      }
    }
  }

  truncate(p, len = 0) {
    const n = this.node(p);
    if (!Number.isSafeInteger(len) || len < 0) {
      throw new RangeError('length must be a non-negative integer');
    }
    if (n.mode & 0o40000) fail('EISDIR', p);

    const PAGE = this.pageSize;
    const fromPage = Math.ceil(len / PAGE);
    if (n.persisted) {
      const prev = this.truncates.get(n.ino);
      if (prev === undefined || fromPage < prev) {
        this.truncates.set(n.ino, fromPage);
      }
    }
    this.discard(n.ino, fromPage);
    if (len < n.size && len % PAGE) {
      const page = Math.floor(len / PAGE);
      const key = this.key(n.ino, page);
      const existingDirty = this.dirty.get(key);
      if (existingDirty) {
        existingDirty.data.fill(0, len % PAGE);
      } else {
        const data = this.page(n.ino, page).slice();
        data.fill(0, len % PAGE);
        this.savePage(n, page, data);
      }
    }
    n.size = len;
    n.mtime = Date.now();
    this.dirtyNodes.add(n.ino);
  }

  writeFile(p, data, { mode = 0o600, encoding = 'utf8', flag = 'w' } = {}) {
    p = this.norm(p);
    const b = typeof data === 'string' ? encodeString(data, encoding) : bytes(data);
    if (!(b instanceof Uint8Array)) {
      throw new TypeError('data must be a string, Uint8Array or ArrayBuffer');
    }
    const fd = this.open(p, flag, mode);
    try {
      this.write(fd, b, 0, b.length, 0);
    } finally {
      this.close(fd);
    }
  }

  remove(n) {
    if (this._hasOpenFd(n.ino)) {
      this.nodes.delete(n.path);
      n.path = null;
      this.dirtyNodes.add(n.ino);
      return;
    }
    this.discard(n.ino, 0);
    this.dirtyNodes.delete(n.ino);
    this.truncates.delete(n.ino);
    if (n.persisted) {
      this.deletedNodes.set(n.ino, n.persistedSize);
    }
    if (n.path !== null) this.nodes.delete(n.path);
    this.inodes.delete(n.ino);
  }

  unlink(p) {
    const n = this.node(p);
    if (n.mode & 0o40000) fail('EISDIR', p);
    this.remove(n);
  }

  rmdir(p) {
    const n = this.node(p);
    if (n.path === '/') fail('EBUSY', p);
    if (!(n.mode & 0o40000)) fail('ENOTDIR', p);
    if (this.readdir(p).length > 2) fail('ENOTEMPTY', p);
    this.remove(n);
  }

  rename(from, to) {
    from = this.norm(from);
    to = this.norm(to);
    const n = this.node(from);
    if (from === to) return;
    if (from === '/' || to === '/') fail('EBUSY', from);
    if ((n.mode & 0o40000) && to.startsWith(from + '/')) fail('EINVAL', to);
    if (!(this.node(posixDirname(to)).mode & 0o40000)) fail('ENOTDIR', to);
    const old = this.nodes.get(to);
    if (old) {
      if ((n.mode & 0o40000) && !(old.mode & 0o40000)) fail('ENOTDIR', to);
      if (!(n.mode & 0o40000) && (old.mode & 0o40000)) fail('EISDIR', to);
    }
    if (old) {
      if (old.mode & 0o40000) this.rmdir(to);
      else this.unlink(to);
    }
    if (n.mode & 0o40000) {
      const prefix = from + '/';
      const moved = [n];
      for (const child of this.nodes.values()) {
        if (child.path.startsWith(prefix)) moved.push(child);
      }
      for (let i = 0; i < moved.length; i++) {
        const child = moved[i];
        const newPath = to + child.path.slice(from.length);
        this.nodes.delete(child.path);
        child.path = newPath;
        this.nodes.set(newPath, child);
        this.dirtyNodes.add(child.ino);
      }
    } else {
      this.nodes.delete(n.path);
      n.path = to;
      this.nodes.set(to, n);
      this.dirtyNodes.add(n.ino);
    }
  }
}
