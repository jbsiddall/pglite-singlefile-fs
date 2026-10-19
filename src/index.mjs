export { SingleFileFS } from './single-file-fs.mjs';
export { DurableObjectStore } from './durable-object-store.mjs';
/**
 * Coordinate an explicit PostgreSQL checkpoint with the container checkpoint.
 * Automatic PostgreSQL checkpoints are independent: WAL unlink/truncate is
 * not a reliable signal, because PostgreSQL can recycle its WAL segments.
 */
export async function checkpoint(db, filesystem, { mode = 'TRUNCATE' } = {}) {
    return filesystem.checkpointPostgres(db, mode);
}
