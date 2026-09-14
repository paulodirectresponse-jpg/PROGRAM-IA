import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { db, initializeDatabase } from '../server/db/index.js';
import { WorkspaceManager } from '../server/services/workspaceManager.js';
import { ToolRegistry } from '../server/tooling/toolRegistry.js';
import { ToolExecutionService } from '../server/tooling/toolExecutionService.js';
import { ToolExecutionJournal } from '../server/tooling/toolExecutionJournal.js';
import { SandboxManager } from '../server/tooling/sandboxManager.js';
import { SandboxProposalApplyService } from '../server/tooling/sandboxProposalApplyService.js';
import { ProjectFileIndex } from '../server/context-engine/projectFileIndex.js';
import { AgentEngine, AgentWorkflowEngine } from '../server/agent-engine/agentEngine.js';
import { LLMAdapterService } from '../server/services/llmAdapter.js';
import { RunService } from '../server/services/runService.js';

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

function seedAgentModel(userId:string) {
  const now=new Date().toISOString();
  const providerKey='mock-tools';
  db.prepare('INSERT OR REPLACE INTO providers(id,user_id,provider_key,name,base_url,model_id,is_configured,is_active,connection_status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(`provider-${userId}`,userId,providerKey,'Mock Tools','https://mock.invalid/v1','mock-model',1,1,'connected',now);
  const profileId=`profile-${userId}`;
  db.prepare('INSERT OR REPLACE INTO model_profiles(id,user_id,profile_key,level,max_attempts,max_cost_usd,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(profileId,userId,'BASE_FREE',1,1,0.05,1,now,now);
  db.prepare('INSERT OR REPLACE INTO model_candidates(id,profile_id,provider_key,model_id,priority,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(`candidate-${userId}`,profileId,providerKey,'mock-model',0,1,now,now);
}

function cleanup(input:{userId:string;workspaceId:string;projectId:string}) {
  const sandboxes=db.prepare('SELECT id FROM sandboxes WHERE project_id=?').all(input.projectId) as Array<{id:string}>;
  for(const sandbox of sandboxes) SandboxManager.cleanup(sandbox.id,input.userId);
  WorkspaceManager.deleteProject(input.projectId);
  db.prepare('DELETE FROM sandboxes WHERE project_id=?').run(input.projectId);
  db.prepare('DELETE FROM tool_executions WHERE project_id=?').run(input.projectId);
  db.prepare('DELETE FROM projects WHERE id=?').run(input.projectId);
  db.prepare('DELETE FROM model_candidates WHERE profile_id IN (SELECT id FROM model_profiles WHERE user_id=?)').run(input.userId);
  db.prepare('DELETE FROM model_profiles WHERE user_id=?').run(input.userId);
  db.prepare('DELETE FROM providers WHERE user_id=?').run(input.userId);
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
    const merge=SandboxManager.mergeAtomic({sandboxId:sandbox.id,userId:env.userId,projectId:env.projectId,title:'merge test',allowedChanges:[{path:'src/a.ts',action:'modify',content:'export const a=2'}]});
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
    SandboxManager.mergeAtomic({sandboxId:sandbox.id,userId:env.userId,projectId:env.projectId,title:'secret preserving merge',allowedChanges:[{path:'src/a.ts',action:'modify',content:'export const a=3'}]});
    assert.equal(WorkspaceManager.readFile(env.projectId,'.env'),'PRIVATE_TOKEN=keep-me');
  } finally { cleanup(env); }
});


test('phase2 patch tool is deterministic and idempotency prevents repeated side effects', async () => {
  const env=setupProject();
  try {
    WorkspaceManager.writeFile(env.projectId,'src/a.ts','const value = 1;');
    const sandbox=SandboxManager.create({userId:env.userId,projectId:env.projectId,runId:'run-patch',stepId:'step-patch'});
    const request={
      toolKey:'workspace.apply_patch',
      input:{patch:JSON.stringify({path:'src/a.ts',search:'value = 1',replace:'value = 2'})},
      idempotencyKey:'patch-once',
    };
    const first=await ToolExecutionService.execute(
      {userId:env.userId,projectId:env.projectId,runId:'run-patch',stepId:'step-patch',sandboxId:sandbox.id},
      request
    );
    assert.equal(first.status,'succeeded');
    const second=await ToolExecutionService.execute(
      {userId:env.userId,projectId:env.projectId,runId:'run-patch',stepId:'step-patch',sandboxId:sandbox.id},
      request
    );
    assert.equal(second.executionId,first.executionId);
    assert.equal(SandboxManager.readFile(sandbox.id,env.userId,'src/a.ts',env.projectId),'const value = 2;');
    assert.equal(WorkspaceManager.readFile(env.projectId,'src/a.ts'),'const value = 1;');
    assert.equal((db.prepare("SELECT COUNT(*) c FROM tool_executions WHERE run_id='run-patch' AND idempotency_key='patch-once'").get() as any).c,1);
  } finally { cleanup(env); }
});


test('phase2 process tool runs declared npm script with sandbox cwd', async () => {
  const env=setupProject();
  try {
    WorkspaceManager.writeFile(env.projectId,'package.json',JSON.stringify({scripts:{where:'node -e "console.log(process.cwd())"'}}));
    const sandbox=SandboxManager.create({userId:env.userId,projectId:env.projectId,runId:'run-process',stepId:'step-process'});
    const result=await ToolExecutionService.execute(
      {userId:env.userId,projectId:env.projectId,runId:'run-process',stepId:'step-process',sandboxId:sandbox.id},
      {toolKey:'process.run',input:{script:'where',timeoutMs:10000},idempotencyKey:'where-once'}
    );
    assert.equal(result.status,'succeeded');
    assert.ok(String((result.output as any).output).includes(sandbox.rootPath));
    assert.equal(String((result.output as any).output).includes(WorkspaceManager.getProjectDir(env.projectId)),false);
    const row=ToolExecutionJournal.get(result.executionId);
    assert.equal(row?.sandboxId,sandbox.id);
  } finally { cleanup(env); }
});


test('phase2 sandbox detects stale official revision before merge', async () => {
  const env=setupProject();
  try {
    WorkspaceManager.writeFile(env.projectId,'src/a.ts','export const a=1');
    const sandbox=SandboxManager.create({userId:env.userId,projectId:env.projectId,runId:'run-stale'});
    await ToolExecutionService.execute(
      {userId:env.userId,projectId:env.projectId,runId:'run-stale',sandboxId:sandbox.id},
      {toolKey:'workspace.write_file',input:{path:'src/a.ts',content:'export const a=2'},idempotencyKey:'stale-write'}
    );
    WorkspaceManager.writeFile(env.projectId,'src/other.ts','export const other=1');
    assert.equal(SandboxManager.baseMatches(sandbox.id,env.userId,env.projectId),false);
    let code='';
    try { SandboxManager.mergeAtomic({sandboxId:sandbox.id,userId:env.userId,projectId:env.projectId,title:'stale',allowedChanges:[{path:'src/a.ts',action:'modify',content:'export const a=2'}]}); }
    catch(error:any){ code=String(error?.code||''); }
    assert.equal(code,'stale_base_revision');
    assert.equal(WorkspaceManager.readFile(env.projectId,'src/a.ts'),'export const a=1');
  } finally { cleanup(env); }
});


test('phase2 provider can request bounded read tools before final answer', async (t) => {
  const env=setupProject();
  seedAgentModel(env.userId);
  const run=RunService.start(env.userId,env.projectId,'conv-phase2-tools','build');
  WorkspaceManager.writeFile(env.projectId,'src/a.ts','export const inspected=42;');
  const seen:any[]=[];
  let calls=0;
  t.mock.method(LLMAdapterService,'getProviderConfig',()=>({key:'mock-tools',type:'openai_compatible',apiKey:'x',baseUrl:'https://mock.invalid/v1',modelId:'mock-model',name:'Mock Tools',isConfigured:true} as any));
  t.mock.method(LLMAdapterService,'executePrompt',async(options:any)=>{
    seen.push(options);
    calls++;
    if(calls===1){
      return {
        replyText:JSON.stringify({type:'tool_request',calls:[{tool:'workspace.read_file',input:{path:'src/a.ts'}}]}),
        mode:'build',decisionType:'invalid_response',isDemonstrativeFallback:false,providerUsed:'Mock Tools',modelUsed:'mock-model',
        hasErrors:true,invalidResponse:true,errorReason:'tool_request',usage:{inputTokens:2,outputTokens:1,billedCostUsd:0.001},
      } as any;
    }
    return {
      replyText:'done',mode:'build',decisionType:'change',isDemonstrativeFallback:false,providerUsed:'Mock Tools',modelUsed:'mock-model',
      hasErrors:false,build:{summary:'done',explanation:'done',files:[{path:'src/a.ts',action:'modify',content:'export const inspected=43;'}]},
      usage:{inputTokens:3,outputTokens:2,billedCostUsd:0.002},
    } as any;
  });
  try {
    const result=await AgentEngine.execute({
      prompt:'Inspect and update a',mode:'build',projectId:env.projectId,existingFiles:WorkspaceManager.getAllFilesContent(env.projectId),
      appliedSkills:[],conversationHistory:[],userId:env.userId,runId:run.runId,stepId:run.stepId,focusPaths:['src/a.ts'],
    },{profile:'BASE_FREE',forcedAgentKey:'FORGE'});
    assert.equal(result.hasErrors,false);
    assert.equal(calls,2);
    assert.ok(String(seen[1].prompt).includes('TOOL RESULTS'));
    assert.ok(String(seen[1].prompt).includes('inspected'));
    const tools=ToolExecutionJournal.listByRun(run.runId);
    assert.equal(tools.filter(row=>row.toolKey==='workspace.read_file').length,1);
    assert.equal(result.usage?.inputTokens,5);
    assert.equal(result.diagnostics?.toolExecutions,1);
  } finally {
    db.prepare('DELETE FROM model_invocations WHERE run_id=?').run(run.runId);
    db.prepare('DELETE FROM agent_steps WHERE run_id=?').run(run.runId);
    db.prepare('DELETE FROM agent_runs WHERE id=?').run(run.runId);
    cleanup(env);
  }
});


test('phase2 sandbox migration and tool provenance columns exist', () => {
  const toolCols=new Set((db.prepare('PRAGMA table_info(tool_executions)').all() as any[]).map(row=>row.name));
  assert.ok(toolCols.has('sandbox_id'));
  const sandboxCols=new Set((db.prepare('PRAGMA table_info(sandboxes)').all() as any[]).map(row=>row.name));
  for(const name of ['project_id','user_id','run_id','status','root_path','base_hash','base_manifest_json','validation_json']) assert.ok(sandboxCols.has(name));
  const migration=db.prepare('SELECT name FROM schema_migrations WHERE version=6').get() as any;
  assert.equal(migration?.name,'006_phase2_isolated_sandboxes');
});


test('phase2 restart marks in-flight tool execution interrupted instead of replaying it', () => {
  const env=setupProject();
  try {
    const definition=ToolRegistry.get('workspace.list_tree')!;
    const running=ToolExecutionJournal.start({
      context:{userId:env.userId,projectId:env.projectId,runId:'run-restart',stepId:'step-restart'},
      definition,
      requestInput:{},
      idempotencyKey:'restart-list',
    });
    assert.equal(running.status,'running');
    initializeDatabase();
    const recovered=ToolExecutionJournal.get(running.id);
    assert.equal(recovered?.status,'interrupted');
    assert.equal(recovered?.errorCode,'worker_interrupted');
    const replay=ToolExecutionJournal.findByIdempotency('run-restart','restart-list');
    assert.equal(replay?.id,running.id);
  } finally { cleanup(env); }
});


test('phase2 proposal apply validates sandbox then atomically updates official workspace', async () => {
  const env=setupProject();
  try {
    WorkspaceManager.writeFile(env.projectId,'index.html','<html><body>old</body></html>');
    const proposal={
      id:'proposal-direct-sandbox',
      summary:'update html',
      requiresConfirmation:true,
      status:'pending',
      files:[{path:'index.html',action:'modify',content:'<html><body>new</body></html>'}],
    };
    const result=await SandboxProposalApplyService.apply({
      userId:env.userId,projectId:env.projectId,proposal,summary:'apply sandbox proposal',
    });
    assert.equal(result.success,true);
    assert.equal(result.validation?.status,'unverified');
    assert.equal(result.needsVerification,true);
    assert.equal(WorkspaceManager.readFile(env.projectId,'index.html'),'<html><body>new</body></html>');
    assert.ok(result.checkpointId);
    assert.ok(result.sandboxId);
    const writes=db.prepare("SELECT COUNT(*) c FROM tool_executions WHERE project_id=? AND sandbox_id=? AND tool_key='workspace.write_file' AND status='succeeded'")
      .get(env.projectId,result.sandboxId) as any;
    assert.equal(writes.c,1);
  } finally { cleanup(env); }
});


test('phase2 workflow materializes FORGE proposal in sandbox while official workspace remains unchanged', async (t) => {
  const env=setupProject();
  seedAgentModel(env.userId);
  WorkspaceManager.writeFile(env.projectId,'index.html','<html><body>old</body></html>');
  const run=RunService.start(env.userId,env.projectId,'conv-phase2-workflow','build');
  t.mock.method(LLMAdapterService,'getProviderConfig',()=>({key:'mock-tools',type:'openai_compatible',apiKey:'x',baseUrl:'https://mock.invalid/v1',modelId:'mock-model',name:'Mock Tools',isConfigured:true} as any));
  t.mock.method(LLMAdapterService,'executePrompt',async(options:any)=>{
    if(options.mode==='review'){
      return {replyText:'brief ready',mode:'review',decisionType:'none',isDemonstrativeFallback:false,providerUsed:'Mock Tools',modelUsed:'mock-model',hasErrors:false,usage:{inputTokens:1,outputTokens:1,billedCostUsd:0.001}} as any;
    }
    return {
      replyText:'proposal ready',mode:'build',decisionType:'change',isDemonstrativeFallback:false,providerUsed:'Mock Tools',modelUsed:'mock-model',hasErrors:false,
      build:{summary:'change',explanation:'change',files:[{path:'index.html',action:'modify',content:'<html><body>new</body></html>'}]},
      proposal:{id:'phase2-workflow-proposal',summary:'change',requiresConfirmation:true,status:'pending',files:[{path:'index.html',action:'modify',content:'<html><body>new</body></html>'}]},
      usage:{inputTokens:1,outputTokens:1,billedCostUsd:0.001},
    } as any;
  });
  try {
    const result=await AgentWorkflowEngine.executeWorkflow({
      prompt:'Update the page',mode:'build',projectId:env.projectId,existingFiles:WorkspaceManager.getAllFilesContent(env.projectId),
      appliedSkills:[],conversationHistory:[],userId:env.userId,runId:run.runId,stepId:run.stepId,focusPaths:['index.html'],
    });
    assert.equal(result.workflow.status,'waiting_approval');
    assert.equal(WorkspaceManager.readFile(env.projectId,'index.html'),'<html><body>old</body></html>');
    assert.ok(result.proposal?.sandboxId);
    assert.equal(SandboxManager.readFile(result.proposal!.sandboxId!,env.userId,'index.html',env.projectId),'<html><body>new</body></html>');
    const tools=ToolExecutionJournal.listByRun(run.runId);
    assert.ok(tools.some(row=>row.toolKey==='workspace.write_file'&&row.sandboxId===result.proposal?.sandboxId));
  } finally {
    db.prepare('DELETE FROM model_invocations WHERE run_id=?').run(run.runId);
    db.prepare('DELETE FROM agent_steps WHERE run_id=?').run(run.runId);
    db.prepare('DELETE FROM agent_runs WHERE id=?').run(run.runId);
    cleanup(env);
  }
});


test('phase2 sandbox process environment replaces host home temp and provider secrets', async () => {
  const env=setupProject();
  const previousSecret=process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY='phase2-host-secret-must-not-leak';
  try {
    WorkspaceManager.writeFile(env.projectId,'package.json',JSON.stringify({
      scripts:{
        envcheck:'node -e "console.log(JSON.stringify({home:process.env.HOME,userprofile:process.env.USERPROFILE,tmp:process.env.TMP,npmrc:process.env.NPM_CONFIG_USERCONFIG,secret:process.env.OPENAI_API_KEY||null}))"'
      }
    }));
    const sandbox=SandboxManager.create({userId:env.userId,projectId:env.projectId,runId:'run-env',stepId:'step-env'});
    const result=await ToolExecutionService.execute(
      {userId:env.userId,projectId:env.projectId,runId:'run-env',stepId:'step-env',sandboxId:sandbox.id},
      {toolKey:'process.run',input:{script:'envcheck',timeoutMs:10000},idempotencyKey:'envcheck-once'}
    );
    assert.equal(result.status,'succeeded');
    const output=String((result.output as any).output||'');
    assert.equal(output.includes('phase2-host-secret-must-not-leak'),false);
    assert.ok(output.includes(path.join(sandbox.rootPath,'.forge-home')));
    assert.equal(SandboxManager.getFiles(sandbox.id,env.userId,env.projectId).some(file=>file.path.startsWith('.forge-home/')),false);
  } finally {
    if(previousSecret===undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY=previousSecret;
    cleanup(env);
  }
});

test('phase2 validator-generated artifacts are excluded from approved atomic merge', async () => {
  const env=setupProject();
  try {
    WorkspaceManager.writeFile(env.projectId,'index.html','<html><body>old</body></html>');
    WorkspaceManager.writeFile(env.projectId,'package.json',JSON.stringify({
      scripts:{build:'node -e "require(\'fs\').writeFileSync(\'generated-by-build.txt\',\'artifact\')"'}
    }));
    const proposal={
      id:'proposal-generated-artifact',
      summary:'update html only',
      requiresConfirmation:true,
      status:'pending',
      files:[{path:'index.html',action:'modify',content:'<html><body>new</body></html>'}],
    };
    const result=await SandboxProposalApplyService.apply({
      userId:env.userId,projectId:env.projectId,proposal,summary:'merge without build artifact',
    });
    assert.equal(result.success,true);
    assert.equal(result.validation?.status,'passed');
    assert.equal(WorkspaceManager.readFile(env.projectId,'index.html'),'<html><body>new</body></html>');
    assert.equal(WorkspaceManager.readFile(env.projectId,'generated-by-build.txt'),null);
    assert.equal(WorkspaceManager.readFile(env.projectId,'package-lock.json'),null);
  } finally { cleanup(env); }
});

test('phase2 apply rejects tampered approved file while preserving official workspace', async () => {
  const env=setupProject();
  try {
    WorkspaceManager.writeFile(env.projectId,'index.html','<html><body>old</body></html>');
    const sandbox=SandboxManager.create({userId:env.userId,projectId:env.projectId,runId:'run-tamper'});
    await ToolExecutionService.execute(
      {userId:env.userId,projectId:env.projectId,runId:'run-tamper',sandboxId:sandbox.id},
      {toolKey:'workspace.write_file',input:{path:'index.html',content:'<html><body>approved</body></html>'},idempotencyKey:'approved-content'}
    );
    await ToolExecutionService.execute(
      {userId:env.userId,projectId:env.projectId,runId:'run-tamper',sandboxId:sandbox.id},
      {toolKey:'workspace.write_file',input:{path:'index.html',content:'<html><body>tampered</body></html>'},idempotencyKey:'tampered-content'}
    );
    const proposal={
      id:'proposal-tamper',
      summary:'approved html',
      requiresConfirmation:true,
      status:'pending',
      sandboxId:sandbox.id,
      files:[{path:'index.html',action:'modify',content:'<html><body>approved</body></html>'}],
    };
    const result=await SandboxProposalApplyService.apply({
      userId:env.userId,projectId:env.projectId,proposal,summary:'reject tamper',
    });
    assert.equal(result.success,false);
    assert.equal(result.statusCode,409);
    assert.equal(result.errorCode,'sandbox_proposal_mismatch');
    assert.equal(WorkspaceManager.readFile(env.projectId,'index.html'),'<html><body>old</body></html>');
  } finally { cleanup(env); }
});

test('phase2 atomic merge ignores unapproved extra sandbox files', async () => {
  const env=setupProject();
  try {
    WorkspaceManager.writeFile(env.projectId,'index.html','<html><body>old</body></html>');
    const sandbox=SandboxManager.create({userId:env.userId,projectId:env.projectId,runId:'run-extra'});
    await ToolExecutionService.execute(
      {userId:env.userId,projectId:env.projectId,runId:'run-extra',sandboxId:sandbox.id},
      {toolKey:'workspace.write_file',input:{path:'index.html',content:'<html><body>approved</body></html>'},idempotencyKey:'extra-approved'}
    );
    await ToolExecutionService.execute(
      {userId:env.userId,projectId:env.projectId,runId:'run-extra',sandboxId:sandbox.id},
      {toolKey:'workspace.write_file',input:{path:'unapproved.txt',content:'must not merge'},idempotencyKey:'extra-unapproved'}
    );
    const proposal={
      id:'proposal-extra',
      summary:'approved html only',
      requiresConfirmation:true,
      status:'pending',
      sandboxId:sandbox.id,
      files:[{path:'index.html',action:'modify',content:'<html><body>approved</body></html>'}],
    };
    const result=await SandboxProposalApplyService.apply({
      userId:env.userId,projectId:env.projectId,proposal,summary:'merge approved subset',
    });
    assert.equal(result.success,true);
    assert.equal(WorkspaceManager.readFile(env.projectId,'index.html'),'<html><body>approved</body></html>');
    assert.equal(WorkspaceManager.readFile(env.projectId,'unapproved.txt'),null);
  } finally { cleanup(env); }
});
