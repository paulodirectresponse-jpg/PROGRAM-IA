import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import {router} from '../server/routes.js';
import {db,initializeDatabase} from '../server/db/index.js';
import {AuthService} from '../server/services/authService.js';
import type {Server} from 'node:http';

let server:Server, base:string, tokenA:string, tokenB:string, userA:string, userB:string;
const id=`http-project-${Date.now()}`;
before(async()=>{
  initializeDatabase();
  userA=AuthService.register(`${id}-a@example.test`,'A','test-password-123').id;
  userB=AuthService.register(`${id}-b@example.test`,'B','test-password-123').id;
  tokenA=AuthService.createSession(userA).token;
  tokenB=AuthService.createSession(userB).token;
  db.prepare("INSERT INTO projects(id,user_id,workspace_id,name,origin,created_at,updated_at) VALUES(?,?,?,'Private','novo',?,?)").run(id,userA,`ws-${userA}`,new Date().toISOString(),new Date().toISOString());
  const app=express();app.use(cookieParser());app.use(express.json());app.use('/api',router);
  await new Promise<void>(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});
  base=`http://127.0.0.1:${(server.address() as any).port}/api`;
});
after(async()=>{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));db.close();});
test('no anonymous access even when user-default exists',async()=>{
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
  const {providers}=await r.json();assert.equal(providers.length,3);assert.ok(providers.every((p:any)=>p.id.includes(userA)));
});
test('cookie mutations require a CSRF header',async()=>{
  const r=await fetch(`${base}/providers/update`,{method:'POST',headers:{Cookie:`forge_session=${tokenA}; forge_csrf=expected`,'Content-Type':'application/json'},body:JSON.stringify({providerKey:'useoneai',modelId:'test'})});
  assert.equal(r.status,403);
});
test('changing model configuration does not mutate another user',async()=>{
  const r=await fetch(`${base}/providers/update`,{method:'POST',headers:{Authorization:`Bearer ${tokenA}`,'Content-Type':'application/json'},body:JSON.stringify({providerKey:'useoneai',modelId:'my-model'})});
  assert.equal(r.status,200);
  assert.equal((db.prepare("SELECT model_id FROM providers WHERE user_id=? AND provider_key='useoneai'").get(userB) as any).model_id,'chatgpt-5.5');
});
