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
import { ContextEngineV2, ContextCommitService, ContextCompiler } from './context-engine/contextEngine.js';
import { ToolRegistry } from './tooling/toolRegistry.js';
import { ToolExecutionService } from './tooling/toolExecutionService.js';
import { ToolExecutionJournal } from './tooling/toolExecutionJournal.js';
import { SandboxManager } from './tooling/sandboxManager.js';
import { BrowserQualityService } from './browser/browserQualityService.js';
import { SandboxProposalApplyService } from './tooling/sandboxProposalApplyService.js';
import { AttachmentService, type IncomingAttachment } from './services/attachmentService.js';

export const router = express.Router();
const activeProjects = new Set<string>();
const activeProjectControllers = new Map<string, AbortController>();

router.use((_req:Request,res:Response,next:NextFunction)=>{
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma','no-cache');
  res.setHeader('Expires','0');
  next();
});

const LEGACY_TEXT_REPLACEMENTS:Array<[RegExp,string]> = [
  [/\u00c3\u00a1/g,'á'],[/\u00c3\u00a0/g,'à'],[/\u00c3\u00a2/g,'â'],[/\u00c3\u00a3/g,'ã'],[/\u00c3\u00a9/g,'é'],[/\u00c3\u00aa/g,'ê'],
  [/\u00c3\u00ad/g,'í'],[/\u00c3\u00b3/g,'ó'],[/\u00c3\u00b4/g,'ô'],[/\u00c3\u00b5/g,'õ'],[/\u00c3\u00ba/g,'ú'],[/\u00c3\u00a7/g,'ç'],
  [/\u00e2\u0080\u0094/g,'—'],[/\u00e2\u0080\u0093/g,'–'],[/\u00e2\u0080\u00a2/g,'•'],[/\u00e2\u009c\u0093/g,'✓'],[/\u00c2\u00b7/g,'·'],
];
function repairLegacyGeneratedText(value:string){
  let next=String(value||'');
  for(const [pattern,replacement] of LEGACY_TEXT_REPLACEMENTS)next=next.replace(pattern,replacement);
  return next;
}
function repairLegacyProjectText(projectId:string){
  const html=WorkspaceManager.readFile(projectId,'index.html');
  if(html&&html.includes('forge-placeholder: preview-only')){
    const fixed=repairLegacyGeneratedText(html);
    if(fixed!==html)WorkspaceManager.writeFile(projectId,'index.html',fixed);
  }
  const conversation=db.prepare('SELECT id FROM conversations WHERE project_id=? ORDER BY created_at DESC LIMIT 1').get(projectId) as any;
  if(!conversation)return;
  const rows=db.prepare("SELECT id,content FROM messages WHERE conversation_id=? AND sender IN ('agent','system')").all(conversation.id) as any[];
  for(const row of rows){
    const fixed=repairLegacyGeneratedText(String(row.content||''));
    if(fixed!==row.content)db.prepare('UPDATE messages SET content=? WHERE id=?').run(fixed,row.id);
  }
}

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


function workflowRequirementIds(projectId: string, runId?: string | null, planId?: string | null): string[] {
  const rows = runId ? RequirementLedgerService.listByRun(runId) : (planId ? RequirementLedgerService.listByPlan(projectId, planId) : []);
  return rows.map(row => row.requirement_key).filter(Boolean);
}

async function materializeProposalInSandbox(input:{
  userId:string;
  projectId:string;
  runId?:string|null;
  stepId?:string|null;
  proposal:any;
  signal?:AbortSignal;
}) {
  if(!input.proposal?.id || !Array.isArray(input.proposal?.files) || !input.proposal.files.length) return input.proposal;
  if(input.proposal.sandboxId) return input.proposal;
  const sandbox=SandboxManager.create({userId:input.userId,projectId:input.projectId,runId:input.runId||null,stepId:input.stepId||null});
  const executionIds:string[]=[];
  for(const file of input.proposal.files){
    const execution=await ToolExecutionService.execute({
      userId:input.userId,projectId:input.projectId,runId:input.runId||null,stepId:input.stepId||null,sandboxId:sandbox.id,signal:input.signal,
    },{
      toolKey:file.action==='delete'?'workspace.delete_file':'workspace.write_file',
      input:file.action==='delete'?{path:file.path}:{path:file.path,content:String(file.content||'')},
      idempotencyKey:`${input.proposal.id}:${file.action}:${file.path}`,
    });
    if(execution.executionId)executionIds.push(execution.executionId);
    if(execution.status!=='succeeded')throw Object.assign(new Error(execution.message||'Falha ao materializar proposta no sandbox.'),{code:execution.errorCode||'sandbox_materialization_failed'});
  }
  const validation=await ValidatorEngine.validate({
    projectId:input.projectId,runId:input.runId||undefined,stepId:input.stepId||undefined,
    signal:input.signal,sandboxId:sandbox.id,userId:input.userId,
  });
  input.proposal.sandboxId=sandbox.id;
  input.proposal.baseRevision=sandbox.baseHash;
  input.proposal.sandboxValidation=validation;
  input.proposal.toolExecutionIds=executionIds;
  return input.proposal;
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
    return res.status(401).json({ error: 'Não autenticado. Faça login para acessar este recurso.' });
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
        return res.status(403).json({ error: 'Falha de validação CSRF (token inválido).' });
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
    return res.status(401).json({ error: 'Não autenticado.' });
  }

  const project = db.prepare('SELECT user_id FROM projects WHERE id = ?').get(projectId) as { user_id?: string } | undefined;
  if (!project) {
    return res.status(404).json({ error: 'Projeto não encontrado.' });
  }

  if (project.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Este projeto pertence a outro usuário.' });
  }

  next();
}

// Mount global session parser and CSRF check
router.use(sessionAuthMiddleware);
router.use(csrfProtection);
router.use((req,res,next)=>{res.on('finish',()=>{const projectDelete=req.method==='DELETE'&&/^\/projects\/[^/]+$/.test(req.path);if(req.user&&['POST','PUT','PATCH','DELETE'].includes(req.method)&&!req.path.startsWith('/sync/')&&!projectDelete)CloudSyncService.schedule(req.user.id);});next();});

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
  catch { res.status(500).json({error:'Não foi possível carregar integrações.'}); }
});
router.put('/integrations/:service', requireAuth, (req, res) => {
  try { res.json(IntegrationService.save(req.user!.id, req.params.service, req.body.fields || {})); }
  catch { res.status(400).json({error:'Configuração inválida. Confira os campos e o JSON da conta de serviço.'}); }
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
      return res.status(400).json({ error: 'Provedor e valor da chave são obrigatórios.' });
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
      return res.status(400).json({ error: 'O nome do projeto é obrigatório.' });
    }

    const projectId = 'proj-' + Date.now();
    const now = new Date().toISOString();
    let effectiveBranch = branch || 'main';
    const userId = req.user!.id;
    const workspaceId = ensureUserWorkspace(userId);

    // 1. GITHUB REPOSITORY IMPORT
    if (origin === 'github') {
      if (!repo_url || repo_url.trim().length === 0) {
        return res.status(400).json({ error: 'URL do repositório GitHub é obrigatória para importação.' });
      }

      const parsed = GitHubService.parseRepoUrl(repo_url);
      if (!parsed) {
        return res.status(400).json({
          error: 'URL do GitHub inválida. Formatos aceitos: https://github.com/usuario/repo ou usuario/repo',
        });
      }

      // Import real files using user's configured GitHub token
      const importResult = await GitHubService.importRepoFiles(parsed.owner, parsed.repo, effectiveBranch, userId);
      if (!importResult.success) {
        return res.status(400).json({
          error: importResult.error || 'Falha ao importar arquivos do repositório especificado.',
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
        `Repositório **${parsed.owner}/${parsed.repo}** importado com sucesso!\n\nForam carregados **${importResult.filesCount || 0} arquivos** no workspace. Estou pronto para analisar e implementar o que você precisar.`,
        JSON.stringify({ isWelcome: true, mode: 'auto' }),
        now
      );

      WorkspaceManager.createCheckpoint(projectId, 'Importação do GitHub', `Importado de ${parsed.owner}/${parsed.repo}`);
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
        if (!/^[A-Za-z0-9+/=]+$/.test(encoded) || encoded.length > 36_000_000) throw new Error('Arquivo ZIP inválido ou acima do limite permitido.');
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
        `Arquivo **${name}** extraído com sucesso!\n\nForam criados **${importedCount} arquivos** no workspace.`,
        JSON.stringify({ isWelcome: true, mode: 'auto' }),
        now
      );

      if (!zipData) WorkspaceManager.createCheckpoint(projectId, 'Importação de Arquivo ZIP', `Extração de ${importedCount} arquivos`);
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
      `Projeto **${name}** pronto!\n\nEstou operando no modo **Automático**. Diga o que deseja construir, modificar ou entender.`,
      JSON.stringify({ isWelcome: true, mode: 'auto' }),
      now
    );

    const starterTitle = name.replace(/</g, '&lt;');
    const initialHtml = `<!DOCTYPE html>
<!-- forge-placeholder: preview-only; this file is NOT the required application architecture -->
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${starterTitle} — Live Preview</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Plus Jakarta Sans', sans-serif; background-color: #0b0f19; color: #f8fafc; }
  </style>
</head>
<body class="p-6 md:p-8 min-h-screen flex flex-col justify-between">
  <div class="max-w-3xl mx-auto w-full space-y-6">
    <div class="border-b border-slate-800 pb-4">
      <span class="text-xs font-mono text-cyan-400">Sandbox Preview • Forge Agent</span>
      <h1 class="text-2xl font-bold mt-1 text-slate-100">${starterTitle}</h1>
      <p class="text-xs text-slate-400 mt-1">${description || 'Projeto criado com sucesso. Converse com o agente para construir telas e fluxos.'}</p>
    </div>
    <div class="p-6 rounded-xl bg-slate-900/90 border border-slate-800 text-center space-y-3">
      <div class="w-10 h-10 rounded-full bg-cyan-950/80 border border-cyan-700/60 text-cyan-400 mx-auto flex items-center justify-center font-bold">✓</div>
      <h2 class="text-base font-semibold text-slate-200">Workspace Pronto para Iterações</h2>
      <p class="text-xs text-slate-400 max-w-md mx-auto">
        Envie sua instrução no painel ao lado. Seus arquivos serão atualizados e renderizados aqui em tempo real.
      </p>
    </div>
  </div>
  <footer class="text-center text-xs text-slate-500">Forge Agent Live Preview Sandbox</footer>
</body>
</html>`;

    WorkspaceManager.writeFile(projectId, 'index.html', initialHtml);
    WorkspaceManager.createCheckpoint(projectId, 'Criação do Projeto', 'Setup inicial do workspace');

    res.json(projectResponse(projectId, userId));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// PHASE 1 — CONTEXT ENGINE V2 CORE API
// ==========================================

router.get('/projects/:projectId/tools', requireAuth, requireProjectOwner, (_req: Request, res: Response) => {
  res.json({ success:true, tools:ToolRegistry.list() });
});

router.post('/projects/:projectId/tools/execute', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  try {
    const result=await ToolExecutionService.execute({
      userId:req.user!.id,
      projectId:req.params.projectId,
      runId:req.body?.runId ? String(req.body.runId) : null,
      stepId:req.body?.stepId ? String(req.body.stepId) : null,
      sandboxId:req.body?.sandboxId ? String(req.body.sandboxId) : null,
    },{
      toolKey:String(req.body?.toolKey || ''),
      input:req.body?.input && typeof req.body.input==='object' ? req.body.input : {},
      idempotencyKey:req.body?.idempotencyKey ? String(req.body.idempotencyKey) : null,
    });
    const status=result.status==='blocked' ? 409 : result.status==='failed' ? 422 : result.status==='aborted' ? 499 : 200;
    res.status(status).json({success:result.status==='succeeded',result});
  } catch (err:any) {
    res.status(500).json({error:String(err?.message || err)});
  }
});

router.get('/projects/:projectId/tool-executions/:runId', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  const rows=ToolExecutionJournal.listByRun(String(req.params.runId || '')).filter(row=>!row.projectId || row.projectId===req.params.projectId);
  res.json({success:true,executions:rows});
});

