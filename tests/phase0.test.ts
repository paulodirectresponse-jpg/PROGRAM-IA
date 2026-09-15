import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase, db } from '../server/db/index.js';
import { LLMAdapterService } from '../server/services/llmAdapter.js';
import { ProgressRetryController } from '../server/services/progressRetryController.js';
import { RequirementLedgerService } from '../server/services/requirementLedgerService.js';
import { RunService } from '../server/services/runService.js';
import { AGENT_CONTRACTS } from '../server/agent-engine/agentContracts.js';
import { ModelRouter } from '../server/services/modelRouter.js';

initializeDatabase();

test('phase0 plan schema preserves architecture and more than eight files', () => {
  const newFiles=Array.from({length:24},(_,i)=>`src/features/f${i+1}.ts`);
  const parsed=LLMAdapterService.extractPlan(JSON.stringify({
    type:'plan',
    plan:{
      objective:'Construir aplicação modular',
      scope_in:'features completas',
      scope_out:'deploy',
      architecture_summary:'React + módulos de domínio e serviços',
      existing_files_to_modify:['package.json'],
      new_files_to_create:newFiles,
      files_to_delete:['legacy.ts'],
      integrations:[],
      risks:[],
      acceptance_criteria:['Cadastro funcional','Venda funcional'],
      requirements:[
        {id:'REQ-001',title:'Cadastro funcional',description:'Criar produto',priority:'critical',verification:['criar e persistir produto']},
        {id:'REQ-002',title:'Venda funcional',description:'Registrar venda',priority:'critical',verification:['reduzir estoque e registrar caixa']},
      ],
      task_graph:[
        {id:'TASK-001',title:'Domínio de produtos',requirement_ids:['REQ-001'],depends_on:[]},
        {id:'TASK-002',title:'Fluxo de vendas',requirement_ids:['REQ-002'],depends_on:['TASK-001']},
      ],
    }
  }));
  assert.ok(parsed);
  assert.equal(parsed!.new_files_to_create.length,24);
  assert.equal(parsed!.files_affected.length,26);
  assert.match(parsed!.architecture_summary,/React/);
  assert.equal(parsed!.requirements[0].id,'REQ-001');
  assert.deepEqual(parsed!.task_graph[1].depends_on,['TASK-001']);
});

test('phase0 build target resolver has no eight-file hard cap', () => {
  const requested=Array.from({length:32},(_,i)=>`src/module-${i+1}.ts`);
  const targets=LLMAdapterService.resolveBuildTargets(requested,{},'');
  assert.equal(targets.length,32);
  assert.equal(new Set(targets).size,32);
});

test('phase0 preview-only index is not treated as implicit application architecture', () => {
  const targets=LLMAdapterService.resolveBuildTargets([],{
    'index.html':'<!doctype html><!-- forge-placeholder: preview-only; this file is NOT the required application architecture --><html></html>'
  },'construa o sistema');
  assert.deepEqual(targets,[]);
  const legacy=LLMAdapterService.resolveBuildTargets([],{'index.html':'<!doctype html><html><body>app real</body></html>'},'');
  assert.deepEqual(legacy,['index.html']);
  const complexLegacy=LLMAdapterService.resolveBuildTargets([],{'index.html':'<!doctype html><html><body>app real</body></html>'},'construa um sistema de fluxo de caixa, estoque, vendas e fornecedores');
  assert.deepEqual(complexLegacy,[]);
});

