import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { WorkspaceManager } from './workspaceManager.js';
import { ExecutionWorker } from './executionWorker.js';
import { StorageGuard } from './storageGuard.js';

export type RuntimeStatus = 'static' | 'starting' | 'installing' | 'running' | 'error' | 'stopping' | 'stopped';
export type RuntimeStage =
  | 'detect'
  | 'validate'
  | 'copy'
  | 'analyze_dependencies'
  | 'install'
  | 'start'
  | 'health_check'
  | 'ready'
  | 'cleanup'
  | 'failed'
  | 'idle';

export interface RuntimeInfo {
  status: RuntimeStatus;
  stage?: RuntimeStage;
  sessionId?: string;
  stageStartedAt?: string;
  stageElapsedMs?: number;
  framework?: string;
  packageManager?: string;
  command?: string;
  port?: number;
  url?: string;
  startedAt?: string;
  updatedAt: string;
  lastActivityAt?: string;
  lastError?: string;
  errorCode?: string;
  output?: string;
}

interface RuntimeRecord extends RuntimeInfo {
  child?: ChildProcessWithoutNullStreams;
  operation?: Promise<RuntimeInfo>;
  runtimeDir?: string;
  controller?: AbortController;
}

type ToolResult = {
  ok: boolean;
  output: string;
  durationMs: number;
  timedOut: boolean;
  stalled: boolean;
};

const records = new Map<string, RuntimeRecord>();
const MAX_OUTPUT = 16000;
const COPY_TIMEOUT_MS = 30000;
const INSTALL_TIMEOUT_MS = 180000;
const INSTALL_STALL_MS = 120000;
const HEALTH_TIMEOUT_MS = 45000;
const PORT_ATTEMPTS = 4;

const now = () => new Date().toISOString();
const clip = (current: string | undefined, chunk: Buffer | string) =>
  `${current || ''}${chunk.toString()}`.slice(-MAX_OUTPUT);
const hasFile = (cwd: string, file: string) => fs.existsSync(path.join(cwd, file));
const readPackage = (cwd: string): any | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
};

function stageStatus(stage: RuntimeStage): RuntimeStatus {
  if (stage === 'install') return 'installing';
  if (stage === 'ready') return 'running';
  if (stage === 'failed') return 'error';
  if (stage === 'cleanup') return 'stopping';
  if (stage === 'idle') return 'stopped';
  return 'starting';
}

function stageMessage(stage?: RuntimeStage): string {
  switch (stage) {
    case 'detect': return 'Identificando o projeto…';
    case 'validate': return 'Validando a configuração do projeto…';
    case 'copy': return 'Preparando uma cópia isolada do projeto…';
    case 'analyze_dependencies': return 'Analisando as dependências…';
    case 'install': return 'Instalando as dependências do preview…';
    case 'start': return 'Iniciando a aplicação…';
    case 'health_check': return 'Verificando o servidor da aplicação…';
    case 'ready': return 'Preview pronto.';
    case 'cleanup': return 'Limpando o runtime anterior…';
    case 'failed': return 'O preview falhou.';
    default: return 'Preparando o preview…';
  }
}

function publicRecord(record: RuntimeRecord): RuntimeInfo {
  const { child: _child, operation: _operation, runtimeDir: _runtimeDir, controller: _controller, ...info } = record;
  const started = info.stageStartedAt ? Date.parse(info.stageStartedAt) : NaN;
  return {
    ...info,
    stageElapsedMs: Number.isFinite(started) ? Math.max(0, Date.now() - started) : undefined,
  };
}

function logStage(key: string, record: RuntimeRecord, extra: Record<string, unknown> = {}) {
  console.log('FORGE_PREVIEW_STAGE', JSON.stringify({
    projectId: key,
    sessionId: record.sessionId,
    stage: record.stage,
    status: record.status,
    framework: record.framework,
    packageManager: record.packageManager,
    ...extra,
  }));
}

function setStage(key: string, sessionId: string, stage: RuntimeStage, patch: Partial<RuntimeRecord> = {}): RuntimeRecord {
  const current = records.get(key);
  if (current && current.sessionId && current.sessionId !== sessionId) return current;
  const previousStage = current?.stage;
  const next: RuntimeRecord = {
    ...(current || { status: stageStatus(stage), updatedAt: now() }),
    ...patch,
    status: stageStatus(stage),
    stage,
    sessionId,
    stageStartedAt: previousStage === stage ? current?.stageStartedAt || now() : now(),
    updatedAt: now(),
  };
  records.set(key, next);
  if (previousStage !== stage) logStage(key, next);
  return next;
}

function runtimeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

async function findPort() {
  return await new Promise<number>((resolve, reject) => {
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
  const dev = String(pkg?.scripts?.dev || '');
  const start = String(pkg?.scripts?.start || '');
  if (deps.vite || dev.includes('vite')) return 'vite';
  if (deps.next || dev.includes('next') || start.includes('next')) return 'next';
  if (deps['@sveltejs/kit']) return 'sveltekit';
  if (deps.astro || dev.includes('astro')) return 'astro';
  if (deps['react-scripts']) return 'cra';
  return 'node';
}

function toolCommand(pm: string) {
  if (pm === 'npm') {
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(npmCli)) return { command: process.execPath, prefix: [npmCli] };
    return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [] };
  }
  if (pm === 'pnpm') return { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', prefix: [] };
  if (pm === 'yarn') return { command: process.platform === 'win32' ? 'yarn.cmd' : 'yarn', prefix: [] };
  return { command: process.platform === 'win32' ? 'bun.exe' : 'bun', prefix: [] };
}

function toolAvailable(pm: string): boolean {
  if (pm === 'npm') return true;
  const { command, prefix } = toolCommand(pm);
  const probe = spawnSync(command, [...prefix, '--version'], {
    windowsHide: true,
    timeout: 3000,
    stdio: 'ignore',
    env: ExecutionWorker.safeEnvironment(),
  });
  return !probe.error && probe.status === 0;
}

function resolvePackageManager(cwd: string, key: string, sessionId: string): string {
  const requested = detectPackageManager(cwd);
  if (toolAvailable(requested)) return requested;
  if (requested !== 'npm') {
    console.warn('FORGE_PREVIEW_PACKAGE_MANAGER_FALLBACK', JSON.stringify({
      projectId: key,
      sessionId,
      requested,
      fallback: 'npm',
    }));
    return 'npm';
  }
  throw runtimeError('PREVIEW_TOOL_MISSING', 'O gerenciador de pacotes necessário para este projeto não está disponível.');
}

function installArgs(pm: string, cwd: string) {
  if (pm === 'npm') {
    const base = hasFile(cwd, 'package-lock.json') || hasFile(cwd, 'npm-shrinkwrap.json') ? ['ci'] : ['install'];
    return [...base, '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--legacy-peer-deps'];
  }
  if (pm === 'pnpm') {
    return ['install', hasFile(cwd, 'pnpm-lock.yaml') ? '--frozen-lockfile' : '--no-frozen-lockfile', '--ignore-scripts'];
  }
  if (pm === 'yarn') {
    return [...(hasFile(cwd, 'yarn.lock') ? ['install', '--frozen-lockfile'] : ['install']), '--ignore-scripts'];
  }
  return ['install', '--ignore-scripts'];
}

function startArgs(pm: string, pkg: any, framework: string, port: number) {
  const script = pkg?.scripts?.dev ? 'dev' : pkg?.scripts?.start ? 'start' : '';
  if (!script) throw runtimeError('PREVIEW_SCRIPT_MISSING', 'Nenhum script dev/start foi encontrado no package.json.');
  const base = ['run', script];
  if (framework === 'vite') return [...base, '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
  if (framework === 'next') return [...base, '--', '-H', '127.0.0.1', '-p', String(port)];
  if (framework === 'astro' || framework === 'sveltekit') return [...base, '--', '--host', '127.0.0.1', '--port', String(port)];
  if (framework === 'cra') return base;
  return base;
}

export function expectedBuildOutput(framework: string) {
  if (framework === 'vite' || framework === 'astro' || framework === 'sveltekit') return 'dist';
  if (framework === 'cra') return 'build';
  if (framework === 'next') return 'out';
  return 'dist';
}

function classifyRuntimeError(error: any, output = '') {
  const text = `${String(error?.message || error || '')}\n${output}`;
  if (error?.code === 'PREVIEW_SESSION_SUPERSEDED') return { code: error.code, message: 'A sessão de preview foi substituída por uma mais recente.' };
  if (/ENOSPC|no space left|disk is full|database or disk is full/i.test(text)) return { code: 'PREVIEW_STORAGE_FULL', message: 'Armazenamento insuficiente para preparar o preview.' };
  if (/ENOENT|not found|is not recognized|command not found/i.test(text)) return { code: 'PREVIEW_TOOL_MISSING', message: 'O gerenciador de pacotes necessário para este projeto não está disponível no runtime.' };
  if (/EADDRINUSE|address already in use/i.test(text)) return { code: 'PREVIEW_PORT_BUSY', message: 'A porta reservada para o preview ficou indisponível.' };
  if (/PREVIEW_INSTALL_STALLED/i.test(text)) return { code: 'PREVIEW_INSTALL_STALLED', message: 'A instalação das dependências ficou sem progresso e foi interrompida.' };
  if (/timed out|limite de tempo|não respondeu|excedeu/i.test(text)) return { code: 'PREVIEW_TIMEOUT', message: 'Uma etapa do preview excedeu o limite de tempo.' };
  if (/PREVIEW_SCRIPT_MISSING|Nenhum script dev\/start/i.test(text)) return { code: 'PREVIEW_SCRIPT_MISSING', message: 'O package.json não possui um script dev ou start utilizável para preview.' };
  if (/npm ERR!|ERR_PNPM|yarn error|bun install|Falha ao instalar dependências/i.test(text)) return { code: 'PREVIEW_INSTALL_FAILED', message: 'Falha ao instalar as dependências necessárias para o preview.' };
  if (/Processo do preview encerrou|PREVIEW_PROCESS_EXIT/i.test(text)) return { code: 'PREVIEW_PROCESS_EXIT', message: 'O processo do preview encerrou antes de ficar pronto.' };
  return { code: String(error?.code || 'PREVIEW_RUNTIME_FAILED'), message: String(error?.message || error || 'Falha desconhecida no runtime do preview.') };
}

export async function killProcessTree(child: ChildProcessWithoutNullStreams) {
  if (child.killed || !child.pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => resolve()));
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  await new Promise(r => setTimeout(r, 400));
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}

async function runTool(
  cwd: string,
  pm: string,
  args: string[],
  timeoutMs: number,
  stallMs: number,
  signal?: AbortSignal,
  envOverride?: NodeJS.ProcessEnv,
  onActivity?: (output: string) => void,
): Promise<ToolResult> {
  const { command, prefix } = toolCommand(pm);
  const started = Date.now();
  return await new Promise<ToolResult>(resolve => {
    const child = spawn(command, [...prefix, ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: envOverride || ExecutionWorker.safeEnvironment(),
    });
    let output = '';
    let settled = false;
    let timedOut = false;
    let stalled = false;
    let lastActivity = Date.now();

    const finish = (value: ToolResult) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const activity = (buffer: Buffer | string) => {
      output = clip(output, buffer);
      lastActivity = Date.now();
      onActivity?.(output);
    };
    const watchdog = setInterval(() => {
      if (Date.now() - started >= timeoutMs) {
        timedOut = true;
        void killProcessTree(child);
        return;
      }
      if (Date.now() - lastActivity >= stallMs) {
        stalled = true;
        void killProcessTree(child);
      }
    }, 1000);
    const abort = () => void killProcessTree(child);

    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', activity);
    child.stderr.on('data', activity);
    child.on('error', error => finish({
      ok: false,
      output: clip(output, error.message),
      durationMs: Date.now() - started,
      timedOut: false,
      stalled: false,
    }));
    child.on('close', code => finish({
      ok: code === 0 && !timedOut && !stalled && !signal?.aborted,
      output,
      durationMs: Date.now() - started,
      timedOut: timedOut || Boolean(signal?.aborted),
      stalled,
    }));
  });
}

export async function ensureDependenciesAt(cwd: string, signal?: AbortSignal) {
  const pkg = readPackage(cwd);
  if (!pkg) return { ok: true, skipped: true, output: 'Projeto sem package.json.', durationMs: 0, packageManager: 'none' };
  StorageGuard.assertCapacity('temporary', 'instalar dependências do preview');
  const pm = detectPackageManager(cwd);
  if (fs.existsSync(path.join(cwd, 'node_modules'))) return { ok: true, skipped: true, output: 'Dependências já presentes.', durationMs: 0, packageManager: pm };
  const actualPm = toolAvailable(pm) ? pm : 'npm';
  const result = await runTool(cwd, actualPm, installArgs(actualPm, cwd), INSTALL_TIMEOUT_MS, INSTALL_STALL_MS, signal, ExecutionWorker.sandboxEnvironment(cwd));
  return { ...result, skipped: false, packageManager: actualPm };
}

async function waitForHttp(
  port: number,
  child: ChildProcessWithoutNullStreams,
  output: () => string,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw runtimeError('PREVIEW_SESSION_SUPERSEDED', 'Inicialização cancelada.');
    if (child.exitCode !== null || child.killed) {
      throw runtimeError('PREVIEW_PROCESS_EXIT', `Processo do preview encerrou antes de responder.\n${output().slice(-3000)}`);
    }
    const ok = await new Promise<boolean>(resolve => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/', method: 'GET', timeout: 1500 }, res => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
    if (ok) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw runtimeError('PREVIEW_TIMEOUT', 'O dev server não respondeu dentro do limite de tempo.');
}

function safePreviewHeaders(headers: http.IncomingHttpHeaders) {
  const blocked = new Set(['host', 'cookie', 'authorization', 'proxy-authorization', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'content-length']);
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

function ephemeralRuntimeDir(projectId: string, sessionId: string) {
  return path.join(StorageGuard.previewTempRoot(), projectId, sessionId);
}

function assertActiveSession(key: string, sessionId: string, signal?: AbortSignal) {
  if (signal?.aborted || records.get(key)?.sessionId !== sessionId) {
    throw runtimeError('PREVIEW_SESSION_SUPERSEDED', 'Esta sessão de preview foi substituída.');
  }
}

async function copyProjectIsolated(source: string, target: string, signal: AbortSignal, key: string, sessionId: string) {
  const started = Date.now();
  let files = 0;
  let bytes = 0;
  const excluded = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', '.turbo', '.vite']);

  async function copyDir(from: string, to: string) {
    assertActiveSession(key, sessionId, signal);
    if (Date.now() - started > COPY_TIMEOUT_MS) throw runtimeError('PREVIEW_COPY_TIMEOUT', 'A cópia isolada do projeto excedeu o limite de tempo.');
    await fs.promises.mkdir(to, { recursive: true });
    const entries = await fs.promises.readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      assertActiveSession(key, sessionId, signal);
      if (excluded.has(entry.name)) continue;
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await copyDir(src, dst);
      } else if (entry.isFile()) {
        const stat = await fs.promises.stat(src);
        await fs.promises.copyFile(src, dst);
        files += 1;
        bytes += stat.size;
      }
    }
  }

  await fs.promises.rm(target, { recursive: true, force: true });
  await copyDir(source, target);
  return { files, bytes, durationMs: Date.now() - started };
}

function dependencySummary(pkg: any, cwd: string) {
  return {
    dependencies: Object.keys(pkg?.dependencies || {}).length,
    devDependencies: Object.keys(pkg?.devDependencies || {}).length,
    hasNodeModules: fs.existsSync(path.join(cwd, 'node_modules')),
    lockfile:
      hasFile(cwd, 'package-lock.json') ? 'package-lock.json' :
      hasFile(cwd, 'pnpm-lock.yaml') ? 'pnpm-lock.yaml' :
      hasFile(cwd, 'yarn.lock') ? 'yarn.lock' :
      hasFile(cwd, 'bun.lockb') || hasFile(cwd, 'bun.lock') ? 'bun.lock' :
      null,
  };
}

export class RuntimeManager {
  static get(projectId: string): RuntimeInfo | null {
    const record = records.get(projectId);
    return record ? publicRecord(record) : null;
  }

  static message(projectId: string): string {
    return stageMessage(records.get(projectId)?.stage);
  }

  static async build(projectId: string, signal?: AbortSignal) {
    const cwd = WorkspaceManager.getProjectDir(projectId);
    const pkg = readPackage(cwd);
    if (!pkg) throw new Error('Projeto sem package.json não possui build de framework.');
    const pm = toolAvailable(detectPackageManager(cwd)) ? detectPackageManager(cwd) : 'npm';
    const framework = detectFramework(pkg);
    if (!pkg?.scripts?.build) throw new Error('Script build não declarado no package.json.');
    const result = await runTool(cwd, pm, ['run', 'build'], INSTALL_TIMEOUT_MS, INSTALL_STALL_MS, signal);
    const artifact = path.join(cwd, expectedBuildOutput(framework));
    return {
      ok: result.ok,
      output: result.output,
      framework,
      packageManager: pm,
      artifactDir: result.ok && fs.existsSync(path.join(artifact, 'index.html')) ? artifact : undefined,
      durationMs: result.durationMs,
    };
  }

  static async ensure(projectId: string, signal?: AbortSignal): Promise<RuntimeInfo> {
    const source = WorkspaceManager.getProjectDir(projectId);
    if (!readPackage(source)) return { status: 'static', stage: 'ready', updatedAt: now(), lastError: 'Projeto sem package.json usa preview estático.' };

    const existing = records.get(projectId);
    if (existing?.status === 'running' && existing.child && !existing.child.killed && existing.port) return publicRecord(existing);
    if (existing?.operation) return existing.operation;

    const sessionId = `preview-${crypto.randomUUID()}`;
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const record: RuntimeRecord = {
      status: 'starting',
      stage: 'detect',
      sessionId,
      stageStartedAt: now(),
      updatedAt: now(),
      controller,
    };
    records.set(projectId, record);
    logStage(projectId, record);

    const operation = this.pipeline(projectId, source, controller.signal, false, sessionId, true);
    record.operation = operation;
    return operation;
  }

  static async ensureAt(key: string, cwd: string, signal?: AbortSignal, sandboxed = true): Promise<RuntimeInfo> {
    const pkg = readPackage(cwd);
    if (!pkg) return { status: 'static', stage: 'ready', updatedAt: now(), lastError: 'Projeto sem package.json usa preview estático.' };

    const existing = records.get(key);
    if (existing?.status === 'running' && existing.child && !existing.child.killed && existing.port) return publicRecord(existing);
    if (existing?.operation) return existing.operation;

    const sessionId = `preview-${crypto.randomUUID()}`;
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const record: RuntimeRecord = {
      status: 'starting',
      stage: 'detect',
      sessionId,
      stageStartedAt: now(),
      updatedAt: now(),
      controller,
      runtimeDir: cwd,
    };
    records.set(key, record);
    logStage(key, record);

    const operation = this.pipeline(key, cwd, controller.signal, sandboxed, sessionId, false);
    record.operation = operation;
    return operation;
  }

  private static async pipeline(
    key: string,
    source: string,
    signal: AbortSignal,
    sandboxed: boolean,
    sessionId: string,
    isolate: boolean,
  ): Promise<RuntimeInfo> {
    let cwd = source;
    let framework = 'node';
    let pm = 'npm';
    let diagnosticOutput = '';

    try {
      assertActiveSession(key, sessionId, signal);
      setStage(key, sessionId, 'detect');
      const sourcePkg = readPackage(source);
      if (!sourcePkg) throw runtimeError('PREVIEW_PACKAGE_INVALID', 'O package.json não pôde ser lido.');
      framework = detectFramework(sourcePkg);
      pm = resolvePackageManager(source, key, sessionId);

      setStage(key, sessionId, 'validate', { framework, packageManager: pm });
      if (!sourcePkg?.scripts?.dev && !sourcePkg?.scripts?.start) {
        throw runtimeError('PREVIEW_SCRIPT_MISSING', 'Nenhum script dev/start foi encontrado no package.json.');
      }

      if (isolate) {
        StorageGuard.assertCapacity('temporary', 'copiar o projeto para o preview');
        setStage(key, sessionId, 'copy', { framework, packageManager: pm });
        cwd = ephemeralRuntimeDir(key, sessionId);
        const copy = await copyProjectIsolated(source, cwd, signal, key, sessionId);
        const current = records.get(key);
        if (current?.sessionId === sessionId) current.runtimeDir = cwd;
        console.log('FORGE_PREVIEW_COPY', JSON.stringify({ projectId: key, sessionId, ...copy }));
      }

      assertActiveSession(key, sessionId, signal);
      const pkg = readPackage(cwd);
      if (!pkg) throw runtimeError('PREVIEW_PACKAGE_INVALID', 'O package.json não foi encontrado na cópia isolada.');

      setStage(key, sessionId, 'analyze_dependencies', { framework, packageManager: pm, runtimeDir: cwd });
      console.log('FORGE_PREVIEW_DEPENDENCIES', JSON.stringify({
        projectId: key,
        sessionId,
        framework,
        packageManager: pm,
        ...dependencySummary(pkg, cwd),
      }));

      if (!fs.existsSync(path.join(cwd, 'node_modules'))) {
        StorageGuard.assertCapacity('temporary', 'instalar dependências do preview');
        const args = installArgs(pm, cwd);
        setStage(key, sessionId, 'install', {
          framework,
          packageManager: pm,
          runtimeDir: cwd,
          command: `${pm} ${args.join(' ')}`,
        });

        const installed = await runTool(
          cwd,
          pm,
          args,
          INSTALL_TIMEOUT_MS,
          INSTALL_STALL_MS,
          signal,
          sandboxed ? ExecutionWorker.sandboxEnvironment(cwd) : ExecutionWorker.safeEnvironment(),
          output => {
            diagnosticOutput = output;
            const current = records.get(key);
            if (current?.sessionId === sessionId) {
              current.output = output;
              current.lastActivityAt = now();
              current.updatedAt = now();
            }
          },
        );
        diagnosticOutput = installed.output;
        if (!installed.ok) {
          if (installed.stalled) throw runtimeError('PREVIEW_INSTALL_STALLED', 'PREVIEW_INSTALL_STALLED: instalação sem atividade por tempo excessivo.');
          if (installed.timedOut) throw runtimeError('PREVIEW_TIMEOUT', 'A instalação de dependências excedeu o limite de tempo.');
          throw runtimeError('PREVIEW_INSTALL_FAILED', `Falha ao instalar dependências: ${installed.output || 'sem saída'}`);
        }
      }

      assertActiveSession(key, sessionId, signal);
      let lastError: unknown;
      for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
        const port = await findPort();
        const args = startArgs(pm, pkg, framework, port);
        const { command, prefix } = toolCommand(pm);
        const env = sandboxed
          ? ExecutionWorker.sandboxEnvironment(cwd, { PORT: String(port), HOST: '127.0.0.1', FORGE_PROJECT_RUNTIME: '1', FORGE_BROWSER_RUNTIME: '1' })
          : { ...ExecutionWorker.safeEnvironment(), PORT: String(port), HOST: '127.0.0.1', FORGE_PROJECT_RUNTIME: '1' };

        setStage(key, sessionId, 'start', {
          framework,
          packageManager: pm,
          runtimeDir: cwd,
          command: `${pm} ${args.join(' ')}`,
          port,
          url: `http://127.0.0.1:${port}`,
          startedAt: now(),
          output: '',
        });

        const child = spawn(command, [...prefix, ...args], {
          cwd,
          shell: false,
          windowsHide: true,
          detached: process.platform !== 'win32',
          env,
        });
        const current = records.get(key);
        if (!current || current.sessionId !== sessionId) {
          await killProcessTree(child);
          throw runtimeError('PREVIEW_SESSION_SUPERSEDED', 'Esta sessão de preview foi substituída.');
        }
        current.child = child;

        child.stdout.on('data', buffer => {
          const active = records.get(key);
          if (active?.sessionId !== sessionId) return;
          active.output = clip(active.output, buffer);
          active.lastActivityAt = now();
          active.updatedAt = now();
        });
        child.stderr.on('data', buffer => {
          const active = records.get(key);
          if (active?.sessionId !== sessionId) return;
          active.output = clip(active.output, buffer);
          active.lastActivityAt = now();
          active.updatedAt = now();
        });
        child.on('exit', code => {
          const active = records.get(key);
          if (!active || active.sessionId !== sessionId || ['stopping', 'stopped'].includes(active.status)) return;
          if (active.status === 'running') {
            active.status = 'error';
            active.stage = 'failed';
            active.lastError = `Processo encerrado com código ${code}.`;
            active.errorCode = 'PREVIEW_PROCESS_EXIT';
            active.updatedAt = now();
            console.error('FORGE_PREVIEW_FAILED', JSON.stringify({
              projectId: key,
              sessionId,
              stage: 'ready',
              errorCode: active.errorCode,
              message: active.lastError,
            }));
          }
        });

        try {
          setStage(key, sessionId, 'health_check', { child, runtimeDir: cwd });
          await waitForHttp(port, child, () => records.get(key)?.output || '', signal);
          assertActiveSession(key, sessionId, signal);
          const ready = setStage(key, sessionId, 'ready', { child, runtimeDir: cwd, errorCode: undefined, lastError: undefined });
          ready.operation = undefined;
          console.log('FORGE_PREVIEW_READY', JSON.stringify({
            projectId: key,
            sessionId,
            framework,
            packageManager: pm,
            port,
          }));
          return publicRecord(ready);
        } catch (error: any) {
          lastError = error;
          diagnosticOutput = records.get(key)?.output || diagnosticOutput;
          await killProcessTree(child).catch(() => undefined);
          const text = `${diagnosticOutput}\n${String(error?.message || error)}`;
          if (/EADDRINUSE|address already in use/i.test(text) && attempt < PORT_ATTEMPTS - 1) continue;
          throw error;
        }
      }
      throw lastError || runtimeError('PREVIEW_PORT_BUSY', 'Não foi possível reservar uma porta para o runtime.');
    } catch (error: any) {
      const active = records.get(key);
      if (signal.aborted || active?.sessionId !== sessionId || active?.status === 'stopped') {
        return active ? publicRecord(active) : { status: 'stopped', stage: 'idle', updatedAt: now() };
      }

      if (active?.child && !active.child.killed) await killProcessTree(active.child).catch(() => undefined);
      const classified = classifyRuntimeError(error, diagnosticOutput);
      const failed = setStage(key, sessionId, 'failed', {
        framework,
        packageManager: pm,
        runtimeDir: cwd,
        child: undefined,
        operation: undefined,
        lastError: classified.message,
        errorCode: classified.code,
        output: clip(diagnosticOutput, String(error?.message || error)),
      });
      console.error('FORGE_PREVIEW_FAILED', JSON.stringify({
        projectId: key,
        sessionId,
        stage: active?.stage,
        framework,
        packageManager: pm,
        errorCode: classified.code,
        message: classified.message,
        detail: String(error?.message || error).slice(0, 700),
      }));
      return publicRecord(failed);
    }
  }

  static async stop(key: string): Promise<RuntimeInfo> {
    const record = records.get(key);
    if (!record) return { status: 'stopped', stage: 'idle', updatedAt: now() };

    const sessionId = record.sessionId || `preview-${crypto.randomUUID()}`;
    record.controller?.abort();
    setStage(key, sessionId, 'cleanup');

    const child = record.child;
    if (child && !child.killed) await killProcessTree(child).catch(() => undefined);

    const runtimeDir = record.runtimeDir;
    if (runtimeDir && runtimeDir.startsWith(StorageGuard.previewTempRoot())) {
      try {
        await fs.promises.rm(runtimeDir, { recursive: true, force: true });
        console.log('FORGE_PREVIEW_CLEANUP', JSON.stringify({ projectId: key, sessionId, runtimeDir }));
      } catch (error: any) {
        console.warn('FORGE_PREVIEW_CLEANUP_FAILED', JSON.stringify({ projectId: key, sessionId, message: String(error?.message || error) }));
      }
    }

    const stopped: RuntimeRecord = {
      ...record,
      child: undefined,
      operation: undefined,
      controller: undefined,
      status: 'stopped',
      stage: 'idle',
      updatedAt: now(),
      stageStartedAt: now(),
    };
    records.set(key, stopped);
    return publicRecord(stopped);
  }

  static async restart(projectId: string, signal?: AbortSignal) {
    await this.stop(projectId);
    return this.ensure(projectId, signal);
  }

  static proxy(projectId: string, req: http.IncomingMessage, reqPath: string, res: http.ServerResponse) {
    const record = records.get(projectId);
    if (record?.status !== 'running' || !record.port) return false;
    const safePath = reqPath.startsWith('/') ? reqPath : `/${reqPath}`;
    const request = http.request({
      hostname: '127.0.0.1',
      port: record.port,
      path: safePath,
      method: req.method,
      headers: safePreviewHeaders(req.headers),
    }, upstream => {
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
