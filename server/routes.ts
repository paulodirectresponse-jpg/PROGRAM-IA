import { IntegrationService, integrationFields } from './services/integrationService.js';
import { verifyFirebaseIdentity } from './services/firebaseIdentity.js';
import express, { Request, Response, NextFunction } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { db } from './db/index.js';
import { AuthService, AuthUser } from './services/authService.js';
import { SecretService } from './services/secretService.js';
import { WorkspaceManager } from './services/workspaceManager.js';
import { LLMAdapterService, AgentMode } from './services/llmAdapter.js';
import { ModelRouter, type ProfileKey } from './services/modelRouter.js';
import { RunService } from './services/runService.js';
import { ValidatorEngine } from './services/validatorEngine.js';
import { AgentEngine, AgentWorkflowEngine } from './agent-engine/agentEngine.js';
import { AGENTS } from './agent-engine/agentRegistry.js';
import { GitHubService } from './services/githubService.js';
import { DesktopService } from './services/desktopService.js';
import { CloudSyncService } from './services/cloudSyncService.js';
import { RuntimeManager } from './services/runtimeManager.js';
import { RequirementLedgerService } from './services/requirementLedgerService.js';

export const router = express.Router();
const activeProjects = new Set<string>();
const activeProjectControllers = new Map<string, AbortController>();

function ensureUserWorkspace(userId: string) {
  const id = `ws-${userId}`;
  const existing = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(id) as { id: string } | undefined;
  if (!existing) {
    db.prepare('INSERT INTO workspaces (id, user_id, name, root_path, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, userId, 'Workspace do usuário', `/workspace/${userId}`, new Date().toISOString());
  }
  return id;
}

function projectResponse(projectId: string, userId: string) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId);
  return { success: true, projectId, project };
}

function upsertRepository(projectId: string, remoteUrl: string, branch: string, visibility = 'private') {
  const existing = db.prepare('SELECT id FROM repositories WHERE project_id = ?').get(projectId) as { id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE repositories SET remote_url = ?, default_branch = ?, visibility = ?, is_connected = 1 WHERE id = ?')
      .run(remoteUrl, branch, visibility, existing.id);
  } else {
    db.prepare('INSERT INTO repositories (id, project_id, remote_url, default_branch, visibility, is_connected, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run(`repo-${crypto.randomUUID()}`, projectId, remoteUrl, branch, visibility, new Date().toISOString());
  }
}

function projectRepositoryContext(projectId: string, legacyProject?: any) {
  const repository = db.prepare(
    'SELECT remote_url, default_branch FROM repositories WHERE project_id = ? AND is_connected = 1 ORDER BY created_at DESC LIMIT 1'
  ).get(projectId) as {remote_url?:string;default_branch?:string}|undefined;
  const currentBranch = db.prepare(
    'SELECT name, head_commit_hash FROM branches WHERE project_id = ? AND is_current = 1 ORDER BY created_at DESC LIMIT 1'
  ).get(projectId) as {name?:string;head_commit_hash?:string}|undefined;
  return {
    repoUrl: repository?.remote_url || legacyProject?.repo_url || '',
    branch: currentBranch?.name || repository?.default_branch || legacyProject?.branch || 'main',
    headSha: currentBranch?.head_commit_hash || null,
  };
}

router.get('/version', (_req, res) => res.json({
  version: process.env.npm_package_version || 'dev',
  sha: process.env.GITHUB_SHA || process.env.RENDER_GIT_COMMIT || process.env.COMMIT_SHA || 'local',
  agentEngineEnabled: process.env.AGENT_ENGINE_ENABLED === 'true',
}));

// Extend Express Request type for authenticated user
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// ==========================================
// AUTHENTICATION & SECURITY MIDDLEWARE
// ==========================================

/**
 * Extracts and validates session from cookies or Authorization header
 */
function sessionAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const token =
    req.cookies?.['forge_session'] ||
    (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.substring(7) : null) ||
    (req.headers['x-session-token'] as string | undefined);

  if (token) {
    const sessionUser = AuthService.validateSession(token);
    if (sessionUser) {
      req.user = sessionUser;
    }
  }

  next();
}

/**
 * Enforces authenticated user
 */
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: 'NÃ£o autenticado. FaÃ§a login para acessar este recurso.' });
  }
  next();
}

/**
 * Validates CSRF token on state-changing requests when cookies are used
 */
function csrfProtection(req: Request, res: Response, next: NextFunction) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const sessionCookie = req.cookies?.['forge_session'];
    // If using cookie-based auth, verify CSRF token
    if (sessionCookie) {
      const csrfCookie = req.cookies?.['forge_csrf'];
      const csrfHeader = req.headers['x-csrf-token'];
      const sameOrigin = req.headers['sec-fetch-site']==='same-origin' && (!req.headers.origin || new URL(req.headers.origin).host===req.headers.host);
      if (!sameOrigin && (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader)) {
        return res.status(403).json({ error: 'Falha de validaÃ§Ã£o CSRF (token invÃ¡lido).' });
      }
    }
  }
  next();
}

/**
 * Verifies that the authenticated user owns the project
 */
function requireProjectOwner(req: Request, res: Response, next: NextFunction) {
  const projectId = req.params.id || req.params.projectId;
  if (!projectId) return next();

  if (!req.user) {
    return res.status(401).json({ error: 'NÃ£o autenticado.' });
  }

  const project = db.prepare('SELECT user_id FROM projects WHERE id = ?').get(projectId) as { user_id?: string } | undefined;
  if (!project) {
    return res.status(404).json({ error: 'Projeto nÃ£o encontrado.' });
  }

  if (project.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Este projeto pertence a outro usuÃ¡rio.' });
  }

  next();
}

// Mount global session parser and CSRF check
router.use(sessionAuthMiddleware);
router.use(csrfProtection);
router.use((req,res,next)=>{res.on('finish',()=>{if(req.user&&['POST','PUT','PATCH','DELETE'].includes(req.method)&&!req.path.startsWith('/sync/'))CloudSyncService.schedule(req.user.id);});next();});

// ==========================================
// 1. AUTHENTICATION ROUTES
// ==========================================

router.post(['/auth/register', '/auth/login'], (_req, res) => {
  res.status(410).json({ error: 'Entre pelo Firebase. O login local foi desativado.' });
});

