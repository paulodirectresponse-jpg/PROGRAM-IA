import test from 'node:test';
import assert from 'node:assert/strict';
import { db, initializeDatabase } from '../server/db/index.js';
import JSZip from 'jszip';
import { AgentEngine, AgentWorkflowEngine } from '../server/agent-engine/agentEngine.js';
import { LLMAdapterService } from '../server/services/llmAdapter.js';
import { RunService } from '../server/services/runService.js';
import { RequirementLedgerService } from '../server/services/requirementLedgerService.js';
import { WorkspaceManager } from '../server/services/workspaceManager.js';
import {
  ArchitectureGraphService, ContextCommitService, ContextCompiler, ContextEngineV2, ProjectFileIndex,
} from '../server/context-engine/contextEngine.js';

initializeDatabase();

function safeIdSuffix() { return `${Date.now()}-${crypto.randomUUID()}`; }

function cleanup(projectId: string) {
  db.prepare('DELETE FROM context_packs WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM context_commits WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM context_architecture_graphs WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM context_project_files WHERE project_id=?').run(projectId);
}

test('phase1 project file index hashes, extracts symbols and invalidates incrementally', () => {
  const projectId=`phase1-index-${safeIdSuffix()}`;
  try {
    const first=ProjectFileIndex.syncProject(projectId,{
      'src/domain/Product.ts':`export interface Product { id:string }\nexport const makeProduct=()=>({id:'1'})`,
      'src/services/products.ts':`import { makeProduct } from '../domain/Product';\nexport function listProducts(){ return [makeProduct()]; }`,
    });
    assert.equal(first.changedPaths.length,2);
    const product=ProjectFileIndex.get(projectId,'src/domain/Product.ts');
    assert.ok(product?.symbols.includes('Product'));
    assert.ok(product?.exports.includes('makeProduct'));

    const second=ProjectFileIndex.syncProject(projectId,{
      'src/domain/Product.ts':`export interface Product { id:string }\nexport const makeProduct=()=>({id:'1'})`,
      'src/services/products.ts':`import { makeProduct } from '../domain/Product';\nexport function listProducts(){ return [makeProduct(),makeProduct()]; }`,
    });
    assert.deepEqual(second.changedPaths,['src/services/products.ts']);
    assert.deepEqual(second.unchangedPaths,['src/domain/Product.ts']);
    assert.notEqual(first.projectHash,second.projectHash);

    const third=ProjectFileIndex.syncProject(projectId,{
      'src/domain/Product.ts':`export interface Product { id:string }\nexport const makeProduct=()=>({id:'1'})`,
    });
    assert.deepEqual(third.removedPaths,['src/services/products.ts']);
    assert.equal(third.totalFiles,1);
  } finally { cleanup(projectId); }
});

test('phase1 architecture graph classifies structure and resolves dependencies', () => {
  const projectId=`phase1-graph-${safeIdSuffix()}`;
  try {
    ProjectFileIndex.syncProject(projectId,{
      'src/domain/Product.ts':`export interface Product { id:string }`,
      'src/services/productService.ts':`import type { Product } from '../domain/Product'; export const save=(x:Product)=>x;`,
      'src/components/ProductForm.tsx':`import { save } from '../services/productService'; export function ProductForm(){ return null }`,
      'src/integrations/supabaseClient.ts':`import { createClient } from '@supabase/supabase-js'; export const client=createClient('x','y');`,
      'src/routes/products.route.ts':`import { save } from '../services/productService'; export const route=save;`,
    });
    const graph=ArchitectureGraphService.buildAndPersist(projectId);
    assert.ok(graph.models.some(item=>item.files.includes('src/domain/Product.ts')));
    assert.ok(graph.services.some(item=>item.files.includes('src/services/productService.ts')));
    assert.ok(graph.components.some(item=>item.files.includes('src/components/ProductForm.tsx')));
    assert.ok(graph.integrations.some(item=>item.files.includes('src/integrations/supabaseClient.ts')));
    assert.ok(graph.routes.some(item=>item.files.includes('src/routes/products.route.ts')));
    assert.ok(graph.dependencies.some(dep=>dep.from==='src/components/ProductForm.tsx'&&dep.to==='src/services/productService.ts'));
    assert.ok(graph.dependencies.some(dep=>dep.to==='pkg:@supabase/supabase-js'));
  } finally { cleanup(projectId); }
});

