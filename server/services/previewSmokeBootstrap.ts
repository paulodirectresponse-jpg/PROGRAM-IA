import { RuntimeManager } from './runtimeManager.js';

export class PreviewSmokeBootstrap {
  static async maybeStartFromEnv() {
    const projectId = String(process.env.FORGE_PREVIEW_SMOKE_PROJECT_ID || '').trim();
    if (!projectId) return;

    await new Promise(resolve => setTimeout(resolve, 800));
    const startedAt = Date.now();
    try {
      const runtime = await RuntimeManager.restart(projectId);
      let httpStatus: number | null = null;
      let bodyBytes = 0;

      if (runtime.status === 'running' && runtime.url) {
        const response = await fetch(runtime.url, { signal: AbortSignal.timeout(5000) });
        const body = await response.text();
        httpStatus = response.status;
        bodyBytes = Buffer.byteLength(body);
      }

      const ok = runtime.status === 'running' && Boolean(httpStatus && httpStatus < 500) && bodyBytes > 0;
      const payload = {
        projectId,
        ok,
        elapsedMs: Date.now() - startedAt,
        runtime,
        httpStatus,
        bodyBytes,
      };
      if (ok) console.log('FORGE_PREVIEW_SMOKE_RESULT', JSON.stringify(payload));
      else console.error('FORGE_PREVIEW_SMOKE_RESULT', JSON.stringify(payload));
    } catch (error: any) {
      console.error('FORGE_PREVIEW_SMOKE_RESULT', JSON.stringify({
        projectId,
        ok: false,
        elapsedMs: Date.now() - startedAt,
        error: String(error?.message || error),
      }));
    }
  }
}