test('phase0 atomic builder emits live progress for every generated file', async (t) => {
  t.mock.method(LLMAdapterService,'executePrompt',async(options:any)=>{
    const target=String(options.prompt).match(/ARQUIVO ALVO:\s*([^\n]+)/)?.[1]?.trim() || 'unknown.ts';
    return {
      replyText:JSON.stringify({files:[{path:target,action:'create',content:`export const value = "${target}";`}]}),
      mode:'build',
      decisionType:'change',
      isDemonstrativeFallback:false,
      providerUsed:'Mock',
      modelUsed:'mock',
      hasErrors:false,
      build:{summary:'ok',explanation:'ok',files:[{path:target,action:'create',content:`export const value = "${target}";`}]},
      usage:{inputTokens:1,outputTokens:1,billedCostUsd:0},
    } as any;
  });
  const events:any[]=[];
  const files=['src/domain/Product.ts','src/services/products.ts','src/features/ProductForm.tsx'];
  const result=await LLMAdapterService.buildApprovedPlanReliably({
    projectId:'phase0-builder',
    providerKey:'mock',
    modelId:'mock',
    userId:'phase0-user',
    existingFiles:{},
    requestedFiles:files,
    objective:'Construir produtos',
    acceptanceCriteria:['Cadastro funcional'],
    onProgress:(event)=>{ events.push(event); },
  });
  assert.equal(result.hasErrors,false);
  assert.equal(result.build?.files.length,3);
  assert.deepEqual(events.filter(event=>event.type==='file_started').map(event=>event.path),files);
  assert.deepEqual(events.filter(event=>event.type==='file_completed').map(event=>event.path),files);
  assert.equal(events.at(-1)?.index,3);
  assert.equal(events.at(-1)?.total,3);
});

test('phase0 retry controller prevents blind repetition and recommends strategy changes', () => {
  const first={failureKind:'operational' as const,errorMessage:'upstream timeout 180000ms',strategy:'same_candidate'};
  const firstDecision=ProgressRetryController.decide(first,[],{attempt:1,maxAttempts:3,hasNextCandidate:false,canEscalate:true});
  assert.equal(firstDecision.retryAllowed,true);
  assert.equal(firstDecision.nextStrategy,'reduce_context');

  const repeated={...first,strategy:'reduce_context'};
  const secondDecision=ProgressRetryController.decide(repeated,[repeated],{attempt:2,maxAttempts:3,hasNextCandidate:false,canEscalate:true});
  assert.equal(secondDecision.retryAllowed,false);
  assert.equal(secondDecision.escalateAllowed,true);
  assert.equal(secondDecision.nextStrategy,'expert');
});

test('phase0 explicit agent contracts define non-overlapping responsibilities', () => {
  assert.equal(AGENT_CONTRACTS.SCOUT.key,'SCOUT');
  assert.ok(AGENT_CONTRACTS.SCOUT.requiredOutputs.includes('requirements'));
  assert.ok(AGENT_CONTRACTS.FORGE.requiredOutputs.includes('code_changes'));
  assert.ok(AGENT_CONTRACTS.SENTINEL.requiredOutputs.includes('requirement_results'));
  assert.ok(AGENT_CONTRACTS.SHIP.doneWhen.some(item=>/gates/i.test(item)));
});

test('phase0 requirement ledger persists progress evidence without treating implemented as verified', () => {
  const unique=Date.now().toString(36)+Math.random().toString(36).slice(2);
  const projectId=`phase0-project-${unique}`;
  const planId=`phase0-plan-${unique}`;
  const runId=`phase0-run-${unique}`;
  try {
    const rows=RequirementLedgerService.syncPlan({
      projectId,
      planId,
      requirements:[
        {id:'REQ-001',title:'Cadastrar produto',description:'CRUD',priority:'critical',verification:['produto persiste']},
        {id:'REQ-002',title:'Registrar venda',description:'Venda',priority:'critical',verification:['estoque reduz']},
      ],
    });
    assert.equal(rows.length,2);
    assert.ok(rows.every(row=>row.status==='pending'));
    RequirementLedgerService.attachRun(projectId,planId,runId);
    RequirementLedgerService.setStatusForRun(runId,'implemented',{type:'validator_unverified'},['src/products.ts']);
    const implemented=RequirementLedgerService.listByRun(runId);
    assert.ok(implemented.every(row=>row.status==='implemented'));
    assert.ok(implemented.every(row=>row.status!=='verified'));
    assert.deepEqual(implemented[0].files,['src/products.ts']);
    RequirementLedgerService.setStatusForRun(runId,'verified',{type:'browser_or_validator_pass'});
    const verified=RequirementLedgerService.listByRun(runId);
    assert.ok(verified.every(row=>row.status==='verified'));
    assert.ok(verified.every(row=>row.evidence.length===2));
  } finally {
    db.prepare('DELETE FROM requirements WHERE project_id=?').run(projectId);
  }
});

