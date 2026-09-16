type PreviewPayload = {
  status?: string;
  stage?: string;
  message?: string;
  runtime?: { status?: string; stage?: string; errorCode?: string; lastError?: string };
};

type PreviewState = {
  lastNetworkAt: number;
  lastResponseAt: number;
  lastStage?: string;
  lastResponse?: Response;
};

const supervisedFetch = window.fetch.bind(window);
const states = new Map<string, PreviewState>();

function projectFromStatus(url: URL): string | null {
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/preview\/status$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function stateFor(projectId: string): PreviewState {
  const current = states.get(projectId);
  if (current) return current;
  const created: PreviewState = { lastNetworkAt: 0, lastResponseAt: 0 };
  states.set(projectId, created);
  return created;
}

function delayFor(stage?: string) {
  if (stage === 'install') return 2200;
  if (stage === 'recovering') return 1800;
  if (stage === 'health_check') return 1000;
  return 900;
}

function loadingResponse(message: string): Response {
  return new Response(JSON.stringify({ status: 'loading', stage: 'reconnecting', message }), {
    status: 202,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  let url: URL;
  try {
    url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
  } catch {
    return supervisedFetch(input, init);
  }

  const projectId = method === 'GET' && url.origin === window.location.origin ? projectFromStatus(url) : null;
  if (!projectId) return supervisedFetch(input, init);

  const state = stateFor(projectId);
  const pollDelay = delayFor(state.lastStage);
  if (state.lastResponse && Date.now() - state.lastNetworkAt < pollDelay) return state.lastResponse.clone();

  try {
    const response = await supervisedFetch(input, init);
    const payload = await response.clone().json().catch(() => ({} as PreviewPayload)) as PreviewPayload;
    state.lastNetworkAt = Date.now();
    state.lastResponseAt = Date.now();
    state.lastStage = payload.stage || payload.runtime?.stage;
    state.lastResponse = response.clone();

    if (response.ok && payload.status === 'running') {
      state.lastStage = 'ready';
    }

    return response;
  } catch {
    if (state.lastResponse && Date.now() - state.lastResponseAt < 8000) return state.lastResponse.clone();
    return loadingResponse('Reconectando ao serviço de preview…');
  }
}) as typeof window.fetch;

window.addEventListener('beforeunload', () => states.clear());