test('phase1 context commits persist decisions, requirements and next state', () => {
  const projectId=`phase1-commit-${safeIdSuffix()}`;
  try {
    const created=ContextCommitService.create({
      projectId,runId:'run-1',taskId:'task-1',agentKey:'FORGE',scope:'TASK',
      task:'Implementar cadastro de produto',decisions:['usar serviço de domínio'],
      changedFiles:['src/services/products.ts'],requirementIds:['REQ-001'],
      validation:{status:'passed'},blockers:[],nextState:{action:'verify-browser'},
    });
    const recent=ContextCommitService.listRecent(projectId);
    assert.equal(recent[0].id,created.id);
    assert.deepEqual(recent[0].requirementIds,['REQ-001']);
    assert.deepEqual(recent[0].nextState,{action:'verify-browser'});
  } finally { cleanup(projectId); }
});

test('phase1 context compiler has no file-count cap and preserves dependency evidence', () => {
  const projectId=`phase1-compile-${safeIdSuffix()}`;
  try {
    const files:Record<string,string>={
      'src/domain/Product.ts':`export interface Product { id:string }`,
      'src/services/productService.ts':`import type { Product } from '../domain/Product'; export const save=(x:Product)=>x;`,
      'src/components/ProductForm.tsx':`import { save } from '../services/productService'; export function ProductForm(){ return null }`,
    };
    for(let i=0;i<40;i++) files[`src/other/module-${i}.ts`]=`export const value${i}=${i};`;
    ContextEngineV2.syncProject({projectId,files});
    ContextCommitService.create({
      projectId,task:'Cadastro de produto',agentKey:'FORGE',scope:'TASK',
      changedFiles:['src/services/productService.ts'],requirementIds:['REQ-001'],decisions:['persistir produto'],
    });
    const pack=ContextCompiler.compile({
      projectId,agentKey:'FORGE',scope:'TASK',
      task:{objective:'Implementar cadastro de produto',currentFile:'src/components/ProductForm.tsx'},
      requirementIds:['REQ-001'],focusPaths:['src/components/ProductForm.tsx'],tokenBudget:50000,
    });
    const selected=pack.selectedFiles.map(item=>item.file.path);
    assert.ok(selected.includes('src/components/ProductForm.tsx'));
    assert.ok(selected.includes('src/services/productService.ts'));
    assert.equal(pack.omittedFiles.length,0);
    assert.equal(selected.length,43);
  } finally { cleanup(projectId); }
});

test('phase1 compiler makes context budget omissions explicit and persists telemetry', () => {
  const projectId=`phase1-budget-${safeIdSuffix()}`;
  try {
    const files:Record<string,string>={};
    for(let i=0;i<25;i++) files[`src/features/feature-${i}.ts`]=`export function feature${i}(){ return 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }`;
    ContextEngineV2.syncProject({projectId,files});
    const pack=ContextCompiler.compile({
      projectId,agentKey:'SCOUT',scope:'MICRO',task:{objective:'Entender feature 1'},tokenBudget:256,
    });
    assert.ok(pack.omittedFiles.length>0);
    assert.ok(pack.omittedFiles.every(item=>item.reason==='budget_exhausted'));
    const telemetry=ContextCompiler.listTelemetry(projectId);
    assert.equal(telemetry[0].id,pack.id);
    assert.equal(telemetry[0].tokenBudget,256);
  } finally { cleanup(projectId); }
});

test('phase1 database exposes context engine v2 tables', () => {
  const tables=new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(row=>row.name));
  for(const table of ['context_project_files','context_architecture_graphs','context_commits','context_packs']) assert.ok(tables.has(table),`missing ${table}`);
});


