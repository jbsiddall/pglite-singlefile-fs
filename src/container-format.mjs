import { decodeNodeBinary } from './chunk-codec.mjs';

export const REDB_MAGIC = new Uint8Array([0x72, 0x65, 0x64, 0x62, 0x1a, 0x0a, 0xa9, 0x0d, 0x0a]);
export const CONTAINER_MAGIC = 'PGSF';
export const FORMAT_VERSION = 3;

const ALLOWED_TABLES = new Set(['meta', 'nodes', 'chunks']);

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
    throw new Error('Not a pglite-singlefile-fs container');
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
