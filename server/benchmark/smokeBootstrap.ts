import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { BenchmarkService } from './benchmarkService.js';

const SMOKE_CASE_IDS=['P4-01','P4-11','P4-28'] as const;
const TERMINAL=new Set(['completed','failed','cancelled','interrupted','budget_exhausted']);

function now(){return new Date().toISOString();}
function sleep(ms:number){return new Promise(resolve=>setTimeout(resolve,ms));}

export function smokeBootstrapConfig(env:NodeJS.ProcessEnv=process.env){
  const requestId=String(env.FORGE_BENCHMARK_SMOKE_REQUEST_ID||'').trim();
  if(!requestId)return null;
  const maxCostUsd=Number(env.FORGE_BENCHMARK_SMOKE_MAX_USD||'1');
  if(!Number.isFinite(maxCostUsd)||maxCostUsd<0.05||maxCostUsd>1){
    throw new Error('FORGE_BENCHMARK_SMOKE_MAX_USD deve estar entre US$0.05 e US$1.00.');
  }
  const waitForBudget=String(env.FORGE_BENCHMARK_SMOKE_WAIT_FOR_BUDGET||'false').toLowerCase()==='true';
  const rawWait=Number(env.FORGE_BENCHMARK_SMOKE_MAX_WAIT_MINUTES||'360');
  const maxWaitMinutes=Number.isFinite(rawWait)?Math.max(5,Math.min(720,Math.floor(rawWait))):360;
  return {requestId,maxCostUsd:Number(maxCostUsd.toFixed(4)),caseIds:[...SMOKE_CASE_IDS],waitForBudget,maxWaitMinutes};
}

function sanitizedReport(run:any){
  return {
    benchmarkRunId:run?.id||null,
    status:run?.status||null,
    totalCases:Number(run?.totalCases||0),
    completedCases:Number(run?.summary?.completedCases||0),
    passedCases:Number(run?.summary?.passedCases||0),
    failedCases:Number(run?.summary?.failedCases||0),
    passRate:Number(run?.summary?.passRate||0),
    averageScore:Number(run?.summary?.averageScore||0),
    knownCostUsd:Number(run?.summary?.totalCostUsd||0),
    budgetCostUsd:Number(run?.summary?.budgetCostUsd||run?.spentUsd||0),
    unknownCostCalls:Number(run?.summary?.unknownCostCalls||0),
    cases:(run?.cases||[]).map((item:any)=>({
      caseId:item.caseId,
      status:item.status,
      score:Number(item.score||0),
      passed:Boolean(item.passed),
      providerReal:Boolean(item.providerReal),
      profileKey:item.profileKey||null,
      providerKey:item.providerKey||null,
      modelId:item.modelId||null,
      costUsd:Number(item.costUsd||0),
      budgetCostUsd:Number(item.budgetCostUsd||0),
      unknownCostCalls:Number(item.unknownCostCalls||0),
      latencyMs:Number(item.latencyMs||0),
      attempts:Number(item.attempts||0),
      repairs:Number(item.repairs||0),
      expertEscalations:Number(item.expertEscalations||0),
      validatorStatus:item.validatorStatus||null,
      browserStatus:item.browserStatus||null,
      failureReason:item.failureReason||null,
    })),
  };
}

export class BenchmarkSmokeBootstrap {
  static resolveEligibleUsers(){
    const users=db.prepare('SELECT id FROM users ORDER BY created_at').all() as Array<{id:string}>;
    return users.map(({id})=>{
      try{return {userId:id,preflight:BenchmarkService.preflight(id,false)};}
      catch{return null;}
    }).filter((entry:any)=>entry&&entry.preflight?.canRun&&Array.isArray(entry.preflight.baseCandidates)&&entry.preflight.baseCandidates.length>0) as Array<{userId:string;preflight:any}>;
  }

