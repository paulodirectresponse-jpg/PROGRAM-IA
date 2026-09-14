import crypto from 'node:crypto';
import { BrowserQualityService } from '../browser/browserQualityService.js';
import { WorkspaceManager } from '../services/workspaceManager.js';
import { ExecutionWorker } from '../services/executionWorker.js';
import { SandboxManager } from './sandboxManager.js';
import { ToolExecutionJournal } from './toolExecutionJournal.js';
import { ToolPolicy } from './toolPolicy.js';
import { ToolRegistry } from './toolRegistry.js';
import type { ToolExecutionContext, ToolExecutionRequest, ToolExecutionResult } from './types.js';

function errorCode(error:unknown) {
  return String((error as any)?.code || 'tool_execution_failed');
}

function requireSandbox(context:ToolExecutionContext){
  if(!context.sandboxId)throw Object.assign(new Error('Ferramenta exige sandbox isolado.'),{code:'sandbox_required'});
  return SandboxManager.assertAccess(context.sandboxId,context.userId,context.projectId);
}

function safeMutationPath(value:unknown){
  const path=ToolPolicy.normalizeRelativePath(value);
  if(ToolPolicy.isSensitivePath(path))throw Object.assign(new Error('Arquivo sensível bloqueado para mutation tool.'),{code:'sensitive_path'});
  return path;
}

function parsePatch(raw:string){
  let parsed:any;
  try{parsed=JSON.parse(raw);}catch{throw Object.assign(new Error('Patch deve ser JSON válido.'),{code:'invalid_patch'});}
  const items=Array.isArray(parsed)?parsed:[parsed];
  if(!items.length)throw Object.assign(new Error('Patch vazio.'),{code:'invalid_patch'});
  return items.map((item:any)=>{
    if(!item||typeof item!=='object'||typeof item.path!=='string'||typeof item.search!=='string'||typeof item.replace!=='string'){
      throw Object.assign(new Error('Patch precisa de path, search e replace em string.'),{code:'invalid_patch'});
    }
    return {path:safeMutationPath(item.path),search:item.search,replace:item.replace};
  });
}

