import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {db, initializeDatabase} from '../server/db/index.js';
import {AuthService} from '../server/services/authService.js';
import {SecretService} from '../server/services/secretService.js';
import {IntegrationService} from '../server/services/integrationService.js';
import {verifyFirebaseIdentity} from '../server/services/firebaseIdentity.js';
import {WorkspaceManager} from '../server/services/workspaceManager.js';
import {ModelRouter} from '../server/services/modelRouter.js';
import {CloudSyncService} from '../server/services/cloudSyncService.js';
import {ValidatorEngine} from '../server/services/validatorEngine.js';
import {LLMAdapterService} from '../server/services/llmAdapter.js';
import {GitHubService} from '../server/services/githubService.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const suffix = `${Date.now()}`;
let a: string, b: string;
before(()=>{
  initializeDatabase();
  a = AuthService.firebaseLogin(`a-${suffix}@example.test`, 'A', `fb-a-${suffix}`).user.id;
  b = AuthService.firebaseLogin(`b-${suffix}@example.test`, 'B', `fb-b-${suffix}`).user.id;
});
after(()=>db.close());
test('each new Firebase user receives independent providers and skills',()=>{
  for(const id of [a,b]) {
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM providers WHERE user_id=?').get(id) as any).n,5);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM skills WHERE user_id=?').get(id) as any).n,12);
  }
});
test('model profiles and candidates are isolated and configurable',()=>{const pa=ModelRouter.listProfiles(a),pb=ModelRouter.listProfiles(b);assert.equal(pa.length,3);assert.equal(pb.length,3);assert.equal(pa[0].candidates[0].provider_key,'omniroute');ModelRouter.saveCandidate(a,'BASE_FREE',{providerKey:'omniroute',modelId:'second-free',priority:2});assert.equal(ModelRouter.listProfiles(b)[0].candidates.length,1);});
test('candidate order, pause and removal remain isolated',()=>{let c=ModelRouter.listProfiles(a)[0].candidates.find((x:any)=>x.model_id==='second-free');assert.ok(c);ModelRouter.updateCandidate(a,c.id,{priority:-1,enabled:false});c=ModelRouter.listProfiles(a)[0].candidates.find((x:any)=>x.id===c.id);assert.equal(c.enabled,0);ModelRouter.deleteCandidate(a,c.id);assert.equal(ModelRouter.listProfiles(a)[0].candidates.some((x:any)=>x.id===c.id),false);assert.throws(()=>ModelRouter.updateCandidate(b,c.id,{enabled:true}));});
test('operational failures open and recover a candidate circuit',()=>{const c=ModelRouter.listProfiles(a)[0].candidates[0];ModelRouter.recordCandidateResult(c.id,false,'operational');ModelRouter.recordCandidateResult(c.id,false,'operational');assert.equal(ModelRouter.listProfiles(a)[0].candidates[0].health_state,'open');ModelRouter.recordCandidateResult(c.id,true);assert.equal(ModelRouter.listProfiles(a)[0].candidates[0].health_state,'healthy');});
test('budget governor keeps benchmark daily limits explicit without silently capping normal runs',()=>{
  const previous=process.env.FORGE_DAILY_AI_BUDGET_USD;
  delete process.env.FORGE_DAILY_AI_BUDGET_USD;
  try{
    assert.doesNotThrow(()=>ModelRouter.assertBudget(a,4));
    assert.throws(()=>ModelRouter.assertBudget(a,4,{dailyLimit:3}),/diário/);
    process.env.FORGE_DAILY_AI_BUDGET_USD='3';
    assert.throws(()=>ModelRouter.assertBudget(a,4),/diário/);
  }finally{
    if(previous===undefined)delete process.env.FORGE_DAILY_AI_BUDGET_USD;
    else process.env.FORGE_DAILY_AI_BUDGET_USD=previous;
  }
});
test('budget guard failures cannot leave a candidate quarantined when no provider call happened',()=>{
  const candidate=ModelRouter.listProfiles(a)[0].candidates[0] as any;
  ModelRouter.recordCandidateResult(candidate.id,false,'incompatible');
  const poisoned=db.prepare('SELECT health_state,circuit_open_until FROM model_candidates WHERE id=?').get(candidate.id) as any;
  assert.equal(poisoned.health_state,'incompatible');
  assert.ok(poisoned.circuit_open_until);

  const runId=`budget-repair-run-${suffix}`;
  const stepId=`budget-repair-step-${suffix}`;
  const createdAt=new Date().toISOString();
  db.prepare(`INSERT INTO agent_runs(id,user_id,project_id,conversation_id,mode,status,budget_usd,spent_usd,created_at)
    VALUES(?,?,?,?,?,'failed',.5,0,?)`).run(runId,a,`project-${suffix}`,`conv-${suffix}`,'plan',createdAt);
  db.prepare(`INSERT INTO agent_steps(id,run_id,agent_key,title,status,order_index,scope_level,attempt_count,acceptance_json,context_json,created_at)
    VALUES(?,?,?,'Analyze','failed',0,'task',1,'[]',?,?)`).run(
      stepId,runId,'SCOUT',
      JSON.stringify({events:[{
        type:'agent_stage',stage:'attempt.failed',status:'failed',profile:'BASE_FREE',
        providerKey:candidate.provider_key,modelId:candidate.model_id,error:'Limite diário de IA atingido.'
      }]}),
      createdAt
    );
  try{
    const repaired=ModelRouter.repairFalseBudgetQuarantines();
    assert.ok(repaired>=1);
    const recovered=db.prepare('SELECT health_state,circuit_open_until,consecutive_failures FROM model_candidates WHERE id=?').get(candidate.id) as any;
    assert.equal(recovered.health_state,'healthy');
    assert.equal(recovered.circuit_open_until,null);
    assert.equal(Number(recovered.consecutive_failures),0);
  }finally{
    db.prepare('DELETE FROM agent_steps WHERE id=?').run(stepId);
    db.prepare('DELETE FROM agent_runs WHERE id=?').run(runId);
  }
});

