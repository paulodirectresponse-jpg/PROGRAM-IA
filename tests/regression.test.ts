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

test('ZIP import strips a real archive wrapper, preserves bytes, and exposes every imported file', async () => {
  const id=createProject('zip-wrapper');
  try {
    const zip=new JSZip();
    zip.file('my-project/src/App.tsx','export const App=()=>null;');
    zip.file('my-project/public/logo.png',Buffer.from([0,1,2,255]));
    const result=await WorkspaceManager.importZip(id,await zip.generateAsync({type:'nodebuffer'}));
    assert.deepEqual(result.importedFiles.sort(),['public/logo.png','src/App.tsx']);
    assert.equal(WorkspaceManager.readFile(id,'src/App.tsx'),'export const App=()=>null;');
    assert.deepEqual(WorkspaceManager.readBinaryFile(id,'public/logo.png'),Buffer.from([0,1,2,255]));
    const visible=WorkspaceManager.getFiles(id).map(file=>file.path).sort();
    assert.deepEqual(visible,['public/logo.png','src/App.tsx']);
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

test('framework project cannot be downgraded to raw static preview', () => {
  const id=createProject('framework-preview');
  try {
    WorkspaceManager.writeFile(id,'package.json',JSON.stringify({scripts:{dev:'vite'}}));
    WorkspaceManager.writeFile(id,'index.html','<div id="root"></div>');
    const preview=WorkspaceManager.getPreviewInfo(id);
    assert.equal(preview.status,'error');
    assert.match(preview.message,/runtime de framework/i);
    assert.equal(preview.entryPath,undefined);
  } finally { cleanup(id); }
});

test('plain HTML project keeps static preview support', () => {
  const id=createProject('static-preview');
  try {
    WorkspaceManager.writeFile(id,'index.html','<!doctype html><h1>ok</h1>');
    const preview=WorkspaceManager.getPreviewInfo(id);
    assert.equal(preview.status,'running');
    assert.equal(preview.entryPath,'index.html');
  } finally { cleanup(id); }
});
