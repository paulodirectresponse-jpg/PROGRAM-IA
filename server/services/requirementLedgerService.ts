import crypto from 'node:crypto';
import { db } from '../db/index.js';
import type { PlanRequirement } from './llmAdapter.js';

export type RequirementStatus='pending'|'implemented'|'verified'|'failed'|'waived';

export interface RequirementRecord {
  id:string;
  project_id:string;
  conversation_id?:string|null;
  run_id?:string|null;
  plan_id?:string|null;
  requirement_key:string;
  title:string;
  description:string;
  priority:'critical'|'high'|'medium'|'low';
  status:RequirementStatus;
  verification:string[];
  files:string[];
  evidence:any[];
  created_at:string;
  updated_at:string;
}

const json=(value:unknown,fallback:any=[])=>{try{return typeof value==='string'?JSON.parse(value):value??fallback;}catch{return fallback;}};

export class RequirementLedgerService {
  static normalizeRequirements(requirements:PlanRequirement[]=[]):PlanRequirement[]{
    return (requirements||[]).map((req:any,index)=>{
      const title=String(req?.title||req?.description||`Requisito ${index+1}`).trim()||`Requisito ${index+1}`;
      const description=String(req?.description||title).trim()||title;
      const rawPriority=String(req?.priority||'high').toLowerCase();
      const priority=(['critical','high','medium','low'].includes(rawPriority)?rawPriority:'high') as PlanRequirement['priority'];
      const verification=(Array.isArray(req?.verification)?req.verification:[])
        .map((item:any)=>String(item||'').trim()).filter(Boolean);
      return {
        id:String(req?.id||`REQ-${String(index+1).padStart(3,'0')}`).toUpperCase().trim(),
        title,
        description,
        priority,
        verification:verification.length?verification:[description],
      };
    });
  }

  static syncPlan(input:{
    projectId:string;
    conversationId?:string|null;
    runId?:string|null;
    planId:string;
    requirements:PlanRequirement[];
  }){
    const now=new Date().toISOString();
    const requirements=this.normalizeRequirements(input.requirements||[]);
    const keys=requirements.map(req=>req.id);
    if(new Set(keys).size!==keys.length)throw new Error('Requirement Ledger recusou IDs duplicados no mesmo plano.');
    if(keys.length){
      const placeholders=keys.map(()=>'?').join(',');
      db.prepare(`DELETE FROM requirements WHERE project_id=? AND plan_id=? AND requirement_key NOT IN (${placeholders})`)
        .run(input.projectId,input.planId,...keys);
    }else{
      db.prepare('DELETE FROM requirements WHERE project_id=? AND plan_id=?').run(input.projectId,input.planId);
    }
    for(const req of requirements){
      const existing=db.prepare('SELECT id,status,files_json,evidence_json FROM requirements WHERE project_id=? AND plan_id=? AND requirement_key=?')
        .get(input.projectId,input.planId,req.id) as any;
      if(existing){
        db.prepare(`UPDATE requirements SET conversation_id=?,run_id=COALESCE(?,run_id),title=?,description=?,priority=?,verification_json=?,updated_at=? WHERE id=?`)
          .run(input.conversationId||null,input.runId||null,req.title,req.description||'',req.priority||'high',JSON.stringify(req.verification||[]),now,existing.id);
      }else{
        db.prepare(`INSERT INTO requirements(id,project_id,conversation_id,run_id,plan_id,requirement_key,title,description,priority,status,verification_json,files_json,evidence_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,'pending',?,'[]','[]',?,?)`)
          .run(`req-${crypto.randomUUID()}`,input.projectId,input.conversationId||null,input.runId||null,input.planId,req.id,req.title,req.description||'',req.priority||'high',JSON.stringify(req.verification||[]),now,now);
      }
    }
    return this.listByPlan(input.projectId,input.planId);
  }

