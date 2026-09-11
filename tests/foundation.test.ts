import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {db, initializeDatabase} from '../server/db/index.js';
import {AuthService} from '../server/services/authService.js';
import {SecretService} from '../server/services/secretService.js';
import {IntegrationService} from '../server/services/integrationService.js';
import {verifyFirebaseIdentity} from '../server/services/firebaseIdentity.js';

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
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM providers WHERE user_id=?').get(id) as any).n,3);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM skills WHERE user_id=?').get(id) as any).n,12);
  }
});
test('Firebase identity stays bound to uid; email cannot take over an existing account',()=>{
  assert.throws(()=>AuthService.firebaseLogin(`a-${suffix}@example.test`,'Other','unrelated-uid'), /migração/);
  assert.equal(AuthService.firebaseLogin(`a-${suffix}@example.test`,'A',`fb-a-${suffix}`).user.id,a);
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
test('unknown credentials are not reported as connected just because they contain characters',async()=>{
  const result=await SecretService.testConnection(a,'unimplemented-service',{apiKey:'long-arbitrary-value'});
  assert.equal(result.success,false);
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
