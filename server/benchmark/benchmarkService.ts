import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/index.js';
import { AgentEngine } from '../agent-engine/agentEngine.js';
import { BrowserQualityService } from '../browser/browserQualityService.js';
import { LLMAdapterService } from '../services/llmAdapter.js';
import { ModelRouter } from '../services/modelRouter.js';
import { RunService } from '../services/runService.js';
import { RuntimeManager } from '../services/runtimeManager.js';
import { WorkspaceManager } from '../services/workspaceManager.js';
import { SandboxManager } from '../tooling/sandboxManager.js';
import { SandboxProposalApplyService } from '../tooling/sandboxProposalApplyService.js';
import { PHASE4_BENCHMARK_CASES, PHASE4_SUITE_KEY } from './catalog.js';
import { scoreBenchmarkCase } from './scorer.js';
import type { BenchmarkCaseDefinition, BenchmarkRunSummary, BenchmarkStatus } from './types.js';

const activeRuns=new Map<string,AbortController>();
const DAILY_MODEL_BUDGET_USD=3;
const MAX_BENCHMARK_COST_USD=3;

function now(){return new Date().toISOString();}
function parseJson<T>(value:unknown,fallback:T):T{try{return typeof value==='string'?JSON.parse(value):((value as T)??fallback);}catch{return fallback;}}
function roundMoney(value:number){return Math.round(value*1_000_000)/1_000_000;}

function redactBenchmarkEvidence(value:string){
  return String(value||'')
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{12,}\b/g,'[REDACTED]')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/ig,'$1[REDACTED]')
    .replace(/\b(API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)\s*[:=]\s*[^\s&]+/ig,'$1=[REDACTED]');
}
function safeArtifactSegment(value:string){
  const clean=String(value||'');
  if(!/^[A-Za-z0-9._-]+$/.test(clean))throw new Error('Invalid benchmark artifact segment.');
  return clean;
}
function benchmarkArtifactRoot(){
  return path.resolve(process.env.FORGE_DATA_DIR||path.join(process.cwd(),'.data'),'benchmark-evidence');
}
function benchmarkScreenshotFile(userId:string,benchmarkRunId:string,caseId:string,viewport:string){
  const segments=[userId,benchmarkRunId,caseId,viewport].map(safeArtifactSegment);
  const root=benchmarkArtifactRoot();
  const file=path.resolve(root,segments[0],segments[1],segments[2],`${segments[3]}.png`);
  if(!file.startsWith(root+path.sep))throw new Error('Invalid benchmark artifact path.');
  return file;
}
function persistBrowserEvidence(userId:string,benchmarkRunId:string,caseId:string,browserQuality:any){
  if(!browserQuality)return null;
  const source=browserQuality?.id?BrowserQualityService.get(String(browserQuality.id))||browserQuality:browserQuality;
  const viewports=Array.isArray(source.viewports)?source.viewports.map((viewport:any)=>{
    const {screenshotPath,...publicViewport}=viewport||{};
    let screenshotAvailable=false;
    if(screenshotPath&&fs.existsSync(screenshotPath)){
      try{
        const target=benchmarkScreenshotFile(userId,benchmarkRunId,caseId,String(viewport.name||'viewport'));
        fs.mkdirSync(path.dirname(target),{recursive:true});
        fs.copyFileSync(screenshotPath,target);
        screenshotAvailable=true;
      }catch{}
    }
    return {...publicViewport,screenshotAvailable};
  }):[];
  return {
    id:source.id||null,
    status:source.status||null,
    runtimeKind:source.runtimeKind||null,
    framework:source.framework||null,
    entryPath:source.entryPath||null,
    url:source.url||null,
    issues:Array.isArray(source.issues)?source.issues:[],
    viewports,
    durationMs:Number(source.durationMs||0),
    reason:source.reason||null,
    createdAt:source.createdAt||null,
  };
}
function benchmarkModelOutputExcerpt(definition:BenchmarkCaseDefinition,result:any){
  const payload=definition.mode==='review'
    ? String(result.replyText||'')
    : definition.mode==='plan'
      ? JSON.stringify(result.plan||{})
      : JSON.stringify({proposal:result.proposal||null,build:result.build||null});
  return redactBenchmarkEvidence(payload).slice(0,12000);
}
function benchmarkCheckedFiles(definition:BenchmarkCaseDefinition,files:Record<string,string>){
  const paths=[...new Set([
    ...(definition.checks.requiredPaths||[]),
    ...(definition.checks.content||[]).map(item=>item.path),
  ])];
  return Object.fromEntries(paths.map(file=>[file,redactBenchmarkEvidence(String(files[file]??'')).slice(0,8000)]));
}

