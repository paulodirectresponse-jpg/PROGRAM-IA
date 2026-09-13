import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SupabasePersistenceService } from '../server/services/supabasePersistenceService.js';
import { CloudSyncService } from '../server/services/cloudSyncService.js';
import { compareSnapshots } from '../server/services/persistenceMigrationService.js';
import { db, initializeDatabase } from '../server/db/index.js';
import { AuthService } from '../server/services/authService.js';

before(()=>initializeDatabase());

function restore(name: 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY', value: string | undefined) {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}

const stamp='2026-09-12T00:00:00.000Z';
function fullSnapshot(){
  const file=Buffer.from('<!doctype html><h1>ok</h1>').toString('base64');
  return {schemaVersion:1 as const,userId:'u1',deviceId:'fixture-A',createdAt:stamp,tables:{
    users:[{id:'u1',email:'a@example.test',name:'A',firebase_uid:'fb1',created_at:stamp,updated_at:stamp}],
    projects:[{id:'p1',user_id:'u1',workspace_id:'ws1',name:'P',description:'D',origin:'scratch',status:'active',current_checkpoint_id:'cp1',revision:7,created_at:stamp,updated_at:stamp}],
    providers:[{id:'prov1',user_id:'u1',provider_key:'cheaper',name:'Cheaper',base_url:'https://api.example.test/v1',model_id:'gpt-5.6-luna',extra_headers_json:'{"x":"y"}',is_configured:1,is_active:1,connection_status:'connected',last_error:null,created_at:stamp,updated_at:stamp}],
    user_secrets:[{id:'sec1',user_id:'u1',service_key:'cheaper:api_key',encrypted_value:'cipher',iv:'iv',tag:'tag',masked_hint:'sk-...abc',status:'configured',is_default:1,is_active:1,last_tested_at:stamp,last_error:null,created_at:stamp,updated_at:stamp}],
    integrations:[{id:'int1',user_id:'u1',service_name:'github',config_json:'{"owner":"paulo"}',status:'connected',last_verified_at:stamp,created_at:stamp,updated_at:stamp}],
    skills:[{id:'skill1',user_id:'u1',project_id:'p1',name:'UI',slug:'ui',description:'Visual',system_instructions:'Polish UI',scope:'project',is_active:1,created_at:stamp,updated_at:stamp}],
    conversations:[{id:'conv1',project_id:'p1',title:'Chat',mode:'build',created_at:stamp,updated_at:stamp}],
    messages:[{id:'msg1',conversation_id:'conv1',sender:'user',content:'faz',metadata_json:'{"kind":"prompt"}',created_at:stamp}],
    checkpoints:[{id:'cp1',project_id:'p1',title:'v1',description:'initial',parent_id:null,files_snapshot_json:'{"index.html":"ok"}',created_at:stamp}],
    repositories:[{id:'repo1',project_id:'p1',remote_url:'https://github.com/a/b',default_branch:'main',visibility:'private',is_connected:1,created_at:stamp,updated_at:stamp}],
    branches:[{id:'br1',project_id:'p1',name:'main',is_current:1,head_commit_hash:'abc123',created_at:stamp,updated_at:stamp}],
    model_profiles:[{id:'mp1',user_id:'u1',profile_key:'base_free',level:1,max_attempts:3,max_cost_usd:.25,enabled:1,created_at:stamp,updated_at:stamp}],
    model_candidates:[{id:'mc1',profile_id:'mp1',provider_key:'cheaper',model_id:'gpt-5.6-luna',priority:1,enabled:1,health_state:'degraded',consecutive_failures:1,circuit_open_until:'2026-09-12T00:05:00.000Z',created_at:stamp,updated_at:stamp}],
    model_invocations:[{id:'mi1',user_id:'u1',project_id:'p1',run_id:'run1',step_id:'step1',agent_key:'forja',profile_key:'base_free',provider_key:'cheaper',model_id:'gpt-5.6-luna',input_tokens:11,output_tokens:22,cost_usd:.01,latency_ms:333,status:'success',error_code:null,retry_index:0,created_at:stamp}],
  },files:{p1:{'index.html':file}}};
}

test('restores normalized entities and hash-verified Storage files', async (t) => {
  const oldUrl = process.env.SUPABASE_URL, oldKey = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL = 'https://direct.example.test'; process.env.SUPABASE_SECRET_KEY = 'test-service-role';
  const bytes = Buffer.from([0, 1, 2, 250]);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('forge_accounts?')) return new Response(JSON.stringify([{ user_id: 'u1', firebase_uid: 'fb1', updated_at: '2026-09-12T00:00:00.000Z' }]), { status: 200 });
    if (url.includes('forge_entities?')) return new Response(JSON.stringify([{ entity_type: 'projects', payload: { id: 'p1', user_id: 'u1', name: 'Direct' } }]), { status: 200 });
    if (url.includes('forge_project_files?')) return new Response(JSON.stringify([{ project_id: 'p1', path: 'logo.bin', storage_path: 'fb1/p1/logo.bin', sha256: hash }]), { status: 200 });
    return new Response(bytes, { status: 200 });
  });
  try {
    const result = await SupabasePersistenceService.pull('u1');
    assert.equal(result.status, 'synced');
    assert.equal(result.snapshot?.tables.projects[0].name, 'Direct');
    assert.equal(result.snapshot?.files.p1['logo.bin'], bytes.toString('base64'));
  } finally { restore('SUPABASE_URL', oldUrl); restore('SUPABASE_SECRET_KEY', oldKey); }
});

