import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db, initializeDatabase } from '../server/db/index.js';
import { WorkspaceManager } from '../server/services/workspaceManager.js';
import { ToolRegistry } from '../server/tooling/toolRegistry.js';
import { ToolExecutionService } from '../server/tooling/toolExecutionService.js';
import { ToolExecutionJournal } from '../server/tooling/toolExecutionJournal.js';
import { SandboxManager } from '../server/tooling/sandboxManager.js';
import { SandboxProposalApplyService } from '../server/tooling/sandboxProposalApplyService.js';
import { ProjectFileIndex } from '../server/context-engine/projectFileIndex.js';

initializeDatabase();

function setupProject() {
  const suffix=`${Date.now()}-${crypto.randomUUID()}`;
  const userId=`phase2-user-${suffix}`;
  const workspaceId=`phase2-ws-${suffix}`;
  const projectId=`phase2-project-${suffix}`;
  const now=new Date().toISOString();
  db.prepare("INSERT INTO users(id,email,name,role,created_at) VALUES(?,?,?,'developer',?)")
    .run(userId,`${userId}@example.test`,'Phase 2 User',now);
  db.prepare('INSERT INTO workspaces(id,user_id,name,root_path,created_at) VALUES(?,?,?,?,?)')
    .run(workspaceId,userId,'Phase 2 Workspace',`/tmp/${workspaceId}`,now);
  db.prepare("INSERT INTO projects(id,user_id,workspace_id,name,origin,created_at,updated_at) VALUES(?,?,?,'Phase 2 Project','novo',?,?)")
    .run(projectId,userId,workspaceId,now,now);
  return {userId,workspaceId,projectId};
}

function cleanup(input:{userId:string;workspaceId:string;projectId:string}) {
  const sandboxes=db.prepare('SELECT id FROM sandboxes WHERE project_id=?').all(input.projectId) as Array<{id:string}>;
  for(const sandbox of sandboxes) SandboxManager.cleanup(sandbox.id,input.userId);
  WorkspaceManager.deleteProject(input.projectId);
  db.prepare('DELETE FROM sandboxes WHERE project_id=?').run(input.projectId);
  db.prepare('DELETE FROM tool_executions WHERE project_id=?').run(input.projectId);
  db.prepare('DELETE FROM projects WHERE id=?').run(input.projectId);
  db.prepare('DELETE FROM workspaces WHERE id=?').run(input.workspaceId);
  db.prepare('DELETE FROM users WHERE id=?').run(input.userId);
}

test('phase2 registry separates ready read tools from sandbox-required mutation tools', () => {
  const tools=ToolRegistry.list();
  assert.ok(tools.some(tool=>tool.key==='workspace.list_tree'&&tool.availability==='ready'&&tool.risk==='read'));
  assert.ok(tools.some(tool=>tool.key==='workspace.read_file'&&tool.availability==='ready'&&tool.resumePolicy==='replay_safe'));
  assert.ok(tools.some(tool=>tool.key==='workspace.search_text'&&tool.availability==='ready'));
  assert.ok(tools.some(tool=>tool.key==='workspace.write_file'&&tool.availability==='requires_sandbox'&&tool.risk==='write'));
  assert.ok(tools.some(tool=>tool.key==='workspace.apply_patch'&&tool.availability==='requires_sandbox'));
  assert.ok(tools.some(tool=>tool.key==='process.run'&&tool.availability==='requires_sandbox'&&tool.risk==='process'));
  assert.deepEqual(ToolRegistry.validate('workspace.read_file',{}),['path:required']);
  assert.deepEqual(ToolRegistry.validate('unknown.tool',{}),['tool_unknown']);
});

test('phase2 read tools execute against owned workspace and persist compact journal evidence', async () => {
  const env=setupProject();
  try {
    WorkspaceManager.writeFile(env.projectId,'src/a.ts',"export const alpha='needle';\n");
    WorkspaceManager.writeFile(env.projectId,'src/b.ts',"export const beta='needle';\n");

    const list=await ToolExecutionService.execute(
      {userId:env.userId,projectId:env.projectId,runId:'run-phase2',stepId:'step-phase2'},
      {toolKey:'workspace.list_tree',input:{pathPrefix:'src/'}}
    );
    assert.equal(list.status,'succeeded');
    assert.equal((list.output as any).files.length,2);

    const read=await ToolExecutionService.execute(
      {userId:env.userId,projectId:env.projectId,runId:'run-phase2',stepId:'step-phase2'},
      {toolKey:'workspace.read_file',input:{path:'src/a.ts',start:0,end:6}}
    );
    assert.equal(read.status,'succeeded');
    assert.equal((read.output as any).content,'export');

    const search=await ToolExecutionService.execute(
      {userId:env.userId,projectId:env.projectId,runId:'run-phase2',stepId:'step-phase2'},
      {toolKey:'workspace.search_text',input:{query:'needle'}}
    );
    assert.equal(search.status,'succeeded');
    assert.equal((search.output as any).matches.length,2);

    const rows=ToolExecutionJournal.listByRun('run-phase2');
    assert.equal(rows.length,3);
    assert.ok(rows.every(row=>row.status==='succeeded'));
    assert.ok(rows.every(row=>row.projectId===env.projectId));
    assert.ok(rows.every(row=>row.requestHash&&row.requestHash.length===64));
    const raw=db.prepare("SELECT summary_json FROM tool_executions WHERE run_id='run-phase2'").all() as any[];
    assert.ok(raw.every(row=>!String(row.summary_json).includes("export const alpha")));
  } finally { cleanup(env); }
});