  static verifyPlanSync(projectId:string,planId:string,requirements:PlanRequirement[]){
    const expected=this.normalizeRequirements(requirements);
    const rows=this.listByPlan(projectId,planId);
    const expectedKeys=[...new Set(expected.map(req=>req.id))];
    const persistedKeys=[...new Set(rows.map(req=>req.requirement_key))];
    const missing=expectedKeys.filter(key=>!persistedKeys.includes(key));
    const unexpected=persistedKeys.filter(key=>!expectedKeys.includes(key));
    return{
      valid:expectedKeys.length>0&&missing.length===0&&unexpected.length===0&&rows.length===expectedKeys.length,
      expected:expectedKeys.length,
      persisted:rows.length,
      missing,
      unexpected,
    };
  }

  static attachRun(projectId:string,planId:string,runId:string){
    db.prepare('UPDATE requirements SET run_id=?,updated_at=? WHERE project_id=? AND plan_id=?')
      .run(runId,new Date().toISOString(),projectId,planId);
  }

  static setStatusForRun(runId:string,status:RequirementStatus,evidence?:any,files?:string[]){
    const now=new Date().toISOString();
    const rows=db.prepare('SELECT id,evidence_json,files_json FROM requirements WHERE run_id=?').all(runId) as any[];
    for(const row of rows){
      const evidenceList=json(row.evidence_json,[]);
      if(evidence!==undefined)evidenceList.push(evidence);
      const fileList=[...new Set([...(json(row.files_json,[])||[]),...(files||[])])];
      db.prepare('UPDATE requirements SET status=?,evidence_json=?,files_json=?,updated_at=? WHERE id=?')
        .run(status,JSON.stringify(evidenceList),JSON.stringify(fileList),now,row.id);
    }
  }

  static setStatusForPlan(projectId:string,planId:string,status:RequirementStatus,evidence?:any,files?:string[]){
    const rows=db.prepare('SELECT run_id FROM requirements WHERE project_id=? AND plan_id=? AND run_id IS NOT NULL LIMIT 1').get(projectId,planId) as any;
    if(rows?.run_id)return this.setStatusForRun(rows.run_id,status,evidence,files);
    const now=new Date().toISOString();
    const list=db.prepare('SELECT id,evidence_json,files_json FROM requirements WHERE project_id=? AND plan_id=?').all(projectId,planId) as any[];
    for(const row of list){
      const ev=json(row.evidence_json,[]);
      if(evidence!==undefined)ev.push(evidence);
      const fileList=[...new Set([...(json(row.files_json,[])||[]),...(files||[])])];
      db.prepare('UPDATE requirements SET status=?,evidence_json=?,files_json=?,updated_at=? WHERE id=?')
        .run(status,JSON.stringify(ev),JSON.stringify(fileList),now,row.id);
    }
  }

  static list(projectId:string){
    return (db.prepare('SELECT * FROM requirements WHERE project_id=? ORDER BY created_at ASC').all(projectId) as any[]).map(this.hydrate);
  }

  static listByPlan(projectId:string,planId:string){
    return (db.prepare('SELECT * FROM requirements WHERE project_id=? AND plan_id=? ORDER BY created_at ASC').all(projectId,planId) as any[]).map(this.hydrate);
  }

  static listByRun(runId:string){
    return (db.prepare('SELECT * FROM requirements WHERE run_id=? ORDER BY created_at ASC').all(runId) as any[]).map(this.hydrate);
  }

  static summary(projectId:string){
    const rows=db.prepare('SELECT status,COUNT(*) count FROM requirements WHERE project_id=? GROUP BY status').all(projectId) as any[];
    const counts:Record<string,number>={pending:0,implemented:0,verified:0,failed:0,waived:0};
    for(const row of rows)counts[row.status]=Number(row.count||0);
    return {counts,total:Object.values(counts).reduce((n,v)=>n+v,0)};
  }

  private static hydrate(row:any):RequirementRecord{
    return {
      ...row,
      verification:json(row.verification_json,[]),
      files:json(row.files_json,[]),
      evidence:json(row.evidence_json,[]),
    };
  }
}
