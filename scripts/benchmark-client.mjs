import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
export function runtimeCommand(script) {
  const runtime=process.env.BENCH_RUNTIME??process.env.TEST_RUNTIME??'node';
  const executable=process.env.BENCH_RUNTIME_BIN??runtime;
  return { runtime, executable, args:runtime==='deno'?['run','--allow-all',script]:[script] };
}
export function startWorker(options) {
  const script=fileURLToPath(new URL('./benchmark-worker.mjs',import.meta.url));
  const {runtime,executable,args}=runtimeCommand(script);
  const child=spawn(executable,args,{stdio:['pipe','pipe','pipe'],env:process.env});
  const pending=new Map();let id=0,stderr='';
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-20000);});
  const rejectAll=(error)=>{for(const p of pending.values())p.reject(error);pending.clear();};
  child.on('error',rejectAll);
  child.stdin.on('error',rejectAll);
  child.on('exit',(code)=>{if(pending.size)rejectAll(new Error(`${runtime} worker exited (${code}): ${stderr}`));});
  createInterface({input:child.stdout}).on('line',line=>{
    let response;try{response=JSON.parse(line);}catch{return;}
    const promise=pending.get(response.id);if(!promise)return;pending.delete(response.id);
    if(response.error)promise.reject(new Error(response.error.stack??response.error.message));else promise.resolve(response.value);
  });
  const request=(command,extra={})=>new Promise((resolve,reject)=>{const next=++id;pending.set(next,{resolve,reject});child.stdin.write(JSON.stringify({id:next,command,...extra})+'\n');});
  const initialized=request('initialize',{options}).then(info=>{
    if(info.runtime.name!==runtime)throw new Error(`Requested ${runtime}, worker actually used ${info.runtime.name}`);
    const expected=process.env.BENCH_RUNTIME_VERSION?.replace(/^v/,'');
    const actual=info.runtime.version.replace(/^v/,'');
    if(expected && /^\d+(\.\d+)*$/.test(expected) && !(actual===expected||actual.startsWith(expected+'.'))) throw new Error(`Expected ${runtime} ${expected}, got ${actual}`);
    return info;
  }).catch(error=>{child.kill('SIGKILL');rejectAll(error);throw error;});
  return { initialized, run:workload=>request('run',{workload}), async close(){await initialized;try{return await request('shutdown');}finally{child.stdin.end();}}, kill(){child.kill('SIGKILL');rejectAll(new Error('Worker terminated'));} };
}