function publicRun(row:any){
  return {
    id:row.id,userId:row.user_id,suiteKey:row.suite_key,status:row.status,totalCases:Number(row.total_cases||0),
    completedCases:Number(row.completed_cases||0),passedCases:Number(row.passed_cases||0),failedCases:Number(row.failed_cases||0),
    maxCostUsd:Number(row.max_cost_usd||0),spentUsd:Number(row.spent_usd||0),allowExpert:Boolean(row.allow_expert),
    config:parseJson(row.config_json,{}),summary:parseJson(row.summary_json,{}),createdAt:row.created_at,
    startedAt:row.started_at||null,finishedAt:row.finished_at||null,
  };
}

function publicCase(row:any){
  return {
    id:row.id,benchmarkRunId:row.benchmark_run_id,caseId:row.case_id,order:Number(row.case_order),category:row.category,
    mode:row.mode,agentKey:row.agent_key,status:row.status,score:Number(row.score||0),passed:Boolean(row.passed),
    profileKey:row.profile_key||null,providerKey:row.provider_key||null,modelId:row.model_id||null,
    providerReal:Boolean(row.provider_real),costUsd:Number(row.cost_usd||0),latencyMs:Number(row.latency_ms||0),
    inputTokens:Number(row.input_tokens||0),outputTokens:Number(row.output_tokens||0),attempts:Number(row.attempts||0),
    repairs:Number(row.repairs||0),expertEscalations:Number(row.expert_escalations||0),validatorStatus:row.validator_status||null,
    browserStatus:row.browser_status||null,failureReason:row.failure_reason||null,evidence:parseJson(row.evidence_json,{}),
    createdAt:row.created_at,startedAt:row.started_at||null,finishedAt:row.finished_at||null,
  };
}

function configuredCandidates(userId:string,profile:'BASE_FREE'|'EXPERT_PAID'){
  return ModelRouter.candidates(userId,profile)
    .filter(candidate=>LLMAdapterService.getProviderConfig(candidate.provider_key,userId).isConfigured);
}

function reserveForNextCase(userId:string,allowExpert:boolean){
  const base=configuredCandidates(userId,'BASE_FREE')[0] as any;
  const expert=allowExpert?(configuredCandidates(userId,'EXPERT_PAID')[0] as any):null;
  if(base)return Math.max(0.01,Number(base.max_cost_usd||0));
  if(expert)return Math.max(0.01,Number(expert.max_cost_usd||0));
  return Number.POSITIVE_INFINITY;
}

function createEphemeralProject(userId:string,benchmarkRunId:string,definition:BenchmarkCaseDefinition){
  const projectId=`bench-${crypto.randomUUID()}`;
  const createdAt=now();
  db.prepare(`INSERT INTO projects(id,user_id,workspace_id,name,description,origin,status,created_at,updated_at)
    VALUES(?,?,?,?,?,'benchmark','archived',?,?)`).run(
      projectId,userId,`benchmark-${benchmarkRunId}`,`Benchmark ${definition.id}`,
      'Projeto temporário isolado da suíte Phase 4.',createdAt,createdAt
    );
  for(const [file,content] of Object.entries(definition.fixtureFiles))WorkspaceManager.writeFile(projectId,file,content);
  return projectId;
}

async function cleanupEphemeralProject(projectId:string,userId:string){
  try{await RuntimeManager.stop(projectId);}catch{}
  try{BrowserQualityService.cleanupProject(projectId,userId);}catch{}
  const sandboxes=db.prepare('SELECT id FROM sandboxes WHERE project_id=?').all(projectId) as Array<{id:string}>;
  for(const sandbox of sandboxes){try{SandboxManager.cleanup(sandbox.id,userId);}catch{}}
  const runIds=db.prepare('SELECT id FROM agent_runs WHERE project_id=?').all(projectId) as Array<{id:string}>;
  for(const run of runIds){
    // Model invocations are intentionally retained for truthful daily-cost accounting.
    // Benchmark linkage/project nulling happens before project cleanup.
    db.prepare('DELETE FROM tool_executions WHERE run_id=?').run(run.id);
    db.prepare('DELETE FROM agent_steps WHERE run_id=?').run(run.id);
  }
  db.prepare('DELETE FROM requirements WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM context_packs WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM context_commits WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM context_architecture_graphs WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM context_project_files WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM sandboxes WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM verifications WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM file_changes WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM checkpoints WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM deployments WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM logs WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM plans WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM tasks WHERE project_id=?').run(projectId);
  const conversations=db.prepare('SELECT id FROM conversations WHERE project_id=?').all(projectId) as Array<{id:string}>;
  for(const conversation of conversations)db.prepare('DELETE FROM messages WHERE conversation_id=?').run(conversation.id);
  db.prepare('DELETE FROM conversations WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM repositories WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM branches WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM project_sources WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM agent_runs WHERE project_id=?').run(projectId);
  try{WorkspaceManager.deleteProject(projectId);}catch{}
  db.prepare('DELETE FROM projects WHERE id=?').run(projectId);
}