  static async maybeStartFromEnv(){
    const config=smokeBootstrapConfig();
    if(!config)return {enabled:false};

    const existing=db.prepare('SELECT * FROM benchmark_smoke_requests WHERE request_id=?').get(config.requestId) as any;
    if(existing){
      if(existing.benchmark_run_id&&existing.user_id){
        const current=BenchmarkService.get(existing.benchmark_run_id,existing.user_id);
        if(current&&TERMINAL.has(String(current.status))){
          const report=sanitizedReport(current);
          db.prepare("UPDATE benchmark_smoke_requests SET status=?,report_json=?,finished_at=COALESCE(finished_at,?) WHERE request_id=?")
            .run(String(current.status),JSON.stringify(report),now(),config.requestId);
          console.log('FORGE_BENCHMARK_SMOKE_REPORT '+JSON.stringify({requestId:config.requestId,recovered:true,...report}));
          return {enabled:true,skipped:true,status:current.status,benchmarkRunId:existing.benchmark_run_id,report};
        }
      }
      console.log('FORGE_BENCHMARK_SMOKE_SKIP '+JSON.stringify({
        requestId:config.requestId,status:existing.status,benchmarkRunId:existing.benchmark_run_id||null,
      }));
      return {enabled:true,skipped:true,status:existing.status,benchmarkRunId:existing.benchmark_run_id||null};
    }

    const createdAt=now();
    db.prepare(`INSERT INTO benchmark_smoke_requests(
      request_id,status,max_cost_usd,case_ids_json,created_at
    ) VALUES(?, 'claimed', ?, ?, ?)`).run(config.requestId,config.maxCostUsd,JSON.stringify(config.caseIds),createdAt);

    try{
      const eligible=this.resolveEligibleUsers();
      if(eligible.length!==1){
        const reason=eligible.length===0?'no_unique_eligible_user':'multiple_eligible_users';
        db.prepare("UPDATE benchmark_smoke_requests SET status='failed_preflight',report_json=?,finished_at=? WHERE request_id=?")
          .run(JSON.stringify({reason,eligibleCount:eligible.length}),now(),config.requestId);
        console.error('FORGE_BENCHMARK_SMOKE_PREFLIGHT_FAILED '+JSON.stringify({
          requestId:config.requestId,reason,eligibleCount:eligible.length,
        }));
        return {enabled:true,status:'failed_preflight',reason,eligibleCount:eligible.length};
      }

      const userId=eligible[0].userId;
      let preflight=eligible[0].preflight;
      let remaining=Number(preflight.remainingDailyUsd||0);
      let effectiveBudget=Math.min(config.maxCostUsd,remaining);
      if(!Number.isFinite(effectiveBudget)||effectiveBudget<0.05){
        if(!config.waitForBudget){
          const reason='insufficient_daily_budget';
          db.prepare("UPDATE benchmark_smoke_requests SET user_id=?,status='failed_preflight',report_json=?,finished_at=? WHERE request_id=?")
            .run(userId,JSON.stringify({reason,remainingDailyUsd:remaining}),now(),config.requestId);
          console.error('FORGE_BENCHMARK_SMOKE_PREFLIGHT_FAILED '+JSON.stringify({requestId:config.requestId,reason,remainingDailyUsd:remaining}));
          return {enabled:true,status:'failed_preflight',reason};
        }

        db.prepare("UPDATE benchmark_smoke_requests SET user_id=?,status='waiting_budget',report_json=? WHERE request_id=?")
          .run(userId,JSON.stringify({reason:'waiting_daily_budget_reset',remainingDailyUsd:remaining,maxWaitMinutes:config.maxWaitMinutes}),config.requestId);
        console.log('FORGE_BENCHMARK_SMOKE_WAITING_BUDGET '+JSON.stringify({
          requestId:config.requestId,remainingDailyUsd:remaining,maxWaitMinutes:config.maxWaitMinutes,
        }));

        const maxPolls=config.maxWaitMinutes;
        let ready=false;
        for(let poll=0;poll<maxPolls;poll++){
          await sleep(60_000);
          preflight=BenchmarkService.preflight(userId,false);
          const hasBase=Array.isArray(preflight.baseCandidates)&&preflight.baseCandidates.length>0;
          if(!hasBase||!preflight.canRun){
            const reason='provider_became_unavailable';
            db.prepare("UPDATE benchmark_smoke_requests SET status='failed_preflight',report_json=?,finished_at=? WHERE request_id=?")
              .run(JSON.stringify({reason}),now(),config.requestId);
            console.error('FORGE_BENCHMARK_SMOKE_PREFLIGHT_FAILED '+JSON.stringify({requestId:config.requestId,reason}));
            return {enabled:true,status:'failed_preflight',reason};
          }
          remaining=Number(preflight.remainingDailyUsd||0);
          effectiveBudget=Math.min(config.maxCostUsd,remaining);
          if(Number.isFinite(effectiveBudget)&&effectiveBudget>=0.05){
            ready=true;
            console.log('FORGE_BENCHMARK_SMOKE_BUDGET_READY '+JSON.stringify({
              requestId:config.requestId,remainingDailyUsd:remaining,effectiveBudget:Number(effectiveBudget.toFixed(4)),
            }));
            break;
          }
        }
        if(!ready){
          const reason='budget_wait_timeout';
          db.prepare("UPDATE benchmark_smoke_requests SET status='failed_preflight',report_json=?,finished_at=? WHERE request_id=?")
            .run(JSON.stringify({reason,remainingDailyUsd:remaining}),now(),config.requestId);
          console.error('FORGE_BENCHMARK_SMOKE_PREFLIGHT_FAILED '+JSON.stringify({requestId:config.requestId,reason,remainingDailyUsd:remaining}));
          return {enabled:true,status:'failed_preflight',reason};
        }
      }

      const active=db.prepare("SELECT id,status FROM benchmark_runs WHERE user_id=? AND status IN ('queued','running') LIMIT 1").get(userId) as any;
      if(active){
        const reason='benchmark_already_running';
        db.prepare("UPDATE benchmark_smoke_requests SET user_id=?,status='failed_preflight',report_json=?,finished_at=? WHERE request_id=?")
          .run(userId,JSON.stringify({reason,benchmarkRunId:active.id}),now(),config.requestId);
        console.error('FORGE_BENCHMARK_SMOKE_PREFLIGHT_FAILED '+JSON.stringify({requestId:config.requestId,reason,benchmarkRunId:active.id}));
        return {enabled:true,status:'failed_preflight',reason};
      }

      db.prepare("UPDATE benchmark_smoke_requests SET user_id=?,status='starting',started_at=? WHERE request_id=?")
        .run(userId,now(),config.requestId);

      console.log('FORGE_BENCHMARK_SMOKE_START '+JSON.stringify({
        requestId:config.requestId,
        caseIds:config.caseIds,
        maxCostUsd:Number(effectiveBudget.toFixed(4)),
        allowExpert:false,
        baseCandidates:(preflight.baseCandidates||[]).map((candidate:any)=>({
          providerKey:candidate.providerKey,modelId:candidate.modelId,maxCostUsd:candidate.maxCostUsd,
        })),
        remainingDailyUsd:remaining,
      }));

      const run=BenchmarkService.start({
        userId,
        maxCostUsd:Number(effectiveBudget.toFixed(4)),
        confirmRealProviderCosts:true,
        allowExpert:false,
        caseIds:config.caseIds,
      });
      if(!run)throw Object.assign(new Error('BenchmarkService.start não retornou a execução criada.'),{code:'benchmark_start_missing_run'});

      db.prepare("UPDATE benchmark_smoke_requests SET status='running',benchmark_run_id=? WHERE request_id=?")
        .run(run.id,config.requestId);

      for(let poll=0;poll<900;poll++){
        const current=BenchmarkService.get(run.id,userId);
        if(current&&TERMINAL.has(String(current.status))){
          const report=sanitizedReport(current);
          db.prepare("UPDATE benchmark_smoke_requests SET status=?,report_json=?,finished_at=? WHERE request_id=?")
            .run(String(current.status),JSON.stringify(report),now(),config.requestId);
          console.log('FORGE_BENCHMARK_SMOKE_REPORT '+JSON.stringify({requestId:config.requestId,...report}));
          return {enabled:true,status:current.status,benchmarkRunId:run.id,report};
        }
        await sleep(2000);
      }

      const report={reason:'smoke_monitor_timeout',benchmarkRunId:run.id};
      db.prepare("UPDATE benchmark_smoke_requests SET status='monitor_timeout',report_json=?,finished_at=? WHERE request_id=?")
        .run(JSON.stringify(report),now(),config.requestId);
      console.error('FORGE_BENCHMARK_SMOKE_MONITOR_TIMEOUT '+JSON.stringify({requestId:config.requestId,benchmarkRunId:run.id}));
      return {enabled:true,status:'monitor_timeout',benchmarkRunId:run.id};
    }catch(error:any){
      const report={reason:'bootstrap_error',code:error?.code||null,message:String(error?.message||error).slice(0,800)};
      db.prepare("UPDATE benchmark_smoke_requests SET status='failed',report_json=?,finished_at=? WHERE request_id=?")
        .run(JSON.stringify(report),now(),config.requestId);
      console.error('FORGE_BENCHMARK_SMOKE_FAILED '+JSON.stringify({requestId:config.requestId,...report}));
      return {enabled:true,status:'failed',error:report};
    }
  }

  static latestRequest(requestId:string){
    const row=db.prepare('SELECT * FROM benchmark_smoke_requests WHERE request_id=?').get(requestId) as any;
    if(!row)return null;
    return {
      requestId:row.request_id,status:row.status,benchmarkRunId:row.benchmark_run_id||null,maxCostUsd:Number(row.max_cost_usd||0),
      caseIds:JSON.parse(row.case_ids_json||'[]'),report:JSON.parse(row.report_json||'{}'),createdAt:row.created_at,startedAt:row.started_at||null,finishedAt:row.finished_at||null,
    };
  }

  static newRequestId(){return 'smoke-'+crypto.randomUUID();}
}
