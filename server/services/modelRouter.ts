import crypto from 'node:crypto';
import { db } from '../db/index.js';
export type ProfileKey='BASE_FREE'|'EXPERT_PAID'|'PREMIUM_OVERRIDE';
export type FailureKind='operational'|'incompatible'|'capacity';
export class ModelRouter {
  static listProfiles(userId:string){const ps=db.prepare('SELECT * FROM model_profiles WHERE user_id=? ORDER BY level').all(userId) as any[];const cs=db.prepare(`SELECT c.* FROM model_candidates c JOIN model_profiles p ON p.id=c.profile_id WHERE p.user_id=? ORDER BY c.profile_id,c.priority`).all(userId) as any[];return ps.map(p=>({...p,candidates:cs.filter(c=>c.profile_id===p.id)}));}
  static saveCandidate(userId:string,key:ProfileKey,x:{providerKey:string;modelId:string;priority?:number;enabled?:boolean}){const p=db.prepare('SELECT * FROM model_profiles WHERE user_id=? AND profile_key=?').get(userId,key) as any;if(!p)throw Error('Perfil não encontrado.');if(!db.prepare('SELECT 1 FROM providers WHERE user_id=? AND provider_key=?').get(userId,x.providerKey)||!x.modelId?.trim())throw Error('Provedor ou modelo inválido.');const now=new Date().toISOString(),old=db.prepare('SELECT id FROM model_candidates WHERE profile_id=? AND provider_key=? AND model_id=?').get(p.id,x.providerKey,x.modelId.trim()) as any,id=old?.id||`candidate-${crypto.randomUUID()}`;db.prepare(`INSERT INTO model_candidates(id,profile_id,provider_key,model_id,priority,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET priority=excluded.priority,enabled=excluded.enabled,updated_at=excluded.updated_at`).run(id,p.id,x.providerKey,x.modelId.trim(),x.priority??0,x.enabled===false?0:1,now,now);return this.listProfiles(userId);}
  static updateCandidate(userId:string,id:string,x:{priority?:number;enabled?:boolean}){const owned=db.prepare(`SELECT c.id FROM model_candidates c JOIN model_profiles p ON p.id=c.profile_id WHERE c.id=? AND p.user_id=?`).get(id,userId);if(!owned)throw Error('Candidato não encontrado.');db.prepare('UPDATE model_candidates SET priority=COALESCE(?,priority),enabled=COALESCE(?,enabled),updated_at=? WHERE id=?').run(x.priority??null,x.enabled===undefined?null:(x.enabled?1:0),new Date().toISOString(),id);return this.listProfiles(userId);}
  static deleteCandidate(userId:string,id:string){const owned=db.prepare(`SELECT c.id FROM model_candidates c JOIN model_profiles p ON p.id=c.profile_id WHERE c.id=? AND p.user_id=?`).get(id,userId);if(!owned)throw Error('Candidato não encontrado.');db.prepare('DELETE FROM model_candidates WHERE id=?').run(id);return this.listProfiles(userId);}
  static candidates(userId:string,key:ProfileKey){return db.prepare(`SELECT c.*,p.max_attempts,p.max_cost_usd FROM model_candidates c JOIN model_profiles p ON p.id=c.profile_id WHERE p.user_id=? AND p.profile_key=? AND p.enabled=1 AND c.enabled=1 AND (c.circuit_open_until IS NULL OR c.circuit_open_until<=?) ORDER BY c.priority`).all(userId,key,new Date().toISOString()) as any[];}
  static openCandidateCircuit(id:string,minutes=30,healthState='open'){
    const now=new Date().toISOString();
    const until=new Date(Date.now()+Math.max(1,minutes)*60*1000).toISOString();
    const r=db.prepare('SELECT consecutive_failures FROM model_candidates WHERE id=?').get(id) as any;
    const n=(r?.consecutive_failures||0)+1;
    db.prepare('UPDATE model_candidates SET consecutive_failures=?,health_state=?,circuit_open_until=?,updated_at=? WHERE id=?')
      .run(n,healthState,until,now,id);
  }
  static recordCandidateResult(id:string,ok:boolean,kind?:FailureKind){
    const now=new Date().toISOString();
    if(ok){
      db.prepare("UPDATE model_candidates SET health_state='healthy',consecutive_failures=0,circuit_open_until=NULL,updated_at=? WHERE id=?").run(now,id);
      return;
    }
    const r=db.prepare('SELECT consecutive_failures FROM model_candidates WHERE id=?').get(id) as any;
    const n=(r?.consecutive_failures||0)+1;
    if(kind==='incompatible'){
      // Invalid/unsupported provider-model pairs do not become valid by repeating the same call.
      // Quarantine immediately so later FORGE runs do not burn another paid/free attempt on it.
      const until=new Date(Date.now()+6*60*60*1000).toISOString();
      db.prepare("UPDATE model_candidates SET consecutive_failures=?,health_state='incompatible',circuit_open_until=?,updated_at=? WHERE id=?").run(n,until,now,id);
      return;
    }
    if(kind!=='operational')return;
    const until=n>=2?new Date(Date.now()+300000).toISOString():null;
    db.prepare('UPDATE model_candidates SET consecutive_failures=?,health_state=?,circuit_open_until=?,updated_at=? WHERE id=?').run(n,until?'open':'degraded',until,now,id);
  }
  static repairFalseBudgetQuarantines(hours=24){
    const since=new Date(Date.now()-Math.max(1,hours)*60*60*1000).toISOString();
    const steps=db.prepare(`SELECT s.id step_id,s.context_json,r.user_id
      FROM agent_steps s JOIN agent_runs r ON r.id=s.run_id
      WHERE s.created_at>=? AND s.context_json IS NOT NULL`).all(since) as Array<{step_id:string;context_json:string;user_id:string}>;
    let repaired=0;
    for(const step of steps){
      let events:any[]=[];
      try{
        const parsed=JSON.parse(step.context_json||'{}');
        events=Array.isArray(parsed?.events)?parsed.events:[];
      }catch{continue;}
      for(const event of events){
        if(event?.stage!=='attempt.failed')continue;
        if(!/Limite diário de IA atingido|Orçamento desta execução seria excedido/i.test(String(event?.error||'')))continue;
        const providerKey=String(event?.providerKey||'').trim();
        const modelId=String(event?.modelId||'').trim();
        const profileKey=String(event?.profile||'').trim();
        if(!providerKey||!modelId||!profileKey)continue;
        const invocation=db.prepare('SELECT 1 FROM model_invocations WHERE step_id=? AND provider_key=? AND model_id=? LIMIT 1')
          .get(step.step_id,providerKey,modelId);
        if(invocation)continue;
        const candidate=db.prepare(`SELECT c.id,c.health_state,c.circuit_open_until
          FROM model_candidates c JOIN model_profiles p ON p.id=c.profile_id
          WHERE p.user_id=? AND p.profile_key=? AND c.provider_key=? AND c.model_id=? LIMIT 1`)
          .get(step.user_id,profileKey,providerKey,modelId) as any;
        if(!candidate||candidate.health_state!=='incompatible'||!candidate.circuit_open_until)continue;
        if(String(candidate.circuit_open_until)<=new Date().toISOString())continue;
        db.prepare("UPDATE model_candidates SET health_state='healthy',consecutive_failures=0,circuit_open_until=NULL,updated_at=? WHERE id=?")
          .run(new Date().toISOString(),candidate.id);
        repaired++;
      }
    }
    return repaired;
  }