test('migration upserts account, entities and binary files without putting server key in payloads', async (t) => {
  const oldUrl = process.env.SUPABASE_URL, oldKey = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL = 'https://direct.example.test'; process.env.SUPABASE_SECRET_KEY = 'server-secret-value';
  const calls: { url: string; body: unknown }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(input), body: init?.body }); return new Response('{}', { status: 201 }); });
  try {
    const result = await SupabasePersistenceService.push('u1', 'firebase-uid', {
      schemaVersion: 1, userId: 'u1', deviceId: 'test', createdAt: new Date().toISOString(),
      tables: { projects: [{ id: 'p1', user_id: 'u1', name: 'Project' }] },
      files: { p1: { 'assets/a.bin': Buffer.from([4, 5, 6]).toString('base64') } },
    });
    assert.deepEqual({ status: result.status, records: result.records, files: result.files }, { status: 'synced', records: 1, files: 1 });
    assert.ok(calls.some((call) => call.url.includes('/forge_accounts')));
    assert.ok(calls.some((call) => call.url.includes('/forge_entities')));
    assert.ok(calls.some((call) => call.url.includes('/storage/v1/object/forge-project-files/firebase-uid/p1/assets/a.bin')));
    assert.equal(JSON.stringify(calls.map((call) => call.body)).includes('server-secret-value'), false);
  } finally { restore('SUPABASE_URL', oldUrl); restore('SUPABASE_SECRET_KEY', oldKey); }
});

test('finds a legacy direct account through the stable Firebase UID', async (t) => {
  const oldUrl = process.env.SUPABASE_URL, oldKey = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL = 'https://direct.example.test'; process.env.SUPABASE_SECRET_KEY = 'test-service-role';
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input); urls.push(url);
    if (url.includes('forge_accounts?')) return new Response(JSON.stringify([{ user_id: 'legacy-user', firebase_uid: 'stable-firebase-uid', updated_at: '2026-09-12T00:00:00.000Z' }]), { status: 200 });
    return new Response('[]', { status: 200 });
  });
  try {
    const result = await SupabasePersistenceService.pull('stable-user', 'stable-firebase-uid');
    assert.equal(result.status, 'synced');
    assert.equal(result.migratedFrom, 'legacy-user');
    assert.equal(result.snapshot?.userId, 'legacy-user');
    assert.ok(urls[0].includes('firebase_uid.eq.stable-firebase-uid'));
    assert.ok(urls.some((url) => url.includes('user_id=eq.legacy-user')));
  } finally { restore('SUPABASE_URL', oldUrl); restore('SUPABASE_SECRET_KEY', oldKey); }
});

test('canonical persistence writes normalized domains and Storage without legacy snapshot', async (t) => {
  const oldUrl=process.env.SUPABASE_URL,oldKey=process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL='https://canonical.example.test';process.env.SUPABASE_SECRET_KEY='server-secret-value';
  const urls:string[]=[];t.mock.method(globalThis,'fetch',async(input:string|URL|Request)=>{urls.push(String(input));return new Response('{}',{status:201});});
  try{const result=await SupabasePersistenceService.pushCanonical('u1','fb1',{schemaVersion:1,userId:'u1',deviceId:'A',createdAt:'2026-09-12T00:00:00.000Z',tables:{users:[{id:'u1',email:'a@example.test',name:'A'}],projects:[{id:'p1',user_id:'u1',name:'P',origin:'novo',status:'active'}],providers:[],user_secrets:[],integrations:[],skills:[],conversations:[],messages:[],checkpoints:[],repositories:[],branches:[],model_profiles:[],model_candidates:[],model_invocations:[]},files:{p1:{'index.html':Buffer.from('<h1>A</h1>').toString('base64')}}});assert.equal(result.status,'synced');assert.ok(urls.some(x=>x.includes('/forge_profiles?')));assert.ok(urls.some(x=>x.includes('/forge_projects?')));assert.ok(urls.some(x=>x.includes('/forge_project_files?')));assert.equal(urls.some(x=>x.includes('forge_sync_snapshots')),false);assert.equal(urls.some(x=>x.includes('forge_entities')),false);}
  finally{restore('SUPABASE_URL',oldUrl);restore('SUPABASE_SECRET_KEY',oldKey);}
});

