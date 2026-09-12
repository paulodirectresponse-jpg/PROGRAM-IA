import crypto from 'node:crypto';
import os from 'node:os';
import {db} from '../db/index.js';
import {WorkspaceManager} from './workspaceManager.js';

const OWNED=['workspaces','providers','skills','integrations','user_secrets','model_profiles'] as const;
const PROJECT_CHILDREN=['project_sources','branches','conversations','checkpoints','verifications','attachments','plans','tasks','agent_runs'] as const;
const deviceId=crypto.createHash('sha256').update(`${os.hostname()}|${process.env.FORGE_DEVICE_ID||''}`).digest('hex').slice(0,24);
type Snapshot={schemaVersion:1;userId:string;deviceId:string;createdAt:string;tables:Record<string,any[]>;files:Record<string,Record<string,string>>};

export class CloudSyncService{
  private static timer=new Map<string,NodeJS.Timeout>();
  static configured(){return Boolean(process.env.SUPABASE_URL&&process.env.SUPABASE_SERVICE_ROLE_KEY);}
  private static headers(extra:Record<string,string>={}){const key=process.env.SUPABASE_SERVICE_ROLE_KEY!;return{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',...extra};}
  static export(userId:string):Snapshot{
    const tables:Record<string,any[]>={};
    for(const name of OWNED)tables[name]=db.prepare(`SELECT * FROM ${name} WHERE user_id=?`).all(userId);
    const projects=db.prepare('SELECT * FROM projects WHERE user_id=?').all(userId) as any[];tables.projects=projects;
    const ids=projects.map(p=>p.id);const inSql=ids.map(()=>'?').join(',');
    for(const name of PROJECT_CHILDREN)tables[name]=ids.length?db.prepare(`SELECT * FROM ${name} WHERE project_id IN (${inSql})`).all(...ids):[];
    const conversations=tables.conversations.map((x:any)=>x.id),runs=tables.agent_runs.map((x:any)=>x.id);
    tables.messages=conversations.length?db.prepare(`SELECT * FROM messages WHERE conversation_id IN (${conversations.map(()=>'?').join(',')})`).all(...conversations):[];
    tables.agent_steps=runs.length?db.prepare(`SELECT * FROM agent_steps WHERE run_id IN (${runs.map(()=>'?').join(',')})`).all(...runs):[];
    tables.tool_executions=runs.length?db.prepare(`SELECT * FROM tool_executions WHERE run_id IN (${runs.map(()=>'?').join(',')})`).all(...runs):[];
    const profiles=tables.model_profiles.map((x:any)=>x.id);tables.model_candidates=profiles.length?db.prepare(`SELECT * FROM model_candidates WHERE profile_id IN (${profiles.map(()=>'?').join(',')})`).all(...profiles):[];
    tables.model_invocations=db.prepare('SELECT * FROM model_invocations WHERE user_id=?').all(userId);
    const files:Record<string,Record<string,string>>={};for(const p of projects){files[p.id]={};for(const f of WorkspaceManager.getFiles(p.id)){const b=WorkspaceManager.readBinaryFile(p.id,f.path);if(b)files[p.id][f.path]=b.toString('base64');}}
    return{schemaVersion:1,userId,deviceId,createdAt:new Date().toISOString(),tables,files};
  }
  static async push(userId:string){if(!this.configured())return{status:'not_configured',deviceId};const payload=this.export(userId),serialized=JSON.stringify(payload);if(Buffer.byteLength(serialized)>45*1024*1024)throw Error('Snapshot excede 45 MB; publique arquivos grandes no GitHub ou Storage.');const hash=crypto.createHash('sha256').update(serialized).digest('hex');const current=await this.remote(userId);const revision=Number(current?.revision||0)+1;const url=`${process.env.SUPABASE_URL}/rest/v1/forge_sync_snapshots?on_conflict=user_id`;const r=await fetch(url,{method:'POST',headers:this.headers({Prefer:'resolution=merge-duplicates,return=representation'}),body:JSON.stringify({user_id:userId,revision,device_id:deviceId,schema_version:1,payload,payload_hash:hash,updated_at:new Date().toISOString()})});if(!r.ok)throw Error(`Supabase sync push ${r.status}: ${(await r.text()).slice(0,300)}`);return{status:'synced',revision,deviceId,hash};}
  static async remote(userId:string){if(!this.configured())return null;const r=await fetch(`${process.env.SUPABASE_URL}/rest/v1/forge_sync_snapshots?user_id=eq.${encodeURIComponent(userId)}&select=*`,{headers:this.headers()});if(!r.ok)throw Error(`Supabase sync read ${r.status}`);return(await r.json())[0]||null;}
  static async pull(userId:string){const row=await this.remote(userId);if(!row)return{status:'empty',deviceId};this.import(userId,row.payload);return{status:'restored',revision:row.revision,deviceId,updatedAt:row.updated_at};}
  static import(userId:string,s:Snapshot){if(s.userId!==userId)throw Error('Snapshot não pertence ao usuário autenticado.');const order=['workspaces','providers','skills','integrations','user_secrets','model_profiles','model_candidates','projects','project_sources','branches','conversations','messages','checkpoints','verifications','attachments','plans','tasks','agent_runs','agent_steps','tool_executions','model_invocations'];db.exec('BEGIN IMMEDIATE');try{for(const name of order){for(const row of s.tables[name]||[]){const cols=Object.keys(row);if(!cols.length)continue;db.prepare(`INSERT OR REPLACE INTO ${name} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).run(...cols.map(c=>row[c]));}}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}for(const [projectId,items] of Object.entries(s.files||{})){if(!WorkspaceManager.verifyProjectOwnership(projectId,userId))continue;for(const [name,b64] of Object.entries(items)){WorkspaceManager.writeBinaryFile(projectId,name,Buffer.from(b64,'base64'));}}}
  static schedule(userId:string){if(!this.configured())return;clearTimeout(this.timer.get(userId));this.timer.set(userId,setTimeout(()=>{this.push(userId).catch(e=>console.error('Cloud sync:',e.message)).finally(()=>this.timer.delete(userId));},1200));}
  static async bootstrap(userId:string){try{const row=await this.remote(userId);if(row){this.import(userId,row.payload);return{status:'restored',revision:row.revision};}return await this.push(userId);}catch(e:any){return{status:'error',message:e.message,deviceId};}}
}

