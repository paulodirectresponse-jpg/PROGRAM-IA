import { IntegrationService, integrationFields } from './services/integrationService.js';
import { verifyFirebaseIdentity } from './services/firebaseIdentity.js';
import express, { Request, Response, NextFunction } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { db } from './db/index.js';
import { AuthService, AuthUser } from './services/authService.js';
import { SecretService } from './services/secretService.js';
import { WorkspaceManager } from './services/workspaceManager.js';
import { LLMAdapterService, AgentMode } from './services/llmAdapter.js';
import { GitHubService } from './services/githubService.js';
import { DesktopService } from './services/desktopService.js';

export const router = express.Router();
const activeProjects = new Set<string>();

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
      if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
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
    const { user, session } = AuthService.firebaseLogin(identity.email, identity.name, identity.uid, req.headers['user-agent'], req.ip);

    res.cookie('forge_session', session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    res.json({ success: true, user });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/auth/me', (req: Request, res: Response) => {
  if (!req.user) {
    return res.json({ authenticated: false, user: null });
  }
  res.json({ authenticated: true, user: req.user });
});

router.post('/auth/logout', (req: Request, res: Response) => {
  const token = req.cookies?.['forge_session'] || (req.headers.authorization?.replace('Bearer ', ''));
  if (token) {
    AuthService.logout(token);
  }
  res.clearCookie('forge_session', { path: '/' });
  res.json({ success: true });
});

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
    db.prepare('UPDATE providers SET connection_status = ? WHERE user_id = ? AND provider_key = ?').run(result.success?'connected':'error', req.user!.id, providerKey);
    res.json(result);
  } catch { res.status(400).json({success:false,message:'Falha ao testar o provedor.'}); }
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

