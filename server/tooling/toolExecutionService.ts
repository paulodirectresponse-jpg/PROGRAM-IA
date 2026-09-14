import { WorkspaceManager } from '../services/workspaceManager.js';
import { ToolExecutionJournal } from './toolExecutionJournal.js';
import { ToolPolicy } from './toolPolicy.js';
import { ToolRegistry } from './toolRegistry.js';
import type { ToolExecutionContext, ToolExecutionRequest, ToolExecutionResult } from './types.js';

function errorCode(error:unknown) {
  return String((error as any)?.code || 'tool_execution_failed');
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

    const record=ToolExecutionJournal.start({
      context,definition,requestInput:request.input || {},idempotencyKey:request.idempotencyKey || null,
    });
    const started=Date.now();

    if (definition.availability!=='ready') {
      ToolExecutionJournal.finish(record.id,'blocked',{availability:definition.availability,risk:definition.risk},'sandbox_required',Date.now()-started);
      return {
        executionId:record.id,toolKey:definition.key,toolVersion:definition.version,status:'blocked',
        errorCode:'sandbox_required',message:'Ferramenta exige sandbox/worktree isolado da Fase 2.',durationMs:Date.now()-started,
      };
    }

    try {
      context.signal?.throwIfAborted();
      let output:unknown;
      let summary:Record<string,unknown>={};

      if (definition.key==='workspace.list_tree') {
        const prefix=String(request.input.pathPrefix || '').replace(/\\/g,'/').replace(/^\.\//,'');
        const files=WorkspaceManager.getFiles(context.projectId)
          .filter(file=>!prefix || file.path.replace(/\\/g,'/').startsWith(prefix))
          .map(file=>({path:file.path,size:file.size,isBinary:file.isBinary,updatedAt:file.updatedAt}));
        output={files};
        summary={fileCount:files.length,pathPrefix:prefix || null};
      } else if (definition.key==='workspace.read_file') {
        const path=ToolPolicy.assertReadablePath(request.input.path);
        if (WorkspaceManager.isBinaryPath(path)) throw Object.assign(new Error('Arquivo binário não pode ser lido como texto.'),{code:'binary_file'});
        const content=WorkspaceManager.readFile(context.projectId,path);
        if (content===null) throw Object.assign(new Error('Arquivo não encontrado.'),{code:'file_not_found'});
        const start=request.input.start===undefined ? 0 : Number(request.input.start);
        const end=request.input.end===undefined ? content.length : Number(request.input.end);
        if (end<start) throw Object.assign(new Error('Range inválido.'),{code:'invalid_range'});
        const slice=content.slice(start,end);
        output={path,start,end:Math.min(end,content.length),content:slice,truncated:end<content.length || start>0};
        summary={path,start,end:Math.min(end,content.length),chars:slice.length,partial:end<content.length || start>0};
      } else if (definition.key==='workspace.search_text') {
        const query=String(request.input.query || '');
        if (!query) throw Object.assign(new Error('Query obrigatória.'),{code:'invalid_query'});
        const prefix=String(request.input.pathPrefix || '').replace(/\\/g,'/').replace(/^\.\//,'');
        const maxMatches=request.input.maxMatches===undefined ? null : Number(request.input.maxMatches);
        const matches:Array<{path:string;index:number;line:number;preview:string}>=[];
        outer: for (const file of WorkspaceManager.getFiles(context.projectId)) {
          const path=file.path.replace(/\\/g,'/');
          if (file.isBinary || ToolPolicy.isSensitivePath(path) || (prefix && !path.startsWith(prefix))) continue;
          const content=WorkspaceManager.readFile(context.projectId,path);
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
        output={query,matches,limited:maxMatches!==null && matches.length>=maxMatches};
        summary={queryLength:query.length,matchCount:matches.length,maxMatches};
      } else {
        throw Object.assign(new Error('Executor ainda não implementado para esta ferramenta.'),{code:'tool_not_implemented'});
      }

      const durationMs=Date.now()-started;
      ToolExecutionJournal.finish(record.id,'succeeded',summary,null,durationMs);
      return {executionId:record.id,toolKey:definition.key,toolVersion:definition.version,status:'succeeded',output,durationMs};
    } catch (error:any) {
      const aborted=context.signal?.aborted || error?.name==='AbortError';
      const status=aborted?'aborted':errorCode(error)==='sensitive_path'?'blocked':'failed';
      const durationMs=Date.now()-started;
      ToolExecutionJournal.finish(record.id,status,{message:String(error?.message || error)},errorCode(error),durationMs);
      return {
        executionId:record.id,toolKey:definition.key,toolVersion:definition.version,status,
        errorCode:errorCode(error),message:String(error?.message || error),durationMs,
      };
    }
  }
}
