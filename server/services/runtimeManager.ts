import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { WorkspaceManager } from './workspaceManager.js';
import { ExecutionWorker } from './executionWorker.js';

export type RuntimeStatus = 'static' | 'starting' | 'installing' | 'running' | 'error' | 'stopping' | 'stopped';

export interface RuntimeInfo {
  status: RuntimeStatus;
  framework?: string;
  packageManager?: string;
  command?: string;
  port?: number;
  url?: string;
  startedAt?: string;
  updatedAt: string;
  lastError?: string;
  output?: string;
}

interface RuntimeRecord extends RuntimeInfo {
  child?: ChildProcessWithoutNullStreams;
  operation?: Promise<RuntimeInfo>;
}

const records = new Map<string, RuntimeRecord>();
const MAX_OUTPUT = 12000;
const START_TIMEOUT_MS = 120000;
const INSTALL_TIMEOUT_MS = 180000;

function now() { return new Date().toISOString(); }
function clip(current: string | undefined, chunk: Buffer | string) { return `${current || ''}${chunk.toString()}`.slice(-MAX_OUTPUT); }
function hasFile(cwd: string, file: string) { return fs.existsSync(path.join(cwd, file)); }
function readPackage(cwd: string): any | null { try { return JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')); } catch { return null; } }

async function findPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function detectPackageManager(cwd: string) {
  if (hasFile(cwd, 'pnpm-lock.yaml')) return 'pnpm';
  if (hasFile(cwd, 'yarn.lock')) return 'yarn';
  if (hasFile(cwd, 'bun.lockb') || hasFile(cwd, 'bun.lock')) return 'bun';
  return 'npm';
}

function detectFramework(pkg: any) {
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  if (deps.vite || String(pkg?.scripts?.dev || '').includes('vite')) return 'vite';
  if (deps.next || String(pkg?.scripts?.dev || '').includes('next')) return 'next';
  if (deps['@sveltejs/kit']) return 'sveltekit';
  if (deps.astro) return 'astro';
  return 'node';
}

function toolCommand(packageManager: string) {
  if (packageManager === 'npm') {
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(npmCli)) return { command: process.execPath, prefix: [npmCli] };
    return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [] };
  }
  if (packageManager === 'pnpm') return { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', prefix: [] };
  if (packageManager === 'yarn') return { command: process.platform === 'win32' ? 'yarn.cmd' : 'yarn', prefix: [] };
  return { command: process.platform === 'win32' ? 'bun.exe' : 'bun', prefix: [] };
}

function installArgs(packageManager: string, cwd: string) {
  if (packageManager === 'npm') return hasFile(cwd, 'package-lock.json') || hasFile(cwd, 'npm-shrinkwrap.json') ? ['ci'] : ['install'];
  if (packageManager === 'pnpm') return ['install', hasFile(cwd, 'pnpm-lock.yaml') ? '--frozen-lockfile' : '--no-frozen-lockfile'];
  if (packageManager === 'yarn') return hasFile(cwd, 'yarn.lock') ? ['install', '--frozen-lockfile'] : ['install'];
  return ['install'];
}

function startArgs(packageManager: string, pkg: any, framework: string, port: number) {
  const script = pkg?.scripts?.dev ? 'dev' : pkg?.scripts?.start ? 'start' : '';
  if (!script) throw new Error('Nenhum script dev/start foi encontrado no package.json.');
  const base = packageManager === 'bun' ? ['run', script] : ['run', script];
  if (framework === 'vite') return [...base, '--', '--host', '127.0.0.1', '--port', String(port)];
  if (framework === 'next') return [...base, '--', '-H', '127.0.0.1', '-p', String(port)];
  if (framework === 'astro') return [...base, '--', '--host', '127.0.0.1', '--port', String(port)];
  return base;
}

async function killProcessTree(child: ChildProcessWithoutNullStreams) {
  if (child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    await new Promise<void>(resolve => execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => resolve()));
    return;
  }
  try { child.kill(); } catch {}
}

async function runTool(cwd: string, packageManager: string, args: string[], timeoutMs: number, signal?: AbortSignal) {
  const { command, prefix } = toolCommand(packageManager);
  const started = Date.now();
  return await new Promise<{ ok: boolean; output: string; durationMs: number }>((resolve) => {
    const child = spawn(command, [...prefix, ...args], { cwd, shell: false, windowsHide: true, env: ExecutionWorker.safeEnvironment() });
    let output = '';
    child.stdout.on('data', b => output = clip(output, b));
    child.stderr.on('data', b => output = clip(output, b));
    const timer = setTimeout(() => { void killProcessTree(child); }, timeoutMs);
    const abort = () => { void killProcessTree(child); };
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, output: e.message, durationMs: Date.now() - started }); });
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve({ ok: code === 0, output, durationMs: Date.now() - started }); });
  });
}

async function waitForHttp(port: number, signal?: AbortSignal) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Inicialização cancelada.');
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/', method: 'GET', timeout: 1500 }, res => { res.resume(); resolve(true); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
    if (ok) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('O dev server não respondeu dentro do limite de tempo.');
}

export class RuntimeManager {
  static get(projectId: string): RuntimeInfo | null {
    const record = records.get(projectId);
    if (!record) return null;
    const { child: _child, operation: _operation, ...info } = record;
    return info;
  }