test('phase2 blocks sensitive reads and mutation/process tools instead of pretending execution', async () => {
  const env=setupProject();
  try {
    WorkspaceManager.writeFile(env.projectId,'.env','SECRET_TOKEN=do-not-read');
    WorkspaceManager.writeFile(env.projectId,'src/a.ts','export const a=1');

    const secret=await ToolExecutionService.execute(
      {userId:env.userId,projectId:env.projectId,runId:'run-phase2-blocked'},
      {toolKey:'workspace.read_file',input:{path:'.env'}}
    );
    assert.equal(secret.status,'blocked');
    assert.equal(secret.errorCode,'sensitive_path');
    assert.equal(JSON.stringify(ToolExecutionJournal.get(secret.executionId)?.summary).includes('do-not-read'),false);

    const before=WorkspaceManager.readFile(env.projectId,'src/a.ts');
    const write=await ToolExecutionService.execute(
      {userId:env.userId,projectId:env.projectId,runId:'run-phase2-blocked'},
      {toolKey:'workspace.write_file',input:{path:'src/a.ts',content:'export const changed=1'}}
    );
    assert.equal(write.status,'blocked');
    assert.equal(write.errorCode,'sandbox_required');
    assert.equal(WorkspaceManager.readFile(env.projectId,'src/a.ts'),before);

    const process=await ToolExecutionService.execute(
      {userId:env.userId,projectId:env.projectId,runId:'run-phase2-blocked'},
      {toolKey:'process.run',input:{script:'test'}}
    );
    assert.equal(process.status,'blocked');
    assert.equal(process.errorCode,'sandbox_required');
  } finally { cleanup(env); }
});

test('phase2 journal exposes recoverable execution state without replaying side effects', () => {
  const env=setupProject();
  try {
    const definition=ToolRegistry.get('workspace.list_tree');
    assert.ok(definition);
    const running=ToolExecutionJournal.start({
      context:{userId:env.userId,projectId:env.projectId,runId:'run-phase2-recovery',stepId:'step-recovery'},
      definition:definition!,
      requestInput:{pathPrefix:'src/'},
      idempotencyKey:'list-tree-1',
    });
    const recoverable=ToolExecutionJournal.recoverable('run-phase2-recovery');
    assert.equal(recoverable.length,1);
    assert.equal(recoverable[0].resumePolicy,'replay_safe');
    const interrupted=ToolExecutionJournal.markInterrupted(running.id);
    assert.equal(interrupted?.status,'interrupted');
    assert.equal(interrupted?.errorCode,'worker_interrupted');
  } finally { cleanup(env); }
});

test('phase2 database exposes durable tool journal columns and migration', () => {
  const cols=new Set((db.prepare('PRAGMA table_info(tool_executions)').all() as any[]).map(row=>row.name));
  for(const name of ['project_id','tool_version','error_code','attempt_index','idempotency_key','request_hash','resume_policy','started_at','finished_at']) {
    assert.ok(cols.has(name),`missing ${name}`);
  }
  const migration=db.prepare('SELECT name FROM schema_migrations WHERE version=5').get() as any;
  assert.equal(migration?.name,'005_tool_execution_journal_foundation');
});


test('phase2 sandbox write stays isolated until merge', async () => {
  const env=setupProject();
  try {
    WorkspaceManager.writeFile(env.projectId,'src/a.ts','export const a=1');
    const sandbox=SandboxManager.create({userId:env.userId,projectId:env.projectId,runId:'run-sandbox',stepId:'step-sandbox'});
    const write=await ToolExecutionService.execute(
      {userId:env.userId,projectId:env.projectId,runId:'run-sandbox',stepId:'step-sandbox',sandboxId:sandbox.id},
      {toolKey:'workspace.write_file',input:{path:'src/a.ts',content:'export const a=2'},idempotencyKey:'write-a'}
    );
    assert.equal(write.status,'succeeded');
    assert.equal(WorkspaceManager.readFile(env.projectId,'src/a.ts'),'export const a=1');
    assert.equal(SandboxManager.readFile(sandbox.id,env.userId,'src/a.ts',env.projectId),'export const a=2');
    const merge=SandboxManager.mergeAtomic({sandboxId:sandbox.id,userId:env.userId,projectId:env.projectId,title:'merge test'});
    assert.equal(WorkspaceManager.readFile(env.projectId,'src/a.ts'),'export const a=2');
    assert.ok(merge.checkpointId);
    assert.ok(ProjectFileIndex.get(env.projectId,'src/a.ts'));
  } finally { cleanup(env); }
});


test('phase2 sensitive project files are not exposed to sandbox tools and survive merge', async () => {
  const env=setupProject();
  try {
    WorkspaceManager.writeFile(env.projectId,'.env','PRIVATE_TOKEN=keep-me');
    WorkspaceManager.writeFile(env.projectId,'src/a.ts','export const a=1');
    const sandbox=SandboxManager.create({userId:env.userId,projectId:env.projectId,runId:'run-secret'});
    assert.equal(SandboxManager.readFile(sandbox.id,env.userId,'.env',env.projectId),null);
    await ToolExecutionService.execute(
      {userId:env.userId,projectId:env.projectId,runId:'run-secret',sandboxId:sandbox.id},
      {toolKey:'workspace.write_file',input:{path:'src/a.ts',content:'export const a=3'},idempotencyKey:'secret-safe-write'}
    );
    SandboxManager.mergeAtomic({sandboxId:sandbox.id,userId:env.userId,projectId:env.projectId,title:'secret preserving merge'});
    assert.equal(WorkspaceManager.readFile(env.projectId,'.env'),'PRIVATE_TOKEN=keep-me');
  } finally { cleanup(env); }
});
