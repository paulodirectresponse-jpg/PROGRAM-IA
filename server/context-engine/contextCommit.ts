import crypto from 'node:crypto';
import { db } from '../db/index.js';
import type { ContextCommitInput, ContextCommitRecord, ContextScope } from './types.js';

function parse(row: any): ContextCommitRecord {
  return {
    id: row.id, projectId:row.project_id, runId:row.run_id, taskId:row.task_id, agentKey:row.agent_key,
    scope:(row.scope || 'TASK') as ContextScope, task:row.task,
    decisions:JSON.parse(row.decisions_json || '[]'),
    changedFiles:JSON.parse(row.changed_files_json || '[]'),
    requirementIds:JSON.parse(row.requirement_ids_json || '[]'),
    validation:JSON.parse(row.validation_json || 'null'),
    blockers:JSON.parse(row.blockers_json || '[]'),
    nextState:JSON.parse(row.next_state_json || 'null'),
    createdAt:row.created_at,
  };
}

export class ContextCommitService {
  static create(input: ContextCommitInput): ContextCommitRecord {
    const record: ContextCommitRecord = {
      ...input,
      id:`ctx-commit-${crypto.randomUUID()}`,
      runId:input.runId || null, taskId:input.taskId || null, agentKey:input.agentKey || null,
      scope:input.scope || 'TASK', decisions:input.decisions || [], changedFiles:input.changedFiles || [],
      requirementIds:input.requirementIds || [], validation:input.validation ?? null,
      blockers:input.blockers || [], nextState:input.nextState ?? null, createdAt:new Date().toISOString(),
    };
    db.prepare(`INSERT INTO context_commits(
      id,project_id,run_id,task_id,agent_key,scope,task,decisions_json,changed_files_json,
      requirement_ids_json,validation_json,blockers_json,next_state_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      record.id,record.projectId,record.runId,record.taskId,record.agentKey,record.scope,record.task,
      JSON.stringify(record.decisions),JSON.stringify(record.changedFiles),JSON.stringify(record.requirementIds),
      JSON.stringify(record.validation),JSON.stringify(record.blockers),JSON.stringify(record.nextState),record.createdAt
    );
    return record;
  }

  static listRecent(projectId: string, limit = 50): ContextCommitRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    return (db.prepare('SELECT * FROM context_commits WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?').all(projectId,safeLimit) as any[]).map(parse);
  }

  static listByRun(runId: string): ContextCommitRecord[] {
    return (db.prepare('SELECT * FROM context_commits WHERE run_id=? ORDER BY created_at,rowid').all(runId) as any[]).map(parse);
  }

  static clear(projectId: string) {
    db.prepare('DELETE FROM context_commits WHERE project_id=?').run(projectId);
  }
}
