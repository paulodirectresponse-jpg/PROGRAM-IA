import crypto from 'node:crypto';
import { SupabaseRepository, type CanonicalTable } from '../repositories/supabaseRepository.js';

export type DirectSnapshot = {
  schemaVersion: 1;
  userId: string;
  deviceId: string;
  createdAt: string;
  tables: Record<string, any[]>;
  files: Record<string, Record<string, string>>;
};

type DirectStatus = 'synced' | 'local_only' | 'not_configured';

export class SupabasePersistenceService {
  private static key() {
    return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  }

  static configured() {
    return Boolean(process.env.SUPABASE_URL && this.key());
  }

  private static headers(extra: Record<string, string> = {}) {
    const key = this.key();
    const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json', ...extra };
    if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
    return headers;
  }

  private static rest(path: string) {
    return `${process.env.SUPABASE_URL}/rest/v1/${path}`;
  }

  private static storagePath(firebaseUid: string, projectId: string, filePath: string) {
    const safe = filePath.replace(/\\/g, '/').split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return `${encodeURIComponent(firebaseUid)}/${encodeURIComponent(projectId)}/${safe}`;
  }

  private static async expect(response: Response, operation: string) {
    if (!response.ok) throw new Error(`${operation} ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return response;
  }

  private static repository() { return new SupabaseRepository(String(process.env.SUPABASE_URL), (extra={}) => this.headers(extra)); }

  private static canonicalRows(snapshot: DirectSnapshot, firebaseUid: string) {
    const t=snapshot.tables, stamp=snapshot.createdAt;
    const json=(value:any,fallback:any={})=>{try{return typeof value==='string'?JSON.parse(value):value??fallback;}catch{return fallback;}};
    const rest=(row:any,known:string[])=>Object.fromEntries(Object.entries(row||{}).filter(([key])=>!known.includes(key)));
    const critical=(value:any,fallback:any)=>value===undefined||value===null||value===''?fallback:value;
    const rows: Partial<Record<CanonicalTable,any[]>> = {
      forge_profiles:(t.users||[]).map((x:any)=>({firebase_uid:firebaseUid,email:x.email||null,display_name:x.name||null,created_at:x.created_at||stamp,updated_at:x.updated_at||stamp})),
      forge_projects:(t.projects||[]).map((x:any)=>({id:x.id,firebase_uid:firebaseUid,workspace_id:x.workspace_id||null,name:x.name,description:x.description||null,origin:x.origin,status:x.status||'active',current_checkpoint_id:x.current_checkpoint_id||null,revision:Number(x.revision||0),created_at:x.created_at||stamp,updated_at:x.updated_at||stamp})),
      forge_conversations:(t.conversations||[]).map((x:any)=>({id:x.id,firebase_uid:firebaseUid,project_id:x.project_id,title:x.title,mode:x.mode,created_at:x.created_at||stamp,updated_at:x.updated_at||stamp})),
      forge_messages:(t.messages||[]).map((x:any)=>({id:x.id,firebase_uid:firebaseUid,conversation_id:x.conversation_id,sender:x.sender,content:x.content,metadata:json(x.metadata_json),created_at:x.created_at||stamp})),
      forge_providers:(t.providers||[]).map((x:any)=>({id:x.id,firebase_uid:firebaseUid,provider_key:x.provider_key,name:x.name,base_url:x.base_url,model_id:x.model_id,extra_headers:json(x.extra_headers_json),configured:Boolean(x.is_configured),active:Boolean(x.is_active),health:x.connection_status==='connected'?'connected':x.connection_status==='error'?'error':'untested',last_error:x.last_error||null,created_at:x.created_at||stamp,updated_at:x.updated_at||x.created_at||stamp})),
      forge_provider_secrets:(t.user_secrets||[]).map((x:any)=>({id:x.id,firebase_uid:firebaseUid,provider_id:null,service_key:x.service_key,encrypted_value:x.encrypted_value,iv:x.iv,tag:x.tag,masked_hint:x.masked_hint,status:x.status||'configured',last_tested_at:x.last_tested_at||null,last_error:x.last_error||null,created_at:x.created_at||stamp,updated_at:x.updated_at||stamp})),
      forge_integrations:(t.integrations||[]).map((x:any)=>({id:x.id,firebase_uid:firebaseUid,service_name:x.service_name,config:json(x.config_json),status:x.status||'pending_credentials',last_verified_at:x.last_verified_at||null,created_at:x.created_at||stamp,updated_at:x.updated_at||x.created_at||stamp})),
      forge_skills:(t.skills||[]).map((x:any)=>({id:x.id,firebase_uid:firebaseUid,project_id:x.project_id||null,name:x.name,slug:x.slug,description:x.description,system_instructions:x.system_instructions,scope:x.scope||'project',active:Boolean(x.is_active),is_custom:Boolean(x.is_custom),created_at:x.created_at||stamp,updated_at:x.updated_at||x.created_at||stamp})),
      forge_checkpoints:(t.checkpoints||[]).map((x:any)=>({id:x.id,firebase_uid:firebaseUid,project_id:x.project_id,title:x.title,description:x.description||null,parent_id:x.parent_id||null,files_manifest:Object.fromEntries(Object.entries(json(x.files_snapshot_json)).map(([p,v]:any)=>[p,crypto.createHash('sha256').update(String(v)).digest('hex')])),created_at:x.created_at||stamp})),
      forge_repositories:(t.repositories||[]).map((x:any)=>({id:x.id,firebase_uid:firebaseUid,project_id:x.project_id,remote_url:x.remote_url||null,default_branch:x.default_branch||null,visibility:x.visibility||null,connected:Boolean(x.is_connected),created_at:x.created_at||stamp,updated_at:x.updated_at||x.created_at||stamp})),
      forge_branches:(t.branches||[]).map((x:any)=>({id:x.id,firebase_uid:firebaseUid,project_id:x.project_id,name:x.name,current:Boolean(x.is_current),head_sha:x.head_commit_hash||null,created_at:x.created_at||stamp,updated_at:x.updated_at||x.created_at||stamp})),
      forge_model_profiles:(t.model_profiles||[]).map((x:any)=>({id:critical(x.id,`profile-${firebaseUid}-${critical(x.profile_key,'default')}`),firebase_uid:firebaseUid,name:String(critical(x.name,critical(x.profile_key,x.id))),profile_type:String(critical(x.profile_type,critical(x.level,0))),profile_key:String(critical(x.profile_key,critical(x.profile_type,critical(x.name,x.id)))),level:Number(critical(x.level,0)),max_attempts:Number(critical(x.max_attempts,1)),max_cost_usd:Number(critical(x.max_cost_usd,0)),active:critical(x.enabled,x.is_active)!==0,metadata:rest(x,['id','user_id','profile_key','level','max_attempts','max_cost_usd','enabled','name','profile_type','is_active','created_at','updated_at']),created_at:x.created_at||stamp,updated_at:x.updated_at||x.created_at||stamp})),
      forge_model_candidates:(t.model_candidates||[]).map((x:any)=>({id:critical(x.id,`candidate-${firebaseUid}-${crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0,16)}`),firebase_uid:firebaseUid,profile_id:x.profile_id,provider_id:x.provider_id||null,provider_key:x.provider_key||null,model_id:x.model_id,priority:Number(x.priority||0),active:critical(x.enabled,x.is_active)!==0,health_state:x.health_state||'healthy',consecutive_failures:Number(x.consecutive_failures||0),circuit_open_until:x.circuit_open_until||null,metadata:rest(x,['id','profile_id','provider_id','provider_key','model_id','priority','enabled','is_active','health_state','consecutive_failures','circuit_open_until','created_at','updated_at']),created_at:x.created_at||stamp,updated_at:x.updated_at||x.created_at||stamp})),
      forge_model_invocations:(t.model_invocations||[]).map((x:any)=>({id:critical(x.id,`inv-${firebaseUid}-${crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0,16)}`),firebase_uid:firebaseUid,project_id:x.project_id||null,run_id:x.run_id||null,step_id:x.step_id||null,agent_key:x.agent_key||null,profile_key:x.profile_key||null,provider_id:x.provider_id||null,provider_key:x.provider_key||null,model_id:x.model_id||null,status:x.status,cost_usd:x.cost_usd??null,tokens_input:x.tokens_input??x.input_tokens??null,tokens_output:x.tokens_output??x.output_tokens??null,latency_ms:x.latency_ms??null,error_code:x.error_code||null,retry_index:x.retry_index??null,metadata:{...json(x.metadata_json),...rest(x,['id','user_id','project_id','run_id','step_id','agent_key','profile_key','provider_id','provider_key','model_id','status','cost_usd','tokens_input','tokens_output','input_tokens','output_tokens','latency_ms','error_code','retry_index','metadata_json','created_at'])},created_at:x.created_at||stamp})),
    };
    return rows;
  }

  static async pushCanonical(userId:string,firebaseUid:string,snapshot:DirectSnapshot){
    if(!this.configured())return{status:'not_configured' as DirectStatus};
    if(!firebaseUid)throw Error('Firebase UID ausente; persistência direta recusada.');
    const repo=this.repository(), rows=this.canonicalRows(snapshot,firebaseUid);
    const conflicts:Partial<Record<CanonicalTable,string>>={forge_profiles:'firebase_uid',forge_projects:'id',forge_conversations:'id',forge_messages:'id',forge_providers:'id',forge_provider_secrets:'id',forge_integrations:'id',forge_skills:'id',forge_checkpoints:'id',forge_repositories:'id',forge_branches:'id',forge_model_profiles:'id',forge_model_candidates:'id',forge_model_invocations:'id'};
    for(const [table,items] of Object.entries(rows) as [CanonicalTable,any[]][])await repo.upsert(table,items,conflicts[table]||'id');
    let files=0;
    for(const [projectId,items] of Object.entries(snapshot.files))for(const [filePath,base64] of Object.entries(items)){
      const content=Buffer.from(base64,'base64'),storagePath=this.storagePath(firebaseUid,projectId,filePath),sha256=crypto.createHash('sha256').update(content).digest('hex');
      await this.expect(await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/forge-project-files/${storagePath}`,{method:'POST',headers:this.headers({'Content-Type':'application/octet-stream','x-upsert':'true'}),body:content}),'Supabase Storage upload');
      await repo.upsert('forge_project_files',[{firebase_uid:firebaseUid,project_id:projectId,path:filePath,storage_path:storagePath,sha256,size_bytes:content.length,content_type:'application/octet-stream',updated_at:snapshot.createdAt}], 'firebase_uid,project_id,path'); files++;
    }
    return{status:'synced' as DirectStatus,records:Object.values(rows).reduce((n,x)=>n+(x?.length||0),0),files};
  }

  static async pullCanonical(userId:string,firebaseUid:string):Promise<{status:DirectStatus;snapshot?:DirectSnapshot}>{
    if(!this.configured())return{status:'not_configured'};
    if(!firebaseUid)return{status:'local_only'};
    const repo=this.repository();
    const tablesToRead:CanonicalTable[]=['forge_profiles','forge_projects','forge_conversations','forge_messages','forge_providers','forge_provider_secrets','forge_integrations','forge_skills','forge_checkpoints','forge_repositories','forge_branches','forge_model_profiles','forge_model_candidates','forge_model_invocations','forge_project_files'];
    const values=await Promise.all(tablesToRead.map(t=>repo.owned(t,firebaseUid))),remote=Object.fromEntries(tablesToRead.map((t,i)=>[t,values[i]]));
    // A legacy snapshot-shaped response is not a canonical profile. Let the migration bridge handle it.
    if(!remote.forge_profiles.length||remote.forge_profiles[0]?.firebase_uid!==firebaseUid)return{status:'local_only'};
    const bool=(x:any)=>x?1:0, string=(x:any)=>JSON.stringify(x??{}), tables:Record<string,any[]>={};
    tables.users=remote.forge_profiles.map((x:any)=>({id:userId,email:x.email||'',name:x.display_name||'',role:'developer',firebase_uid:firebaseUid,created_at:x.created_at,updated_at:x.updated_at}));
    tables.projects=remote.forge_projects.map(({firebase_uid,revision,...x}:any)=>({...x,user_id:userId,revision}));
    tables.conversations=remote.forge_conversations.map(({firebase_uid,...x}:any)=>x);
    tables.messages=remote.forge_messages.map(({firebase_uid,metadata,...x}:any)=>({...x,metadata_json:string(metadata)}));
    tables.providers=remote.forge_providers.map(({firebase_uid,configured,active,health,extra_headers,updated_at,...x}:any)=>({...x,user_id:userId,is_configured:bool(configured),is_active:bool(active),connection_status:health==='connected'?'connected':health==='error'?'error':'not_configured',extra_headers_json:string(extra_headers)}));
    tables.user_secrets=remote.forge_provider_secrets.map(({firebase_uid,provider_id,...x}:any)=>({...x,user_id:userId,is_default:0,is_active:1}));
    tables.integrations=remote.forge_integrations.map(({firebase_uid,config,updated_at,...x}:any)=>({...x,user_id:userId,config_json:string(config)}));
    tables.skills=remote.forge_skills.map(({firebase_uid,active,is_custom,updated_at,...x}:any)=>({...x,user_id:userId,is_active:bool(active),is_custom:bool(is_custom)}));
    tables.checkpoints=remote.forge_checkpoints.map(({firebase_uid,files_manifest,...x}:any)=>({...x,files_snapshot_json:'{}'}));
    tables.repositories=remote.forge_repositories.map(({firebase_uid,connected,updated_at,...x}:any)=>({...x,is_connected:bool(connected)}));
    tables.branches=remote.forge_branches.map(({firebase_uid,current,updated_at,head_sha,...x}:any)=>({...x,is_current:bool(current),head_commit_hash:head_sha}));
    tables.model_profiles=remote.forge_model_profiles.map(({firebase_uid,active,metadata,name,profile_type,...x}:any)=>({...metadata,...x,user_id:userId,profile_key:x.profile_key||name,level:x.level??Number(profile_type||0),max_attempts:x.max_attempts??1,enabled:bool(active)}));
    tables.model_candidates=remote.forge_model_candidates.map(({firebase_uid,active,metadata,provider_id,...x}:any)=>({...metadata,...x,provider_id,enabled:bool(active)}));
    tables.model_invocations=remote.forge_model_invocations.map(({firebase_uid,metadata,tokens_input,tokens_output,...x}:any)=>({...metadata,...x,user_id:userId,input_tokens:tokens_input??metadata?.input_tokens??0,output_tokens:tokens_output??metadata?.output_tokens??0,metadata_json:string(metadata)}));
    const files:Record<string,Record<string,string>>={};
    for(const row of remote.forge_project_files){const response=await this.expect(await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/forge-project-files/${row.storage_path}`,{headers:this.headers()}),'Supabase Storage download');const content=Buffer.from(await response.arrayBuffer());if(crypto.createHash('sha256').update(content).digest('hex')!==row.sha256)throw Error(`Arquivo remoto corrompido: ${row.path}`);(files[row.project_id]||={})[row.path]=content.toString('base64');}
    return{status:'synced',snapshot:{schemaVersion:1,userId,deviceId:'supabase-canonical',createdAt:remote.forge_profiles[0].updated_at,tables,files}};
  }

  static async push(userId: string, firebaseUid: string, snapshot: DirectSnapshot): Promise<{status: DirectStatus; records?: number; files?: number}> {
    if (!this.configured()) return { status: 'not_configured' };
    if (!firebaseUid) throw new Error('Firebase UID ausente; persistência direta recusada.');

    const user = snapshot.tables.users?.find((row: any) => row.id === userId) || {};
    await this.expect(await fetch(this.rest('forge_accounts?on_conflict=user_id'), {
      method: 'POST',
      headers: this.headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify({ user_id: userId, firebase_uid: firebaseUid, email: user.email || null, display_name: user.name || null, schema_version: snapshot.schemaVersion, updated_at: snapshot.createdAt }),
    }), 'Supabase account upsert');

    const entities: any[] = [];
    for (const [entityType, rows] of Object.entries(snapshot.tables)) {
      for (const row of rows) {
        const entityId = String(row.id || `${entityType}:${crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex')}`);
        entities.push({ user_id: userId, firebase_uid: firebaseUid, entity_type: entityType, entity_id: entityId, project_id: row.project_id || (entityType === 'projects' ? row.id : null), payload: row, updated_at: row.updated_at || row.created_at || snapshot.createdAt });
      }
    }
    for (let index = 0; index < entities.length; index += 250) {
      await this.expect(await fetch(this.rest('forge_entities?on_conflict=user_id,entity_type,entity_id'), {
        method: 'POST', headers: this.headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(entities.slice(index, index + 250)),
      }), 'Supabase entity upsert');
    }

    const metadata: any[] = [];
    for (const [projectId, files] of Object.entries(snapshot.files)) {
      for (const [filePath, base64] of Object.entries(files)) {
        const content = Buffer.from(base64, 'base64');
        const storagePath = this.storagePath(firebaseUid, projectId, filePath);
        await this.expect(await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/forge-project-files/${storagePath}`, {
          method: 'POST', headers: this.headers({ 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' }), body: content,
        }), 'Supabase Storage upload');
        metadata.push({ user_id: userId, firebase_uid: firebaseUid, project_id: projectId, path: filePath, storage_path: storagePath, sha256: crypto.createHash('sha256').update(content).digest('hex'), size_bytes: content.length, updated_at: snapshot.createdAt });
      }
    }
    for (let index = 0; index < metadata.length; index += 250) {
      await this.expect(await fetch(this.rest('forge_project_files?on_conflict=user_id,project_id,path'), {
        method: 'POST', headers: this.headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(metadata.slice(index, index + 250)),
      }), 'Supabase file metadata upsert');
    }
    return { status: 'synced', records: entities.length, files: metadata.length };
  }

  static async pull(userId: string, firebaseUid = ''): Promise<{status: DirectStatus; snapshot?: DirectSnapshot; migratedFrom?: string}> {
    if (!this.configured()) return { status: 'not_configured' };
    const accountFilter = firebaseUid
      ? `or=(user_id.eq.${encodeURIComponent(userId)},firebase_uid.eq.${encodeURIComponent(firebaseUid)})`
      : `user_id=eq.${encodeURIComponent(userId)}`;
    const accountResponse = await this.expect(await fetch(this.rest(`forge_accounts?${accountFilter}&select=*&order=updated_at.desc&limit=1`), { headers: this.headers() }), 'Supabase account read');
    const accounts = await accountResponse.json() as any[];
    if (!accounts.length || !accounts[0]?.firebase_uid) return { status: 'local_only' };
    const remoteUserId = String(accounts[0].user_id);
    const entityResponse = await this.expect(await fetch(this.rest(`forge_entities?user_id=eq.${encodeURIComponent(remoteUserId)}&select=entity_type,payload`), { headers: this.headers() }), 'Supabase entity read');
    const fileResponse = await this.expect(await fetch(this.rest(`forge_project_files?user_id=eq.${encodeURIComponent(remoteUserId)}&select=project_id,path,storage_path,sha256`), { headers: this.headers() }), 'Supabase file metadata read');
    const tables: Record<string, any[]> = {};
    for (const row of await entityResponse.json() as any[]) (tables[row.entity_type] ||= []).push(row.payload);
    const files: Record<string, Record<string, string>> = {};
    for (const row of await fileResponse.json() as any[]) {
      const response = await this.expect(await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/forge-project-files/${row.storage_path}`, { headers: this.headers() }), 'Supabase Storage download');
      const content = Buffer.from(await response.arrayBuffer());
      if (crypto.createHash('sha256').update(content).digest('hex') !== row.sha256) throw new Error(`Arquivo remoto corrompido: ${row.path}`);
      (files[row.project_id] ||= {})[row.path] = content.toString('base64');
    }
    return { status: 'synced', migratedFrom: remoteUserId === userId ? undefined : remoteUserId, snapshot: { schemaVersion: 1, userId: remoteUserId, deviceId: 'supabase-direct', createdAt: accounts[0].updated_at, tables, files } };
  }
}