function aggregate(runId:string):BenchmarkRunSummary{
  const rows=db.prepare('SELECT * FROM benchmark_case_runs WHERE benchmark_run_id=? ORDER BY case_order').all(runId) as any[];
  const completed=rows.filter(row=>['passed','failed'].includes(row.status));
  const passed=completed.filter(row=>Number(row.passed)===1);
  const firstPass=completed.filter(row=>Number(row.attempts)<=1&&Number(row.repairs)===0);
  const expert=completed.filter(row=>Number(row.expert_escalations)>0);
  const repaired=completed.filter(row=>Number(row.repairs)>0);
  const verified=completed.filter(row=>row.validator_status==='passed'||row.browser_status==='passed'||['plan','review'].includes(row.mode));
  const totalCost=rows.reduce((sum,row)=>sum+Number(row.cost_usd||0),0);
  const avgScore=completed.length?completed.reduce((sum,row)=>sum+Number(row.score||0),0)/completed.length:0;
  const avgLatency=completed.length?completed.reduce((sum,row)=>sum+Number(row.latency_ms||0),0)/completed.length:0;
  const providerBreakdown:BenchmarkRunSummary['providerBreakdown']={};
  const categoryBreakdown:BenchmarkRunSummary['categoryBreakdown']={};
  for(const row of completed){
    const provider=String(row.provider_key||'unknown');
    providerBreakdown[provider]||={cases:0,costUsd:0,passed:0};
    providerBreakdown[provider].cases++;
    providerBreakdown[provider].costUsd=roundMoney(providerBreakdown[provider].costUsd+Number(row.cost_usd||0));
    if(Number(row.passed)===1)providerBreakdown[provider].passed++;
    const category=String(row.category);
    categoryBreakdown[category]||={cases:0,passed:0,averageScore:0};
    const entry=categoryBreakdown[category];
    entry.averageScore=(entry.averageScore*entry.cases+Number(row.score||0))/(entry.cases+1);
    entry.cases++;
    if(Number(row.passed)===1)entry.passed++;
  }
  for(const entry of Object.values(categoryBreakdown))entry.averageScore=Math.round(entry.averageScore*10)/10;
  return {
    totalCases:rows.length,completedCases:completed.length,passedCases:passed.length,failedCases:completed.length-passed.length,
    passRate:completed.length?passed.length/completed.length:0,averageScore:Math.round(avgScore*10)/10,
    firstPassRate:completed.length?firstPass.length/completed.length:0,
    expertEscalationRate:completed.length?expert.length/completed.length:0,
    repairRate:completed.length?repaired.length/completed.length:0,
    verifiedRate:completed.length?verified.length/completed.length:0,
    totalCostUsd:roundMoney(totalCost),averageLatencyMs:Math.round(avgLatency),providerBreakdown,categoryBreakdown,
  };
}

function updateRunSummary(runId:string,status?:BenchmarkStatus){
  const summary=aggregate(runId);
  const finished=status&&['completed','failed','interrupted','cancelled','budget_exhausted'].includes(status)?now():null;
  if(status){
    db.prepare(`UPDATE benchmark_runs SET status=?,completed_cases=?,passed_cases=?,failed_cases=?,spent_usd=?,summary_json=?,finished_at=COALESCE(?,finished_at) WHERE id=?`)
      .run(status,summary.completedCases,summary.passedCases,summary.failedCases,summary.totalCostUsd,JSON.stringify(summary),finished,runId);
  }else{
    db.prepare(`UPDATE benchmark_runs SET completed_cases=?,passed_cases=?,failed_cases=?,spent_usd=?,summary_json=? WHERE id=?`)
      .run(summary.completedCases,summary.passedCases,summary.failedCases,summary.totalCostUsd,JSON.stringify(summary),runId);
  }
  return summary;
}

function invocationMetrics(agentRunId:string){
  const invocations=db.prepare('SELECT * FROM model_invocations WHERE run_id=? ORDER BY created_at').all(agentRunId) as any[];
  const successes=invocations.filter(row=>row.status==='success');
  const provider=successes.at(-1)||invocations.at(-1);
  const steps=db.prepare('SELECT agent_key,title,attempt_count,scope_level FROM agent_steps WHERE run_id=?').all(agentRunId) as any[];
  return {
    providerReal:successes.length>0,
    profileKey:provider?.profile_key||null,providerKey:provider?.provider_key||null,modelId:provider?.model_id||null,
    costUsd:roundMoney(invocations.reduce((sum,row)=>sum+Number(row.cost_usd||0),0)),
    latencyMs:invocations.reduce((sum,row)=>sum+Number(row.latency_ms||0),0),
    inputTokens:invocations.reduce((sum,row)=>sum+Number(row.input_tokens||0),0),
    outputTokens:invocations.reduce((sum,row)=>sum+Number(row.output_tokens||0),0),
    attempts:invocations.length,
    repairs:steps.filter(row=>row.agent_key==='FORGE'&&/corrigir|repair/i.test(String(row.title))).length,
    expertEscalations:invocations.filter(row=>row.profile_key==='EXPERT_PAID').length,
    invocationEvidence:invocations.map(row=>({
      agentKey:row.agent_key,profileKey:row.profile_key,providerKey:row.provider_key,modelId:row.model_id,status:row.status,
      errorCode:row.error_code,retryIndex:Number(row.retry_index||0),latencyMs:Number(row.latency_ms||0),
      costUsd:Number(row.cost_usd||0),contextPackId:row.context_pack_id,contextScope:row.context_scope,
      contextTokens:Number(row.context_tokens||0),omittedFiles:Number(row.context_omitted_files_count||0),
    })),
  };
}

