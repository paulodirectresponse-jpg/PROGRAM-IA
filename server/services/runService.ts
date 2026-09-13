import crypto from 'node:crypto';
import {db} from '../db/index.js';
export class RunService{
  static start(userId:string,projectId:string,conversationId:string,mode:string,budget=.5){
    const now=new Date().toISOString(),runId=`run-${crypto.randomUUID()}`;
    db.prepare('INSERT INTO agent_runs(id,user_id,project_id,conversation_id,mode,status,budget_usd,created_at) VALUES(?,?,?,?,?,?,?,?)').run(runId,userId,projectId,conversationId,mode,'running',budget,now);
    const stepId=this.createStep(runId,'PROGRAM','Receber solicitação',0,'task',{mode});
    return{runId,stepId};
  }
  static createStep(runId:string,agentKey:string,title:string,orderIndex:number,scope:'micro'|'local'|'task'='task',context:unknown=null){
    const stepId=`step-${crypto.randomUUID()}`,now=new Date().toISOString();
    db.prepare('INSERT INTO agent_steps(id,run_id,agent_key,title,status,order_index,scope_level,acceptance_json,context_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(stepId,runId,agentKey,title,'running',orderIndex,scope,'[]',context?JSON.stringify(context):null,now);
    return stepId;
  }
  static assignAgent(stepId:string,agentKey:string){db.prepare('UPDATE agent_steps SET agent_key=? WHERE id=?').run(agentKey,stepId);}
  static recordAttempt(stepId:string){db.prepare('UPDATE agent_steps SET attempt_count=attempt_count+1 WHERE id=?').run(stepId);}
  static finishStep(stepId:string,status:'completed'|'failed'|'aborted'='completed',context?:unknown){
    const now=new Date().toISOString();
    if(context===undefined) db.prepare('UPDATE agent_steps SET status=?,finished_at=? WHERE id=?').run(status,now,stepId);
    else db.prepare('UPDATE agent_steps SET status=?,finished_at=?,context_json=? WHERE id=?').run(status,now,JSON.stringify(context),stepId);
  }
  static finish(runId:string,stepId:string,status:'completed'|'failed'|'aborted'){
    const now=new Date().toISOString();
    db.prepare('UPDATE agent_steps SET status=?,finished_at=? WHERE id=? AND status=\'running\'').run(status,now,stepId);
    db.prepare('UPDATE agent_steps SET status=?,finished_at=? WHERE run_id=? AND status=\'running\'').run(status,now,runId);
    db.prepare('UPDATE agent_runs SET status=?,finished_at=? WHERE id=?').run(status,now,runId);
  }
  static context(scope:'micro'|'local'|'task',x:{objective:string;acceptanceCriteria?:string[];snippets?:unknown[];diff?:unknown;errors?:unknown[];previousAttempt?:string;constraints?:string[];budgetRemaining?:number}){return{scope,objective:x.objective,acceptanceCriteria:x.acceptanceCriteria||[],relevantFilesOrSnippets:x.snippets||[],currentDiff:x.diff||null,errorEvidence:x.errors||[],previousAttemptSummary:x.previousAttempt||'',constraints:x.constraints||[],budgetRemaining:x.budgetRemaining??0};}
}
