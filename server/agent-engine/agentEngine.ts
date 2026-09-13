import {LLMAdapterService,type AgentMode,type LLMExecutionResult} from '../services/llmAdapter.js';import {ModelRouter,type ProfileKey,type FailureKind} from '../services/modelRouter.js';import {selectAgent} from './agentRegistry.js';import {RunService} from '../services/runService.js';
type Input={prompt:string;mode:AgentMode;projectId:string;existingFiles:Record<string,string>;appliedSkills:string[];conversationHistory:Array<{sender:string;content:string}>;userId:string;runId:string;stepId:string;signal?:AbortSignal};
export class AgentEngine{static async execute(x:Input,profile:ProfileKey='BASE_FREE'):Promise<LLMExecutionResult&{agentKey:string;profileKey:ProfileKey}> {const agentKey=selectAgent(x.mode,x.prompt);RunService.assignAgent(x.stepId,agentKey);const available=ModelRouter.candidates(x.userId,profile).filter(c=>LLMAdapterService.getProviderConfig(c.provider_key,x.userId).isConfigured),candidates=available.slice(0,Math.max(1,Number(available[0]?.max_attempts||1)));if(!candidates.length){const fallback=await LLMAdapterService.executePrompt({...x,providerKey:undefined,allowActiveFallback:false});return{...fallback,agentKey,profileKey:profile};}let last:unknown;for(let i=0;i<candidates.length;i++){RunService.recordAttempt(x.stepId);const c=candidates[i],started=Date.now();try{ModelRouter.assertBudget(x.userId,Number(c.max_cost_usd||0),{runId:x.runId});const result=await LLMAdapterService.executePrompt({...x,providerKey:c.provider_key,modelId:c.model_id==='auto'?undefined:c.model_id});if(result.isDemonstrativeFallback||result.hasErrors){const reason=String(result.errorReason||result.errorMessage||'provider_error');const operational=/timeout|network|rate_limit|provider_error|429|5\d\d/i.test(reason);throw Object.assign(Error(result.errorMessage||'Provider indisponível'),{kind:operational?'operational':'incompatible',reason});}ModelRouter.recordCandidateResult(c.id,true);ModelRouter.recordInvocation({userId:x.userId,projectId:x.projectId,runId:x.runId,stepId:x.stepId,agentKey,profileKey:profile,providerKey:c.provider_key,modelId:c.model_id,inputTokens:result.usage?.inputTokens,outputTokens:result.usage?.outputTokens,costUsd:result.usage?.billedCostUsd,latencyMs:Date.now()-started,status:'success',retryIndex:i});return{...result,agentKey,profileKey:profile};}catch(e:any){last=e;const operational=/429|5\d\d|timeout|fetch|network|indispon/i.test(String(e.message));const kind:FailureKind=operational?'operational':'incompatible';ModelRouter.recordCandidateResult(c.id,false,kind);ModelRouter.recordInvocation({userId:x.userId,projectId:x.projectId,runId:x.runId,stepId:x.stepId,agentKey,profileKey:profile,providerKey:c.provider_key,modelId:c.model_id,latencyMs:Date.now()-started,status:'failed',errorCode:kind,retryIndex:i});}}throw last||Error('Nenhum modelo disponível.');}}



function needsStudio(prompt:string,mode:AgentMode){return mode==='auto'&&/interface|layout|design|visual|tela|css|responsiv|premium|ux|ui/i.test(prompt);}
function needsShip(prompt:string,mode:AgentMode){return mode==='publish'||/\b(public(?:ar|a|e)|deploy|lançar|release)\b/i.test(prompt);}

export type WorkflowResult = LLMExecutionResult & {agentKey:string;profileKey:ProfileKey;workflow:{runId:string;steps:string[];status:'completed'|'failed'|'aborted'}};

export class AgentWorkflowEngine extends AgentEngine{
 static async executeWorkflow(x:Input):Promise<WorkflowResult>{
  const steps:string[]=[x.stepId];
  RunService.assignAgent(x.stepId,'SCOUT');
  RunService.finishStep(x.stepId,'completed',RunService.context('task',{objective:x.prompt,acceptanceCriteria:['Responder sem estado falso','Preservar preview antes da aplicação definitiva'],snippets:Object.keys(x.existingFiles).slice(0,20)}));
  let order=1;
  if(needsStudio(x.prompt,x.mode)){
    const studio=RunService.createStep(x.runId,'STUDIO','Definir critérios visuais',order++,'local',RunService.context('local',{objective:'Direção visual/UX solicitada',constraints:['Não altera arquivos diretamente']}));
    steps.push(studio);RunService.finishStep(studio,'completed');
  }
  const forge=RunService.createStep(x.runId,'FORGE','Gerar resposta ou proposta',order++,'local',RunService.context('local',{objective:x.prompt,snippets:Object.keys(x.existingFiles).slice(0,12)}));
  steps.push(forge);
  let result:LLMExecutionResult&{agentKey:string;profileKey:ProfileKey};
  try{result=await AgentEngine.execute({...x,stepId:forge},'BASE_FREE');RunService.assignAgent(forge,'FORGE');RunService.finishStep(forge,result.hasErrors?'failed':'completed',{decisionType:result.decisionType,providerUsed:result.providerUsed,modelUsed:result.modelUsed,files:result.build?.files?.map(f=>f.path)||[]});}
  catch(error:any){
    RunService.finishStep(forge,'failed',{error:String(error?.message||error)});
    const sentinel=RunService.createStep(x.runId,'SENTINEL','Registrar falha com evidência',order++,'micro',RunService.context('micro',{objective:'Diagnosticar falha de provider/modelo',errors:[String(error?.message||error)]}));
    steps.push(sentinel);RunService.finishStep(sentinel,'completed');
    throw error;
  }
  const validate=RunService.createStep(x.runId,'SENTINEL','Preparar verificação da proposta',order++,'micro',{status:result.proposal?'pending_user_apply':'not_applicable',reason:result.proposal?'Preview antes de aplicar é intencional; gates rodam na aplicação definitiva.':'Sem proposta de código para validar.'});
  steps.push(validate);RunService.finishStep(validate,'completed');
  if(needsShip(x.prompt,x.mode)){
    const ship=RunService.createStep(x.runId,'SHIP','Preparar publicação solicitada',order++,'task',{requested:true,status:'delegated_to_publish_adapter'});
    steps.push(ship);RunService.finishStep(ship,'completed');
  }
  return {...result,workflow:{runId:x.runId,steps,status:result.hasErrors?'failed':'completed'}};
 }
}
