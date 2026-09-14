import { db } from '../db/index.js';
import { SandboxManager } from './sandboxManager.js';
import { ToolExecutionJournal } from './toolExecutionJournal.js';

export class Phase2RecoveryService {
  static recoverStartup() {
    const interruptedTools=ToolExecutionJournal.markAllRunningInterrupted();
    const sandboxes=SandboxManager.recoverInterrupted();
    const affectedRuns=db.prepare("SELECT DISTINCT run_id FROM tool_executions WHERE status='interrupted' AND run_id IS NOT NULL").all() as Array<{run_id:string}>;
    for(const row of affectedRuns){
      const run=db.prepare('SELECT status FROM agent_runs WHERE id=?').get(row.run_id) as {status?:string}|undefined;
      if(run?.status==='running'){
        db.prepare("UPDATE agent_runs SET status='failed',finished_at=? WHERE id=?").run(new Date().toISOString(),row.run_id);
        db.prepare("UPDATE agent_steps SET status='aborted',finished_at=? WHERE run_id=? AND status='running'")
          .run(new Date().toISOString(),row.run_id);
      }
    }
    return {interruptedTools,sandboxes,affectedRuns:affectedRuns.length};
  }
}
