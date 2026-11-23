import { decodeNodeBinary } from './chunk-codec.mjs';

export const REDB_MAGIC = new Uint8Array([0x72, 0x65, 0x64, 0x62, 0x1a, 0x0a, 0xa9, 0x0d, 0x0a]);
export const CONTAINER_MAGIC = 'PGSF';
export const FORMAT_VERSION = 3;

const ALLOWED_TABLES = new Set(['meta', 'nodes', 'chunks']);
const OVERLAY_PAGE_SIZE = 4096;

export function hasRedbMagic(bytes) {
  if (!bytes || bytes.byteLength < REDB_MAGIC.length) return false;
  for (let i = 0; i < REDB_MAGIC.length; i++) {
    if (bytes[i] !== REDB_MAGIC[i]) return false;
  }
  return true;
}

/**
 * Create a read-only, non-closing wrapper around a StorageBackend so we can
 * inspect an existing non-empty container before opening it read-write without
 * releasing an exclusive handle (e.g., OPFS FileSystemSyncAccessHandle).
 */
export function wrapReadOnlyNonClosing(backend) {
  return {
    read(offset, dst) {
      return backend.read(offset, dst);
    },
    len() {
      return backend.len();
    },
    write() {
      throw new Error('Write attempted during read-only container inspection');
    },
    setLen() {
      throw new Error('Resize attempted during read-only container inspection');
    },
    sync() {},
    close() {},
  };
}

/**
 * Create a non-closing, in-memory Copy-on-Write overlay over a StorageBackend.
 * Used when an existing redb image requires crash repair before inspection so
 * foreign redb files are validated purely in RAM and NEVER mutated on disk/OPFS.
 */
export function wrapInMemoryRepairOverlay(backend) {
  const pages = new Map();
  let virtualLen = backend.len();
  const baseLen = virtualLen;

  const getOrLoadPage = pageIdx => {
    let page = pages.get(pageIdx);
    if (page) return page;
    page = new Uint8Array(OVERLAY_PAGE_SIZE);
    const pageStart = pageIdx * OVERLAY_PAGE_SIZE;
    if (pageStart < baseLen) {
      const want = Math.min(OVERLAY_PAGE_SIZE, baseLen - pageStart);
      backend.read(pageStart, page.subarray(0, want));
    }
    pages.set(pageIdx, page);
    return page;
  };

  return {
    read(offset, dst) {
      const avail = Math.max(0, virtualLen - offset);
      const total = Math.min(dst.byteLength, avail);
      if (total <= 0) return 0;

      let done = 0;
      while (done < total) {
        const pos = offset + done;
        const pageIdx = Math.floor(pos / OVERLAY_PAGE_SIZE);
        const rel = pos - pageIdx * OVERLAY_PAGE_SIZE;
        const chunk = Math.min(OVERLAY_PAGE_SIZE - rel, total - done);
        const overlay = pages.get(pageIdx);
        if (overlay) {
          dst.set(overlay.subarray(rel, rel + chunk), done);
        } else if (pos < baseLen) {
          const fromBase = Math.min(chunk, baseLen - pos);
          const got = backend.read(pos, dst.subarray(done, done + fromBase));
          if (got < chunk) dst.fill(0, done + got, done + chunk);
        } else {
          dst.fill(0, done, done + chunk);
        }
        done += chunk;
      }
      return total;
    },
    write(offset, src) {
      const len = src.byteLength;
      if (len === 0) return;
      let done = 0;
      while (done < len) {
        const pos = offset + done;
        const pageIdx = Math.floor(pos / OVERLAY_PAGE_SIZE);
        const rel = pos - pageIdx * OVERLAY_PAGE_SIZE;
        const chunk = Math.min(OVERLAY_PAGE_SIZE - rel, len - done);
        const page = getOrLoadPage(pageIdx);
        page.set(src.subarray(done, done + chunk), rel);
        done += chunk;
      }
      const end = offset + len;
      if (end > virtualLen) virtualLen = end;
    },
    len() {
      return virtualLen;
    },
    setLen(newLen) {
      if (newLen < virtualLen) {
        const fromPage = Math.ceil(newLen / OVERLAY_PAGE_SIZE);
        for (const p of pages.keys()) {
          if (p >= fromPage) pages.delete(p);
        }
        const rem = newLen % OVERLAY_PAGE_SIZE;
        if (rem !== 0) {
          const tailIdx = Math.floor(newLen / OVERLAY_PAGE_SIZE);
          const page = getOrLoadPage(tailIdx);
          page.fill(0, rem);
        }
      }
      virtualLen = newLen;
    },
    sync() {},
    close() {},
  };
}

/**
 * Verify that an existing non-empty backend begins with the redb file magic
 * before redb ever attempts to open or touch it.
 */
export function assertBackendIsRedbOrEmpty(backend) {
  const size = backend.len();
  if (size === 0) return false;
  if (size < REDB_MAGIC.length) {
    throw new Error('Not a pglite-singlefile-fs container: unrecognized file header');
  }
  const header = new Uint8Array(REDB_MAGIC.length);
  const read = backend.read(0, header);
  if (read < REDB_MAGIC.length || !hasRedbMagic(header)) {
    throw new Error('Not a pglite-singlefile-fs container: unrecognized file format');
  }
  return true;
}

/**
 * Verify that an existing redb database opened read-only is either empty
 * (0 tables) or a recognized PGlite SingleFileFS container.
 * Returns the parsed format metadata object if initialized, or null if empty.
 */
export function assertContainerFormat(roDb) {
  const tables = roDb.listTables();
  if (tables.length === 0) return null;

  for (const name of tables) {
    if (!ALLOWED_TABLES.has(name)) {
      throw new Error(`Not a recognized pglite-singlefile-fs container schema (unexpected table: ${name})`);
    }
  }
  if (!tables.includes('meta') || !tables.includes('nodes')) {
    throw new Error('Not a recognized pglite-singlefile-fs container schema');
  }

  const formatRaw = roDb.getText('meta', 'format');
  if (!formatRaw) {
    throw new Error('Not a recognized pglite-singlefile-fs container: missing format metadata');
  }
  let format;
  try {
    format = JSON.parse(formatRaw);
  } catch {
    throw new Error('Not a recognized pglite-singlefile-fs container: corrupt format metadata');
  }
  if (format?.magic !== CONTAINER_MAGIC) {
    throw new Error('Not a recognized pglite-singlefile-fs container');
  }
  if (format?.version !== FORMAT_VERSION) {
    throw new Error(`Unsupported pglite-singlefile-fs container format version: ${format?.version}`);
  }
  if (![4096, 8192, 16384, 32768, 65536].includes(format?.pageSize)) {
    throw new Error(`Invalid pglite-singlefile-fs container pageSize: ${format?.pageSize}`);
  }

  const rootKey = new Uint8Array([0, 0, 0, 1]);
  const rootBytes = roDb.get('nodes', rootKey);
  if (!rootBytes) {
    throw new Error('Not a recognized pglite-singlefile-fs container root');
  }
  let root;
  try {
    root = decodeNodeBinary(rootBytes);
  } catch {
    throw new Error('Corrupt pglite-singlefile-fs container root');
  }
  if (root?.ino !== 1 || root?.path !== '/' || !(root?.mode & 0o40000)) {
    throw new Error('Not a recognized pglite-singlefile-fs container root');
  }
  return format;
}
