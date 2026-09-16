import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import { createServer as createViteServer } from 'vite';
import { initializeDatabase } from './server/db/index.js';
import { router as apiRouter } from './server/routes.js';
import { CloudSyncService } from './server/services/cloudSyncService.js';
import { RuntimeManager } from './server/services/runtimeManager.js';
import { WorkspaceManager } from './server/services/workspaceManager.js';
import { StorageGuard } from './server/services/storageGuard.js';
import { Phase2RecoveryService } from './server/tooling/phase2RecoveryService.js';
import { BenchmarkService } from './server/benchmark/benchmarkService.js';
import { BenchmarkSmokeBootstrap } from './server/benchmark/smokeBootstrap.js';
import { ModelRouter } from './server/services/modelRouter.js';
import { PreviewRecoverySupervisor } from './server/services/previewRecoverySupervisor.js';
import { PreviewSmokeBootstrap } from './server/services/previewSmokeBootstrap.js';
import { PreviewRegressionBootstrap } from './server/services/previewRegressionBootstrap.js';

dotenv.config();

// Reclaim only reproducible/derived artifacts before SQLite migrations or
// recovery need to write to the persistent volume. User source files,
// uploads, checkpoints and database state are never touched by this cleanup.
try {
  StorageGuard.startup();
} catch (error) {
  console.error('Storage startup guard failed:', error);
}

// Initialize SQLite database and run migrations
initializeDatabase();
try {
  const repairedBudgetQuarantines=ModelRouter.repairFalseBudgetQuarantines();
  if(repairedBudgetQuarantines>0)console.log('Recovered false budget candidate quarantines:', repairedBudgetQuarantines);
} catch (error) {
  console.error('Budget quarantine recovery failed:', error);
}
try {
  Phase2RecoveryService.recoverStartup();
} catch (error) {
  // Recovery is best-effort. A stale/interrupted sandbox must never prevent
  // the application from booting after a successful schema migration.
  console.error('Phase 2 startup recovery failed:', error);
}

try {
  BenchmarkService.recoverStartup();
} catch (error) {
  console.error('Phase 4 benchmark recovery failed:', error);
}

if (process.env.FORGE_REQUIRE_CLOUD_SYNC === 'true') {
  CloudSyncService.assertPersistentConfiguration();
}

PreviewRecoverySupervisor.start();
const unregisterPreviewInvalidation = WorkspaceManager.onMutation(projectId => {
  RuntimeManager.invalidate(projectId, 'workspace_mutation');
});

const app = express();

// Railway injeta PORT automaticamente.
// Localmente continua usando 3000.
const PORT = Number(process.env.PORT || 3000);

// Security Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, res, next) => {
  let csrfToken = req.cookies?.['forge_csrf'];
  if (!csrfToken) {
    csrfToken = crypto.randomBytes(24).toString('hex');
    res.cookie('forge_csrf', csrfToken, {
      httpOnly: false,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    });
  }
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), app: 'Forge Agent' });
});

app.use('/api', apiRouter);

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Forge Agent full-stack server running on http://0.0.0.0:${PORT}`);
    queueMicrotask(()=>{
      void BenchmarkSmokeBootstrap.maybeStartFromEnv().catch(error=>{
        console.error('Phase 4 server-side smoke bootstrap failed:', error);
      });
      void PreviewSmokeBootstrap.maybeStartFromEnv().catch(error=>{
        console.error('Preview server-side smoke bootstrap failed:', error);
      });
      void PreviewRegressionBootstrap.maybeStartFromEnv().catch(error=>{
        console.error('Preview regression bootstrap failed:', error);
      });
    });
  });

  const shutdown = async () => {
    unregisterPreviewInvalidation();
    PreviewRecoverySupervisor.stop();
    await RuntimeManager.stopAll();
    server.close(() => { process.exit(0); });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

startServer();