function seedModel(userId: string, providerKey = 'mock-context', profileKey = 'BASE_FREE', maxAttempts = 1, maxCostUsd = 0.01) {
  const now = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId,`${userId}@example.test`,userId,now);
  db.prepare('INSERT OR REPLACE INTO providers(id,user_id,provider_key,name,base_url,model_id,is_configured,is_active,connection_status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(`provider-${userId}-${providerKey}`,userId,providerKey,'Mock Context','https://mock.invalid/v1','mock-model',1,1,'connected',now);
  const profileId=`profile-${userId}-${profileKey}`;
  db.prepare('INSERT OR REPLACE INTO model_profiles(id,user_id,profile_key,level,max_attempts,max_cost_usd,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(profileId,userId,profileKey,profileKey==='EXPERT_PAID'?2:1,maxAttempts,maxCostUsd,1,now,now);
  db.prepare('INSERT OR REPLACE INTO model_candidates(id,profile_id,provider_key,model_id,priority,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(`candidate-${userId}-${providerKey}-${profileKey}`,profileId,providerKey,'mock-model',0,1,now,now);
}

function cleanupRun(runId:string, projectId:string, userId:string) {
  db.prepare('DELETE FROM model_invocations WHERE run_id=?').run(runId);
  db.prepare('DELETE FROM agent_steps WHERE run_id=?').run(runId);
  db.prepare('DELETE FROM agent_runs WHERE id=?').run(runId);
  db.prepare('DELETE FROM model_candidates WHERE profile_id IN (SELECT id FROM model_profiles WHERE user_id=?)').run(userId);
  db.prepare('DELETE FROM model_profiles WHERE user_id=?').run(userId);
  db.prepare('DELETE FROM providers WHERE user_id=?').run(userId);
  db.prepare('DELETE FROM requirements WHERE project_id=?').run(projectId);
  cleanup(projectId);
  WorkspaceManager.deleteProject(projectId);
}

test('phase1 agents send ContextPack-derived prompts and propagate requirements through SCOUT FORGE SENTINEL', async (t) => {
  const suffix=safeIdSuffix();
  const userId=`phase1-agent-user-${suffix}`;
  const projectId=`phase1-agent-project-${suffix}`;
  const run=RunService.start(userId,projectId,'conv-phase1','auto');
  seedModel(userId);
  const seen:any[]=[];
  t.mock.method(LLMAdapterService,'getProviderConfig',()=>({key:'mock-context',type:'openai_compatible',apiKey:'x',baseUrl:'https://mock.invalid/v1',modelId:'mock-model',name:'Mock Context',isConfigured:true} as any));
  t.mock.method(LLMAdapterService,'executePrompt',async(options:any)=>{
    seen.push({prompt:options.prompt,contextBrief:options.contextBrief,contextPackId:options.contextPackId,files:Object.keys(options.existingFiles)});
    return {replyText:'ok',mode:options.mode,decisionType:'change',isDemonstrativeFallback:false,providerUsed:'Mock Context',modelUsed:'mock-model',hasErrors:false,build:{summary:'ok',explanation:'ok',files:[{path:'src/App.tsx',action:'modify',content:'export function App(){return <main>ok</main>}'}]},proposal:{id:'p',summary:'ok',requiresConfirmation:true,status:'pending',files:[{path:'src/App.tsx',action:'modify',content:'export function App(){return <main>ok</main>}'}]},usage:{inputTokens:1,outputTokens:1,billedCostUsd:0.001}} as any;
  });
  try {
    await AgentWorkflowEngine.executeWorkflow({
      prompt:'Melhore visualmente a tela de cadastro REQ-CTX-1',mode:'auto',projectId,
      existingFiles:{'src/App.tsx':'export function App(){return <main>old</main>}','src/api.ts':'export const api=1'},
      appliedSkills:[],conversationHistory:[],userId,runId:run.runId,stepId:run.stepId,requirementIds:['REQ-CTX-1'],focusPaths:['src/App.tsx']
    });
    assert.ok(seen.length>=3);
    assert.ok(seen.every(call=>call.contextBrief?.includes('ContextPack')));
    assert.ok(seen.some(call=>call.contextBrief.includes('requirements=REQ-CTX-1')));
    assert.ok(seen.some(call=>call.prompt.includes('SCOUT')));
    assert.ok(seen.some(call=>call.prompt.includes('STUDIO')));
    assert.ok(seen.some(call=>call.prompt.includes('FORGE')));
    const invocations=db.prepare('SELECT agent_key,context_pack_id,context_scope,context_selected_files_json FROM model_invocations WHERE run_id=? ORDER BY created_at').all(run.runId) as any[];
    assert.ok(invocations.length>=3);
    assert.ok(invocations.every(row=>row.context_pack_id));
    assert.ok(invocations.some(row=>row.agent_key==='FORGE'&&JSON.parse(row.context_selected_files_json).includes('src/App.tsx')));
    const commits=ContextCommitService.listByRun(run.runId);
    assert.ok(commits.some(commit=>commit.agentKey==='SCOUT'&&commit.requirementIds?.includes('REQ-CTX-1')));
    assert.ok(commits.some(commit=>commit.agentKey==='FORGE'&&commit.changedFiles?.includes('src/App.tsx')));
  } finally { cleanupRun(run.runId,projectId,userId); }
});

test('phase1 repair uses local ContextPack focused on failed files instead of full project', async (t) => {
  const suffix=safeIdSuffix();
  const userId=`phase1-repair-user-${suffix}`;
  const projectId=`phase1-repair-project-${suffix}`;
  const run=RunService.start(userId,projectId,'conv-phase1','build');
  seedModel(userId);
  const seen:any[]=[];
  t.mock.method(LLMAdapterService,'getProviderConfig',()=>({key:'mock-context',type:'openai_compatible',apiKey:'x',baseUrl:'https://mock.invalid/v1',modelId:'mock-model',name:'Mock Context',isConfigured:true} as any));
  t.mock.method(LLMAdapterService,'executePrompt',async(options:any)=>{seen.push(options);return {replyText:'repair',mode:'build',decisionType:'change',isDemonstrativeFallback:false,providerUsed:'Mock Context',modelUsed:'mock-model',hasErrors:false,build:{summary:'repair',explanation:'repair',files:[{path:'src/broken.ts',action:'modify',content:'export const fixed=1'}]},usage:{inputTokens:1,outputTokens:1,billedCostUsd:0.001}} as any;});
  try {
    const files:Record<string,string>={'src/broken.ts':'export const broken =',};
    for(let i=0;i<35;i++) files[`src/noise-${i}.ts`]=`export const noise${i}=${i}`;
    await AgentEngine.execute({prompt:'Corrija somente falha concreta',mode:'build',projectId,existingFiles:files,appliedSkills:[],conversationHistory:[],userId,runId:run.runId,stepId:run.stepId,requirementIds:['REQ-REPAIR'],focusPaths:['src/broken.ts']},{profile:'BASE_FREE',forcedAgentKey:'FORGE',allowExpertEscalation:true,repair:true});
    const call=seen[0];
    assert.ok(call.contextBrief.includes('scope=LOCAL'));
    assert.ok(Object.keys(call.existingFiles).includes('src/broken.ts'));
    assert.ok(call.contextBrief.includes('requirements=REQ-REPAIR'));
  } finally { cleanupRun(run.runId,projectId,userId); }
});

test('phase1 workspace mutations keep ProjectFileIndex current for writes deletes zip duplicate and checkpoint restore', async () => {
  const suffix=safeIdSuffix();
  const projectId=`phase1-workspace-${suffix}`;
  try {
    WorkspaceManager.writeFile(projectId,'src/a.ts','export const a=1');
    const first=ProjectFileIndex.get(projectId,'src/a.ts');
    assert.ok(first);
    WorkspaceManager.writeFile(projectId,'src/a.ts','export const a=1');
    const second=ProjectFileIndex.syncProject(projectId,WorkspaceManager.getAllFilesContent(projectId));
    assert.deepEqual(second.unchangedPaths,['src/a.ts']);
    const cp=WorkspaceManager.createCheckpoint(projectId,'before');
    WorkspaceManager.writeFile(projectId,'src/b.ts','export const b=2');
    assert.ok(ProjectFileIndex.get(projectId,'src/b.ts'));
    WorkspaceManager.restoreCheckpoint(projectId,cp);
    assert.equal(ProjectFileIndex.get(projectId,'src/b.ts'),null);
    WorkspaceManager.deleteFile(projectId,'src/a.ts');
    assert.equal(ProjectFileIndex.get(projectId,'src/a.ts'),null);

    const zip=new JSZip();
    zip.file('pkg/src/c.ts','export const c=3');
    await WorkspaceManager.importZip(projectId,await zip.generateAsync({type:'nodebuffer'}));
    assert.ok(ProjectFileIndex.get(projectId,'src/c.ts'));

    const clone=`${projectId}-clone`;
    assert.equal(WorkspaceManager.duplicateProject(projectId,clone),true);
    assert.ok(ProjectFileIndex.get(clone,'src/c.ts'));
    cleanup(clone);
    WorkspaceManager.deleteProject(clone);
  } finally { cleanup(projectId); WorkspaceManager.deleteProject(projectId); }
});

test('phase1 ContextPack is immutable history and recompiles after project hash changes with explicit omissions', () => {
  const projectId=`phase1-stale-${safeIdSuffix()}`;
  try {
    ContextEngineV2.syncProject({projectId,files:{'src/main.ts':'export const oldValue=1'}});
    const oldPack=ContextCompiler.compile({projectId,agentKey:'FORGE',scope:'TASK',task:{objective:'alterar main'},focusPaths:['src/main.ts'],tokenBudget:5000});
    ContextEngineV2.syncProject({projectId,files:{'src/main.ts':'export const newValue=2'}});
    const newPack=ContextCompiler.compile({projectId,agentKey:'FORGE',scope:'TASK',task:{objective:'alterar main'},focusPaths:['src/main.ts'],tokenBudget:5000});
    assert.notEqual(oldPack.id,newPack.id);
    assert.notEqual(oldPack.projectHash,newPack.projectHash);
    assert.equal(ContextCompiler.get(oldPack.id)?.projectHash,oldPack.projectHash);

    const many:Record<string,string>={};
    for(let i=0;i<120;i++) many[`src/modules/file-${i}.ts`]=`export const value${i}='${'x'.repeat(100)}';`;
    ContextEngineV2.syncProject({projectId,files:many});
    const budgeted=ContextCompiler.compile({projectId,agentKey:'SCOUT',scope:'MICRO',task:{objective:'mapear módulos'},tokenBudget:300});
    assert.ok(budgeted.omittedFiles.length>0);
    assert.ok(budgeted.omittedFiles.every(file=>file.reason==='budget_exhausted'));
  } finally { cleanup(projectId); }
});
