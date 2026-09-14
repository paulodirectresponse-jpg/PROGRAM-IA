import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface SupervisedProcessResult {
  status:'pass'|'fail'|'aborted'|'timeout';
  exitCode:number|null;
  durationMs:number;
  output:string;
}

function redact(value:string){
  return value
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{12,}\b/g,'[REDACTED]')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/ig,'$1[REDACTED]')
    .replace(/\b(API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^\s]+/ig,'$1=[REDACTED]');
}

export class SandboxProcessSupervisor {
  static safeEnvironment(extra:Record<string,string>={}){
    const allowed=['PATH','Path','PATHEXT','SYSTEMROOT','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','TMPDIR','HOME','USERPROFILE','APPDATA','LOCALAPPDATA'];
    const env:NodeJS.ProcessEnv={CI:'1',FORGE_SANDBOX:'1',NO_COLOR:'1'};
    for(const key of allowed)if(process.env[key])env[key]=process.env[key];
    for(const [key,value] of Object.entries(extra))env[key]=value;
    return env;
  }

  static terminate(child:ChildProcess){
    if(!child.pid)return;
    if(process.platform==='win32'){
      try{spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}
      return;
    }
    try{process.kill(-child.pid,'SIGTERM');}catch{try{child.kill('SIGTERM');}catch{}}
    setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}},500).unref();
  }

  static async runNpmScript(input:{cwd:string;script:string;timeoutMs?:number;signal?:AbortSignal}):Promise<SupervisedProcessResult>{
    const packagePath=path.join(input.cwd,'package.json');
    if(!fs.existsSync(packagePath))return{status:'fail',exitCode:null,durationMs:0,output:'package.json não encontrado no sandbox.'};
    let pkg:any;
    try{pkg=JSON.parse(fs.readFileSync(packagePath,'utf8'));}catch{return{status:'fail',exitCode:null,durationMs:0,output:'package.json inválido no sandbox.'};}
    if(!pkg?.scripts?.[input.script])return{status:'fail',exitCode:null,durationMs:0,output:`Script npm não declarado: ${input.script}`};

    const npmCli=path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js');
    const command=fs.existsSync(npmCli)?process.execPath:(process.platform==='win32'?'npm.cmd':'npm');
    const args=fs.existsSync(npmCli)?[npmCli,'run',input.script]:['run',input.script];
    const started=Date.now();

    return await new Promise(resolve=>{
      let settled=false;
      let timedOut=false;
      let aborted=false;
      let output='';
      const child=spawn(command,args,{
        cwd:input.cwd,
        shell:false,
        windowsHide:true,
        detached:process.platform!=='win32',
        env:this.safeEnvironment(),
      });
      const collect=(chunk:Buffer)=>{
        output=redact((output+chunk.toString()).slice(-20000));
      };
      child.stdout?.on('data',collect);
      child.stderr?.on('data',collect);
      const finish=(status:SupervisedProcessResult['status'],exitCode:number|null)=>{
        if(settled)return;
        settled=true;
        clearTimeout(timer);
        input.signal?.removeEventListener('abort',onAbort);
        resolve({status,exitCode,durationMs:Date.now()-started,output:redact(output)});
      };
      const timer=setTimeout(()=>{
        timedOut=true;
        this.terminate(child);
      },Math.min(Math.max(1,Number(input.timeoutMs||120000)),10*60*1000));
      const onAbort=()=>{
        aborted=true;
        this.terminate(child);
      };
      input.signal?.addEventListener('abort',onAbort,{once:true});
      child.on('error',error=>finish('fail',null));
      child.on('close',code=>{
        if(aborted)return finish('aborted',code);
        if(timedOut)return finish('timeout',code);
        finish(code===0?'pass':'fail',code);
      });
    });
  }
}
