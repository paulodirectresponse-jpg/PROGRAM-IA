import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { db } from '../db/index.js';
import { WorkspaceManager } from './workspaceManager.js';
import { RuntimeManager } from './runtimeManager.js';
import { PreviewRecoverySupervisor } from './previewRecoverySupervisor.js';
import { StorageGuard, type StorageSnapshot } from './storageGuard.js';

type CaseResult = {
  name: string;
  ok: boolean;
  elapsedMs: number;
  detail?: Record<string, unknown>;
  error?: string;
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchText(url: string, timeoutMs = 5000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.text();
  return { status: response.status, body };
}

async function runCase(name: string, fn: () => Promise<Record<string, unknown> | void>): Promise<CaseResult> {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, elapsedMs: Date.now() - startedAt, detail: detail || undefined };
  } catch (error: any) {
    return { name, ok: false, elapsedMs: Date.now() - startedAt, error: String(error?.message || error) };
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function simpleNodeProject(dir: string, marker: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: `preview-regression-${marker.toLowerCase()}`,
    private: true,
    scripts: { dev: 'node server.mjs' },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'server.mjs'), `import http from 'node:http';
const marker = ${JSON.stringify(marker)};
const port = Number(process.env.PORT);
http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end(marker);}).listen(port,'127.0.0.1');
`);
}

async function waitForStatus(projectId: string, expected: string[], timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let current = RuntimeManager.get(projectId);
  while (Date.now() < deadline) {
    if (current && expected.includes(current.status)) return current;
    await wait(100);
    current = RuntimeManager.get(projectId);
  }
  throw new Error(`Runtime ${projectId} não chegou a ${expected.join('/')} em ${timeoutMs}ms; estado=${current?.status || 'null'}`);
}