router.post('/projects/:projectId/context/sync', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId;
    const files = WorkspaceManager.getAllFilesContent(projectId);
    const result = ContextEngineV2.syncProject({ projectId, files });
    res.json({ success:true, ...result });
  } catch (err:any) {
    res.status(500).json({ error:String(err?.message || err) });
  }
});

router.get('/projects/:projectId/context', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  try {
    res.json({ success:true, ...ContextEngineV2.snapshot(req.params.projectId) });
  } catch (err:any) {
    res.status(500).json({ error:String(err?.message || err) });
  }
});

router.post('/projects/:projectId/context/compile', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId;
    const scope = String(req.body?.scope || 'TASK').toUpperCase();
    if (!['MICRO','LOCAL','TASK','PROJECT'].includes(scope)) {
      return res.status(400).json({ error:'Context scope inválido.' });
    }
    const task = typeof req.body?.task === 'string' ? { objective:req.body.task } : req.body?.task;
    if (!task?.objective || typeof task.objective !== 'string') {
      return res.status(400).json({ error:'task.objective é obrigatório.' });
    }
    const currentFiles = WorkspaceManager.getAllFilesContent(projectId);
    if (req.body?.sync !== false) {
      ContextEngineV2.syncProject({ projectId, files:currentFiles });
    }
    const runId = req.body?.runId ? String(req.body.runId) : null;
    const explicitRequirementIds = Array.isArray(req.body?.requirementIds) ? req.body.requirementIds.map(String) : [];
    const requirementIds = [...new Set([...explicitRequirementIds,...(runId ? workflowRequirementIds(projectId,runId,null) : [])])];
    const pack = ContextEngineV2.compile({
      projectId,
      agentKey:String(req.body?.agentKey || 'FORGE'),
      scope:scope as any,
      task,
      requirementIds,
      runId,
      stepId:req.body?.stepId ? String(req.body.stepId) : null,
      focusPaths:Array.isArray(req.body?.focusPaths) ? req.body.focusPaths.map(String) : [],
      tokenBudget:Number.isFinite(Number(req.body?.tokenBudget)) ? Number(req.body.tokenBudget) : undefined,
      fileContents:currentFiles,
    });
    res.json({ success:true, pack });
  } catch (err:any) {
    res.status(500).json({ error:String(err?.message || err) });
  }
});

router.post('/projects/:projectId/context/commits', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId;
    if (!req.body?.task || typeof req.body.task !== 'string') {
      return res.status(400).json({ error:'task é obrigatório.' });
    }
    const record = ContextEngineV2.recordCommit({
      projectId,
      runId:req.body.runId ? String(req.body.runId) : null,
      taskId:req.body.taskId ? String(req.body.taskId) : null,
      agentKey:req.body.agentKey ? String(req.body.agentKey) : null,
      scope:['MICRO','LOCAL','TASK','PROJECT'].includes(String(req.body.scope || '').toUpperCase()) ? String(req.body.scope).toUpperCase() as any : 'TASK',
      task:String(req.body.task),
      decisions:Array.isArray(req.body.decisions) ? req.body.decisions.map(String) : [],
      changedFiles:Array.isArray(req.body.changedFiles) ? req.body.changedFiles.map(String) : [],
      requirementIds:Array.isArray(req.body.requirementIds) ? req.body.requirementIds.map(String) : [],
      validation:req.body.validation ?? null,
      blockers:Array.isArray(req.body.blockers) ? req.body.blockers.map(String) : [],
      nextState:req.body.nextState ?? null,
    });
    res.json({ success:true, commit:record });
  } catch (err:any) {
    res.status(500).json({ error:String(err?.message || err) });
  }
});