async function executeCase(runRow:any,caseRow:any,definition:BenchmarkCaseDefinition,signal:AbortSignal){
  const started=Date.now();
  const benchmarkRunId=String(runRow.id);
  const userId=String(runRow.user_id);
  let projectId:string|null=null;
  let agentRunId:string|null=null;
  db.prepare("UPDATE benchmark_case_runs SET status='running',started_at=?,failure_reason=NULL WHERE id=?").run(now(),caseRow.id);

  try{
    signal.throwIfAborted();
    projectId=createEphemeralProject(userId,benchmarkRunId,definition);
    db.prepare('UPDATE benchmark_case_runs SET project_id=? WHERE id=?').run(projectId,caseRow.id);

    const currentSpent=aggregate(benchmarkRunId).totalCostUsd;
    const remaining=Math.max(0,Number(runRow.max_cost_usd)-currentSpent);
    const reserve=reserveForNextCase(userId,Boolean(runRow.allow_expert));
    if(remaining+1e-9<reserve){
      db.prepare("UPDATE benchmark_case_runs SET status='budget_exhausted',failure_reason=?,finished_at=? WHERE id=?")
        .run(`remaining_budget_${remaining.toFixed(6)}_below_reserve_${reserve.toFixed(6)}`,now(),caseRow.id);
      return {budgetExhausted:true};
    }

    const run=RunService.start(userId,projectId,`benchmark:${benchmarkRunId}:${definition.id}`,definition.mode,remaining);
    agentRunId=run.runId;
    db.prepare('UPDATE benchmark_case_runs SET agent_run_id=? WHERE id=?').run(agentRunId,caseRow.id);
    RunService.finishStep(run.stepId,'completed',{benchmarkRunId,caseId:definition.id});

    const stepId=RunService.createStep(agentRunId,definition.agentKey,`Benchmark ${definition.id}: ${definition.title}`,undefined,definition.agentKey==='SENTINEL'?'micro':definition.agentKey==='STUDIO'?'local':'task',{
      benchmarkRunId,caseId:definition.id,category:definition.category,
    });

    const result=await AgentEngine.execute({
      prompt:definition.prompt,
      mode:definition.mode,
      projectId,
      existingFiles:WorkspaceManager.getAllFilesContent(projectId),
      appliedSkills:[],
      conversationHistory:[],
      userId,
      runId:agentRunId,
      stepId,
      focusPaths:definition.focusPaths||[],
      signal,
    },{
      profile:'BASE_FREE',
      forcedAgentKey:definition.agentKey,
      allowExpertEscalation:Boolean(runRow.allow_expert),
    });

    let apply:any=null;
    let changedPaths:string[]=(result.proposal?.files||result.build?.files||[]).map(file=>file.path);
    if(definition.mode==='build'){
      const proposal=result.proposal||(
        result.build?.files?.length
          ? {id:`bench-proposal-${crypto.randomUUID()}`,summary:result.build.summary,requiresConfirmation:true,status:'pending',files:result.build.files}
          : null
      );
      if(proposal){
        apply=await SandboxProposalApplyService.apply({
          userId,projectId,proposal,runId:agentRunId,summary:`Benchmark ${definition.id}`,originalRequest:definition.prompt,signal,
        });
        if(Array.isArray(apply.changedFiles))changedPaths=[...new Set([...changedPaths,...apply.changedFiles])];
      }
    }else{
      RunService.finishStep(stepId,'completed',{benchmarkRunId,caseId:definition.id,decisionType:result.decisionType});
      RunService.finish(agentRunId,stepId,'completed');
    }

    const metrics=invocationMetrics(agentRunId);
    const finalFiles=WorkspaceManager.getAllFilesContent(projectId);
    const scored=scoreBenchmarkCase({definition,result,providerReal:metrics.providerReal,finalFiles,changedPaths,apply});
    const failureReason=scored.passed?null:(
      result.errorReason||result.errorMessage||scored.checks.filter(item=>!item.passed).map(item=>item.key).join(',')
    );

    const browserEvidence=persistBrowserEvidence(userId,benchmarkRunId,definition.id,apply?.browserQuality);
    const evidence={
      suiteKey:PHASE4_SUITE_KEY,
      title:definition.title,
      checks:scored.checks,
      changedPaths,
      decisionType:result.decisionType||null,
      profileKey:result.profileKey,
      agentKey:result.agentKey,
      providerUsed:result.providerUsed,
      modelUsed:result.modelUsed,
      modelOutputExcerpt:benchmarkModelOutputExcerpt(definition,result),
      checkedFiles:benchmarkCheckedFiles(definition,finalFiles),
      validatorStatus:apply?.validation?.status||null,
      browserStatus:apply?.browserQuality?.status||null,
      browserQualityRunId:apply?.browserQuality?.id||null,
      browserEvidence,
      toolExecutions:Number((db.prepare('SELECT COUNT(*) c FROM tool_executions WHERE run_id=?').get(agentRunId) as any)?.c||0),
      contextPacks:Number((db.prepare('SELECT COUNT(*) c FROM context_packs WHERE run_id=?').get(agentRunId) as any)?.c||0),
      invocations:metrics.invocationEvidence,
    };

    db.prepare(`UPDATE benchmark_case_runs SET status=?,score=?,passed=?,provider_real=?,profile_key=?,provider_key=?,model_id=?,
      cost_usd=?,latency_ms=?,input_tokens=?,output_tokens=?,attempts=?,repairs=?,expert_escalations=?,validator_status=?,browser_status=?,
      failure_reason=?,evidence_json=?,finished_at=? WHERE id=?`).run(
      scored.passed?'passed':'failed',scored.score,scored.passed?1:0,metrics.providerReal?1:0,metrics.profileKey,metrics.providerKey,metrics.modelId,
      metrics.costUsd,Date.now()-started,metrics.inputTokens,metrics.outputTokens,metrics.attempts,metrics.repairs,metrics.expertEscalations,
      apply?.validation?.status||null,apply?.browserQuality?.status||null,failureReason,JSON.stringify(evidence),now(),caseRow.id
    );
    return {budgetExhausted:false};
  }catch(error:any){
    const aborted=signal.aborted||error?.name==='AbortError';
    let metrics:any={providerReal:false,profileKey:null,providerKey:null,modelId:null,costUsd:0,inputTokens:0,outputTokens:0,attempts:0,repairs:0,expertEscalations:0,invocationEvidence:[]};
    if(agentRunId){try{metrics=invocationMetrics(agentRunId);}catch{}}
    db.prepare(`UPDATE benchmark_case_runs SET status=?,provider_real=?,profile_key=?,provider_key=?,model_id=?,cost_usd=?,latency_ms=?,
      input_tokens=?,output_tokens=?,attempts=?,repairs=?,expert_escalations=?,failure_reason=?,evidence_json=?,finished_at=? WHERE id=?`).run(
      aborted?'interrupted':'failed',metrics.providerReal?1:0,metrics.profileKey,metrics.providerKey,metrics.modelId,metrics.costUsd,Date.now()-started,
      metrics.inputTokens,metrics.outputTokens,metrics.attempts,metrics.repairs,metrics.expertEscalations,
      String(error?.message||error).slice(0,1000),JSON.stringify({errorCode:error?.code||error?.kind||null,invocations:metrics.invocationEvidence}),now(),caseRow.id
    );
    if(aborted)throw error;
    return {budgetExhausted:false};
  }finally{
    if(agentRunId){
      try{
        db.prepare('UPDATE model_invocations SET benchmark_run_id=?,benchmark_case_id=?,project_id=NULL WHERE run_id=?')
          .run(benchmarkRunId,caseRow.id,agentRunId);
      }catch{}
    }
    if(projectId)await cleanupEphemeralProject(projectId,userId);
  }
}

