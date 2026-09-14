import crypto from 'node:crypto';
import { db } from '../db/index.js';
import type { ToolDefinition, ToolExecutionContext, ToolExecutionRecord, ToolExecutionStatus } from './types.js';

function parseJson(value: unknown) {
  try { return typeof value === 'string' ? JSON.parse(value) : value || {}; }
  catch { return {}; }
}

function hydrate(row:any): ToolExecutionRecord {
  return {
    id:row.id,
    projectId:row.project_id || null,
    runId:row.run_id || null,
    stepId:row.step_id || null,
    sandboxId:row.sandbox_id || null,
    toolKey:row.tool_key,
    toolVersion:row.tool_version || '1',
    status:row.status,
    durationMs:Number(row.duration_ms || 0),
    errorCode:row.error_code || null,
    attemptIndex:Number(row.attempt_index || 0),
    idempotencyKey:row.idempotency_key || null,
    requestHash:row.request_hash || null,
    resumePolicy:row.resume_policy || 'inspect_only',
    summary:parseJson(row.summary_json),
    createdAt:row.created_at,
    startedAt:row.started_at || null,
    finishedAt:row.finished_at || null,
  };
}

export class ToolExecutionJournal {
  static requestHash(toolKey:string,input:Record<string,unknown>) {
    return crypto.createHash('sha256').update(JSON.stringify({toolKey,input})).digest('hex');
  }

  static start(input:{
    context:ToolExecutionContext;
    definition:ToolDefinition;
    requestInput:Record<string,unknown>;
    idempotencyKey?:string|null;
    attemptIndex?:number;
  }) {
    const id=`tool-exec-${crypto.randomUUID()}`;
    const now=new Date().toISOString();
    db.prepare(`INSERT INTO tool_executions(
      id,run_id,step_id,tool_key,status,duration_ms,summary_json,created_at,
      project_id,tool_version,error_code,attempt_index,idempotency_key,request_hash,resume_policy,started_at,finished_at,sandbox_id
    ) VALUES(?,?,?,?,?,0,'{}',?,?,?,?,?,?,?,?,?,NULL,?)`).run(
      id,input.context.runId || null,input.context.stepId || null,input.definition.key,'running',now,
      input.context.projectId,input.definition.version,null,Math.max(0,Number(input.attemptIndex || 0)),
      input.idempotencyKey || null,this.requestHash(input.definition.key,input.requestInput),input.definition.resumePolicy,now,
      input.context.sandboxId || null
    );
    return this.get(id)!;
  }

  static finish(id:string,status:ToolExecutionStatus,summary:Record<string,unknown>={},errorCode?:string|null,durationMs=0) {
    const now=new Date().toISOString();
    db.prepare('UPDATE tool_executions SET status=?,duration_ms=?,summary_json=?,error_code=?,finished_at=? WHERE id=?')
      .run(status,Math.max(0,Math.floor(durationMs)),JSON.stringify(summary),errorCode || null,now,id);
    return this.get(id);
  }

  static get(id:string) {
    const row=db.prepare('SELECT * FROM tool_executions WHERE id=?').get(id) as any;
    return row ? hydrate(row) : null;
  }

  static findByIdempotency(runId:string,idempotencyKey:string) {
    const row=db.prepare('SELECT * FROM tool_executions WHERE run_id=? AND idempotency_key=? ORDER BY created_at DESC LIMIT 1')
      .get(runId,idempotencyKey) as any;
    return row ? hydrate(row) : null;
  }

  static listByRun(runId:string) {
    return (db.prepare('SELECT * FROM tool_executions WHERE run_id=? ORDER BY created_at ASC').all(runId) as any[]).map(hydrate);
  }

  static recoverable(runId:string) {
    return (db.prepare("SELECT * FROM tool_executions WHERE run_id=? AND status IN ('queued','running','interrupted') ORDER BY created_at ASC").all(runId) as any[]).map(hydrate);
  }

  static markInterrupted(id:string) {
    const current=this.get(id);
    if (!current || !['queued','running'].includes(current.status)) return current;
    return this.finish(id,'interrupted',{reason:'worker_interrupted'},'worker_interrupted',current.durationMs);
  }

  static markAllRunningInterrupted() {
    const rows=db.prepare("SELECT id FROM tool_executions WHERE status IN ('queued','running')").all() as Array<{id:string}>;
    for(const row of rows)this.markInterrupted(row.id);
    return rows.length;
  }
}
