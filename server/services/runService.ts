import crypto from 'node:crypto';
import {db} from '../db/index.js';
export type RunStatus='running'|'waiting_approval'|'needs_verification'|'completed'|'failed'|'aborted'|'rejected';
export type StepStatus='completed'|'failed'|'aborted'|'rejected';
export class RunService{
  static start(userId:string,projectId:string,conversationId:string,mode:string,budget=.5){
    const now=new Date().toISOString(),runId=`run-${crypto.randomUUID()}`;
    db.prepare('INSERT INTO agent_runs(id,user_id,project_id,conversation_id,mode,status,budget_usd,created_at) VALUES(?,?,?,?,?,?,?,?)').run(runId,userId,projectId,conversationId,mode,'running',budget,now);
    const stepId=this.createStep(runId,'PROGRAM','Receber solicitação',0,'task',{mode});
    return{runId,stepId};
  }
  static nextOrderIndex(runId:string){
    const row=db.prepare('SELECT COALESCE(MAX(order_index),-1)+1 next_index FROM agent_steps WHERE run_id=?').get(runId) as any;
    return Number(row?.next_index||0);
  }
  static createStep(runId:string,agentKey:string,title:string,orderIndex:number=this.nextOrderIndex(runId),scope:'micro'|'local'|'task'='task',context:unknown=null){
    const stepId=`step-${crypto.randomUUID()}`,now=new Date().toISOString();
    db.prepare('INSERT INTO agent_steps(id,run_id,agent_key,title,status,order_index,scope_level,acceptance_json,context_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(stepId,runId,agentKey,title,'running',orderIndex,scope,'[]',context?JSON.stringify(context):null,now);
    return stepId;
  }
  static assignAgent(stepId:string,agentKey:string){db.prepare('UPDATE agent_steps SET agent_key=? WHERE id=?').run(agentKey,stepId);}
  static recordAttempt(stepId:string){db.prepare('UPDATE agent_steps SET attempt_count=attempt_count+1 WHERE id=?').run(stepId);}
  static finishStep(stepId:string,status:StepStatus='completed',context?:unknown){
    const now=new Date().toISOString();
    if(context===undefined) db.prepare('UPDATE agent_steps SET status=?,finished_at=? WHERE id=?').run(status,now,stepId);
    else db.prepare('UPDATE agent_steps SET status=?,finished_at=?,context_json=? WHERE id=?').run(status,now,JSON.stringify(context),stepId);
  }
  static setStatus(runId:string,status:RunStatus,finish=false){
    const now=new Date().toISOString();
    if(finish) db.prepare('UPDATE agent_runs SET status=?,finished_at=? WHERE id=?').run(status,now,runId);
    else db.prepare('UPDATE agent_runs SET status=?,finished_at=NULL WHERE id=?').run(status,runId);
  }
  static closeDanglingSteps(runId:string,status:StepStatus='aborted'){
    const now=new Date().toISOString();
    db.prepare("UPDATE agent_steps SET status=?,finished_at=? WHERE run_id=? AND status='running'").run(status,now,runId);
  }
  static waitForApproval(runId:string){
    // A run cannot be waiting for approval while an old step remains "running".
    this.closeDanglingSteps(runId,'aborted');
    this.setStatus(runId,'waiting_approval',false);
  }
  static resume(runId:string){
    // Resume always starts a fresh step. Any unfinished prior step is historical
    // evidence, not an active worker.
    this.closeDanglingSteps(runId,'aborted');
    this.setStatus(runId,'running',false);
  }
  static finish(runId:string,stepId:string,status:RunStatus){
    const now=new Date().toISOString();
    const stepStatus:StepStatus=status==='rejected'?'rejected':status==='completed'?'completed':status==='aborted'?'aborted':'failed';
    if(stepId) db.prepare('UPDATE agent_steps SET status=?,finished_at=? WHERE id=? AND status=\'running\'').run(stepStatus,now,stepId);
    db.prepare('UPDATE agent_steps SET status=?,finished_at=? WHERE run_id=? AND status=\'running\'').run(stepStatus,now,runId);
    db.prepare('UPDATE agent_runs SET status=?,finished_at=? WHERE id=?').run(status,now,runId);
  }
  static trace(runId:string){
    const steps=db.prepare(`SELECT id,agent_key,title,status,order_index,scope_level,attempt_count,context_json,created_at,finished_at
      FROM agent_steps WHERE run_id=? ORDER BY order_index ASC, created_at ASC`).all(runId) as any[];
    const invocations=db.prepare(`SELECT id,step_id,agent_key,profile_key,provider_key,model_id,status,error_code,retry_index,latency_ms,cost_usd,created_at
      FROM model_invocations WHERE run_id=? ORDER BY created_at ASC`).all(runId) as any[];
    return steps.map(step=>({
      ...step,
      context:(()=>{try{return step.context_json?JSON.parse(step.context_json):null;}catch{return null;}})(),
      invocations:invocations.filter(inv=>inv.step_id===step.id),
    }));
  }
  static context(scope:'micro'|'local'|'task',x:{objective:string;acceptanceCriteria?:string[];snippets?:unknown[];diff?:unknown;errors?:unknown[];previousAttempt?:string;constraints?:string[];budgetRemaining?:number}){return{scope,objective:x.objective,acceptanceCriteria:x.acceptanceCriteria||[],relevantFilesOrSnippets:x.snippets||[],currentDiff:x.diff||null,errorEvidence:x.errors||[],previousAttemptSummary:x.previousAttempt||'',constraints:x.constraints||[],budgetRemaining:x.budgetRemaining??0};}
}