test('Firebase identity stays bound to uid; email cannot take over an existing account',()=>{
  assert.throws(()=>AuthService.firebaseLogin(`a-${suffix}@example.test`,'Other','unrelated-uid'), /outra identidade/);
  assert.equal(AuthService.firebaseLogin(`a-${suffix}@example.test`,'A',`fb-a-${suffix}`).user.id,a);
  assert.equal(a,`usr-firebase-${crypto.createHash('sha256').update(`fb-a-${suffix}`).digest('hex').slice(0,32)}`);
});
test('legacy Firebase identity and owned records migrate to the cross-device stable id',()=>{
  const uid=`legacy-fb-${suffix}`, legacyId=`legacy-${suffix}`, now=new Date().toISOString();
  db.prepare("INSERT INTO users(id,email,name,role,firebase_uid,created_at,updated_at) VALUES(?,?,?,'developer',?,?,?)").run(legacyId,`legacy-${suffix}@example.test`,'Legacy',uid,now,now);
  db.prepare('INSERT INTO workspaces(id,user_id,name,root_path,created_at) VALUES(?,?,?,?,?)').run(`ws-${legacyId}`,legacyId,'Legacy','/legacy',now);
  const migrated=AuthService.firebaseLogin(`legacy-${suffix}@example.test`,'Legacy',uid).user;
  assert.match(migrated.id,/^usr-firebase-[a-f0-9]{32}$/);
  assert.equal((db.prepare('SELECT user_id FROM workspaces WHERE id=?').get(`ws-${legacyId}`) as any).user_id,migrated.id);
  assert.equal(db.prepare('SELECT id FROM users WHERE id=?').get(legacyId),undefined);
});
test('a clean second runtime restores projects, active provider, secrets and conversations before loading',async(t)=>{
  const uid=`sync-fb-${suffix}`, email=`sync-${suffix}@example.test`;
  const {user}=AuthService.firebaseLogin(email,'Sync User',uid);
  const workspace=(db.prepare('SELECT id FROM workspaces WHERE user_id=? LIMIT 1').get(user.id) as any).id;
  const now=new Date().toISOString(), projectId=`sync-project-${suffix}`, conversationId=`sync-conversation-${suffix}`;
  db.prepare("INSERT INTO projects(id,user_id,workspace_id,name,origin,created_at,updated_at) VALUES(?,?,?,'Cloud project','novo',?,?)").run(projectId,user.id,workspace,now,now);
  db.prepare("UPDATE providers SET is_active=CASE WHEN provider_key='cheaper_inference' THEN 1 ELSE 0 END WHERE user_id=?").run(user.id);
  SecretService.saveSecret(user.id,'github','github-secret-for-second-runtime');
  db.prepare("INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES(?,?,'Cloud conversation',?,?)").run(conversationId,projectId,now,now);
  const snapshot=CloudSyncService.export(user.id);
  for(const table of ['conversations','projects'])db.prepare(`DELETE FROM ${table} WHERE ${table==='projects'?'user_id':'project_id'}=?`).run(table==='projects'?user.id:projectId);
  for(const table of ['providers','user_secrets','workspaces'])db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(user.id);
  const previousUrl=process.env.SUPABASE_URL, previousKey=process.env.SUPABASE_SECRET_KEY, previousMaster=process.env.SECRETS_MASTER_KEY;
  process.env.SUPABASE_URL='https://sync.example.test';process.env.SUPABASE_SECRET_KEY='test-service-role';process.env.SECRETS_MASTER_KEY='stable-master-key-for-both-test-runtimes';
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify([{user_id:user.id,revision:7,device_id:'other-device',schema_version:1,payload:snapshot,updated_at:now}]),{status:200,headers:{'content-type':'application/json'}}));
  try{
    const result=await CloudSyncService.bootstrap(user.id);
    assert.equal(result.status,'synced');
    assert.equal((db.prepare('SELECT name FROM projects WHERE id=?').get(projectId) as any).name,'Cloud project');
    assert.equal((db.prepare("SELECT is_active FROM providers WHERE user_id=? AND provider_key='cheaper_inference'").get(user.id) as any).is_active,1);
    assert.equal(SecretService.getDecryptedSecret(user.id,'github'),'github-secret-for-second-runtime');
    assert.equal((db.prepare('SELECT title FROM conversations WHERE id=?').get(conversationId) as any).title,'Cloud conversation');

  }finally{
    if(previousUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=previousUrl;
    if(previousKey===undefined)delete process.env.SUPABASE_SECRET_KEY;else process.env.SUPABASE_SECRET_KEY=previousKey;
    if(previousMaster===undefined)delete process.env.SECRETS_MASTER_KEY;else process.env.SECRETS_MASTER_KEY=previousMaster;
  }
});
test('required cloud configuration reports only safe presence flags and fails closed',()=>{
  const saved={url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SECRET_KEY,master:process.env.SECRETS_MASTER_KEY,required:process.env.FORGE_REQUIRE_CLOUD_SYNC};
  process.env.FORGE_REQUIRE_CLOUD_SYNC='true';delete process.env.SUPABASE_URL;delete process.env.SUPABASE_SECRET_KEY;delete process.env.SECRETS_MASTER_KEY;
  try{const status=CloudSyncService.configurationStatus();assert.deepEqual(status,{configured:false,hasSupabaseUrl:false,hasSupabaseKey:false,hasMasterKey:false,required:true});assert.throws(()=>CloudSyncService.assertPersistentConfiguration(),/Cloud sync obrigatório/);}finally{for(const [key,value] of Object.entries(saved)){const envName={url:'SUPABASE_URL',key:'SUPABASE_SECRET_KEY',master:'SECRETS_MASTER_KEY',required:'FORGE_REQUIRE_CLOUD_SYNC'}[key]!;if(value===undefined)delete process.env[envName];else process.env[envName]=value;}}
});
test('two independent runtimes restore atomically and reject a different master key',()=>{
  const root=path.resolve(process.env.FORGE_DATA_DIR||'.data','two-runtime-'+suffix),snapshot=path.join(root,'snapshot.json'),fixture=path.resolve('tests/fixtures/cloudRuntime.ts');fs.mkdirSync(root,{recursive:true});
  const run=(name:string,mode:string,master:string)=>spawnSync(process.execPath,['--import','tsx',fixture,mode,snapshot],{encoding:'utf8',env:{...process.env,FORGE_DATA_DIR:path.join(root,name),SUPABASE_URL:'https://sync.example.test',SUPABASE_SECRET_KEY:'test-service-role',SECRETS_MASTER_KEY:master}});
  const a=run('runtime-a','create','same-stable-master-key-across-runtimes');assert.equal(a.status,0,a.stderr);
  const b=run('runtime-b','restore','same-stable-master-key-across-runtimes');assert.equal(b.status,0,b.stderr);const restored=JSON.parse(b.stdout);assert.deepEqual(restored,{status:'synced',projects:1,active:'cheaper_inference',secret:'secret-survives-runtime',conversations:1});
  const bad=run('runtime-b-wrong-key','restore','different-master-key-for-this-runtime');assert.equal(bad.status,0,bad.stderr);const rejected=JSON.parse(bad.stdout);assert.equal(rejected.status,'error');assert.equal(rejected.projects,0);assert.equal(rejected.secret,null);assert.equal(rejected.conversations,0);
});
test('sessions are revoked and never reconstructed from user-default',()=>{
  const session=AuthService.createSession(a);
  assert.equal(AuthService.validateSession(session.token)?.id,a);
  AuthService.logout(session.token);
  assert.equal(AuthService.validateSession(session.token),null);
  assert.equal(AuthService.validateSession(''),null);
});
test('integration credentials are encrypted, scoped, and not returned to the client',()=>{
  const token='test-private-token-123456789';
  const summary=IntegrationService.save(a,'cloudflare',{token, accountId:'account123'});
  assert.equal(summary.configured,true);
  assert.equal(JSON.stringify(summary).includes(token),false);
  assert.equal(IntegrationService.summary(b,'cloudflare').configured,false);
  const row=db.prepare('SELECT encrypted_value FROM user_secrets WHERE user_id=? AND service_key=?').get(a,'integration:cloudflare') as any;
  assert.equal(row.encrypted_value.includes(token),false);
  IntegrationService.save(a,'cloudflare',{accountId:'account456',token:''});
  assert.equal(IntegrationService.read(a,'cloudflare').token,token);
});
test('invalid integration config does not overwrite a saved secret',()=>{
  assert.throws(()=>IntegrationService.save(a,'cloudflare',{accountId:'../escape'}));
  assert.equal(IntegrationService.read(a,'cloudflare').accountId,'account456');
  assert.throws(()=>IntegrationService.save(a,'firebase',{serviceAccount:'{}'}));
});
test('unknown provider configuration is never reported as connected just because a key has characters',async()=>{
  const result=await LLMAdapterService.testConnection({
    providerKey:'unimplemented-service',
    apiKey:'long-arbitrary-value',
    baseUrl:'not-a-valid-url',
    modelId:'unknown-model',
    userId:a,
  });
  assert.equal(result.success,false);
  assert.equal(result.status,'invalid_url');
});
test('Firebase login rejects missing token without network request',async()=>{
  await assert.rejects(()=>verifyFirebaseIdentity(undefined),/Token/);
});
test('Firebase identity comes from verified response, not fields supplied by a browser',async(t)=>{
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({users:[{localId:'verified-id',email:'verified@example.test',displayName:'Verified'}]}),{status:200}));
  const user=await verifyFirebaseIdentity('x'.repeat(100));
  assert.equal(user.uid,'verified-id');
  assert.equal(user.email,'verified@example.test');
});
test('failed connection tests cannot produce a success status',async(t)=>{
  t.mock.method(globalThis,'fetch',async()=>new Response('{}',{status:403}));
  await assert.rejects(()=>IntegrationService.test(a,'cloudflare'),/403/);
});
test('checkpoint restores text and binary assets and removes subsequent files',()=>{
  const id=`restore-${suffix}`;
  const now=new Date().toISOString();
  db.prepare("INSERT INTO projects(id,user_id,workspace_id,name,origin,created_at,updated_at) VALUES(?,?,?,'Restore','novo',?,?)").run(id,a,`ws-${a}`,now,now);
  WorkspaceManager.writeFile(id,'index.html','<html lang="pt"></html>');
  WorkspaceManager.writeBinaryFile(id,'logo.png',Buffer.from([0,1,2,255]));
  const checkpoint=WorkspaceManager.createCheckpoint(id,'Versão com logo');
  WorkspaceManager.writeBinaryFile(id,'logo.png',Buffer.from([9]));
  WorkspaceManager.writeFile(id,'extra.txt','later');
  assert.equal(WorkspaceManager.restoreCheckpoint(id,checkpoint),true);
  assert.deepEqual(WorkspaceManager.readBinaryFile(id,'logo.png'),Buffer.from([0,1,2,255]));
  assert.equal(WorkspaceManager.readFile(id,'extra.txt'),null);
});
test('plain HTML without a toolchain passes the applicable static validation gate',async()=>{const id=`html-static-${suffix}`,now=new Date().toISOString();db.prepare("INSERT INTO projects(id,user_id,workspace_id,name,origin,created_at,updated_at) VALUES(?,?,?,'HTML','novo',?,?)").run(id,a,`ws-${a}`,now,now);WorkspaceManager.writeFile(id,'index.html','<!doctype html><html><body><script src="app.js"></script></body></html>');WorkspaceManager.writeFile(id,'app.js','document.body.dataset.ready="true";');const result=await ValidatorEngine.validate({projectId:id});assert.equal(result.status,'passed');assert.equal(result.passed,true);assert.ok(result.results.every(item=>item.status==='skipped'));assert.equal(result.advisory?.status,'pass');});
test('an executed npm build failure is failed and eligible for rollback',async()=>{const id=`build-failed-${suffix}`,now=new Date().toISOString();db.prepare("INSERT INTO projects(id,user_id,workspace_id,name,origin,created_at,updated_at) VALUES(?,?,?,'Build failure','novo',?,?)").run(id,a,`ws-${a}`,now,now);WorkspaceManager.writeFile(id,'package.json',JSON.stringify({scripts:{build:'node -e "process.exit(1)"'}}));const result=await ValidatorEngine.validate({projectId:id});assert.equal(result.status,'failed');assert.equal(result.results.find(item=>item.tool==='build')?.status,'fail');});



