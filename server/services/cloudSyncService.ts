import crypto from 'node:crypto';
import os from 'node:os';
import {db} from '../db/index.js';
import {WorkspaceManager} from './workspaceManager.js';
import {SecretService} from './secretService.js';
import {SupabasePersistenceService} from './supabasePersistenceService.js';

const OWNED=['workspaces','providers','skills','integrations','user_secrets','model_profiles'] as const;
const PROJECT_CHILDREN=['project_sources','branches','conversations','checkpoints','verifications','attachments','plans','tasks','requirements','agent_runs'] as const;
const deviceId=crypto.createHash('sha256').update(`${os.hostname()}|${process.env.FORGE_DEVICE_ID||''}`).digest('hex').slice(0,24);
type Snapshot={schemaVersion:1;userId:string;deviceId:string;createdAt:string;tables:Record<string,any[]>;files:Record<string,Record<string,string>>};

export class CloudSyncService{
  private static timer=new Map<string,NodeJS.Timeout>();
  private static key(){return process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY||'';}
  static configured(){return Boolean(process.env.SUPABASE_URL&&this.key()&&process.env.SECRETS_MASTER_KEY&&process.env.SECRETS_MASTER_KEY.length>=32);}
  static configurationStatus(){return{configured:this.configured()&&Boolean(process.env.SECRETS_MASTER_KEY&&process.env.SECRETS_MASTER_KEY.length>=32),hasSupabaseUrl:Boolean(process.env.SUPABASE_URL),hasSupabaseKey:Boolean(this.key()),hasMasterKey:Boolean(process.env.SECRETS_MASTER_KEY&&process.env.SECRETS_MASTER_KEY.length>=32),required:process.env.FORGE_REQUIRE_CLOUD_SYNC==='true'};}
  static assertPersistentConfiguration(){
    if(!this.configured())throw Error('Cloud sync obrigatório: configure SUPABASE_URL e SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY no ambiente persistente.');
    if(!process.env.SECRETS_MASTER_KEY||process.env.SECRETS_MASTER_KEY.length<32)throw Error('Cloud sync obrigatório: configure uma SECRETS_MASTER_KEY estável com pelo menos 32 caracteres.');
  }
  private static headers(extra:Record<string,string>={}):Record<string,string>{const key=this.key();const headers:Record<string,string>={apikey:key,'Content-Type':'application/json',...extra};if(!key.startsWith('sb_secret_'))headers.Authorization=`Bearer ${key}`;return headers;}
  static export(userId:string):Snapshot{
    const tables:Record<string,any[]>={};
    tables.users=db.prepare('SELECT id,email,name,role,firebase_uid,avatar_url,last_active_project_id,created_at,updated_at FROM users WHERE id=?').all(userId);
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
  private static isMissingLegacySnapshotTable(status:number,body:string){return status===404&&(/forge_sync_snapshots/i.test(body)||/schema cache/i.test(body)||/could not find/i.test(body)||/PGRST(200|205)/i.test(body));}
  static async remote(userId:string){if(!this.configured())return null;const r=await fetch(`${process.env.SUPABASE_URL}/rest/v1/forge_sync_snapshots?user_id=eq.${encodeURIComponent(userId)}&select=*`,{headers:this.headers()});if(!r.ok){const body=(await r.text()).slice(0,500);if(this.isMissingLegacySnapshotTable(r.status,body))return null;throw Error(`Supabase sync read ${r.status}: ${body}`);}return(await r.json())[0]||null;}
  private static assertSecretsReadable(snapshot:Snapshot){const result=SecretService.validateEncryptedRows(snapshot?.tables?.user_secrets||[]);if(!result.valid)throw Error('As credenciais da conta não podem ser descriptografadas com a SECRETS_MASTER_KEY deste ambiente.');}
  static import(userId:string,s:Snapshot){if(!s?.userId)throw Error('Snapshot remoto inválido.');const sourceUserId=s.userId;const order=['workspaces','providers','skills','integrations','user_secrets','model_profiles','model_candidates','projects','project_sources','branches','conversations','messages','checkpoints','verifications','attachments','plans','tasks','requirements','agent_runs','agent_steps','tool_executions','model_invocations'];db.exec('BEGIN IMMEDIATE');try{for(const name of order){const valid=new Set((db.prepare(`PRAGMA table_info(${name})`).all() as any[]).map(c=>c.name));for(const original of s.tables?.[name]||[]){const row={...original};if(row.user_id===sourceUserId)row.user_id=userId;if(name==='messages'&&row.metadata_json){try{const metadata=JSON.parse(row.metadata_json);row.metadata_json=JSON.stringify(metadata&&typeof metadata==='object'?metadata:{});}catch{row.metadata_json='{}';}}const cols=Object.keys(row).filter(c=>valid.has(c));if(!cols.length)continue;db.prepare(`INSERT OR REPLACE INTO ${name} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).run(...cols.map(c=>row[c]));}}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}for(const [projectId,items] of Object.entries(s.files||{})){if(!WorkspaceManager.verifyProjectOwnership(projectId,userId))continue;for(const [name,b64] of Object.entries(items)){WorkspaceManager.writeBinaryFile(projectId,name,Buffer.from(b64,'base64'));}}}
  private static firebaseUid(userId:string){return (db.prepare('SELECT firebase_uid FROM users WHERE id=?').get(userId) as any)?.firebase_uid||'';}
  static async pushDirect(userId:string){return SupabasePersistenceService.pushCanonical(userId,this.firebaseUid(userId),this.export(userId));}
  static async deleteProject(userId:string,projectId:string){
    const pending=this.timer.get(userId);
    if(pending){clearTimeout(pending);this.timer.delete(userId);}
    if(!this.configured())return{status:'not_configured' as const,deleted:false};
    return SupabasePersistenceService.deleteCanonicalProject(this.firebaseUid(userId),projectId);
  }
  static async pullDirect(userId:string){const direct=await SupabasePersistenceService.pullCanonical(userId,this.firebaseUid(userId));if(direct.status==='synced'&&direct.snapshot){this.assertSecretsReadable(direct.snapshot);this.import(userId,direct.snapshot as Snapshot);return{status:'synced',restored:true,source:'canonical'};}return direct;}
  // Canonical writes target normalized Postgres tables and Storage only. Snapshot writes are migration-only.
  static async syncAll(userId:string){return this.pushDirect(userId);}
  static schedule(userId:string){if(!this.configured())return;clearTimeout(this.timer.get(userId));this.timer.set(userId,setTimeout(()=>{this.syncAll(userId).catch(e=>console.error('Cloud sync:',e.message)).finally(()=>this.timer.delete(userId));},1200));}
  static async bootstrap(userId:string,legacyUserIds:string[]=[]){try{if(!this.configured())return{status:'not_configured',deviceId};const direct=await this.pullDirect(userId);if(direct.status==='synced')return direct;let row=await this.remote(userId);let migratedFrom:string|undefined;
    for(const legacyId of legacyUserIds){if(row)break;row=await this.remote(legacyId);if(row)migratedFrom=legacyId;}
    if(row){
    const newestLocal=db.prepare('SELECT MAX(updated_at) updated_at FROM projects WHERE user_id=?').get(userId) as any;
    if(row.device_id!==deviceId&&newestLocal?.updated_at&&new Date(newestLocal.updated_at)>new Date(row.updated_at)) return{status:'conflict',revision:row.revision,deviceId,message:'Existem alterações locais mais novas. Sincronize manualmente para escolher a versão.'};
    this.assertSecretsReadable(row.payload);this.import(userId,row.payload);
    await this.pushDirect(userId);
    // Legacy snapshot is read-only migration compatibility until the reconciliation gate in CODEX_HANDOFF.md is approved.
    return{status:'synced',restored:true,revision:row.revision,migratedFrom,source:'legacy-migrated'};
  }
  const hasLocal=(db.prepare('SELECT COUNT(*) n FROM projects WHERE user_id=?').get(userId) as any).n>0;
  return hasLocal?await this.pushDirect(userId):{status:'local_only',deviceId};}catch(e:any){return{status:'error',message:e.message,deviceId};}}
}
