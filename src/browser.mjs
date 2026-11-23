import {
  Redb,
  createMemoryBackend,
  createOpfsBackend,
  createOpfsBackendFromHandle,
} from 'redb-js';
import {
  SingleFileFS,
  setPlatformAdapter,
  verifyBackendSync,
  verifyBackendAsync,
} from './single-file-fs.mjs';

function openBrowserSync(filename, norm) {
  if (norm.backend) {
    const format = verifyBackendSync(Redb, norm.backend, norm);
    const store = Redb.openSync(norm.backend, {
      cacheSize: norm.redbCacheBytes,
      wasm: norm.wasm,
    });
    return { store, format, filename };
  }
  if (filename === ':memory:') {
    const backend = createMemoryBackend(norm.initialBytes);
    const format = verifyBackendSync(Redb, backend, norm);
    const store = Redb.openSync(backend, {
      cacheSize: norm.redbCacheBytes,
      wasm: norm.wasm,
    });
    return { store, format, filename };
  }
  throw new Error(
    'In browsers, use await SingleFileFS.open(filename, options) for OPFS or pass { backend } / ":memory:"'
  );
}

async function openBrowserAsync(filename, norm) {
  if (norm.backend) {
    const format = await verifyBackendAsync(Redb, norm.backend, norm);
    const store = await Redb.open(norm.backend, {
      cacheSize: norm.redbCacheBytes,
      wasm: norm.wasm,
    });
    return { store, format, filename };
  }
  if (filename === ':memory:' || norm.storage === 'memory') {
    const backend = createMemoryBackend(norm.initialBytes);
    const format = await verifyBackendAsync(Redb, backend, norm);
    const store = await Redb.open(backend, {
      cacheSize: norm.redbCacheBytes,
      wasm: norm.wasm,
    });
    return { store, format, filename };
  }
  const backend = await createOpfsBackend(filename, { create: true, sync: norm.durable });
  try {
    const format = await verifyBackendAsync(Redb, backend, norm);
    const store = await Redb.open(backend, {
      cacheSize: norm.redbCacheBytes,
      wasm: norm.wasm,
    });
    return { store, format, filename };
  } catch (error) {
    try {
      backend.close();
    } catch {}
    throw error;
  }
}

setPlatformAdapter({
  openSync: openBrowserSync,
  openAsync: openBrowserAsync,
});

export { SingleFileFS, createOpfsBackend, createOpfsBackendFromHandle, createMemoryBackend };

/**
 * Coordinate an explicit PostgreSQL checkpoint with container maintenance.
 */
export async function checkpoint(db, filesystem, { mode = 'TRUNCATE' } = {}) {
  return filesystem.checkpointPostgres(db, mode);
}