test('phase0 requirement ledger mirrors normalized plan requirements exactly', () => {
  const unique=Date.now().toString(36)+Math.random().toString(36).slice(2);
  const projectId=`phase0-ledger-mirror-${unique}`;
  const planId=`phase0-ledger-plan-${unique}`;
  try{
    const rows=RequirementLedgerService.syncPlan({
      projectId,planId,
      requirements:[
        {id:'req-001',title:'',description:'Fluxo de caixa',priority:'critical',verification:[]} as any,
        {id:'REQ-002',title:'Estoque',description:'Controlar estoque',priority:'invalid',verification:['estoque atualiza']} as any,
      ],
    });
    assert.equal(rows.length,2);
    assert.equal(rows[0].requirement_key,'REQ-001');
    assert.equal(rows[0].title,'Fluxo de caixa');
    assert.deepEqual(rows[0].verification,['Fluxo de caixa']);
    assert.equal(rows[1].priority,'high');

    const second=RequirementLedgerService.syncPlan({
      projectId,planId,
      requirements:[{id:'REQ-002',title:'Estoque atualizado',description:'Controlar estoque',priority:'high',verification:['estoque atualiza']}],
    });
    assert.equal(second.length,1);
    const coverage=RequirementLedgerService.verifyPlanSync(projectId,planId,[{id:'REQ-002',title:'Estoque atualizado',description:'Controlar estoque',priority:'high',verification:['estoque atualiza']}]);
    assert.equal(coverage.valid,true);
    assert.equal(coverage.persisted,1);

    assert.throws(()=>RequirementLedgerService.syncPlan({
      projectId,planId,
      requirements:[
        {id:'REQ-X',title:'A',description:'A',priority:'high',verification:['A']},
        {id:'REQ-X',title:'B',description:'B',priority:'high',verification:['B']},
      ],
    }),/duplicados/i);
  }finally{
    db.prepare('DELETE FROM requirements WHERE project_id=?').run(projectId);
  }
});

