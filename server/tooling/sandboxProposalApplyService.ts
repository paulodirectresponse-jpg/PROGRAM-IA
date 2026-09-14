import { AgentEngine } from '../agent-engine/agentEngine.js';
import { ContextEngineV2 } from '../context-engine/contextEngine.js';
import { RequirementLedgerService } from '../services/requirementLedgerService.js';
import { RunService } from '../services/runService.js';
import { ValidatorEngine } from '../services/validatorEngine.js';
import { ProposalSandboxService } from './proposalSandboxService.js';
import { SandboxManager } from './sandboxManager.js';
import { ToolExecutionService } from './toolExecutionService.js';

function requirementIds(projectId:string,runId?:string|null,planId?:string|null){
  const rows=runId?RequirementLedgerService.listByRun(runId):(planId?RequirementLedgerService.listByPlan(projectId,planId):[]);
  return rows.map(row=>row.requirement_key).filter(Boolean);
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
  }){
    const proposal=input.proposal;
    if(!proposal?.id||!Array.isArray(proposal.files)||!proposal.files.length){
      return {success:false,statusCode:409,error:'Proposta vazia ou inválida.'};
    }

    if(!proposal.sandboxId){
      const materialized=await ProposalSandboxService.materialize({
        userId:input.userId,projectId:input.projectId,runId:input.runId||null,stepId:null,
        proposalId:proposal.id,files:proposal.files,signal:input.signal,
      });
      proposal.sandboxId=materialized.sandboxId;
      proposal.baseRevision=materialized.baseRevision;
      proposal.sandboxValidation=materialized.validation;
      proposal.toolExecutionIds=materialized.toolExecutionIds;
    }

    const sandboxId=String(proposal.sandboxId);
    const reqIds=requirementIds(input.projectId,input.runId,input.planId);
    let validation=await ValidatorEngine.validate({
      projectId:input.projectId,runId:input.runId||undefined,signal:input.signal,
      sandboxId,userId:input.userId,
    });

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

      const repairStep=RunService.createStep(input.runId,'FORGE','Corrigir falha no sandbox',undefined,'local',{
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
        }
        validation=await ValidatorEngine.validate({
          projectId:input.projectId,runId:input.runId,stepId:repairStep,signal:input.signal,
          sandboxId,userId:input.userId,
        });
        ContextEngineV2.recordCommit({
          projectId:input.projectId,runId:input.runId,taskId:repairStep,agentKey:'FORGE',scope:'LOCAL',
          task:'Repair bounded no sandbox',changedFiles:repairFiles.map((file:any)=>file.path),requirementIds:reqIds,
          validation,blockers:validation.status==='failed'?['repair_validation_failed']:[],nextState:{status:validation.status},
        });
        RunService.finishStep(repairStep,validation.status==='failed'?'failed':'completed',{sandboxId,validation,profileKey:repair.profileKey});
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

    let merge:any;
    try{
      merge=SandboxManager.mergeAtomic({
        sandboxId,userId:input.userId,projectId:input.projectId,title:input.summary,
        description:'Aplicação aprovada a partir do ambiente isolado.',
      });
    }catch(error:any){
      if(error?.code==='stale_base_revision'){
        return {success:false,statusCode:409,error:'A revisão-base mudou. Atualize a proposta antes de aplicar.',validation,sandboxId,errorCode:'stale_base_revision'};
      }
      throw error;
    }

    const changedFiles=merge.changedFiles.map((item:any)=>item.path);
    if(input.runId){
      RequirementLedgerService.setStatusForRun(input.runId,validation.status==='passed'?'verified':'implemented',{
        type:validation.status==='passed'?'sandbox_merge_verified':'sandbox_merge_unverified',
        validation,sandboxId,checkpointId:merge.checkpointId,
      },changedFiles);
      ContextEngineV2.recordCommit({
        projectId:input.projectId,runId:input.runId,agentKey:'SENTINEL',scope:'TASK',
        task:'Sandbox validado e merge atômico concluído',changedFiles,requirementIds:reqIds,
        validation,blockers:[],nextState:{status:validation.status==='passed'?'completed':'needs_verification'},
      });
      if(input.shipRequested&&validation.status==='passed'){
        const ship=RunService.createStep(input.runId,'SHIP','Preparar publicação após merge validado',undefined,'task',{sandboxId,checkpointId:merge.checkpointId});
        RunService.finishStep(ship,'completed');
      }
      if(validation.status==='passed')RunService.setStatus(input.runId,'completed',true);
      else RunService.setStatus(input.runId,'needs_verification',true);
    }else if(input.planId){
      RequirementLedgerService.setStatusForPlan(input.projectId,input.planId,validation.status==='passed'?'verified':'implemented',{
        type:'sandbox_merge',validation,sandboxId,checkpointId:merge.checkpointId,
      },changedFiles);
    }

    return {
      success:true,statusCode:200,checkpointId:merge.checkpointId,validation,sandboxId,
      changedFiles,needsVerification:validation.status!=='passed',merge,
    };
  }
}
