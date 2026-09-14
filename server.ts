import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import { createServer as createViteServer } from 'vite';
import { initializeDatabase } from './server/db/index.js';
import { router as apiRouter } from './server/routes.js';
import { CloudSyncService } from './server/services/cloudSyncService.js';
import { AuthService } from './server/services/authService.js';
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
  const firebaseUid=String(process.env.PHASE4_BENCHMARK_FIREBASE_UID||'').trim();
  const maxCostUsd=Number(process.env.PHASE4_AUTORUN_MAX_COST_USD||0.5);
  if(!firebaseUid)throw new Error('PHASE4_BENCHMARK_FIREBASE_UID is required.');
  const {user}=AuthService.firebaseLogin('phase4-benchmark@local.invalid','Phase 4 Benchmark',firebaseUid,'phase4-autorun','127.0.0.1');
  const userId=user.id;
  if(!Number.isFinite(maxCostUsd)||maxCostUsd<0.05||maxCostUsd>1){
    throw new Error('PHASE4_AUTORUN_MAX_COST_USD must be between US$0.05 and US$1.00.');
  }
  const sync=await CloudSyncService.pullDirect(userId);
  if(sync.status!=='synced')throw new Error(`Phase 4 autorun cloud bootstrap failed: ${sync.status}`);
  const preflight=BenchmarkService.preflight(userId,false);
  console.log('PHASE4_AUTORUN_PREFLIGHT',JSON.stringify(preflight));
  if(!preflight.canRun||preflight.baseCandidates.length===0)throw new Error('No BASE_FREE provider available for Phase 4 autorun.');
  let run=BenchmarkService.start({
    userId,
    maxCostUsd,
    confirmRealProviderCosts:true,
    allowExpert:false,
  });
  if(!run)throw new Error('Phase 4 autorun did not create a benchmark run.');
  console.log('PHASE4_AUTORUN_STARTED',JSON.stringify({runId:run.id,totalCases:run.totalCases,maxCostUsd}));
  const terminal=new Set(['completed','failed','interrupted','cancelled','budget_exhausted']);
  const deadline=Date.now()+45*60*1000;
  while(!terminal.has(run.status)){
    if(Date.now()>deadline){
      BenchmarkService.cancel(run.id,userId);
      throw new Error('Phase 4 autorun exceeded 45 minute deadline.');
    }
    await new Promise(resolve=>setTimeout(resolve,1000));
    const next=BenchmarkService.get(run.id,userId);
    if(!next)throw new Error('Phase 4 autorun benchmark run disappeared.');
    run=next;
  }
  const compactCases=(run.cases||[]).map((item:any)=>({
    caseId:item.caseId,
    category:item.category,
    status:item.status,
    score:item.score,
    passed:item.passed,
    providerReal:item.providerReal,
    profileKey:item.profileKey,
    providerKey:item.providerKey,
    modelId:item.modelId,
    costUsd:item.costUsd,
    attempts:item.attempts,
    repairs:item.repairs,
    expertEscalations:item.expertEscalations,
    validatorStatus:item.validatorStatus,
    browserStatus:item.browserStatus,
    failureReason:item.failureReason,
    failedChecks:Array.isArray(item.evidence?.checks)
      ? item.evidence.checks.filter((check:any)=>check?.passed===false).map((check:any)=>({key:check.key,detail:check.detail||null}))
      : [],
  }));
  const gate=BenchmarkService.releaseGate(run.id,userId);
  console.log('PHASE4_AUTORUN_RESULT',JSON.stringify({
    id:run.id,status:run.status,totalCases:run.totalCases,completedCases:run.completedCases,
    passedCases:run.passedCases,failedCases:run.failedCases,maxCostUsd:run.maxCostUsd,
    spentUsd:run.spentUsd,allowExpert:run.allowExpert,summary:run.summary,
  }));
  console.log('PHASE4_AUTORUN_CASES',JSON.stringify(compactCases));
  console.log('PHASE4_AUTORUN_GATE',JSON.stringify(gate));
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
