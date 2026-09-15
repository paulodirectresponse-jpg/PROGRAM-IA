import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db, initializeDatabase } from '../server/db/index.js';
import { PHASE4_BENCHMARK_CASES, PHASE4_SUITE_KEY } from '../server/benchmark/catalog.js';
import { scoreBenchmarkCase } from '../server/benchmark/scorer.js';
import { BenchmarkService } from '../server/benchmark/benchmarkService.js';
import { BenchmarkSmokeBootstrap, smokeBootstrapConfig } from '../server/benchmark/smokeBootstrap.js';

initializeDatabase();

test('phase4 server-side smoke configuration is hard-bounded and idempotent',async()=>{
  const migration12=db.prepare('SELECT name FROM schema_migrations WHERE version=12').get() as any;
  assert.equal(migration12?.name,'012_phase4_server_side_smoke_request');
  const smokeColumns=new Set((db.prepare('PRAGMA table_info(benchmark_smoke_requests)').all() as any[]).map(row=>row.name));
  for(const column of ['request_id','user_id','benchmark_run_id','status','max_cost_usd','case_ids_json','report_json'])assert.ok(smokeColumns.has(column));

  const cfg=smokeBootstrapConfig({
    FORGE_BENCHMARK_SMOKE_REQUEST_ID:'authorized-smoke',
    FORGE_BENCHMARK_SMOKE_MAX_USD:'1',
    FORGE_BENCHMARK_SMOKE_WAIT_FOR_BUDGET:'true',
    FORGE_BENCHMARK_SMOKE_MAX_WAIT_MINUTES:'999',
  } as any);
  assert.deepEqual(cfg?.caseIds,['P4-01','P4-11','P4-28']);
  assert.equal(cfg?.maxCostUsd,1);
  assert.equal(cfg?.waitForBudget,true);
  assert.equal(cfg?.maxWaitMinutes,720);
  assert.throws(()=>smokeBootstrapConfig({
    FORGE_BENCHMARK_SMOKE_REQUEST_ID:'too-expensive',
    FORGE_BENCHMARK_SMOKE_MAX_USD:'1.01',
  } as any),/US\$1\.00/);

  const requestId=`smoke-test-${crypto.randomUUID()}`;
  const before=Number((db.prepare('SELECT COUNT(*) c FROM benchmark_runs').get() as any).c||0);
  db.prepare(`INSERT INTO benchmark_smoke_requests(request_id,status,max_cost_usd,case_ids_json,created_at)
    VALUES(?,'completed',1,'["P4-01","P4-11","P4-28"]',?)`).run(requestId,new Date().toISOString());
  const prevId=process.env.FORGE_BENCHMARK_SMOKE_REQUEST_ID;
  const prevBudget=process.env.FORGE_BENCHMARK_SMOKE_MAX_USD;
  process.env.FORGE_BENCHMARK_SMOKE_REQUEST_ID=requestId;
  process.env.FORGE_BENCHMARK_SMOKE_MAX_USD='1';
  try{
    const result=await BenchmarkSmokeBootstrap.maybeStartFromEnv();
    assert.equal((result as any).skipped,true);
    const after=Number((db.prepare('SELECT COUNT(*) c FROM benchmark_runs').get() as any).c||0);
    assert.equal(after,before);
  }finally{
    if(prevId===undefined)delete process.env.FORGE_BENCHMARK_SMOKE_REQUEST_ID;else process.env.FORGE_BENCHMARK_SMOKE_REQUEST_ID=prevId;
    if(prevBudget===undefined)delete process.env.FORGE_BENCHMARK_SMOKE_MAX_USD;else process.env.FORGE_BENCHMARK_SMOKE_MAX_USD=prevBudget;
    db.prepare('DELETE FROM benchmark_smoke_requests WHERE request_id=?').run(requestId);
  }
});

