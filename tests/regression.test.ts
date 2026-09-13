import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { db } from '../server/db/index.js';
import { AuthService } from '../server/services/authService.js';
import { WorkspaceManager } from '../server/services/workspaceManager.js';

function createProject(label: string) {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const user = AuthService.firebaseLogin(`${suffix}@example.test`, label, `fb-${suffix}`).user;
  const workspace = db.prepare('SELECT id FROM workspaces WHERE user_id=? LIMIT 1').get(user.id) as {id:string};
  const id = `reg-${suffix}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects(id,user_id,workspace_id,name,origin,created_at,updated_at) VALUES(?,?,?,?,'novo',?,?)")
    .run(id,user.id,workspace.id,label,now,now);
  return id;
}

function cleanup(id:string) {
  WorkspaceManager.deleteProject(id);
  db.prepare('DELETE FROM projects WHERE id=?').run(id);
}

test('ZIP import strips a real archive wrapper and preserves binary bytes', async () => {
  const id=createProject('zip-wrapper');
  try {
    const zip=new JSZip();
    zip.file('my-project/src/App.tsx','export const App=()=>null;');
    zip.file('my-project/public/logo.png',Buffer.from([0,1,2,255]));
    const result=await WorkspaceManager.importZip(id,await zip.generateAsync({type:'nodebuffer'}));
    assert.deepEqual(result.importedFiles.sort(),['public/logo.png','src/App.tsx']);
    assert.equal(WorkspaceManager.readFile(id,'src/App.tsx'),'export const App=()=>null;');
    assert.deepEqual(WorkspaceManager.readBinaryFile(id,'public/logo.png'),Buffer.from([0,1,2,255]));
  } finally { cleanup(id); }
});

test('ZIP import never strips a legitimate src root', async () => {
  const id=createProject('zip-src-root');
  try {
    const zip=new JSZip();
    zip.file('src/App.tsx','export const App=1;');
    zip.file('src/lib/util.ts','export const util=1;');
    const result=await WorkspaceManager.importZip(id,await zip.generateAsync({type:'nodebuffer'}));
    assert.ok(result.importedFiles.includes('src/App.tsx'));
    assert.ok(result.importedFiles.includes('src/lib/util.ts'));
    assert.equal(WorkspaceManager.readFile(id,'App.tsx'),null);
  } finally { cleanup(id); }
});
