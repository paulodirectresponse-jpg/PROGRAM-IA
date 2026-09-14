import type { FileChangeProposal } from '../services/llmAdapter.js';
import { ValidatorEngine } from '../services/validatorEngine.js';
import { SandboxManager } from './sandboxManager.js';
import { ToolExecutionService } from './toolExecutionService.js';

export class ProposalSandboxService {
  static async materialize(input:{
    userId:string;
    projectId:string;
    runId?:string|null;
    stepId?:string|null;
    proposalId:string;
    files:FileChangeProposal[];
    signal?:AbortSignal;
  }){
    const sandbox=SandboxManager.create({
      userId:input.userId,
      projectId:input.projectId,
      runId:input.runId || null,
      stepId:input.stepId || null,
    });
    const executionIds:string[]=[];
    for(const file of input.files){
      input.signal?.throwIfAborted();
      const result=await ToolExecutionService.execute({
        userId:input.userId,
        projectId:input.projectId,
        runId:input.runId || null,
        stepId:input.stepId || null,
        sandboxId:sandbox.id,
        signal:input.signal,
      },{
        toolKey:file.action==='delete'?'workspace.delete_file':'workspace.write_file',
        input:file.action==='delete'?{path:file.path}:{path:file.path,content:file.content},
        idempotencyKey:`${input.proposalId}:${file.action}:${file.path}`,
      });
      if(result.executionId)executionIds.push(result.executionId);
      if(result.status!=='succeeded'){
        throw Object.assign(new Error(result.message||'Falha ao materializar proposta no sandbox.'),{code:result.errorCode||'sandbox_materialization_failed'});
      }
    }
    const validation=await ValidatorEngine.validate({
      projectId:input.projectId,
      runId:input.runId || undefined,
      stepId:input.stepId || undefined,
      signal:input.signal,
      sandboxId:sandbox.id,
      userId:input.userId,
    });
    return {
      sandboxId:sandbox.id,
      baseRevision:sandbox.baseHash,
      changedFiles:SandboxManager.changedFiles(sandbox.id,input.userId,input.projectId),
      validation,
      toolExecutionIds:executionIds,
    };
  }
}
