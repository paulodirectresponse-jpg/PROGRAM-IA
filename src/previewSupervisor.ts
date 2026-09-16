type PreviewPayload = {
  status?: string;
  message?: string;
  runtime?: { status?: string; errorCode?: string; lastError?: string };
};

type PreviewState = {
  failures: number;
  lastAttemptAt: number;
  rebuilding: boolean;
  lastNetworkAt: number;
  lastResponse?: Response;
};

const supervisedFetch = window.fetch.bind(window);
const states = new Map<string, PreviewState>();
const MAX_AUTOMATIC_RECOVERIES = 2;
const ACTIVE_POLL_MS = 1800;
const BACKOFF_POLL_MS = 4500;
const REBUILD_COOLDOWN_MS = 5000;
const RECOVERABLE = new Set([
  'PREVIEW_PROCESS_EXIT',
  'PREVIEW_PORT_BUSY',
  'PREVIEW_TIMEOUT',
  'PREVIEW_RUNTIME_FAILED',
]);

function projectFromStatus(url: URL): string | null {
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/preview\/status$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function stateFor(projectId: string): PreviewState {
  const current = states.get(projectId);
  if (current) return current;
  const created: PreviewState = { failures: 0, lastAttemptAt: 0, rebuilding: false, lastNetworkAt: 0 };
  states.set(projectId, created);
  return created;
}

function jsonResponse(payload: PreviewPayload, status = 202): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function errorCode(payload: PreviewPayload): string {
  return String(payload.runtime?.errorCode || 'PREVIEW_RUNTIME_FAILED');
}

function shouldRecover(payload: PreviewPayload): boolean {
  const code = errorCode(payload);
  if (code === 'PREVIEW_STORAGE_FULL' || code === 'PREVIEW_TOOL_MISSING' || code === 'PREVIEW_SCRIPT_MISSING' || code === 'PREVIEW_INSTALL_FAILED') return false;
  return RECOVERABLE.has(code) || !payload.runtime?.errorCode;
}

async function startRecovery(projectId: string, state: PreviewState): Promise<void> {
  if (state.rebuilding || state.failures >= MAX_AUTOMATIC_RECOVERIES) return;
  if (Date.now() - state.lastAttemptAt < REBUILD_COOLDOWN_MS) return;
  state.rebuilding = true;
  state.failures += 1;
  state.lastAttemptAt = Date.now();
  try {
    const response = await supervisedFetch(`/api/projects/${encodeURIComponent(projectId)}/preview/rebuild`, { method: 'POST' });
    if (response.ok) {
      state.failures = 0;
      state.lastResponse = undefined;
    }
  } catch {
    // The next status request exposes the stable backend diagnosis.
  } finally {
    state.rebuilding = false;
  }
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  let url: URL;
  try { url = new URL(input instanceof Request ? input.url : String(input), window.location.origin); }
  catch { return supervisedFetch(input, init); }

  const projectId = method === 'GET' && url.origin === window.location.origin ? projectFromStatus(url) : null;
  if (!projectId) return supervisedFetch(input, init);

  const state = stateFor(projectId);
  const pollDelay = state.failures > 0 ? BACKOFF_POLL_MS : ACTIVE_POLL_MS;
  if (state.lastResponse && Date.now() - state.lastNetworkAt < pollDelay) return state.lastResponse.clone();

  try {
    const response = await supervisedFetch(input, init);
    state.lastNetworkAt = Date.now();
    const payload = await response.clone().json().catch(() => ({} as PreviewPayload)) as PreviewPayload;

    if (response.ok && payload.status === 'running') {
      state.failures = 0;
      state.rebuilding = false;
      state.lastResponse = response.clone();
      return response;
    }

    if (response.status === 202 || payload.status === 'loading') {
      state.lastResponse = response.clone();
      return response;
    }

    if ((response.status === 422 || payload.status === 'error') && shouldRecover(payload) && state.failures < MAX_AUTOMATIC_RECOVERIES) {
      void startRecovery(projectId, state);
      const recovery = jsonResponse({
        status: 'loading',
        message: state.failures === 0 ? 'Recuperando o preview automaticamente…' : `Recuperando o preview automaticamente (tentativa ${Math.min(state.failures + 1, MAX_AUTOMATIC_RECOVERIES)}/${MAX_AUTOMATIC_RECOVERIES})…`,
        runtime: payload.runtime,
      });
      state.lastResponse = recovery.clone();
      return recovery;
    }

    state.lastResponse = response.clone();
    return response;
  } catch (error) {
    if (state.lastResponse) return state.lastResponse.clone();
    return jsonResponse({ status: 'loading', message: 'Reconectando ao supervisor do preview…' });
  }
}) as typeof window.fetch;

window.addEventListener('beforeunload', () => states.clear());
