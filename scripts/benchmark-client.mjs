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
  const requestTimeoutMs=Number(process.env.BENCH_RPC_TIMEOUT_MS??120000);
  if(!Number.isSafeInteger(requestTimeoutMs)||requestTimeoutMs<1||requestTimeoutMs>120000){child.kill('SIGKILL');throw new Error('BENCH_RPC_TIMEOUT_MS must be an integer from 1 to 120000');}
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  const waitClosed=async()=>{
    let timer;
    try {
      const result=await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`${runtime} benchmark worker did not exit within 15 seconds`));},15000);})]);
      if(result.code!==0)throw new Error(`${runtime} benchmark worker exited ${result.code}/${result.signal}: ${stderr}`);
    }finally{clearTimeout(timer);}
  };
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-20000);});
  const rejectAll=(error)=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
  child.on('error',rejectAll);
  child.stdin.on('error',rejectAll);
  child.on('close',(code)=>{if(pending.size)rejectAll(new Error(`${runtime} worker exited (${code}): ${stderr}`));});
  createInterface({input:child.stdout}).on('line',line=>{
    let response;try{response=JSON.parse(line);}catch{return;}
    const promise=pending.get(response.id);if(!promise)return;pending.delete(response.id);clearTimeout(promise.timer);
    if(response.error)promise.reject(new Error(`[${runtime}/${response.error.backend??options.backend}/${response.error.command}/${response.error.workload??'setup'}] ${response.error.stack??response.error.message}`));else promise.resolve(response.value);
  });
  const request=(command,extra={})=>new Promise((resolve,reject)=>{
    const next=++id;
    const timer=setTimeout(()=>{
      child.kill('SIGKILL');
      rejectAll(new Error(`[${runtime}/${options.backend}/${command}/${extra.workload??'setup'}] RPC exceeded ${requestTimeoutMs} ms`));
    },requestTimeoutMs);
    pending.set(next,{resolve,reject,timer});
    try{child.stdin.write(JSON.stringify({id:next,command,...extra})+'\n');}catch(error){rejectAll(error);}
  });
  const initialized=request('initialize',{options}).then(info=>{
    if(info.runtime.name!==runtime)throw new Error(`Requested ${runtime}, worker actually used ${info.runtime.name}`);
    const expected=process.env.BENCH_RUNTIME_VERSION?.replace(/^v/,'');
    const actual=info.runtime.version.replace(/^v/,'');
    if(expected && /^\d+(\.\d+)*$/.test(expected) && !(actual===expected||actual.startsWith(expected+'.'))) throw new Error(`Expected ${runtime} ${expected}, got ${actual}`);
    return info;
  }).catch(error=>{child.kill('SIGKILL');rejectAll(error);throw error;});
  return { initialized, run:workload=>request('run',{workload}), async close(){await initialized;let storage;try{storage=await request('shutdown');}finally{child.stdin.end();}await waitClosed();return storage;}, kill(){child.kill('SIGKILL');rejectAll(new Error('Worker terminated'));} };
}
