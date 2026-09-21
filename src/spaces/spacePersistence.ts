export type SpaceViewport = Record<string, unknown> & { x?: number; y?: number; zoom?: number };
export type SpaceNodeState = Record<string, unknown>;
export type SpaceEdgeState = Record<string, unknown>;

export type PersistedSpace = {
  id: string;
  userId: string;
  projectId: string | null;
  title: string;
  nodes: SpaceNodeState[];
  edges: SpaceEdgeState[];
  viewport: SpaceViewport;
  metadata: Record<string, unknown>;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type SpaceState = Pick<PersistedSpace, 'nodes' | 'edges' | 'viewport' | 'metadata'>;
export type SpaceSaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export class SpaceApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly current?: PersistedSpace,
  ) {
    super(message);
    this.name = 'SpaceApiError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new SpaceApiError(
      body?.message || body?.error || 'Falha ao salvar o Space.',
      response.status,
      body?.error,
      body?.current,
    );
  }
  return body as T;
}

export async function listSpaces() {
  return (await request<{ spaces: Array<Omit<PersistedSpace, 'nodes' | 'edges' | 'viewport'>> }>('/api/spaces')).spaces;
}

export async function createSpace(input: Partial<SpaceState> & { title?: string; projectId?: string | null } = {}) {
  return (await request<{ space: PersistedSpace }>('/api/spaces', {
    method: 'POST',
    body: JSON.stringify(input),
  })).space;
}

export async function loadSpace(spaceId: string) {
  return (await request<{ space: PersistedSpace }>(`/api/spaces/${encodeURIComponent(spaceId)}`)).space;
}

export async function saveSpaceState(
  spaceId: string,
  state: SpaceState,
  baseRevision: number,
  options: { keepalive?: boolean } = {},
) {
  return (await request<{ space: PersistedSpace }>(`/api/spaces/${encodeURIComponent(spaceId)}/state`, {
    method: 'PUT',
    keepalive: options.keepalive,
    body: JSON.stringify({ ...state, baseRevision }),
  })).space;
}

export async function updateSpace(spaceId: string, input: { title?: string; projectId?: string | null; metadata?: Record<string, unknown> }) {
  return (await request<{ space: PersistedSpace }>(`/api/spaces/${encodeURIComponent(spaceId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })).space;
}

export async function deleteSpace(spaceId: string) {
  await request<{ success: true }>(`/api/spaces/${encodeURIComponent(spaceId)}`, { method: 'DELETE' });
}

export class SpaceAutosaveCoordinator {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: SpaceState | null = null;
  private inFlight: Promise<PersistedSpace | null> | null = null;
  private stopped = false;

  constructor(
    private readonly spaceId: string,
    private revision: number,
    private readonly options: {
      debounceMs?: number;
      onStatus?: (status: SpaceSaveStatus) => void;
      onSaved?: (space: PersistedSpace) => void;
      onConflict?: (current?: PersistedSpace) => void;
      onError?: (error: unknown) => void;
    } = {},
  ) {}

  setRevision(revision: number) {
    this.revision = revision;
  }

  schedule(state: SpaceState) {
    if (this.stopped) return;
    this.pending = state;
    this.options.onStatus?.('pending');
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, this.options.debounceMs ?? 600);
  }

  async flush(options: { keepalive?: boolean } = {}): Promise<PersistedSpace | null> {
    if (this.stopped || !this.pending) return this.inFlight ?? null;
    if (this.inFlight) {
      await this.inFlight.catch(() => null);
      if (!this.pending) return null;
    }

    const state = this.pending;
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.options.onStatus?.('saving');

    this.inFlight = saveSpaceState(this.spaceId, state, this.revision, options)
      .then(space => {
        this.revision = space.revision;
        this.options.onStatus?.('saved');
        this.options.onSaved?.(space);
        return space;
      })
      .catch(error => {
        this.options.onStatus?.('error');
        if (error instanceof SpaceApiError && error.status === 409) this.options.onConflict?.(error.current);
        else this.options.onError?.(error);
        throw error;
      })
      .finally(() => { this.inFlight = null; });

    try {
      const saved = await this.inFlight;
      if (this.pending && !this.stopped) queueMicrotask(() => { void this.flush(); });
      return saved;
    } catch {
      return null;
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
