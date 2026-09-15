import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CloudSyncService } from './cloudSyncService.js';
import { SupabasePersistenceService } from './supabasePersistenceService.js';
import { SecretService } from './secretService.js';

export type MigrationReport={dryRun:boolean;userId:string;firebaseUid:string;tables:Record<string,number>;files:number;bytes:number;payloadHash:string;backupPath?:string;remote?:{records:number;files:number};reconciled?:boolean;divergences?:string[]};

const DOMAINS=['users','projects','providers','user_secrets','integrations','skills','conversations','messages','checkpoints','repositories','branches','model_profiles','model_candidates','model_invocations'];

function rowKey(domain:string,row:any){return String(row?.id||row?.service_key||row?.provider_key||row?.profile_key||`${domain}:${JSON.stringify(row)}`);}
function normalizeValue(value:any,field?:string){
  if(value===undefined)return null;
  if(['revision','level','max_attempts','max_cost_usd','priority','consecutive_failures','input_tokens','output_tokens','cost_usd','budget_cost_usd','latency_ms','retry_index'].includes(String(field))&&value!==null&&value!=='')return Number(value);
  return value;
}
function criticalFields(domain:string){
  const map:Record<string,string[]>={
    users:['id','email','firebase_uid'],
    projects:['id','user_id','name','origin','status'],
    providers:['id','user_id','provider_key','base_url','model_id','is_configured','is_active'],
    user_secrets:['id','user_id','service_key','encrypted_value','iv','tag','masked_hint','status'],
    integrations:['id','user_id','service_name','config_json','status'],
    skills:['id','user_id','project_id','slug','system_instructions','scope','is_active'],
    conversations:['id','project_id','title','mode'],
    messages:['id','conversation_id','sender','content','metadata_json'],
    checkpoints:['id','project_id','title'],
    repositories:['id','project_id','remote_url','default_branch','is_connected'],
    branches:['id','project_id','name','is_current','head_commit_hash'],
    model_profiles:['id','user_id','profile_key','level','max_attempts','max_cost_usd','enabled'],
    model_candidates:['id','profile_id','provider_key','model_id','priority','enabled','health_state','consecutive_failures','circuit_open_until'],
    model_invocations:['id','user_id','project_id','run_id','step_id','agent_key','profile_key','provider_key','model_id','input_tokens','output_tokens','cost_usd','cost_status','budget_cost_usd','latency_ms','status','error_code','retry_index','benchmark_run_id','benchmark_case_id'],
  };
  return map[domain]||['id'];
}

export function compareSnapshots(local:any,remote:any,userId:string){
  const divergences:string[]=[];
  for(const domain of DOMAINS){
    const localRows=local.tables?.[domain]||[],remoteRows=remote.tables?.[domain]||[];
    if(localRows.length!==remoteRows.length)divergences.push(`${domain}: contagem local=${localRows.length}, remoto=${remoteRows.length}`);
    const byKey=new Map(remoteRows.map((row:any)=>[rowKey(domain,row),row]));
    for(const row of localRows){
      const remoteRow=byKey.get(rowKey(domain,row)) as any;
      if(!remoteRow){divergences.push(`${domain}:${rowKey(domain,row)} ausente no remoto`);continue;}
      if('user_id' in row&&normalizeValue(remoteRow.user_id)!==userId)divergences.push(`${domain}:${rowKey(domain,row)} owner remoto inválido`);
      for(const field of criticalFields(domain)){
        const left=normalizeValue(row[field],field),right=normalizeValue(remoteRow[field],field);
        if(JSON.stringify(left)!==JSON.stringify(right))divergences.push(`${domain}:${rowKey(domain,row)} campo ${field} local=${JSON.stringify(left)} remoto=${JSON.stringify(right)}`);
      }
    }
  }
  const localFiles=local.files||{},remoteFiles=remote.files||{};
  for(const [projectId,items] of Object.entries(localFiles) as [string,Record<string,string>][])for(const [name,base64] of Object.entries(items)){
    const remoteBase64=remoteFiles?.[projectId]?.[name];
    if(!remoteBase64){divergences.push(`files:${projectId}/${name} ausente no remoto`);continue;}
    const localHash=crypto.createHash('sha256').update(Buffer.from(base64,'base64')).digest('hex');
    const remoteHash=crypto.createHash('sha256').update(Buffer.from(remoteBase64,'base64')).digest('hex');
    if(localHash!==remoteHash)divergences.push(`files:${projectId}/${name} hash local=${localHash} remoto=${remoteHash}`);
  }
  for(const [projectId,items] of Object.entries(remoteFiles) as [string,Record<string,string>][])for(const name of Object.keys(items))if(!localFiles?.[projectId]?.[name])divergences.push(`files:${projectId}/${name} existe apenas no remoto`);
  return divergences;
}

export class PersistenceMigrationService {
  static inspect(userId:string,firebaseUid:string):MigrationReport{
    const snapshot=CloudSyncService.export(userId),serialized=JSON.stringify(snapshot),tables=Object.fromEntries(Object.entries(snapshot.tables).map(([name,rows])=>[name,rows.length]));
    let files=0,bytes=0;for(const project of Object.values(snapshot.files))for(const value of Object.values(project)){files++;bytes+=Buffer.from(value,'base64').length;}
    const secrets=SecretService.validateEncryptedRows(snapshot.tables.user_secrets||[]);if(!secrets.valid)throw Error('Migração recusada: secrets locais não podem ser validados com a master key atual.');
    return{dryRun:true,userId,firebaseUid,tables,files,bytes,payloadHash:crypto.createHash('sha256').update(serialized).digest('hex')};
  }
  static async migrate(userId:string,firebaseUid:string,backupRoot=path.resolve('.data','migration-backups')):Promise<MigrationReport>{
    const report=this.inspect(userId,firebaseUid),snapshot=CloudSyncService.export(userId);fs.mkdirSync(backupRoot,{recursive:true});
    const backupPath=path.join(backupRoot,`${firebaseUid}-${report.payloadHash.slice(0,16)}.json`);if(!fs.existsSync(backupPath))fs.writeFileSync(backupPath,JSON.stringify(snapshot),'utf8');
    const pushed=await SupabasePersistenceService.pushCanonical(userId,firebaseUid,snapshot);if(pushed.status!=='synced')throw Error(`Migração não sincronizada: ${pushed.status}`);
    const pulled=await SupabasePersistenceService.pullCanonical(userId,firebaseUid);if(pulled.status!=='synced'||!pulled.snapshot)throw Error('Reconciliação falhou: leitura canônica indisponível.');
    const divergences=compareSnapshots(snapshot,pulled.snapshot,userId);
    if(divergences.length)throw Error(`Migração BLOCKED: ${divergences.join('; ')}`);
    return{...report,dryRun:false,backupPath,remote:{records:pushed.records||0,files:pushed.files||0},reconciled:true,divergences:[]};
  }
}
