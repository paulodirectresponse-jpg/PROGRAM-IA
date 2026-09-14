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
const PORT_ATTEMPTS = 5;

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

export function detectFramework(pkg: any) {
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  if (deps.vite || String(pkg?.scripts?.dev || '').includes('vite')) return 'vite';
  if (deps.next || String(pkg?.scripts?.dev || '').includes('next')) return 'next';
  if (deps['@sveltejs/kit']) return 'sveltekit';
  if (deps.astro) return 'astro';
  if (deps['react-scripts']) return 'cra';
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
  if (packageManager === 'npm') return [...(hasFile(cwd, 'package-lock.json') || hasFile(cwd, 'npm-shrinkwrap.json') ? ['ci'] : ['install']), '--ignore-scripts'];
  if (packageManager === 'pnpm') return ['install', hasFile(cwd, 'pnpm-lock.yaml') ? '--frozen-lockfile' : '--no-frozen-lockfile', '--ignore-scripts'];
  if (packageManager === 'yarn') return [...(hasFile(cwd, 'yarn.lock') ? ['install', '--frozen-lockfile'] : ['install']), '--ignore-scripts'];
  return ['install', '--ignore-scripts'];
}

function buildArgs(packageManager: string) {
  return packageManager === 'bun' ? ['run', 'build'] : ['run', 'build'];
}

function startArgs(packageManager: string, pkg: any, framework: string, port: number) {
  const script = pkg?.scripts?.dev ? 'dev' : pkg?.scripts?.start ? 'start' : '';
  if (!script) throw new Error('Nenhum script dev/start foi encontrado no package.json.');
  const base = ['run', script];
  if (framework === 'vite') return [...base, '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
  if (framework === 'next') return [...base, '--', '-H', '127.0.0.1', '-p', String(port)];
  if (framework === 'astro') return [...base, '--', '--host', '127.0.0.1', '--port', String(port)];
  return base;
}

export function expectedBuildOutput(framework: string) {
  if (framework === 'vite' || framework === 'astro') return 'dist';
  if (framework === 'cra') return 'build';
  if (framework === 'next') return 'out';
  return 'dist';
}

export async function killProcessTree(child: ChildProcessWithoutNullStreams) {
  if (child.killed || !child.pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => resolve()));
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  await new Promise(resolve => setTimeout(resolve, 400));
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}