test('phase0 cost telemetry distinguishes unknown, explicit zero and reported cost', () => {
  const unique=Date.now().toString(36)+Math.random().toString(36).slice(2);
  const userId=`cost-user-${unique}`;
  const projectId=`cost-project-${unique}`;
  const conversationId=`cost-conv-${unique}`;
  const {runId,stepId}=RunService.start(userId,projectId,conversationId,'plan',0.5);
  try{
    ModelRouter.recordInvocation({
      userId,projectId,runId,stepId,agentKey:'SCOUT',profileKey:'EXPERT_PAID',
      providerKey:'paid',modelId:'model',latencyMs:100,status:'success',
      costStatus:'unknown',budgetCostUsd:0.25,
    });
    const unknown=db.prepare('SELECT cost_usd,cost_status,budget_cost_usd FROM model_invocations WHERE run_id=? ORDER BY created_at LIMIT 1').get(runId) as any;
    assert.equal(unknown.cost_usd,null);
    assert.equal(unknown.cost_status,'unknown');
    assert.equal(Number(unknown.budget_cost_usd),0.25);
    assert.equal(Number((db.prepare('SELECT spent_usd FROM agent_runs WHERE id=?').get(runId) as any).spent_usd),0.25);

    ModelRouter.recordInvocation({
      userId,projectId,runId,stepId,agentKey:'SCOUT',profileKey:'EXPERT_PAID',
      providerKey:'paid',modelId:'model',latencyMs:100,status:'success',
      costUsd:0,costStatus:'known_zero',budgetCostUsd:0.25,
    });
    ModelRouter.recordInvocation({
      userId,projectId,runId,stepId,agentKey:'SCOUT',profileKey:'EXPERT_PAID',
      providerKey:'paid',modelId:'model',latencyMs:100,status:'success',
      costUsd:0.02,costStatus:'reported',budgetCostUsd:0.25,
    });
    const rows=db.prepare('SELECT cost_usd,cost_status,budget_cost_usd FROM model_invocations WHERE run_id=? ORDER BY created_at').all(runId) as any[];
    assert.equal(rows[1].cost_status,'known_zero');
    assert.equal(Number(rows[1].budget_cost_usd),0);
    assert.equal(rows[2].cost_status,'reported');
    assert.equal(Number(rows[2].budget_cost_usd),0.02);
    assert.equal(Number((db.prepare('SELECT spent_usd FROM agent_runs WHERE id=?').get(runId) as any).spent_usd),0.27);
    assert.throws(()=>ModelRouter.assertBudget(userId,0.24,{runId}),/Orçamento/i);
  }finally{
    db.prepare('DELETE FROM model_invocations WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM agent_steps WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM agent_runs WHERE id=?').run(runId);
  }
});

test('phase0 database exposes truthful cost telemetry migration', () => {
  const migration=db.prepare('SELECT name FROM schema_migrations WHERE version=8').get() as any;
  assert.equal(migration?.name,'008_cost_telemetry_truthfulness');
  const cols=new Set((db.prepare('PRAGMA table_info(model_invocations)').all() as any[]).map(row=>row.name));
  assert.ok(cols.has('cost_status'));
  assert.ok(cols.has('budget_cost_usd'));
});

test('phase0 waiting approval and resume cannot leave stale running steps behind', () => {
  const unique=Date.now().toString(36)+Math.random().toString(36).slice(2);
  const {runId,stepId}=RunService.start(`u-${unique}`,`p-${unique}`,`c-${unique}`,'build',0.5);
  try {
    const forge=RunService.createStep(runId,'FORGE','Gerar proposta',undefined,'local',{});
    assert.equal((db.prepare('SELECT status FROM agent_steps WHERE id=?').get(forge) as any).status,'running');
    RunService.waitForApproval(runId);
    assert.equal((db.prepare('SELECT status FROM agent_runs WHERE id=?').get(runId) as any).status,'waiting_approval');
    assert.equal((db.prepare('SELECT status FROM agent_steps WHERE id=?').get(forge) as any).status,'aborted');
    RunService.resume(runId);
    assert.equal((db.prepare('SELECT status FROM agent_runs WHERE id=?').get(runId) as any).status,'running');
    assert.equal((db.prepare("SELECT COUNT(*) n FROM agent_steps WHERE run_id=? AND status='running'").get(runId) as any).n,0);
  } finally {
    db.prepare('DELETE FROM model_invocations WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM agent_steps WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM agent_runs WHERE id=?').run(runId);
  }
});

test('phase0 database exposes architecture plan columns and requirement ledger', () => {
  const planColumns=new Set((db.prepare('PRAGMA table_info(plans)').all() as any[]).map(row=>row.name));
  for(const column of ['architecture_summary','existing_files_json','new_files_json','files_to_delete_json','requirements_json','task_graph_json']){
    assert.ok(planColumns.has(column),`missing plans.${column}`);
  }
  const requirementColumns=new Set((db.prepare('PRAGMA table_info(requirements)').all() as any[]).map(row=>row.name));
  for(const column of ['requirement_key','status','verification_json','files_json','evidence_json']){
    assert.ok(requirementColumns.has(column),`missing requirements.${column}`);
  }
});
