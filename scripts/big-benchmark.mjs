// Opt-in large storage benchmark. Run sequential backends; needs ~12 GiB free disk.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomBytes, createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { SingleFileFS } from '../src/index.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { runtimeCommand } from './benchmark-client.mjs';

const targetGiB=Number(process.env.BIG_BENCH_SIZE_GIB??5);
if(!(targetGiB>0&&targetGiB<=20))throw new Error('BIG_BENCH_SIZE_GIB must be in (0,20]');
const repetitions=Number(process.env.BIG_BENCH_REPEATS??3);
const targetBytes=targetGiB*1024**3,batch=Number(process.env.BIG_BENCH_BATCH_ROWS??10000),payloadBytes=4096;
const runtime=globalThis.Bun?{name:'bun',version:Bun.version}:globalThis.Deno?{name:'deno',version:Deno.version.deno}:{name:'node',version:process.version};
const directorySize=dir=>readdirSync(dir,{withFileTypes:true}).reduce((n,e)=>n+(e.isDirectory()?directorySize(join(dir,e.name)):statSync(join(dir,e.name)).size),0);
const median=values=>{const a=[...values].sort((a,b)=>a-b);return a[Math.floor(a.length/2)];};
const records=[],environments={};
// One incompressible 4096-character value. PostgreSQL does not deduplicate TOAST
// between rows; reuse avoids making cryptographic hashing the loading bottleneck.
const payload=process.env.BIG_BENCH_PAYLOAD??randomBytes(3072).toString('base64');
const payloadHash=createHash('sha256').update(payload).digest('hex');
for(const backend of (process.env.BIG_BENCH_CHILD?[process.env.BIG_BENCH_CHILD]:['nodefs','singlefile'])) {
  if(!process.env.BIG_BENCH_CHILD) {
    const {executable,args}=runtimeCommand(fileURLToPath(import.meta.url));
    const child=spawn(executable,args,{env:{...process.env,BIG_BENCH_CHILD:backend,BIG_BENCH_PAYLOAD:payload},stdio:['ignore','pipe','inherit']});
    let final;
    createInterface({input:child.stdout}).on('line',line=>{
      console.log(line);
      try{const parsed=JSON.parse(line);if(parsed.record)final=parsed;}catch{}
    });
    await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`Large benchmark ${backend} exited ${code}`)));});
    if(!final)throw new Error('Missing large worker result');
    records.push(final.record);environments[backend]=final.environment;continue;
  }
  const root=mkdtempSync(join(process.env.BIG_BENCH_TMPDIR??tmpdir(),'pglite-large-'));
  let db,fs;
  try {
    fs=backend==='singlefile'?new SingleFileFS(join(root,'database.pglite'),{durable:true,journalMode:'WAL',sqliteCacheKiB:2048,cacheBytes:0,pageSize:8192,chunkTable:'rowid'}):null;
    const startParams=[...PGlite.defaultStartParams,'-c',`shared_buffers=${fs?98:100}MB`,'-c','work_mem=32MB'];
    db=fs?await PGlite.create({fs,startParams}):await PGlite.create(join(root,'pgdata'),{startParams});
    environments[backend]={runtime,platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model,settings:(await db.query("SELECT name,setting FROM pg_settings WHERE name IN ('fsync','shared_buffers','work_mem') ORDER BY name")).rows};
    // Exactly two application tables. Random payload resists PostgreSQL TOAST compression.
    await db.exec('CREATE TABLE customers(id bigint PRIMARY KEY, label text NOT NULL); CREATE TABLE events(id bigint NOT NULL, customer_id bigint NOT NULL, amount integer NOT NULL, payload text NOT NULL)');
    await db.query("INSERT INTO customers SELECT g,'customer-'||g FROM generate_series(1,10000)g");
    let rows=0,relationBytes=0,peakObservedStorageBytes=directorySize(root),peakObservedSqliteWalBytes=0;
    const loadStart=performance.now();
    while(relationBytes<targetBytes) {
      await db.query(`INSERT INTO events SELECT g,1+(g%10000),g%1000,$3::text FROM generate_series($1::bigint,$2::bigint)g`,[rows+1,rows+batch,payload]);
      rows+=batch;
      peakObservedStorageBytes=Math.max(peakObservedStorageBytes,directorySize(root));
      if(fs){try{peakObservedSqliteWalBytes=Math.max(peakObservedSqliteWalBytes,statSync(join(root,'database.pglite-wal')).size);}catch(error){if(error.code!=='ENOENT')throw error;}}
      relationBytes=Number((await db.query("SELECT (pg_total_relation_size('events')+pg_total_relation_size('customers'))::text AS bytes")).rows[0].bytes);
      if(rows%(batch*10)===0)console.log(JSON.stringify({backend,progressRows:rows,relationBytes,targetBytes}));
    }
    await db.exec('CHECKPOINT');if(fs)await fs.flush();
    const loadMs=performance.now()-loadStart;
    await db.exec('ANALYZE events; ANALYZE customers');if(fs)await fs.flush();
    const bytesBeforeIndex=directorySize(root),imageBeforeIndex=fs?statSync(join(root,'database.pglite')).size:null;
    const samples=[];
    const expectedCount=Math.floor(rows/10000); // customer 42 is always amount 41.
    async function measure(phase,query,parameters=[],exclude=false) {
      const start=performance.now();const result=(await db.query(query,parameters)).rows[0];if(fs)await fs.flush();const elapsedMs=performance.now()-start;
      assert.equal(Number(result.n),expectedCount+(rows%10000>=41?1:0));assert.equal(Number(result.total),Number(result.n)*41);
      return {phase,elapsedMs,result,excludedWarmup:exclude};
    }
    const query='SELECT count(*)::text AS n,coalesce(sum(e.amount),0)::text AS total FROM events e JOIN customers c ON c.id=e.customer_id WHERE c.id=$1';
    const planWithout=(await db.query('EXPLAIN (FORMAT JSON) '+query,[42])).rows;
    samples.push(await measure('joinWithoutIndex',query,[42],true));
    for(let i=0;i<repetitions;i++)samples.push(await measure('joinWithoutIndex',query,[42]));
    const indexStart=performance.now();await db.exec('CREATE INDEX events_customer_id_idx ON events(customer_id)');await db.exec('ANALYZE events; ANALYZE customers; CHECKPOINT');if(fs)await fs.flush();const indexMs=performance.now()-indexStart;
    const planWith=(await db.query('EXPLAIN (FORMAT JSON) '+query,[42])).rows;
    samples.push(await measure('joinWithIndex',query,[42],true));
    for(let i=0;i<repetitions;i++)samples.push(await measure('joinWithIndex',query,[42]));
    // Check payload survives as well, not merely the keys/aggregate.
    const persistedPayload=(await db.query('SELECT payload FROM events WHERE id=1')).rows[0].payload;
    assert.equal(persistedPayload.length,payloadBytes);assert.equal(persistedPayload,payload);
    await db.close();db=null;
    records.push({backend,payloadHash,peakObservedStorageBytes,peakObservedSqliteWalBytes,targetBytes,rows,relationBytes,loadMs,indexMs,bytesBeforeIndex,imageBeforeIndex,closedBytes:directorySize(root),samples,planWithout,planWith});
    console.log(JSON.stringify(records.at(-1)));
  }finally{if(db)await db.close();rmSync(root,{recursive:true,force:true});}
}
if(process.env.BIG_BENCH_CHILD){console.log(JSON.stringify({record:records[0],environment:environments[process.env.BIG_BENCH_CHILD]}));process.exit(0);}
const summary=['joinWithoutIndex','joinWithIndex'].map(phase=>{
  const duration=backend=>median(records.find(r=>r.backend===backend).samples.filter(s=>s.phase===phase&&!s.excludedWarmup).map(s=>s.elapsedMs));
  return {phase,nodefsMs:duration('nodefs'),singlefileMs:duration('singlefile'),ratio:duration('singlefile')/duration('nodefs')};
});
const report={timestamp:new Date().toISOString(),repeats:repetitions,environments,summary,records,notes:[
  `Two application tables. PostgreSQL total relation sizes (including TOAST) reach at least ${targetGiB} GiB before index creation. Physical backend sizes separately measured; adapter file need not equal logical PostgreSQL size. Peak storage/WAL sizes are observed at batch boundaries and may miss intra-batch peaks.`,
  'No event join-key index in first phase; indexed customers and indexed events in second. Explicit plans saved. Same selective customer join avoids a pathological Cartesian join.',
  'One excluded warm-up per join phase. OS cache not cleared. Backends run sequentially once, so environmental/order effects remain; not a cross-machine performance guarantee.',
  'Payload is one cryptographically random base64 value reused across rows, resisting per-value PostgreSQL compression; storage layers do not deduplicate it. Joins read keys/amounts, not the complete payload: this checks large database operation, not a full 5 GiB payload scan.',
  '100 MiB configured page-cache budget, not a total RAM cap. NodeFS fsync=off versus SQLite synchronous=FULL; hardware durability differs.'
]};
mkdirSync('reports',{recursive:true});writeFileSync('reports/benchmark-large-results.json',JSON.stringify(report,null,2));console.table(summary);
