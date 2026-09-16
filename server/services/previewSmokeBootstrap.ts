import { RuntimeManager } from './runtimeManager.js';
import { WorkspaceManager } from './workspaceManager.js';

export class PreviewSmokeBootstrap {
  static async maybeStartFromEnv() {
    const projectId = String(process.env.FORGE_PREVIEW_SMOKE_PROJECT_ID || '').trim();
    if (!projectId) return;

    await new Promise(resolve => setTimeout(resolve, 800));
    const packageRaw = WorkspaceManager.readFile(projectId, 'package.json');
    let packageInfo: any = null;
    try { packageInfo = packageRaw ? JSON.parse(packageRaw) : null; } catch {}
    const configName = ['vite.config.ts','vite.config.js','vite.config.mts','vite.config.mjs'].find(name => Boolean(WorkspaceManager.readFile(projectId, name)));
    const configText = configName ? WorkspaceManager.readFile(projectId, configName) || '' : '';
    console.log('FORGE_PREVIEW_SMOKE_CONTEXT', JSON.stringify({
      projectId,
      scripts: packageInfo?.scripts || {},
      dependencies: Object.keys(packageInfo?.dependencies || {}),
      devDependencies: Object.keys(packageInfo?.devDependencies || {}),
      configName: configName || null,
      configPreview: configText.slice(0, 6000),
    }));
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
