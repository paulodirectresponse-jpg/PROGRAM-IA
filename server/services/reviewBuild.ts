import ts from 'typescript';
import {LLMAdapterService, type LLMExecutionResult} from './llmAdapter.js';
import {WorkspaceManager} from './workspaceManager.js';
import {reviewUntilAccepted} from './reviewerLoop.js';

export async function reviewBuild(initial:LLMExecutionResult, context:{prompt:string;projectId:string;userId:string;providerKey:string;modelId?:string;existingFiles:Record<string,string>;appliedSkills:string[];signal:AbortSignal}) {
  const materialize=(candidate:LLMExecutionResult)=>{
    const files={...context.existingFiles};
    for(const f of candidate.build?.files||[]) {if(f.action==='delete')delete files[f.path];else files[f.path]=f.content;}
    return files;
  };
  return reviewUntilAccepted({
    initial,signal:context.signal,maxIterations:3,timeoutMs:120000,
    validate(candidate){
      const issues:string[]=[];
      if(candidate.hasErrors||candidate.isDemonstrativeFallback||!candidate.build?.files?.length)return ['O programador não retornou uma alteração válida.'];
      for(const file of candidate.build.files){
        try{
          WorkspaceManager.resolveSafePath(context.projectId,file.path);
          if(file.action==='delete')continue;
          if(file.path.endsWith('.json'))JSON.parse(file.content);
          if(/\.[cm]?[jt]sx?$/.test(file.path)){
            const output=ts.transpileModule(file.content,{fileName:file.path,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}});
            for(const d of output.diagnostics||[]) if(d.category===ts.DiagnosticCategory.Error) issues.push(`${file.path}: ${ts.flattenDiagnosticMessageText(d.messageText,' ')}`);
          }
        }catch{issues.push(`Caminho ou conteúdo inválido: ${file.path}`);}
      }
      return issues;
    },
    async review(candidate,signal){
      const review=await LLMAdapterService.executePrompt({...context,signal,mode:'review',conversationHistory:[],existingFiles:materialize(candidate),prompt:`Revise o código proposto para atender este pedido: ${context.prompt}\nProcure falhas funcionais, perda de dados e regressões. Não declare testes executados. Responda somente JSON com {"approved":boolean,"issues":string[]}. Se houver problemas, approved deve ser false. A proposta altera: ${candidate.build?.files.map(f=>f.path).join(', ')}`});
      if(review.hasErrors||review.isDemonstrativeFallback)throw new Error('Revisor indisponível. Nenhuma alteração aplicada.');
      return LLMAdapterService.extractStructuredJson(review.replyText);
    },
    async repair(candidate,issues,signal){
      return LLMAdapterService.executePrompt({...context,signal,mode:'build',conversationHistory:[],existingFiles:context.existingFiles,prompt:`Pedido original: ${context.prompt}\nA proposta anterior foi rejeitada. Retorne a proposta completa corrigida, incluindo todas as alterações necessárias em relação aos arquivos originais.\nProblemas: ${JSON.stringify(issues)}\nProposta anterior: ${JSON.stringify(candidate.build)}`});
    },
  });
}