router.post('/secrets/test', requireAuth, async (req: Request, res: Response) => {
  try {
    const { providerKey, secretValue, baseUrl, modelId } = req.body;
    if (!providerKey) {
      return res.status(400).json({ error: 'Provedor é obrigatório para teste.' });
    }

    const result = await SecretService.testConnection(req.user!.id, providerKey, {
      apiKey: secretValue,
      baseUrl,
      modelId,
    });

    res.json(result);
  } catch (err: any) {
    res.status(500).json({
      success: false,
      code: 'network_error',
      message: `Erro interno ao testar conexão: ${err.message}`,
    });
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
    const { name, description, origin = 'novo', repo_url = '', branch = 'main', initialFiles = {} } = req.body;
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'O nome do projeto é obrigatório.' });
    }

    const projectId = 'proj-' + Date.now();
    const now = new Date().toISOString();
    let effectiveBranch = branch || 'main';
    const userId = req.user!.id;

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
        ) VALUES (?, ?, 'ws-default', ?, ?, ?, ?, ?, 'active', 'prov-useoneai', 'chatgpt-5.5', ?, ?)
      `).run(projectId, userId, name.trim(), description || `Importado de ${repo_url}`, origin, repo_url.trim(), effectiveBranch, now, now);

      // Write text files
      if (importResult.files) {
        for (const [filePath, content] of Object.entries(importResult.files)) {
          WorkspaceManager.writeFile(projectId, filePath, content);
        }
      }

      // Write binary assets (images, fonts)
      if (importResult.binaryFiles) {
        for (const [filePath, buf] of Object.entries(importResult.binaryFiles)) {
          WorkspaceManager.writeBinaryFile(projectId, filePath, buf);
        }
      }

      db.prepare(`
        INSERT INTO branches (id, project_id, name, is_current, head_commit_hash, created_at)
        VALUES (?, ?, ?, 1, 'head-import', ?)
      `).run('br-' + Date.now(), projectId, effectiveBranch, now);

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
      return res.json({ success: true, projectId });
    }

    // 2. LOCAL / ZIP FILE IMPORT
    if (origin === 'local' && initialFiles && Object.keys(initialFiles).length > 0) {
      db.prepare(`
        INSERT INTO projects (
          id, user_id, workspace_id, name, description, origin, repo_url, branch, status, provider_id, model_id, created_at, updated_at
        ) VALUES (?, ?, 'ws-default', ?, ?, ?, '', 'main', 'active', 'prov-useoneai', 'chatgpt-5.5', ?, ?)
      `).run(projectId, userId, name.trim(), description || 'Importado de arquivo ZIP', origin, now, now);

      for (const [filePath, content] of Object.entries(initialFiles)) {
        if (typeof content === 'string') {
          WorkspaceManager.writeFile(projectId, filePath, content);
        }
      }

      db.prepare(`
        INSERT INTO branches (id, project_id, name, is_current, head_commit_hash, created_at)
        VALUES (?, ?, 'main', 1, 'head-zip', ?)
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
        `Arquivo **${name}** extraído com sucesso!\n\nForam criados **${Object.keys(initialFiles).length} arquivos** no workspace.`,
        JSON.stringify({ isWelcome: true, mode: 'auto' }),
        now
      );

      WorkspaceManager.createCheckpoint(projectId, 'Importação de Arquivo ZIP', `Extração de ${Object.keys(initialFiles).length} arquivos`);
      return res.json({ success: true, projectId });
    }

    // 3. NEW PROJECT FROM SCRATCH
    db.prepare(`
      INSERT INTO projects (
        id, user_id, workspace_id, name, description, origin, repo_url, branch, status, provider_id, model_id, created_at, updated_at
      ) VALUES (?, ?, 'ws-default', ?, ?, 'novo', '', 'main', 'active', 'prov-useoneai', 'chatgpt-5.5', ?, ?)
    `).run(projectId, userId, name.trim(), description || 'Novo projeto Forge Agent', now, now);

    db.prepare(`
      INSERT INTO branches (id, project_id, name, is_current, head_commit_hash, created_at)
      VALUES (?, ?, 'main', 1, 'head-init', ?)
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

    res.json({ success: true, projectId });
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

    // 6. Delete physical workspace directory
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

    db.prepare(`
      INSERT INTO projects (
        id, user_id, workspace_id, name, description, origin, repo_url, branch, status, provider_id, model_id, created_at, updated_at
      ) VALUES (?, ?, 'ws-default', ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(
      newId,
      req.user!.id,
      newName,
      source.description,
      source.origin || 'novo',
      source.repo_url || '',
      source.branch || 'main',
      source.provider_id || 'prov-useoneai',
      source.model_id || 'chatgpt-5.5',
      now,
      now
    );

    WorkspaceManager.duplicateProject(sourceId, newId);

    db.prepare(`
      INSERT INTO branches (id, project_id, name, is_current, head_commit_hash, created_at)
      VALUES (?, ?, ?, 1, 'head-dup', ?)
    `).run('br-' + Date.now(), newId, source.branch || 'main', now);

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

router.get('/conversations/:projectId', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  try {
    const conversation = db.prepare('SELECT * FROM conversations WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(req.params.projectId) as any;
    if (!conversation) {
      return res.status(404).json({ error: 'Conversa não encontrada.' });
    }

    const messages = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversation.id);
    const activePlan = db.prepare('SELECT * FROM plans WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(req.params.projectId);

    res.json({ conversation, messages, activePlan });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/conversations/:projectId/messages', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  if (activeProjects.has(req.params.projectId)) return res.status(409).json({error:'Já há uma execução neste projeto. Aguarde ou cancele antes de enviar outro pedido.'});
  activeProjects.add(req.params.projectId);
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    const { content, mode = 'auto', appliedSkills = [] } = req.body;
    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Conteúdo da mensagem obrigatório.' });
    }

    const projectId = req.params.projectId;
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
      db.prepare('UPDATE conversations SET mode = ?, updated_at = ? WHERE id = ?').run(mode, now, conv.id);
    }

    // Save user message
    const userMsgId = 'msg-user-' + Date.now();
    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender, content, metadata_json, created_at)
      VALUES (?, ?, 'user', ?, ?, ?)
    `).run(userMsgId, conv.id, content, JSON.stringify({ mode, appliedSkills }), now);

    const history = db.prepare('SELECT sender, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20').all(conv.id).reverse() as any[];
    const existingFiles = WorkspaceManager.getAllFilesContent(projectId);

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    const providerRow = db.prepare('SELECT provider_key FROM providers WHERE id = ? AND user_id = ?').get(project?.provider_id || '', req.user!.id) as any;
    const providerKey = providerRow?.provider_key || 'useoneai';
    const modelId = providerRow ? project?.model_id : undefined;

    // Call LLM Adapter with authenticated userId
    let result = await LLMAdapterService.executePrompt({
      prompt: content,
      mode: mode as AgentMode,
      projectId,
      providerKey,
      modelId,
      existingFiles,
      appliedSkills,
      conversationHistory: history,
      userId: req.user!.id,
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    if (JSON.stringify(WorkspaceManager.getAllFilesContent(projectId)) !== JSON.stringify(existingFiles)) {
      return res.status(409).json({error:'Os arquivos mudaram durante a revisão. Envie novamente para usar a versão atual.'});
    }

    let checkpointCreatedId: string | null = null;

    // STRICT SAFETY CHECK:
    // Fallback mode or invalid responses NEVER apply code or create checkpoints!
    const canApplyFiles =
      !result.isDemonstrativeFallback &&
      !result.hasErrors &&
      result.decisionType !== 'invalid_response' &&
      result.decisionType !== 'blocked_no_provider';

    if (canApplyFiles && result.build?.files?.length && (mode === 'build' || mode === 'auto') && !result.proposal?.requiresConfirmation) {
      for (const file of result.build.files) WorkspaceManager.resolveSafePath(projectId, file.path);
      WorkspaceManager.createCheckpoint(projectId, `Antes: ${content.slice(0, 60)}`, 'Ponto de restauração antes da alteração.');
    }
    if (canApplyFiles) {
      if (mode === 'build' && !result.proposal?.requiresConfirmation && result.build?.files && result.build.files.length > 0) {
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
          result.build.summary || 'Alterações validadas e aplicadas no workspace'
        );
      } else if (mode === 'auto' && result.build?.files && !result.proposal?.requiresConfirmation) {
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
          result.build.summary || 'Alterações aplicadas automaticamente'
        );
      }
    }

    // Save plan if generated
    let savedPlanId: string | null = null;
    if (result.plan) {
      savedPlanId = 'plan-' + Date.now();
      db.prepare(`
        INSERT INTO plans (
          id, task_id, project_id, objective, scope_in, scope_out, files_affected_json, integrations_json, risks_json, acceptance_criteria_json, status, created_at, updated_at
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
      `).run(
        savedPlanId,
        projectId,
        result.plan.objective,
        result.plan.scope_in,
        result.plan.scope_out,
        JSON.stringify(result.plan.files_affected || []),
        JSON.stringify(result.plan.integrations || []),
        JSON.stringify(result.plan.risks || []),
        JSON.stringify(result.plan.acceptance_criteria || []),
        now,
        now
      );
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
    };

    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender, content, metadata_json, created_at)
      VALUES (?, ?, 'agent', ?, ?, ?)
    `).run(agentMsgId, conv.id, result.replyText, JSON.stringify(metadata), now);

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
    if (!res.destroyed) res.status(500).json({ error: err.message });
  } finally { activeProjects.delete(req.params.projectId); }
});

