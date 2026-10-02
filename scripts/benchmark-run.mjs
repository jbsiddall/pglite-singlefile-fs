import { mkdirSync, writeFileSync } from 'node:fs';
import { startWorker } from './benchmark-client.mjs';
const workloads=['batchRead','batchInsert','batchUpdate','frequentRead','frequentInsert','frequentUpdate'];
const repeats=Number(process.env.BENCH_REPEATS??5);
if(!Number.isSafeInteger(repeats)||repeats<1)throw new Error('BENCH_REPEATS must be a positive integer');
const records=[],warmups=[],environments={};
for(let iteration=-1;iteration<repeats;iteration++) {
  const order=iteration%2===0?['nodefs','singlefile']:['singlefile','nodefs'];
  for(const backend of order) {
    const worker=startWorker({backend});
    try {
      environments[backend]=await worker.initialized;
      const samples=[];for(const workload of workloads)samples.push(await worker.run(workload));
      const storage=await worker.close();
      const record={backend,iteration,samples,storage};
      (iteration<0?warmups:records).push(record);
      console.log(JSON.stringify(record));
    }catch(error){worker.kill();throw error;}
  }
}
const median=values=>{const a=[...values].sort((a,b)=>a-b),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;};
const summary=workloads.map(workload=>{
  const nodefs=median(records.filter(r=>r.backend==='nodefs').map(r=>r.samples.find(s=>s.workload===workload).settledMs));
  const singlefile=median(records.filter(r=>r.backend==='singlefile').map(r=>r.samples.find(s=>s.workload===workload).settledMs));
  return {workload,nodefsMs:nodefs,singlefileMs:singlefile,ratio:singlefile/nodefs};
});
const report={timestamp:new Date().toISOString(),repeats,environments,summary,records,warmups,notes:[
  'One complete excluded warm-up per backend. Fresh process/database per measured suite. Backend order alternates. Startup and verification excluded from operation-only times. Includes pending persistence flush.',
  'Warm reads: working set fits PostgreSQL cache. 100 MiB configured page-cache budget: NodeFS PostgreSQL 100 MiB; singlefile PostgreSQL 98 MiB + SQLite 2 MiB. Adapter clean cache disabled. Not a total process RAM cap.',
  'SingleFileFS SQLite synchronous=FULL versus upstream NodeFS PostgreSQL fsync=off. This is not equal hardware durability. OS cache not cleared; no NVMe-specific performance claim.',
  'All six workloads, raw samples and warm-ups retained; no performance gate or cherry-picked samples.'
]};
mkdirSync('reports',{recursive:true});writeFileSync(process.env.BENCH_OUTPUT??'reports/benchmark-results.json',JSON.stringify(report,null,2));console.table(summary);
