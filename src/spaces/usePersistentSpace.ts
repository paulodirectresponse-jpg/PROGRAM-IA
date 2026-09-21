import { useCallback, useEffect, useRef, useState } from 'react';
import {
  loadSpace,
  SpaceApiError,
  SpaceAutosaveCoordinator,
  type PersistedSpace,
  type SpaceSaveStatus,
  type SpaceState,
} from './spacePersistence';

function cloneState(state: SpaceState): SpaceState {
  if (typeof structuredClone === 'function') return structuredClone(state);
  return JSON.parse(JSON.stringify(state)) as SpaceState;
}

export function usePersistentSpace(spaceId: string | null) {
  const [space, setSpace] = useState<PersistedSpace | null>(null);
  const [status, setStatus] = useState<SpaceSaveStatus>('idle');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<PersistedSpace | null>(null);
  const coordinatorRef = useRef<SpaceAutosaveCoordinator | null>(null);

  const reload = useCallback(async () => {
    if (!spaceId) {
      setSpace(null);
      setStatus('idle');
      setError(null);
      setConflict(null);
      return null;
    }

    setIsLoading(true);
    setError(null);
    try {
      const loaded = await loadSpace(spaceId);
      setSpace(loaded);
      setConflict(null);
      setStatus('saved');
      return loaded;
    } catch (err: any) {
      setError(String(err?.message || 'Não foi possível carregar o Space.'));
      setStatus('error');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [spaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    coordinatorRef.current?.stop();
    coordinatorRef.current = null;
    if (!spaceId || !space) return;

    const coordinator = new SpaceAutosaveCoordinator(spaceId, space.revision, {
      debounceMs: 600,
      onStatus: setStatus,
      onSaved: saved => {
        setSpace(saved);
        setConflict(null);
        setError(null);
      },
      onConflict: current => {
        setConflict(current || null);
        setError('Este Space foi alterado em outra sessão. Recarregue a versão mais recente antes de continuar.');
      },
      onError: err => {
        setError(String((err as any)?.message || 'Falha ao salvar o Space.'));
      },
    });
    coordinatorRef.current = coordinator;

    const flushBeforeLeave = () => {
      void coordinator.flush({ keepalive: true });
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') flushBeforeLeave();
    };

    window.addEventListener('pagehide', flushBeforeLeave);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      flushBeforeLeave();
      window.removeEventListener('pagehide', flushBeforeLeave);
      document.removeEventListener('visibilitychange', handleVisibility);
      coordinator.stop();
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
    };
  }, [spaceId, space?.id]);

  const queueSave = useCallback((next: SpaceState) => {
    const coordinator = coordinatorRef.current;
    if (!coordinator) return;
    coordinator.schedule(cloneState(next));
  }, []);

  const flush = useCallback(async () => {
    return coordinatorRef.current?.flush() ?? null;
  }, []);

  const acceptRemoteConflict = useCallback(() => {
    if (!conflict) return;
    setSpace(conflict);
    coordinatorRef.current?.setRevision(conflict.revision);
    setConflict(null);
    setError(null);
    setStatus('saved');
  }, [conflict]);

  const overwriteConflict = useCallback(async (next: SpaceState) => {
    if (!conflict || !spaceId) return null;
    coordinatorRef.current?.setRevision(conflict.revision);
    coordinatorRef.current?.schedule(cloneState(next));
    const saved = await coordinatorRef.current?.flush();
    if (saved) {
      setConflict(null);
      setError(null);
    }
    return saved ?? null;
  }, [conflict, spaceId]);

  return {
    space,
    status,
    isLoading,
    error,
    conflict,
    queueSave,
    flush,
    reload,
    acceptRemoteConflict,
    overwriteConflict,
  };
}

export function isSpaceConflict(error: unknown): error is SpaceApiError {
  return error instanceof SpaceApiError && error.status === 409;
}