export class BenchmarkService {
  static screenshotPath(benchmarkRunId:string,caseId:string,viewport:string,userId:string){
    const row=db.prepare(`SELECT c.case_id FROM benchmark_case_runs c JOIN benchmark_runs r ON r.id=c.benchmark_run_id WHERE r.id=? AND r.user_id=? AND c.case_id=?`)
      .get(benchmarkRunId,userId,caseId) as any;
    if(!row)return null;
    let file:string;
    try{file=benchmarkScreenshotFile(userId,benchmarkRunId,caseId,viewport);}catch{return null;}
    return fs.existsSync(file)?file:null;
  }
  static preflight(userId:string,allowExpert=false){
    const base=configuredCandidates(userId,'BASE_FREE').map((candidate:any)=>({
      providerKey:candidate.provider_key,modelId:candidate.model_id,maxCostUsd:Number(candidate.max_cost_usd||0),priority:Number(candidate.priority||0),
    }));
    const expert=allowExpert?configuredCandidates(userId,'EXPERT_PAID').map((candidate:any)=>({
      providerKey:candidate.provider_key,modelId:candidate.model_id,maxCostUsd:Number(candidate.max_cost_usd||0),priority:Number(candidate.priority||0),
    })):[];
    const startOfDay=new Date();startOfDay.setHours(0,0,0,0);
    const spentToday=ModelRouter.spent(userId,startOfDay.toISOString());
    return {
      suiteKey:PHASE4_SUITE_KEY,
      totalCases:PHASE4_BENCHMARK_CASES.length,
      realProviderRequired:true,
      baseCandidates:base,
      expertCandidates:expert,
      canRun:base.length>0||expert.length>0,
      minimumCaseReserveUsd:Number.isFinite(reserveForNextCase(userId,allowExpert))?reserveForNextCase(userId,allowExpert):null,
      dailyLimitUsd:DAILY_MODEL_BUDGET_USD,
      spentTodayUsd:roundMoney(spentToday),
      remainingDailyUsd:roundMoney(Math.max(0,DAILY_MODEL_BUDGET_USD-spentToday)),
      maxBenchmarkBudgetUsd:MAX_BENCHMARK_COST_USD,
    };
  }

