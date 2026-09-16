import { RuntimeManager, type RuntimeInfo } from './runtimeManager.js';

type RecoveryState = {
  attempts: number;
  recovering: boolean;
  lastRecoveryAt: number;
  lastSeenAt: number;
};

const states = new Map<string, RecoveryState>();
const MAX_RECOVERIES = 2;
const RECOVERY_COOLDOWN_MS = 5000;
const HEARTBEAT_MS = 10000;
const IDLE_TTL_MS = 30 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;

const RECOVERABLE = new Set([
  'PREVIEW_PROCESS_EXIT',
  'PREVIEW_PORT_BUSY',
  'PREVIEW_TIMEOUT',
  'PREVIEW_RUNTIME_FAILED',
  'PREVIEW_INSTALL_STALLED',
]);

const NON_RECOVERABLE = new Set([
  'PREVIEW_STORAGE_FULL',
  'PREVIEW_TOOL_MISSING',
  'PREVIEW_SCRIPT_MISSING',
  'PREVIEW_INSTALL_FAILED',
  'PREVIEW_PACKAGE_INVALID',
]);

function stateFor(projectId: string): RecoveryState {
  const existing = states.get(projectId);
  if (existing) return existing;
  const created = { attempts: 0, recovering: false, lastRecoveryAt: 0, lastSeenAt: Date.now() };
  states.set(projectId, created);
  return created;
}

function shouldRecover(runtime: RuntimeInfo | null): boolean {
  if (!runtime || runtime.status !== 'error') return false;
  const code = String(runtime.errorCode || 'PREVIEW_RUNTIME_FAILED');
  if (NON_RECOVERABLE.has(code)) return false;
  return RECOVERABLE.has(code) || !runtime.errorCode;
}

export class PreviewRecoverySupervisor {
  static touch(projectId: string) {
    stateFor(projectId).lastSeenAt = Date.now();
  }

  static reset(projectId: string) {
    states.set(projectId, { attempts: 0, recovering: false, lastRecoveryAt: 0, lastSeenAt: Date.now() });
  }

  static forget(projectId: string) {
    states.delete(projectId);
  }

  static inspect(projectId: string) {
    const state = stateFor(projectId);
    state.lastSeenAt = Date.now();
    const runtime = RuntimeManager.get(projectId);

    if (runtime?.status === 'running') {
      state.attempts = 0;
      state.recovering = false;
      return { runtime, recovering: false, attempts: 0, maxAttempts: MAX_RECOVERIES };
    }

    if (shouldRecover(runtime) && !state.recovering && state.attempts < MAX_RECOVERIES && Date.now() - state.lastRecoveryAt >= RECOVERY_COOLDOWN_MS) {
      void this.recover(projectId);
    }

    return { runtime, recovering: state.recovering, attempts: state.attempts, maxAttempts: MAX_RECOVERIES };
  }

  private static async recover(projectId: string) {
    const state = stateFor(projectId);
    if (state.recovering || state.attempts >= MAX_RECOVERIES) return;
    state.recovering = true;
    state.attempts += 1;
    state.lastRecoveryAt = Date.now();

    console.warn('FORGE_PREVIEW_RECOVERY', JSON.stringify({
      projectId,
      attempt: state.attempts,
      maxAttempts: MAX_RECOVERIES,
      previous: RuntimeManager.get(projectId),
    }));

    try {
      const runtime = await RuntimeManager.recover(projectId);
      if (runtime.status === 'running') {
        state.attempts = 0;
        console.log('FORGE_PREVIEW_RECOVERY_READY', JSON.stringify({ projectId, sessionId: runtime.sessionId }));
      }
    } catch (error: any) {
      console.error('FORGE_PREVIEW_RECOVERY_FAILED', JSON.stringify({
        projectId,
        attempt: state.attempts,
        message: String(error?.message || error),
      }));
    } finally {
      state.recovering = false;
    }
  }

  static start() {
    if (timer) return;
    timer = setInterval(() => {
      const now = Date.now();
      for (const [projectId, state] of states) {
        if (now - state.lastSeenAt > IDLE_TTL_MS) {
          states.delete(projectId);
          void RuntimeManager.stop(projectId).catch(() => undefined);
          continue;
        }
        const runtime = RuntimeManager.get(projectId);
        if (runtime?.status === 'error' && shouldRecover(runtime)) void this.recover(projectId);
      }
    }, HEARTBEAT_MS);
    timer.unref?.();
  }

  static stop() {
    if (timer) clearInterval(timer);
    timer = null;
    states.clear();
  }
}