export class PreviewRegressionBootstrap {
  static async maybeStartFromEnv() {
    if (process.env.FORGE_PREVIEW_REGRESSION_ENABLED !== 'true') return;
    const realProjectId = String(process.env.FORGE_PREVIEW_REGRESSION_PROJECT_ID || '').trim();
    const runId = `preview-regression-${crypto.randomUUID()}`;
    const results: CaseResult[] = [];
    const cleanupProjectIds = new Set<string>();
    const tempRoot = path.join(os.tmpdir(), 'forge-preview-regression', runId);
    fs.mkdirSync(tempRoot, { recursive: true });

    console.log('FORGE_PREVIEW_REGRESSION_START', JSON.stringify({ runId, realProjectId: realProjectId || null }));

    try {
      results.push(await runCase('service-shell-and-auth-fast-path', async () => {
        const base = `http://127.0.0.1:${Number(process.env.PORT || 3000)}`;
        const healthStarted = Date.now();
        const health = await fetchText(`${base}/api/health`);
        const shell = await fetchText(`${base}/`);
        const authStarted = Date.now();
        const auth = await fetchText(`${base}/api/auth/me`, 7000);
        const authMs = Date.now() - authStarted;
        assert(health.status === 200, `/api/health retornou ${health.status}`);
        assert(shell.status === 200, `/ retornou ${shell.status}`);
        assert(auth.status === 200, `/api/auth/me retornou ${auth.status}`);
        assert(authMs < 6500, `/api/auth/me excedeu o limite do gate: ${authMs}ms`);
        return { healthMs: Date.now() - healthStarted, authMs, shellBytes: Buffer.byteLength(shell.body) };
      }));

      results.push(await runCase('static-html-preview', async () => {
        const id = `reg-static-${crypto.randomBytes(6).toString('hex')}`;
        cleanupProjectIds.add(id);
        WorkspaceManager.writeFile(id, 'index.html', '<!doctype html><html><body>STATIC_REGRESSION_OK</body></html>');
        const info = WorkspaceManager.getPreviewInfo(id);
        assert(info.status === 'running', `preview estático não ficou running: ${info.message}`);
        assert(info.entryPath === 'index.html', `entryPath inesperado: ${info.entryPath}`);
        assert((WorkspaceManager.readFile(id, 'index.html') || '').includes('STATIC_REGRESSION_OK'), 'conteúdo estático divergente');
        return { entryPath: info.entryPath };
      }));

      results.push(await runCase('zip-import-wrapper-normalization', async () => {
        assert(realProjectId, 'FORGE_PREVIEW_REGRESSION_PROJECT_ID não configurado para obter owner seguro');
        const owner = db.prepare('SELECT user_id, workspace_id FROM projects WHERE id=?').get(realProjectId) as any;
        assert(owner?.user_id && owner?.workspace_id, 'projeto real não encontrado para criar fixture temporária');
        const id = `reg-zip-${crypto.randomBytes(6).toString('hex')}`;
        cleanupProjectIds.add(id);
        const now = new Date().toISOString();
        db.prepare("INSERT INTO projects(id,user_id,workspace_id,name,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
          .run(id, owner.user_id, owner.workspace_id, 'Preview Regression ZIP', 'regression', now, now);

        const zip = new JSZip();
        zip.file('wrapped-site/index.html', '<!doctype html><html><body>ZIP_REGRESSION_OK</body></html>');
        zip.file('wrapped-site/assets/app.js', 'console.log("ZIP_REGRESSION_OK")');
        const buffer = await zip.generateAsync({ type: 'nodebuffer' });
        const imported = await WorkspaceManager.importZip(id, buffer);
        const info = WorkspaceManager.getPreviewInfo(id);
        assert(imported.fileCount === 2, `ZIP importou ${imported.fileCount} arquivos`);
        assert(imported.importedFiles.includes('index.html'), 'wrapper do ZIP não foi removido');
        assert(info.status === 'running' && info.entryPath === 'index.html', 'ZIP importado não virou preview estático válido');
        return { fileCount: imported.fileCount, importedFiles: imported.importedFiles };
      }));

      results.push(await runCase('synthetic-low-storage-guard', async () => {
        const synthetic: StorageSnapshot = {
          path: '/synthetic-low-space',
          totalBytes: 1024 * 1024 * 1024,
          freeBytes: 32 * 1024 * 1024,
          usedBytes: 992 * 1024 * 1024,
          freePercent: 3.125,
        };
        const denied = StorageGuard.evaluateCapacity(synthetic);
        const actual = StorageGuard.inspect().temporary;
        assert(!denied.ok, 'StorageGuard aceitou snapshot sintético abaixo do limite');
        assert(actual, 'não foi possível inspecionar storage temporário real');
        const accepted = StorageGuard.evaluateCapacity(actual);
        assert(accepted.ok, `storage temporário real seria bloqueado: ${accepted.reason}`);
        return { simulatedDenied: true, realFreePercent: Number(actual.freePercent.toFixed(2)), realFreeBytes: actual.freeBytes };
      }));

      results.push(await runCase('multi-project-runtime-isolation', async () => {
        const dirA = path.join(tempRoot, 'multi-a');
        const dirB = path.join(tempRoot, 'multi-b');
        const keyA = `reg-runtime-a-${crypto.randomBytes(5).toString('hex')}`;
        const keyB = `reg-runtime-b-${crypto.randomBytes(5).toString('hex')}`;
        simpleNodeProject(dirA, 'RUNTIME_A_OK');
        simpleNodeProject(dirB, 'RUNTIME_B_OK');
        try {
          const [a, b] = await Promise.all([
            RuntimeManager.ensureAt(keyA, dirA, undefined, true),
            RuntimeManager.ensureAt(keyB, dirB, undefined, true),
          ]);
          assert(a.status === 'running' && a.url, `runtime A falhou: ${a.lastError || a.status}`);
          assert(b.status === 'running' && b.url, `runtime B falhou: ${b.lastError || b.status}`);
          assert(a.port !== b.port, 'dois projetos receberam a mesma porta');
          const [bodyA, bodyB] = await Promise.all([fetchText(a.url), fetchText(b.url)]);
          assert(bodyA.body === 'RUNTIME_A_OK', `isolamento A divergente: ${bodyA.body.slice(0,100)}`);
          assert(bodyB.body === 'RUNTIME_B_OK', `isolamento B divergente: ${bodyB.body.slice(0,100)}`);
          return { portA: a.port, portB: b.port };
        } finally {
          await Promise.all([RuntimeManager.stop(keyA), RuntimeManager.stop(keyB)]);
        }
      }));

      results.push(await runCase('workspace-edit-invalidates-runtime', async () => {
        const id = `reg-edit-${crypto.randomBytes(6).toString('hex')}`;
        cleanupProjectIds.add(id);
        WorkspaceManager.writeFile(id, 'package.json', JSON.stringify({ name: id, private: true, scripts: { dev: 'node server.mjs' } }));
        WorkspaceManager.writeFile(id, 'server.mjs', `import http from 'node:http';const p=Number(process.env.PORT);http.createServer((_q,r)=>r.end('EDIT_V1')).listen(p,'127.0.0.1');`);
        const first = await RuntimeManager.ensure(id);
        assert(first.status === 'running' && first.url, `runtime de edição inicial falhou: ${first.lastError || first.status}`);
        const initial = await fetchText(first.url);
        assert(initial.body === 'EDIT_V1', 'runtime inicial não serviu EDIT_V1');

        WorkspaceManager.writeFile(id, 'server.mjs', `import http from 'node:http';const p=Number(process.env.PORT);http.createServer((_q,r)=>r.end('EDIT_V2')).listen(p,'127.0.0.1');`);
        await waitForStatus(id, ['stopped'], 5000);
        const second = await RuntimeManager.ensure(id);
        assert(second.status === 'running' && second.url, `runtime pós-edição falhou: ${second.lastError || second.status}`);
        const updated = await fetchText(second.url);
        assert(updated.body === 'EDIT_V2', `preview ficou stale após edição: ${updated.body.slice(0,100)}`);
        return { firstSession: first.sessionId, secondSession: second.sessionId };
      }));

      if (realProjectId) {
        results.push(await runCase('real-project-deploy-restart-and-http', async () => {
          const runtime = await RuntimeManager.restart(realProjectId);
          assert(runtime.status === 'running' && runtime.url, `projeto real não iniciou: ${runtime.lastError || runtime.status}`);
          const response = await fetchText(runtime.url);
          assert(response.status < 500 && response.body.length > 0, `projeto real respondeu ${response.status} / ${response.body.length} bytes`);
          return { framework: runtime.framework, status: response.status, bodyBytes: Buffer.byteLength(response.body) };
        }));

        results.push(await runCase('real-process-kill-auto-recovery', async () => {
          PreviewRecoverySupervisor.reset(realProjectId);
          PreviewRecoverySupervisor.inspect(realProjectId);
          const before = RuntimeManager.get(realProjectId);
          assert(before?.status === 'running', 'runtime real não estava running antes do kill');
          const killed = await RuntimeManager.killForSmoke(realProjectId);
          assert(killed, 'não foi possível matar/detectar o processo real do preview');
          PreviewRecoverySupervisor.inspect(realProjectId);
          const recovered = await waitForStatus(realProjectId, ['running'], 15000);
          assert(recovered.url, 'runtime recuperado sem URL');
          const response = await fetchText(recovered.url);
          assert(response.status < 500 && response.body.length > 0, 'runtime recuperado não respondeu');
          assert(before?.sessionId !== recovered.sessionId, 'recuperação reutilizou indevidamente a mesma sessão');
          return { previousSession: before?.sessionId, recoveredSession: recovered.sessionId, status: response.status, recoveryBodyBytes: Buffer.byteLength(response.body) };
        }));
      }

      const failed = results.filter(item => !item.ok);
      const payload = {
        runId,
        ok: failed.length === 0,
        passed: results.length - failed.length,
        failed: failed.length,
        total: results.length,
        results,
        storage: StorageGuard.inspect(),
      };
      if (failed.length) console.error('FORGE_PREVIEW_REGRESSION_RESULT', JSON.stringify(payload));
      else console.log('FORGE_PREVIEW_REGRESSION_RESULT', JSON.stringify(payload));
    } finally {
      for (const id of cleanupProjectIds) {
        await RuntimeManager.stop(id).catch(() => undefined);
        try { db.prepare('DELETE FROM checkpoints WHERE project_id=?').run(id); } catch {}
        try { db.prepare('DELETE FROM verifications WHERE project_id=?').run(id); } catch {}
        try { db.prepare('DELETE FROM projects WHERE id=?').run(id); } catch {}
        try { WorkspaceManager.deleteProject(id); } catch {}
      }
      try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
      console.log('FORGE_PREVIEW_REGRESSION_CLEANUP', JSON.stringify({ runId, cleanedProjects: cleanupProjectIds.size }));
    }
  }
}