test('phase4 migration and canonical benchmark catalog exist',()=>{
  const migration9=db.prepare('SELECT name FROM schema_migrations WHERE version=9').get() as any;
  const migration10=db.prepare('SELECT name FROM schema_migrations WHERE version=10').get() as any;
  const migration11=db.prepare('SELECT name FROM schema_migrations WHERE version=11').get() as any;
  assert.equal(migration9?.name,'009_phase4_benchmark_framework');
  assert.equal(migration10?.name,'010_phase4_benchmark_invocation_provenance');
  assert.equal(migration11?.name,'011_phase4_single_active_benchmark_per_user');
  const invocationColumns=new Set((db.prepare('PRAGMA table_info(model_invocations)').all() as any[]).map(row=>row.name));
  assert.ok(invocationColumns.has('benchmark_run_id'));
  assert.ok(invocationColumns.has('benchmark_case_id'));
  const caseColumns=new Set((db.prepare('PRAGMA table_info(benchmark_case_runs)').all() as any[]).map(row=>row.name));
  assert.ok(caseColumns.has('budget_cost_usd'));
  assert.ok(caseColumns.has('unknown_cost_calls'));
  const benchmarkIndexes=(db.prepare("PRAGMA index_list('benchmark_runs')").all() as any[]).map(row=>row.name);
  assert.ok(benchmarkIndexes.includes('benchmark_runs_one_active_user'));
  assert.equal(PHASE4_SUITE_KEY,'phase4-v1-30');
  assert.equal(PHASE4_BENCHMARK_CASES.length,30);
  assert.equal(new Set(PHASE4_BENCHMARK_CASES.map(item=>item.id)).size,30);
  assert.ok(PHASE4_BENCHMARK_CASES.some(item=>item.category==='planning'));
  assert.ok(PHASE4_BENCHMARK_CASES.some(item=>item.category==='context'));
  assert.ok(PHASE4_BENCHMARK_CASES.some(item=>item.category==='build'));
  assert.ok(PHASE4_BENCHMARK_CASES.some(item=>item.category==='visual'));
  assert.ok(PHASE4_BENCHMARK_CASES.some(item=>item.category==='repair'));
  assert.ok(PHASE4_BENCHMARK_CASES.some(item=>item.category==='review'));
});

test('phase4 public catalog never exposes fixture source contents',()=>{
  const catalog=BenchmarkService.catalog();
  assert.equal(catalog.total,30);
  assert.equal((catalog.cases[0] as any).fixtureFiles,undefined);
  assert.ok(catalog.cases.every(item=>Number((item as any).fixtureFileCount)>0));
});

test('phase4 scorer requires a real provider even when structural output is good',()=>{
  const definition=PHASE4_BENCHMARK_CASES.find(item=>item.id==='P4-01')!;
  const plan={
    objective:'Painel',scope_in:'UI e persistência',scope_out:'deploy',architecture_summary:'UI estado persistência',
    existing_files_to_modify:['index.html'],new_files_to_create:['src/ui.ts'],files_to_delete:[],files_affected:['index.html','src/ui.ts'],
    integrations:[],risks:[],acceptance_criteria:['UI funciona','persistência funciona','estado isolado'],
    requirements:[
      {id:'REQ-001',title:'UI',description:'UI',priority:'high' as const,verification:['teste']},
      {id:'REQ-002',title:'Persist',description:'Persist',priority:'high' as const,verification:['teste']},
      {id:'REQ-003',title:'Estado',description:'Estado',priority:'high' as const,verification:['teste']},
    ],
    task_graph:[
      {id:'TASK-001',title:'UI',requirement_ids:['REQ-001'],depends_on:[]},
      {id:'TASK-002',title:'Persist',requirement_ids:['REQ-002','REQ-003'],depends_on:['TASK-001']},
    ],
  };
  const result:any={replyText:'ok',mode:'plan',isDemonstrativeFallback:false,providerUsed:'Mock',modelUsed:'real-model',decisionType:'plan',plan};
  const scored=scoreBenchmarkCase({definition,result,providerReal:false});
  assert.equal(scored.passed,false);
  assert.ok(scored.score<100);
  assert.equal(scored.checks.find(item=>item.key==='real_provider')?.passed,false);
});

test('phase4 scorer passes deterministic review evidence from a real provider',()=>{
  const definition=PHASE4_BENCHMARK_CASES.find(item=>item.id==='P4-28')!;
  const result:any={replyText:'PHASE4_REVIEW_28 ocorre em src/app.js por acesso a name quando user é null.',mode:'review',isDemonstrativeFallback:false,providerUsed:'Provider',modelUsed:'model',decisionType:'review'};
  const scored=scoreBenchmarkCase({definition,result,providerReal:true});
  assert.equal(scored.passed,true);
  assert.equal(scored.score,100);
});

