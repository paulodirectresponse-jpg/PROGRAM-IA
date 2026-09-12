import fs from 'node:fs';
import {initializeDatabase,db} from '../../server/db/index.js';
import {AuthService} from '../../server/services/authService.js';
import {SecretService} from '../../server/services/secretService.js';
import {CloudSyncService} from '../../server/services/cloudSyncService.js';

const [mode,snapshotPath]=process.argv.slice(2);
initializeDatabase();
const uid='firebase-two-runtime-identity',email='two-runtime@example.test',now=new Date().toISOString();
const {user}=AuthService.firebaseLogin(email,'Two Runtime',uid);

if(mode==='create'){
  const workspace=(db.prepare('SELECT id FROM workspaces WHERE user_id=? LIMIT 1').get(user.id) as any).id;
  db.prepare("INSERT INTO projects(id,user_id,workspace_id,name,origin,created_at,updated_at) VALUES('p-runtime',?,?, 'Persistência Teste','novo',?,?)").run(user.id,workspace,now,now);
  db.prepare("UPDATE providers SET is_active=CASE WHEN provider_key='cheaper_inference' THEN 1 ELSE 0 END WHERE user_id=?").run(user.id);
  SecretService.saveSecret(user.id,'cheaper_inference','secret-survives-runtime');
  db.prepare("INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES('c-runtime','p-runtime','Conversa restaurada',?,?)").run(now,now);
  fs.writeFileSync(snapshotPath,JSON.stringify(CloudSyncService.export(user.id)));
}else{
  const snapshot=JSON.parse(fs.readFileSync(snapshotPath,'utf8'));
  globalThis.fetch=async()=>new Response(JSON.stringify([{user_id:user.id,revision:3,device_id:'runtime-a',schema_version:1,payload:snapshot,updated_at:now}]),{status:200,headers:{'content-type':'application/json'}});
  const result=await CloudSyncService.bootstrap(user.id);
  const restored={status:result.status,projects:(db.prepare('SELECT COUNT(*) n FROM projects WHERE user_id=?').get(user.id) as any).n,active:(db.prepare("SELECT provider_key FROM providers WHERE user_id=? AND is_active=1").get(user.id) as any)?.provider_key||null,secret:SecretService.getDecryptedSecret(user.id,'cheaper_inference'),conversations:(db.prepare("SELECT COUNT(*) n FROM conversations WHERE project_id='p-runtime'").get() as any).n};
  process.stdout.write(JSON.stringify(restored));
}
db.close();

