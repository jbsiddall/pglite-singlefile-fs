import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite';
import { SingleFileFS } from '../src/index.mjs';

export const workloads = ['batchRead', 'batchInsert', 'batchUpdate', 'frequentRead', 'frequentInsert', 'frequentUpdate'];
const runtime = globalThis.Bun ? { name: 'bun', version: Bun.version } : globalThis.Deno ? { name: 'deno', version: Deno.version.deno } : { name: 'node', version: process.version };
const root = mkdtempSync(join(tmpdir(), 'pglite-benchmark-'));
let db, fs, config, readCalls = 0, initialRows, insertedRows = 0, sum = 0;
const settle = async () => { if (fs) await fs.flush(); };
export async function initialize(options = {}) {
  config = { backend: 'nodefs', rows: 10000, frequent: 500, batch: 10000, ...options };
  initialRows = config.rows;
  if (!Number.isSafeInteger(initialRows) || initialRows < config.frequent) throw new Error('rows must cover frequent operations');
  fs = config.backend === 'singlefile' ? new SingleFileFS(join(root, 'database.pglite'), { durable: true, cacheBytes: 0, sqliteCacheKiB: 2048, journalMode: 'WAL', pageSize: 8192, chunkTable: 'rowid' }) : null;
  const startParams = [...PGlite.defaultStartParams, '-c', `shared_buffers=${fs ? 98 : 100}MB`];
  db = fs ? await PGlite.create({ fs, startParams }) : await PGlite.create(join(root, 'pgdata'), { startParams });
  const backendFs = db.fs;
  if(typeof backendFs.read==='function'){
    const originalRead=backendFs.read.bind(backendFs);
    backendFs.read=(...args)=>{readCalls++;return originalRead(...args);};
  }
  await db.exec('CREATE TABLE orders(id BIGSERIAL PRIMARY KEY, product TEXT NOT NULL, amount INTEGER NOT NULL)');
  await db.query("INSERT INTO orders(product,amount) SELECT 'product-'||(g%100),g%1000 FROM generate_series(1,$1::int)g", [initialRows]);
  sum = Number((await db.query('SELECT sum(amount)::text AS total FROM orders')).rows[0].total);
  await db.exec('CHECKPOINT'); await settle();
  // Warm SQL and PostgreSQL buffers explicitly; warm results are never presented as cold I/O.
  await db.query('SELECT count(*)::int AS n,sum(amount)::text AS total FROM orders');
  await db.query('SELECT amount FROM orders WHERE id=$1', [1]);
  await settle();
  return { runtime, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, config, pageCacheMiB: { postgres: fs ? 98 : 100, sqlite: fs ? 2 : 0, adapterClean: 0 }, settings: (await db.query("SELECT name,setting FROM pg_settings WHERE name IN ('fsync','shared_buffers','synchronous_commit','full_page_writes') ORDER BY name")).rows };
}
export async function runWorkload(name) {
  if (!workloads.includes(name)) throw new Error('Unknown workload: '+name);
  let result;
  readCalls = 0;
  const start = performance.now();
  if (name === 'batchRead') result = (await db.query('SELECT id,product,amount FROM orders ORDER BY id')).rows;
  if (name === 'batchInsert') await db.query("INSERT INTO orders(product,amount) SELECT 'batch',g%1000 FROM generate_series(1,$1::int)g", [config.batch]);
  if (name === 'batchUpdate') await db.query('UPDATE orders SET amount=amount+1 WHERE id<=$1', [initialRows]);
  if (name === 'frequentRead') { result=[]; for(let i=1;i<=config.frequent;i++) result.push((await db.query('SELECT amount FROM orders WHERE id=$1',[i])).rows[0]); }
  if (name === 'frequentInsert') { for(let i=0;i<config.frequent;i++) await db.query("INSERT INTO orders(product,amount) VALUES('single',$1)",[i]); }
  if (name === 'frequentUpdate') { for(let i=1;i<=config.frequent;i++) await db.query('UPDATE orders SET amount=amount+1 WHERE id=$1',[i]); }
  const acknowledgedMs = performance.now()-start;
  await settle();
  const settledMs = performance.now()-start, reads=fs?readCalls:null;
  if(name==='batchInsert') { insertedRows+=config.batch; for(let g=1;g<=config.batch;g++)sum+=g%1000; }
  if(name==='frequentInsert') { insertedRows+=config.frequent; sum+=config.frequent*(config.frequent-1)/2; }
  if(name==='batchUpdate')sum+=initialRows;
  if(name==='frequentUpdate')sum+=config.frequent;
  if(name==='batchRead') { assert.equal(result.length,initialRows+insertedRows); assert.equal(result.reduce((n,row)=>n+row.amount,0),sum); }
  if(name==='frequentRead')assert.equal(result.length,config.frequent);
  const state=(await db.query('SELECT count(*)::int AS n,sum(amount)::text AS total FROM orders')).rows[0];
  assert.equal(state.n,initialRows+insertedRows);assert.equal(Number(state.total),sum);
  return { workload:name, acknowledgedMs, settledMs, filesystemReads:reads, rows:state.n, checksum:state.total };
}
export async function shutdown() {
  if(db) await db.close();
  const size = (dir) => readdirSync(dir,{withFileTypes:true}).reduce((n,e)=>n+(e.isDirectory()?size(join(dir,e.name)):statSync(join(dir,e.name)).size),0);
  const bytes=size(root);
  rmSync(root,{recursive:true,force:true});
  return { bytes };
}
if (process.argv[1]?.endsWith('benchmark-worker.mjs')) {
  const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
  for await(const line of lines) {
    let request;
    try {
      request=JSON.parse(line);
      const value=request.command==='initialize'?await initialize(request.options):request.command==='shutdown'?await shutdown():await runWorkload(request.workload);
      process.stdout.write(JSON.stringify({id:request.id,value})+'\n');
      if(request.command==='shutdown')break;
    }catch(error){process.stdout.write(JSON.stringify({id:request?.id,error:{message:error.message,stack:error.stack}})+'\n');process.exitCode=1;break;}
  }
}
