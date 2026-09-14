import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import {router} from '../server/routes.js';
import {db,initializeDatabase} from '../server/db/index.js';
import {AuthService} from '../server/services/authService.js';
import {LLMAdapterService} from '../server/services/llmAdapter.js';
import {WorkspaceManager} from '../server/services/workspaceManager.js';
import {RuntimeManager} from '../server/services/runtimeManager.js';
import {SecretService} from '../server/services/secretService.js';
import {ValidatorEngine} from '../server/services/validatorEngine.js';
import {RunService} from '../server/services/runService.js';
import {RequirementLedgerService} from '../server/services/requirementLedgerService.js';
import {AgentEngine} from '../server/agent-engine/agentEngine.js';
import {SandboxManager} from '../server/tooling/sandboxManager.js';
import type {Server} from 'node:http';

let server:Server, base:string, tokenA:string, tokenB:string, userA:string, userB:string;
const id=`http-project-${Date.now()}`;
async function waitForCondition(check:()=>boolean,timeoutMs=10000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    if(check())return;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.fail('Timed out waiting for background workflow.');
}
async function waitForRunTerminal(runId:string,timeoutMs=10000){
  await waitForCondition(()=>{
    const row=db.prepare('SELECT status FROM agent_runs WHERE id=?').get(runId) as any;
    return Boolean(row&&row.status!=='running'&&row.status!=='waiting_approval');
  },timeoutMs);
  return db.prepare('SELECT * FROM agent_runs WHERE id=?').get(runId) as any;
}
before(async()=>{
  initializeDatabase();
  userA=AuthService.firebaseLogin(`${id}-a@example.test`,'A',`${id}-firebase-a`).user.id;
  userB=AuthService.firebaseLogin(`${id}-b@example.test`,'B',`${id}-firebase-b`).user.id;
  tokenA=AuthService.createSession(userA).token;
  tokenB=AuthService.createSession(userB).token;
  db.prepare("INSERT INTO projects(id,user_id,workspace_id,name,origin,created_at,updated_at) VALUES(?,?,?,'Private','novo',?,?)").run(id,userA,`ws-${userA}`,new Date().toISOString(),new Date().toISOString());
  const app=express();app.use(cookieParser());app.use(express.json());app.use('/api',router);
  await new Promise<void>(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});
  base=`http://127.0.0.1:${(server.address() as any).port}/api`;
});
after(async()=>{await RuntimeManager.stopAll();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));db.close();});
test('no anonymous access without a Firebase-backed session',async()=>{
  const r=await fetch(`${base}/projects`);assert.equal(r.status,401);
});
test('forged Firebase email/uid cannot create a session',async()=>{
  const r=await fetch(`${base}/auth/firebase-login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'developer@forgeagent.dev',uid:'forged'})});
  assert.equal(r.status,400);assert.equal(r.headers.get('set-cookie'),null);
});
test('project owner has access; second user does not',async()=>{
  assert.equal((await fetch(`${base}/projects/${id}`,{headers:{Authorization:`Bearer ${tokenA}`}})).status,200);
  assert.equal((await fetch(`${base}/projects/${id}`,{headers:{Authorization:`Bearer ${tokenB}`}})).status,403);
  assert.equal((await fetch(`${base}/preview/${id}/index.html`,{headers:{Authorization:`Bearer ${tokenB}`}})).status,403);
});
test('provider list only contains this user’s rows',async()=>{
  const r=await fetch(`${base}/providers`,{headers:{Authorization:`Bearer ${tokenA}`}});assert.equal(r.status,200);
  const {providers}=await r.json();assert.equal(providers.length,5);assert.ok(providers.every((p:any)=>p.id.includes(userA)));
});
test('cookie mutations require a CSRF header',async()=>{
  const r=await fetch(`${base}/providers/update`,{method:'POST',headers:{Cookie:`forge_session=${tokenA}; forge_csrf=expected`,'Content-Type':'application/json'},body:JSON.stringify({providerKey:'useoneai',modelId:'test'})});
  assert.equal(r.status,403);
});
test('cloud sync reports not-configured when Supabase is not configured',async()=>{const r=await fetch(`${base}/sync/status`,{headers:{Authorization:`Bearer ${tokenA}`}});assert.equal(r.status,200);const body=await r.json();assert.equal(body.configured,false);assert.equal(body.status,'not_configured');});
test('proposal preview serves temporary files without changing the workspace',async()=>{const now=new Date().toISOString(),conversation=`preview-conversation-${Date.now()}`,proposal=`preview-proposal-${Date.now()}`;WorkspaceManager.writeFile(id,'index.html','<html><body>ORIGINAL</body></html>');db.prepare('INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(conversation,id,'Preview',now,now);db.prepare("INSERT INTO messages(id,conversation_id,sender,content,metadata_json,created_at) VALUES(?,?,'agent','proposal',?,?)").run(`preview-message-${Date.now()}`,conversation,JSON.stringify({proposal:{id:proposal,status:'pending',files:[{path:'index.html',action:'modify',content:'<html><body>CALCULADORA</body></html>'}]}}),now);const preview=await fetch(`${base}/preview-proposal/${id}/${proposal}/index.html`,{headers:{Authorization:`Bearer ${tokenA}`}});assert.equal(preview.status,200);assert.match(preview.headers.get('content-security-policy') || '', /connect-src 'self' https: wss:/);assert.match(await preview.text(),/CALCULADORA/);assert.match(WorkspaceManager.readFile(id,'index.html')||'',/ORIGINAL/);});
test('failed executed validation rolls an applied proposal back to the exact previous workspace',async()=>{
  const now=new Date(Date.now()+1000).toISOString();
  const conversation=`rollback-conversation-${Date.now()}`;
  const proposal=`rollback-proposal-${Date.now()}`;
  WorkspaceManager.writeFile(id,'index.html','<html><body>ROLLBACK_ORIGINAL</body></html>');
  WorkspaceManager.deleteFile(id,'package.json');
  db.prepare('INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(conversation,id,'Rollback validation',now,now);
  db.prepare("INSERT INTO messages(id,conversation_id,sender,content,metadata_json,created_at) VALUES(?,?,'agent','proposal',?,?)")
    .run(
      `rollback-message-${Date.now()}`,
      conversation,
      JSON.stringify({proposal:{
        id:proposal,
        status:'pending',
        files:[
          {path:'index.html',action:'modify',content:'<html><body>SHOULD_BE_REVERTED</body></html>'},
          {path:'package.json',action:'create',content:JSON.stringify({scripts:{build:'node -e "process.exit(1)"'}})}
        ]
      }}),
      now
    );

  const response=await fetch(`${base}/conversations/${id}/apply-proposal`,{
    method:'POST',
    headers:{Authorization:`Bearer ${tokenA}`,'Content-Type':'application/json'},
    body:JSON.stringify({proposalId:proposal,summary:'Rollback real'})
  });
  assert.equal(response.status,422);
  assert.match(WorkspaceManager.readFile(id,'index.html')||'',/ROLLBACK_ORIGINAL/);
  assert.equal(WorkspaceManager.readFile(id,'package.json'),null);
  const metadata=JSON.parse((db.prepare('SELECT metadata_json FROM messages WHERE conversation_id=? AND sender=\'agent\' ORDER BY created_at DESC LIMIT 1').get(conversation) as any).metadata_json);
  assert.equal(metadata.proposal.status,'failed_validation');
  assert.equal(metadata.validation.status,'failed');
});

test('unverified static proposal remains needs_verification and cannot trigger SHIP',async()=>{
  const now=new Date(Date.now()+1500).toISOString();
  const conversation=`unverified-conversation-${Date.now()}`;
  const proposal=`unverified-proposal-${Date.now()}`;
  const planId=`unverified-plan-${Date.now()}`;
  WorkspaceManager.deleteFile(id,'package.json');
  WorkspaceManager.writeFile(id,'index.html','<!doctype html><html><body>BASE</body></html>');
  db.prepare('INSERT INTO conversations(id,project_id,title,mode,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(conversation,id,'Unverified static','build',now,now);
  db.prepare(`INSERT INTO plans(
    id,task_id,project_id,objective,scope_in,scope_out,architecture_summary,
    existing_files_json,new_files_json,files_to_delete_json,files_affected_json,
    integrations_json,risks_json,acceptance_criteria_json,requirements_json,task_graph_json,status,created_at,updated_at
  ) VALUES(?,NULL,?,?,?,?,?,'[]','[]','[]','[]','[]','[]','[]',?,'[]','approved',?,?)`)
    .run(planId,id,'Static feature','Static HTML','','Static architecture',JSON.stringify([
      {id:'REQ-001',title:'Render feature',description:'Feature visível',priority:'critical',verification:['browser evidence']}
    ]),now,now);
  const {runId,stepId}=RunService.start(userA,id,conversation,'build',0.5);
  RequirementLedgerService.syncPlan({
    projectId:id,conversationId:conversation,runId,planId,
    requirements:[{id:'REQ-001',title:'Render feature',description:'Feature visível',priority:'critical',verification:['browser evidence']}],
  });
  const messageId=`unverified-message-${Date.now()}`;
  db.prepare("INSERT INTO messages(id,conversation_id,sender,content,metadata_json,created_at) VALUES(?,?,'agent','proposal',?,?)")
    .run(messageId,conversation,JSON.stringify({
      planId,
      runId,
      executionType:'agent_engine',
      agentKey:'FORGE',
      workflow:{runId,status:'waiting_approval',steps:[stepId],shipRequested:true},
      proposal:{id:proposal,status:'pending',summary:'Static change',files:[
        {path:'index.html',action:'modify',content:'<!doctype html><html><body><button>Novo Produto</button></body></html>'}
      ]}
    }),now);

  const response=await fetch(`${base}/conversations/${id}/apply-proposal`,{
    method:'POST',
    headers:{Authorization:`Bearer ${tokenA}`,'Content-Type':'application/json'},
    body:JSON.stringify({proposalId:proposal,summary:'Static unverified'})
  });
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.validation.status,'unverified');
  assert.equal(body.needsVerification,true);
  const run=db.prepare('SELECT status FROM agent_runs WHERE id=?').get(runId) as any;
  assert.equal(run.status,'needs_verification');
  const requirement=db.prepare('SELECT status FROM requirements WHERE run_id=? AND requirement_key=?').get(runId,'REQ-001') as any;
  assert.equal(requirement.status,'implemented');
  const shipCount=(db.prepare("SELECT COUNT(*) n FROM agent_steps WHERE run_id=? AND agent_key='SHIP'").get(runId) as any).n;
  assert.equal(shipCount,0);
});

test('invalid proposal is rejected before mutation and remains pending',async()=>{
  const now=new Date(Date.now()+2000).toISOString();
  const conversation=`invalid-proposal-conversation-${Date.now()}`;
  const proposal=`invalid-proposal-${Date.now()}`;
  WorkspaceManager.writeFile(id,'index.html','<html><body>INVALID_ACTION_ORIGINAL</body></html>');
  db.prepare('INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(conversation,id,'Invalid proposal preflight',now,now);
  db.prepare("INSERT INTO messages(id,conversation_id,sender,content,metadata_json,created_at) VALUES(?,?,'agent','proposal',?,?)")
    .run(
      `invalid-proposal-message-${Date.now()}`,
      conversation,
      JSON.stringify({proposal:{
        id:proposal,
        status:'pending',
        files:[
          {path:'index.html',action:'execute',content:'<html><body>SHOULD_NOT_APPLY</body></html>'}
        ]
      }}),
      now
    );

  const response=await fetch(`${base}/conversations/${id}/apply-proposal`,{
    method:'POST',
    headers:{Authorization:`Bearer ${tokenA}`,'Content-Type':'application/json'},
    body:JSON.stringify({proposalId:proposal,summary:'Invalid preflight'})
  });
  assert.equal(response.status,400);
  assert.match(WorkspaceManager.readFile(id,'index.html')||'',/INVALID_ACTION_ORIGINAL/);
  const metadata=JSON.parse((db.prepare("SELECT metadata_json FROM messages WHERE conversation_id=? AND sender='agent' ORDER BY created_at DESC LIMIT 1").get(conversation) as any).metadata_json);
  assert.equal(metadata.proposal.status,'pending');
});

test('unexpected validation exception restores workspace and makes proposal retryable',async()=>{
  const now=new Date(Date.now()+3000).toISOString();
  const conversation=`exception-proposal-conversation-${Date.now()}`;
  const proposal=`exception-proposal-${Date.now()}`;
  WorkspaceManager.writeFile(id,'index.html','<html><body>EXCEPTION_ORIGINAL</body></html>');
  db.prepare('INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(conversation,id,'Unexpected validation exception',now,now);
  db.prepare("INSERT INTO messages(id,conversation_id,sender,content,metadata_json,created_at) VALUES(?,?,'agent','proposal',?,?)")
    .run(
      `exception-proposal-message-${Date.now()}`,
      conversation,
      JSON.stringify({proposal:{
        id:proposal,
        status:'pending',
        files:[
          {path:'index.html',action:'modify',content:'<html><body>MUTATED_BEFORE_EXCEPTION</body></html>'}
        ]
      }}),
      now
    );

  const originalValidate=ValidatorEngine.validate;
  ValidatorEngine.validate=async()=>{ throw new Error('synthetic validator crash'); };
  try {
    const response=await fetch(`${base}/conversations/${id}/apply-proposal`,{
      method:'POST',
      headers:{Authorization:`Bearer ${tokenA}`,'Content-Type':'application/json'},
      body:JSON.stringify({proposalId:proposal,summary:'Unexpected validator crash'})
    });
    assert.equal(response.status,500);
    assert.match(WorkspaceManager.readFile(id,'index.html')||'',/EXCEPTION_ORIGINAL/);
    const metadata=JSON.parse((db.prepare("SELECT metadata_json FROM messages WHERE conversation_id=? AND sender='agent' ORDER BY created_at DESC LIMIT 1").get(conversation) as any).metadata_json);
    assert.equal(metadata.proposal.status,'pending');
    assert.equal(metadata.hasErrors,true);
    assert.match(metadata.errorMessage,/restaurado/i);
  } finally {
    ValidatorEngine.validate=originalValidate;
  }
});

test('changing model configuration does not mutate another user',async()=>{
  const r=await fetch(`${base}/providers/update`,{method:'POST',headers:{Authorization:`Bearer ${tokenA}`,'Content-Type':'application/json'},body:JSON.stringify({providerKey:'useoneai',modelId:'my-model'})});
  assert.equal(r.status,200);
  assert.equal((db.prepare("SELECT model_id FROM providers WHERE user_id=? AND provider_key='useoneai'").get(userB) as any).model_id,'chatgpt-5.5');
});
test('saving a provider makes that exact model the active account model',async()=>{
  const r=await fetch(`${base}/providers/save-with-key`,{method:'POST',headers:{Authorization:`Bearer ${tokenA}`,'Content-Type':'application/json'},body:JSON.stringify({providerKey:'cheaper_inference',baseUrl:'https://example.test/v1',modelId:'gpt-test',apiKey:'private-test-key'})});
  assert.equal(r.status,200);
  const row=db.prepare('SELECT model_id, is_active, connection_status FROM providers WHERE user_id=? AND provider_key=?').get(userA,'cheaper_inference') as any;
  assert.equal(row.model_id,'gpt-test');assert.equal(row.is_active,1);assert.equal(row.connection_status,'untested');
});
test('testing a provider never changes the active provider',async()=>{
  const original=LLMAdapterService.testConnection;
  LLMAdapterService.testConnection=async()=>({success:true,status:'connected',message:'OK',latencyMs:1,provider:'cheaper_inference',model:'gpt-test'} as any);
  try {
    const r=await fetch(`${base}/providers/test`,{method:'POST',headers:{Authorization:`Bearer ${tokenA}`,'Content-Type':'application/json'},body:JSON.stringify({providerKey:'cheaper_inference'})});
    assert.equal(r.status,200);
    const row=db.prepare('SELECT is_active,connection_status FROM providers WHERE user_id=? AND provider_key=?').get(userA,'cheaper_inference') as any;
    assert.equal(row.is_active,1);assert.equal(row.connection_status,'connected');
  } finally { LLMAdapterService.testConnection=original; }
});



test('approving a draft plan builds, validates and applies the result without a second approval',async()=>{
  const previousFlag=process.env.AGENT_ENGINE_ENABLED;
  delete process.env.AGENT_ENGINE_ENABLED;
  const now=new Date(Date.now()+5000).toISOString();
  const conversation=`plan-approve-conversation-${Date.now()}`;
  const planId=`plan-approve-${Date.now()}`;
  db.prepare('INSERT INTO conversations(id,project_id,title,mode,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(conversation,id,'Plan approval','plan',now,now);
  db.prepare(`INSERT INTO plans(id,task_id,project_id,objective,scope_in,scope_out,files_affected_json,integrations_json,risks_json,acceptance_criteria_json,status,created_at,updated_at)
    VALUES(?,NULL,?,?,?,?,?,?,?,?,'draft',?,?)`).run(planId,id,'Criar dashboard financeiro','Dashboard e fluxo de caixa','Deploy externo',JSON.stringify(['index.html']),JSON.stringify([]),JSON.stringify([]),JSON.stringify(['Dashboard funcional']),now,now);
  WorkspaceManager.writeFile(id,'index.html','<html><body>ORIGINAL_PLAN_APPROVAL</body></html>');
  SecretService.saveSecret(userA,'omniroute','test-omniroute-key-plan-approval');
  db.prepare('UPDATE providers SET is_active=0 WHERE user_id=?').run(userA);
  db.prepare("UPDATE providers SET is_active=1,is_configured=1,connection_status='connected',model_id='auto' WHERE user_id=? AND provider_key='omniroute'").run(userA);
  const originalExecute=LLMAdapterService.executePrompt;
  LLMAdapterService.executePrompt=async()=>({
    replyText:'Proposta gerada a partir do plano aprovado.',mode:'build',decisionType:'change',isDemonstrativeFallback:false,
    providerUsed:'OmniRoute (Free Pool)',modelUsed:'auto',hasErrors:false,
    build:{summary:'Construir dashboard financeiro',explanation:'Implementação proposta',files:[{path:'index.html',action:'modify',content:'<html><body>DASHBOARD_PROPOSTO</body></html>'}]}
  } as any);
  try{
    const response=await fetch(`${base}/conversations/${id}/plan/approve`,{method:'POST',headers:{Authorization:`Bearer ${tokenA}`,'Content-Type':'application/json'},body:JSON.stringify({planId})});
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.success,true);
    assert.equal(body.proposal.status,'applied');
    assert.match(WorkspaceManager.readFile(id,'index.html')||'',/DASHBOARD_PROPOSTO/);
    assert.equal((db.prepare('SELECT status FROM plans WHERE id=?').get(planId) as any).status,'approved');
    assert.equal((db.prepare('SELECT mode FROM conversations WHERE id=?').get(conversation) as any).mode,'build');
    const message=db.prepare("SELECT metadata_json FROM messages WHERE conversation_id=? AND sender='agent' ORDER BY created_at DESC LIMIT 1").get(conversation) as any;
    const metadata=JSON.parse(message.metadata_json);
    assert.equal(metadata.planId,planId);
    assert.equal(metadata.proposal.status,'applied');
  }finally{
    LLMAdapterService.executePrompt=originalExecute;
    if(previousFlag===undefined)delete process.env.AGENT_ENGINE_ENABLED;else process.env.AGENT_ENGINE_ENABLED=previousFlag;
  }
});

test('agent-engine plan approval returns quickly while build, review and apply continue in background',async()=>{
  const now=new Date(Date.now()+6500).toISOString();
  const conversation=`agent-plan-approve-conversation-${Date.now()}`;
  const planId=`agent-plan-approve-${Date.now()}`;
  db.prepare('INSERT INTO conversations(id,project_id,title,mode,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(conversation,id,'Agent plan approval','plan',now,now);
  db.prepare(`INSERT INTO plans(id,task_id,project_id,objective,scope_in,scope_out,files_affected_json,integrations_json,risks_json,acceptance_criteria_json,status,created_at,updated_at)
    VALUES(?,NULL,?,?,?,?,?,?,?,?,'draft',?,?)`).run(planId,id,'Criar painel completo','Dashboard, estoque e vendas','Deploy externo',JSON.stringify(['index.html']),JSON.stringify([]),JSON.stringify([]),JSON.stringify(['Fluxo funcional']),now,now);
  WorkspaceManager.writeFile(id,'index.html','<html><body>AGENT_ENGINE_ORIGINAL</body></html>');
  SecretService.saveSecret(userA,'omniroute','test-omniroute-key-agent-plan-approval');
  db.prepare('UPDATE providers SET is_active=0 WHERE user_id=?').run(userA);
  db.prepare("UPDATE providers SET is_active=1,is_configured=1,connection_status='connected',model_id='auto' WHERE user_id=? AND provider_key='omniroute'").run(userA);
  db.prepare("UPDATE model_profiles SET enabled=1 WHERE user_id=? AND profile_key='BASE_FREE'").run(userA);
  db.prepare(`UPDATE model_candidates SET enabled=1,health_state='healthy',consecutive_failures=0,circuit_open_until=NULL
    WHERE profile_id=(SELECT id FROM model_profiles WHERE user_id=? AND profile_key='BASE_FREE') AND provider_key='omniroute'`).run(userA);
  const previousFlag=process.env.AGENT_ENGINE_ENABLED;process.env.AGENT_ENGINE_ENABLED='true';
  const originalReliable=(LLMAdapterService as any).buildApprovedPlanReliably;
  const originalExecutePrompt=(LLMAdapterService as any).executePrompt;
  (LLMAdapterService as any).executePrompt=async(options:any)=>({
    replyText:options.mode==='review'?'{"verdict":"pass","summary":"revisado","issues":[]}':'ok',
    mode:options.mode,decisionType:options.mode==='review'?'review':'change',isDemonstrativeFallback:false,
    providerUsed:'OmniRoute (Free Pool)',modelUsed:'auto',hasErrors:false,usage:{inputTokens:3,outputTokens:4,billedCostUsd:0}
  } as any);
  let reliableCalls=0;
  (LLMAdapterService as any).buildApprovedPlanReliably=async(options:any)=>{
    reliableCalls++;assert.equal(options.providerKey,'omniroute');assert.equal(options.objective,'Criar painel completo');assert.deepEqual(options.requestedFiles,['index.html']);
    return {replyText:'Implementação atômica gerada.',mode:'build',decisionType:'change',isDemonstrativeFallback:false,providerUsed:'OmniRoute (Free Pool)',modelUsed:'auto',hasErrors:false,
      build:{summary:'Painel completo',explanation:'Construção atômica',files:[{path:'index.html',action:'modify',content:'<html><body>AGENT_ENGINE_PROPOSAL</body></html>'}]},
      usage:{inputTokens:10,outputTokens:20,billedCostUsd:0},diagnostics:{strategy:'atomic_file_build',attempts:1,targets:['index.html'],failures:[]}} as any;
  };
  try{
    const response=await fetch(`${base}/conversations/${id}/plan/approve`,{method:'POST',headers:{Authorization:`Bearer ${tokenA}`,'Content-Type':'application/json'},body:JSON.stringify({planId})});
    assert.equal(response.status,202);
    const accepted=await response.json();assert.equal(accepted.accepted,true);assert.ok(accepted.runId);
    const run=await waitForRunTerminal(accepted.runId,15000);
    assert.equal(run.status,'completed');
    assert.equal(reliableCalls,1);
    assert.match(WorkspaceManager.readFile(id,'index.html')||'',/AGENT_ENGINE_PROPOSAL/);
    const message=db.prepare("SELECT content,metadata_json FROM messages WHERE conversation_id=? AND sender='agent' ORDER BY created_at DESC LIMIT 1").get(conversation) as any;
    const metadata=JSON.parse(message.metadata_json);
    assert.equal(metadata.executionType,'agent_engine');
    assert.equal(metadata.proposal.status,'applied');
    assert.equal(metadata.workflow.status,'completed');
    assert.equal((db.prepare('SELECT status FROM plans WHERE id=?').get(planId) as any).status,'approved');
  }finally{
    (LLMAdapterService as any).buildApprovedPlanReliably=originalReliable;
    (LLMAdapterService as any).executePrompt=originalExecutePrompt;
    if(previousFlag===undefined)delete process.env.AGENT_ENGINE_ENABLED;else process.env.AGENT_ENGINE_ENABLED=previousFlag;
  }
});

test('plan approval retries atomic generation and applies only after validation',async()=>{
  const previousFlag=process.env.AGENT_ENGINE_ENABLED;delete process.env.AGENT_ENGINE_ENABLED;
  const now=new Date(Date.now()+7000).toISOString();
  const conversation=`plan-repair-conversation-${Date.now()}`;const planId=`plan-repair-${Date.now()}`;
  db.prepare('INSERT INTO conversations(id,project_id,title,mode,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(conversation,id,'Plan format repair','plan',now,now);
  db.prepare(`INSERT INTO plans(id,task_id,project_id,objective,scope_in,scope_out,files_affected_json,integrations_json,risks_json,acceptance_criteria_json,status,created_at,updated_at)
    VALUES(?,NULL,?,?,?,?,?,?,?,?,'draft',?,?)`).run(planId,id,'Criar gestão da loja','Dashboard e fluxo de caixa','Deploy externo',JSON.stringify(['index.html']),JSON.stringify([]),JSON.stringify([]),JSON.stringify(['Dashboard funcional']),now,now);
  WorkspaceManager.writeFile(id,'index.html','<html><body>ORIGINAL_REPAIR</body></html>');
  SecretService.saveSecret(userA,'omniroute','test-omniroute-key-format-repair');
  db.prepare('UPDATE providers SET is_active=0 WHERE user_id=?').run(userA);
  db.prepare("UPDATE providers SET is_active=1,is_configured=1,connection_status='connected',model_id='auto' WHERE user_id=? AND provider_key='omniroute'").run(userA);
  const originalExecute=LLMAdapterService.executePrompt;let calls=0;
  LLMAdapterService.executePrompt=async()=>{calls++;if(calls===1)return {replyText:'formato inválido',mode:'build',decisionType:'invalid_response',isDemonstrativeFallback:false,providerUsed:'OmniRoute',modelUsed:'auto',hasErrors:true,invalidResponse:true,errorReason:'invalid'} as any;
    return {replyText:'ok',mode:'build',decisionType:'change',isDemonstrativeFallback:false,providerUsed:'OmniRoute',modelUsed:'auto',hasErrors:false,build:{summary:'Dashboard',explanation:'Resposta reparada',files:[{path:'index.html',action:'modify',content:'<html><body>REPAIRED_PROPOSAL</body></html>'}]}} as any;};
  try{
    const response=await fetch(`${base}/conversations/${id}/plan/approve`,{method:'POST',headers:{Authorization:`Bearer ${tokenA}`,'Content-Type':'application/json'},body:JSON.stringify({planId})});
    assert.equal(response.status,200);assert.equal(calls,2);
    const body=await response.json();assert.equal(body.proposal.status,'applied');
    assert.match(WorkspaceManager.readFile(id,'index.html')||'',/REPAIRED_PROPOSAL/);
    const message=db.prepare("SELECT metadata_json FROM messages WHERE conversation_id=? AND sender='agent' ORDER BY created_at DESC LIMIT 1").get(conversation) as any;
    const metadata=JSON.parse(message.metadata_json);
    assert.equal(metadata.buildDiagnostics.strategy,'atomic_file_build');assert.equal(metadata.buildDiagnostics.attempts,2);
  }finally{LLMAdapterService.executePrompt=originalExecute;if(previousFlag===undefined)delete process.env.AGENT_ENGINE_ENABLED;else process.env.AGENT_ENGINE_ENABLED=previousFlag;}
});
test('framework runtime starts, proxies preview, filters Forge secrets and stops cleanly', async () => {
  const runtimeProject = `runtime-project-${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects(id,user_id,workspace_id,name,origin,created_at,updated_at) VALUES(?,?,?,'Runtime','novo',?,?)")
    .run(runtimeProject,userA,`ws-${userA}`,now,now);
  WorkspaceManager.writeFile(runtimeProject,'package.json',JSON.stringify({scripts:{dev:'node server.js'}}));
  WorkspaceManager.writeFile(runtimeProject,'server.js',`
    const http = require('http');
    const body = JSON.stringify({
      ok: true,
      port: process.env.PORT,
      leaked: Boolean(process.env.SUPABASE_SECRET_KEY || process.env.SECRETS_MASTER_KEY || process.env.GITHUB_TOKEN)
    });
    http.createServer((req,res)=>{
      res.setHeader('content-type','application/json');
      res.end(body);
    }).listen(Number(process.env.PORT), '127.0.0.1');
  `);
  const previousSecret = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_SECRET_KEY = 'must-not-leak-to-runtime';
  try {
    const status = await fetch(`${base}/projects/${runtimeProject}/preview/status`,{headers:{Authorization:`Bearer ${tokenA}`}});
    assert.equal(status.status,200);
    const body = await status.json();
    assert.equal(body.status,'running');
    assert.equal(body.runtime.framework,'node');
    assert.ok(body.runtime.port > 0);
    const preview = await fetch(`${base}/preview/${runtimeProject}/`,{headers:{Authorization:`Bearer ${tokenA}`}});
    assert.equal(preview.status,200);
    const payload = await preview.json();
    assert.equal(payload.ok,true);
    assert.equal(payload.leaked,false);
    const stopped = await fetch(`${base}/projects/${runtimeProject}/runtime/stop`,{method:'POST',headers:{Authorization:`Bearer ${tokenA}`}});
    assert.equal(stopped.status,200);
    assert.equal((await stopped.json()).status,'stopped');
  } finally {
    if (previousSecret === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = previousSecret;
    await RuntimeManager.stop(runtimeProject);
    WorkspaceManager.deleteProject(runtimeProject);
    db.prepare('DELETE FROM projects WHERE id=?').run(runtimeProject);
  }
});


test('failed framework start returns error status and leaves no running runtime', async () => {
  const runtimeProject = `runtime-fail-${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects(id,user_id,workspace_id,name,origin,created_at,updated_at) VALUES(?,?,?,'Runtime fail','novo',?,?)")
    .run(runtimeProject,userA,`ws-${userA}`,now,now);
  WorkspaceManager.writeFile(runtimeProject,'package.json',JSON.stringify({scripts:{}}));
  try {
    const status = await fetch(`${base}/projects/${runtimeProject}/preview/status`,{headers:{Authorization:`Bearer ${tokenA}`}});
    assert.equal(status.status,422);
    const body = await status.json();
    assert.equal(body.status,'error');
    assert.match(body.message,/script dev\/start|Nenhum script/i);
    const runtime = RuntimeManager.get(runtimeProject);
    assert.equal(runtime?.status,'error');
  } finally {
    await RuntimeManager.stop(runtimeProject);
    WorkspaceManager.deleteProject(runtimeProject);
    db.prepare('DELETE FROM projects WHERE id=?').run(runtimeProject);
  }
});


test('Cloudflare Direct Upload refuses missing build artifact without false success', async () => {
  const projectId = `direct-upload-${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects(id,user_id,workspace_id,name,origin,created_at,updated_at) VALUES(?,?,?,'Direct upload','novo',?,?)")
    .run(projectId,userA,`ws-${userA}`,now,now);
  db.prepare("INSERT INTO integrations(id,user_id,service_name,config_json,status,last_verified_at,created_at) VALUES(?,?,?,'{}','connected',?,?)")
    .run(`int-${projectId}`,userA,'cloudflare',now,now);
  WorkspaceManager.writeFile(projectId,'index.html','<html><body>source only</body></html>');
  try {
    const response=await fetch(`${base}/projects/${projectId}/deploy/cloudflare/direct`,{method:'POST',headers:{Authorization:`Bearer ${tokenA}`}});
    assert.equal(response.status,400);
    const body=await response.json();
    assert.equal(body.success,false);
    assert.match(body.error,/artefato de build|Configure token/i);
    const row=db.prepare("SELECT status,target FROM deployments WHERE project_id=? ORDER BY created_at DESC LIMIT 1").get(projectId) as any;
    assert.equal(row.status,'failed');
    assert.equal(row.target,'cloudflare_pages_direct_upload');
  } finally {
    WorkspaceManager.deleteProject(projectId);
    db.prepare('DELETE FROM deployments WHERE project_id=?').run(projectId);
    db.prepare('DELETE FROM integrations WHERE user_id=? AND service_name=?').run(userA,'cloudflare');
    db.prepare('DELETE FROM projects WHERE id=?').run(projectId);
  }
});

test('runtime proxy preserves method body query and strips Forge credentials', async () => {
  const runtimeProject = `runtime-proxy-${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects(id,user_id,workspace_id,name,origin,created_at,updated_at) VALUES(?,?,?,'Runtime proxy','novo',?,?)")
    .run(runtimeProject,userA,`ws-${userA}`,now,now);
  WorkspaceManager.writeFile(runtimeProject,'package.json',JSON.stringify({scripts:{dev:'node server.js'}}));
  WorkspaceManager.writeFile(runtimeProject,'server.js',`
    const http = require('http');
    http.createServer((req,res)=>{
      let body='';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify({method:req.method,url:req.url,body,authorization:req.headers.authorization||null,cookie:req.headers.cookie||null,custom:req.headers['x-custom']||null}));
      });
    }).listen(Number(process.env.PORT), '127.0.0.1');
  `);
  try {
    const status = await fetch(`${base}/projects/${runtimeProject}/preview/status`,{headers:{Authorization:`Bearer ${tokenA}`}});
    assert.equal(status.status,200);
    const preview = await fetch(`${base}/preview/${runtimeProject}/api/save?x=1`,{method:'POST',headers:{Authorization:`Bearer ${tokenA}`,'Content-Type':'text/plain','X-Custom':'kept'},body:'payload'});
    assert.equal(preview.status,200);
    const payload = await preview.json();
    assert.equal(payload.method,'POST');
    assert.equal(payload.url,'/api/save?x=1');
    assert.equal(payload.body,'payload');
    assert.equal(payload.authorization,null);
    assert.equal(payload.cookie,null);
    assert.equal(payload.custom,'kept');
  } finally {
    await RuntimeManager.stop(runtimeProject);
    WorkspaceManager.deleteProject(runtimeProject);
    db.prepare('DELETE FROM projects WHERE id=?').run(runtimeProject);
  }
});

test('runtime dependency install does not execute lifecycle scripts from imported projects', async () => {
  const runtimeProject = `runtime-install-safe-${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects(id,user_id,workspace_id,name,origin,created_at,updated_at) VALUES(?,?,?,'Runtime install safe','novo',?,?)")
    .run(runtimeProject,userA,`ws-${userA}`,now,now);
  WorkspaceManager.writeFile(runtimeProject,'package.json',JSON.stringify({scripts:{postinstall:'node postinstall.js',dev:'node server.js'}}));
  WorkspaceManager.writeFile(runtimeProject,'postinstall.js','require("fs").writeFileSync("lifecycle-ran.txt","bad")');
  WorkspaceManager.writeFile(runtimeProject,'server.js','require("http").createServer((req,res)=>res.end("ok")).listen(Number(process.env.PORT), "127.0.0.1")');
  try {
    const status = await fetch(`${base}/projects/${runtimeProject}/preview/status`,{headers:{Authorization:`Bearer ${tokenA}`}});
    assert.equal(status.status,200);
    assert.equal(WorkspaceManager.readFile(runtimeProject,'lifecycle-ran.txt'),null);
  } finally {
    await RuntimeManager.stop(runtimeProject);
    WorkspaceManager.deleteProject(runtimeProject);
    db.prepare('DELETE FROM projects WHERE id=?').run(runtimeProject);
  }
});


test('Cloudflare Direct Upload runs build and persists failed when build fails', async () => {
  const projectId = `direct-upload-build-fail-${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects(id,user_id,workspace_id,name,origin,created_at,updated_at) VALUES(?,?,?,'Direct upload build fail','novo',?,?)")
    .run(projectId,userA,`ws-${userA}`,now,now);
  db.prepare("INSERT INTO integrations(id,user_id,service_name,config_json,status,last_verified_at,created_at) VALUES(?,?,?,'{}','connected',?,?)")
    .run(`int-${projectId}`,userA,'cloudflare',now,now);
  SecretService.saveSecret(userA, 'integration:cloudflare', JSON.stringify({token:'cf-token-secret', accountId:'account123', projectName:'forge-pages'}));
  WorkspaceManager.writeFile(projectId,'package.json',JSON.stringify({scripts:{build:'node -e "process.exit(2)"'}}));
  try {
    const response=await fetch(`${base}/projects/${projectId}/deploy/cloudflare/direct`,{method:'POST',headers:{Authorization:`Bearer ${tokenA}`}});
    assert.equal(response.status,400);
    const body=await response.json();
    assert.match(body.error,/Build do projeto falhou/i);
    const row=db.prepare("SELECT status,error_message FROM deployments WHERE project_id=? ORDER BY created_at DESC LIMIT 1").get(projectId) as any;
    assert.equal(row.status,'failed');
    assert.doesNotMatch(row.error_message,/cf-token-secret/);
  } finally {
    WorkspaceManager.deleteProject(projectId);
    db.prepare('DELETE FROM deployments WHERE project_id=?').run(projectId);
    db.prepare('DELETE FROM integrations WHERE user_id=? AND service_name=?').run(userA,'cloudflare');
    db.prepare('DELETE FROM user_secrets WHERE user_id=? AND service_key=?').run(userA,'integration:cloudflare');
    db.prepare('DELETE FROM projects WHERE id=?').run(projectId);
  }
});

test('Cloudflare Direct Upload does not treat public source folder as build artifact', async () => {
  const projectId = `direct-upload-public-${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects(id,user_id,workspace_id,name,origin,created_at,updated_at) VALUES(?,?,?,'Direct upload public','novo',?,?)")
    .run(projectId,userA,`ws-${userA}`,now,now);
  db.prepare("INSERT INTO integrations(id,user_id,service_name,config_json,status,last_verified_at,created_at) VALUES(?,?,?,'{}','connected',?,?)")
    .run(`int-${projectId}`,userA,'cloudflare',now,now);
  SecretService.saveSecret(userA, 'integration:cloudflare', JSON.stringify({token:'cf-token-secret', accountId:'account123', projectName:'forge-pages'}));
  WorkspaceManager.writeFile(projectId,'package.json',JSON.stringify({scripts:{build:'node build.js'}}));
  WorkspaceManager.writeFile(projectId,'build.js','const fs=require("fs");fs.mkdirSync("public",{recursive:true});fs.writeFileSync("public/index.html","<html></html>");');
  try {
    const response=await fetch(`${base}/projects/${projectId}/deploy/cloudflare/direct`,{method:'POST',headers:{Authorization:`Bearer ${tokenA}`}});
    assert.equal(response.status,400);
    const body=await response.json();
    assert.match(body.error,/public\/ não é aceito como build|Nenhum artefato compatível/i);
  } finally {
    WorkspaceManager.deleteProject(projectId);
    db.prepare('DELETE FROM deployments WHERE project_id=?').run(projectId);
    db.prepare('DELETE FROM integrations WHERE user_id=? AND service_name=?').run(userA,'cloudflare');
    db.prepare('DELETE FROM user_secrets WHERE user_id=? AND service_key=?').run(userA,'integration:cloudflare');
    db.prepare('DELETE FROM projects WHERE id=?').run(projectId);
  }
});

function insertLifecycleProposal(projectId:string, runId:string, files:any[], shipRequested=false) {
  const now = new Date().toISOString();
  const conversationId = `lifecycle-conv-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const proposalId = `lifecycle-prop-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  db.prepare('INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(conversationId,projectId,'Lifecycle',now,now);
  const metadata = {runId, workflow:{runId,status:'waiting_approval',shipRequested}, originalRequest:'lifecycle test', proposal:{id:proposalId,status:'pending',summary:'Lifecycle proposal',files}};
  db.prepare("INSERT INTO messages(id,conversation_id,sender,content,metadata_json,created_at) VALUES(?,?,'agent','proposal',?,?)").run(`lifecycle-msg-${Date.now()}-${Math.random().toString(16).slice(2)}`,conversationId,JSON.stringify(metadata),now);
  return {conversationId,proposalId};
}

function createLifecycleProject(label:string) {
  const projectId = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects(id,user_id,workspace_id,name,origin,created_at,updated_at) VALUES(?,?,?,?,'novo',?,?)")
    .run(projectId,userA,`ws-${userA}`,label,now,now);
  return projectId;
}

function configureLifecycleProfile(userId:string, profile:'BASE_FREE'|'EXPERT_PAID', providerKey:string, modelId:string, maxCost=0.01) {
  const now = new Date().toISOString();
  db.prepare("UPDATE providers SET is_configured=1, connection_status='connected', model_id=? WHERE user_id=? AND provider_key=?").run(modelId,userId,providerKey);
  SecretService.saveSecret(userId, providerKey, `${providerKey}-secret`);
  const profileId = `profile-${userId}-${profile}`;
  db.prepare('INSERT OR REPLACE INTO model_profiles(id,user_id,profile_key,level,max_attempts,max_cost_usd,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(profileId,userId,profile,profile==='BASE_FREE'?0:1,1,maxCost,1,now,now);
  db.prepare('DELETE FROM model_candidates WHERE profile_id=?').run(profileId);
  db.prepare('INSERT INTO model_candidates(id,profile_id,provider_key,model_id,priority,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(`candidate-${userId}-${profile}-${Date.now()}`,profileId,providerKey,modelId,0,1,now,now);
}


test('direct LLM build validates and applies the sandbox result automatically',async(t)=>{
  delete process.env.AGENT_ENGINE_ENABLED;
  configureLifecycleProfile(userA,'BASE_FREE','omniroute','auto');
  db.prepare("UPDATE providers SET is_active=1,is_configured=1,connection_status='connected' WHERE user_id=? AND provider_key='omniroute'").run(userA);
  t.mock.method(LLMAdapterService,'executePrompt',async()=>({replyText:'resultado pronto',mode:'build',decisionType:'change',isDemonstrativeFallback:false,providerUsed:'OmniRoute',modelUsed:'auto',hasErrors:false,
    build:{summary:'change',explanation:'change',files:[{path:'index.html',action:'modify',content:'<html><body>NEW</body></html>'}]},usage:{inputTokens:1,outputTokens:1,billedCostUsd:0}} as any));
  const projectId=createLifecycleProject('direct-auto-apply');WorkspaceManager.writeFile(projectId,'index.html','<html><body>ORIGINAL</body></html>');
  try{
    const r=await fetch(`${base}/conversations/${projectId}/messages`,{method:'POST',headers:{Authorization:`Bearer ${tokenA}`,'Content-Type':'application/json'},body:JSON.stringify({content:'altere a página',mode:'build'})});
    assert.equal(r.status,200);const body=await r.json();
    assert.equal(body.proposal?.status,'applied');assert.ok(body.proposal?.sandboxId);
    assert.equal(WorkspaceManager.readFile(projectId,'index.html'),'<html><body>NEW</body></html>');
    assert.equal(body.agentMessage.metadata.autoApplied,true);
  }finally{WorkspaceManager.deleteProject(projectId);db.prepare('DELETE FROM projects WHERE id=?').run(projectId);}
});

test('agent automatic lifecycle returns 202 then completes review and apply without user approval',async(t)=>{
  process.env.AGENT_ENGINE_ENABLED='true';configureLifecycleProfile(userA,'BASE_FREE','omniroute','auto');
  t.mock.method(LLMAdapterService,'executePrompt',async(options:any)=>{
    if(options.mode==='review')return {replyText:'{"verdict":"pass","summary":"revisado","issues":[]}',mode:'review',decisionType:'review',isDemonstrativeFallback:false,providerUsed:'OmniRoute',modelUsed:'auto',hasErrors:false,usage:{inputTokens:1,outputTokens:1,billedCostUsd:0}} as any;
    return {replyText:'implementado',mode:'build',decisionType:'change',isDemonstrativeFallback:false,providerUsed:'OmniRoute',modelUsed:'auto',
      proposal:{id:'prop-auto',summary:'auto',requiresConfirmation:false,files:[{path:'index.html',action:'modify',content:'<html><body>Built</body></html>'}],status:'pending'},
      build:{summary:'auto',explanation:'auto',files:[{path:'index.html',action:'modify',content:'<html><body>Built</body></html>'}]},usage:{inputTokens:1,outputTokens:1,billedCostUsd:0}} as any;
  });
  const projectId=createLifecycleProject('auto-lifecycle');WorkspaceManager.writeFile(projectId,'index.html','<html><body>Before</body></html>');
  try{
    const r=await fetch(`${base}/conversations/${projectId}/messages`,{method:'POST',headers:{Authorization:`Bearer ${tokenA}`,'Content-Type':'application/json'},body:JSON.stringify({content:'crie uma tela visual',mode:'auto'})});
    assert.equal(r.status,202);const accepted=await r.json();assert.equal(accepted.accepted,true);assert.ok(accepted.runId);
    const run=await waitForRunTerminal(accepted.runId,15000);assert.equal(run.status,'completed');
    assert.match(WorkspaceManager.readFile(projectId,'index.html')||'',/Built/);
    const conversation=db.prepare('SELECT id FROM conversations WHERE project_id=? ORDER BY created_at DESC LIMIT 1').get(projectId) as any;
    const message=db.prepare("SELECT content,metadata_json FROM messages WHERE conversation_id=? AND sender='agent' ORDER BY created_at DESC LIMIT 1").get(conversation.id) as any;
    const metadata=JSON.parse(message.metadata_json);assert.equal(metadata.proposal.status,'applied');assert.equal(metadata.autoApplied,true);assert.equal(metadata.workflow.status,'completed');
  }finally{delete process.env.AGENT_ENGINE_ENABLED;WorkspaceManager.deleteProject(projectId);db.prepare('DELETE FROM projects WHERE id=?').run(projectId);}
});
test('rejecting proposal closes run as rejected without validation or repair invocation', async () => {
  const projectId=createLifecycleProject('reject-proposal');
  const {runId}=RunService.start(userA,projectId,`conv-placeholder-${Date.now()}`,'auto',0.5);RunService.waitForApproval(runId);
  const {proposalId}=insertLifecycleProposal(projectId,runId,[{path:'index.html',action:'modify',content:'<html></html>'}]);
  const beforeInv=(db.prepare('SELECT COUNT(*) c FROM model_invocations WHERE run_id=?').get(runId) as any).c;
  try {
    const r=await fetch(`${base}/conversations/${projectId}/reject-proposal`,{method:'POST',headers:{Authorization:`Bearer ${tokenA}`,'Content-Type':'application/json'},body:JSON.stringify({proposalId})});
    assert.equal(r.status,200);
    const run=db.prepare('SELECT status,finished_at FROM agent_runs WHERE id=?').get(runId) as any;
    assert.equal(run.status,'rejected');
    assert.ok(run.finished_at);
    assert.equal((db.prepare('SELECT COUNT(*) c FROM model_invocations WHERE run_id=?').get(runId) as any).c,beforeInv);
    assert.equal((db.prepare('SELECT COUNT(*) c FROM verifications WHERE project_id=?').get(projectId) as any).c,0);
  } finally { WorkspaceManager.deleteProject(projectId); db.prepare('DELETE FROM projects WHERE id=?').run(projectId); }
});

test('approving proposal with passing validator completes waiting run without repair', async () => {
  const projectId=createLifecycleProject('approval-pass');
  const {runId}=RunService.start(userA,projectId,`conv-placeholder-${Date.now()}`,'auto',0.5);RunService.waitForApproval(runId);
  const {proposalId}=insertLifecycleProposal(projectId,runId,[{path:'index.html',action:'modify',content:'<html></html>'},{path:'package.json',action:'modify',content:JSON.stringify({scripts:{build:'node -e "process.exit(0)"'}})}]);
  try {
    const r=await fetch(`${base}/conversations/${projectId}/apply-proposal`,{method:'POST',headers:{Authorization:`Bearer ${tokenA}`,'Content-Type':'application/json'},body:JSON.stringify({proposalId,summary:'pass'})});
    assert.equal(r.status,200);
    const run=db.prepare('SELECT status,finished_at FROM agent_runs WHERE id=?').get(runId) as any;
    assert.equal(run.status,'completed');
    assert.ok(run.finished_at);
    assert.equal((db.prepare("SELECT COUNT(*) c FROM agent_steps WHERE run_id=? AND title LIKE 'Corrigir falha%'").get(runId) as any).c,0);
  } finally { WorkspaceManager.deleteProject(projectId); db.prepare('DELETE FROM projects WHERE id=?').run(projectId); }
});

test('approved publish proposal creates SHIP only after validation passes', async () => {
  const projectId=createLifecycleProject('approval-ship');
  const {runId}=RunService.start(userA,projectId,`conv-placeholder-${Date.now()}`,'publish',0.5);RunService.waitForApproval(runId);
  const {proposalId}=insertLifecycleProposal(projectId,runId,[{path:'index.html',action:'modify',content:'<html></html>'},{path:'package.json',action:'modify',content:JSON.stringify({scripts:{build:'node -e "process.exit(0)"'}})}],true);
  try {
    assert.equal((db.prepare("SELECT COUNT(*) c FROM agent_steps WHERE run_id=? AND agent_key='SHIP'").get(runId) as any).c,0);
    const r=await fetch(`${base}/conversations/${projectId}/apply-proposal`,{method:'POST',headers:{Authorization:`Bearer ${tokenA}`,'Content-Type':'application/json'},body:JSON.stringify({proposalId,summary:'publish pass'})});
    assert.equal(r.status,200);
    const ship=db.prepare("SELECT status,order_index FROM agent_steps WHERE run_id=? AND agent_key='SHIP'").get(runId) as any;
    assert.equal(ship.status,'completed');
    assert.equal((db.prepare('SELECT status FROM agent_runs WHERE id=?').get(runId) as any).status,'completed');
  } finally { WorkspaceManager.deleteProject(projectId); db.prepare('DELETE FROM projects WHERE id=?').run(projectId); }
});

test('validator fail triggers one bounded FORGE repair and completes when revalidation passes', async (t) => {
  configureLifecycleProfile(userA,'BASE_FREE','omniroute','auto');
  t.mock.method(LLMAdapterService,'executePrompt',async()=>({replyText:'repair',mode:'build',decisionType:'change',isDemonstrativeFallback:false,providerUsed:'OmniRoute',modelUsed:'auto',build:{summary:'repair',explanation:'repair',files:[{path:'package.json',action:'modify',content:JSON.stringify({scripts:{build:'node -e "process.exit(0)"'}})},{path:'index.html',action:'modify',content:'<html><body>fixed</body></html>'}]},proposal:{id:'repair-prop',summary:'repair',requiresConfirmation:false,files:[{path:'package.json',action:'modify',content:JSON.stringify({scripts:{build:'node -e "process.exit(0)"'}})},{path:'index.html',action:'modify',content:'<html><body>fixed</body></html>'}],status:'pending'},usage:{inputTokens:1,outputTokens:1,billedCostUsd:0.001}} as any));
  const projectId=createLifecycleProject('repair-pass');
  const {runId}=RunService.start(userA,projectId,`conv-placeholder-${Date.now()}`,'auto',0.5);RunService.waitForApproval(runId);
  const {proposalId}=insertLifecycleProposal(projectId,runId,[{path:'index.html',action:'modify',content:'<html><body>broken</body></html>'},{path:'package.json',action:'modify',content:JSON.stringify({scripts:{build:'node -e "process.exit(1)"'}})}]);
  try {
    const r=await fetch(`${base}/conversations/${projectId}/apply-proposal`,{method:'POST',headers:{Authorization:`Bearer ${tokenA}`,'Content-Type':'application/json'},body:JSON.stringify({proposalId,summary:'repair pass'})});
    assert.equal(r.status,200);
    const body=await r.json();
    assert.equal(body.repair.status,'passed');
    assert.equal((db.prepare('SELECT status FROM agent_runs WHERE id=?').get(runId) as any).status,'completed');
    assert.equal((db.prepare("SELECT COUNT(*) c FROM agent_steps WHERE run_id=? AND title='Corrigir falha de validação'").get(runId) as any).c,1);
    const inv=db.prepare('SELECT agent_key,profile_key FROM model_invocations WHERE run_id=?').all(runId) as any[];
    assert.equal(inv[0].agent_key,'FORGE');
    assert.equal(inv[0].profile_key,'BASE_FREE');
  } finally { WorkspaceManager.deleteProject(projectId); db.prepare('DELETE FROM projects WHERE id=?').run(projectId); }
});

test('validator fail plus repair fail rolls back and does not attempt third repair', async (t) => {
  configureLifecycleProfile(userA,'BASE_FREE','omniroute','auto');
  t.mock.method(LLMAdapterService,'executePrompt',async()=>({replyText:'bad repair',mode:'build',decisionType:'change',isDemonstrativeFallback:false,providerUsed:'OmniRoute',modelUsed:'auto',build:{summary:'bad',explanation:'bad',files:[{path:'package.json',action:'modify',content:JSON.stringify({scripts:{build:'node -e "process.exit(1)"'}})}]},proposal:{id:'repair-bad',summary:'bad',requiresConfirmation:false,files:[{path:'package.json',action:'modify',content:JSON.stringify({scripts:{build:'node -e "process.exit(1)"'}})}],status:'pending'},usage:{inputTokens:1,outputTokens:1,billedCostUsd:0.001}} as any));
  const projectId=createLifecycleProject('repair-fail');
  WorkspaceManager.writeFile(projectId,'index.html','<html><body>original</body></html>');
  const {runId}=RunService.start(userA,projectId,`conv-placeholder-${Date.now()}`,'auto',0.5);RunService.waitForApproval(runId);
  const {proposalId}=insertLifecycleProposal(projectId,runId,[{path:'package.json',action:'modify',content:JSON.stringify({scripts:{build:'node -e "process.exit(1)"'}})}]);
  try {
    const r=await fetch(`${base}/conversations/${projectId}/apply-proposal`,{method:'POST',headers:{Authorization:`Bearer ${tokenA}`,'Content-Type':'application/json'},body:JSON.stringify({proposalId,summary:'repair fail'})});
    assert.equal(r.status,422);
    assert.equal((db.prepare('SELECT status FROM agent_runs WHERE id=?').get(runId) as any).status,'failed');
    assert.equal((db.prepare("SELECT COUNT(*) c FROM agent_steps WHERE run_id=? AND title='Corrigir falha de validação'").get(runId) as any).c,1);
    assert.equal((db.prepare("SELECT COUNT(*) c FROM tool_executions WHERE run_id=? AND tool_key='build'").get(runId) as any).c,2);
  } finally { WorkspaceManager.deleteProject(projectId); db.prepare('DELETE FROM projects WHERE id=?').run(projectId); }
});

test('repair escalates only the blocked step to EXPERT and later model step starts BASE_FREE', async (t) => {
  db.prepare("UPDATE model_profiles SET enabled=0 WHERE user_id=? AND profile_key='BASE_FREE'").run(userA);
  configureLifecycleProfile(userA,'EXPERT_PAID','cheaper_inference','expert-model',0.01);
  t.mock.method(LLMAdapterService,'executePrompt',async()=>({replyText:'expert repair',mode:'build',decisionType:'change',isDemonstrativeFallback:false,providerUsed:'Cheaper',modelUsed:'expert-model',build:{summary:'repair',explanation:'repair',files:[{path:'package.json',action:'modify',content:JSON.stringify({scripts:{build:'node -e "process.exit(0)"'}})}]},proposal:{id:'repair-expert',summary:'repair',requiresConfirmation:false,files:[{path:'package.json',action:'modify',content:JSON.stringify({scripts:{build:'node -e "process.exit(0)"'}})}],status:'pending'},usage:{inputTokens:1,outputTokens:1,billedCostUsd:0.001}} as any));
  const projectId=createLifecycleProject('repair-expert');
  const {runId}=RunService.start(userA,projectId,`conv-placeholder-${Date.now()}`,'auto',0.5);RunService.waitForApproval(runId);
  const {proposalId}=insertLifecycleProposal(projectId,runId,[{path:'package.json',action:'modify',content:JSON.stringify({scripts:{build:'node -e "process.exit(1)"'}})}]);
  try {
    const r=await fetch(`${base}/conversations/${projectId}/apply-proposal`,{method:'POST',headers:{Authorization:`Bearer ${tokenA}`,'Content-Type':'application/json'},body:JSON.stringify({proposalId,summary:'expert repair'})});
    assert.equal(r.status,200);
    const inv=db.prepare('SELECT profile_key FROM model_invocations WHERE run_id=?').all(runId) as any[];
    assert.ok(inv.some(i=>i.profile_key==='EXPERT_PAID'));
    const next=RunService.createStep(runId,'SHIP','Depois do repair',RunService.nextOrderIndex(runId),'task',{});
    db.prepare("UPDATE model_profiles SET enabled=1 WHERE user_id=? AND profile_key='BASE_FREE'").run(userA);
    configureLifecycleProfile(userA,'BASE_FREE','omniroute','auto');
    await AgentEngine.execute({prompt:'ship',mode:'publish',projectId,existingFiles:{},appliedSkills:[],conversationHistory:[],userId:userA,runId,stepId:next},{profile:'BASE_FREE',forcedAgentKey:'SHIP'});
    const last=db.prepare('SELECT profile_key FROM model_invocations WHERE run_id=? ORDER BY created_at DESC LIMIT 1').get(runId) as any;
    assert.equal(last.profile_key,'BASE_FREE');
  } finally { db.prepare("UPDATE model_profiles SET enabled=1 WHERE user_id=? AND profile_key='BASE_FREE'").run(userA); WorkspaceManager.deleteProject(projectId); db.prepare('DELETE FROM projects WHERE id=?').run(projectId); }
});

test('budget blocks EXPERT repair before provider call and PREMIUM is not automatic', async (t) => {
  let calls=0;
  db.prepare("UPDATE model_profiles SET enabled=0 WHERE user_id=? AND profile_key='BASE_FREE'").run(userA);
  configureLifecycleProfile(userA,'EXPERT_PAID','cheaper_inference','expert-model',1);
  t.mock.method(LLMAdapterService,'executePrompt',async()=>{calls++;return {} as any;});
  const projectId=createLifecycleProject('repair-budget');
  const {runId}=RunService.start(userA,projectId,`conv-placeholder-${Date.now()}`,'auto',0.01);RunService.waitForApproval(runId);
  const {proposalId}=insertLifecycleProposal(projectId,runId,[{path:'package.json',action:'modify',content:JSON.stringify({scripts:{build:'node -e "process.exit(1)"'}})}]);
  try {
    const r=await fetch(`${base}/conversations/${projectId}/apply-proposal`,{method:'POST',headers:{Authorization:`Bearer ${tokenA}`,'Content-Type':'application/json'},body:JSON.stringify({proposalId,summary:'budget'})});
    assert.equal(r.status,422);
    assert.equal(calls,0);
    const profiles=(db.prepare('SELECT DISTINCT profile_key FROM model_invocations WHERE run_id=?').all(runId) as any[]).map(x=>x.profile_key);
    assert.equal(profiles.includes('PREMIUM_OVERRIDE'),false);
  } finally { db.prepare("UPDATE model_profiles SET enabled=1 WHERE user_id=? AND profile_key='BASE_FREE'").run(userA); WorkspaceManager.deleteProject(projectId); db.prepare('DELETE FROM projects WHERE id=?').run(projectId); }
});

