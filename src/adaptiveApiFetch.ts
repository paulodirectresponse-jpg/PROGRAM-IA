type CachedResponse = { at: number; response: Response };

const nativeFetch = window.fetch.bind(window);
const cache = new Map<string, CachedResponse>();
const inflight = new Map<string, Promise<Response>>();
let agentRunActive = false;

const ACTIVE_TTL_MS = 650;
const IDLE_TTL_MS = 10_000;

function requestUrl(input: RequestInfo | URL): URL | null {
  try {
    if (input instanceof Request) return new URL(input.url, window.location.origin);
    return new URL(String(input), window.location.origin);
  } catch {
    return null;
  }
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

function isAdaptivePollingPath(url: URL): boolean {
  return url.origin === window.location.origin && (
    url.pathname === '/api/agent-runs' ||
    /^\/api\/conversations\/[^/]+$/.test(url.pathname)
  );
}

function isAgentMutation(url: URL, method: string): boolean {
  return url.origin === window.location.origin && method !== 'GET' && (
    /^\/api\/conversations\/[^/]+\/messages$/.test(url.pathname) ||
    url.pathname.startsWith('/api/agent-runs')
  );
}

function clearPollingCache(): void {
  for (const key of cache.keys()) {
    if (key.includes('/api/agent-runs') || key.includes('/api/conversations/')) cache.delete(key);
  }
}

function observeAgentRuns(response: Response): void {
  response.clone().json().then((payload: any) => {
    const runs = Array.isArray(payload?.runs) ? payload.runs : [];
    agentRunActive = runs.some((run: any) => run?.status === 'running');
    if (agentRunActive) clearPollingCache();
  }).catch(() => {});
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = requestUrl(input);
  const method = requestMethod(input, init);

  if (!url) return nativeFetch(input, init);

  if (isAgentMutation(url, method)) {
    agentRunActive = true;
    clearPollingCache();
    return nativeFetch(input, init);
  }

  if (method !== 'GET' || !isAdaptivePollingPath(url)) return nativeFetch(input, init);

  const key = `${method}:${url.pathname}${url.search}`;
  const ttl = agentRunActive ? ACTIVE_TTL_MS : IDLE_TTL_MS;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < ttl) return cached.response.clone();

  const pending = inflight.get(key);
  if (pending) return (await pending).clone();

  const networkRequest = nativeFetch(input, init).then((response) => {
    if (response.ok) {
      cache.set(key, { at: Date.now(), response: response.clone() });
      if (url.pathname === '/api/agent-runs') observeAgentRuns(response);
    }
    return response;
  }).finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, networkRequest);
  return (await networkRequest).clone();
}) as typeof window.fetch;