  static releaseGate(id:string,userId:string){
    const run=this.get(id,userId);
    if(!run)return null;
    const cases=run.cases as any[];
    const summary=run.summary as BenchmarkRunSummary;
    const fullCatalog=new Set(PHASE4_BENCHMARK_CASES.map(item=>item.id));
    const fullSuite=run.totalCases===30&&cases.length===30&&cases.every(item=>fullCatalog.has(item.caseId));
    const allReal=cases.length===30&&cases.every(item=>item.providerReal===true);
    const repairsBounded=cases.every(item=>Number(item.repairs||0)<=2);
    const categoryFloor=Object.values(summary.categoryBreakdown||{}).every((entry:any)=>entry.cases>0&&(entry.passed/entry.cases)>=0.60);
    const criteria={
      completed:run.status==='completed'&&summary.completedCases===30,
      fullSuite,
      allRealProviders:allReal,
      passRate:(summary.passRate||0)>=0.80,
      averageScore:(summary.averageScore||0)>=80,
      verifiedRate:(summary.verifiedRate||0)>=0.90,
      categoryFloor,
      repairsBounded,
      withinBudget:Number(run.spentUsd)<=Number(run.maxCostUsd)+1e-9,
    };
    const eligible=criteria.completed&&criteria.fullSuite&&criteria.allRealProviders;
    return {
      version:'phase4-release-gate-v1',
      eligible,
      passed:eligible&&Object.values(criteria).every(Boolean),
      criteria,
      thresholds:{passRate:0.80,averageScore:80,verifiedRate:0.90,categoryPassRate:0.60,maxRepairsPerCase:2},
      summary,
    };
  }

  static catalog(){
    return {suiteKey:PHASE4_SUITE_KEY,total:PHASE4_BENCHMARK_CASES.length,cases:PHASE4_BENCHMARK_CASES.map(({fixtureFiles:_fixture,...item})=>({...item,fixtureFileCount:Object.keys(_fixture).length}))};
  }