async function runTool(cwd: string, packageManager: string, args: string[], timeoutMs: number, signal?: AbortSignal, envOverride?: NodeJS.ProcessEnv) {
  const { command, prefix } = toolCommand(packageManager);
  const started = Date.now();
  return await new Promise<{ ok: boolean; output: string; durationMs: number; timedOut: boolean }>((resolve) => {
    const child = spawn(command, [...prefix, ...args], { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env: envOverride || ExecutionWorker.safeEnvironment() });
    let output = '';
    let settled = false;
    const finish = (value: { ok: boolean; output: string; durationMs: number; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    child.stdout.on('data', b => output = clip(output, b));
    child.stderr.on('data', b => output = clip(output, b));
    const timer = setTimeout(() => { void killProcessTree(child); }, timeoutMs);
    const abort = () => { void killProcessTree(child); };
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', e => finish({ ok: false, output: e.message, durationMs: Date.now() - started, timedOut: false }));
    child.on('close', code => finish({ ok: code === 0, output, durationMs: Date.now() - started, timedOut: signal?.aborted || Date.now() - started >= timeoutMs }));
  });
}

export async function ensureDependenciesAt(cwd:string,signal?:AbortSignal){
  const pkg=readPackage(cwd);
  if(!pkg)return {ok:true,skipped:true,output:'Projeto sem package.json.',durationMs:0,packageManager:'none'};
  const packageManager=detectPackageManager(cwd);
  if(fs.existsSync(path.join(cwd,'node_modules')))return {ok:true,skipped:true,output:'Dependências já presentes.',durationMs:0,packageManager};
  const result=await runTool(cwd,packageManager,installArgs(packageManager,cwd),INSTALL_TIMEOUT_MS,signal);
  return {...result,skipped:false,packageManager};
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

function safePreviewHeaders(headers: http.IncomingHttpHeaders) {
  const blocked = new Set(['host','cookie','authorization','proxy-authorization','x-forwarded-for','x-forwarded-host','x-forwarded-proto','content-length']);
  const next: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || blocked.has(key.toLowerCase()) || key.toLowerCase().startsWith('x-forge')) continue;
    next[key] = Array.isArray(value) ? value : String(value);
  }
  next.host = '127.0.0.1';
  return next;
}

function writePreviewHeaders(upstream: http.IncomingMessage, res: http.ServerResponse) {
  for (const [key, value] of Object.entries(upstream.headers)) {
    if (value !== undefined && !['content-security-policy', 'x-frame-options', 'set-cookie'].includes(key.toLowerCase())) res.setHeader(key, value as any);
  }
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'self' https: data: blob:; script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; connect-src 'self' https: wss: ws:; img-src 'self' https: data: blob:; font-src 'self' https: data:; form-action 'none'");
}

export class RuntimeManager {
  static get(projectId: string): RuntimeInfo | null {
    const record = records.get(projectId);
    if (!record) return null;
    const { child: _child, operation: _operation, ...info } = record;
    return info;
  }

  static async build(projectId: string, signal?: AbortSignal): Promise<{ ok: boolean; output: string; framework: string; packageManager: string; artifactDir?: string; durationMs: number }> {
    const cwd = WorkspaceManager.getProjectDir(projectId);
    const pkg = readPackage(cwd);
    if (!pkg) throw new Error('Projeto sem package.json não possui build de framework.');
    const packageManager = detectPackageManager(cwd);
    const framework = detectFramework(pkg);
    if (!pkg?.scripts?.build) throw new Error('Script build não declarado no package.json.');
    const result = await runTool(cwd, packageManager, buildArgs(packageManager), INSTALL_TIMEOUT_MS, signal);
    const artifact = path.join(cwd, expectedBuildOutput(framework));
    return { ok: result.ok, output: result.output, framework, packageManager, artifactDir: result.ok && fs.existsSync(path.join(artifact, 'index.html')) ? artifact : undefined, durationMs: result.durationMs };
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
        const args = installArgs(packageManager, cwd);
        records.set(projectId, { status: 'installing', packageManager, framework, updatedAt: now(), command: `${packageManager} ${args.join(' ')}` });
        const installed = await runTool(cwd, packageManager, args, INSTALL_TIMEOUT_MS, signal);
        if (!installed.ok) throw new Error(`Falha ao instalar dependências: ${installed.output || 'sem saída'}`);
      }

      let lastError: unknown;
      for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
        const port = await findPort();
        const args = startArgs(packageManager, pkg, framework, port);
        const { command, prefix } = toolCommand(packageManager);
        const env = { ...ExecutionWorker.safeEnvironment(), PORT: String(port), HOST: '127.0.0.1', FORGE_PROJECT_RUNTIME: '1' };
        const child = spawn(command, [...prefix, ...args], { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env });
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
        try {
          await waitForHttp(port, signal);
          signal?.removeEventListener('abort', abort);
          record.status = 'running';
          record.updatedAt = now();
          return this.get(projectId)!;
        } catch (error: any) {
          signal?.removeEventListener('abort', abort);
          lastError = error;
          const text = `${record.output || ''}\n${String(error?.message || error)}`;
          await this.stop(projectId);
          if (!/EADDRINUSE|address already in use/i.test(text) || attempt === PORT_ATTEMPTS - 1) throw error;
        }
      }
      throw lastError || new Error('Não foi possível reservar porta para o runtime.');
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

  static proxy(projectId: string, req: http.IncomingMessage, reqPath: string, res: http.ServerResponse) {
    const record = records.get(projectId);
    if (record?.status !== 'running' || !record.port) return false;
    const safePath = reqPath.startsWith('/') ? reqPath : `/${reqPath}`;
    const request = http.request({ hostname: '127.0.0.1', port: record.port, path: safePath, method: req.method, headers: safePreviewHeaders(req.headers) }, upstream => {
      res.statusCode = upstream.statusCode || 200;
      writePreviewHeaders(upstream, res);
      upstream.pipe(res);
    });
    request.on('error', error => {
      if (res.headersSent) return res.destroy(error as Error);
      res.statusCode = 502;
      res.end(`Preview runtime indisponível: ${String((error as Error).message)}`);
    });
    if (!['GET', 'HEAD'].includes(String(req.method || 'GET').toUpperCase())) req.pipe(request);
    else request.end();
    return true;
  }

  static async stopAll() {
    await Promise.all([...records.keys()].map(id => this.stop(id)));
  }
}