test('phase4 review scorer rejects prompt echo without fixture-specific cause',()=>{
  const definition=PHASE4_BENCHMARK_CASES.find(item=>item.id==='P4-28')!;
  const result:any={replyText:'PHASE4_REVIEW_28 está em src/app.js.',mode:'review',isDemonstrativeFallback:false,providerUsed:'Provider',modelUsed:'model',decisionType:'review'};
  const scored=scoreBenchmarkCase({definition,result,providerReal:true});
  assert.equal(scored.passed,false);
  assert.equal(scored.checks.find(item=>item.key==='review_semantics')?.passed,false);
});

test('phase4 scorer enforces build scope, content and browser gate',()=>{
  const definition=PHASE4_BENCHMARK_CASES.find(item=>item.id==='P4-11')!;
  const result:any={
    replyText:'feito',mode:'build',isDemonstrativeFallback:false,providerUsed:'Provider',modelUsed:'model',decisionType:'change',
    proposal:{files:[{path:'index.html',action:'modify',content:'<main data-testid="phase4-hello">Olá Fase 4</main>'}]},
  };
  const passed=scoreBenchmarkCase({
    definition,result,providerReal:true,changedPaths:['index.html'],
    finalFiles:{'index.html':'<main data-testid="phase4-hello">Olá Fase 4</main>'},
    apply:{success:true,validation:{status:'passed'},browserQuality:{status:'passed'}},
  });
  assert.equal(passed.passed,true);

  const badBrowser=scoreBenchmarkCase({
    definition,result,providerReal:true,changedPaths:['index.html'],
    finalFiles:{'index.html':'<main data-testid="phase4-hello">Olá Fase 4</main>'},
    apply:{success:true,validation:{status:'passed'},browserQuality:{status:'failed'}},
  });
  assert.equal(badBrowser.passed,false);
});

test('phase4 benchmark refuses real-provider spend without explicit confirmation',()=>{
  assert.throws(
    ()=>BenchmarkService.start({userId:`no-provider-${crypto.randomUUID()}`,maxCostUsd:0.1,confirmRealProviderCosts:false}),
    (error:any)=>error?.code==='benchmark_cost_confirmation_required'
  );
});

test('phase4 benchmark refuses to fake a real run when no configured provider exists',()=>{
  assert.throws(
    ()=>BenchmarkService.start({userId:`no-provider-${crypto.randomUUID()}`,maxCostUsd:0.1,confirmRealProviderCosts:true}),
    (error:any)=>error?.code==='benchmark_no_real_provider'
  );
});

test('phase4 startup recovery marks in-flight benchmark state interrupted',()=>{
  const id=`bench-test-${crypto.randomUUID()}`,caseId=`bench-case-${crypto.randomUUID()}`,created=new Date().toISOString();
  try{
    db.prepare(`INSERT INTO benchmark_runs(id,user_id,suite_key,status,total_cases,max_cost_usd,allow_expert,config_json,summary_json,created_at,started_at)
      VALUES(?,?,?,'running',1,0.1,0,'{}','{}',?,?)`).run(id,'phase4-recovery-user',PHASE4_SUITE_KEY,created,created);
    db.prepare(`INSERT INTO benchmark_case_runs(id,benchmark_run_id,case_id,case_order,category,mode,agent_key,status,created_at,started_at)
      VALUES(?,?,?,?,?,?,?,'running',?,?)`).run(caseId,id,'P4-01',0,'planning','plan','SCOUT',created,created);
    const recovery=BenchmarkService.recoverStartup();
    assert.ok(recovery.interrupted>=1);
    assert.equal((db.prepare('SELECT status FROM benchmark_runs WHERE id=?').get(id) as any).status,'interrupted');
    assert.equal((db.prepare('SELECT status FROM benchmark_case_runs WHERE id=?').get(caseId) as any).status,'interrupted');
  }finally{
    db.prepare('DELETE FROM benchmark_case_runs WHERE benchmark_run_id=?').run(id);
    db.prepare('DELETE FROM benchmark_runs WHERE id=?').run(id);
  }
});


