import { AgentEngine } from '../agent-engine/agentEngine.js';
import { db } from '../db/index.js';
import { ContextEngineV2 } from '../context-engine/contextEngine.js';
import { RequirementLedgerService } from '../services/requirementLedgerService.js';
import { RunService } from '../services/runService.js';
import { ValidatorEngine } from '../services/validatorEngine.js';
import { WorkspaceManager } from '../services/workspaceManager.js';
import { ProposalSandboxService } from './proposalSandboxService.js';
import { SandboxManager } from './sandboxManager.js';
import { ToolExecutionService } from './toolExecutionService.js';

type CandidateChange={path:string;action:string;content?:string};

export interface SandboxProposalApplyResult {
  success:boolean;
  statusCode:number;
  error?:string;
  errorCode?:string;
  validation?:any;
  sandboxId?:string;
  repair?:any;
  checkpointId?:string;
  changedFiles?:string[];
  needsVerification?:boolean;
  merge?:any;
  browserQuality?:any;
  browserRepair?:any;
}

function requirementIds(projectId:string,runId?:string|null,planId?:string|null){
  const rows=runId?RequirementLedgerService.listByRun(runId):(planId?RequirementLedgerService.listByPlan(projectId,planId):[]);
  return rows.map(row=>row.requirement_key).filter(Boolean);
}

function canonicalMergeChanges(sandboxId:string,changes:CandidateChange[]) {
  const record=SandboxManager.get(sandboxId);
  if(!record)throw Object.assign(new Error('Sandbox não encontrado.'),{code:'sandbox_not_found'});
  const merged=new Map<string,CandidateChange>();
  for(const change of changes){
    const action=change.action==='delete'
      ? 'delete'
      : record.baseManifest[change.path]===undefined ? 'create' : 'modify';
    merged.set(change.path,{...change,action});
  }
  return [...merged.values()];
}

function candidateMismatchResult(error:any,validation:any,sandboxId:string){
  return {
    success:false,
    statusCode:409,
    error:'O conteúdo candidato do sandbox divergiu da proposta/repair esperado; nada foi aplicado.',
    validation,
    sandboxId,
    errorCode:String(error?.code||'sandbox_proposal_mismatch'),
  };
}