  static start(input:{userId:string;maxCostUsd:number;confirmRealProviderCosts:boolean;allowExpert?:boolean;caseIds?:string[]}){
    const active=db.prepare("SELECT id FROM benchmark_runs WHERE user_id=? AND status IN ('queued','running') LIMIT 1").get(input.userId) as {id:string}|undefined;
    if(active)throw Object.assign(new Error('Já existe um benchmark pago em execução para este usuário.'),{code:'benchmark_already_running',benchmarkRunId:active.id});
    if(input.confirmRealProviderCosts!==true)throw Object.assign(new Error('Confirme explicitamente o uso de créditos reais dos providers.'),{code:'benchmark_cost_confirmation_required'});
    const maxCostUsd=Number(input.maxCostUsd);
    if(!Number.isFinite(maxCostUsd)||maxCostUsd<0.05||maxCostUsd>MAX_BENCHMARK_COST_USD)throw Object.assign(new Error('maxCostUsd deve estar entre US$0.05 e US$3.00.'),{code:'benchmark_invalid_budget'});
    ModelRouter.assertBudget(input.userId,maxCostUsd,{dailyLimit:DAILY_MODEL_BUDGET_USD});

    const base=configuredCandidates(input.userId,'BASE_FREE');
    const expert=input.allowExpert?configuredCandidates(input.userId,'EXPERT_PAID'):[];
    if(!base.length&&!expert.length)throw Object.assign(new Error('Nenhum provider real configurado nos perfis selecionados.'),{code:'benchmark_no_real_provider'});

    const requested=(input.caseIds||[]).map(String);
    const selected=requested.length
      ? PHASE4_BENCHMARK_CASES.filter(item=>requested.includes(item.id))
      : PHASE4_BENCHMARK_CASES;
    if(!selected.length||selected.length!==(requested.length||selected.length))throw Object.assign(new Error('caseIds contém caso inexistente ou duplicado.'),{code:'benchmark_invalid_cases'});

    const id=`bench-run-${crypto.randomUUID()}`,created=now();
    try{
      db.prepare(`INSERT INTO benchmark_runs(id,user_id,suite_key,status,total_cases,max_cost_usd,allow_expert,config_json,summary_json,created_at)
        VALUES(?,?,?,'queued',?,?,?,?,?,?)`).run(
        id,input.userId,PHASE4_SUITE_KEY,selected.length,maxCostUsd,input.allowExpert?1:0,
        JSON.stringify({caseIds:selected.map(item=>item.id),canonicalFullSuite:selected.length===PHASE4_BENCHMARK_CASES.length,realProvidersRequired:true}),
        JSON.stringify({}),created
      );
    }catch(error:any){
      if(/UNIQUE constraint failed: benchmark_runs\.user_id/i.test(String(error?.message||error))){
        throw Object.assign(new Error('Já existe um benchmark pago em execução para este usuário.'),{code:'benchmark_already_running'});
      }
      throw error;
    }
    selected.forEach((definition,index)=>{
      db.prepare(`INSERT INTO benchmark_case_runs(id,benchmark_run_id,case_id,case_order,category,mode,agent_key,status,created_at)
        VALUES(?,?,?,?,?,?,?,'pending',?)`).run(`bench-case-${crypto.randomUUID()}`,id,definition.id,index,definition.category,definition.mode,definition.agentKey,created);
    });

    const controller=new AbortController();
    activeRuns.set(id,controller);
    queueMicrotask(()=>{void this.execute(id,input.userId,controller).catch(()=>undefined);});
    return this.get(id,input.userId);
  }

  private static async execute(id:string,userId:string,controller:AbortController){
    const runRow=db.prepare('SELECT * FROM benchmark_runs WHERE id=? AND user_id=?').get(id,userId) as any;
    if(!runRow)return;
    db.prepare("UPDATE benchmark_runs SET status='running',started_at=COALESCE(started_at,?),finished_at=NULL WHERE id=?").run(now(),id);
    try{
      const rows=db.prepare("SELECT * FROM benchmark_case_runs WHERE benchmark_run_id=? AND status IN ('pending','interrupted') ORDER BY case_order").all(id) as any[];
      for(const row of rows){
        controller.signal.throwIfAborted();
        const current=db.prepare('SELECT * FROM benchmark_runs WHERE id=?').get(id) as any;
        const definition=PHASE4_BENCHMARK_CASES.find(item=>item.id===row.case_id);
        if(!definition)continue;
        const outcome=await executeCase(current,row,definition,controller.signal);
        const summary=updateRunSummary(id);
        if(outcome.budgetExhausted||summary.totalCostUsd>=Number(current.max_cost_usd)){
          const pending=db.prepare("SELECT id FROM benchmark_case_runs WHERE benchmark_run_id=? AND status='pending'").all(id) as Array<{id:string}>;
          for(const item of pending)db.prepare("UPDATE benchmark_case_runs SET status='budget_exhausted',failure_reason='benchmark_budget_exhausted',finished_at=? WHERE id=?").run(now(),item.id);
          updateRunSummary(id,'budget_exhausted');
          return;
        }
      }
      const final=aggregate(id);
      const caseStates=db.prepare('SELECT status FROM benchmark_case_runs WHERE benchmark_run_id=?').all(id) as Array<{status:string}>;
      const status:BenchmarkStatus=caseStates.some(row=>row.status==='interrupted')?'interrupted':'completed';
      updateRunSummary(id,status);
      if(status==='completed'&&final.completedCases===0)updateRunSummary(id,'failed');
    }catch(error:any){
      const aborted=controller.signal.aborted||error?.name==='AbortError';
      const status:BenchmarkStatus=aborted?'cancelled':'interrupted';
      db.prepare("UPDATE benchmark_case_runs SET status='interrupted',failure_reason=COALESCE(failure_reason,?),finished_at=COALESCE(finished_at,?) WHERE benchmark_run_id=? AND status='running'")
        .run(aborted?'benchmark_cancelled':'benchmark_worker_interrupted',now(),id);
      updateRunSummary(id,status);
    }finally{
      activeRuns.delete(id);
    }
  }

  static get(id:string,userId:string){
    const row=db.prepare('SELECT * FROM benchmark_runs WHERE id=? AND user_id=?').get(id,userId) as any;
    if(!row)return null;
    const cases=(db.prepare('SELECT * FROM benchmark_case_runs WHERE benchmark_run_id=? ORDER BY case_order').all(id) as any[]).map(publicCase);
    return {...publicRun(row),cases};
  }

