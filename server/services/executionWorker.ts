import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
export type WorkerTool='typecheck'|'lint'|'build'|'test';
export interface WorkerResult{tool:WorkerTool;status:'pass'|'fail'|'skipped';exitCode:number|null;durationMs:number;output:string}
export class ExecutionWorker{
 static available(cwd:string){try{const p=JSON.parse(fs.readFileSync(path.join(cwd,'package.json'),'utf8'));return new Set(Object.keys(p.scripts||{}));}catch{return new Set<string>();}}
 static async run(cwd:string,tool:WorkerTool,signal?:AbortSignal):Promise<WorkerResult>{const scripts=this.available(cwd);let args:string[]|null=null;if(tool==='typecheck')args=scripts.has('typecheck')?['run','typecheck']:scripts.has('lint')?['run','lint']:null;else args=scripts.has(tool)?['run',tool]:null;if(!args)return{tool,status:'skipped',exitCode:null,durationMs:0,output:'Script não declarado no package.json.'};const started=Date.now();return await new Promise((resolve)=>{const child=spawn(process.platform==='win32'?'npm.cmd':'npm',args!,{cwd,shell:false,windowsHide:true,env:{...process.env,CI:'1'}});let out='';const collect=(b:Buffer)=>{out=(out+b.toString()).slice(-20000)};child.stdout.on('data',collect);child.stderr.on('data',collect);const timer=setTimeout(()=>child.kill(),120000);const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});child.on('error',e=>{clearTimeout(timer);resolve({tool,status:'fail',exitCode:null,durationMs:Date.now()-started,output:e.message})});child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve({tool,status:code===0?'pass':'fail',exitCode:code,durationMs:Date.now()-started,output:out})});});}
}