  static spent(userId:string,since:string,runId?:string){
    const r=(runId
      ?db.prepare('SELECT COALESCE(SUM(budget_cost_usd),0) total FROM model_invocations WHERE user_id=? AND run_id=?').get(userId,runId)
      :db.prepare('SELECT COALESCE(SUM(budget_cost_usd),0) total FROM model_invocations WHERE user_id=? AND created_at>=?').get(userId,since)) as any;
    return Number(r?.total||0);
  }
  static recommendedRunBudget(userId:string,mode:string){
    const profiles=this.listProfiles(userId);
    const profileMax=(key:ProfileKey)=>{
      const profile=profiles.find((item:any)=>item.profile_key===key&&Number(item.enabled)!==0);
      if(!profile)return 0;
      const enabled=(profile.candidates||[]).filter((candidate:any)=>Number(candidate.enabled)!==0);
      if(!enabled.length)return 0;
      return Math.max(0,Number(profile.max_cost_usd||0));
    };
    const routeReserve=Math.max(0.05,profileMax('BASE_FREE')+profileMax('EXPERT_PAID'));
    const normalized=String(mode||'auto').toLowerCase();
    const policy:Record<string,{calls:number;floor:number;cap:number}>={
      plan:{calls:2,floor:.75,cap:1.5},
      review:{calls:2,floor:.75,cap:1.5},
      publish:{calls:1,floor:.5,cap:1},
      build:{calls:4,floor:1,cap:2},
      auto:{calls:5,floor:1.5,cap:2},
    };
    const rule=policy[normalized]||policy.auto;
    return Math.round(Math.min(rule.cap,Math.max(rule.floor,routeReserve*rule.calls))*1000)/1000;
  }

