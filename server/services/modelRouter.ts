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
  static spent(userId:string,since:string,runId?:string){const r=(runId?db.prepare('SELECT COALESCE(SUM(cost_usd),0) total FROM model_invocations WHERE user_id=? AND run_id=?').get(userId,runId):db.prepare('SELECT COALESCE(SUM(cost_usd),0) total FROM model_invocations WHERE user_id=? AND created_at>=?').get(userId,since)) as any;return Number(r?.total||0);}
  static assertBudget(userId:string,max:number,o:{runId?:string;runLimit?:number;dailyLimit?:number}={}){const d=new Date();d.setHours(0,0,0,0);if(this.spent(userId,d.toISOString())+max>(o.dailyLimit??3))throw Error('Limite diário de IA atingido.');if(o.runId){const run=db.prepare('SELECT budget_usd,spent_usd FROM agent_runs WHERE id=? AND user_id=?').get(o.runId,userId) as any;const limit=Number(o.runLimit??run?.budget_usd??.5);const spent=Number(run?.spent_usd??this.spent(userId,'',o.runId));if(spent+max>limit)throw Error('Orçamento desta execução seria excedido.');}}
  static recordInvocation(x:{userId:string;projectId?:string;runId?:string;stepId?:string;agentKey?:string;profileKey?:string;providerKey:string;modelId:string;inputTokens?:number;outputTokens?:number;costUsd?:number;latencyMs:number;status:string;errorCode?:string;retryIndex?:number;contextPackId?:string;contextScope?:string;projectHash?:string;contextTokens?:number;contextSelectedFiles?:string[];contextOmittedFilesCount?:number}){db.prepare(`INSERT INTO model_invocations(id,user_id,project_id,run_id,step_id,agent_key,profile_key,provider_key,model_id,input_tokens,output_tokens,cost_usd,latency_ms,status,error_code,retry_index,context_pack_id,context_scope,project_hash,context_tokens,context_selected_files_json,context_omitted_files_count,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`inv-${crypto.randomUUID()}`,x.userId,x.projectId||null,x.runId||null,x.stepId||null,x.agentKey||null,x.profileKey||null,x.providerKey,x.modelId,x.inputTokens||0,x.outputTokens||0,x.costUsd||0,x.latencyMs,x.status,x.errorCode||null,x.retryIndex||0,x.contextPackId||null,x.contextScope||null,x.projectHash||null,x.contextTokens||0,JSON.stringify(x.contextSelectedFiles||[]),x.contextOmittedFilesCount||0,new Date().toISOString());if(x.runId){db.prepare('UPDATE agent_runs SET spent_usd=(SELECT COALESCE(SUM(cost_usd),0) FROM model_invocations WHERE user_id=? AND run_id=?) WHERE id=? AND user_id=?').run(x.userId,x.runId,x.runId,x.userId);}}
}