  static list(userId:string){
    return (db.prepare('SELECT * FROM benchmark_runs WHERE user_id=? ORDER BY created_at DESC LIMIT 30').all(userId) as any[]).map(publicRun);
  }

  static cancel(id:string,userId:string){
    const row=db.prepare('SELECT status FROM benchmark_runs WHERE id=? AND user_id=?').get(id,userId) as any;
    if(!row)return null;
    const controller=activeRuns.get(id);
    if(controller)controller.abort();
    if(!controller&&['queued','running'].includes(row.status))updateRunSummary(id,'cancelled');
    return this.get(id,userId);
  }

  static resume(id:string,userId:string,input:{maxCostUsd?:number;confirmRealProviderCosts:boolean}){
    if(input.confirmRealProviderCosts!==true)throw Object.assign(new Error('Confirme explicitamente o uso de créditos reais dos providers.'),{code:'benchmark_cost_confirmation_required'});
    const row=db.prepare('SELECT * FROM benchmark_runs WHERE id=? AND user_id=?').get(id,userId) as any;
    if(!row)throw Object.assign(new Error('Benchmark não encontrado.'),{code:'benchmark_not_found'});
    if(activeRuns.has(id))return this.get(id,userId);
    if(!['interrupted','cancelled','budget_exhausted'].includes(row.status))throw Object.assign(new Error('Somente benchmark interrompido/cancelado/sem budget pode ser retomado.'),{code:'benchmark_not_resumable'});
    if(input.maxCostUsd!==undefined){
      const next=Number(input.maxCostUsd);
      if(!Number.isFinite(next)||next<Number(row.spent_usd)||next>MAX_BENCHMARK_COST_USD)throw Object.assign(new Error('Novo budget deve cobrir o gasto atual e não exceder US$3.00.'),{code:'benchmark_invalid_budget'});
      ModelRouter.assertBudget(userId,Math.max(0,next-Number(row.spent_usd||0)),{dailyLimit:DAILY_MODEL_BUDGET_USD});
      db.prepare('UPDATE benchmark_runs SET max_cost_usd=? WHERE id=?').run(next,id);
    }
    db.prepare("UPDATE benchmark_case_runs SET status='pending',failure_reason=NULL,finished_at=NULL WHERE benchmark_run_id=? AND status IN ('interrupted','budget_exhausted')").run(id);
    const controller=new AbortController();activeRuns.set(id,controller);
    queueMicrotask(()=>{void this.execute(id,userId,controller).catch(()=>undefined);});
    return this.get(id,userId);
  }

  static recoverStartup(){
    const interrupted=db.prepare("SELECT id,user_id FROM benchmark_runs WHERE status IN ('queued','running')").all() as Array<{id:string;user_id:string}>;
    const when=now();
    let recoveredCases=0;
    for(const row of interrupted){
      const cases=db.prepare("SELECT id,agent_run_id,project_id FROM benchmark_case_runs WHERE benchmark_run_id=? AND status='running'").all(row.id) as Array<{id:string;agent_run_id?:string;project_id?:string}>;
      for(const item of cases){
        let metrics:any=null;
        if(item.agent_run_id){
          try{
            metrics=invocationMetrics(item.agent_run_id);
            db.prepare('UPDATE model_invocations SET benchmark_run_id=?,benchmark_case_id=?,project_id=NULL WHERE run_id=?')
              .run(row.id,item.id,item.agent_run_id);
          }catch{}
        }
        db.prepare(`UPDATE benchmark_case_runs SET status='interrupted',provider_real=COALESCE(?,provider_real),profile_key=COALESCE(?,profile_key),
          provider_key=COALESCE(?,provider_key),model_id=COALESCE(?,model_id),cost_usd=MAX(cost_usd,?),latency_ms=MAX(latency_ms,?),
          input_tokens=MAX(input_tokens,?),output_tokens=MAX(output_tokens,?),attempts=MAX(attempts,?),repairs=MAX(repairs,?),
          expert_escalations=MAX(expert_escalations,?),failure_reason=COALESCE(failure_reason,'server_restart'),finished_at=COALESCE(finished_at,?)
          WHERE id=?`).run(
            metrics?.providerReal?1:null,metrics?.profileKey||null,metrics?.providerKey||null,metrics?.modelId||null,
            Number(metrics?.costUsd||0),Number(metrics?.latencyMs||0),Number(metrics?.inputTokens||0),Number(metrics?.outputTokens||0),
            Number(metrics?.attempts||0),Number(metrics?.repairs||0),Number(metrics?.expertEscalations||0),when,item.id
          );
        if(item.project_id)void cleanupEphemeralProject(item.project_id,row.user_id).catch(()=>undefined);
        recoveredCases++;
      }
      updateRunSummary(row.id,'interrupted');
    }
    return {interrupted:interrupted.length,recoveredCases};
  }
}