  static assertBudget(userId:string,max:number,o:{runId?:string;runLimit?:number;dailyLimit?:number}={}){
    const configuredDailyLimit=(()=>{
      if(o.dailyLimit!==undefined)return Number(o.dailyLimit);
      const raw=String(process.env.FORGE_DAILY_AI_BUDGET_USD||'').trim();
      if(!raw)return null;
      const parsed=Number(raw);
      return Number.isFinite(parsed)&&parsed>=0?parsed:null;
    })();
    if(configuredDailyLimit!==null){
      const d=new Date();d.setHours(0,0,0,0);
      if(this.spent(userId,d.toISOString())+max>configuredDailyLimit){
        throw Object.assign(new Error('Limite diário de IA atingido.'),{code:'AI_DAILY_BUDGET_EXCEEDED'});
      }
    }
    if(o.runId){
      const run=db.prepare('SELECT budget_usd,spent_usd FROM agent_runs WHERE id=? AND user_id=?').get(o.runId,userId) as any;
      const limit=Number(o.runLimit??run?.budget_usd??.5);
      const spent=Number(run?.spent_usd??this.spent(userId,'',o.runId));
      if(spent+max>limit){
        throw Object.assign(new Error('Orçamento desta execução seria excedido.'),{code:'AI_RUN_BUDGET_EXCEEDED'});
      }
    }
  }
  static recordInvocation(x:{
    userId:string;projectId?:string;runId?:string;stepId?:string;agentKey?:string;profileKey?:string;
    providerKey:string;modelId:string;inputTokens?:number;outputTokens?:number;costUsd?:number;
    costStatus?:'reported'|'known_zero'|'unknown'|'partial';budgetCostUsd?:number;
    latencyMs:number;status:string;errorCode?:string;retryIndex?:number;contextPackId?:string;
    contextScope?:string;projectHash?:string;contextTokens?:number;contextSelectedFiles?:string[];
    contextOmittedFilesCount?:number;
  }){
    const knownCost=x.costUsd===undefined||x.costUsd===null?null:Math.max(0,Number(x.costUsd)||0);
    const costStatus=x.costStatus||(knownCost===null?'unknown':knownCost===0?'known_zero':'reported');
    const reservation=Math.max(0,Number(x.budgetCostUsd||0));
    const budgetCost=(costStatus==='unknown'||costStatus==='partial')
      ?Math.max(knownCost||0,reservation)
      :(knownCost||0);
    db.prepare(`INSERT INTO model_invocations(
      id,user_id,project_id,run_id,step_id,agent_key,profile_key,provider_key,model_id,
      input_tokens,output_tokens,cost_usd,cost_status,budget_cost_usd,latency_ms,status,error_code,retry_index,
      context_pack_id,context_scope,project_hash,context_tokens,context_selected_files_json,context_omitted_files_count,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      `inv-${crypto.randomUUID()}`,x.userId,x.projectId||null,x.runId||null,x.stepId||null,x.agentKey||null,x.profileKey||null,
      x.providerKey,x.modelId,x.inputTokens||0,x.outputTokens||0,knownCost,costStatus,budgetCost,x.latencyMs,x.status,x.errorCode||null,
      x.retryIndex||0,x.contextPackId||null,x.contextScope||null,x.projectHash||null,x.contextTokens||0,
      JSON.stringify(x.contextSelectedFiles||[]),x.contextOmittedFilesCount||0,new Date().toISOString()
    );
    if(x.runId){
      db.prepare('UPDATE agent_runs SET spent_usd=(SELECT COALESCE(SUM(budget_cost_usd),0) FROM model_invocations WHERE user_id=? AND run_id=?) WHERE id=? AND user_id=?')
        .run(x.userId,x.runId,x.runId,x.userId);
    }
  }
}