test('canonical model routing mapper preserves legacy profile, candidate and invocation fields', async (t)=>{
  const oldUrl=process.env.SUPABASE_URL,oldKey=process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL='https://canonical.example.test';process.env.SUPABASE_SECRET_KEY='server-secret-value';
  const writes:Record<string,any[]>={};
  t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init?:RequestInit)=>{
    const url=String(input);
    const table=url.match(/\/rest\/v1\/([^?]+)/)?.[1];
    if(table&&init?.body)writes[table]=[...(writes[table]||[]),...JSON.parse(String(init.body))];
    return new Response('{}',{status:201});
  });
  try{
    const result=await SupabasePersistenceService.pushCanonical('u1','fb1',fullSnapshot());
    assert.equal(result.status,'synced');
    assert.deepEqual(Object.keys(writes).sort(),['forge_branches','forge_checkpoints','forge_conversations','forge_integrations','forge_messages','forge_model_candidates','forge_model_invocations','forge_model_profiles','forge_profiles','forge_project_files','forge_projects','forge_provider_secrets','forge_providers','forge_repositories','forge_skills'].sort());
    assert.equal(writes.forge_model_profiles[0].profile_key,'base_free');
    assert.equal(writes.forge_model_profiles[0].level,1);
    assert.equal(writes.forge_model_profiles[0].max_attempts,3);
    assert.equal(writes.forge_model_profiles[0].active,true);
    assert.equal(Object.values(writes.forge_model_profiles[0]).includes(undefined),false);
    assert.equal(writes.forge_model_candidates[0].provider_key,'cheaper');
    assert.equal(writes.forge_model_candidates[0].health_state,'degraded');
    assert.equal(writes.forge_model_candidates[0].consecutive_failures,1);
    assert.equal(writes.forge_model_candidates[0].circuit_open_until,'2026-09-12T00:05:00.000Z');
    assert.equal(writes.forge_model_invocations[0].run_id,'run1');
    assert.equal(writes.forge_model_invocations[0].agent_key,'forja');
    assert.equal(writes.forge_model_invocations[0].tokens_input,11);
    assert.equal(writes.forge_model_invocations[0].tokens_output,22);
    assert.equal(writes.forge_model_invocations[0].latency_ms,333);
  }finally{restore('SUPABASE_URL',oldUrl);restore('SUPABASE_SECRET_KEY',oldKey);}
});

test('migration reconciliation blocks count and file hash divergences',()=>{
  const local=fullSnapshot();
  const missingSkill=fullSnapshot();
  missingSkill.tables.skills=[];
  const changedFile=fullSnapshot();
  changedFile.files.p1['index.html']=Buffer.from('<h1>changed</h1>').toString('base64');
  const divergences=compareSnapshots(local,missingSkill,'u1');
  assert.ok(divergences.some((x)=>x.includes('skills: contagem local=1, remoto=0')));
  assert.ok(divergences.some((x)=>x.includes('skill1 ausente')));
  const fileDivergences=compareSnapshots(local,changedFile,'u1');
  assert.ok(fileDivergences.some((x)=>x.includes('files:p1/index.html hash')));
});


function configureCloudEnv(){
  const saved={url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SECRET_KEY,master:process.env.SECRETS_MASTER_KEY};
  process.env.SUPABASE_URL='https://phase-a.example.test';
  process.env.SUPABASE_SECRET_KEY='test-service-role';
  process.env.SECRETS_MASTER_KEY='stable-master-key-for-bootstrap-tests-32';
  return ()=>{restore('SUPABASE_URL',saved.url);restore('SUPABASE_SECRET_KEY',saved.key);if(saved.master===undefined)delete process.env.SECRETS_MASTER_KEY;else process.env.SECRETS_MASTER_KEY=saved.master;};
}
function makeBootstrapUser(label:string){return AuthService.firebaseLogin(`${label}-${Date.now()}-${Math.random()}@example.test`,label,`fb-${label}-${Date.now()}-${Math.random()}`).user;}
function missingLegacyTable(){return new Response(JSON.stringify({code:'PGRST205',message:"Could not find the table 'public.forge_sync_snapshots' in the schema cache"}),{status:404});}

