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
import type {Server} from 'node:http';

let server:Server, base:string, tokenA:string, tokenB:string, userA:string, userB:string;
const id=`http-project-${Date.now()}`;
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