export class ToolExecutionService {
  static async execute(context:ToolExecutionContext,request:ToolExecutionRequest):Promise<ToolExecutionResult> {
    const definition=ToolRegistry.get(request.toolKey);
    if (!definition) {
      return {executionId:'',toolKey:request.toolKey,toolVersion:'0',status:'blocked',errorCode:'tool_unknown',message:'Ferramenta desconhecida.',durationMs:0};
    }
    if (!WorkspaceManager.verifyProjectOwnership(context.projectId,context.userId)) {
      return {executionId:'',toolKey:definition.key,toolVersion:definition.version,status:'blocked',errorCode:'project_forbidden',message:'Projeto não pertence ao usuário.',durationMs:0};
    }
    const validation=ToolRegistry.validate(definition.key,request.input || {});
    if (validation.length) {
      return {executionId:'',toolKey:definition.key,toolVersion:definition.version,status:'blocked',errorCode:'invalid_tool_input',message:validation.join(', '),durationMs:0};
    }

    if(request.idempotencyKey&&context.runId){
      const previous=ToolExecutionJournal.findByIdempotency(context.runId,request.idempotencyKey);
      if(previous){
        if(['running','queued','interrupted'].includes(previous.status)){
          return {executionId:previous.id,toolKey:definition.key,toolVersion:definition.version,status:'blocked',errorCode:'uncertain_previous_execution',message:'Execução anterior com a mesma chave não possui resultado terminal seguro.',durationMs:previous.durationMs};
        }
        return {executionId:previous.id,toolKey:definition.key,toolVersion:definition.version,status:previous.status,message:'Resultado idempotente já registrado; side effect não foi repetido.',durationMs:previous.durationMs};
      }
    }

    let sandboxRecord=null;
    try{
      if(definition.availability==='requires_sandbox')sandboxRecord=requireSandbox(context);
      else if(context.sandboxId)sandboxRecord=SandboxManager.assertAccess(context.sandboxId,context.userId,context.projectId);
    }catch(error:any){
      return {executionId:'',toolKey:definition.key,toolVersion:definition.version,status:'blocked',errorCode:errorCode(error),message:String(error?.message||error),durationMs:0};
    }

    const record=ToolExecutionJournal.start({
      context,definition,requestInput:request.input || {},idempotencyKey:request.idempotencyKey || null,
    });
    const started=Date.now();

    try {
      context.signal?.throwIfAborted();
      let output:unknown;
      let summary:Record<string,unknown>={};

      const listFiles=()=>context.sandboxId
        ? SandboxManager.getFiles(context.sandboxId,context.userId,context.projectId)
        : WorkspaceManager.getFiles(context.projectId);
      const readFile=(filePath:string)=>context.sandboxId
        ? SandboxManager.readFile(context.sandboxId!,context.userId,filePath,context.projectId)
        : WorkspaceManager.readFile(context.projectId,filePath);

      if (definition.key==='workspace.list_tree') {
        const prefix=String(request.input.pathPrefix || '').replace(/\\/g,'/').replace(/^\.\//,'');
        const files=listFiles()
          .filter(file=>!prefix || file.path.replace(/\\/g,'/').startsWith(prefix))
          .filter(file=>!ToolPolicy.isSensitivePath(file.path))
          .map(file=>({path:file.path,size:file.size,isBinary:file.isBinary,updatedAt:file.updatedAt}));
        output={files,sandboxId:context.sandboxId||null};
        summary={fileCount:files.length,pathPrefix:prefix || null,sandbox:Boolean(context.sandboxId)};
      } else if (definition.key==='workspace.read_file') {
        const path=ToolPolicy.assertReadablePath(request.input.path);
        if (WorkspaceManager.isBinaryPath(path)) throw Object.assign(new Error('Arquivo binário não pode ser lido como texto.'),{code:'binary_file'});
        const content=readFile(path);
        if (content===null) throw Object.assign(new Error('Arquivo não encontrado.'),{code:'file_not_found'});
        const start=request.input.start===undefined ? 0 : Number(request.input.start);
        const end=request.input.end===undefined ? content.length : Number(request.input.end);
        if (end<start) throw Object.assign(new Error('Range inválido.'),{code:'invalid_range'});
        const slice=content.slice(start,end);
        output={path,start,end:Math.min(end,content.length),content:slice,truncated:end<content.length || start>0,sandboxId:context.sandboxId||null};
        summary={path,start,end:Math.min(end,content.length),chars:slice.length,partial:end<content.length || start>0,sandbox:Boolean(context.sandboxId)};
      } else if (definition.key==='workspace.search_text') {
        const query=String(request.input.query || '');
        if (!query) throw Object.assign(new Error('Query obrigatória.'),{code:'invalid_query'});
        const prefix=String(request.input.pathPrefix || '').replace(/\\/g,'/').replace(/^\.\//,'');
        const maxMatches=request.input.maxMatches===undefined ? null : Number(request.input.maxMatches);
        const matches:Array<{path:string;index:number;line:number;preview:string}>=[];
        outer: for (const file of listFiles()) {
          const path=file.path.replace(/\\/g,'/');
          if (file.isBinary || ToolPolicy.isSensitivePath(path) || (prefix && !path.startsWith(prefix))) continue;
          const content=readFile(path);
          if (content===null) continue;
          let from=0;
          while (from<=content.length) {
            const index=content.indexOf(query,from);
            if (index<0) break;
            const line=content.slice(0,index).split('\n').length;
            const preview=content.slice(Math.max(0,index-80),Math.min(content.length,index+query.length+80));
            matches.push({path,index,line,preview});
            from=index+Math.max(1,query.length);
            if (maxMatches!==null && matches.length>=maxMatches) break outer;
          }
        }
        output={query,matches,limited:maxMatches!==null && matches.length>=maxMatches,sandboxId:context.sandboxId||null};
        summary={queryLength:query.length,matchCount:matches.length,maxMatches,sandbox:Boolean(context.sandboxId)};
      } else if(definition.key==='workspace.write_file'){
        const sandbox=requireSandbox(context);
        const path=safeMutationPath(request.input.path);
        const content=String(request.input.content ?? '');
        SandboxManager.writeFile(sandbox.id,context.userId,path,content,context.projectId);
        output={path,chars:content.length,sandboxId:sandbox.id};
        summary={path,chars:content.length,contentHash:crypto.createHash('sha256').update(content).digest('hex'),sandboxId:sandbox.id};
      } else if(definition.key==='workspace.delete_file'){
        const sandbox=requireSandbox(context);
        const path=safeMutationPath(request.input.path);
        const existed=SandboxManager.deleteFile(sandbox.id,context.userId,path,context.projectId);
        output={path,deleted:existed,sandboxId:sandbox.id};
        summary={path,deleted:existed,sandboxId:sandbox.id};
      } else if(definition.key==='workspace.apply_patch'){
        const sandbox=requireSandbox(context);
        const patches=parsePatch(String(request.input.patch || ''));
        const changed:string[]=[];
        for(const patch of patches){
          const current=SandboxManager.readFile(sandbox.id,context.userId,patch.path,context.projectId);
          if(current===null)throw Object.assign(new Error(`Arquivo do patch não encontrado: ${patch.path}`),{code:'patch_target_missing'});
          const first=current.indexOf(patch.search);
          if(first<0)throw Object.assign(new Error(`Trecho do patch não encontrado: ${patch.path}`),{code:'patch_search_missing'});
          if(current.indexOf(patch.search,first+Math.max(1,patch.search.length))>=0)throw Object.assign(new Error(`Trecho do patch não é único: ${patch.path}`),{code:'patch_ambiguous'});
          const next=current.slice(0,first)+patch.replace+current.slice(first+patch.search.length);
          SandboxManager.writeFile(sandbox.id,context.userId,patch.path,next,context.projectId);
          changed.push(patch.path);
        }
        output={changedFiles:changed,sandboxId:sandbox.id};
        summary={changedFiles:changed,patchCount:patches.length,sandboxId:sandbox.id};
      } else if(definition.key==='browser.inspect_page'){
        const sandbox=requireSandbox(context);
        const quality=await BrowserQualityService.inspect({
          userId:context.userId,
          projectId:context.projectId,
          sandboxId:sandbox.id,
          runId:context.runId||null,
          stepId:context.stepId||null,
          entryPath:request.input.entryPath ? String(request.input.entryPath) : undefined,
          signal:context.signal,
        });
        const publicQuality={
          ...quality,
          viewports:quality.viewports.map(({screenshotPath:_screenshotPath,...viewport})=>viewport),
        };
        output=publicQuality;
        summary={
          qualityRunId:quality.id,
          status:quality.status,
          issueCount:quality.issues.length,
          errorCount:quality.issues.filter(issue=>issue.severity==='error').length,
          warningCount:quality.issues.filter(issue=>issue.severity==='warning').length,
          runtimeKind:quality.runtimeKind,
          framework:quality.framework||null,
          viewportCount:quality.viewports.length,
          sandboxId:sandbox.id,
        };
      } else if(definition.key==='process.run'){
        const sandbox=requireSandbox(context);
        const script=String(request.input.script || '').trim();
        if(!script||/^(?:preinstall|install|postinstall|prepare|prepublish|publish)$/i.test(script)){
          throw Object.assign(new Error('Script bloqueado pela política do sandbox.'),{code:'process_script_blocked'});
        }
        const result=await ExecutionWorker.runScript(sandbox.rootPath,script,context.signal,request.input.timeoutMs===undefined?undefined:Number(request.input.timeoutMs));
        const status=result.status==='pass'?'succeeded':result.status==='aborted'?'aborted':'failed';
        const durationMs=Date.now()-started;
        const processSummary={script,exitCode:result.exitCode,processStatus:result.status,output:result.output.slice(-4000),sandboxId:sandbox.id};
        ToolExecutionJournal.finish(record.id,status,processSummary,status==='failed'?'process_failed':status==='aborted'?'aborted':null,durationMs);
        return {
          executionId:record.id,toolKey:definition.key,toolVersion:definition.version,status,
          output:{script,exitCode:result.exitCode,status:result.status,output:result.output,sandboxId:sandbox.id},
          errorCode:status==='failed'?'process_failed':status==='aborted'?'aborted':undefined,
          durationMs,
        };
      } else {
        throw Object.assign(new Error('Executor ainda não implementado para esta ferramenta.'),{code:'tool_not_implemented'});
      }

      const durationMs=Date.now()-started;
      ToolExecutionJournal.finish(record.id,'succeeded',summary,null,durationMs);
      return {executionId:record.id,toolKey:definition.key,toolVersion:definition.version,status:'succeeded',output,durationMs};
    } catch (error:any) {
      const aborted=context.signal?.aborted || error?.name==='AbortError';
      const code=errorCode(error);
      const status=aborted?'aborted':['sensitive_path','sandbox_required','sandbox_forbidden','process_script_blocked'].includes(code)?'blocked':'failed';
      const durationMs=Date.now()-started;
      ToolExecutionJournal.finish(record.id,status,{message:String(error?.message || error),sandboxId:context.sandboxId||null},code,durationMs);
      return {
        executionId:record.id,toolKey:definition.key,toolVersion:definition.version,status,
        errorCode:code,message:String(error?.message || error),durationMs,
      };
    }
  }
}