test('phase4 database prevents two concurrent paid benchmark runs for one user',()=>{
  const userId=`phase4-concurrency-${crypto.randomUUID()}`;
  const first=`bench-${crypto.randomUUID()}`,second=`bench-${crypto.randomUUID()}`,created=new Date().toISOString();
  try{
    db.prepare(`INSERT INTO benchmark_runs(id,user_id,suite_key,status,total_cases,max_cost_usd,allow_expert,config_json,summary_json,created_at)
      VALUES(?,?,?,'running',30,1,0,'{}','{}',?)`).run(first,userId,PHASE4_SUITE_KEY,created);
    assert.throws(()=>db.prepare(`INSERT INTO benchmark_runs(id,user_id,suite_key,status,total_cases,max_cost_usd,allow_expert,config_json,summary_json,created_at)
      VALUES(?,?,?,'queued',30,1,0,'{}','{}',?)`).run(second,userId,PHASE4_SUITE_KEY,created),/UNIQUE/);
  }finally{
    db.prepare('DELETE FROM benchmark_runs WHERE user_id=?').run(userId);
  }
});

test('phase4 release gate only approves a complete thirty-case real-provider run',()=>{
  const userId=`phase4-gate-${crypto.randomUUID()}`,runId=`bench-${crypto.randomUUID()}`,created=new Date().toISOString();
  const categoryBreakdown:any={};
  for(const definition of PHASE4_BENCHMARK_CASES){
    categoryBreakdown[definition.category]||={cases:0,passed:0,averageScore:100};
    categoryBreakdown[definition.category].cases++;
    categoryBreakdown[definition.category].passed++;
  }
  const summary={
    totalCases:30,completedCases:30,passedCases:30,failedCases:0,passRate:1,averageScore:100,
    firstPassRate:1,expertEscalationRate:0,repairRate:0,verifiedRate:1,totalCostUsd:.5,budgetCostUsd:.5,unknownCostCalls:0,averageLatencyMs:100,
    providerBreakdown:{real:{cases:30,costUsd:.5,budgetCostUsd:.5,unknownCostCalls:0,passed:30}},categoryBreakdown,
  };
  try{
    db.prepare(`INSERT INTO benchmark_runs(id,user_id,suite_key,status,total_cases,completed_cases,passed_cases,failed_cases,max_cost_usd,spent_usd,allow_expert,config_json,summary_json,created_at,started_at,finished_at)
      VALUES(?,?,?,'completed',30,30,30,0,1,.5,0,'{}',?,?,?,?)`).run(runId,userId,PHASE4_SUITE_KEY,JSON.stringify(summary),created,created,created);
    PHASE4_BENCHMARK_CASES.forEach((definition,index)=>{
      db.prepare(`INSERT INTO benchmark_case_runs(id,benchmark_run_id,case_id,case_order,category,mode,agent_key,status,score,passed,provider_real,provider_key,model_id,cost_usd,attempts,repairs,expert_escalations,evidence_json,created_at,finished_at)
        VALUES(?,?,?,?,?,?,?,'passed',100,1,1,'real','model',.01,1,0,0,'{}',?,?)`).run(
          `case-${crypto.randomUUID()}`,runId,definition.id,index,definition.category,definition.mode,definition.agentKey,created,created
        );
    });
    const gate=BenchmarkService.releaseGate(runId,userId);
    assert.equal(gate?.eligible,true);
    assert.equal(gate?.passed,true);
    assert.equal(gate?.version,'phase4-release-gate-v1');
    db.prepare("UPDATE benchmark_case_runs SET provider_real=0 WHERE benchmark_run_id=? AND case_id='P4-30'").run(runId);
    const invalid=BenchmarkService.releaseGate(runId,userId);
    assert.equal(invalid?.eligible,false);
    assert.equal(invalid?.passed,false);
  }finally{
    db.prepare('DELETE FROM benchmark_case_runs WHERE benchmark_run_id=?').run(runId);
    db.prepare('DELETE FROM benchmark_runs WHERE id=?').run(runId);
  }
});
