import fs from 'node:fs';
import path from 'node:path';
import { SandboxProcessSupervisor } from '../tooling/sandboxProcessSupervisor.js';

export type WorkerTool='typecheck'|'lint'|'build'|'test';
export interface WorkerResult{tool:WorkerTool;status:'pass'|'fail'|'skipped';exitCode:number|null;durationMs:number;output:string}

export class ExecutionWorker{
  static available(cwd:string){
    try{
      const p=JSON.parse(fs.readFileSync(path.join(cwd,'package.json'),'utf8'));
      return new Set(Object.keys(p.scripts||{}));
    }catch{return new Set<string>();}
  }

  static safeEnvironment(){
    return SandboxProcessSupervisor.safeEnvironment();
  }

  static sandboxEnvironment(cwd:string){
    return SandboxProcessSupervisor.sandboxEnvironment(cwd);
  }

  static async run(cwd:string,tool:WorkerTool,signal?:AbortSignal):Promise<WorkerResult>{
    const scripts=this.available(cwd);
    let script:WorkerTool|null=null;
    if(tool==='typecheck')script=scripts.has('typecheck')?'typecheck':scripts.has('lint')?'lint':null;
    else script=scripts.has(tool)?tool:null;
    if(!script)return{tool,status:'skipped',exitCode:null,durationMs:0,output:'Script não declarado no package.json.'};
    const result=await SandboxProcessSupervisor.runNpmScript({cwd,script,signal});
    return {
      tool,
      status:result.status==='pass'?'pass':'fail',
      exitCode:result.exitCode,
      durationMs:result.durationMs,
      output:result.output || (result.status==='timeout'?'Processo excedeu timeout.':result.status==='aborted'?'Processo cancelado.':''),
    };
  }

  static async runScript(cwd:string,script:string,signal?:AbortSignal,timeoutMs?:number){
    return SandboxProcessSupervisor.runNpmScript({cwd,script,signal,timeoutMs});
  }
}
