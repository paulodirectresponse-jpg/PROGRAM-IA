import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { db, initializeDatabase, applyBootstrapSchemaIfNeeded } from '../server/db/index.js';
import { BrowserQualityService } from '../server/browser/browserQualityService.js';
import { WorkspaceManager } from '../server/services/workspaceManager.js';
import { SandboxManager } from '../server/tooling/sandboxManager.js';
import { ToolExecutionService } from '../server/tooling/toolExecutionService.js';
import { ToolExecutionJournal } from '../server/tooling/toolExecutionJournal.js';
import { ToolRegistry } from '../server/tooling/toolRegistry.js';
import { SandboxProposalApplyService } from '../server/tooling/sandboxProposalApplyService.js';
import { LLMAdapterService } from '../server/services/llmAdapter.js';
import { RunService } from '../server/services/runService.js';

initializeDatabase();

function setupProject(){
  const suffix=`${Date.now()}-${crypto.randomUUID()}`;
  const userId=`phase3-user-${suffix}`,workspaceId=`phase3-ws-${suffix}`,projectId=`phase3-project-${suffix}`,now=new Date().toISOString();
  db.prepare("INSERT INTO users(id,email,name,role,created_at) VALUES(?,?,?,'developer',?)").run(userId,`${userId}@example.test`,'Phase 3 User',now);
  db.prepare('INSERT INTO workspaces(id,user_id,name,root_path,created_at) VALUES(?,?,?,?,?)').run(workspaceId,userId,'Phase 3 Workspace',`/tmp/${workspaceId}`,now);
  db.prepare("INSERT INTO projects(id,user_id,workspace_id,name,origin,created_at,updated_at) VALUES(?,?,?,'Phase 3 Project','novo',?,?)").run(projectId,userId,workspaceId,now,now);
  return {userId,workspaceId,projectId};
}
function seedAgentModel(userId:string){
  const now=new Date().toISOString(),providerKey='mock-phase3',profileId=`profile-${userId}-phase3`;
  db.prepare('INSERT OR REPLACE INTO providers(id,user_id,provider_key,name,base_url,model_id,is_configured,is_active,connection_status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(`provider-${userId}-phase3`,userId,providerKey,'Mock Phase3','https://mock.invalid/v1','mock-model',1,1,'connected',now);
  db.prepare('INSERT OR REPLACE INTO model_profiles(id,user_id,profile_key,level,max_attempts,max_cost_usd,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(profileId,userId,'BASE_FREE',0,1,0.1,1,now,now);
  db.prepare('INSERT OR REPLACE INTO model_candidates(id,profile_id,provider_key,model_id,priority,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(`candidate-${userId}-phase3`,profileId,providerKey,'mock-model',0,1,now,now);
}
function cleanup(env:{userId:string;workspaceId:string;projectId:string}){
  const quality=db.prepare('SELECT viewports_json FROM browser_quality_runs WHERE project_id=?').all(env.projectId) as Array<{viewports_json:string}>;
  for(const row of quality){
    try{
      for(const item of JSON.parse(row.viewports_json||'[]'))if(item?.screenshotPath)fs.rmSync(item.screenshotPath,{force:true});
    }catch{}
  }
  const sandboxes=db.prepare('SELECT id FROM sandboxes WHERE project_id=?').all(env.projectId) as Array<{id:string}>;
  for(const sandbox of sandboxes)SandboxManager.cleanup(sandbox.id,env.userId);
  WorkspaceManager.deleteProject(env.projectId);
  db.prepare('DELETE FROM browser_quality_runs WHERE project_id=?').run(env.projectId);
  db.prepare("DELETE FROM verifications WHERE project_id=? AND gate_type='preview'").run(env.projectId);
  db.prepare('DELETE FROM tool_executions WHERE project_id=?').run(env.projectId);
  db.prepare('DELETE FROM context_commits WHERE project_id=?').run(env.projectId);
  db.prepare('DELETE FROM context_packs WHERE project_id=?').run(env.projectId);
  db.prepare('DELETE FROM context_project_files WHERE project_id=?').run(env.projectId);
  db.prepare('DELETE FROM context_architecture_graphs WHERE project_id=?').run(env.projectId);
  db.prepare('DELETE FROM sandboxes WHERE project_id=?').run(env.projectId);
  db.prepare('DELETE FROM projects WHERE id=?').run(env.projectId);
  db.prepare('DELETE FROM model_candidates WHERE profile_id IN (SELECT id FROM model_profiles WHERE user_id=?)').run(env.userId);
  db.prepare('DELETE FROM model_profiles WHERE user_id=?').run(env.userId);
  db.prepare('DELETE FROM providers WHERE user_id=?').run(env.userId);
  db.prepare('DELETE FROM workspaces WHERE id=?').run(env.workspaceId);
  db.prepare('DELETE FROM users WHERE id=?').run(env.userId);
}

test('production bootstrap schema is never replayed over a legacy persistent database',()=>{
  const legacy=new DatabaseSync(':memory:');
  try{
    legacy.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version,name,applied_at) VALUES(1,'001_initial_schema','2026-01-01T00:00:00.000Z');
      CREATE TABLE tool_executions(
        id TEXT PRIMARY KEY,run_id TEXT,step_id TEXT,tool_key TEXT NOT NULL,status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,summary_json TEXT NOT NULL,created_at TEXT NOT NULL
      );
    `);
    const schemaSql=fs.readFileSync(path.resolve(process.cwd(),'server','db','schema.sql'),'utf8');
    assert.doesNotThrow(()=>applyBootstrapSchemaIfNeeded(legacy,schemaSql));
    const cols=new Set((legacy.prepare('PRAGMA table_info(tool_executions)').all() as any[]).map(row=>row.name));
    assert.equal(cols.has('sandbox_id'),false);
    assert.equal(cols.has('idempotency_key'),false);
  }finally{legacy.close();}
});

test('phase3 migration and browser tool are registered',()=>{
  const migration=db.prepare('SELECT name FROM schema_migrations WHERE version=7').get() as any;
  assert.equal(migration?.name,'007_phase3_browser_quality_gate');
  const columns=new Set((db.prepare('PRAGMA table_info(browser_quality_runs)').all() as any[]).map(row=>row.name));
  for(const name of ['project_id','user_id','sandbox_id','status','issues_json','viewports_json','duration_ms'])assert.ok(columns.has(name));
  const tool=ToolRegistry.get('browser.inspect_page');
  assert.equal(tool?.availability,'requires_sandbox');
  assert.equal(tool?.risk,'network');
  assert.equal(tool?.resumePolicy,'replay_safe');
});

test('phase3 real browser inspects static candidate on desktop and mobile with persisted screenshots',async()=>{
  const env=setupProject();
  try{
    WorkspaceManager.writeFile(env.projectId,'index.html',`<!doctype html><html><head><title>Quality</title></head><body><main><h1>Hello Browser</h1><button aria-label="Continue">Go</button></main></body></html>`);
    const sandbox=SandboxManager.create({userId:env.userId,projectId:env.projectId,runId:'run-browser-pass'});
    const quality=await BrowserQualityService.inspect({userId:env.userId,projectId:env.projectId,sandboxId:sandbox.id,runId:'run-browser-pass'});
    assert.equal(quality.status,'passed',JSON.stringify({reason:quality.reason,issues:quality.issues,viewports:quality.viewports},null,2));
    assert.equal(quality.runtimeKind,'static');
    assert.equal(quality.viewports.length,2);
    assert.deepEqual(quality.viewports.map(v=>v.name),['desktop','mobile']);
    for(const viewport of quality.viewports){
      assert.ok(viewport.screenshotPath&&fs.existsSync(viewport.screenshotPath));
      assert.ok((viewport.screenshotBytes||0)>0);
      assert.equal(viewport.title,'Quality');
    }
    assert.equal(BrowserQualityService.get(quality.id)?.status,'passed');
    const verification=db.prepare("SELECT status,details_json FROM verifications WHERE project_id=? AND gate_type='preview' ORDER BY created_at DESC LIMIT 1").get(env.projectId) as any;
    assert.equal(verification.status,'pass');
    assert.equal(JSON.parse(verification.details_json).browserQualityRunId,quality.id);
  }finally{cleanup(env);}
});

test('phase3 browser blocks external requests while preserving local quality evidence',async()=>{
  const env=setupProject();
  try{
    WorkspaceManager.writeFile(env.projectId,'index.html',`<!doctype html><html><body><h1>Local</h1><img alt="remote" src="https://example.com/remote.png?TOKEN=phase3-secret-value"><script>console.error('TOKEN=phase3-secret-value')</script></body></html>`);
    const sandbox=SandboxManager.create({userId:env.userId,projectId:env.projectId,runId:'run-browser-network'});
    const quality=await BrowserQualityService.inspect({userId:env.userId,projectId:env.projectId,sandboxId:sandbox.id,runId:'run-browser-network'});
    assert.equal(quality.status,'passed');
    assert.ok(quality.viewports.every(v=>v.blockedExternalRequests.some(url=>url.includes('example.com'))));
    assert.ok(quality.issues.some(issue=>issue.code==='external_requests_blocked'&&issue.severity==='info'));
    assert.equal(JSON.stringify(quality).includes('phase3-secret-value'),false);
  }finally{cleanup(env);}
});

test('phase3 browser detects executable page error as failed quality gate',async()=>{
  const env=setupProject();
  try{
    WorkspaceManager.writeFile(env.projectId,'index.html',`<!doctype html><html><body><h1>Broken</h1><script>setTimeout(()=>{throw new Error('phase3 boom')},0)</script></body></html>`);
    const sandbox=SandboxManager.create({userId:env.userId,projectId:env.projectId,runId:'run-browser-fail'});
    const quality=await BrowserQualityService.inspect({userId:env.userId,projectId:env.projectId,sandboxId:sandbox.id,runId:'run-browser-fail'});
    assert.equal(quality.status,'failed',JSON.stringify({reason:quality.reason,issues:quality.issues,viewports:quality.viewports},null,2));
    assert.ok(quality.issues.some(issue=>issue.code==='page_error'&&issue.severity==='error'&&issue.message.includes('phase3 boom')));
  }finally{cleanup(env);}
});

test('phase3 browser tool records provenance and hides server screenshot paths from tool output',async()=>{
  const env=setupProject();
  try{
    WorkspaceManager.writeFile(env.projectId,'index.html','<!doctype html><html><body><h1>Tool Browser</h1></body></html>');
    const sandbox=SandboxManager.create({userId:env.userId,projectId:env.projectId,runId:'run-browser-tool',stepId:'step-browser-tool'});
    const result=await ToolExecutionService.execute(
      {userId:env.userId,projectId:env.projectId,runId:'run-browser-tool',stepId:'step-browser-tool',sandboxId:sandbox.id},
      {toolKey:'browser.inspect_page',input:{},idempotencyKey:'browser-tool-once'}
    );
    assert.equal(result.status,'succeeded');
    assert.equal((result.output as any).status,'passed',JSON.stringify(result.output,null,2));
    assert.ok((result.output as any).viewports.every((v:any)=>v.screenshotPath===undefined));
    const record=ToolExecutionJournal.get(result.executionId);
    assert.equal(record?.toolKey,'browser.inspect_page');
    assert.equal(record?.sandboxId,sandbox.id);
    assert.equal(record?.status,'succeeded');
  }finally{cleanup(env);}
});

test('phase3 framework candidate runs through isolated runtime before browser inspection',async()=>{
  const env=setupProject();
  try{
    WorkspaceManager.writeFile(env.projectId,'package.json',JSON.stringify({scripts:{dev:'node server.js'}}));
    WorkspaceManager.writeFile(env.projectId,'server.js',`const http=require('http');http.createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<html><head><title>Runtime Quality</title></head><body><h1>Runtime OK</h1></body></html>')}).listen(Number(process.env.PORT),'127.0.0.1')`);
    const sandbox=SandboxManager.create({userId:env.userId,projectId:env.projectId,runId:'run-browser-runtime'});
    fs.mkdirSync(path.join(sandbox.rootPath,'node_modules'),{recursive:true});
    const quality=await BrowserQualityService.inspect({userId:env.userId,projectId:env.projectId,sandboxId:sandbox.id,runId:'run-browser-runtime'});
    assert.equal(quality.status,'passed');
    assert.equal(quality.runtimeKind,'framework');
    assert.ok(quality.url?.startsWith('http://127.0.0.1:'));
    assert.ok(quality.viewports.every(v=>v.title==='Runtime Quality'));
  }finally{cleanup(env);}
});

test('phase3 failed browser gate invokes SENTINEL then one bounded FORGE repair and revalidates in browser',async(t)=>{
  const env=setupProject();seedAgentModel(env.userId);
  WorkspaceManager.writeFile(env.projectId,'index.html',`<!doctype html><html><body><h1>Broken</h1><script>throw new Error('visual boom')</script></body></html>`);
  const run=RunService.start(env.userId,env.projectId,'conv-phase3-repair','build');
  let calls=0;
  t.mock.method(LLMAdapterService,'getProviderConfig',()=>({key:'mock-phase3',type:'openai_compatible',apiKey:'x',baseUrl:'https://mock.invalid/v1',modelId:'mock-model',name:'Mock Phase3',isConfigured:true} as any));
  t.mock.method(LLMAdapterService,'executePrompt',async(options:any)=>{
    calls++;
    if(options.mode==='review'){
      return {replyText:'O erro visual vem do script que lança visual boom; remova somente esse script.',mode:'review',decisionType:'none',isDemonstrativeFallback:false,providerUsed:'Mock Phase3',modelUsed:'mock-model',hasErrors:false,usage:{inputTokens:2,outputTokens:2,billedCostUsd:0.001}} as any;
    }
    return {replyText:'repair',mode:'build',decisionType:'change',isDemonstrativeFallback:false,providerUsed:'Mock Phase3',modelUsed:'mock-model',hasErrors:false,
      build:{summary:'browser repair',explanation:'remove runtime error',files:[{path:'index.html',action:'modify',content:'<!doctype html><html><body><h1>Fixed</h1></body></html>'}]},
      proposal:{id:'phase3-repair-proposal',summary:'browser repair',requiresConfirmation:false,status:'pending',files:[{path:'index.html',action:'modify',content:'<!doctype html><html><body><h1>Fixed</h1></body></html>'}]},
      usage:{inputTokens:3,outputTokens:3,billedCostUsd:0.001}} as any;
  });
  try{
    const proposal={id:'phase3-broken-proposal',summary:'broken page',requiresConfirmation:true,status:'pending',files:[{path:'index.html',action:'modify',content:`<!doctype html><html><body><h1>Broken</h1><script>throw new Error('visual boom')</script></body></html>`}]};
    const result=await SandboxProposalApplyService.apply({userId:env.userId,projectId:env.projectId,proposal,runId:run.runId,summary:'browser repair'});
    assert.equal(result.success,true,JSON.stringify(result,null,2));
    assert.equal(result.browserRepair?.status,'passed');
    assert.equal(result.browserQuality?.status,'passed');
    assert.match(WorkspaceManager.readFile(env.projectId,'index.html')||'',/Fixed/);
    assert.equal((db.prepare("SELECT COUNT(*) c FROM agent_steps WHERE run_id=? AND title='Diagnosticar falha do Browser Quality Gate'").get(run.runId) as any).c,1);
    assert.equal((db.prepare("SELECT COUNT(*) c FROM agent_steps WHERE run_id=? AND title='Corrigir falha do Browser Quality Gate'").get(run.runId) as any).c,1);
    assert.equal(BrowserQualityService.listByRun(run.runId).length,2);
    assert.equal(calls,2);
  }finally{
    db.prepare('DELETE FROM model_invocations WHERE run_id=?').run(run.runId);
    db.prepare('DELETE FROM agent_steps WHERE run_id=?').run(run.runId);
    db.prepare('DELETE FROM agent_runs WHERE id=?').run(run.runId);
    cleanup(env);
  }
});


test('phase3 screenshot evidence is owner-scoped and cannot be resolved by another user',async()=>{
  const env=setupProject();
  try{
    WorkspaceManager.writeFile(env.projectId,'index.html','<!doctype html><html><body><h1>Owner Evidence</h1></body></html>');
    const sandbox=SandboxManager.create({userId:env.userId,projectId:env.projectId,runId:'run-browser-owner'});
    const quality=await BrowserQualityService.inspect({userId:env.userId,projectId:env.projectId,sandboxId:sandbox.id,runId:'run-browser-owner'});
    assert.equal(quality.status,'passed');
    assert.ok(BrowserQualityService.screenshotPath(quality.id,'desktop',env.userId,env.projectId));
    assert.equal(BrowserQualityService.screenshotPath(quality.id,'desktop','different-user',env.projectId),null);
    assert.equal(BrowserQualityService.screenshotPath(quality.id,'desktop',env.userId,'different-project'),null);
  }finally{cleanup(env);}
});

test('phase3 direct proposal with executable browser failure is blocked before official merge',async()=>{
  const env=setupProject();
  try{
    WorkspaceManager.writeFile(env.projectId,'index.html','<!doctype html><html><body><h1>Original</h1></body></html>');
    const proposal={
      id:'phase3-direct-fail',
      summary:'broken direct proposal',
      requiresConfirmation:true,
      status:'pending',
      files:[{path:'index.html',action:'modify',content:'<!doctype html><html><body><h1>Broken</h1><script>throw new Error("direct browser failure")</script></body></html>'}],
    };
    const result=await SandboxProposalApplyService.apply({userId:env.userId,projectId:env.projectId,proposal,summary:'direct browser fail'});
    assert.equal(result.success,false);
    assert.equal(result.statusCode,422);
    assert.equal(result.browserQuality?.status,'failed');
    assert.match(WorkspaceManager.readFile(env.projectId,'index.html')||'',/Original/);
  }finally{cleanup(env);}
});


test('phase3 browser evidence cleanup removes persisted screenshot artifacts',async()=>{
  const env=setupProject();
  try{
    WorkspaceManager.writeFile(env.projectId,'index.html','<!doctype html><html><body><h1>Cleanup Evidence</h1></body></html>');
    const sandbox=SandboxManager.create({userId:env.userId,projectId:env.projectId,runId:'run-browser-cleanup'});
    const quality=await BrowserQualityService.inspect({userId:env.userId,projectId:env.projectId,sandboxId:sandbox.id,runId:'run-browser-cleanup'});
    const screenshot=quality.viewports[0]?.screenshotPath;
    assert.ok(screenshot&&fs.existsSync(screenshot));
    const cleaned=BrowserQualityService.cleanupProject(env.projectId,env.userId);
    assert.equal(cleaned.runs,1);
    assert.ok(cleaned.artifacts>=2);
    assert.equal(fs.existsSync(screenshot!),false);
    assert.equal(BrowserQualityService.get(quality.id),null);
  }finally{cleanup(env);}
});