  static async ensure(projectId: string, signal?: AbortSignal): Promise<RuntimeInfo> {
    const cwd = WorkspaceManager.getProjectDir(projectId);
    const pkg = readPackage(cwd);
    if (!pkg) return { status: 'static', updatedAt: now(), lastError: 'Projeto sem package.json usa preview estático.' };

    const existing = records.get(projectId);
    if (existing?.status === 'running' && existing.child && !existing.child.killed && existing.port) return this.get(projectId)!;
    if (existing?.operation) return existing.operation;

    const packageManager = detectPackageManager(cwd);
    const framework = detectFramework(pkg);
    const operation = this.start(projectId, cwd, pkg, packageManager, framework, signal);
    records.set(projectId, { status: 'starting', packageManager, framework, updatedAt: now(), operation });
    return operation;
  }

  private static async start(projectId: string, cwd: string, pkg: any, packageManager: string, framework: string, signal?: AbortSignal): Promise<RuntimeInfo> {
    try {
      const modulesPath = path.join(cwd, 'node_modules');
      if (!fs.existsSync(modulesPath)) {
        records.set(projectId, { status: 'installing', packageManager, framework, updatedAt: now(), command: `${packageManager} ${installArgs(packageManager, cwd).join(' ')}` });
        const installed = await runTool(cwd, packageManager, installArgs(packageManager, cwd), INSTALL_TIMEOUT_MS, signal);
        if (!installed.ok) throw new Error(`Falha ao instalar dependências: ${installed.output || 'sem saída'}`);
      }

      const port = await findPort();
      const args = startArgs(packageManager, pkg, framework, port);
      const { command, prefix } = toolCommand(packageManager);
      const env = { ...ExecutionWorker.safeEnvironment(), PORT: String(port), HOST: '127.0.0.1', FORGE_PROJECT_RUNTIME: '1' };
      const child = spawn(command, [...prefix, ...args], { cwd, shell: false, windowsHide: true, env });
      const record: RuntimeRecord = { status: 'starting', packageManager, framework, command: `${packageManager} ${args.join(' ')}`, port, url: `http://127.0.0.1:${port}`, startedAt: now(), updatedAt: now(), child, output: '' };
      records.set(projectId, record);
      child.stdout.on('data', b => { record.output = clip(record.output, b); record.updatedAt = now(); });
      child.stderr.on('data', b => { record.output = clip(record.output, b); record.updatedAt = now(); });
      child.on('exit', code => {
        if (record.status !== 'stopping' && record.status !== 'stopped') {
          record.status = code === 0 ? 'stopped' : 'error';
          record.lastError = code === 0 ? undefined : `Processo encerrado com código ${code}.`;
          record.updatedAt = now();
        }
      });
      const abort = () => this.stop(projectId);
      signal?.addEventListener('abort', abort, { once: true });
      await waitForHttp(port, signal);
      signal?.removeEventListener('abort', abort);
      record.status = 'running';
      record.updatedAt = now();
      return this.get(projectId)!;
    } catch (error: any) {
      await this.stop(projectId);
      const info: RuntimeRecord = { status: 'error', packageManager, framework, updatedAt: now(), lastError: String(error?.message || error) };
      records.set(projectId, info);
      return this.get(projectId)!;
    }
  }

  static async stop(projectId: string): Promise<RuntimeInfo> {
    const record = records.get(projectId);
    if (!record) return { status: 'stopped', updatedAt: now() };
    record.status = 'stopping';
    record.updatedAt = now();
    const child = record.child;
    if (child && !child.killed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { void killProcessTree(child).finally(resolve); }, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        void killProcessTree(child).catch(() => undefined);
      });
    }
    const stopped: RuntimeRecord = { ...record, child: undefined, operation: undefined, status: 'stopped', updatedAt: now() };
    records.set(projectId, stopped);
    return this.get(projectId)!;
  }

  static async restart(projectId: string, signal?: AbortSignal) {
    await this.stop(projectId);
    return this.ensure(projectId, signal);
  }

  static proxy(projectId: string, reqPath: string, res: http.ServerResponse) {
    const record = records.get(projectId);
    if (record?.status !== 'running' || !record.port) return false;
    const safePath = reqPath.startsWith('/') ? reqPath : `/${reqPath}`;
    const request = http.request({ hostname: '127.0.0.1', port: record.port, path: safePath, method: 'GET', headers: { accept: '*/*' } }, upstream => {
      res.statusCode = upstream.statusCode || 200;
      for (const [key, value] of Object.entries(upstream.headers)) {
        if (value !== undefined && !['content-security-policy', 'x-frame-options'].includes(key.toLowerCase())) res.setHeader(key, value as any);
      }
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'self' https: data: blob:; script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; connect-src 'self' https: wss:; img-src 'self' https: data: blob:; font-src 'self' https: data:; form-action 'none'");
      upstream.pipe(res);
    });
    request.on('error', error => {
      res.statusCode = 502;
      res.end(`Preview runtime indisponível: ${String((error as Error).message)}`);
    });
    request.end();
    return true;
  }

  static async stopAll() {
    await Promise.all([...records.keys()].map(id => this.stop(id)));
  }
}