test('bootstrap treats empty canonical plus missing legacy table as no legacy snapshot, not error',async(t)=>{
  const cleanup=configureCloudEnv(),user=makeBootstrapUser('empty-canonical');
  t.mock.method(CloudSyncService,'pullDirect',async()=>({status:'local_only',source:'canonical'}));
  t.mock.method(globalThis,'fetch',async()=>missingLegacyTable());
  try{const result=await CloudSyncService.bootstrap(user.id);assert.notEqual(result.status,'error');assert.equal(result.status,'local_only');}
  finally{cleanup();}
});

test('new empty account can load when canonical is empty and legacy table is absent',async(t)=>{
  const cleanup=configureCloudEnv(),user=makeBootstrapUser('new-account');
  t.mock.method(CloudSyncService,'pullDirect',async()=>({status:'local_only'}));
  t.mock.method(globalThis,'fetch',async()=>missingLegacyTable());
  try{const result=await CloudSyncService.bootstrap(user.id);assert.deepEqual({status:result.status,device:Boolean((result as any).deviceId)},{status:'local_only',device:true});}
  finally{cleanup();}
});

test('bootstrap pushes canonical when canonical is empty, legacy is absent, and local data exists',async(t)=>{
  const cleanup=configureCloudEnv(),user=makeBootstrapUser('local-data'),now=new Date().toISOString();
  const ws=(db.prepare('SELECT id FROM workspaces WHERE user_id=? LIMIT 1').get(user.id) as any).id;
  db.prepare("INSERT INTO projects(id,user_id,workspace_id,name,origin,created_at,updated_at) VALUES(?,?,?,'Local data','novo',?,?)").run(`local-${Date.now()}`,user.id,ws,now,now);
  let pushed=false;
  t.mock.method(CloudSyncService,'pullDirect',async()=>({status:'local_only'}));
  t.mock.method(CloudSyncService,'pushDirect',async()=>{pushed=true;return{status:'synced',source:'canonical',records:1,files:0};});
  t.mock.method(globalThis,'fetch',async()=>missingLegacyTable());
  try{const result=await CloudSyncService.bootstrap(user.id);assert.equal(result.status,'synced');assert.equal(pushed,true);}
  finally{cleanup();}
});

test('bootstrap restores directly when canonical persistence is populated',async(t)=>{
  const cleanup=configureCloudEnv(),user=makeBootstrapUser('canonical-full');
  t.mock.method(CloudSyncService,'pullDirect',async()=>({status:'synced',restored:true,source:'canonical'}));
  t.mock.method(globalThis,'fetch',async()=>{throw Error('legacy fallback should not be called');});
  try{const result=await CloudSyncService.bootstrap(user.id);assert.equal(result.status,'synced');assert.equal((result as any).source,'canonical');}
  finally{cleanup();}
});

test('legacy snapshot fallback still migrates when a valid legacy snapshot exists',async(t)=>{
  const cleanup=configureCloudEnv(),user=makeBootstrapUser('legacy-valid');
  const payload=fullSnapshot();payload.userId=user.id;payload.tables.user_secrets=[];
  let imported=false,pushed=false;
  t.mock.method(CloudSyncService,'pullDirect',async()=>({status:'local_only'}));
  t.mock.method(CloudSyncService,'import',()=>{imported=true;});
  t.mock.method(CloudSyncService,'pushDirect',async()=>{pushed=true;return{status:'synced'};});
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify([{user_id:user.id,revision:3,device_id:'legacy-device',schema_version:1,payload,updated_at:new Date().toISOString()}]),{status:200}));
  try{const result=await CloudSyncService.bootstrap(user.id);assert.equal(result.status,'synced');assert.equal((result as any).source,'legacy-migrated');assert.equal(imported,true);assert.equal(pushed,true);}
  finally{cleanup();}
});

test('real Supabase errors during legacy fallback still return bootstrap error',async(t)=>{
  for(const status of [401,403,500]){
    const cleanup=configureCloudEnv(),user=makeBootstrapUser(`real-error-${status}`);
    t.mock.method(CloudSyncService,'pullDirect',async()=>({status:'local_only'}));
    t.mock.method(globalThis,'fetch',async()=>new Response('real outage',{status}));
    try{const result=await CloudSyncService.bootstrap(user.id);assert.equal(result.status,'error');assert.match((result as any).message,new RegExp(String(status)));}
    finally{cleanup();t.mock.reset();}
  }
});
