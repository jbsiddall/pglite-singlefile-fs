import { test, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { startWorker } from '../scripts/benchmark-client.mjs';

const workloads=['batchRead','batchInsert','batchUpdate','frequentRead','frequentInsert','frequentUpdate'];
const records:Record<string,unknown>[]=[];
const environments:Record<string,unknown>={};
// Vitest wall times include JSON-RPC and correctness verification. Operation-only
// timings are recorded separately; benchmark-run.mjs is the publication baseline.
for(const workload of workloads) {
  test(workload,async({bench})=>{
    const workers:Record<string,ReturnType<typeof startWorker>>={};
    try {
      for(const backend of ['nodefs','singlefile']) {
        workers[backend]=startWorker({backend});environments[backend]=await workers[backend].initialized;
        await workers[backend].run(workload);
      }
      await bench.compare(...['nodefs','singlefile'].map(backend=>bench(
        `${backend} — RPC + operation + verification`,
        {writeResult:`reports/benchmarks/${workload}-${backend}.json`},
        async()=>{records.push({backend,...await workers[backend].run(workload)});},
      )),{iterations:3,time:0,warmup:false});
    } finally {
      for(const worker of Object.values(workers))await worker.close();
    }
  },120000);
}
afterAll(()=>{
  mkdirSync('reports',{recursive:true});
  writeFileSync('reports/vitest-operation-samples.json',JSON.stringify({notes:'Vitest wall times include RPC and verification. Worker samples measure operation plus persistence, exclude verification and PostgreSQL startup. Insert samples grow the table. Use benchmark-run.mjs fresh-process alternating samples for published ratios.',environments,records},null,2));
});
