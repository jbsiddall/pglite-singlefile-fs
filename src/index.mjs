import fs from 'node:fs';
import path from 'node:path';
import {
  Redb,
  createMemoryBackend,
  createOpfsBackend,
  createOpfsBackendFromHandle,
} from 'redb-js';
import {
  createNodeFileBackend,
  ensureNodeWasmLoadedSync,
} from 'redb-js/node';
import {
  SingleFileFS,
  checkpoint,
  setPlatformAdapter,
  verifyBackendSync,
  verifyBackendAsync,
} from './single-file-fs.mjs';
import { REDB_MAGIC, hasRedbMagic } from './container-format.mjs';
import { DurableObjectStore } from './durable-object-store.mjs';

function assertExistingNodeFileSync(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  if (stat.size === 0) return false;
  if (stat.size < REDB_MAGIC.length) {
    throw new Error('Not a pglite-singlefile-fs container: unrecognized file header');
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY);
  try {
    const header = new Uint8Array(REDB_MAGIC.length);
    const n = fs.readSync(fd, header, 0, REDB_MAGIC.length, 0);
    if (n < REDB_MAGIC.length || !hasRedbMagic(header)) {
      throw new Error('Not a pglite-singlefile-fs container: unrecognized file format');
    }
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function openServerSync(filename, norm) {
  if (!norm.wasm) {
    ensureNodeWasmLoadedSync();
  }
  if (norm.backend) {
    const format = verifyBackendSync(Redb, norm.backend, norm);
    const store = Redb.openSync(norm.backend, {
      cacheSize: norm.redbCacheBytes,
      wasm: norm.wasm,
    });
    return { store, format, filename };
  }
  if (filename === ':memory:' || norm.storage === 'memory') {
    const backend = createMemoryBackend(norm.initialBytes);
    const format = verifyBackendSync(Redb, backend, norm);
    const store = Redb.openSync(backend, {
      cacheSize: norm.redbCacheBytes,
      wasm: norm.wasm,
    });
    return { store, format, filename };
  }
  if (norm.storage === 'opfs') {
    throw new Error(
      'OPFS storage requires asynchronous opening: use await SingleFileFS.open(filename, { storage: "opfs", ... }) inside a Dedicated Web Worker'
    );
  }
  const resolved = path.resolve(filename);
  const existsNonEmpty = assertExistingNodeFileSync(resolved);
  let format = null;
  if (existsNonEmpty) {
    const roBackend = createNodeFileBackend(resolved, { readOnly: true });
    try {
      format = verifyBackendSync(Redb, roBackend, norm);
    } finally {
      roBackend.close();
    }
  }
  const backend = createNodeFileBackend(resolved, { sync: norm.durable });
  try {
    const store = Redb.openSync(backend, {
      cacheSize: norm.redbCacheBytes,
      wasm: norm.wasm,
    });
    return { store, format, filename: resolved };
  } catch (error) {
    try {
      backend.close();
    } catch {}
    throw error;
  }
}

async function openServerAsync(filename, norm) {
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
  if (norm.storage === 'opfs') {
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
  const resolved = path.resolve(filename);
  const existsNonEmpty = assertExistingNodeFileSync(resolved);
  let format = null;
  if (existsNonEmpty) {
    const roBackend = createNodeFileBackend(resolved, { readOnly: true });
    try {
      format = await verifyBackendAsync(Redb, roBackend, norm);
    } finally {
      roBackend.close();
    }
  }
  const backend = createNodeFileBackend(resolved, { sync: norm.durable });
  try {
    const store = await Redb.open(backend, {
      cacheSize: norm.redbCacheBytes,
      wasm: norm.wasm,
    });
    return { store, format, filename: resolved };
  } catch (error) {
    try {
      backend.close();
    } catch {}
    throw error;
  }
}

setPlatformAdapter({
  openSync: openServerSync,
  openAsync: openServerAsync,
});

export {
  SingleFileFS,
  DurableObjectStore,
  checkpoint,
  createOpfsBackend,
  createOpfsBackendFromHandle,
  createMemoryBackend,
};