router.post('/conversations/:projectId/apply-proposal', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  try {
    const { files, summary = 'Alterações aprovadas pelo usuário' } = req.body;
    const projectId = req.params.projectId;

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'Lista de arquivos proposta inválida ou vazia.' });
    }

    for (const file of files) {
      WorkspaceManager.resolveSafePath(projectId, file.path);
      if (!['create', 'update', 'delete', 'modify'].includes(file.action) || (file.action !== 'delete' && typeof file.content !== 'string')) return res.status(400).json({error:'Arquivo proposto inválido.'});
    }
    WorkspaceManager.createCheckpoint(projectId, `Antes: ${summary.slice(0, 60)}`);
    for (const file of files) {
      if (file.action === 'delete') {
        WorkspaceManager.deleteFile(projectId, file.path);
      } else if (typeof file.content === 'string') {
        WorkspaceManager.writeFile(projectId, file.path, file.content);
      }
    }

    const checkpointId = WorkspaceManager.createCheckpoint(projectId, summary.slice(0, 100), summary);
    res.json({ success: true, checkpointId, message: 'Alterações aplicadas com sucesso ao workspace.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/projects/:id/github/pull', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    if (!project.repo_url) return res.status(400).json({ error: 'Projeto não possui URL do GitHub vinculada.' });

    const parsed = GitHubService.parseRepoUrl(project.repo_url);
    if (!parsed) return res.status(400).json({ error: 'URL do repositório inválida.' });

    const result = await GitHubService.importRepoFiles(parsed.owner, parsed.repo, project.branch || 'main', req.user!.id);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    if (result.files) {
      for (const [filePath, content] of Object.entries(result.files)) {
        WorkspaceManager.writeFile(projectId, filePath, content);
      }
    }
    if (result.binaryFiles) {
      for (const [filePath, buf] of Object.entries(result.binaryFiles)) {
        WorkspaceManager.writeBinaryFile(projectId, filePath, buf);
      }
    }

    const cpId = WorkspaceManager.createCheckpoint(projectId, `Git Pull: ${project.branch}`, `Sincronizados ${result.filesCount} arquivos`);
    res.json({ success: true, count: result.filesCount, checkpointId: cpId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/projects/:id/github/push', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id;
    const { commitMessage, commitDescription } = req.body;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    if (!project.repo_url) return res.status(400).json({ error: 'Projeto não possui URL do GitHub vinculada.' });

    const parsed = GitHubService.parseRepoUrl(project.repo_url);
    if (!parsed) return res.status(400).json({ error: 'URL do repositório inválida.' });

    const files = WorkspaceManager.getAllFilesContent(projectId);
    const result = await GitHubService.pushFilesToRepo({
      userId: req.user!.id,
      owner: parsed.owner,
      repo: parsed.repo,
      branch: project.branch || 'main',
      commitMessage: commitMessage || 'Alterações aplicadas via Forge Agent',
      files,
    });

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    // Update local head commit hash
    if (result.commitSha) {
      db.prepare('UPDATE branches SET head_commit_hash = ? WHERE project_id = ? AND name = ?').run(
        result.commitSha,
        projectId,
        project.branch || 'main'
      );
    }

    // Create named checkpoint on GitHub push for full rollback control
    const cpTitle = commitMessage ? `GitHub Push: ${commitMessage}` : 'GitHub Push: Atualização remota';
    const cpDesc = commitDescription || `Commit ${result.commitSha ? result.commitSha.slice(0, 7) : 'recente'} enviado para branch ${project.branch || 'main'}`;
    const cpId = WorkspaceManager.createCheckpoint(projectId, cpTitle, cpDesc);

    res.json({ success: true, commitSha: result.commitSha, checkpointId: cpId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/projects/:id/github/status', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as any;
    if (!project || !project.repo_url) {
      return res.json({ connected: false, message: 'Repositório GitHub não vinculado.' });
    }
    const parsed = GitHubService.parseRepoUrl(project.repo_url);
    if (!parsed) {
      return res.json({ connected: false, message: 'URL do repositório inválida.' });
    }

    const syncRes = await GitHubService.getSyncStatus({
      userId: req.user!.id,
      projectId: req.params.id,
      owner: parsed.owner,
      repo: parsed.repo,
      branch: project.branch || 'main',
    });

    res.json({
      connected: true,
      repoUrl: project.repo_url,
      branch: project.branch || 'main',
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
    if (!project || !project.repo_url) {
      return res.status(400).json({ error: 'Repositório GitHub não vinculado.' });
    }
    const parsed = GitHubService.parseRepoUrl(project.repo_url);
    if (!parsed) return res.status(400).json({ error: 'URL do repositório inválida.' });

    const result = await GitHubService.listBranches(parsed.owner, parsed.repo, req.user!.id);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/projects/:id/github/branch', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  try {
    const { newBranch, fromBranch } = req.body;
    if (!newBranch) return res.status(400).json({ error: 'Nome da nova branch é obrigatório.' });

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as any;
    if (!project || !project.repo_url) {
      return res.status(400).json({ error: 'Repositório GitHub não vinculado.' });
    }
    const parsed = GitHubService.parseRepoUrl(project.repo_url);
    if (!parsed) return res.status(400).json({ error: 'URL do repositório inválida.' });

    const baseBranch = fromBranch || project.branch || 'main';
    const result = await GitHubService.createBranch({
      userId: req.user!.id,
      owner: parsed.owner,
      repo: parsed.repo,
      newBranch: newBranch.trim(),
      fromBranch: baseBranch,
    });

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    const now = new Date().toISOString();
    db.prepare('UPDATE projects SET branch = ?, updated_at = ? WHERE id = ?').run(newBranch.trim(), now, req.params.id);
    db.prepare(`
      INSERT INTO branches (id, project_id, name, is_current, head_commit_hash, created_at)
      VALUES (?, ?, ?, 1, 'head-new', ?)
    `).run('br-' + Date.now(), req.params.id, newBranch.trim(), now);

    res.json({ success: true, branch: newBranch.trim() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/projects/:id/github/pull-request', requireAuth, requireProjectOwner, async (req: Request, res: Response) => {
  try {
    const { title, base = 'main', body } = req.body;
    if (!title) return res.status(400).json({ error: 'Título do Pull Request é obrigatório.' });

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as any;
    if (!project || !project.repo_url) {
      return res.status(400).json({ error: 'Repositório GitHub não configurado.' });
    }
    const parsed = GitHubService.parseRepoUrl(project.repo_url);
    if (!parsed) return res.status(400).json({ error: 'URL do repositório inválida.' });

    const headBranch = project.branch || 'main';
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

    res.json(result);
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

    const now = new Date().toISOString();
    db.prepare('UPDATE projects SET repo_url = ?, branch = ?, updated_at = ? WHERE id = ?').run(
      repoUrl.trim(),
      branch.trim(),
      now,
      req.params.id
    );

    res.json({ success: true, repoUrl: repoUrl.trim(), branch: branch.trim() });
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

router.delete('/skills/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params.id) as any;
    if (!skill) return res.status(404).json({ error: 'Skill não encontrada.' });
    if (skill.user_id !== req.user!.id) {
      return res.status(403).json({ error: 'Sem permissão para excluir esta skill.' });
    }

    db.prepare('DELETE FROM skills WHERE id = ?').run(req.params.id);
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
    const providers = db.prepare('SELECT id, provider_key, name, base_url, model_id, is_configured, connection_status, context_limit, created_at FROM providers WHERE user_id = ?').all(req.user!.id) as any[];

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

    db.prepare(`
      UPDATE providers
      SET base_url = COALESCE(?, base_url),
          model_id = COALESCE(?, model_id),
          is_configured = ?,
          connection_status = ?
      WHERE provider_key = ? AND user_id = ?
    `).run(
      baseUrl || null,
      modelId || null,
      hasKey ? 1 : 0,
      hasKey ? 'configured' : 'not_configured',
      providerKey, req.user!.id
    );

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

router.get('/preview/:projectId/*', requireAuth, requireProjectOwner, (req: Request, res: Response) => {
  const projectId = req.params.projectId;
  const projectDir = WorkspaceManager.getProjectDir(projectId);

  const requestedFile = req.params[0] || 'index.html';
  const safeRel = path.normalize(requestedFile).replace(/^(\.\.[\/\\])+/, '');
  let filePath = path.join(projectDir, safeRel);

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(projectDir, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Preview não disponível para este projeto.');
  }

  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (!filePath.startsWith(projectDir + path.sep)) return res.status(403).end();
  res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'self' https: data: blob:; script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; connect-src 'none'; form-action 'none'");
  res.sendFile(filePath);
});


