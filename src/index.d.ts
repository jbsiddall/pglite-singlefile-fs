import { BaseFilesystem, type FsStats } from '@electric-sql/pglite/basefs';
import type { StorageBackend, WasmSource } from 'redb-js';

export type ChunkCompression = 'sparse' | 'bitsparse32' | 'bitsparse16' | 'zerobytemask' | 'lz4' | 'none';
/** Byte offsets refer to the underlying bytes of the supplied view. */
export type ByteBuffer = ArrayBuffer | SharedArrayBuffer | ArrayBufferView;

export interface CheckpointOptions {
    /** Whether to compact free pages in the single redb container after PostgreSQL CHECKPOINT (default: true). */
    compact?: boolean;
}

export interface CheckpointResult {
    /** True if container compaction reclaimed free space. */
    compacted: boolean;
}

export interface SingleFileFSOptions {
    /** Default true. False uses redb Durability::None (not crash-safe). */
    durable?: boolean;
    /** Optional adapter clean chunk cache in bytes; disabled by default. Not a total memory cap. */
    cacheBytes?: number;
    /** In-memory redb page cache size in bytes; 8 MiB by default. */
    redbCacheBytes?: number;
    /** Creation setting; an existing image retains its page size (default 8192). */
    pageSize?: 4096 | 8192 | 16384 | 32768 | 65536;
    /**
     * Chunk encoding mode:
     * - 'sparse' / 'zerobytemask' (default, aliases): hybrid PG-hole + 2-level zero-byte bitmask
     * - 'bitsparse32': 32-bit word bitmap
     * - 'bitsparse16': 16-bit word bitmap
     * - 'lz4': pure-JS LZ4 block compression
     * - 'none': raw bytes with trailing zeros trimmed
     */
    compression?: ChunkCompression;
    /** Target storage backend: 'auto' (default), 'node', 'opfs', or 'memory'. */
    storage?: 'auto' | 'node' | 'opfs' | 'memory';
    /** Optional custom redb StorageBackend (e.g. from createOpfsBackendFromHandle). */
    backend?: StorageBackend;
    /**
     * Optional explicit redb WASM source.
     * `URL | string` is supported by `SingleFileFS.open()`; synchronous `new SingleFileFS()`
     * requires a `WebAssembly.Module`, `Uint8Array`, or `ArrayBuffer`.
     */
    wasm?: WasmSource;
    /** Initial image bytes when opening in `':memory:'` or `{ storage: 'memory' }` mode. */
    initialBytes?: Uint8Array;
}

export interface FilesystemCounters {
    cacheHits: number;
    cacheMisses: number;
    coalescedWrites: number;
    blobPuts: number;
    zeroChunks: number;
    trimmedBytes: number;
    storedBytes: number;
    metadataUpdates: number;
    commits: number;
    relaxedSyncs: number;
    strictSyncs: number;
}

export interface CheckpointDatabase {
    exec(query: string): Promise<unknown>;
}

export class SingleFileFS extends BaseFilesystem {
    /**
     * Recommended PostgreSQL start parameters for CoW SingleFileFS (`['-c', 'full_page_writes=off']`).
     */
    static readonly recommendedStartParams: string[];
    constructor(filename: string, options?: SingleFileFSOptions);
    static open(filename: string, options?: SingleFileFSOptions): Promise<SingleFileFS>;
    readonly filename: string;
    readonly durable: boolean;
    readonly pageSize: number;
    readonly redbCacheBytes: number;
    readonly compression: ChunkCompression;
    counters: FilesystemCounters;
    resetCounters(): void;
    syncToFs(relaxedDurability?: boolean): Promise<void>;
    /** Wait for any relaxed flush and durably persist pending filesystem changes. */
    flush(): Promise<void>;
    /** Run PostgreSQL CHECKPOINT, flush durably, and optionally compact container storage. */
    checkpointPostgres(db: CheckpointDatabase, options?: CheckpointOptions): Promise<CheckpointResult>;
    /** Compact free pages in the single redb container file. */
    compact(): boolean;
    /** Verify full redb B-tree and checksum integrity. */
    checkIntegrity(): boolean;
    /** Export the single-file image bytes when backed by MemoryBackend (`':memory:'` or `{ storage: 'memory' }`). */
    exportBytes(): Uint8Array;
    closeFs(options?: { compact?: boolean }): Promise<void>;
    chmod(path: string, mode: number): void;
    close(fd: number): void;
    fstat(fd: number): FsStats;
    lstat(path: string): FsStats;
    mkdir(path: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): void;
    open(path: string, flags?: string, mode?: number): number;
    readdir(path: string): string[];
    read(fd: number, buffer: ByteBuffer, offset: number, length: number, position: number): number;
    write(fd: number, buffer: ByteBuffer, offset: number, length: number, position: number): number;
    rename(oldPath: string, newPath: string): void;
    rmdir(path: string): void;
    truncate(path: string, length?: number): void;
    unlink(path: string): void;
    utimes(path: string, atime: number, mtime: number): void;
    writeFile(path: string, data: string | ByteBuffer, options?: {
        encoding?: string;
        mode?: number;
        flag?: string;
    }): void;
}

export function checkpoint(
    db: CheckpointDatabase,
    filesystem: SingleFileFS,
    options?: CheckpointOptions
): Promise<CheckpointResult>;

export {
    createOpfsBackend,
    createOpfsBackendFromHandle,
    createMemoryBackend,
} from 'redb-js';
