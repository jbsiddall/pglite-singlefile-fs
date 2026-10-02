import { BaseFilesystem, type FsStats } from '@electric-sql/pglite/basefs';
export type WalCheckpointMode = 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE';
/** Byte offsets refer to the underlying bytes of the supplied view. */
export type ByteBuffer = ArrayBuffer | SharedArrayBuffer | ArrayBufferView;
export interface WalCheckpointResult {
    busy: number;
    log: number;
    checkpointed: number;
}
export interface SingleFileFSOptions {
    /** Default true. False disables crash durability and uses MEMORY journaling by default. */
    durable?: boolean;
    /** Optional clean chunk cache in bytes; disabled by default. Not a total memory cap. */
    cacheBytes?: number;
    journalMode?: 'WAL' | 'DELETE' | 'MEMORY';
    /** Creation setting; an existing image retains its page size. */
    pageSize?: 4096 | 8192 | 16384 | 32768 | 65536;
    /** Creation setting; defaults to rowid for new images. */
    chunkTable?: 'rowid' | 'without-rowid';
    lockingMode?: 'NORMAL' | 'EXCLUSIVE';
    /** SQLite pager budget in KiB; approximately 2 MiB by default. */
    sqliteCacheKiB?: number;
    /** Soft automatic SQLite WAL checkpoint threshold in bytes; default 32 MiB. */
    walAutoCheckpointBytes?: number;
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
    constructor(filename: string, options?: SingleFileFSOptions);
    readonly filename: string;
    readonly durable: boolean;
    readonly pageSize: number;
    readonly chunkTable: 'rowid' | 'without-rowid';
    readonly journalMode: string;
    counters: FilesystemCounters;
    resetCounters(): void;
    syncToFs(relaxedDurability?: boolean): Promise<void>;
    /** Wait for any relaxed flush and persist pending filesystem changes. */
    flush(): Promise<void>;
    checkpointWal(mode?: WalCheckpointMode): Promise<WalCheckpointResult>;
    /** Run PostgreSQL CHECKPOINT, then checkpoint the container WAL. */
    checkpointPostgres(db: CheckpointDatabase, mode?: WalCheckpointMode): Promise<WalCheckpointResult>;
    closeFs(): Promise<void>;
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
export function checkpoint(db: CheckpointDatabase, filesystem: SingleFileFS, options?: {
    mode?: WalCheckpointMode;
}): Promise<WalCheckpointResult>;
