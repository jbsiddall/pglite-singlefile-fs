export interface WorkloadSample { workload:string; acknowledgedMs:number; settledMs:number; filesystemReads:number|null; rows:number; checksum:string; }
export interface WorkerInfo { runtimeFlags:Record<string,string>;runtime:{name:string;version:string}; platform:string;arch:string;cpu:string;config:Record<string,unknown>;pageCacheMiB:Record<string,number>;settings:unknown[]; }
export interface WorkerClient { initialized:Promise<WorkerInfo>;run(workload:string):Promise<WorkloadSample>;close():Promise<{bytes:number}>;kill():void; }
export function startWorker(options:{backend:string;rows?:number;frequent?:number;batch?:number}):WorkerClient;
export function runtimeCommand(script:string):{runtime:string;executable:string;args:string[]};
