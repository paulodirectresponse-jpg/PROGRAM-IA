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
import { Phase2RecoveryService } from './server/tooling/phase2RecoveryService.js';
import { BenchmarkService } from './server/benchmark/benchmarkService.js';

dotenv.config();

// Initialize SQLite database and run migrations
initializeDatabase();
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

// Middleware for cookies and parsing JSON with generous size limit
// for project files/diffs
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// CSRF Protection & Token Distribution
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

// Health check endpoint
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    app: 'Forge Agent',
  });
});

// Mount API routes
app.use('/api', apiRouter);

// Vite middleware setup
async function maybeRunPhase4Benchmark() {
  if (process.env.PHASE4_AUTORUN !== 'full') return;
  const userId=String(process.env.PHASE4_AUTORUN_USER_ID||'').trim();
  const maxCostUsd=Number(process.env.PHASE4_AUTORUN_MAX_COST_USD||0.5);
  if(!userId)throw new Error('PHASE4_AUTORUN_USER_ID is required.');
  if(!Number.isFinite(maxCostUsd)||maxCostUsd<0.05||maxCostUsd>1){
    throw new Error('PHASE4_AUTORUN_MAX_COST_USD must be between US$0.05 and US$1.00.');
  }
  const sync=await CloudSyncService.pullDirect(userId);
  if(sync.status!=='synced')throw new Error(`Phase 4 autorun cloud bootstrap failed: ${sync.status}`);
  const preflight=BenchmarkService.preflight(userId,false);
  console.log('PHASE4_AUTORUN_PREFLIGHT',JSON.stringify(preflight));
  if(!preflight.canRun||preflight.baseCandidates.length===0)throw new Error('No BASE_FREE provider available for Phase 4 autorun.');
  const run=BenchmarkService.start({
    userId,
    maxCostUsd,
    confirmRealProviderCosts:true,
    allowExpert:false,
  });
  console.log('PHASE4_AUTORUN_STARTED',JSON.stringify({runId:run?.id||null,totalCases:run?.totalCases||0,maxCostUsd}));
}

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
      },
      appType: 'spa',
    });

    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');

    app.use(express.static(distPath));

    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `Forge Agent full-stack server running on http://0.0.0.0:${PORT}`
    );
    queueMicrotask(()=>{
      void maybeRunPhase4Benchmark().catch(error=>{
        console.error('PHASE4_AUTORUN_ERROR',String(error?.message||error));
      });
    });
  });

  const shutdown = async () => {
    await RuntimeManager.stopAll();

    server.close(() => {
      process.exit(0);
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

startServer();