test('provider tester classifies rate limit and upstream errors precisely', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({error:{message:'limit'}}), {status: 429}));
  const limited = await LLMAdapterService.testConnection({providerKey:'useoneai', apiKey:'sk-test', baseUrl:'https://api.example.test/v1', modelId:'chatgpt-5.5'});
  assert.equal(limited.success, false);
  assert.equal(limited.status, 'rate_limit');

  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({error:{message:'temporarily down'}}), {status: 502}));
  const upstream = await LLMAdapterService.testConnection({providerKey:'useoneai', apiKey:'sk-test', baseUrl:'https://api.example.test/v1', modelId:'chatgpt-5.5'});
  assert.equal(upstream.success, false);
  assert.equal(upstream.status, 'provider_error');
});


test('GitHub status remains unknown when compare API cannot classify divergence', async (t) => {
  const originalToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'ghp_test_token';
  t.after(() => { if (originalToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = originalToken; });
  t.mock.method(globalThis, 'fetch', async (url: any) => {
    const target = String(url);
    if (target.includes('/commits/main')) {
      return new Response(JSON.stringify({sha:'remote-sha', commit:{message:'remote', author:{date:'2026-09-13T00:00:00Z', name:'Dev'}}}), {status: 200});
    }
    if (target.includes('/compare/local-sha...remote-sha')) {
      return new Response(JSON.stringify({message:'comparison unavailable'}), {status: 502});
    }
    return new Response('{}', {status: 404});
  });
  const status = await GitHubService.getSyncStatus({owner:'owner', repo:'repo', branch:'main', localHeadSha:'local-sha'});
  assert.equal(status.success, true);
  assert.equal(status.syncStatus, 'unknown');
});

test('GitHub branch creation returns the real base SHA instead of a placeholder', async (t) => {
  const originalToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'ghp_test_token';
  t.after(() => { if (originalToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = originalToken; });
  t.mock.method(globalThis, 'fetch', async (url: any, init?: any) => {
    const target = String(url);
    if (target.includes('/git/ref/heads/main')) {
      return new Response(JSON.stringify({object:{sha:'base-real-sha'}}), {status: 200});
    }
    if (target.includes('/git/refs') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      assert.equal(body.sha, 'base-real-sha');
      return new Response(JSON.stringify({ref:'refs/heads/feature/test'}), {status: 201});
    }
    return new Response('{}', {status: 404});
  });
  const result = await GitHubService.createBranch({owner:'owner', repo:'repo', newBranch:'feature/test', fromBranch:'main'});
  assert.equal(result.success, true);
  assert.equal(result.baseSha, 'base-real-sha');
});


test('GitHub push preserves binary files while deleting only paths absent locally', async (t) => {
  const originalToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'ghp_test_token';
  t.after(() => { if (originalToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = originalToken; });
  let createdTreeBody: any = null;
  t.mock.method(globalThis, 'fetch', async (url: any, init?: any) => {
    const target = String(url);
    if (target.includes('/git/ref/heads/main') && (!init || init.method === undefined)) {
      return new Response(JSON.stringify({object:{sha:'commit-sha'}}), {status: 200});
    }
    if (target.includes('/git/commits/commit-sha') && (!init || init.method === undefined)) {
      return new Response(JSON.stringify({tree:{sha:'base-tree-sha'}}), {status: 200});
    }
    if (target.includes('/git/trees/base-tree-sha')) {
      return new Response(JSON.stringify({tree:[
        {path:'keep.html', type:'blob'},
        {path:'assets/logo.png', type:'blob'},
        {path:'removed.html', type:'blob'}
      ]}), {status: 200});
    }
    if (target.endsWith('/git/blobs') && init?.method === 'POST') {
      const body=JSON.parse(String(init.body));
      if(body.encoding==='base64'){
        assert.equal(body.content,Buffer.from([0,1,2,255]).toString('base64'));
        return new Response(JSON.stringify({sha:'blob-binary'}), {status: 201});
      }
      return new Response(JSON.stringify({sha:'blob-text'}), {status: 201});
    }
    if (target.endsWith('/git/trees') && init?.method === 'POST') {
      createdTreeBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({sha:'new-tree-sha'}), {status: 201});
    }
    if (target.endsWith('/git/commits') && init?.method === 'POST') {
      return new Response(JSON.stringify({sha:'new-commit-sha'}), {status: 201});
    }
    if (target.includes('/git/refs/heads/main') && init?.method === 'PATCH') {
      return new Response(JSON.stringify({object:{sha:'new-commit-sha'}}), {status: 200});
    }
    return new Response('{}', {status: 404});
  });
  const result = await GitHubService.pushFilesToRepo({
    owner:'owner', repo:'repo', branch:'main', commitMessage:'sync',
    files:{'keep.html':'<h1>keep</h1>'},
    binaryFiles:{'assets/logo.png':Buffer.from([0,1,2,255])}
  });
  assert.equal(result.success, true);
  assert.ok(createdTreeBody.tree.some((item: any) => item.path === 'removed.html' && item.sha === null));
  assert.ok(createdTreeBody.tree.some((item: any) => item.path === 'keep.html' && item.sha === 'blob-text'));
  assert.ok(createdTreeBody.tree.some((item: any) => item.path === 'assets/logo.png' && item.sha === 'blob-binary'));
});

test('GitHub import returns the real remote head and complete blob path inventory', async (t) => {
  t.mock.method(globalThis,'fetch',async(url:any)=>{
    const target=String(url);
    if(target==='https://api.github.com/repos/owner/repo') return new Response(JSON.stringify({default_branch:'main'}),{status:200});
    if(target.includes('/commits/main')) return new Response(JSON.stringify({sha:'remote-head-sha',commit:{tree:{sha:'remote-tree-sha'}}}),{status:200});
    if(target.includes('/git/trees/remote-tree-sha')) return new Response(JSON.stringify({truncated:false,tree:[
      {path:'src/app.ts',type:'blob',sha:'text-sha',size:20},
      {path:'assets/logo.png',type:'blob',sha:'binary-sha',size:4},
      {path:'large.dat',type:'blob',sha:'large-sha',size:3000000}
    ]}),{status:200});
    if(target.includes('/git/blobs/text-sha')) return new Response(JSON.stringify({encoding:'base64',content:Buffer.from('export const ok=true;').toString('base64')}),{status:200});
    if(target.includes('/git/blobs/binary-sha')) return new Response(JSON.stringify({encoding:'base64',content:Buffer.from([0,1,2,3]).toString('base64')}),{status:200});
    return new Response('{}',{status:404});
  });
  const result=await GitHubService.importRepoFiles('owner','repo','main');
  assert.equal(result.success,true);
  assert.equal(result.headSha,'remote-head-sha');
  assert.deepEqual(result.remotePaths,['src/app.ts','assets/logo.png','large.dat']);
  assert.equal(result.files?.['src/app.ts'],'export const ok=true;');
  assert.deepEqual(result.binaryFiles?.['assets/logo.png'],Buffer.from([0,1,2,3]));
  assert.equal('large.dat' in (result.binaryFiles||{}),false);
});