export class SandboxProposalApplyService {
  static async apply(input:{
    userId:string;
    projectId:string;
    proposal:any;
    runId?:string|null;
    planId?:string|null;
    summary:string;
    originalRequest?:string;
    shipRequested?:boolean;
    signal?:AbortSignal;
  }):Promise<SandboxProposalApplyResult>{
    const proposal=input.proposal;
    if(!proposal?.id||!Array.isArray(proposal.files)||!proposal.files.length){
      return {success:false,statusCode:409,error:'Proposta vazia ou inválida.'};
    }

    const expectedByPath=new Map<string,CandidateChange>();
    for(const file of proposal.files)expectedByPath.set(String(file.path),{path:String(file.path),action:String(file.action),content:file.content});

    let materializedValidation:any=null;
    if(!proposal.sandboxId){
      const materialized=await ProposalSandboxService.materialize({
        userId:input.userId,projectId:input.projectId,runId:input.runId||null,stepId:null,
        proposalId:proposal.id,files:proposal.files,signal:input.signal,
      });
      proposal.sandboxId=materialized.sandboxId;
      proposal.baseRevision=materialized.baseRevision;
      proposal.sandboxValidation=materialized.validation;
      proposal.toolExecutionIds=materialized.toolExecutionIds;
      materializedValidation=materialized.validation;
    }

    const sandboxId=String(proposal.sandboxId);
    const reqIds=requirementIds(input.projectId,input.runId,input.planId);
    let repairSummary:any=null;

    try{
      SandboxManager.assertExpectedChanges(sandboxId,input.userId,input.projectId,[...expectedByPath.values()],{allowExtraPaths:true});
    }catch(error:any){
      return candidateMismatchResult(error,materializedValidation,sandboxId);
    }

    let validation=materializedValidation || await ValidatorEngine.validate({
      projectId:input.projectId,runId:input.runId||undefined,signal:input.signal,
      sandboxId,userId:input.userId,
    });

    // Validation/build/test processes may create artifacts, but they may not mutate the
    // approved candidate files. Extra generated files are ignored by mergeAtomic.
    try{
      SandboxManager.assertExpectedChanges(sandboxId,input.userId,input.projectId,[...expectedByPath.values()],{allowExtraPaths:true});
    }catch(error:any){
      return candidateMismatchResult(error,validation,sandboxId);
    }

    if(validation.status==='failed'&&input.runId){
      const failed=validation.results.find((item:any)=>item.status==='fail');
      const errorOutput=failed?.output||validation.security?.issues?.join('; ')||'validation_failed';
      const affectedFiles=proposal.files.map((file:any)=>file.path);
      const sentinel=RunService.createStep(input.runId,'SENTINEL','Diagnosticar falha no sandbox',undefined,'micro',{
        sandboxId,failedGate:failed?.tool||null,errors:[errorOutput],affectedFiles,
      });
      ContextEngineV2.recordCommit({
        projectId:input.projectId,runId:input.runId,taskId:sentinel,agentKey:'SENTINEL',scope:'MICRO',
        task:'Diagnóstico de falha no sandbox',changedFiles:affectedFiles,requirementIds:reqIds,
        validation,blockers:[String(errorOutput)],nextState:{next:'FORGE_REPAIR_SANDBOX'},
      });
      RunService.finishStep(sentinel,'completed',{sandboxId,failedGate:failed?.tool||null,error:String(errorOutput)});

      const repairStep=RunService.createStep(input.runId,'FORGE','Corrigir falha de validação',undefined,'local',{
        sandboxId,affectedFiles,failedGate:failed?.tool||null,
      });
      try{
        const repair=await AgentEngine.execute({
          prompt:`Corrija somente a falha concreta detectada pelo ValidatorEngine no sandbox.\nFalha: ${errorOutput}`,
          mode:'build',
          projectId:input.projectId,
          existingFiles:SandboxManager.getAllFilesContent(sandboxId,input.userId,input.projectId),
          appliedSkills:[],
          conversationHistory:[],
          userId:input.userId,
          runId:input.runId,
          stepId:repairStep,
          requirementIds:reqIds,
          focusPaths:affectedFiles,
          signal:input.signal,
          skipContextSync:true,
          toolSandboxId:sandboxId,
        },{profile:'BASE_FREE',forcedAgentKey:'FORGE',allowExpertEscalation:true,repair:true});
        const repairFiles=repair.build?.files||repair.proposal?.files||[];
        if(!repairFiles.length)throw new Error('Repair não retornou arquivos aplicáveis.');

        for(const file of repairFiles){
          const execution=await ToolExecutionService.execute({
            userId:input.userId,projectId:input.projectId,runId:input.runId,stepId:repairStep,sandboxId,signal:input.signal,
          },{
            toolKey:file.action==='delete'?'workspace.delete_file':'workspace.write_file',
            input:file.action==='delete'?{path:file.path}:{path:file.path,content:String(file.content||'')},
            idempotencyKey:`repair:${proposal.id}:${file.action}:${file.path}`,
          });
          if(execution.status!=='succeeded')throw new Error(execution.message||'Repair tool falhou.');
          expectedByPath.set(String(file.path),{path:String(file.path),action:String(file.action),content:file.content});
        }

        validation=await ValidatorEngine.validate({
          projectId:input.projectId,runId:input.runId,stepId:repairStep,signal:input.signal,
          sandboxId,userId:input.userId,
        });

        try{
          SandboxManager.assertExpectedChanges(sandboxId,input.userId,input.projectId,[...expectedByPath.values()],{allowExtraPaths:true});
        }catch(error:any){
          throw Object.assign(new Error('Validator alterou o conteúdo candidato durante o repair.'),{code:error?.code||'sandbox_proposal_mismatch'});
        }

        ContextEngineV2.recordCommit({
          projectId:input.projectId,runId:input.runId,taskId:repairStep,agentKey:'FORGE',scope:'LOCAL',
          task:'Repair bounded no sandbox',changedFiles:repairFiles.map((file:any)=>file.path),requirementIds:reqIds,
          validation,blockers:validation.status==='failed'?['repair_validation_failed']:[],nextState:{status:validation.status},
        });
        RunService.finishStep(repairStep,validation.status==='failed'?'failed':'completed',{sandboxId,validation,profileKey:repair.profileKey});
        if(validation.status!=='failed') repairSummary={attempted:true,status:'passed',profileKey:repair.profileKey,files:repairFiles.map((file:any)=>file.path)};
        if(validation.status==='failed'){
          RequirementLedgerService.setStatusForRun(input.runId,'failed',{type:'sandbox_repair_failed',validation},repairFiles.map((f:any)=>f.path));
          RunService.finish(input.runId,repairStep,'failed');
          return {success:false,statusCode:422,error:'A proposta e o repair falharam no sandbox; o workspace oficial não foi alterado.',validation,sandboxId,repair:{attempted:true,status:'failed'}};
        }
      }catch(error:any){
        RunService.finishStep(repairStep,error?.name==='AbortError'?'aborted':'failed',{sandboxId,error:String(error?.message||error)});
        RunService.finish(input.runId,repairStep,error?.name==='AbortError'?'aborted':'failed');
        return {success:false,statusCode:error?.name==='AbortError'?499:422,error:'O repair no sandbox falhou; o workspace oficial não foi alterado.',validation,sandboxId,repair:{attempted:true,status:'failed',error:String(error?.message||error)}};
      }
    }else if(validation.status==='failed'){
      return {success:false,statusCode:422,error:'A proposta falhou na validação do sandbox; o workspace oficial não foi alterado.',validation,sandboxId};
    }

    let browserQuality:any=null;
    let browserRepair:any=null;
    const executeBrowserGate=async(stepId:string|null,attempt:number)=>{
      const execution=await ToolExecutionService.execute({
        userId:input.userId,
        projectId:input.projectId,
        runId:input.runId||null,
        stepId,
        sandboxId,
        signal:input.signal,
      },{
        toolKey:'browser.inspect_page',
        input:{},
        idempotencyKey:input.runId?`browser-quality:${proposal.id}:${attempt}`:null,
      });
      if(execution.status==='aborted')throw Object.assign(new Error('Browser quality cancelado.'),{name:'AbortError'});
      if(execution.status!=='succeeded'){
        return {
          id:null,
          status:'unverified',
          issues:[],
          viewports:[],
          reason:execution.errorCode||execution.message||'browser_tool_failed',
          toolExecutionId:execution.executionId||null,
        };
      }
      return {...(execution.output as any),toolExecutionId:execution.executionId};
    };

    browserQuality=await executeBrowserGate(null,0);

    if(browserQuality?.status==='failed'){
      if(!input.runId){
        return {
          success:false,statusCode:422,error:'O Browser Quality Gate encontrou falha executável no candidato; o workspace oficial não foi alterado.',
          validation,sandboxId,browserQuality,
        };
      }

      const affectedFiles=[...expectedByPath.keys()];
      const sentinelStep=RunService.createStep(input.runId,'SENTINEL','Diagnosticar falha do Browser Quality Gate',undefined,'micro',{
        sandboxId,browserQualityRunId:browserQuality.id,issues:browserQuality.issues,affectedFiles,
      });
      let sentinelDiagnostic='';
      try{
        const sentinel=await AgentEngine.execute({
          prompt:[
            'Analise somente a evidência concreta do Browser Quality Gate e descreva a causa provável e a correção mínima.',
            JSON.stringify({status:browserQuality.status,issues:browserQuality.issues,viewports:browserQuality.viewports.map((item:any)=>({
              name:item.name,title:item.title,bodyTextChars:item.bodyTextChars,horizontalOverflowPx:item.horizontalOverflowPx,
              consoleErrors:item.consoleErrors,pageErrors:item.pageErrors,failedRequests:item.failedRequests,badResponses:item.badResponses,
            }))}),
          ].join('\n\n'),
          mode:'review',
          projectId:input.projectId,
          existingFiles:SandboxManager.getAllFilesContent(sandboxId,input.userId,input.projectId),
          appliedSkills:[],
          conversationHistory:[],
          userId:input.userId,
          runId:input.runId,
          stepId:sentinelStep,
          requirementIds:reqIds,
          focusPaths:affectedFiles,
          signal:input.signal,
          skipContextSync:true,
          toolSandboxId:sandboxId,
        },{profile:'BASE_FREE',forcedAgentKey:'SENTINEL',allowExpertEscalation:true,repair:true});
        sentinelDiagnostic=String(sentinel.replyText||'').trim();
        RunService.finishStep(sentinelStep,'completed',{sandboxId,browserQualityRunId:browserQuality.id,diagnostic:sentinelDiagnostic,profileKey:sentinel.profileKey});
      }catch(error:any){
        RunService.finishStep(sentinelStep,error?.name==='AbortError'?'aborted':'failed',{sandboxId,browserQualityRunId:browserQuality.id,error:String(error?.message||error)});
        if(error?.name==='AbortError')throw error;
        sentinelDiagnostic='Diagnóstico LLM indisponível; usar evidência determinística do Browser Quality Gate.';
      }
      ContextEngineV2.recordCommit({
        projectId:input.projectId,runId:input.runId,taskId:sentinelStep,agentKey:'SENTINEL',scope:'MICRO',
        task:'Browser Quality Gate diagnostic',decisions:sentinelDiagnostic?[sentinelDiagnostic]:[],
        changedFiles:affectedFiles,requirementIds:reqIds,
        validation:{validator:validation,browserQuality},blockers:browserQuality.issues?.filter((issue:any)=>issue.severity==='error').map((issue:any)=>String(issue.message))||[],
        nextState:{next:'FORGE_BROWSER_REPAIR'},
      });

      const repairStep=RunService.createStep(input.runId,'FORGE','Corrigir falha do Browser Quality Gate',undefined,'local',{
        sandboxId,browserQualityRunId:browserQuality.id,affectedFiles,
      });
      try{
        const repair=await AgentEngine.execute({
          prompt:[
            'Corrija somente a falha concreta detectada pelo Browser Quality Gate. Não expanda o escopo.',
            sentinelDiagnostic,
            JSON.stringify({issues:browserQuality.issues}),
          ].filter(Boolean).join('\n\n'),
          mode:'build',
          projectId:input.projectId,
          existingFiles:SandboxManager.getAllFilesContent(sandboxId,input.userId,input.projectId),
          appliedSkills:[],
          conversationHistory:[],
          userId:input.userId,
          runId:input.runId,
          stepId:repairStep,
          requirementIds:reqIds,
          focusPaths:affectedFiles,
          signal:input.signal,
          skipContextSync:true,
          toolSandboxId:sandboxId,
        },{profile:'BASE_FREE',forcedAgentKey:'FORGE',allowExpertEscalation:true,repair:true});

        const repairFiles=repair.build?.files||repair.proposal?.files||[];
        if(!repairFiles.length)throw new Error('Browser repair não retornou arquivos aplicáveis.');
        for(const file of repairFiles){
          const execution=await ToolExecutionService.execute({
            userId:input.userId,projectId:input.projectId,runId:input.runId,stepId:repairStep,sandboxId,signal:input.signal,
          },{
            toolKey:file.action==='delete'?'workspace.delete_file':'workspace.write_file',
            input:file.action==='delete'?{path:file.path}:{path:file.path,content:String(file.content||'')},
            idempotencyKey:`browser-repair:${proposal.id}:${file.action}:${file.path}`,
          });
          if(execution.status!=='succeeded')throw new Error(execution.message||'Browser repair tool falhou.');
          expectedByPath.set(String(file.path),{path:String(file.path),action:String(file.action),content:file.content});
        }

        validation=await ValidatorEngine.validate({
          projectId:input.projectId,runId:input.runId,stepId:repairStep,signal:input.signal,sandboxId,userId:input.userId,
        });
        if(validation.status==='failed'){
          RequirementLedgerService.setStatusForRun(input.runId,'failed',{type:'browser_repair_validator_failed',validation,browserQuality},repairFiles.map((file:any)=>file.path));
          RunService.finishStep(repairStep,'failed',{sandboxId,validation,browserQuality});
          RunService.finish(input.runId,repairStep,'failed');
          return {
            success:false,statusCode:422,error:'O repair visual gerou falha no ValidatorEngine; o workspace oficial não foi alterado.',
            validation,sandboxId,browserQuality,repair:{attempted:true,status:'failed'},
          };
        }

        browserQuality=await executeBrowserGate(repairStep,1);
        const browserPassed=['passed','skipped'].includes(String(browserQuality?.status));
        browserRepair={attempted:true,status:browserPassed?'passed':String(browserQuality?.status||'failed'),profileKey:repair.profileKey,files:repairFiles.map((file:any)=>file.path)};
        repairSummary=repairSummary||browserRepair;

        ContextEngineV2.recordCommit({
          projectId:input.projectId,runId:input.runId,taskId:repairStep,agentKey:'FORGE',scope:'LOCAL',
          task:'Browser Quality Gate bounded repair',changedFiles:repairFiles.map((file:any)=>file.path),requirementIds:reqIds,
          validation:{validator:validation,browserQuality},blockers:browserPassed?[]:['browser_quality_failed_after_repair'],
          nextState:{status:browserPassed?'passed':browserQuality?.status||'failed'},
        });
        RunService.finishStep(repairStep,browserQuality?.status==='failed'?'failed':'completed',{sandboxId,validation,browserQuality,profileKey:repair.profileKey});

        if(browserQuality?.status==='failed'){
          RequirementLedgerService.setStatusForRun(input.runId,'failed',{type:'browser_quality_failed_after_repair',validation,browserQuality},repairFiles.map((file:any)=>file.path));
          RunService.finish(input.runId,repairStep,'failed');
          return {
            success:false,statusCode:422,error:'O Browser Quality Gate continuou falhando após um repair bounded; o workspace oficial não foi alterado.',
            validation,sandboxId,browserQuality,browserRepair,repair:browserRepair,
          };
        }
      }catch(error:any){
        RunService.finishStep(repairStep,error?.name==='AbortError'?'aborted':'failed',{sandboxId,error:String(error?.message||error),browserQuality});
        RunService.finish(input.runId,repairStep,error?.name==='AbortError'?'aborted':'failed');
        return {
          success:false,statusCode:error?.name==='AbortError'?499:422,error:'O repair do Browser Quality Gate falhou; o workspace oficial não foi alterado.',
          validation,sandboxId,browserQuality,browserRepair:{attempted:true,status:'failed',error:String(error?.message||error)},repair:{attempted:true,status:'failed',error:String(error?.message||error)},
        };
      }
    }

    const allowedChanges=canonicalMergeChanges(sandboxId,[...expectedByPath.values()]);
    try{
      SandboxManager.assertExpectedChanges(sandboxId,input.userId,input.projectId,allowedChanges,{allowExtraPaths:true});
    }catch(error:any){
      return candidateMismatchResult(error,validation,sandboxId);
    }

    let merge:any;
    try{
      merge=SandboxManager.mergeAtomic({
        sandboxId,userId:input.userId,projectId:input.projectId,title:input.summary,
        description:'Aplicação aprovada a partir do ambiente isolado.',
        allowedChanges,
      });
    }catch(error:any){
      if(error?.code==='stale_base_revision'){
        return {success:false,statusCode:409,error:'A revisão-base mudou. Atualize a proposta antes de aplicar.',validation,sandboxId,errorCode:'stale_base_revision'};
      }
      if(error?.code==='sandbox_proposal_mismatch'){
        return candidateMismatchResult(error,validation,sandboxId);
      }
      throw error;
    }

    const changedFiles=merge.changedFiles.map((item:any)=>item.path);
    const browserVerified=['passed','skipped'].includes(String(browserQuality?.status||'skipped'));
    const qualityVerified=validation.status==='passed'&&browserVerified;
    const combinedValidation={validator:validation,browserQuality};
    const alreadyInTransaction=db.isTransaction;
    try{
      if(!alreadyInTransaction)db.exec('BEGIN IMMEDIATE');
        if(input.runId){
          RequirementLedgerService.setStatusForRun(input.runId,qualityVerified?'verified':'implemented',{
            type:qualityVerified?'sandbox_merge_verified':'sandbox_merge_unverified',
            validation:combinedValidation,sandboxId,checkpointId:merge.checkpointId,
          },changedFiles);
          ContextEngineV2.recordCommit({
            projectId:input.projectId,runId:input.runId,agentKey:'SENTINEL',scope:'TASK',
            task:'Sandbox validado e merge atômico concluído',changedFiles,requirementIds:reqIds,
            validation:combinedValidation,blockers:[],nextState:{status:qualityVerified?'completed':'needs_verification'},
          });
          if(input.shipRequested&&qualityVerified){
            const ship=RunService.createStep(input.runId,'SHIP','Preparar publicação após merge validado',undefined,'task',{sandboxId,checkpointId:merge.checkpointId});
            RunService.finishStep(ship,'completed');
          }
          if(qualityVerified)RunService.setStatus(input.runId,'completed',true);
          else RunService.setStatus(input.runId,'needs_verification',true);
        }else if(input.planId){
          RequirementLedgerService.setStatusForPlan(input.projectId,input.planId,qualityVerified?'verified':'implemented',{
            type:'sandbox_merge',validation:combinedValidation,sandboxId,checkpointId:merge.checkpointId,
          },changedFiles);
        }
      if(!alreadyInTransaction)db.exec('COMMIT');
    }catch(error:any){
      if(!alreadyInTransaction&&db.isTransaction){
        try{db.exec('ROLLBACK');}catch{}
      }
      const restored=WorkspaceManager.restoreCheckpoint(input.projectId,merge.beforeCheckpointId);
      SandboxManager.markRolledBack(sandboxId,input.userId,input.projectId);
      return {
        success:false,
        statusCode:500,
        error:restored
          ? 'O merge foi revertido porque a persistência final do workflow falhou.'
          : 'A persistência final falhou após o merge e a restauração automática também falhou.',
        errorCode:restored?'post_merge_state_failed':'post_merge_rollback_failed',
        validation,
        sandboxId,
        repair:repairSummary,
      };
    }

    return {
      success:true,statusCode:200,checkpointId:merge.checkpointId,validation,sandboxId,
      changedFiles,needsVerification:!qualityVerified,merge,repair:repairSummary,browserQuality,browserRepair,
    };
  }
}