router.post('/auth/firebase-login', async (req: Request, res: Response) => {
  try {
    const limit = AuthService.checkRateLimit(req.ip || 'unknown');
    if (!limit.allowed) return res.status(429).json({ error: 'Muitas tentativas. Aguarde um minuto.' });
    const identity = await verifyFirebaseIdentity(req.body.idToken);
    const { user, session, legacyUserIds } = AuthService.firebaseLogin(identity.email, identity.name, identity.uid, req.headers['user-agent'], req.ip);

    res.cookie('forge_session', session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    const sync = await CloudSyncService.bootstrap(user.id, legacyUserIds);
    res.json({ success: true, user, sync });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/auth/me', async (req: Request, res: Response) => {
  if (!req.user) {
    return res.json({ authenticated: false, user: null });
  }
  const sync = await CloudSyncService.bootstrap(req.user.id);
  res.json({ authenticated: true, user: req.user, sync });
});

router.post('/auth/logout', (req: Request, res: Response) => {
  const token = req.cookies?.['forge_session'] || (req.headers.authorization?.replace('Bearer ', ''));
  if (token) {
    AuthService.logout(token);
  }
  res.clearCookie('forge_session', { path: '/' });
  res.json({ success: true });
});

router.get('/sync/status',requireAuth,async(req,res)=>{try{if(!CloudSyncService.configured())return res.json({configured:false,status:'not_configured',revision:0});const direct=await CloudSyncService.pullDirect(req.user!.id);res.json({configured:true,status:direct.status,source:direct.status==='synced'?'direct':undefined});}catch(e:any){res.status(502).json({configured:true,status:'error',error:e.message});}});
router.get('/sync/configuration',(_req,res)=>res.json(CloudSyncService.configurationStatus()));
router.post('/sync/push',requireAuth,async(req,res)=>{try{res.json(await CloudSyncService.syncAll(req.user!.id));}catch(e:any){res.status(502).json({status:'error',error:e.message});}});
router.post('/sync/pull',requireAuth,async(req,res)=>{try{res.json(await CloudSyncService.pullDirect(req.user!.id));}catch(e:any){res.status(502).json({status:'error',error:e.message});}});

// ==========================================
// 2. SECRETS & CREDENTIALS API (PER-USER)
// ==========================================

router.get('/integrations', requireAuth, (req, res) => {
  try { res.json({integrations: Object.keys(integrationFields).map(key => IntegrationService.summary(req.user!.id, key))}); }
  catch { res.status(500).json({error:'NÃ£o foi possÃ­vel carregar integraÃ§Ãµes.'}); }
});
router.put('/integrations/:service', requireAuth, (req, res) => {
  try { res.json(IntegrationService.save(req.user!.id, req.params.service, req.body.fields || {})); }
  catch { res.status(400).json({error:'ConfiguraÃ§Ã£o invÃ¡lida. Confira os campos e o JSON da conta de serviÃ§o.'}); }
});
router.post('/integrations/:service/test', requireAuth, async (req, res) => {
  try { res.json(await IntegrationService.test(req.user!.id, req.params.service)); }
  catch (err: any) { res.status(400).json({success:false,error:err.message}); }
});
router.post('/providers/test', requireAuth, async (req, res) => {
  try {
    const {providerKey, baseUrl, modelId, apiKey} = req.body;
    const result = await LLMAdapterService.testConnection({providerKey, baseUrl, modelId, apiKey, userId:req.user!.id});
    const checkedAt = new Date().toISOString();
    db.prepare('UPDATE providers SET connection_status = ?, last_error = ? WHERE user_id = ? AND provider_key = ?')
      .run(result.success?'connected':'error', result.success?null:result.message, req.user!.id, providerKey);
    db.prepare('UPDATE user_secrets SET status=?,last_tested_at=?,last_error=?,updated_at=? WHERE user_id=? AND service_key=?')
      .run(result.success?'connected':'error', checkedAt, result.success?null:result.message, checkedAt, req.user!.id, providerKey);
    res.status(result.success ? 200 : 400).json({...result,last_verified_at:checkedAt});
  } catch (error: any) { res.status(400).json({success:false,status:'request_error',message:String(error?.message||'Falha ao testar o provedor.').slice(0,300)}); }
});
router.get('/model-profiles',requireAuth,(req,res)=>res.json({profiles:ModelRouter.listProfiles(req.user!.id)}));
router.put('/model-profiles/:profileKey/candidates',requireAuth,(req,res)=>{try{res.json({profiles:ModelRouter.saveCandidate(req.user!.id,req.params.profileKey as ProfileKey,req.body)});}catch(e:any){res.status(400).json({error:e.message});}});
router.patch('/model-candidates/:id',requireAuth,(req,res)=>{try{res.json({profiles:ModelRouter.updateCandidate(req.user!.id,req.params.id,req.body)});}catch(e:any){res.status(400).json({error:e.message});}});
router.delete('/model-candidates/:id',requireAuth,(req,res)=>{try{res.json({profiles:ModelRouter.deleteCandidate(req.user!.id,req.params.id)});}catch(e:any){res.status(400).json({error:e.message});}});
router.get('/telemetry/summary',requireAuth,(req,res)=>{const since=String(req.query.since||new Date(Date.now()-2592000000).toISOString());const rows=db.prepare(`SELECT profile_key,provider_key,model_id,COUNT(*) calls,COALESCE(SUM(cost_usd),0) cost_usd,ROUND(AVG(latency_ms)) avg_latency_ms,SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) successes FROM model_invocations WHERE user_id=? AND created_at>=? GROUP BY profile_key,provider_key,model_id`).all(req.user!.id,since);res.json({since,rows});});
router.get('/agents',requireAuth,(req,res)=>{
  const invocationMetrics=db.prepare(`SELECT agent_key,COUNT(*) calls,COALESCE(SUM(cost_usd),0) cost_usd,SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) successes
    FROM model_invocations WHERE user_id=? GROUP BY agent_key`).all(req.user!.id) as any[];
  const executionMetrics=db.prepare(`SELECT s.agent_key,COUNT(*) executions,SUM(CASE WHEN s.status='completed' THEN 1 ELSE 0 END) completed
    FROM agent_steps s JOIN agent_runs r ON r.id=s.run_id WHERE r.user_id=? GROUP BY s.agent_key`).all(req.user!.id) as any[];
  res.json({agents:Object.entries(AGENTS).map(([key,value])=>{
    const inv=invocationMetrics.find(m=>m.agent_key===key)||{calls:0,cost_usd:0,successes:0};
    const exec=executionMetrics.find(m=>m.agent_key===key)||{executions:0,completed:0};
    return {key,label:value.role,profile:value.defaultProfile,tools:value.tools,metrics:{...inv,...exec}};
  })});
});
router.get('/agent-runs',requireAuth,(req,res)=>{
  const projectId=String(req.query.projectId||'');
  const runs=(projectId
    ? db.prepare('SELECT * FROM agent_runs WHERE user_id=? AND project_id=? ORDER BY created_at DESC LIMIT 30').all(req.user!.id,projectId)
    : db.prepare('SELECT * FROM agent_runs WHERE user_id=? ORDER BY created_at DESC LIMIT 30').all(req.user!.id)) as any[];

  for (const run of runs) {
    if (run.status === 'running' && !activeProjects.has(run.project_id)) {
      db.prepare("UPDATE agent_runs SET status='aborted', finished_at=? WHERE id=? AND status='running'")
        .run(new Date().toISOString(), run.id);
      run.status = 'aborted';
    }
  }

  res.json({runs:runs.map(run=>({...run,trace:RunService.trace(run.id)}))});
});

router.get('/secrets', requireAuth, (req: Request, res: Response) => {
  try {
    const secrets = SecretService.listUserSecrets(req.user!.id);
    res.json({ secrets });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/secrets', requireAuth, (req: Request, res: Response) => {
  try {
    const { providerKey, secretValue } = req.body;
    if (!providerKey || !secretValue) {
      return res.status(400).json({ error: 'Provedor e valor da chave sÃ£o obrigatÃ³rios.' });
    }

    SecretService.saveSecret(req.user!.id, providerKey, secretValue);
    const masked = SecretService.maskSecret(secretValue);

    res.json({ success: true, providerKey, masked });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/secrets/:providerKey', requireAuth, (req: Request, res: Response) => {
  try {
    SecretService.deleteSecret(req.user!.id, req.params.providerKey);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. PROJECTS API (USER ISOLATION)
// ==========================================

router.get('/projects', requireAuth, (req: Request, res: Response) => {
  try {
    const projects = db.prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC').all(req.user!.id);
    res.json({ projects });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/projects', requireAuth, async (req: Request, res: Response) => {
  try {
    const { name, description, origin = 'novo', repo_url = '', branch = 'main', initialFiles = {}, zipData = '' } = req.body;
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'O nome do projeto Ã© obrigatÃ³rio.' });
    }

    const projectId = 'proj-' + Date.now();
    const now = new Date().toISOString();
    let effectiveBranch = branch || 'main';
    const userId = req.user!.id;
    const workspaceId = ensureUserWorkspace(userId);

    // 1. GITHUB REPOSITORY IMPORT
    if (origin === 'github') {
      if (!repo_url || repo_url.trim().length === 0) {
        return res.status(400).json({ error: 'URL do repositÃ³rio GitHub Ã© obrigatÃ³ria para importaÃ§Ã£o.' });
      }

      const parsed = GitHubService.parseRepoUrl(repo_url);
      if (!parsed) {
        return res.status(400).json({
          error: 'URL do GitHub invÃ¡lida. Formatos aceitos: https://github.com/usuario/repo ou usuario/repo',
        });
      }

      // Import real files using user's configured GitHub token
      const importResult = await GitHubService.importRepoFiles(parsed.owner, parsed.repo, effectiveBranch, userId);
      if (!importResult.success) {
        return res.status(400).json({
          error: importResult.error || 'Falha ao importar arquivos do repositÃ³rio especificado.',
        });
      }

      effectiveBranch = importResult.branch || effectiveBranch;

      db.prepare(`
        INSERT INTO projects (
          id, user_id, workspace_id, name, description, origin, repo_url, branch, status, provider_id, model_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?, ?)
      `).run(projectId, userId, workspaceId, name.trim(), description || `Importado de ${repo_url}`, origin, repo_url.trim(), effectiveBranch, now, now);

      // GitHub paths are already relative to repository root; never strip a common first directory.
      if (importResult.files) {
        for (const [filePath, content] of Object.entries(importResult.files)) {
          WorkspaceManager.writeFile(projectId, filePath, content);
        }
      }

      if (importResult.binaryFiles) {
        for (const [filePath, buf] of Object.entries(importResult.binaryFiles)) {
          WorkspaceManager.writeBinaryFile(projectId, filePath, buf);
        }
      }

      db.prepare(`
        INSERT INTO branches (id, project_id, name, is_current, head_commit_hash, created_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `).run('br-' + Date.now(), projectId, effectiveBranch, importResult.headSha || null, now);
      upsertRepository(projectId, repo_url.trim(), effectiveBranch);

      const convId = 'conv-' + Date.now();
      db.prepare(`
        INSERT INTO conversations (id, project_id, title, mode, created_at, updated_at)
        VALUES (?, ?, 'Workspace GitHub', 'auto', ?, ?)
      `).run(convId, projectId, now, now);

      db.prepare(`
        INSERT INTO messages (id, conversation_id, sender, content, metadata_json, created_at)
        VALUES (?, ?, 'agent', ?, ?, ?)
      `).run(
        'msg-' + Date.now(),
        convId,
        `RepositÃ³rio **${parsed.owner}/${parsed.repo}** importado com sucesso!\n\nForam carregados **${importResult.filesCount || 0} arquivos** no workspace. Estou pronto para analisar e implementar o que vocÃª precisar.`,
        JSON.stringify({ isWelcome: true, mode: 'auto' }),
        now
      );

      WorkspaceManager.createCheckpoint(projectId, 'ImportaÃ§Ã£o do GitHub', `Importado de ${parsed.owner}/${parsed.repo}`);
      return res.json(projectResponse(projectId, userId));
    }

    // 2. LOCAL / ZIP FILE IMPORT
    if (origin === 'local' && (zipData || (initialFiles && Object.keys(initialFiles).length > 0))) {
      db.prepare(`
        INSERT INTO projects (
          id, user_id, workspace_id, name, description, origin, repo_url, branch, status, provider_id, model_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, '', 'main', 'active', NULL, NULL, ?, ?)
      `).run(projectId, userId, workspaceId, name.trim(), description || 'Importado de arquivo ZIP', origin, now, now);

      let importedCount = 0;
      if (zipData) {
        const encoded = String(zipData);
        if (!/^[A-Za-z0-9+/=]+$/.test(encoded) || encoded.length > 36_000_000) throw new Error('Arquivo ZIP invÃ¡lido ou acima do limite permitido.');
        importedCount = (await WorkspaceManager.importZip(projectId, Buffer.from(encoded, 'base64'))).fileCount;
      } else {
        const normalizedInitialFiles = WorkspaceManager.normalizeImportedFiles(initialFiles as Record<string,string>);
        for (const [filePath, content] of Object.entries(normalizedInitialFiles)) {
          if (typeof content === 'string') WorkspaceManager.writeFile(projectId, filePath, content);
        }
        importedCount = Object.keys(normalizedInitialFiles).length;
      }

      db.prepare(`
        INSERT INTO branches (id, project_id, name, is_current, head_commit_hash, created_at)
        VALUES (?, ?, 'main', 1, NULL, ?)
      `).run('br-' + Date.now(), projectId, now);

      const convId = 'conv-' + Date.now();
      db.prepare(`
        INSERT INTO conversations (id, project_id, title, mode, created_at, updated_at)
        VALUES (?, ?, 'Workspace ZIP', 'auto', ?, ?)
      `).run(convId, projectId, now, now);

      db.prepare(`
        INSERT INTO messages (id, conversation_id, sender, content, metadata_json, created_at)
        VALUES (?, ?, 'agent', ?, ?, ?)
      `).run(
        'msg-' + Date.now(),
        convId,
        `Arquivo **${name}** extraÃ­do com sucesso!\n\nForam criados **${importedCount} arquivos** no workspace.`,
        JSON.stringify({ isWelcome: true, mode: 'auto' }),
        now
      );

      if (!zipData) WorkspaceManager.createCheckpoint(projectId, 'ImportaÃ§Ã£o de Arquivo ZIP', `ExtraÃ§Ã£o de ${importedCount} arquivos`);
      return res.json(projectResponse(projectId, userId));
    }

    // 3. NEW PROJECT FROM SCRATCH
    db.prepare(`
      INSERT INTO projects (
        id, user_id, workspace_id, name, description, origin, repo_url, branch, status, provider_id, model_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'novo', '', 'main', 'active', NULL, NULL, ?, ?)
    `).run(projectId, userId, workspaceId, name.trim(), description || 'Novo projeto Forge Agent', now, now);

    db.prepare(`
      INSERT INTO branches (id, project_id, name, is_current, head_commit_hash, created_at)
      VALUES (?, ?, 'main', 1, NULL, ?)
    `).run('br-' + Date.now(), projectId, now);

    const convId = 'conv-' + Date.now();
    db.prepare(`
      INSERT INTO conversations (id, project_id, title, mode, created_at, updated_at)
      VALUES (?, ?, 'Conversa Principal', 'auto', ?, ?)
    `).run(convId, projectId, now, now);

    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender, content, metadata_json, created_at)
      VALUES (?, ?, 'agent', ?, ?, ?)
    `).run(
      'msg-' + Date.now(),
      convId,
      `Projeto **${name}** pronto!\n\nEstou operando no modo **AutomÃ¡tico**. Diga o que deseja construir, modificar ou entender.`,
      JSON.stringify({ isWelcome: true, mode: 'auto' }),
      now
    );

    const starterTitle = name.replace(/</g, '&lt;');
    const initialHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${starterTitle} â Live Preview</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Plus Jakarta Sans', sans-serif; background-color: #0b0f19; color: #f8fafc; }
  </style>
</head>
<body class="p-6 md:p-8 min-h-screen flex flex-col justify-between">
  <div class="max-w-3xl mx-auto w-full space-y-6">
    <div class="border-b border-slate-800 pb-4">
      <span class="text-xs font-mono text-cyan-400">Sandbox Preview â¢ Forge Agent</span>
      <h1 class="text-2xl font-bold mt-1 text-slate-100">${starterTitle}</h1>
      <p class="text-xs text-slate-400 mt-1">${description || 'Projeto criado com sucesso. Converse com o agente para construir telas e fluxos.'}</p>
    </div>
    <div class="p-6 rounded-xl bg-slate-900/90 border border-slate-800 text-center space-y-3">
      <div class="w-10 h-10 rounded-full bg-cyan-950/80 border border-cyan-700/60 text-cyan-400 mx-auto flex items-center justify-center font-bold">â</div>
      <h2 class="text-base font-semibold text-slate-200">Workspace Pronto para IteraÃ§Ãµes</h2>
      <p class="text-xs text-slate-400 max-w-md mx-auto">
        Envie sua instruÃ§Ã£o no painel ao lado. Seus arquivos serÃ£o atualizados e renderizados aqui em tempo real.
      </p>
    </div>
  </div>
  <footer class="text-center text-xs text-slate-500">Forge Agent Live Preview Sandbox</footer>
</body>
</html>`;

    WorkspaceManager.writeFile(projectId, 'index.html', initialHtml);
    WorkspaceManager.createCheckpoint(projectId, 'CriaÃ§Ã£o do Projeto', 'Setup inicial do workspace');

    res.json(projectResponse(projectId, userId));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/projects/:id', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    const branches = db.prepare('SELECT * FROM branches WHERE project_id = ?').all(req.params.id);
    const checkpoints = db.prepare('SELECT id, title, description, parent_id, created_at FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC').all(req.params.id);
    const verifications = db.prepare('SELECT * FROM verifications WHERE project_id = ? ORDER BY created_at DESC LIMIT 10').all(req.params.id);

    res.json({ project, branches, checkpoints, verifications });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/projects/:id', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  try {
    const projectId = req.params.id;

    // 1. Delete associated messages
    const convs = db.prepare('SELECT id FROM conversations WHERE project_id = ?').all(projectId) as { id: string }[];
    for (const c of convs) {
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(c.id);
    }

    // 2. Delete conversations
    db.prepare('DELETE FROM conversations WHERE project_id = ?').run(projectId);

    // 3. Delete verifications
    db.prepare('DELETE FROM verifications WHERE project_id = ?').run(projectId);

    // 4. Delete checkpoints
    db.prepare('DELETE FROM checkpoints WHERE project_id = ?').run(projectId);

    // 5. Delete branches
    db.prepare('DELETE FROM branches WHERE project_id = ?').run(projectId);

    // 6. Stop runtime and delete physical workspace directory
    void RuntimeManager.stop(projectId);
    WorkspaceManager.deleteProject(projectId);

    // 7. Delete project row from SQLite
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

    res.json({ success: true, message: 'Projeto excluÃ­do com sucesso.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/projects/:id/duplicate', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  try {
    const sourceId = req.params.id;
    const source = db.prepare('SELECT * FROM projects WHERE id = ?').get(sourceId) as any;
    const newId = 'proj-' + Date.now();
    const now = new Date().toISOString();
    const newName = `${source.name} (CÃ³pia)`;

    const workspaceId = ensureUserWorkspace(req.user!.id);

    db.prepare(`
      INSERT INTO projects (
        id, user_id, workspace_id, name, description, origin, repo_url, branch, status, provider_id, model_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(
      newId,
      req.user!.id,
      workspaceId,
      newName,
      source.description,
      source.origin || 'novo',
      source.repo_url || '',
      source.branch || 'main',
      source.provider_id || null,
      source.model_id || null,
      now,
      now
    );

    WorkspaceManager.duplicateProject(sourceId, newId);

    const sourceBranch = db.prepare('SELECT head_commit_hash FROM branches WHERE project_id = ? AND name = ? LIMIT 1').get(sourceId, source.branch || 'main') as {head_commit_hash?:string}|undefined;
    db.prepare(`
      INSERT INTO branches (id, project_id, name, is_current, head_commit_hash, created_at)
      VALUES (?, ?, ?, 1, ?, ?)
    `).run('br-' + Date.now(), newId, source.branch || 'main', sourceBranch?.head_commit_hash || null, now);
    if (source.repo_url) upsertRepository(newId, source.repo_url, source.branch || 'main');

    const convId = 'conv-' + Date.now();
    db.prepare(`
      INSERT INTO conversations (id, project_id, title, mode, created_at, updated_at)
      VALUES (?, ?, 'Workspace Duplicado', 'auto', ?, ?)
    `).run(convId, newId, now, now);

    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender, content, metadata_json, created_at)
      VALUES (?, ?, 'agent', ?, ?, ?)
    `).run(
      'msg-' + Date.now(),
      convId,
      `Projeto **${newName}** duplicado com sucesso!`,
      JSON.stringify({ isWelcome: true, mode: 'auto' }),
      now
    );

    WorkspaceManager.createCheckpoint(newId, 'DuplicaÃ§Ã£o do Projeto', `CÃ³pia criada a partir de ${source.name}`);
    res.json({ success: true, projectId: newId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/projects/:id/export/zip', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as any;
    const zipBuffer = await WorkspaceManager.generateZip(req.params.id);
    const safeName = project.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_') || 'forge_project';

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`);
    res.setHeader('Content-Length', zipBuffer.length);
    res.end(zipBuffer);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. WORKSPACE FILES & CHECKPOINTS
// ==========================================

router.get('/projects/:id/files', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  try {
    const files = WorkspaceManager.getFiles(req.params.id);
    res.json({ files });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/projects/:id/files/content', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: 'ParÃ¢metro path ausente.' });

    if (WorkspaceManager.isBinaryPath(filePath)) {
      const buffer = WorkspaceManager.readBinaryFile(req.params.id, filePath);
      if (buffer === null) return res.status(404).json({ error: 'Arquivo nÃ£o encontrado.' });
      return res.json({ path: filePath, isBinary: true, base64: buffer.toString('base64') });
    }

    const content = WorkspaceManager.readFile(req.params.id, filePath);
    if (content === null) {
      return res.status(404).json({ error: 'Arquivo nÃ£o encontrado.' });
    }
    res.json({ path: filePath, isBinary: false, content });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/projects/:id/files', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) {
      return res.status(400).json({ error: 'Campos path e content sÃ£o obrigatÃ³rios.' });
    }
    WorkspaceManager.writeFile(req.params.id, filePath, content);
    const cpId = WorkspaceManager.createCheckpoint(req.params.id, `EdiÃ§Ã£o manual: ${filePath}`);
    res.json({ success: true, checkpointId: cpId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/projects/:id/checkpoints', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  try {
    const checkpoints = db.prepare('SELECT id, title, description, parent_id, created_at FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC').all(req.params.id);
    res.json({ checkpoints });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/projects/:id/checkpoints', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  try {
    const { title, description } = req.body;
    if (!title || title.trim().length === 0) {
      return res.status(400).json({ error: 'O nome da versÃ£o (o que foi alterado nesta atualizaÃ§Ã£o) Ã© obrigatÃ³rio.' });
    }

    const cpId = WorkspaceManager.createCheckpoint(req.params.id, title.trim(), description?.trim() || '');
    const cp = db.prepare('SELECT id, title, description, parent_id, created_at FROM checkpoints WHERE id = ?').get(cpId);
    res.json({ success: true, checkpoint: cp, message: `VersÃ£o "${title.trim()}" criada com sucesso.` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/projects/:id/checkpoints/rollback-previous', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  try {
    const checkpoints = db.prepare('SELECT id, title, description, created_at FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC LIMIT 2').all(req.params.id) as any[];
    if (checkpoints.length < 2) {
      return res.status(400).json({ error: 'NÃ£o hÃ¡ versÃ£o anterior registrada para restaurar neste projeto.' });
    }

    const previousCheckpoint = checkpoints[1];
    const success = WorkspaceManager.restoreCheckpoint(req.params.id, previousCheckpoint.id);
    if (!success) {
      return res.status(500).json({ error: 'Falha ao restaurar arquivos da versÃ£o anterior.' });
    }

    res.json({
      success: true,
      message: `VersÃ£o anterior "${previousCheckpoint.title}" restaurada com sucesso!`,
      restoredCheckpoint: previousCheckpoint,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/projects/:id/checkpoints/:checkpointId/restore', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  try {
    const success = WorkspaceManager.restoreCheckpoint(req.params.id, req.params.checkpointId);
    if (!success) {
      return res.status(404).json({ error: 'Checkpoint nÃ£o encontrado.' });
    }
    res.json({ success: true, message: 'Checkpoint restaurado com sucesso.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/projects/:id/verifications', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  try {
    const verifications = db.prepare('SELECT * FROM verifications WHERE project_id = ? ORDER BY created_at DESC LIMIT 20').all(req.params.id);
    res.json({ verifications });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 5. CONVERSATIONS & CHAT API
// ==========================================

router.get('/conversations/:projectId', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  try {
    const conversation = db.prepare('SELECT * FROM conversations WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(req.params.projectId) as any;
    if (!conversation) {
      return res.status(404).json({ error: 'Conversa nÃ£o encontrada.' });
    }

    const messages = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversation.id);
    const activePlan = db.prepare('SELECT * FROM plans WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(req.params.projectId);

    res.json({ conversation, messages, activePlan });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/conversations/:projectId/plan/approve', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  const projectId = req.params.projectId;
  if (activeProjects.has(projectId)) {
    return res.status(409).json({ error: 'JÃ¡ hÃ¡ uma execuÃ§Ã£o neste projeto. Aguarde ou cancele antes de aprovar o plano.' });
  }

  activeProjects.add(projectId);
  const controller = new AbortController();
  activeProjectControllers.set(projectId, controller);
  let execution: { runId: string; stepId: string } | null = null;

  const parseStoredList = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
    if (typeof value !== 'string' || !value.trim()) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [String(parsed)];
    } catch {
      return [value];
    }
  };

  try {
    const { planId } = req.body || {};
    if (!planId) return res.status(400).json({ error: 'Identificador do plano Ã© obrigatÃ³rio.' });

    const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND project_id = ?').get(planId, projectId) as any;
    if (!plan) return res.status(404).json({ error: 'Plano nÃ£o encontrado neste projeto.' });
    if (plan.status !== 'draft') {
      return res.status(409).json({ error: `Este plano nÃ£o estÃ¡ mais aguardando aprovaÃ§Ã£o (${plan.status || 'estado invÃ¡lido'}).` });
    }

    const conversation = db.prepare('SELECT * FROM conversations WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(projectId) as any;
    if (!conversation) return res.status(404).json({ error: 'Conversa nÃ£o encontrada.' });

    const providerConfig = LLMAdapterService.getActiveProviderConfig(req.user!.id);
    if (!providerConfig) {
      return res.status(409).json({ error: 'Selecione e salve um provedor de IA antes de construir o plano.' });
    }

    const legacyFiles = parseStoredList(plan.files_affected_json);
    const existingFilesToModify = parseStoredList(plan.existing_files_json);
    const newFilesToCreate = parseStoredList(plan.new_files_json);
    const filesToDelete = parseStoredList(plan.files_to_delete_json);
    const filesAffected = [...new Set([...existingFilesToModify,...newFilesToCreate,...filesToDelete,...legacyFiles])];
    const integrations = parseStoredList(plan.integrations_json);
    const risks = parseStoredList(plan.risks_json);
    const acceptanceCriteria = parseStoredList(plan.acceptance_criteria_json);
    const planRequirements = (()=>{try{return JSON.parse(plan.requirements_json||'[]')}catch{return[]}})();
    const taskGraph = (()=>{try{return JSON.parse(plan.task_graph_json||'[]')}catch{return[]}})();
    const architectureSummary=String(plan.architecture_summary||'').trim();
    const buildPrompt = [
      'O usuário aprovou este plano técnico. Implemente-o agora no workspace atual.',
      '',
      `OBJETIVO:\n${plan.objective || ''}`,
      architectureSummary ? `ARQUITETURA APROVADA:\n${architectureSummary}` : '',
      `ESCOPO INCLUÍDO:\n${plan.scope_in || ''}`,
      `ESCOPO EXCLUÍDO:\n${plan.scope_out || ''}`,
      existingFilesToModify.length ? `ARQUIVOS EXISTENTES A MODIFICAR:\n- ${existingFilesToModify.join('\n- ')}` : '',
      newFilesToCreate.length ? `NOVOS ARQUIVOS A CRIAR:\n- ${newFilesToCreate.join('\n- ')}` : '',
      filesToDelete.length ? `ARQUIVOS A REMOVER:\n- ${filesToDelete.join('\n- ')}` : '',
      planRequirements.length ? `REQUISITOS:\n${planRequirements.map((r:any)=>`- ${r.id}: ${r.title||r.description}`).join('\n')}` : '',
      taskGraph.length ? `GRAFO DE TAREFAS:\n${taskGraph.map((t:any)=>`- ${t.id}: ${t.title} [${(t.requirement_ids||[]).join(', ')}]`).join('\n')}` : '',
      integrations.length ? `INTEGRAÇÕES:\n- ${integrations.join('\n- ')}` : '',
      risks.length ? `RISCOS:\n- ${risks.join('\n- ')}` : '',
      acceptanceCriteria.length ? `CRITÉRIOS DE ACEITE:\n- ${acceptanceCriteria.join('\n- ')}` : '',
      '',
      'Gere uma proposta concreta e multi-arquivo quando a arquitetura exigir. Não aplique nada automaticamente; retorne os arquivos estruturados para revisão do usuário.',
    ].filter(Boolean).join('\n\n');

    const history = db.prepare('SELECT sender, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20')
      .all(conversation.id).reverse() as any[];
    const existingFiles = WorkspaceManager.getAllFilesContent(projectId);
    const agentEngineEnabled = process.env.AGENT_ENGINE_ENABLED === 'true';

    if (agentEngineEnabled) {
      execution = RunService.start(req.user!.id, projectId, conversation.id, 'build', .5);
      RequirementLedgerService.attachRun(projectId,planId,execution.runId);
    }

    let result = !agentEngineEnabled
      ? await LLMAdapterService.buildApprovedPlanReliably({
          projectId,
          providerKey: providerConfig.key,
          modelId: providerConfig.modelId,
          userId: req.user!.id,
          existingFiles,
          requestedFiles: filesAffected,
          objective: String(plan.objective || ''),
          scopeIn: [architectureSummary ? 'ARQUITETURA: '+architectureSummary : '', String(plan.scope_in || '')].filter(Boolean).join('\n\n'),
          scopeOut: String(plan.scope_out || ''),
          acceptanceCriteria,
          signal: controller.signal,
        })
      : await AgentWorkflowEngine.executeWorkflow({
          prompt: buildPrompt,
          mode: 'build',
          projectId,
          existingFiles,
          appliedSkills: [],
          conversationHistory: history,
          userId: req.user!.id,
          runId: execution!.runId,
          stepId: execution!.stepId,
          signal: controller.signal,
          reliableBuild: {
            requestedFiles: filesAffected,
            objective: String(plan.objective || ''),
              scopeIn: [architectureSummary ? 'ARQUITETURA: '+architectureSummary : '', String(plan.scope_in || '')].filter(Boolean).join('\n\n'),
            scopeOut: String(plan.scope_out || ''),
            acceptanceCriteria,
          },
        });

    controller.signal.throwIfAborted();

    const formatRepairAttempted = false;

    if (JSON.stringify(WorkspaceManager.getAllFilesContent(projectId)) !== JSON.stringify(existingFiles)) {
      return res.status(409).json({ error: 'Os arquivos mudaram durante a construÃ§Ã£o. Aprove o plano novamente para usar a versÃ£o atual.' });
    }

    if (result.build?.files?.length && !result.proposal && !result.isDemonstrativeFallback && !result.hasErrors) {
      result.proposal = {
        id: `proposal-${crypto.randomUUID()}`,
        summary: result.build.summary || `ConstruÃ§Ã£o do plano: ${String(plan.objective || '').slice(0, 80)}`,
        requiresConfirmation: true,
        files: result.build.files,
        status: 'pending',
      };
    }

    if (result.hasErrors || result.invalidResponse || !result.proposal?.files?.length) {
      if (execution) RunService.finish(execution.runId, execution.stepId, 'failed');
      return res.status(422).json({
        success: false,
        error: result.errorMessage || result.errorReason || 'O modelo nÃ£o retornou uma proposta de construÃ§Ã£o vÃ¡lida. O plano continua aguardando aprovaÃ§Ã£o.',
      });
    }

    const now = new Date().toISOString();
    const agentMsgId = `msg-agent-${Date.now()}`;
    const metadata = {
      mode: 'build',
      decisionType: result.decisionType,
      providerUsed: result.providerUsed,
      modelUsed: result.modelUsed,
      planId,
      planApproved: true,
      filesAffected: result.build?.files?.map((file) => file.path) || [],
      proposal: result.proposal,
      hasErrors: false,
      runId: execution?.runId,
      executionType: agentEngineEnabled ? 'agent_engine' : 'direct_llm',
      agentKey: agentEngineEnabled ? ((result as any).agentKey || 'PROGRAM') : undefined,
      profileKey: (result as any).profileKey,
      workflow: (result as any).workflow,
      formatRepairAttempted,
      buildDiagnostics: result.diagnostics,
    };

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE plans SET status = 'approved', updated_at = ? WHERE id = ? AND project_id = ? AND status = 'draft'")
        .run(now, planId, projectId);
      db.prepare("UPDATE conversations SET mode = 'build', updated_at = ? WHERE id = ?").run(now, conversation.id);
      db.prepare(`
        INSERT INTO messages (id, conversation_id, sender, content, metadata_json, created_at)
        VALUES (?, ?, 'agent', ?, ?, ?)
      `).run(agentMsgId, conversation.id, result.replyText, JSON.stringify(metadata), now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    if (execution) RunService.waitForApproval(execution.runId);

    res.json({
      success: true,
      plan: { ...plan, status: 'approved', updated_at: now },
      agentMessage: {
        id: agentMsgId,
        conversation_id: conversation.id,
        sender: 'agent',
        content: result.replyText,
        metadata,
        created_at: now,
      },
      build: result.build,
      proposal: result.proposal,
    });
  } catch (err: any) {
    if (execution) {
      RunService.finish(execution.runId, execution.stepId, controller.signal.aborted ? 'aborted' : 'failed');
    }
    if (!res.headersSent && !res.destroyed) {
      const detail = String(err?.message || err || '').trim();
      res.status(controller.signal.aborted ? 499 : 500).json({
        error: controller.signal.aborted
          ? 'Construção cancelada. O plano continua aguardando aprovação.'
          : detail || 'Falha ao aprovar e construir o plano.',
        code: controller.signal.aborted ? 'PLAN_BUILD_ABORTED' : 'PLAN_BUILD_FAILED',
      });
    }
  } finally {
    activeProjects.delete(projectId);
    activeProjectControllers.delete(projectId);
  }
});

router.post('/conversations/:projectId/messages', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  if (activeProjects.has(req.params.projectId)) return res.status(409).json({error:'JÃ¡ hÃ¡ uma execuÃ§Ã£o neste projeto. Aguarde ou cancele antes de enviar outro pedido.'});
  activeProjects.add(req.params.projectId);
  const controller = new AbortController();
  activeProjectControllers.set(req.params.projectId, controller);
  let execution: {runId:string;stepId:string}|null=null;
  try {
    const { content, mode = 'auto', appliedSkills = [] } = req.body;
    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'ConteÃºdo da mensagem obrigatÃ³rio.' });
    }

    const projectId = req.params.projectId;
    const selectedMode = mode as AgentMode;
    const resolvedMode = LLMAdapterService.resolveRequestedMode(content, selectedMode);
    let conv = db.prepare('SELECT * FROM conversations WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(projectId) as any;
    const now = new Date().toISOString();

    if (!conv) {
      const convId = 'conv-' + Date.now();
      db.prepare('INSERT INTO conversations (id, project_id, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        convId,
        projectId,
        'Conversa Principal',
        mode,
        now,
        now
      );
      conv = { id: convId, mode };
    } else {
      db.prepare('UPDATE conversations SET mode = ?, updated_at = ? WHERE id = ?').run(resolvedMode, now, conv.id);
    }
    const agentEngineEnabled = process.env.AGENT_ENGINE_ENABLED === 'true';
    if (agentEngineEnabled) execution=RunService.start(req.user!.id,projectId,conv.id,resolvedMode,.5);

    // Save user message
    const userMsgId = 'msg-user-' + Date.now();
    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender, content, metadata_json, created_at)
      VALUES (?, ?, 'user', ?, ?, ?)
    `).run(userMsgId, conv.id, content, JSON.stringify({ mode: resolvedMode, selectedMode, appliedSkills }), now);

    const history = db.prepare('SELECT sender, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20').all(conv.id).reverse() as any[];
    const existingFiles = WorkspaceManager.getAllFilesContent(projectId);

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    const requestsGitHubPublish=/\b(public(?:ar|a|e)|enviar|sincronizar|push)\b[\s\S]{0,80}\b(github|reposit[oÃ³]rio|remoto)\b|\b(github|reposit[oÃ³]rio|remoto)\b[\s\S]{0,80}\b(public(?:ar|a|e)|enviar|sincronizar|push)\b/i.test(content);
    if(requestsGitHubPublish){
      if (execution) RunService.assignAgent(execution.stepId, 'SHIP');
      const repoContext=projectRepositoryContext(projectId,project);
      if(!repoContext.repoUrl){
        if (execution) RunService.finish(execution.runId, execution.stepId, 'failed');
        return res.status(409).json({error:'Vincule ou crie um repositório na aba Publicar antes de enviar o projeto ao GitHub.'});
      }
      const parsed=GitHubService.parseRepoUrl(repoContext.repoUrl);
      if(!parsed){
        if (execution) RunService.finish(execution.runId, execution.stepId, 'failed');
        return res.status(400).json({error:'A URL do repositório vinculado é inválida.'});
      }

      const binaryFiles:Record<string,Buffer>={};
      for(const file of WorkspaceManager.getFiles(projectId)){
        if(!file.isBinary)continue;
        const bytes=WorkspaceManager.readBinaryFile(projectId,file.path);
        if(bytes)binaryFiles[file.path]=bytes;
      }

      const pushed=await GitHubService.pushFilesToRepo({
        userId:req.user!.id,
        owner:parsed.owner,
        repo:parsed.repo,
        branch:repoContext.branch,
        commitMessage:`Forge Agent: ${content.trim().slice(0,72)}`,
        files:existingFiles,
        binaryFiles,
      });
      if(!pushed.success){
        if (execution) RunService.finish(execution.runId, execution.stepId, 'failed');
        return res.status(400).json({error:pushed.error||'O GitHub recusou a publicação.'});
      }
      if(pushed.commitSha){
        db.prepare('UPDATE branches SET head_commit_hash=? WHERE project_id=? AND name=?')
          .run(pushed.commitSha,projectId,repoContext.branch);
      }

      const agentMsgId='msg-agent-'+Date.now();
      const commitUrl=`https://github.com/${parsed.owner}/${parsed.repo}/commit/${pushed.commitSha}`;
      const replyText=`Publicação concluída no GitHub.\n\nCommit: ${pushed.commitSha}\n${commitUrl}`;
      if (execution) RunService.finish(execution.runId, execution.stepId, 'completed');
      const metadata={
        mode,
        decisionType:'publish',
        providerUsed:'GitHub',
        modelUsed:'ferramenta-direta',
        filesAffected:[...Object.keys(existingFiles),...Object.keys(binaryFiles)],
        runId:execution?.runId,
        executionType:execution?'agent_engine':'direct_tool',
        agentKey:execution?'SHIP':undefined,
        workflow:execution?{runId:execution.runId,status:'completed',steps:[execution.stepId],shipRequested:true,trace:RunService.trace(execution.runId)}:undefined,
        github:{owner:parsed.owner,repo:parsed.repo,branch:repoContext.branch,commitSha:pushed.commitSha,commitUrl}
      };
      db.prepare("INSERT INTO messages (id,conversation_id,sender,content,metadata_json,created_at) VALUES (?,?,'agent',?,?,?)")
        .run(agentMsgId,conv.id,replyText,JSON.stringify(metadata),now);
      return res.json({success:true,agentMessage:{id:agentMsgId,sender:'agent',content:replyText,metadata,created_at:now},github:metadata.github});
    }
    const providerConfig = LLMAdapterService.getActiveProviderConfig(req.user!.id);
    if (!providerConfig) {
      if (execution) RunService.finish(execution.runId, execution.stepId, 'failed');
      return res.status(409).json({error:'Selecione e salve um provedor de IA antes de enviar mensagens.'});
    }
    const providerKey = providerConfig.key;
    const modelId = providerConfig.modelId;

    // Call LLM Adapter with authenticated userId
    let result = !agentEngineEnabled ? await LLMAdapterService.executePrompt({
      prompt: content,
      mode: resolvedMode,
      projectId,
      providerKey,
      modelId,
      existingFiles,
      appliedSkills,
      conversationHistory: history,
      userId: req.user!.id,
      signal: controller.signal,
    }) : await AgentWorkflowEngine.executeWorkflow({prompt:content,mode:resolvedMode,projectId,existingFiles,appliedSkills,conversationHistory:history,userId:req.user!.id,runId:execution!.runId,stepId:execution!.stepId,signal:controller.signal});
    controller.signal.throwIfAborted();

    const effectiveIntent = mode === 'auto' ? LLMAdapterService.classifyIntent(content) : (mode as AgentMode);
    const explicitPlanIntent = /\b(planej|plano|arquitetura|roadmap|especifica[cç][aã]o)\b/i.test(content);

    if (!agentEngineEnabled && mode === 'auto' && explicitPlanIntent && !result.plan && !result.build && !result.hasErrors) {
      result.plan = LLMAdapterService.extractPlan(result.replyText) || {
        objective: content.trim().slice(0, 500),
        scope_in: String(result.replyText || content).trim().slice(0, 2500),
        scope_out: '',
        files_affected: [],
        integrations: [],
        risks: [],
        acceptance_criteria: ['Implementação funcional', 'Validação sem erros críticos'],
      };
      result.decisionType = 'plan';
    }

    const recoverableBuildFailure =
      !agentEngineEnabled &&
      effectiveIntent === 'build' &&
      (
        result.invalidResponse === true ||
        result.errorReason === 'timeout' ||
        (
          result.errorReason === 'provider_error' &&
          /524|context|token|too large|response|upstream/i.test(String(result.errorMessage || result.replyText || ''))
        )
      );

    if (recoverableBuildFailure) {
      result = await LLMAdapterService.buildApprovedPlanReliably({
        projectId,
        providerKey,
        modelId,
        userId: req.user!.id,
        existingFiles,
        requestedFiles: [],
        objective: content,
        acceptanceCriteria: ['Atender integralmente ao pedido do usuário', 'Preservar compatibilidade com o projeto existente'],
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
    }

    if (JSON.stringify(WorkspaceManager.getAllFilesContent(projectId)) !== JSON.stringify(existingFiles)) {
      if (execution) RunService.finish(execution.runId, execution.stepId, 'failed');
      return res.status(409).json({error:'Os arquivos mudaram durante a revisão. Envie novamente para usar a versão atual.'});
    }

    let checkpointCreatedId: string | null = null;
    let rollbackCheckpointId: string | null = null;
    let validation: Awaited<ReturnType<typeof ValidatorEngine.validate>>|null=null;

    // Every code change is a server-owned proposal. The browser receives a copy for review,
    // but approval later resolves the immutable files stored with this message.
    if (result.build?.files?.length && !result.proposal && !result.isDemonstrativeFallback && !result.hasErrors) {
      result.proposal = {
        id: `proposal-${crypto.randomUUID()}`,
        summary: result.build.summary || content.slice(0, 100),
        requiresConfirmation: true,
        files: result.build.files,
        status: 'pending',
      };
    }

    // STRICT SAFETY CHECK:
    // Fallback mode or invalid responses NEVER apply code or create checkpoints!
    const canApplyFiles =
      !result.isDemonstrativeFallback &&
      !result.hasErrors &&
      result.decisionType !== 'invalid_response' &&
      result.decisionType !== 'blocked_no_provider';

    if (canApplyFiles && result.build?.files?.length && (mode === 'build' || mode === 'auto') && !result.proposal) {
      for (const file of result.build.files) WorkspaceManager.resolveSafePath(projectId, file.path);
      rollbackCheckpointId=WorkspaceManager.createCheckpoint(projectId, `Antes: ${content.slice(0, 60)}`, 'Ponto de restauraÃ§Ã£o antes da alteraÃ§Ã£o.');
    }
    if (canApplyFiles) {
      if (mode === 'build' && !result.proposal && result.build?.files && result.build.files.length > 0) {
        for (const file of result.build.files) {
          if (file.action === 'delete') {
            WorkspaceManager.deleteFile(projectId, file.path);
          } else {
            WorkspaceManager.writeFile(projectId, file.path, file.content);
          }
        }
        checkpointCreatedId = WorkspaceManager.createCheckpoint(
          projectId,
          `Build: ${content.slice(0, 30)}...`,
          result.build.summary || 'AlteraÃ§Ãµes validadas e aplicadas no workspace'
        );
      } else if (mode === 'auto' && result.build?.files && !result.proposal) {
        for (const file of result.build.files) {
          if (file.action === 'delete') {
            WorkspaceManager.deleteFile(projectId, file.path);
          } else {
            WorkspaceManager.writeFile(projectId, file.path, file.content);
          }
        }
        checkpointCreatedId = WorkspaceManager.createCheckpoint(
          projectId,
          `Auto: ${content.slice(0, 30)}...`,
          result.build.summary || 'AlteraÃ§Ãµes aplicadas automaticamente'
        );
      }
    }
    if(checkpointCreatedId){
      validation=await ValidatorEngine.validate({projectId,checkpointId:checkpointCreatedId,runId:execution?.runId,stepId:execution?.stepId,signal:controller.signal});
      if(validation.status==='failed'&&rollbackCheckpointId){
        WorkspaceManager.restoreCheckpoint(projectId,rollbackCheckpointId);
        result.hasErrors=true;
        result.errorMessage='A alteraÃ§Ã£o foi revertida automaticamente porque uma verificaÃ§Ã£o real falhou.';
        checkpointCreatedId=null;
      }
    }

    // Save plan if generated
    let savedPlanId: string | null = null;
    if (result.plan) {
      savedPlanId = 'plan-' + Date.now();
      db.prepare(`
        INSERT INTO plans (
          id, task_id, project_id, objective, scope_in, scope_out,
          architecture_summary, existing_files_json, new_files_json, files_to_delete_json,
          files_affected_json, integrations_json, risks_json, acceptance_criteria_json,
          requirements_json, task_graph_json, status, created_at, updated_at
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
      `).run(
        savedPlanId,
        projectId,
        typeof result.plan.objective === 'string' ? result.plan.objective : JSON.stringify(result.plan.objective ?? ''),
        typeof result.plan.scope_in === 'string' ? result.plan.scope_in : JSON.stringify(result.plan.scope_in ?? ''),
        typeof result.plan.scope_out === 'string' ? result.plan.scope_out : JSON.stringify(result.plan.scope_out ?? ''),
        result.plan.architecture_summary || '',
        JSON.stringify(result.plan.existing_files_to_modify || []),
        JSON.stringify(result.plan.new_files_to_create || []),
        JSON.stringify(result.plan.files_to_delete || []),
        JSON.stringify(result.plan.files_affected || []),
        JSON.stringify(result.plan.integrations || []),
        JSON.stringify(result.plan.risks || []),
        JSON.stringify(result.plan.acceptance_criteria || []),
        JSON.stringify(result.plan.requirements || []),
        JSON.stringify(result.plan.task_graph || []),
        now,
        now
      );
      RequirementLedgerService.syncPlan({
        projectId,
        conversationId:conv.id,
        runId:execution?.runId || null,
        planId:savedPlanId,
        requirements:result.plan.requirements || [],
      });
    }

    // Save agent message
    const agentMsgId = 'msg-agent-' + Date.now();
    const metadata = {
      mode,
      appliedSkills,
      isDemonstrativeFallback: result.isDemonstrativeFallback,
      providerUsed: result.providerUsed,
      modelUsed: result.modelUsed,
      planId: savedPlanId,
      checkpointId: checkpointCreatedId,
      filesAffected: result.build?.files?.map((f) => f.path) || result.plan?.files_affected || [],
      decisionType: result.decisionType,
      proposal: result.proposal,
      hasErrors: result.hasErrors,
      invalidResponse: result.invalidResponse,
      errorMessage: result.errorMessage || result.errorReason,
      runId: execution?.runId,
      executionType: agentEngineEnabled ? 'agent_engine' : 'direct_llm',
      agentKey: agentEngineEnabled ? ((result as any).agentKey || 'PROGRAM') : undefined,
      profileKey: (result as any).profileKey,
      workflow: (result as any).workflow,
      validation,
      buildDiagnostics: result.diagnostics,
    };

    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender, content, metadata_json, created_at)
      VALUES (?, ?, 'agent', ?, ?, ?)
    `).run(agentMsgId, conv.id, result.replyText, JSON.stringify(metadata), now);

    if (execution) {
      if (result.proposal?.status === 'pending' && !result.hasErrors) RunService.waitForApproval(execution.runId);
      else RunService.finish(execution.runId,execution.stepId,result.hasErrors?'failed':'completed');
    }
    res.json({
      success: !result.hasErrors && !result.invalidResponse,
      agentMessage: {
        id: agentMsgId,
        sender: 'agent',
        content: result.replyText,
        metadata,
        created_at: now,
      },
      plan: result.plan,
      build: result.build,
      proposal: result.proposal,
      checkpointId: checkpointCreatedId,
      invalidResponse: result.invalidResponse,
    });
  } catch (err: any) {
    if(execution)RunService.finish(execution.runId,execution.stepId,controller.signal.aborted?'aborted':'failed');
    if (!res.destroyed) res.status(500).json({ error: err.message });
  } finally {
    activeProjects.delete(req.params.projectId);
    activeProjectControllers.delete(req.params.projectId);
  }
});

router.post('/conversations/:projectId/abort', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  const projectId = req.params.projectId;
  const controller = activeProjectControllers.get(projectId);
  if (!controller) {
    return res.status(404).json({ success: false, error: 'Nenhuma execução ativa para cancelar neste projeto.' });
  }
  controller.abort(new DOMException('Cancelado explicitamente pelo usuário', 'AbortError'));
  res.json({ success: true });
});

router.post('/agent-runs/:runId/continue', requireAuth, async (req: Request, res: Response) => {
  const run = db.prepare('SELECT * FROM agent_runs WHERE id=? AND user_id=?').get(req.params.runId, req.user!.id) as any;
  if (!run) return res.status(404).json({ error: 'Execução não encontrada.' });
  if (!['failed','aborted'].includes(run.status)) {
    return res.status(409).json({ error: `Esta execução não pode ser continuada no estado atual (${run.status}).` });
  }
  if (!['build','auto'].includes(run.mode)) {
    return res.status(409).json({ error: 'Continuação por etapa está disponível apenas para fluxos de construção.' });
  }
  if (activeProjects.has(run.project_id)) {
    return res.status(409).json({ error: 'Já há uma execução ativa neste projeto.' });
  }

  const trace = RunService.trace(run.id) as any[];
  const scout = [...trace].reverse().find(step => step.agent_key === 'SCOUT' && step.status === 'completed');
  if (!scout?.context?.objective) {
    return res.status(409).json({ error: 'Esta execução não possui contexto persistido suficiente para continuar sem recomeçar.' });
  }
  const studio = [...trace].reverse().find(step => step.agent_key === 'STUDIO' && step.status === 'completed');
  const objective = String(scout.context.objective || '').trim();
  const scoutBrief = String(scout.context.brief || '').trim();
  const studioGuidance = String(studio?.context?.guidance || '').trim();

  activeProjects.add(run.project_id);
  const controller = new AbortController();
  activeProjectControllers.set(run.project_id, controller);
  RunService.resume(run.id);

  try {
    const existingFiles = WorkspaceManager.getAllFilesContent(run.project_id);
    const history = db.prepare('SELECT sender, content FROM messages WHERE conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT 20')
      .all(run.conversation_id).reverse() as any[];
    const forge = RunService.createStep(
      run.id,
      'FORGE',
      'Continuar proposta de código a partir do progresso salvo',
      undefined,
      'local',
      RunService.context('local', {
        objective,
        acceptanceCriteria: ['Continuar sem repetir etapas já concluídas', 'Gerar alteração concreta e revisável'],
        snippets: Object.entries(existingFiles).slice(0,10).map(([file,content])=>({file,content:String(content).slice(0,6000)})),
        previousAttempt: 'SCOUT/STUDIO preservados; retomada iniciada no FORGE.',
        constraints: ['Não refazer SCOUT/STUDIO concluídos', 'Não aplicar definitivamente antes da aprovação'],
      })
    );

    const prompt = [
      objective,
      scoutBrief ? 'BRIEF SALVO DO SCOUT:\n' + scoutBrief : '',
      studioGuidance ? 'CRITÉRIOS SALVOS DO STUDIO:\n' + studioGuidance : '',
      'CONTINUAÇÃO: retome a partir do FORGE. Não repita as etapas já concluídas.',
    ].filter(Boolean).join('\n\n');

    let result = await AgentEngine.execute({
      prompt,
      mode: 'build',
      projectId: run.project_id,
      existingFiles,
      appliedSkills: [],
      conversationHistory: history,
      userId: req.user!.id,
      runId: run.id,
      stepId: forge,
      signal: controller.signal,
    }, { profile: 'BASE_FREE', forcedAgentKey: 'FORGE', allowExpertEscalation: true });

    RunService.finishStep(forge, result.hasErrors ? 'failed' : 'completed', {
      continuedFromRunId: run.id,
      providerUsed: result.providerUsed,
      modelUsed: result.modelUsed,
      profileKey: result.profileKey,
      files: result.build?.files?.map((file:any)=>file.path) || result.proposal?.files?.map((file:any)=>file.path) || [],
    });

    if (result.build?.files?.length && !result.proposal && !result.isDemonstrativeFallback && !result.hasErrors) {
      result.proposal = {
        id: `proposal-${crypto.randomUUID()}`,
        summary: result.build.summary || 'Continuação da construção',
        requiresConfirmation: true,
        files: result.build.files,
        status: 'pending',
      };
    }

    if (result.hasErrors || result.invalidResponse || !result.proposal?.files?.length) {
      const sentinel = RunService.createStep(run.id,'SENTINEL','Diagnosticar falha após continuação',undefined,'micro',
        RunService.context('micro',{objective:'Diagnosticar a falha da continuação',errors:[result.errorMessage || result.errorReason || 'Resposta inválida']}));
      RunService.finishStep(sentinel,'completed');
      RunService.finish(run.id, forge, 'failed');
      return res.status(422).json({ success:false, error: result.errorMessage || result.errorReason || 'A continuação não produziu uma proposta válida.', runId:run.id, trace:RunService.trace(run.id) });
    }

    const sentinel = RunService.createStep(run.id,'SENTINEL','Aguardar aplicação para executar quality gates',undefined,'micro',{
      status:'pending_user_apply', validator:'ValidatorEngine', continued:true,
    });
    RunService.finishStep(sentinel,'completed');
    RunService.waitForApproval(run.id);

    const now = new Date().toISOString();
    const msgId = `msg-agent-${Date.now()}`;
    const metadata = {
      mode:'build',
      decisionType:result.decisionType,
      providerUsed:result.providerUsed,
      modelUsed:result.modelUsed,
      proposal:result.proposal,
      filesAffected:result.proposal.files.map((file:any)=>file.path),
      hasErrors:false,
      runId:run.id,
      executionType:'agent_engine_continuation',
      agentKey:'FORGE',
      profileKey:result.profileKey,
      workflow:{runId:run.id,status:'waiting_approval',steps:RunService.trace(run.id).map((s:any)=>s.id),trace:RunService.trace(run.id),continued:true},
    };
    db.prepare(`INSERT INTO messages(id,conversation_id,sender,content,metadata_json,created_at) VALUES(?,?,'agent',?,?,?)`)
      .run(msgId, run.conversation_id, result.replyText || 'Continuação concluída. Revise a proposta antes de aplicar.', JSON.stringify(metadata), now);

    return res.json({success:true,runId:run.id,proposal:result.proposal,agentMessage:{id:msgId,conversation_id:run.conversation_id,sender:'agent',content:result.replyText || 'Continuação concluída.',metadata,created_at:now},trace:RunService.trace(run.id)});
  } catch (err:any) {
    const lastStep = (RunService.trace(run.id) as any[]).slice(-1)[0];
    if (lastStep?.status === 'running') RunService.finishStep(lastStep.id, controller.signal.aborted ? 'aborted' : 'failed', {error:String(err?.message||err)});
    RunService.finish(run.id, lastStep?.id || '', controller.signal.aborted ? 'aborted' : 'failed');
    return res.status(controller.signal.aborted ? 499 : 500).json({error:controller.signal.aborted?'Continuação cancelada.':String(err?.message||err||'Falha ao continuar a execução.'),runId:run.id,trace:RunService.trace(run.id)});
  } finally {
    activeProjects.delete(run.project_id);
    activeProjectControllers.delete(run.project_id);
  }
});

router.post('/conversations/:projectId/apply-proposal', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  const projectId = req.params.projectId;
  let rollbackCheckpointId: string | null = null;
  let workspaceMutated = false;
  let proposalMessage: any = null;
  let metadata: any = null;

  try {
    const { proposalId, summary = 'Alterações aprovadas pelo usuário' } = req.body;
    if (!proposalId) return res.status(400).json({ error: 'Identificador da proposta é obrigatório.' });

    const conversation = db.prepare('SELECT id FROM conversations WHERE project_id=? ORDER BY created_at DESC LIMIT 1').get(projectId) as any;
    const rows = conversation
      ? db.prepare("SELECT id,metadata_json FROM messages WHERE conversation_id=? AND sender='agent' ORDER BY created_at DESC").all(conversation.id) as any[]
      : [];

    proposalMessage = rows.find((row: any) => {
      try { return JSON.parse(row.metadata_json || '{}')?.proposal?.id === proposalId; }
      catch { return false; }
    });
    if (!proposalMessage) return res.status(404).json({ error: 'Proposta não encontrada nesta conversa.' });

    metadata = JSON.parse(proposalMessage.metadata_json || '{}');
    if (metadata.proposal?.status !== 'pending') {
      return res.status(409).json({ error: `Esta proposta não está mais disponível (${metadata.proposal?.status || 'estado inválido'}).` });
    }

    const files = metadata.proposal.files;
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(409).json({ error: 'A proposta armazenada está vazia ou corrompida.' });
    }

    for (const file of files) {
      WorkspaceManager.resolveSafePath(projectId, file.path);
      if (!['create', 'update', 'delete', 'modify'].includes(file.action)) {
        return res.status(400).json({ error: 'A proposta contém uma ação de arquivo inválida.' });
      }
      if (file.action !== 'delete' && typeof file.content !== 'string') {
        return res.status(400).json({ error: 'A proposta contém arquivo sem conteúdo válido.' });
      }
    }

    rollbackCheckpointId = WorkspaceManager.createCheckpoint(projectId, `Antes: ${summary.slice(0, 60)}`);
    metadata.proposal.status = 'previewing';
    metadata.hasErrors = false;
    delete metadata.errorMessage;
    db.prepare('UPDATE messages SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata), proposalMessage.id);

    workspaceMutated = true;
    for (const file of files) {
      if (file.action === 'delete') WorkspaceManager.deleteFile(projectId, file.path);
      else WorkspaceManager.writeFile(projectId, file.path, file.content);
    }

    const checkpointId = WorkspaceManager.createCheckpoint(projectId, summary.slice(0, 100), summary);
    const workflowRunId = metadata.workflow?.runId || metadata.runId || null;
    if (workflowRunId) RunService.resume(workflowRunId);
    const validationStepId = workflowRunId
      ? RunService.createStep(workflowRunId, 'SENTINEL', 'Executar ValidatorEngine após aplicação', RunService.nextOrderIndex(workflowRunId), 'micro', { proposalId, checkpointId })
      : undefined;

    const validation = await ValidatorEngine.validate({
      projectId,
      checkpointId,
      runId: workflowRunId || undefined,
      stepId: validationStepId,
    });

    if (validationStepId) {
      RunService.finishStep(validationStepId, validation.status === 'failed' ? 'failed' : 'completed', {
        validator: 'ValidatorEngine',
        status: validation.status,
        failedGate: validation.results.find((item: any) => item.status === 'fail')?.tool || null,
        security: validation.security?.status,
      });
    }

    if (validation.status === 'failed') {
      WorkspaceManager.restoreCheckpoint(projectId, rollbackCheckpointId);
      workspaceMutated = false;
      const failedResult = validation.results.find((item: any) => item.status === 'fail');
      const errorOutput = failedResult?.output || validation.security?.issues?.join('; ') || 'Gate executado falhou';
      const affectedFiles = files.map((file: any) => file.path);
      const diagnosis = {
        cause: `Falha no gate ${failedResult?.tool || validation.security?.status || 'validator'}`,
        affectedFiles,
        repairInstruction: 'Corrija somente a falha apontada pelo ValidatorEngine, mantendo o escopo da proposta original.',
        confidence: 0.7,
      };
      const evidenceStepId = workflowRunId
        ? RunService.createStep(workflowRunId, 'SENTINEL', 'Diagnosticar falha real de validação', RunService.nextOrderIndex(workflowRunId), 'micro', RunService.context('micro', {
            objective: 'Identificar a causa concreta desta falha e a menor correção necessária.',
            snippets: [{ failedGate: failedResult?.tool || null, affectedFiles, originalProposal: files.map((file: any) => ({ path: file.path, action: file.action })) }],
            errors: [errorOutput],
            previousAttempt: 'A proposta original foi aplicada, validada, falhou e foi revertida para o checkpoint anterior.',
            constraints: ['Sem revisão genérica', 'Sem carregar projeto inteiro', 'Sem aplicar terceira tentativa automática'],
          }))
        : undefined;
      if (evidenceStepId) RunService.finishStep(evidenceStepId, 'completed', diagnosis);

      if (workflowRunId) {
        let repairStepId: string | null = null;
        let repairRollbackId: string | null = null;
        try {
          repairStepId = RunService.createStep(workflowRunId, 'FORGE', 'Corrigir falha de validação', RunService.nextOrderIndex(workflowRunId), 'micro', RunService.context('micro', {
            objective: metadata.originalRequest || summary,
            snippets: [{ affectedFiles, failedGate: failedResult?.tool || null, diagnosis }],
            diff: files.map((file: any) => ({ path: file.path, action: file.action })),
            errors: [errorOutput],
            previousAttempt: 'Repair automático bounded: única correção automática permitida para esta aprovação.',
            constraints: ['Corrigir somente a falha evidenciada', 'Não ampliar escopo', 'Não tentar terceira correção automática'],
          }));
          const repairResult = await AgentEngine.execute({
            prompt: `${diagnosis.repairInstruction}
Falha concreta: ${errorOutput}`,
            mode: 'build',
            projectId,
            existingFiles: WorkspaceManager.getAllFilesContent(projectId),
            appliedSkills: [],
            conversationHistory: [],
            userId: req.user!.id,
            runId: workflowRunId,
            stepId: repairStepId,
          }, { profile: 'BASE_FREE', forcedAgentKey: 'FORGE', allowExpertEscalation: true, repair: true });
          const repairFiles = repairResult.build?.files || repairResult.proposal?.files || [];
          if (!Array.isArray(repairFiles) || repairFiles.length === 0) throw new Error('Repair não retornou arquivos aplicáveis.');
          for (const file of repairFiles) {
            WorkspaceManager.resolveSafePath(projectId, file.path);
            if (!['create', 'update', 'delete', 'modify'].includes(file.action) || (file.action !== 'delete' && typeof file.content !== 'string')) throw new Error('Repair retornou arquivo inválido.');
          }
          repairRollbackId = WorkspaceManager.createCheckpoint(projectId, `Antes do repair: ${summary.slice(0, 50)}`);
          workspaceMutated = true;
          for (const file of repairFiles) {
            if (file.action === 'delete') WorkspaceManager.deleteFile(projectId, file.path);
            else WorkspaceManager.writeFile(projectId, file.path, file.content);
          }
          const repairCheckpointId = WorkspaceManager.createCheckpoint(projectId, `Repair: ${summary.slice(0, 70)}`, 'Correção automática bounded após falha real do ValidatorEngine.');
          const revalidationStepId = RunService.createStep(workflowRunId, 'SENTINEL', 'Reexecutar ValidatorEngine após repair', RunService.nextOrderIndex(workflowRunId), 'micro', { proposalId, repairCheckpointId });
          const repairValidation = await ValidatorEngine.validate({ projectId, checkpointId: repairCheckpointId, runId: workflowRunId, stepId: revalidationStepId });
          RunService.finishStep(revalidationStepId, repairValidation.status === 'failed' ? 'failed' : 'completed', { validator: 'ValidatorEngine', status: repairValidation.status });
          if (repairValidation.status === 'failed') {
            WorkspaceManager.restoreCheckpoint(projectId, repairRollbackId);
            workspaceMutated = false;
            RunService.finishStep(repairStepId, 'failed', { repair: 'failed', validation: repairValidation });
            RunService.finish(workflowRunId, revalidationStepId, 'failed');
            metadata.proposal.status = 'failed_validation';
            metadata.validation = validation;
            metadata.repair = { attempted: true, status: 'failed', validation: repairValidation, profileKey: repairResult.profileKey };
            metadata.hasErrors = true;
            metadata.errorMessage = 'A proposta e o repair automático falharam na validação; alterações revertidas.';
            if (metadata.workflow) metadata.workflow.trace = RunService.trace(workflowRunId);
            db.prepare('UPDATE messages SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata), proposalMessage.id);
            return res.status(422).json({ error: metadata.errorMessage, validation: repairValidation, repair: metadata.repair });
          }
          workspaceMutated = false;
          RunService.finishStep(repairStepId, 'completed', { repair: 'passed', checkpointId: repairCheckpointId, profileKey: repairResult.profileKey });
          if (metadata.workflow?.shipRequested) {
            const ship = RunService.createStep(workflowRunId, 'SHIP', 'Preparar publicação solicitada após validação', RunService.nextOrderIndex(workflowRunId), 'task', { requested: true, status: 'waiting_for_publish_adapter' });
            RunService.finishStep(ship, 'completed');
          }
          RunService.finish(workflowRunId, repairStepId, 'completed');
          metadata.proposal.status = 'applied';
          metadata.validation = repairValidation;
          metadata.initialValidation = validation;
          metadata.repair = { attempted: true, status: 'passed', checkpointId: repairCheckpointId, profileKey: repairResult.profileKey, files: repairFiles.map((file: any) => file.path) };
          metadata.checkpointId = repairCheckpointId;
          metadata.hasErrors = false;
          if (metadata.workflow) metadata.workflow.trace = RunService.trace(workflowRunId);
          db.prepare('UPDATE messages SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata), proposalMessage.id);
          return res.json({ success: true, checkpointId: repairCheckpointId, validation: repairValidation, repair: metadata.repair, message: 'Alterações aplicadas após repair automático e verificadas com sucesso.' });
        } catch (repairError: any) {
          if (workspaceMutated && repairRollbackId) { try { WorkspaceManager.restoreCheckpoint(projectId, repairRollbackId); } catch {} }
          workspaceMutated = false;
          if (repairStepId) RunService.finishStep(repairStepId, repairError?.name === 'AbortError' ? 'aborted' : 'failed', { error: String(repairError?.message || repairError) });
          RunService.finish(workflowRunId, repairStepId || evidenceStepId || validationStepId || '', repairError?.name === 'AbortError' ? 'aborted' : 'failed');
          metadata.proposal.status = 'failed_validation';
          metadata.validation = validation;
          metadata.repair = { attempted: true, status: repairError?.name === 'AbortError' ? 'aborted' : 'failed', error: String(repairError?.message || repairError) };
          metadata.hasErrors = true;
          metadata.errorMessage = repairError?.name === 'AbortError' ? 'Repair cancelado.' : 'A alteração foi revertida e o repair automático não conseguiu gerar correção válida.';
          if (metadata.workflow) metadata.workflow.trace = RunService.trace(workflowRunId);
          db.prepare('UPDATE messages SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata), proposalMessage.id);
          return res.status(repairError?.name === 'AbortError' ? 499 : 422).json({ error: metadata.errorMessage, validation, repair: metadata.repair });
        }
      }

      metadata.proposal.status = 'failed_validation';
      metadata.validation = validation;
      metadata.hasErrors = true;
      metadata.errorMessage = 'Uma verificação executada falhou; a alteração foi revertida integralmente.';
      if (metadata.workflow && workflowRunId) metadata.workflow.trace = RunService.trace(workflowRunId);
      db.prepare('UPDATE messages SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata), proposalMessage.id);
      return res.status(422).json({ error: metadata.errorMessage, validation });
    }

    if (metadata.workflow?.shipRequested && workflowRunId) {
      const ship = RunService.createStep(workflowRunId, 'SHIP', 'Preparar publicação solicitada após validação', RunService.nextOrderIndex(workflowRunId), 'task', { requested: true, status: 'waiting_for_publish_adapter' });
      RunService.finishStep(ship, 'completed');
    }
    if (workflowRunId) RunService.finish(workflowRunId, validationStepId || '', 'completed');
    metadata.proposal.status = 'applied';
    metadata.validation = validation;
    metadata.checkpointId = checkpointId;
    metadata.hasErrors = false;
    if (metadata.workflow && workflowRunId) metadata.workflow.trace = RunService.trace(workflowRunId);
    db.prepare('UPDATE messages SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata), proposalMessage.id);

    workspaceMutated = false;
    res.json({
      success: true,
      checkpointId,
      validation,
      message: validation.status === 'unverified'
        ? 'Alterações aplicadas. Validação automática não disponível para este projeto.'
        : 'Alterações aplicadas e verificadas com sucesso.',
    });
  } catch (err: any) {
    if (workspaceMutated && rollbackCheckpointId) {
      try { WorkspaceManager.restoreCheckpoint(projectId, rollbackCheckpointId); } catch {}
    }

    if (proposalMessage && metadata?.proposal) {
      try {
        metadata.proposal.status = 'pending';
        metadata.hasErrors = true;
        metadata.errorMessage = 'A aplicação falhou e o workspace foi restaurado. Você pode tentar novamente.';
        db.prepare('UPDATE messages SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata), proposalMessage.id);
      } catch {}
    }

    res.status(500).json({ error: 'A aplicação falhou de forma segura; nenhuma alteração parcial foi mantida.' });
  }
});

// ==========================================
// 6. GITHUB INTEGRATION API
// ==========================================

router.get('/github/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const status = await GitHubService.verifyConnection(req.user!.id);
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/github/repos', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await GitHubService.listUserRepos(req.user!.id);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/github/create-repo', requireAuth, async (req: Request, res: Response) => {
  try {
    const { name, description, isPrivate } = req.body;
    const result = await GitHubService.createRepository({
      userId: req.user!.id,
      name,
      description,
      isPrivate: Boolean(isPrivate),
    });
    res.status(result.success ? 200 : 400).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/projects/:id/github/pull', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    const repoContext = projectRepositoryContext(projectId, project);
    if (!repoContext.repoUrl) return res.status(400).json({ error: 'Projeto não possui URL do GitHub vinculada.' });

    const parsed = GitHubService.parseRepoUrl(repoContext.repoUrl);
    if (!parsed) return res.status(400).json({ error: 'URL do repositório inválida.' });

    const result = await GitHubService.importRepoFiles(parsed.owner, parsed.repo, repoContext.branch, req.user!.id);
    if (!result.success) return res.status(400).json({ error: result.error });

    const remotePaths = new Set((result.remotePaths || []).map(filePath => filePath.replace(/\\/g, '/')));
    if (result.remotePaths) {
      for (const localFile of WorkspaceManager.getFiles(projectId)) {
        if (!remotePaths.has(localFile.path.replace(/\\/g, '/'))) WorkspaceManager.deleteFile(projectId, localFile.path);
      }
    }
    if (result.files) {
      for (const [filePath, content] of Object.entries(result.files)) WorkspaceManager.writeFile(projectId, filePath, content);
    }
    if (result.binaryFiles) {
      for (const [filePath, buf] of Object.entries(result.binaryFiles)) WorkspaceManager.writeBinaryFile(projectId, filePath, buf);
    }
    if (result.headSha) {
      db.prepare('UPDATE branches SET head_commit_hash = ? WHERE project_id = ? AND name = ?')
        .run(result.headSha, projectId, repoContext.branch);
    }

    const cpId = WorkspaceManager.createCheckpoint(
      projectId,
      `Git Pull: ${repoContext.branch}`,
      `Sincronizados ${result.filesCount} arquivos`
    );
    res.json({ success: true, count: result.filesCount, checkpointId: cpId, headSha: result.headSha });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/projects/:id/github/push', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id;
    const { commitMessage, commitDescription } = req.body;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    const repoContext = projectRepositoryContext(projectId, project);
    if (!repoContext.repoUrl) return res.status(400).json({ error: 'Projeto não possui URL do GitHub vinculada.' });

    const parsed = GitHubService.parseRepoUrl(repoContext.repoUrl);
    if (!parsed) return res.status(400).json({ error: 'URL do repositório inválida.' });

    const files = WorkspaceManager.getAllFilesContent(projectId);
    const binaryFiles: Record<string, Buffer> = {};
    for (const file of WorkspaceManager.getFiles(projectId)) {
      if (!file.isBinary) continue;
      const content = WorkspaceManager.readBinaryFile(projectId, file.path);
      if (content) binaryFiles[file.path] = content;
    }

    const result = await GitHubService.pushFilesToRepo({
      userId: req.user!.id,
      owner: parsed.owner,
      repo: parsed.repo,
      branch: repoContext.branch,
      commitMessage: commitMessage || 'Alterações aplicadas via Forge Agent',
      files,
      binaryFiles,
    });
    if (!result.success) return res.status(400).json({ error: result.error });

    if (result.commitSha) {
      db.prepare('UPDATE branches SET head_commit_hash = ? WHERE project_id = ? AND name = ?')
        .run(result.commitSha, projectId, repoContext.branch);
    }

    const cpTitle = commitMessage ? `GitHub Push: ${commitMessage}` : 'GitHub Push: Atualização remota';
    const cpDesc = commitDescription || `Commit ${result.commitSha ? result.commitSha.slice(0, 7) : 'recente'} enviado para branch ${repoContext.branch}`;
    const cpId = WorkspaceManager.createCheckpoint(projectId, cpTitle, cpDesc);

    res.json({ success: true, commitSha: result.commitSha, checkpointId: cpId, branch: repoContext.branch });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/projects/:id/github/status', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as any;
    if (!project) return res.json({ connected: false, message: 'Projeto não encontrado.' });

    const repoContext = projectRepositoryContext(req.params.id, project);
    if (!repoContext.repoUrl) {
      return res.json({ connected: false, message: 'Repositório GitHub não vinculado.' });
    }

    const parsed = GitHubService.parseRepoUrl(repoContext.repoUrl);
    if (!parsed) return res.json({ connected: false, message: 'URL do repositório inválida.' });

    const syncRes = await GitHubService.getSyncStatus({
      userId: req.user!.id,
      projectId: req.params.id,
      owner: parsed.owner,
      repo: parsed.repo,
      branch: repoContext.branch,
      localHeadSha: repoContext.headSha || undefined,
    });

    res.json({
      connected: true,
      repoUrl: repoContext.repoUrl,
      branch: repoContext.branch,
      owner: parsed.owner,
      repo: parsed.repo,
      ...syncRes,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/projects/:id/github/branches', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as any;
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });
    const repoContext = projectRepositoryContext(req.params.id, project);
    if (!repoContext.repoUrl) return res.status(400).json({ error: 'Repositório GitHub não vinculado.' });

    const parsed = GitHubService.parseRepoUrl(repoContext.repoUrl);
    if (!parsed) return res.status(400).json({ error: 'URL do repositório inválida.' });

    const result = await GitHubService.listBranches(parsed.owner, parsed.repo, req.user!.id);
    res.json({ ...result, currentBranch: repoContext.branch });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/projects/:id/github/branch', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  try {
    const { newBranch, fromBranch } = req.body;
    if (!newBranch) return res.status(400).json({ error: 'Nome da nova branch é obrigatório.' });

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as any;
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });
    const repoContext = projectRepositoryContext(req.params.id, project);
    if (!repoContext.repoUrl) return res.status(400).json({ error: 'Repositório GitHub não vinculado.' });

    const parsed = GitHubService.parseRepoUrl(repoContext.repoUrl);
    if (!parsed) return res.status(400).json({ error: 'URL do repositório inválida.' });

    const baseBranch = fromBranch || repoContext.branch;
    const result = await GitHubService.createBranch({
      userId: req.user!.id,
      owner: parsed.owner,
      repo: parsed.repo,
      newBranch: newBranch.trim(),
      fromBranch: baseBranch,
    });
    if (!result.success) return res.status(400).json({ error: result.error });

    const now = new Date().toISOString();
    db.prepare('UPDATE branches SET is_current = 0 WHERE project_id = ?').run(req.params.id);
    const existing = db.prepare('SELECT id FROM branches WHERE project_id=? AND name=?').get(req.params.id,newBranch.trim()) as {id:string}|undefined;
    if (existing) {
      db.prepare('UPDATE branches SET is_current=1,head_commit_hash=? WHERE id=?')
        .run(result.baseSha || null, existing.id);
    } else {
      db.prepare(`
        INSERT INTO branches (id, project_id, name, is_current, head_commit_hash, created_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `).run('br-' + Date.now(), req.params.id, newBranch.trim(), result.baseSha || null, now);
    }

    // Legacy mirror only; branches remains canonical until projects.branch is removed by migration.
    db.prepare('UPDATE projects SET branch = ?, updated_at = ? WHERE id = ?').run(newBranch.trim(), now, req.params.id);
    upsertRepository(req.params.id, repoContext.repoUrl, newBranch.trim());

    res.json({ success: true, branch: newBranch.trim(), baseSha: result.baseSha });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/projects/:id/github/pull-request', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  try {
    const { title, base = 'main', body } = req.body;
    if (!title) return res.status(400).json({ error: 'Título do Pull Request é obrigatório.' });

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as any;
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });
    const repoContext = projectRepositoryContext(req.params.id, project);
    if (!repoContext.repoUrl) return res.status(400).json({ error: 'Repositório GitHub não configurado.' });

    const parsed = GitHubService.parseRepoUrl(repoContext.repoUrl);
    if (!parsed) return res.status(400).json({ error: 'URL do repositório inválida.' });

    const headBranch = repoContext.branch;
    if (headBranch === base) {
      return res.status(400).json({
        error: `A branch atual (${headBranch}) é a mesma que a branch base (${base}). Crie uma nova branch antes de abrir o PR.`,
      });
    }

    const result = await GitHubService.createPullRequest({
      userId: req.user!.id,
      owner: parsed.owner,
      repo: parsed.repo,
      title: title.trim(),
      head: headBranch,
      base: base.trim(),
      body: body || `Criado automaticamente pelo Forge Agent para a branch ${headBranch}`,
    });

    res.status(result.success ? 200 : 400).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/projects/:id/github/connect-repo', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  try {
    const { repoUrl, branch = 'main' } = req.body;
    if (!repoUrl) return res.status(400).json({ error: 'repoUrl é obrigatório.' });

    const parsed = GitHubService.parseRepoUrl(repoUrl);
    if (!parsed) return res.status(400).json({ error: 'URL do GitHub inválida.' });

    const targetBranch = String(branch || 'main').trim();
    const head = await GitHubService.getBranchHead(parsed.owner, parsed.repo, targetBranch, req.user!.id);
    if (!head.success || !head.sha) return res.status(400).json({ error: head.error || 'Não foi possível validar a branch remota.' });

    const now = new Date().toISOString();
    upsertRepository(req.params.id, repoUrl.trim(), targetBranch);
    db.prepare('UPDATE branches SET is_current = 0 WHERE project_id = ?').run(req.params.id);
    const knownBranch = db.prepare('SELECT id FROM branches WHERE project_id = ? AND name = ?')
      .get(req.params.id, targetBranch) as { id: string } | undefined;
    if (knownBranch) {
      db.prepare('UPDATE branches SET is_current = 1, head_commit_hash = ? WHERE id = ?').run(head.sha, knownBranch.id);
    } else {
      db.prepare('INSERT INTO branches (id, project_id, name, is_current, head_commit_hash, created_at) VALUES (?, ?, ?, 1, ?, ?)')
        .run(`br-${crypto.randomUUID()}`, req.params.id, targetBranch, head.sha, now);
    }

    // Temporary mirror for older UI/data migrations; repositories + branches are canonical.
    db.prepare('UPDATE projects SET repo_url = ?, branch = ?, updated_at = ? WHERE id = ?')
      .run(repoUrl.trim(), targetBranch, now, req.params.id);

    res.json({ success: true, repoUrl: repoUrl.trim(), branch: targetBranch, headSha: head.sha });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 7. SKILLS & PROVIDERS API
// ==========================================

router.get('/skills', requireAuth, (req: Request, res: Response) => {
  try {
    const skills = db.prepare(`
      SELECT * FROM skills
      WHERE user_id = ?
      ORDER BY is_custom DESC, name ASC
    `).all(req.user!.id);
    res.json({ skills });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/skills', requireAuth, (req: Request, res: Response) => {
  try {
    const { name, slug, description, system_instructions, scope = 'project', is_active = true } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'O nome da skill Ã© obrigatÃ³rio.' });
    }
    if (!system_instructions || !system_instructions.trim()) {
      return res.status(400).json({ error: 'As instruÃ§Ãµes do sistema para o agente sÃ£o obrigatÃ³rias.' });
    }

    const cleanSlug = (slug || name)
      .toLowerCase()
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9_-]/g, '-');

    const id = 'skill-custom-' + Date.now();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO skills (id, user_id, name, slug, description, system_instructions, scope, is_active, is_custom, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      id,
      req.user!.id,
      name.trim(),
      cleanSlug,
      description?.trim() || '',
      system_instructions.trim(),
      scope,
      is_active ? 1 : 0,
      now
    );

    const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(id);
    res.json({ success: true, skill, message: `Skill personalizada "${name.trim()}" criada com sucesso!` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/skills/:id', requireAuth, (req,res) => {
  const skill=db.prepare('SELECT id FROM skills WHERE id=? AND user_id=?').get(req.params.id,req.user!.id);
  if(!skill)return res.status(404).json({error:'Skill nÃ£o encontrada.'});
  const {name,description,system_instructions,scope}=req.body;
  if(typeof name!=='string'||!name.trim()||typeof system_instructions!=='string'||!system_instructions.trim()||!['message','project','workspace'].includes(scope))return res.status(400).json({error:'Nome, instruÃ§Ãµes e escopo vÃ¡lidos sÃ£o obrigatÃ³rios.'});
  db.prepare('UPDATE skills SET name=?,description=?,system_instructions=?,scope=? WHERE id=? AND user_id=?').run(name.trim(),String(description||''),system_instructions.trim(),scope,req.params.id,req.user!.id);
  res.json({success:true});
});

router.delete('/skills/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params.id) as any;
    if (!skill) return res.status(404).json({ error: 'Skill nÃ£o encontrada.' });
    if (skill.user_id !== req.user!.id) {
      return res.status(403).json({ error: 'Sem permissÃ£o para excluir esta skill.' });
    }

    db.prepare('DELETE FROM skills WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Skill excluÃ­da com sucesso.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/skills/toggle', requireAuth, (req: Request, res: Response) => {
  try {
    const { skillId, isActive } = req.body;
    db.prepare('UPDATE skills SET is_active = ? WHERE id = ? AND user_id = ?').run(isActive ? 1 : 0, skillId, req.user!.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/providers', requireAuth, (req: Request, res: Response) => {
  try {
    const providers = db.prepare(`
      SELECT p.id,p.provider_key,p.name,p.base_url,p.model_id,p.is_configured,p.is_active,p.connection_status,
             p.context_limit,p.created_at,s.last_tested_at,s.last_error AS secret_last_error
      FROM providers p
      LEFT JOIN user_secrets s ON s.user_id=p.user_id AND s.service_key=p.provider_key AND s.is_active=1
      WHERE p.user_id=?
    `).all(req.user!.id) as any[];

    // Synchronize is_configured with user's encrypted secret and include masked hint
    const enriched = providers.map((p) => {
      const userSecret = SecretService.getDecryptedSecret(req.user!.id, p.provider_key);
      const isConfig = Boolean(userSecret && userSecret.trim().length > 0);
      const masked = isConfig ? SecretService.maskSecret(userSecret!) : '';
      return {
        ...p,
        is_configured: isConfig ? 1 : 0,
        connection_status: isConfig ? (p.connection_status || 'configured') : 'not_configured',
        masked_hint: masked,
        last_verified_at: p.last_tested_at || null,
        last_error: p.secret_last_error || null,
      };
    });

    res.json({ providers: enriched });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/providers/save-with-key', requireAuth, async (req: Request, res: Response) => {
  try {
    const { providerKey, baseUrl, modelId, apiKey } = req.body;
    if (!providerKey) return res.status(400).json({ error: 'providerKey obrigatÃ³rio.' });

    let hasKey = false;
    let masked = '';
    if (apiKey && apiKey.trim().length > 0) {
      SecretService.saveSecret(req.user!.id, providerKey, apiKey.trim());
      masked = SecretService.maskSecret(apiKey.trim());
      hasKey = true;
    } else {
      const existing = SecretService.getDecryptedSecret(req.user!.id, providerKey);
      if (existing) {
        masked = SecretService.maskSecret(existing);
        hasKey = true;
      }
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE providers SET is_active = 0 WHERE user_id = ?').run(req.user!.id);
      db.prepare(`
      UPDATE providers
      SET base_url = COALESCE(?, base_url),
          model_id = COALESCE(?, model_id),
          is_configured = ?,
          is_active = ?,
          connection_status = CASE WHEN ? = 1 AND connection_status = 'not_configured' THEN 'untested' WHEN ? = 0 THEN 'not_configured' ELSE connection_status END
      WHERE provider_key = ? AND user_id = ?
    `).run(
      baseUrl || null,
      modelId || null,
      hasKey ? 1 : 0,
      hasKey ? 1 : 0,
      hasKey ? 1 : 0,
      hasKey ? 1 : 0,
      providerKey, req.user!.id
    );
      if (modelId) db.prepare('UPDATE model_candidates SET model_id = ?, updated_at = ? WHERE provider_key = ? AND profile_id IN (SELECT id FROM model_profiles WHERE user_id = ?)').run(modelId, new Date().toISOString(), providerKey, req.user!.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }

    res.json({
      success: true,
      providerKey,
      masked,
      message: 'ConfiguraÃ§Ãµes de IA e chave de API salvas com sucesso!',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/providers/update', requireAuth, (req: Request, res: Response) => {
  try {
    const { providerKey, baseUrl, modelId } = req.body;
    if (!providerKey) return res.status(400).json({ error: 'providerKey obrigatÃ³rio.' });

    db.prepare('UPDATE providers SET base_url = COALESCE(?, base_url), model_id = COALESCE(?, model_id) WHERE provider_key = ? AND user_id = ?').run(
      baseUrl || null,
      modelId || null,
      providerKey, req.user!.id
    );

    res.json({ success: true, message: 'ConfiguraÃ§Ã£o atualizada com sucesso.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 8. DESKTOP & AUTO-UPDATER API
// ==========================================

router.get('/desktop/status', (req: Request, res: Response) => {
  res.json(DesktopService.getStatus());
});

router.post('/desktop/check-updates', async (req: Request, res: Response) => {
  const result = await DesktopService.checkForUpdates();
  res.json(result);
});

router.post('/desktop/command', requireAuth, (_req, res) => {
  res.status(501).json({error:'Executor isolado nÃ£o configurado. Comandos no servidor compartilhado nÃ£o estÃ£o habilitados.'});
});

// ==========================================
// 9. LIVE PREVIEW SANDBOX (PUBLIC SERVING FOR IFRAME)
// ==========================================

router.get('/projects/:projectId/preview/status', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  const staticInfo = WorkspaceManager.getPreviewInfo(req.params.projectId);
  if (staticInfo.status === 'running') return res.json(staticInfo);
  try {
    const runtime = await RuntimeManager.ensure(req.params.projectId);
    if (runtime.status === 'running') return res.json({ status: 'running', entryPath: '', runtime, message: `Runtime ${runtime.framework || 'framework'} ativo em ${runtime.url}.` });
    if (runtime.status === 'static') return res.status(422).json(staticInfo);
    return res.status(runtime.status === 'error' ? 422 : 202).json({ status: runtime.status === 'error' ? 'error' : 'loading', runtime, message: runtime.lastError || `Runtime ${runtime.status}.` });
  } catch (error: any) {
    res.status(422).json({ status: 'error', message: String(error?.message || error) });
  }
});

router.post('/projects/:id/deploy/cloudflare', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  const deploymentId = `deploy-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id) as any;
    const repoContext = projectRepositoryContext(req.params.id, project);
    const cloudflare = IntegrationService.summary(req.user!.id, 'cloudflare');

    if (cloudflare.status !== 'connected') {
      return res.status(409).json({
        success:false,
        error:'Teste e confirme a integração Cloudflare antes de publicar.',
      });
    }
    if (!repoContext.repoUrl) {
      return res.status(409).json({
        success:false,
        error:'O deploy Cloudflare atual dispara um Pages conectado a Git. Vincule um repositório ao projeto antes de publicar.',
      });
    }

    db.prepare('INSERT INTO deployments(id,project_id,target,status,url,error_message,created_at) VALUES(?,?,?,?,NULL,NULL,?)')
      .run(deploymentId, req.params.id, 'cloudflare_pages_git', 'pending', now);

    const result = await IntegrationService.deployCloudflarePages(req.user!.id, repoContext.branch);
    const status = ['success','active'].includes(String(result.status)) ? 'active' : String(result.status || 'pending');
    db.prepare('UPDATE deployments SET status=?,url=?,error_message=NULL WHERE id=?')
      .run(status, result.url || null, deploymentId);

    res.json({...result, deploymentId, mode:'git_trigger'});
  } catch (error:any) {
    const message = String(error?.message || 'Falha no deploy Cloudflare.');
    const existing = db.prepare('SELECT id FROM deployments WHERE id=?').get(deploymentId);
    if (existing) {
      db.prepare("UPDATE deployments SET status='failed',error_message=? WHERE id=?").run(message.slice(0,1000), deploymentId);
    } else {
      db.prepare('INSERT INTO deployments(id,project_id,target,status,url,error_message,created_at) VALUES(?,?,?,?,NULL,?,?)')
        .run(deploymentId, req.params.id, 'cloudflare_pages_git', 'failed', message.slice(0,1000), now);
    }
    res.status(400).json({success:false,error:message,deploymentId});
  }
});


router.post('/projects/:id/deploy/cloudflare/direct', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  const deploymentId = `deploy-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id) as any;
    const repoContext = projectRepositoryContext(req.params.id, project);
    const cloudflare = IntegrationService.summary(req.user!.id, 'cloudflare');
    if (cloudflare.status !== 'connected') {
      return res.status(409).json({success:false,error:'Teste e confirme a integração Cloudflare antes de usar Direct Upload.'});
    }
    db.prepare('INSERT INTO deployments(id,project_id,target,status,url,error_message,created_at) VALUES(?,?,?,?,NULL,NULL,?)')
      .run(deploymentId, req.params.id, 'cloudflare_pages_direct_upload', 'pending', now);
    const result = await IntegrationService.deployCloudflareDirectUpload(req.user!.id, req.params.id, repoContext.branch || 'main');
    db.prepare('UPDATE deployments SET status=?,url=?,error_message=NULL WHERE id=?')
      .run(result.status || 'active', result.url || null, deploymentId);
    res.json({...result, deploymentId, mode:'direct_upload'});
  } catch (error:any) {
    const message = String(error?.message || 'Falha no Direct Upload Cloudflare.');
    const existing = db.prepare('SELECT id FROM deployments WHERE id=?').get(deploymentId);
    if (existing) db.prepare("UPDATE deployments SET status='failed',error_message=? WHERE id=?").run(message.slice(0,1000), deploymentId);
    else db.prepare('INSERT INTO deployments(id,project_id,target,status,url,error_message,created_at) VALUES(?,?,?,?,NULL,?,?)')
      .run(deploymentId, req.params.id, 'cloudflare_pages_direct_upload', 'failed', message.slice(0,1000), now);
    res.status(400).json({success:false,error:message,deploymentId,mode:'direct_upload'});
  }
});

router.post('/conversations/:projectId/reject-proposal', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  const proposalId = String(req.body?.proposalId || '');
  if (!proposalId) return res.status(400).json({ error: 'Identificador da proposta Ã© obrigatÃ³rio.' });
  const conversation = db.prepare('SELECT id FROM conversations WHERE project_id=? ORDER BY created_at DESC LIMIT 1').get(req.params.projectId) as any;
  const rows = conversation ? db.prepare("SELECT id,metadata_json FROM messages WHERE conversation_id=? AND sender='agent' ORDER BY created_at DESC").all(conversation.id) as any[] : [];
  const row = rows.find(item => { try { return JSON.parse(item.metadata_json || '{}')?.proposal?.id === proposalId; } catch { return false; } });
  if (!row) return res.status(404).json({ error: 'Proposta nÃ£o encontrada.' });
  const metadata = JSON.parse(row.metadata_json || '{}');
  if (metadata.proposal.status !== 'pending') return res.status(409).json({ error: 'Esta proposta jÃ¡ foi encerrada.' });
  metadata.proposal.status = 'rejected';
  const workflowRunId = metadata.workflow?.runId || metadata.runId || null;
  if (workflowRunId) {
    const rejectedStep = RunService.createStep(workflowRunId, 'PROGRAM', 'Proposta rejeitada pelo usuário', RunService.nextOrderIndex(workflowRunId), 'task', { proposalId });
    RunService.finishStep(rejectedStep, 'rejected');
    RunService.finish(workflowRunId, rejectedStep, 'rejected');
  }
  db.prepare('UPDATE messages SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata), row.id);
  res.json({ success: true });
});

router.post('/projects/:projectId/preview/rebuild', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  const staticInfo = WorkspaceManager.getPreviewInfo(req.params.projectId);
  if (staticInfo.status === 'running') return res.json(staticInfo);
  const runtime = await RuntimeManager.restart(req.params.projectId);
  if (runtime.status === 'running') return res.json({ status: 'running', entryPath: '', runtime, message: `Runtime ${runtime.framework || 'framework'} reiniciado em ${runtime.url}.` });
  res.status(422).json({ status: 'error', runtime, message: runtime.lastError || 'Não foi possível iniciar o runtime do projeto.' });
});

router.post('/projects/:projectId/runtime/stop', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  res.json(await RuntimeManager.stop(req.params.projectId));
});

function findPendingProposal(projectId:string,proposalId:string){const conversation=db.prepare('SELECT id FROM conversations WHERE project_id=? ORDER BY created_at DESC LIMIT 1').get(projectId) as any;if(!conversation)return null;const rows=db.prepare("SELECT metadata_json FROM messages WHERE conversation_id=? AND sender='agent' ORDER BY created_at DESC").all(conversation.id) as any[];for(const row of rows){try{const proposal=JSON.parse(row.metadata_json||'{}')?.proposal;if(proposal?.id===proposalId&&['pending','previewing'].includes(proposal.status))return proposal;}catch{}}return null;}
router.get('/projects/:projectId/proposals/:proposalId/preview/status',requireAuth,requireProjectOwner,(req,res)=>{const proposal=findPendingProposal(req.params.projectId,req.params.proposalId);if(!proposal)return res.status(404).json({status:'error',message:'Proposta temporÃ¡ria nÃ£o encontrada.'});const entry=proposal.files.find((f:any)=>f.action!=='delete'&&/(^|\/)index\.html$/i.test(f.path))?.path||WorkspaceManager.getPreviewInfo(req.params.projectId).entryPath;if(!entry)return res.status(422).json({status:'error',message:'A proposta nÃ£o possui um arquivo HTML de entrada.'});res.json({status:'running',entryPath:entry,message:'Preview temporÃ¡rio da proposta.'});});
router.get('/preview-proposal/:projectId/:proposalId/*',requireAuth,requireProjectOwner,(req,res)=>{const proposal=findPendingProposal(req.params.projectId,req.params.proposalId);if(!proposal)return res.status(404).send('Proposta temporÃ¡ria nÃ£o encontrada.');const preview=WorkspaceManager.getPreviewInfo(req.params.projectId),requested=path.normalize(req.params[0]||proposal.files.find((f:any)=>/(^|\/)index\.html$/i.test(f.path))?.path||preview.entryPath||'index.html').replace(/^(\.\.[\/\\])+/, '').replace(/\\/g,'/');const proposed=proposal.files.find((f:any)=>f.path.replace(/\\/g,'/')===requested);if(proposed?.action==='delete')return res.status(404).end();res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Content-Security-Policy',"sandbox allow-scripts; default-src 'self' https: data: blob:; script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; connect-src 'self' https: wss:; form-action 'none'");if(proposed){res.type(path.extname(requested)||'text/plain').send(proposed.content);return;}const fallback=WorkspaceManager.resolveSafePath(req.params.projectId,requested);if(!fs.existsSync(fallback)||fs.statSync(fallback).isDirectory())return res.status(404).end();res.sendFile(fallback);});

router.all('/preview/:projectId/*', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  const projectId = req.params.projectId;
  const requestedFile = req.params[0] || '';
  if (RuntimeManager.proxy(projectId, req, req.originalUrl.replace(/^\/api\/preview\/[^/]+/, '') || '/', res)) return;
  const projectDir = WorkspaceManager.getProjectDir(projectId);

  const preview = WorkspaceManager.getPreviewInfo(projectId);
  if (preview.status !== 'running' || !preview.entryPath) return res.status(404).send(preview.message);
  const safeRel = path.normalize(requestedFile || preview.entryPath).replace(/^(\.\.[\/\\])+/, '');
  let filePath = path.join(projectDir, safeRel === 'index.html' || safeRel.replace(/\\/g,'/') === preview.entryPath ? preview.entryPath : path.join(preview.root || '', safeRel));

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(projectDir, preview.entryPath);
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Preview não disponível para este projeto.');
  }

  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (!filePath.startsWith(projectDir + path.sep)) return res.status(403).end();
  res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'self' https: data: blob:; script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; connect-src 'self' https: wss:; form-action 'none'");
  res.sendFile(filePath);
});