router.get('/projects/:projectId/context/telemetry', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  try {
    const limit = Number(req.query.limit || 50);
    res.json({
      success:true,
      telemetry:ContextCompiler.listTelemetry(req.params.projectId, Number.isFinite(limit) ? limit : 50),
      commits:ContextCommitService.listRecent(req.params.projectId, Number.isFinite(limit) ? limit : 50),
    });
  } catch (err:any) {
    res.status(500).json({ error:String(err?.message || err) });
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

router.delete('/projects/:id', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id;

    // Delete the canonical cloud row first. This prevents bootstrap from
    // resurrecting a locally deleted project on the next refresh/session.
    if (CloudSyncService.configured()) {
      try {
        await CloudSyncService.deleteProject(req.user!.id, projectId);
      } catch (cloudError:any) {
        return res.status(502).json({
          error: 'A exclusão remota falhou; o projeto local foi preservado para evitar ressurreição/inconsistência.',
          details: String(cloudError?.message || cloudError),
        });
      }
    }

    // 1. Delete associated messages
    const convs = db.prepare('SELECT id FROM conversations WHERE project_id = ?').all(projectId) as { id: string }[];
    for (const c of convs) {
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(c.id);
    }

    // 2. Delete conversations
    db.prepare('DELETE FROM conversations WHERE project_id = ?').run(projectId);

    // 3. Delete execution/planning children before the project itself.
    db.prepare('DELETE FROM requirements WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM context_packs WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM context_commits WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM context_architecture_graphs WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM context_project_files WHERE project_id = ?').run(projectId);
    BrowserQualityService.cleanupProject(projectId,req.user!.id);
    const projectSandboxes=db.prepare('SELECT id FROM sandboxes WHERE project_id=?').all(projectId) as Array<{id:string}>;
    for(const sandbox of projectSandboxes){
      try{SandboxManager.cleanup(sandbox.id,req.user!.id);}catch{}
    }
    db.prepare('DELETE FROM sandboxes WHERE project_id=?').run(projectId);
    const runIds = db.prepare('SELECT id FROM agent_runs WHERE project_id = ?').all(projectId) as {id:string}[];
    for (const run of runIds) {
      db.prepare('DELETE FROM model_invocations WHERE run_id = ?').run(run.id);
      db.prepare('DELETE FROM tool_executions WHERE run_id = ?').run(run.id);
      db.prepare('DELETE FROM agent_steps WHERE run_id = ?').run(run.id);
    }
    db.prepare('DELETE FROM agent_runs WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM plans WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM tasks WHERE project_id = ?').run(projectId);

    // 4. Delete verifications
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

    res.json({ success: true, message: 'Projeto excluído com sucesso.' });
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
    const newName = `${source.name} (Cópia)`;

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

    WorkspaceManager.createCheckpoint(newId, 'Duplicação do Projeto', `Cópia criada a partir de ${source.name}`);
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
    if (!filePath) return res.status(400).json({ error: 'Parâmetro path ausente.' });

    if (WorkspaceManager.isBinaryPath(filePath)) {
      const buffer = WorkspaceManager.readBinaryFile(req.params.id, filePath);
      if (buffer === null) return res.status(404).json({ error: 'Arquivo não encontrado.' });
      return res.json({ path: filePath, isBinary: true, base64: buffer.toString('base64') });
    }

    const content = WorkspaceManager.readFile(req.params.id, filePath);
    if (content === null) {
      return res.status(404).json({ error: 'Arquivo não encontrado.' });
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
      return res.status(400).json({ error: 'Campos path e content são obrigatórios.' });
    }
    WorkspaceManager.writeFile(req.params.id, filePath, content);
    const cpId = WorkspaceManager.createCheckpoint(req.params.id, `Edição manual: ${filePath}`);
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
      return res.status(400).json({ error: 'O nome da versão (o que foi alterado nesta atualização) é obrigatório.' });
    }

    const cpId = WorkspaceManager.createCheckpoint(req.params.id, title.trim(), description?.trim() || '');
    const cp = db.prepare('SELECT id, title, description, parent_id, created_at FROM checkpoints WHERE id = ?').get(cpId);
    res.json({ success: true, checkpoint: cp, message: `Versão "${title.trim()}" criada com sucesso.` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/projects/:id/checkpoints/rollback-previous', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  try {
    const checkpoints = db.prepare('SELECT id, title, description, created_at FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC LIMIT 2').all(req.params.id) as any[];
    if (checkpoints.length < 2) {
      return res.status(400).json({ error: 'Não há versão anterior registrada para restaurar neste projeto.' });
    }

    const previousCheckpoint = checkpoints[1];
    const success = WorkspaceManager.restoreCheckpoint(req.params.id, previousCheckpoint.id);
    if (!success) {
      return res.status(500).json({ error: 'Falha ao restaurar arquivos da versão anterior.' });
    }

    res.json({
      success: true,
      message: `Versão anterior "${previousCheckpoint.title}" restaurada com sucesso!`,
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
      return res.status(404).json({ error: 'Checkpoint não encontrado.' });
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

router.get('/projects/:id/requirements', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  try {
    res.json({
      requirements: RequirementLedgerService.list(req.params.id),
      summary: RequirementLedgerService.summary(req.params.id),
    });
  } catch (error:any) {
    res.status(500).json({error:String(error?.message||error)});
  }
});

router.get('/conversations/:projectId', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  try {
    repairLegacyProjectText(req.params.projectId);
    const conversation = db.prepare('SELECT * FROM conversations WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(req.params.projectId) as any;
    if (!conversation) {
      return res.status(404).json({ error: 'Conversa não encontrada.' });
    }

    const messages = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversation.id);
    const activePlan = db.prepare("SELECT * FROM plans WHERE project_id = ? AND status='draft' ORDER BY created_at DESC LIMIT 1").get(req.params.projectId);

    res.json({ conversation, messages, activePlan });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/conversations/:projectId/plan/approve', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  const projectId=req.params.projectId;
  const {planId}=req.body||{};
  if(!planId)return res.status(400).json({error:'Identificador do plano é obrigatório.'});

  const plan=db.prepare('SELECT * FROM plans WHERE id=? AND project_id=?').get(planId,projectId) as any;
  if(!plan)return res.status(404).json({error:'Plano não encontrado neste projeto.'});
  const conversation=db.prepare('SELECT * FROM conversations WHERE project_id=? ORDER BY created_at DESC LIMIT 1').get(projectId) as any;
  if(!conversation)return res.status(404).json({error:'Conversa não encontrada.'});

  if(plan.status==='approved'){
    const latest=db.prepare('SELECT id,status FROM agent_runs WHERE project_id=? ORDER BY created_at DESC LIMIT 1').get(projectId) as any;
    return res.status(latest?.status==='running'?202:200).json({
      success:true,accepted:latest?.status==='running',alreadyApproved:true,runId:latest?.id||null,status:latest?.status||'approved',
    });
  }
  if(plan.status!=='draft')return res.status(409).json({error:`Este plano não está mais aguardando aprovação (${plan.status||'estado inválido'}).`});
  if(activeProjects.has(projectId)){
    const latest=db.prepare('SELECT id,status FROM agent_runs WHERE project_id=? ORDER BY created_at DESC LIMIT 1').get(projectId) as any;
    return res.status(202).json({success:true,accepted:true,runId:latest?.id||null,status:'already_running'});
  }

  const providerConfig=LLMAdapterService.getActiveProviderConfig(req.user!.id);
  if(!providerConfig)return res.status(409).json({error:'Selecione e salve um provedor de IA antes de construir o plano.'});

  activeProjects.add(projectId);
  const controller=new AbortController();
  activeProjectControllers.set(projectId,controller);
  let execution:{runId:string;stepId:string}|null=null;
  let acceptedEarly=false;
  let agentMessagePersisted=false;

  const parseStoredList=(value:unknown):string[]=>{
    if(Array.isArray(value))return value.map(item=>String(item)).filter(Boolean);
    if(typeof value!=='string'||!value.trim())return[];
    try{const parsed=JSON.parse(value);return Array.isArray(parsed)?parsed.map(item=>String(item)).filter(Boolean):[String(parsed)];}
    catch{return[value];}
  };

  try{
    const legacyFiles=parseStoredList(plan.files_affected_json);
    const existingFilesToModify=parseStoredList(plan.existing_files_json);
    const newFilesToCreate=parseStoredList(plan.new_files_json);
    const filesToDelete=parseStoredList(plan.files_to_delete_json);
    const filesAffected=[...new Set([...existingFilesToModify,...newFilesToCreate,...filesToDelete,...legacyFiles])];
    const integrations=parseStoredList(plan.integrations_json);
    const risks=parseStoredList(plan.risks_json);
    const acceptanceCriteria=parseStoredList(plan.acceptance_criteria_json);
    const planRequirements=(()=>{try{return JSON.parse(plan.requirements_json||'[]')}catch{return[]}})();
    const taskGraph=(()=>{try{return JSON.parse(plan.task_graph_json||'[]')}catch{return[]}})();
    const architectureSummary=String(plan.architecture_summary||'').trim();
    const buildPrompt=[
      'O usuário aprovou este plano técnico. Implemente-o agora no workspace atual e entregue o resultado final.',
      `OBJETIVO:\n${plan.objective||''}`,
      architectureSummary?`ARQUITETURA APROVADA:\n${architectureSummary}`:'',
      `ESCOPO INCLUÍDO:\n${plan.scope_in||''}`,
      `ESCOPO EXCLUÍDO:\n${plan.scope_out||''}`,
      existingFilesToModify.length?`ARQUIVOS EXISTENTES A MODIFICAR:\n- ${existingFilesToModify.join('\n- ')}`:'',
      newFilesToCreate.length?`NOVOS ARQUIVOS A CRIAR:\n- ${newFilesToCreate.join('\n- ')}`:'',
      filesToDelete.length?`ARQUIVOS A REMOVER:\n- ${filesToDelete.join('\n- ')}`:'',
      planRequirements.length?`REQUISITOS:\n${planRequirements.map((item:any)=>`- ${item.id}: ${item.title||item.description}`).join('\n')}`:'',
      taskGraph.length?`GRAFO DE TAREFAS:\n${taskGraph.map((item:any)=>`- ${item.id}: ${item.title} [${(item.requirement_ids||[]).join(', ')}]`).join('\n')}`:'',
      integrations.length?`INTEGRAÇÕES:\n- ${integrations.join('\n- ')}`:'',
      risks.length?`RISCOS:\n- ${risks.join('\n- ')}`:'',
      acceptanceCriteria.length?`CRITÉRIOS DE ACEITE:\n- ${acceptanceCriteria.join('\n- ')}`:'',
      'Construa em sandbox. O sistema fará validação, revisão SENTINEL e merge automaticamente; não peça nova aprovação.',
    ].filter(Boolean).join('\n\n');

    const history=db.prepare('SELECT sender,content FROM messages WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20').all(conversation.id).reverse() as any[];
    const existingFiles=WorkspaceManager.getAllFilesContent(projectId);
    const agentEngineEnabled=process.env.AGENT_ENGINE_ENABLED==='true';
    let executionRequirementIds:string[]=[];
    const approvedAt=new Date().toISOString();

    db.prepare("UPDATE plans SET status='approved',updated_at=? WHERE id=? AND project_id=? AND status='draft'").run(approvedAt,planId,projectId);
    db.prepare("UPDATE conversations SET mode='build',updated_at=? WHERE id=?").run(approvedAt,conversation.id);
    db.prepare("INSERT INTO messages(id,conversation_id,sender,content,metadata_json,created_at) VALUES(?,?,'user',?,?,?)")
      .run('msg-user-'+Date.now(),conversation.id,'Aprovado. Pode construir o plano.',JSON.stringify({mode:'build',action:'approve_plan',planId}),approvedAt);

    if(agentEngineEnabled){
      execution=RunService.start(req.user!.id,projectId,conversation.id,'build',.5);
      RequirementLedgerService.attachRun(projectId,planId,execution.runId);
      executionRequirementIds = workflowRequirementIds(projectId,execution.runId,planId);
      acceptedEarly=true;
      res.status(202).json({success:true,accepted:true,runId:execution.runId,planId});
    }

    let result=!agentEngineEnabled
      ? await LLMAdapterService.buildApprovedPlanReliably({
          projectId,providerKey:providerConfig.key,modelId:providerConfig.modelId,userId:req.user!.id,existingFiles,
          requestedFiles:filesAffected,objective:String(plan.objective||''),
          scopeIn:[architectureSummary?'ARQUITETURA: '+architectureSummary:'',String(plan.scope_in||'')].filter(Boolean).join('\n\n'),
          scopeOut:String(plan.scope_out||''),acceptanceCriteria,signal:controller.signal,
        })
      : await AgentWorkflowEngine.executeWorkflow({
          prompt:buildPrompt,mode:'build',projectId,existingFiles,appliedSkills:[],conversationHistory:history,
          userId:req.user!.id,runId:execution!.runId,stepId:execution!.stepId,signal:controller.signal,
          requirementIds:executionRequirementIds,
          reliableBuild:{
            requestedFiles:filesAffected,objective:String(plan.objective||''),
            scopeIn:[architectureSummary?'ARQUITETURA: '+architectureSummary:'',String(plan.scope_in||'')].filter(Boolean).join('\n\n'),
            scopeOut:String(plan.scope_out||''),acceptanceCriteria,
          },
        });
    controller.signal.throwIfAborted();

    if(JSON.stringify(WorkspaceManager.getAllFilesContent(projectId))!==JSON.stringify(existingFiles)){
      throw new Error('Os arquivos mudaram durante a construção. Tente novamente para usar a versão atual.');
    }
    if(result.build?.files?.length&&!result.proposal&&!result.isDemonstrativeFallback&&!result.hasErrors){
      result.proposal={
        id:`proposal-${crypto.randomUUID()}`,summary:result.build.summary||`Construção do plano: ${String(plan.objective||'').slice(0,80)}`,
        requiresConfirmation:false,files:result.build.files,status:'pending',
      };
    }
    if(result.hasErrors||result.invalidResponse||!result.proposal?.files?.length){
      throw new Error(result.errorMessage||result.errorReason||'O modelo não retornou uma implementação válida.');
    }

    await materializeProposalInSandbox({
      userId:req.user!.id,projectId,runId:execution?.runId||null,stepId:execution?.stepId||null,
      proposal:result.proposal,signal:controller.signal,
    });

    const applied=await SandboxProposalApplyService.apply({
      userId:req.user!.id,projectId,proposal:result.proposal,runId:execution?.runId||null,planId,
      summary:result.proposal.summary||String(plan.objective||'Plano aprovado'),
      originalRequest:String(plan.objective||'')+'\n'+String(plan.scope_in||''),shipRequested:false,signal:controller.signal,
    });
    if(!applied.success)throw Object.assign(new Error(applied.error||'A implementação não passou pela revisão final.'),{applyResult:applied});

    result.proposal.status='applied';
    const changedCount=Array.isArray(applied.changedFiles)?applied.changedFiles.length:result.proposal.files.length;
    const summary=String(result.proposal.summary||'A implementação aprovada foi concluída').replace(/[.\s]+$/,'');
    const replyText=`Pronto. ${summary}. O plano foi construído, revisado e aplicado ao preview${changedCount?` em ${changedCount} arquivo(s)`:''}.`;
    const messageNow=new Date().toISOString();
    const agentMsgId='msg-agent-'+Date.now();
    const metadata:any={
      mode:'build',decisionType:result.decisionType,providerUsed:result.providerUsed,modelUsed:result.modelUsed,
      planId,planApproved:true,filesAffected:applied.changedFiles||result.proposal.files.map((item:any)=>item.path),
      proposal:result.proposal,hasErrors:false,runId:execution?.runId,executionType:agentEngineEnabled?'agent_engine':'direct_llm',
      agentKey:agentEngineEnabled?((result as any).agentKey||'PROGRAM'):undefined,profileKey:(result as any).profileKey,
      workflow:execution?{...((result as any).workflow||{}),runId:execution.runId,status:applied.needsVerification?'needs_verification':'completed',trace:RunService.trace(execution.runId)}:(result as any).workflow,
      validation:applied.validation,browserQuality:applied.browserQuality,browserRepair:applied.browserRepair,sentinelReview:applied.sentinelReview,
      checkpointId:applied.checkpointId,technicalReply:result.replyText,autoApplied:true,buildDiagnostics:result.diagnostics,
    };
    db.prepare("INSERT INTO messages(id,conversation_id,sender,content,metadata_json,created_at) VALUES(?,?,'agent',?,?,?)")
      .run(agentMsgId,conversation.id,replyText,JSON.stringify(metadata),messageNow);
    agentMessagePersisted=true;

    if(!res.headersSent&&!res.destroyed){
      res.json({
        success:true,plan:{...plan,status:'approved',updated_at:approvedAt},
        agentMessage:{id:agentMsgId,conversation_id:conversation.id,sender:'agent',content:replyText,metadata,created_at:messageNow},
        proposal:result.proposal,checkpointId:applied.checkpointId,
      });
    }
  }catch(err:any){
    try{db.prepare("UPDATE plans SET status='draft',updated_at=? WHERE id=? AND project_id=?").run(new Date().toISOString(),planId,projectId);}catch{}
    if(execution){try{RunService.finish(execution.runId,execution.stepId,controller.signal.aborted?'aborted':'failed');}catch{}}
    const detail=String(err?.message||err||'Falha ao aprovar e construir o plano.').trim();
    if(acceptedEarly&&!agentMessagePersisted){
      const failedAt=new Date().toISOString();
      const msgId='msg-agent-'+Date.now();
      const content=controller.signal.aborted?'A construção foi interrompida. O plano voltou a ficar disponível.':`Não consegui concluir a construção com segurança. ${detail}`;
      const metadata={mode:'build',hasErrors:true,errorMessage:detail,planId,runId:execution?.runId,
        workflow:execution?{runId:execution.runId,status:controller.signal.aborted?'aborted':'failed',trace:RunService.trace(execution.runId)}:undefined,
        validation:err?.applyResult?.validation||null,browserQuality:err?.applyResult?.browserQuality||null,sentinelReview:err?.applyResult?.sentinelReview||null};
      db.prepare("INSERT INTO messages(id,conversation_id,sender,content,metadata_json,created_at) VALUES(?,?,'agent',?,?,?)")
        .run(msgId,conversation.id,content,JSON.stringify(metadata),failedAt);
    }else if(!res.headersSent&&!res.destroyed){
      res.status(controller.signal.aborted?499:500).json({error:controller.signal.aborted?'Construção cancelada. O plano continua aguardando aprovação.':detail});
    }
  }finally{
    activeProjects.delete(projectId);
    activeProjectControllers.delete(projectId);
    if(acceptedEarly&&req.user?.id)CloudSyncService.schedule(req.user.id);
  }
});

router.post('/conversations/:projectId/messages', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  const projectId=req.params.projectId;
  if (activeProjects.has(projectId)) return res.status(409).json({error:'Já há uma execução neste projeto. Aguarde ou cancele antes de enviar outro pedido.'});
  activeProjects.add(projectId);
  const controller=new AbortController();
  activeProjectControllers.set(projectId,controller);
  let execution:{runId:string;stepId:string}|null=null;
  let conv:any=null;
  let agentMessagePersisted=false;
  let acceptedEarly=false;
  let conversationalOnly=false;

  try{
    const {content,mode='auto',appliedSkills=[],attachments=[],mentionedFiles=[]}=req.body||{};
    const rawContent=String(content||'').trim();
    const incomingAttachments=Array.isArray(attachments)?attachments as IncomingAttachment[]:[];
    const requestedMentionedFiles=Array.isArray(mentionedFiles)?mentionedFiles.map((item:any)=>String(item||'').replace(/\\/g,'/').trim()).filter(Boolean):[];
    if(!rawContent&&!incomingAttachments.length&&!requestedMentionedFiles.length){
      return res.status(400).json({error:'Digite uma mensagem, anexe um arquivo ou mencione um arquivo do projeto.'});
    }
    const userContent=rawContent||'Analise os arquivos enviados e use-os como contexto para me ajudar com este projeto.';

    const selectedMode=mode as AgentMode;
    const now=new Date().toISOString();
    conv=db.prepare('SELECT * FROM conversations WHERE project_id=? ORDER BY created_at DESC LIMIT 1').get(projectId) as any;

    if(!conv){
      const convId='conv-'+Date.now();
      db.prepare('INSERT INTO conversations (id,project_id,title,mode,created_at,updated_at) VALUES (?,?,?,?,?,?)')
        .run(convId,projectId,'Conversa Principal',selectedMode,now,now);
      conv={id:convId,mode:selectedMode};
    }

    const priorHistory=db.prepare('SELECT sender,content FROM messages WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20').all(conv.id).reverse() as any[];
    const existingFiles=WorkspaceManager.getAllFilesContent(projectId);
    const projectFiles=WorkspaceManager.getFiles(projectId);
    const resolvedMode=LLMAdapterService.resolveRequestedMode(userContent,selectedMode,{
      conversationHistory:priorHistory,
      existingFiles:Object.keys(existingFiles),
    });
    conversationalOnly=selectedMode==='auto'&&resolvedMode==='auto';

    const parsePlanList=(value:unknown):string[]=>{
      if(Array.isArray(value))return value.map(item=>String(item)).filter(Boolean);
      if(typeof value!=='string'||!value.trim())return[];
      try{const parsed=JSON.parse(value);return Array.isArray(parsed)?parsed.map(item=>String(item)).filter(Boolean):[];}catch{return[];}
    };
    const implicitDraftPlan=resolvedMode==='build'
      ? db.prepare("SELECT * FROM plans WHERE project_id=? AND status='draft' ORDER BY created_at DESC LIMIT 1").get(projectId) as any
      : null;
    const implicitPlanExisting=implicitDraftPlan?parsePlanList(implicitDraftPlan.existing_files_json):[];
    const implicitPlanNew=implicitDraftPlan?parsePlanList(implicitDraftPlan.new_files_json):[];
    const implicitPlanTargets=[...new Set([...implicitPlanExisting,...implicitPlanNew])];
    const implicitPlanAcceptance=implicitDraftPlan?parsePlanList(implicitDraftPlan.acceptance_criteria_json):[];
    const implicitPlanRequirements=implicitDraftPlan?(()=>{try{return JSON.parse(implicitDraftPlan.requirements_json||'[]')}catch{return[]}})():[];
    const implicitPlanTasks=implicitDraftPlan?(()=>{try{return JSON.parse(implicitDraftPlan.task_graph_json||'[]')}catch{return[]}})():[];
    const implicitPlanContext=implicitDraftPlan?[
      'PLANO TÉCNICO JÁ DEFINIDO NA CONVERSA — use como contrato da implementação atual:',
      'OBJETIVO: '+String(implicitDraftPlan.objective||''),
      String(implicitDraftPlan.architecture_summary||'')?'ARQUITETURA: '+String(implicitDraftPlan.architecture_summary||''):'',
      String(implicitDraftPlan.scope_in||'')?'ESCOPO: '+String(implicitDraftPlan.scope_in||''):'',
      implicitPlanTargets.length?'ARQUIVOS PLANEJADOS:\\n- '+implicitPlanTargets.join('\\n- '):'',
      implicitPlanRequirements.length?'REQUISITOS:\\n'+implicitPlanRequirements.map((item:any)=>'- '+String(item.id||'')+': '+String(item.title||item.description||'')).join('\\n'):'',
      implicitPlanTasks.length?'TAREFAS:\\n'+implicitPlanTasks.map((item:any)=>'- '+String(item.id||'')+': '+String(item.title||'')).join('\\n'):'',
      implicitPlanAcceptance.length?'CRITÉRIOS DE ACEITE:\\n- '+implicitPlanAcceptance.join('\\n- '):'',
      'O usuário pediu execução agora; não peça aprovação intermediária.',
    ].filter(Boolean).join('\\n\\n'):'';

    // O modo Automático continua visível como Automático; resolvedMode é decisão interna do agente.
    const conversationMode=selectedMode==='auto'?'auto':resolvedMode;
    db.prepare('UPDATE conversations SET mode=?,updated_at=? WHERE id=?').run(conversationMode,now,conv.id);

    const agentEngineEnabled=process.env.AGENT_ENGINE_ENABLED==='true';
    if(agentEngineEnabled&&!conversationalOnly){
      execution=RunService.start(req.user!.id,projectId,conv.id,resolvedMode,.5);
      if(implicitDraftPlan?.id){
        RequirementLedgerService.attachRun(projectId,implicitDraftPlan.id,execution.runId);
      }
    }

    const userMsgId='msg-user-'+Date.now();
    const inlineMentions=projectFiles
      .map(file=>file.path)
      .filter(filePath=>userContent.includes('@'+filePath));
    const validMentionedFiles=[...new Set([...requestedMentionedFiles,...inlineMentions])].filter(filePath=>
      Object.prototype.hasOwnProperty.call(existingFiles,filePath) ||
      projectFiles.some(file=>file.path===filePath)
    ).slice(0,12);

    const processedAttachments=await AttachmentService.ingest({
      userId:req.user!.id,
      projectId,
      messageId:userMsgId,
      attachments:incomingAttachments,
    });
    const attachmentContext=AttachmentService.formatContext(processedAttachments);
    const mentionedFileContext=validMentionedFiles.length
      ? (()=>{
          const chunks=['ARQUIVOS DO WORKSPACE MENCIONADOS EXPLICITAMENTE PELO USUÁRIO — priorize estes arquivos:'];
          let used=chunks[0].length;
          for(const filePath of validMentionedFiles){
            const text=existingFiles[filePath];
            const info=projectFiles.find(file=>file.path===filePath);
            const body=typeof text==='string'?text:`[arquivo binário do workspace, ${info?.size||0} bytes]`;
            const head=`### ${filePath}\n`;
            const remaining=Math.max(0,120000-used-head.length);
            if(!remaining)break;
            const chunk=head+body.slice(0,Math.min(50000,remaining));
            chunks.push(chunk);
            used+=chunk.length;
          }
          return chunks.join('\n\n');
        })()
      : '';
    const requestContext=[attachmentContext,mentionedFileContext].filter(Boolean).join('\n\n');
    const effectivePrompt=[userContent,implicitPlanContext,requestContext].filter(Boolean).join('\n\n');

    const userMetadata={
      mode:selectedMode,resolvedMode,appliedSkills,
      mentionedFiles:validMentionedFiles,
      attachments:processedAttachments.map(item=>({id:item.id,name:item.name,mimeType:item.mimeType,size:item.size,kind:item.kind})),
      implicitPlanId:implicitDraftPlan?.id||undefined,
    };
    db.prepare(`
      INSERT INTO messages (id,conversation_id,sender,content,metadata_json,created_at)
      VALUES (?,?,'user',?,?,?)
    `).run(userMsgId,conv.id,userContent,JSON.stringify(userMetadata),now);

    const history=[...priorHistory,{sender:'user',content:userContent}];
    const project=db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as any;

    const requestsGitHubPublish=/\b(public(?:ar|a|e)|enviar|sincronizar|push)\b[\s\S]{0,80}\b(github|reposit[oó]rio|remoto)\b|\b(github|reposit[oó]rio|remoto)\b[\s\S]{0,80}\b(public(?:ar|a|e)|enviar|sincronizar|push)\b/i.test(userContent);
    if(requestsGitHubPublish){
      if(execution)RunService.assignAgent(execution.stepId,'SHIP');
      const repoContext=projectRepositoryContext(projectId,project);
      if(!repoContext.repoUrl){
        if(execution)RunService.finish(execution.runId,execution.stepId,'failed');
        return res.status(409).json({error:'Vincule ou crie um repositório na aba Publicar antes de enviar o projeto ao GitHub.'});
      }
      const parsed=GitHubService.parseRepoUrl(repoContext.repoUrl);
      if(!parsed){
        if(execution)RunService.finish(execution.runId,execution.stepId,'failed');
        return res.status(400).json({error:'A URL do repositório vinculado é inválida.'});
      }
      const binaryFiles:Record<string,Buffer>={};
      for(const file of WorkspaceManager.getFiles(projectId)){
        if(!file.isBinary)continue;
        const bytes=WorkspaceManager.readBinaryFile(projectId,file.path);
        if(bytes)binaryFiles[file.path]=bytes;
      }
      const pushed=await GitHubService.pushFilesToRepo({
        userId:req.user!.id,owner:parsed.owner,repo:parsed.repo,branch:repoContext.branch,
        commitMessage:`Forge Agent: ${userContent.slice(0,72)}`,files:existingFiles,binaryFiles,
      });
      if(!pushed.success){
        if(execution)RunService.finish(execution.runId,execution.stepId,'failed');
        return res.status(400).json({error:pushed.error||'O GitHub recusou a publicação.'});
      }
      if(pushed.commitSha)db.prepare('UPDATE branches SET head_commit_hash=? WHERE project_id=? AND name=?').run(pushed.commitSha,projectId,repoContext.branch);
      const agentMsgId='msg-agent-'+Date.now();
      const commitUrl=`https://github.com/${parsed.owner}/${parsed.repo}/commit/${pushed.commitSha}`;
      const replyText=`Publicação concluída no GitHub.\n\nCommit: ${pushed.commitSha}\n${commitUrl}`;
      if(execution)RunService.finish(execution.runId,execution.stepId,'completed');
      const metadata={
        mode:selectedMode,decisionType:'publish',providerUsed:'GitHub',modelUsed:'ferramenta-direta',
        filesAffected:[...Object.keys(existingFiles),...Object.keys(binaryFiles)],runId:execution?.runId,
        executionType:execution?'agent_engine':'direct_tool',agentKey:execution?'SHIP':undefined,
        workflow:execution?{runId:execution.runId,status:'completed',steps:[execution.stepId],shipRequested:true,trace:RunService.trace(execution.runId)}:undefined,
        github:{owner:parsed.owner,repo:parsed.repo,branch:repoContext.branch,commitSha:pushed.commitSha,commitUrl},
      };
      db.prepare("INSERT INTO messages (id,conversation_id,sender,content,metadata_json,created_at) VALUES (?,?,'agent',?,?,?)")
        .run(agentMsgId,conv.id,replyText,JSON.stringify(metadata),new Date().toISOString());
      agentMessagePersisted=true;
      return res.json({success:true,agentMessage:{id:agentMsgId,sender:'agent',content:replyText,metadata,created_at:now},github:metadata.github});
    }

    const providerConfig=LLMAdapterService.getActiveProviderConfig(req.user!.id);
    if(!providerConfig){
      if(execution)RunService.finish(execution.runId,execution.stepId,'failed');
      return res.status(409).json({error:'Selecione e salve um provedor de IA antes de enviar mensagens.'});
    }
    const providerKey=providerConfig.key;
    const modelId=providerConfig.modelId;

    // Construções longas deixam de depender da conexão HTTP. A UI acompanha o run e a conversa por polling.
    if(agentEngineEnabled&&resolvedMode==='build'){
      acceptedEarly=true;
      res.status(202).json({
        success:true,accepted:true,runId:execution?.runId,
        userMessage:{id:userMsgId,conversation_id:conv.id,sender:'user',content:userContent,metadata:userMetadata,created_at:now},
      });
    }

    const conversationalPrompt=conversationalOnly
      ? [
          'MODO CONVERSA. Responda ao usuário diretamente no chat.',
          'Não crie, altere, remova ou proponha arquivos. Não inicie implementação, plano executável, diff, sandbox ou publicação.',
          'Você pode explicar capacidades, responder dúvidas, fazer brainstorming, detalhar ideias, melhorar requisitos e ajudar a pensar antes da implementação.',
          'Faça a análise interna com profundidade, mas entregue ao usuário uma resposta final compacta e direta.',
          'A resposta visível deve ter no máximo cerca de 120 palavras, preferindo 2 a 5 parágrafos curtos ou até 5 bullets. Preserve só decisões, recomendações e alertas realmente úteis.',
          'Não despeje raciocínio técnico, logs, arquitetura interna ou listas longas. Se houver muito conteúdo, sintetize o essencial sem reduzir a qualidade da análise.',
          'Se o usuário quiser construir algo depois, ele fará um novo pedido explícito.',
          '',
          'PEDIDO DO USUÁRIO:',
          userContent,
          requestContext?'CONTEXTO DE ARQUIVOS E ANEXOS:\n'+requestContext:'',
        ].filter(Boolean).join('\n')
      : effectivePrompt;

    let result=conversationalOnly
      ? await LLMAdapterService.executePrompt({
          prompt:conversationalPrompt,mode:'auto',projectId,providerKey,modelId,existingFiles,appliedSkills,
          conversationHistory:history,userId:req.user!.id,signal:controller.signal,
        })
      : !agentEngineEnabled
        ? await LLMAdapterService.executePrompt({
            prompt:effectivePrompt,mode:resolvedMode,projectId,providerKey,modelId,existingFiles,appliedSkills,
            conversationHistory:history,userId:req.user!.id,signal:controller.signal,
          })
        : await AgentWorkflowEngine.executeWorkflow({
            prompt:effectivePrompt,mode:resolvedMode,projectId,existingFiles,appliedSkills,conversationHistory:history,
            userId:req.user!.id,runId:execution!.runId,stepId:execution!.stepId,signal:controller.signal,
            focusPaths:validMentionedFiles,
            requirementIds:implicitDraftPlan?.id?workflowRequirementIds(projectId,execution!.runId,implicitDraftPlan.id):undefined,
            reliableBuild:implicitDraftPlan?{
              requestedFiles:implicitPlanTargets,
              objective:String(implicitDraftPlan.objective||userContent),
              scopeIn:[
                String(implicitDraftPlan.architecture_summary||'')?'ARQUITETURA: '+String(implicitDraftPlan.architecture_summary||''):'',
                String(implicitDraftPlan.scope_in||''),
                implicitPlanContext,
              ].filter(Boolean).join('\n\n'),
              scopeOut:String(implicitDraftPlan.scope_out||''),
              acceptanceCriteria:implicitPlanAcceptance,
            }:undefined,
          });
    controller.signal.throwIfAborted();

    if(conversationalOnly&&(result.hasErrors||result.invalidResponse)){
      const tried=new Set([providerKey+'::'+modelId]);
      const profiles:ProfileKey[]=['BASE_FREE','EXPERT_PAID','PREMIUM_OVERRIDE'];
      for(const profile of profiles){
        let recovered=false;
        for(const candidate of ModelRouter.candidates(req.user!.id,profile)){
          const key=candidate.provider_key+'::'+candidate.model_id;
          if(tried.has(key))continue;
          tried.add(key);
          const candidateConfig=LLMAdapterService.getProviderConfig(candidate.provider_key,req.user!.id);
          if(!candidateConfig.isConfigured)continue;
          const fallbackResult=await LLMAdapterService.executePrompt({
            prompt:conversationalPrompt,mode:'auto',projectId,
            providerKey:candidate.provider_key,modelId:candidate.model_id,
            existingFiles,appliedSkills,conversationHistory:history,
            userId:req.user!.id,signal:controller.signal,allowActiveFallback:false,
          });
          controller.signal.throwIfAborted();
          if(!fallbackResult.hasErrors&&!fallbackResult.invalidResponse){
            ModelRouter.recordCandidateResult(candidate.id,true);
            result=fallbackResult;
            recovered=true;
            break;
          }
          const reason=String(fallbackResult.errorReason||fallbackResult.errorMessage||'');
          const operational=/timeout|network|rate_limit|provider_error|429|5\d\d|fetch|enotfound|eai_again/i.test(reason);
          ModelRouter.recordCandidateResult(candidate.id,false,operational?'operational':'incompatible');
        }
        if(recovered)break;
      }
    }

    if(conversationalOnly){
      // Conversa nunca pode vazar para o pipeline de mutação mesmo se um provider
      // retornar por engano um schema de PLAN/BUILD.
      result={...result,mode:'auto',decisionType:'explanation',plan:undefined,build:undefined,proposal:undefined};
    }

    const effectiveIntent=resolvedMode;
    const recoverableBuildFailure=
      !agentEngineEnabled&&effectiveIntent==='build'&&(
        result.invalidResponse===true||
        result.errorReason==='timeout'||
        (result.errorReason==='provider_error'&&/524|context|token|too large|response|upstream/i.test(String(result.errorMessage||result.replyText||'')))
      );
    if(recoverableBuildFailure){
      result=await LLMAdapterService.buildApprovedPlanReliably({
        projectId,providerKey,modelId,userId:req.user!.id,existingFiles,requestedFiles:validMentionedFiles,objective:effectivePrompt,
        acceptanceCriteria:['Atender integralmente ao pedido do usuário','Preservar compatibilidade com o projeto existente'],
        signal:controller.signal,
      });
      controller.signal.throwIfAborted();
    }

    if(JSON.stringify(WorkspaceManager.getAllFilesContent(projectId))!==JSON.stringify(existingFiles)){
      throw Object.assign(new Error('Os arquivos mudaram durante a execução. Envie novamente para usar a versão atual.'),{code:'STALE_WORKSPACE'});
    }

    let checkpointCreatedId:string|null=null;
    let validation:Awaited<ReturnType<typeof ValidatorEngine.validate>>|null=null;
    let browserQuality:any=null;
    let browserRepair:any=null;
    let sentinelReview:any=null;
    let applyResult:any=null;

    if(result.build?.files?.length&&!result.proposal&&!result.isDemonstrativeFallback&&!result.hasErrors){
      result.proposal={
        id:`proposal-${crypto.randomUUID()}`,
        summary:result.build.summary||userContent.slice(0,100),
        requiresConfirmation:false,
        files:result.build.files,
        status:'pending',
      };
    }

    if((result.hasErrors||result.invalidResponse)&&!conversationalOnly){
      throw Object.assign(new Error(result.errorMessage||result.errorReason||'A IA não conseguiu concluir esta etapa com segurança.'),{code:'MODEL_RESULT_FAILED'});
    }

    if(result.proposal?.files?.length&&!result.isDemonstrativeFallback){
      await materializeProposalInSandbox({
        userId:req.user!.id,projectId,runId:execution?.runId||null,stepId:execution?.stepId||null,
        proposal:result.proposal,signal:controller.signal,
      });
      validation=(result.proposal as any).sandboxValidation||null;
    }

    let savedPlanId:string|null=null;
    if(result.plan){
      savedPlanId='plan-'+Date.now();
      db.prepare("UPDATE plans SET status='superseded',updated_at=? WHERE project_id=? AND status='draft'").run(now,projectId);
      db.prepare(`
        INSERT INTO plans (
          id,task_id,project_id,objective,scope_in,scope_out,
          architecture_summary,existing_files_json,new_files_json,files_to_delete_json,
          files_affected_json,integrations_json,risks_json,acceptance_criteria_json,
          requirements_json,task_graph_json,status,created_at,updated_at
        ) VALUES (?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)
      `).run(
        savedPlanId,projectId,
        typeof result.plan.objective==='string'?result.plan.objective:JSON.stringify(result.plan.objective??''),
        typeof result.plan.scope_in==='string'?result.plan.scope_in:JSON.stringify(result.plan.scope_in??''),
        typeof result.plan.scope_out==='string'?result.plan.scope_out:JSON.stringify(result.plan.scope_out??''),
        result.plan.architecture_summary||'',
        JSON.stringify(result.plan.existing_files_to_modify||[]),JSON.stringify(result.plan.new_files_to_create||[]),
        JSON.stringify(result.plan.files_to_delete||[]),JSON.stringify(result.plan.files_affected||[]),
        JSON.stringify(result.plan.integrations||[]),JSON.stringify(result.plan.risks||[]),
        JSON.stringify(result.plan.acceptance_criteria||[]),JSON.stringify(result.plan.requirements||[]),
        JSON.stringify(result.plan.task_graph||[]),now,now
      );
      RequirementLedgerService.syncPlan({
        projectId,conversationId:conv.id,runId:execution?.runId||null,planId:savedPlanId,requirements:result.plan.requirements||[],
      });
    }

    let replyText=String(result.replyText||'').trim();
    if(conversationalOnly&&replyText.length>900){
      const head=replyText.slice(0,900);
      const boundary=Math.max(head.lastIndexOf('\n\n'),head.lastIndexOf('. '),head.lastIndexOf('! '),head.lastIndexOf('? '));
      replyText=(boundary>420?head.slice(0,boundary+1):head).trim();
      replyText+='\n\nSe quiser, eu detalho a parte mais importante.';
    }
    if(result.proposal?.files?.length&&resolvedMode==='build'){
      applyResult=await SandboxProposalApplyService.apply({
        userId:req.user!.id,projectId,proposal:result.proposal,runId:execution?.runId||null,planId:savedPlanId,
        summary:result.proposal.summary||userContent.slice(0,100),originalRequest:userContent,
        shipRequested:Boolean((result as any).workflow?.shipRequested),signal:controller.signal,
      });
      if(!applyResult.success){
        throw Object.assign(new Error(applyResult.error||'A implementação não passou pela revisão final.'),{code:'AUTO_APPLY_FAILED',applyResult});
      }
      result.proposal.status='applied';
      if(implicitDraftPlan?.id){
        db.prepare("UPDATE plans SET status='approved',updated_at=? WHERE id=? AND project_id=? AND status='draft'")
          .run(new Date().toISOString(),implicitDraftPlan.id,projectId);
      }
      checkpointCreatedId=applyResult.checkpointId||null;
      validation=applyResult.validation||validation;
      browserQuality=applyResult.browserQuality||null;
      browserRepair=applyResult.browserRepair||null;
      sentinelReview=applyResult.sentinelReview||null;
      const changedCount=Array.isArray(applyResult.changedFiles)?applyResult.changedFiles.length:result.proposal.files.length;
      const summary=String(result.proposal.summary||result.build?.summary||'A implementação solicitada foi concluída').replace(/[.\s]+$/,'');
      replyText=`Pronto. ${summary}. A implementação foi construída, revisada e aplicada ao preview${changedCount? ` em ${changedCount} arquivo(s)`:''}.`;
      if(applyResult.needsVerification)replyText+=' As verificações compatíveis foram executadas; existe uma etapa técnica que não pôde ser verificada automaticamente.';
    }

    const messageNow=new Date().toISOString();
    const agentMsgId='msg-agent-'+Date.now();
    const metadata:any={
      mode:selectedMode,resolvedMode,appliedSkills,isDemonstrativeFallback:result.isDemonstrativeFallback,
      implicitPlanId:implicitDraftPlan?.id||undefined,
      providerUsed:result.providerUsed,modelUsed:result.modelUsed,planId:savedPlanId,checkpointId:checkpointCreatedId,
      filesAffected:applyResult?.changedFiles||result.build?.files?.map((item:any)=>item.path)||result.plan?.files_affected||[],
      decisionType:result.decisionType,proposal:result.proposal,hasErrors:Boolean(result.hasErrors),invalidResponse:Boolean(result.invalidResponse),
      runId:execution?.runId,executionType:agentEngineEnabled?'agent_engine':'direct_llm',
      agentKey:agentEngineEnabled?((result as any).agentKey||'PROGRAM'):undefined,profileKey:(result as any).profileKey,
      workflow:execution?{...((result as any).workflow||{}),runId:execution.runId,status:applyResult?(applyResult.needsVerification?'needs_verification':'completed'):((result as any).workflow?.status||'completed'),trace:RunService.trace(execution.runId)}:(result as any).workflow,
      validation,browserQuality,browserRepair,sentinelReview,buildDiagnostics:result.diagnostics,
      technicalReply:result.replyText,
      autoApplied:Boolean(applyResult),
      originalRequest:userContent,
      mentionedFiles:validMentionedFiles,
      attachments:userMetadata.attachments,
    };

    db.prepare(`
      INSERT INTO messages (id,conversation_id,sender,content,metadata_json,created_at)
      VALUES (?,?,'agent',?,?,?)
    `).run(agentMsgId,conv.id,replyText,JSON.stringify(metadata),messageNow);
    agentMessagePersisted=true;

    if(execution&&!applyResult){
      if(result.proposal?.status==='pending'&&resolvedMode!=='build')RunService.waitForApproval(execution.runId);
      else RunService.finish(execution.runId,execution.stepId,'completed');
    }

    if(!res.headersSent&&!res.destroyed){
      res.json({
        success:!(result.hasErrors||result.invalidResponse),
        error:result.hasErrors||result.invalidResponse?(result.errorMessage||result.errorReason||'Falha temporária de IA.'):undefined,
        agentMessage:{id:agentMsgId,sender:'agent',content:replyText,metadata,created_at:messageNow},
        plan:result.plan,build:result.build,proposal:result.proposal,checkpointId:checkpointCreatedId,
      });
    }
  }catch(err:any){
    if(execution){
      try{RunService.finish(execution.runId,execution.stepId,controller.signal.aborted?'aborted':'failed');}catch{}
    }
    const detail=String(err?.message||err||'Falha ao concluir o pedido.').trim();
    if(acceptedEarly&&conv&&!agentMessagePersisted){
      const failedAt=new Date().toISOString();
      const msgId='msg-agent-'+Date.now();
      const content=controller.signal.aborted
        ? 'A execução foi interrompida. O progresso concluído foi preservado.'
        : `Não consegui concluir esta implementação com segurança. ${detail}`;
      const metadata={
        mode:req.body?.mode||'auto',hasErrors:true,errorMessage:detail,runId:execution?.runId,
        workflow:execution?{runId:execution.runId,status:controller.signal.aborted?'aborted':'failed',trace:RunService.trace(execution.runId)}:undefined,
        validation:err?.applyResult?.validation||null,browserQuality:err?.applyResult?.browserQuality||null,
        sentinelReview:err?.applyResult?.sentinelReview||null,
      };
      db.prepare("INSERT INTO messages(id,conversation_id,sender,content,metadata_json,created_at) VALUES(?,?,'agent',?,?,?)")
        .run(msgId,conv.id,content,JSON.stringify(metadata),failedAt);
    }else if(!res.headersSent&&!res.destroyed){
      res.status(controller.signal.aborted?499:500).json({error:controller.signal.aborted?'Execução cancelada.':detail});
    }
  }finally{
    activeProjects.delete(projectId);
    activeProjectControllers.delete(projectId);
    // A resposta 202 pode ter sido enviada minutos antes do merge final. Nesse caso
    // o middleware global já sincronizou um snapshot antigo. Reagende a sincronização
    // somente após a execução de background terminar para persistir o workspace final.
    if(acceptedEarly&&req.user?.id)CloudSyncService.schedule(req.user.id);
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
  const run=db.prepare('SELECT * FROM agent_runs WHERE id=? AND user_id=?').get(req.params.runId,req.user!.id) as any;
  if(!run)return res.status(404).json({error:'Execução não encontrada.'});
  if(!['failed','aborted'].includes(run.status))return res.status(409).json({error:`Esta execução não pode ser continuada no estado atual (${run.status}).`});
  if(!['build','auto'].includes(run.mode))return res.status(409).json({error:'Continuação por etapa está disponível apenas para fluxos de construção.'});
  if(activeProjects.has(run.project_id))return res.status(409).json({error:'Já há uma execução ativa neste projeto.'});

  const trace=RunService.trace(run.id) as any[];
  const scout=[...trace].reverse().find(step=>step.agent_key==='SCOUT'&&step.status==='completed');
  if(!scout?.context?.objective)return res.status(409).json({error:'Esta execução não possui contexto persistido suficiente para continuar sem recomeçar.'});
  const studio=[...trace].reverse().find(step=>step.agent_key==='STUDIO'&&step.status==='completed');
  const objective=String(scout.context.objective||'').trim();
  const scoutBrief=String(scout.context.brief||'').trim();
  const studioGuidance=String(studio?.context?.guidance||'').trim();

  activeProjects.add(run.project_id);
  const controller=new AbortController();
  activeProjectControllers.set(run.project_id,controller);
  RunService.resume(run.id);
  let agentMessagePersisted=false;
  res.status(202).json({success:true,accepted:true,runId:run.id});

  try{
    const interruptedTools=ToolExecutionJournal.recoverable(run.id);
    let recoverySandboxId:string|null=null;
    for(const execution of [...interruptedTools].reverse()){
      if(execution.sandboxId){
        try{SandboxManager.assertAccess(execution.sandboxId,req.user!.id,run.project_id);recoverySandboxId=execution.sandboxId;break;}catch{}
      }
    }
    const existingFiles=recoverySandboxId
      ? SandboxManager.getAllFilesContent(recoverySandboxId,req.user!.id,run.project_id)
      : WorkspaceManager.getAllFilesContent(run.project_id);
    const continuedRequirementIds = workflowRequirementIds(run.project_id,run.id,null);
    const history=db.prepare('SELECT sender,content FROM messages WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20').all(run.conversation_id).reverse() as any[];
    const forge=RunService.createStep(
      run.id,'FORGE','Continuar implementação a partir do progresso salvo',undefined,'local',
      RunService.context('local',{
        objective,acceptanceCriteria:['Continuar sem repetir etapas já concluídas','Entregar alteração funcional e revisada'],
        snippets:[{source:'ContextEngineV2',fileCount:Object.keys(existingFiles).length,recoverySandboxId}],
        previousAttempt:'SCOUT/STUDIO preservados; retomada iniciada no FORGE.',
        constraints:['Não refazer SCOUT/STUDIO concluídos','Validar e revisar antes do merge final'],
      })
    );
    const prompt=[
      objective,
      scoutBrief?'BRIEF SALVO DO SCOUT:\n'+scoutBrief:'',
      studioGuidance?'CRITÉRIOS SALVOS DO STUDIO:\n'+studioGuidance:'',
      'CONTINUAÇÃO: retome a partir do FORGE. Não repita etapas concluídas. Entregue a implementação para validação e revisão automática.',
    ].filter(Boolean).join('\n\n');

    let result=await AgentEngine.execute({
      prompt,mode:'build',projectId:run.project_id,existingFiles,appliedSkills:[],conversationHistory:history,
      userId:req.user!.id,runId:run.id,stepId:forge,signal:controller.signal,requirementIds:continuedRequirementIds,
      toolSandboxId:recoverySandboxId||undefined,skipContextSync:Boolean(recoverySandboxId),
    },{profile:'BASE_FREE',forcedAgentKey:'FORGE',allowExpertEscalation:true});

    RunService.finishStep(forge,result.hasErrors?'failed':'completed',{
      continuedFromRunId:run.id,providerUsed:result.providerUsed,modelUsed:result.modelUsed,profileKey:result.profileKey,
      files:result.build?.files?.map((file:any)=>file.path)||result.proposal?.files?.map((file:any)=>file.path)||[],
    });

    if(result.build?.files?.length&&!result.proposal&&!result.isDemonstrativeFallback&&!result.hasErrors){
      result.proposal={id:`proposal-${crypto.randomUUID()}`,summary:result.build.summary||'Continuação da construção',requiresConfirmation:false,files:result.build.files,status:'pending'};
    }
    if(result.hasErrors||result.invalidResponse||!result.proposal?.files?.length){
      throw new Error(result.errorMessage||result.errorReason||'A continuação não produziu uma implementação válida.');
    }
    if(!result.proposal.sandboxId){
      await materializeProposalInSandbox({userId:req.user!.id,projectId:run.project_id,runId:run.id,stepId:forge,proposal:result.proposal,signal:controller.signal});
    }

    const applied=await SandboxProposalApplyService.apply({
      userId:req.user!.id,projectId:run.project_id,proposal:result.proposal,runId:run.id,
      summary:result.proposal.summary||'Continuação da construção',originalRequest:objective,signal:controller.signal,
    });
    if(!applied.success)throw Object.assign(new Error(applied.error||'A continuação não passou pela revisão final.'),{applyResult:applied});
    result.proposal.status='applied';

    const changedCount=Array.isArray(applied.changedFiles)?applied.changedFiles.length:result.proposal.files.length;
    const summary=String(result.proposal.summary||'A continuação foi concluída').replace(/[.\s]+$/,'');
    const replyText=`Pronto. ${summary}. Retomei do ponto salvo, revisei a implementação e atualizei o preview${changedCount?` em ${changedCount} arquivo(s)`:''}.`;
    const now=new Date().toISOString();
    const msgId=`msg-agent-${Date.now()}`;
    const metadata:any={
      mode:'build',decisionType:result.decisionType,providerUsed:result.providerUsed,modelUsed:result.modelUsed,
      proposal:result.proposal,filesAffected:applied.changedFiles||result.proposal.files.map((file:any)=>file.path),hasErrors:false,
      runId:run.id,executionType:'agent_engine_continuation',agentKey:'FORGE',profileKey:result.profileKey,
      workflow:{runId:run.id,status:applied.needsVerification?'needs_verification':'completed',steps:RunService.trace(run.id).map((step:any)=>step.id),trace:RunService.trace(run.id),continued:true},
      validation:applied.validation,browserQuality:applied.browserQuality,browserRepair:applied.browserRepair,sentinelReview:applied.sentinelReview,
      checkpointId:applied.checkpointId,technicalReply:result.replyText,autoApplied:true,
    };
    db.prepare(`INSERT INTO messages(id,conversation_id,sender,content,metadata_json,created_at) VALUES(?,?,'agent',?,?,?)`)
      .run(msgId,run.conversation_id,replyText,JSON.stringify(metadata),now);
    agentMessagePersisted=true;
  }catch(err:any){
    const lastStep=(RunService.trace(run.id) as any[]).slice(-1)[0];
    if(lastStep?.status==='running')RunService.finishStep(lastStep.id,controller.signal.aborted?'aborted':'failed',{error:String(err?.message||err)});
    try{RunService.finish(run.id,lastStep?.id||'',controller.signal.aborted?'aborted':'failed');}catch{}
    if(!agentMessagePersisted){
      const now=new Date().toISOString();
      const msgId=`msg-agent-${Date.now()}`;
      const detail=String(err?.message||err||'Falha ao continuar a execução.');
      const content=controller.signal.aborted?'A continuação foi interrompida. O progresso concluído continua salvo.':`Não consegui concluir a retomada com segurança. ${detail}`;
      const metadata={mode:'build',hasErrors:true,errorMessage:detail,runId:run.id,
        workflow:{runId:run.id,status:controller.signal.aborted?'aborted':'failed',trace:RunService.trace(run.id)},
        validation:err?.applyResult?.validation||null,browserQuality:err?.applyResult?.browserQuality||null,sentinelReview:err?.applyResult?.sentinelReview||null};
      db.prepare(`INSERT INTO messages(id,conversation_id,sender,content,metadata_json,created_at) VALUES(?,?,'agent',?,?,?)`)
        .run(msgId,run.conversation_id,content,JSON.stringify(metadata),now);
    }
  }finally{
    activeProjects.delete(run.project_id);
    activeProjectControllers.delete(run.project_id);
  }
});

router.post('/conversations/:projectId/apply-proposal', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  const projectId=req.params.projectId;
  let proposalMessage:any=null;
  let metadata:any=null;
  try{
    const {proposalId,summary='Alterações aprovadas pelo usuário'}=req.body;
    if(!proposalId)return res.status(400).json({error:'Identificador da proposta é obrigatório.'});

    const conversation=db.prepare('SELECT id FROM conversations WHERE project_id=? ORDER BY created_at DESC LIMIT 1').get(projectId) as any;
    const rows=conversation
      ? db.prepare("SELECT id,metadata_json FROM messages WHERE conversation_id=? AND sender='agent' ORDER BY created_at DESC").all(conversation.id) as any[]
      : [];
    proposalMessage=rows.find((row:any)=>{try{return JSON.parse(row.metadata_json||'{}')?.proposal?.id===proposalId;}catch{return false;}});
    if(!proposalMessage)return res.status(404).json({error:'Proposta não encontrada nesta conversa.'});

    metadata=JSON.parse(proposalMessage.metadata_json||'{}');
    if(metadata.proposal?.status!=='pending'){
      if(metadata.proposal?.status==='applied')return res.json({success:true,alreadyApplied:true,checkpointId:metadata.checkpointId||null});
      return res.status(409).json({error:`Esta proposta não está mais disponível (${metadata.proposal?.status||'estado inválido'}).`});
    }
    const files=metadata.proposal.files;
    if(!Array.isArray(files)||files.length===0)return res.status(409).json({error:'A proposta armazenada está vazia ou corrompida.'});

    for(const file of files){
      WorkspaceManager.resolveSafePath(projectId,file.path);
      if(!['create','update','delete','modify'].includes(file.action))return res.status(400).json({error:'A proposta contém uma ação de arquivo inválida.'});
      if(file.action!=='delete'&&typeof file.content!=='string')return res.status(400).json({error:'A proposta contém arquivo sem conteúdo válido.'});
    }

    if(conversation){
      db.prepare("INSERT INTO messages(id,conversation_id,sender,content,metadata_json,created_at) VALUES(?,?,'user',?,?,?)")
        .run('msg-user-'+Date.now(),conversation.id,'Pode aplicar essas alterações.',JSON.stringify({mode:'build',action:'apply_proposal',proposalId}),new Date().toISOString());
    }

    const sandboxRunId=metadata.workflow?.runId||metadata.runId||null;
    const sandboxApply=await SandboxProposalApplyService.apply({
      userId:req.user!.id,projectId,proposal:metadata.proposal,runId:sandboxRunId,
      planId:metadata.planId||null,summary,originalRequest:metadata.originalRequest||summary,
      shipRequested:Boolean(metadata.workflow?.shipRequested),
    });

    metadata.proposal.sandboxId=sandboxApply.sandboxId||metadata.proposal.sandboxId;
    metadata.validation=sandboxApply.validation||null;
    metadata.browserQuality=sandboxApply.browserQuality||null;
    metadata.browserRepair=sandboxApply.browserRepair||null;
    metadata.sentinelReview=sandboxApply.sentinelReview||null;
    metadata.hasErrors=!sandboxApply.success;

    if(!sandboxApply.success){
      metadata.proposal.status='failed_validation';
      metadata.errorMessage=sandboxApply.error;
      if(metadata.workflow&&sandboxRunId){
        metadata.workflow.status='failed';
        metadata.workflow.trace=RunService.trace(sandboxRunId);
      }
      db.prepare('UPDATE messages SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata),proposalMessage.id);
      return res.status(sandboxApply.statusCode||422).json({
        error:sandboxApply.error,validation:sandboxApply.validation,sandboxId:sandboxApply.sandboxId,
        repair:(sandboxApply as any).repair,browserQuality:sandboxApply.browserQuality,
        browserRepair:sandboxApply.browserRepair,sentinelReview:sandboxApply.sentinelReview,
      });
    }

    metadata.proposal.status='applied';
    metadata.checkpointId=sandboxApply.checkpointId;
    metadata.sandbox={id:sandboxApply.sandboxId,baseRevision:metadata.proposal.baseRevision,changedFiles:sandboxApply.changedFiles};
    metadata.hasErrors=false;
    delete metadata.errorMessage;
    if(metadata.workflow&&sandboxRunId){
      metadata.workflow.status=sandboxApply.needsVerification?'needs_verification':'completed';
      metadata.workflow.trace=RunService.trace(sandboxRunId);
    }
    db.prepare("UPDATE plans SET status='superseded',updated_at=? WHERE project_id=? AND status='draft'").run(new Date().toISOString(),projectId);
    db.prepare('UPDATE messages SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata),proposalMessage.id);

    if(conversation){
      const count=Array.isArray(sandboxApply.changedFiles)?sandboxApply.changedFiles.length:files.length;
      const finalText=`Pronto. As alterações foram revisadas e aplicadas ao preview${count?` em ${count} arquivo(s)`:''}.`;
      db.prepare("INSERT INTO messages(id,conversation_id,sender,content,metadata_json,created_at) VALUES(?,?,'agent',?,?,?)")
        .run('msg-agent-'+Date.now(),conversation.id,finalText,JSON.stringify({
          mode:'build',decisionType:'change',filesAffected:sandboxApply.changedFiles||[],checkpointId:sandboxApply.checkpointId,
          validation:sandboxApply.validation,browserQuality:sandboxApply.browserQuality,browserRepair:sandboxApply.browserRepair,
          sentinelReview:sandboxApply.sentinelReview,runId:sandboxRunId,
        }),new Date().toISOString());
    }

    return res.json({
      success:true,checkpointId:sandboxApply.checkpointId,validation:sandboxApply.validation,
      sandboxId:sandboxApply.sandboxId,changedFiles:sandboxApply.changedFiles,needsVerification:sandboxApply.needsVerification,
      repair:(sandboxApply as any).repair||undefined,browserQuality:sandboxApply.browserQuality,
      browserRepair:sandboxApply.browserRepair,sentinelReview:sandboxApply.sentinelReview,
      message:sandboxApply.needsVerification
        ? 'Alterações aplicadas com segurança; uma verificação opcional não estava disponível neste ambiente.'
        : 'Alterações revisadas e aplicadas com sucesso.',
    });
  }catch(err:any){
    if(proposalMessage&&metadata?.proposal){
      try{
        metadata.proposal.status='pending';
        metadata.hasErrors=true;
        metadata.errorMessage='A aplicação falhou de forma segura; o workspace oficial foi restaurado ou preservado no estado anterior. Você pode tentar novamente.';
        db.prepare('UPDATE messages SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata),proposalMessage.id);
      }catch{}
    }
    res.status(500).json({error:'A aplicação falhou de forma segura; o merge não foi concluído.'});
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
      return res.status(400).json({ error: 'O nome da skill é obrigatório.' });
    }
    if (!system_instructions || !system_instructions.trim()) {
      return res.status(400).json({ error: 'As instruções do sistema para o agente são obrigatórias.' });
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
  if(!skill)return res.status(404).json({error:'Skill não encontrada.'});
  const {name,description,system_instructions,scope}=req.body;
  if(typeof name!=='string'||!name.trim()||typeof system_instructions!=='string'||!system_instructions.trim()||!['message','project','workspace'].includes(scope))return res.status(400).json({error:'Nome, instruções e escopo válidos são obrigatórios.'});
  db.prepare('UPDATE skills SET name=?,description=?,system_instructions=?,scope=? WHERE id=? AND user_id=?').run(name.trim(),String(description||''),system_instructions.trim(),scope,req.params.id,req.user!.id);
  res.json({success:true});
});

router.delete('/skills/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params.id) as any;
    if (!skill) return res.status(404).json({ error: 'Skill não encontrada.' });
    if (skill.user_id !== req.user!.id) {
      return res.status(403).json({ error: 'Sem permissão para excluir esta skill.' });
    }

    // Delete canonical copy first so a refresh cannot resurrect the skill.
    await CloudSyncService.deleteSkill(req.user!.id, req.params.id);
    db.prepare('DELETE FROM skills WHERE id = ? AND user_id = ?').run(req.params.id, req.user!.id);
    res.json({ success: true, message: 'Skill excluída com sucesso.' });
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
    if (!providerKey) return res.status(400).json({ error: 'providerKey obrigatório.' });

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
      message: 'Configurações de IA e chave de API salvas com sucesso!',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/providers/update', requireAuth, (req: Request, res: Response) => {
  try {
    const { providerKey, baseUrl, modelId } = req.body;
    if (!providerKey) return res.status(400).json({ error: 'providerKey obrigatório.' });

    db.prepare('UPDATE providers SET base_url = COALESCE(?, base_url), model_id = COALESCE(?, model_id) WHERE provider_key = ? AND user_id = ?').run(
      baseUrl || null,
      modelId || null,
      providerKey, req.user!.id
    );

    res.json({ success: true, message: 'Configuração atualizada com sucesso.' });
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
  res.status(501).json({error:'Executor isolado não configurado. Comandos no servidor compartilhado não estão habilitados.'});
});

// ==========================================
// 9. LIVE PREVIEW SANDBOX (PUBLIC SERVING FOR IFRAME)
// ==========================================

router.get('/projects/:projectId/preview/status', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  repairLegacyProjectText(req.params.projectId);
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
  if (!proposalId) return res.status(400).json({ error: 'Identificador da proposta é obrigatório.' });
  const conversation = db.prepare('SELECT id FROM conversations WHERE project_id=? ORDER BY created_at DESC LIMIT 1').get(req.params.projectId) as any;
  const rows = conversation ? db.prepare("SELECT id,metadata_json FROM messages WHERE conversation_id=? AND sender='agent' ORDER BY created_at DESC").all(conversation.id) as any[] : [];
  const row = rows.find(item => { try { return JSON.parse(item.metadata_json || '{}')?.proposal?.id === proposalId; } catch { return false; } });
  if (!row) return res.status(404).json({ error: 'Proposta não encontrada.' });
  const metadata = JSON.parse(row.metadata_json || '{}');
  if (metadata.proposal.status !== 'pending') return res.status(409).json({ error: 'Esta proposta já foi encerrada.' });
  metadata.proposal.status = 'rejected';
  const workflowRunId = metadata.workflow?.runId || metadata.runId || null;
  if (workflowRunId) {
    ContextEngineV2.recordCommit({ projectId: req.params.projectId, runId: workflowRunId, agentKey: 'PROGRAM', scope: 'TASK', task: 'Proposta rejeitada pelo usuário', decisions: ['Usuário rejeitou a proposta antes da aplicação'], changedFiles: [], requirementIds: workflowRequirementIds(req.params.projectId, workflowRunId, metadata.planId || null), validation: null, blockers: [], nextState: { status: 'rejected' } });
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
function publicBrowserQuality(result:any){
  if(!result)return result;
  return {
    ...result,
    viewports:Array.isArray(result.viewports)
      ? result.viewports.map(({screenshotPath:_screenshotPath,...viewport}:any)=>viewport)
      : [],
  };
}

router.post('/projects/:projectId/browser-quality/run',requireAuth,requireProjectOwner,async(req:Request,res:Response)=>{
  try{
    const sandboxId=String(req.body?.sandboxId||'');
    if(!sandboxId)return res.status(400).json({error:'sandboxId é obrigatório.'});
    const result=await BrowserQualityService.inspect({
      userId:req.user!.id,
      projectId:req.params.projectId,
      sandboxId,
      runId:req.body?.runId?String(req.body.runId):null,
      stepId:req.body?.stepId?String(req.body.stepId):null,
      entryPath:req.body?.entryPath?String(req.body.entryPath):undefined,
    });
    res.status(result.status==='failed'?422:200).json({success:result.status!=='failed',quality:publicBrowserQuality(result)});
  }catch(error:any){
    res.status(error?.code==='sandbox_forbidden'?403:500).json({error:String(error?.message||error)});
  }
});

router.get('/projects/:projectId/browser-quality/:qualityRunId',requireAuth,requireProjectOwner,(req:Request,res:Response)=>{
  const result=BrowserQualityService.get(req.params.qualityRunId);
  if(!result||result.projectId!==req.params.projectId)return res.status(404).json({error:'Browser quality run não encontrado.'});
  const sandbox=SandboxManager.get(result.sandboxId);
  if(!sandbox||sandbox.userId!==req.user!.id)return res.status(404).json({error:'Browser quality run não encontrado.'});
  res.json({success:true,quality:publicBrowserQuality(result)});
});

router.get('/projects/:projectId/browser-quality/:qualityRunId/screenshot/:viewport',requireAuth,requireProjectOwner,(req:Request,res:Response)=>{
  const file=BrowserQualityService.screenshotPath(req.params.qualityRunId,req.params.viewport,req.user!.id,req.params.projectId);
  if(!file)return res.status(404).json({error:'Screenshot não encontrado.'});
  res.setHeader('Cache-Control','private, no-store');
  res.sendFile(file);
});

router.get('/projects/:projectId/proposals/:proposalId/preview/status',requireAuth,requireProjectOwner,(req,res)=>{const proposal=findPendingProposal(req.params.projectId,req.params.proposalId);if(!proposal)return res.status(404).json({status:'error',message:'Proposta temporária não encontrada.'});const entry=proposal.files.find((f:any)=>f.action!=='delete'&&/(^|\/)index\.html$/i.test(f.path))?.path||WorkspaceManager.getPreviewInfo(req.params.projectId).entryPath;if(!entry)return res.status(422).json({status:'error',message:'A proposta não possui um arquivo HTML de entrada.'});res.json({status:'running',entryPath:entry,message:'Preview temporário da proposta.'});});
router.get('/preview-proposal/:projectId/:proposalId/*',requireAuth,requireProjectOwner,(req,res)=>{const proposal=findPendingProposal(req.params.projectId,req.params.proposalId);if(!proposal)return res.status(404).send('Proposta temporária não encontrada.');const preview=WorkspaceManager.getPreviewInfo(req.params.projectId),requested=path.normalize(req.params[0]||proposal.files.find((f:any)=>/(^|\/)index\.html$/i.test(f.path))?.path||preview.entryPath||'index.html').replace(/^(\.\.[\/\\])+/, '').replace(/\\/g,'/');const proposed=proposal.files.find((f:any)=>f.path.replace(/\\/g,'/')===requested);if(proposed?.action==='delete')return res.status(404).end();res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Content-Security-Policy',"sandbox allow-scripts; default-src 'self' https: data: blob:; script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; connect-src 'self' https: wss:; form-action 'none'");if(proposed){res.type(path.extname(requested)||'text/plain').send(proposed.content);return;}const fallback=WorkspaceManager.resolveSafePath(req.params.projectId,requested);if(!fs.existsSync(fallback)||fs.statSync(fallback).isDirectory())return res.status(404).end();res.sendFile(fallback);});

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




