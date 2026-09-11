import express, { Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { db } from './db/index.js';
import { WorkspaceManager } from './services/workspaceManager.js';
import { LLMAdapterService } from './services/llmAdapter.js';
import { GitHubService } from './services/githubService.js';

export const router = express.Router();

// ==========================================
// 1. PROJECTS API
// ==========================================

router.get('/projects', (req: Request, res: Response) => {
  try {
    const projects = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
    res.json({ projects });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/projects', (req: Request, res: Response) => {
  try {
    const { name, description, origin, repo_url, template } = req.body;
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'O nome do projeto é obrigatório.' });
    }

    const projectId = 'proj-' + Date.now();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO projects (
        id, workspace_id, name, description, origin, repo_url, branch, status, provider_id, model_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'main', 'active', 'prov-useoneai', 'chatgpt-5.5', ?, ?)
    `).run(
      projectId,
      'ws-default',
      name.trim(),
      description || 'Novo projeto Forge Agent',
      origin || 'novo',
      repo_url || '',
      now,
      now
    );

    // Initial project source
    db.prepare(`
      INSERT INTO project_sources (id, project_id, type, original_path_or_url, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('src-' + Date.now(), projectId, origin || 'scratch', repo_url || 'local', now);

    // Main branch
    db.prepare(`
      INSERT INTO branches (id, project_id, name, is_current, head_commit_hash, created_at)
      VALUES (?, ?, 'main', 1, 'head-init', ?)
    `).run('br-' + Date.now(), projectId, now);

    // Initial conversation
    const convId = 'conv-' + Date.now();
    db.prepare(`
      INSERT INTO conversations (id, project_id, title, mode, created_at, updated_at)
      VALUES (?, ?, 'Planejamento Inicial', 'plan', ?, ?)
    `).run(convId, projectId, now, now);

    // Welcome message
    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender, content, metadata_json, created_at)
      VALUES (?, ?, 'agent', ?, ?, ?)
    `).run(
      'msg-' + Date.now(),
      convId,
      'agent',
      `Projeto **${name}** inicializado!\n\nDescreva em linguagem natural o que deseja construir. Estou no modo **Planejar** para elaborar os critérios de aceite e arquitetura antes de aplicar qualquer código.`,
      JSON.stringify({ isWelcome: true }),
      now
    );

    // Populate initial starter files in workspace
    const projectDir = WorkspaceManager.getProjectDir(projectId);
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
        Envie sua primeira instrução no painel ao lado. Seus arquivos serão atualizados e renderizados aqui em tempo real.
      </p>
    </div>
  </div>
  <footer class="text-center text-xs text-slate-500">Forge Agent Live Preview Sandbox</footer>
</body>
</html>`;

    WorkspaceManager.writeFile(projectId, 'index.html', initialHtml);

    // Initial checkpoint
    WorkspaceManager.createCheckpoint(projectId, 'Criação do Projeto', 'Setup inicial do workspace');

    // Audit log
    db.prepare(`
      INSERT INTO audit_events (id, user_id, project_id, action, details_json, created_at)
      VALUES (?, 'user-default', ?, 'create_project', ?, ?)
    `).run('audit-' + Date.now(), projectId, JSON.stringify({ name, origin }), now);

    res.json({ success: true, projectId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/projects/:id', (req: Request, res: Response) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }

    const branches = db.prepare('SELECT * FROM branches WHERE project_id = ?').all(req.params.id);
    const checkpoints = db.prepare('SELECT id, title, description, parent_id, created_at FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC').all(req.params.id);
    const verifications = db.prepare('SELECT * FROM verifications WHERE project_id = ? ORDER BY created_at DESC LIMIT 10').all(req.params.id);

    res.json({ project, branches, checkpoints, verifications });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Files in project workspace
router.get('/projects/:id/files', (req: Request, res: Response) => {
  try {
    const files = WorkspaceManager.getFiles(req.params.id);
    res.json({ files });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/projects/:id/files/content', (req: Request, res: Response) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: 'Parâmetro path ausente.' });
    const content = WorkspaceManager.readFile(req.params.id, filePath);
    if (content === null) {
      return res.status(404).json({ error: 'Arquivo não encontrado.' });
    }
    res.json({ path: filePath, content });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/projects/:id/files', (req: Request, res: Response) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) {
      return res.status(400).json({ error: 'Campos path e content são obrigatórios.' });
    }
    WorkspaceManager.writeFile(req.params.id, filePath, content);
    // Create checkpoint on manual edit
    const cpId = WorkspaceManager.createCheckpoint(req.params.id, `Edição manual: ${filePath}`);
    res.json({ success: true, checkpointId: cpId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Checkpoints and Rollback
router.get('/projects/:id/checkpoints', (req: Request, res: Response) => {
  try {
    const checkpoints = db.prepare('SELECT id, title, description, parent_id, created_at FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC').all(req.params.id);
    res.json({ checkpoints });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/projects/:id/checkpoints/:checkpointId/restore', (req: Request, res: Response) => {
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

// Verifications
router.get('/projects/:id/verifications', (req: Request, res: Response) => {
  try {
    const verifications = db.prepare('SELECT * FROM verifications WHERE project_id = ? ORDER BY created_at DESC LIMIT 15').all(req.params.id);
    res.json({ verifications });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2. CONVERSATIONS & CHAT API
// ==========================================

router.get('/conversations/:projectId', (req: Request, res: Response) => {
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

router.post('/conversations/:projectId/messages', async (req: Request, res: Response) => {
  try {
    const { content, mode = 'plan', appliedSkills = [] } = req.body;
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

    // Fetch conversation history
    const history = db.prepare('SELECT sender, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 10').all(conv.id) as any[];

    // Fetch existing files
    const existingFiles = WorkspaceManager.getAllFilesContent(projectId);

    // Call LLM Adapter (OpenAI-compatible / Gemini / Fallback Demonstrativo)
    const result = await LLMAdapterService.executePrompt({
      prompt: content,
      mode,
      projectId,
      existingFiles,
      appliedSkills,
      conversationHistory: history,
    });

    // If result generated code in Build mode, apply it directly!
    let checkpointCreatedId: string | null = null;
    if (result.build && result.build.files && result.build.files.length > 0) {
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
        result.build.summary || 'Alterações aplicadas automaticamente pelo Forge Agent'
      );
    }

    // If result generated a plan in Plan mode, save it
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
        JSON.stringify(result.plan.files_affected),
        JSON.stringify(result.plan.integrations),
        JSON.stringify(result.plan.risks),
        JSON.stringify(result.plan.acceptance_criteria),
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
      filesAffected: result.build?.files?.map(f => f.path) || result.plan?.files_affected || [],
    };

    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender, content, metadata_json, created_at)
      VALUES (?, ?, 'agent', ?, ?, ?)
    `).run(agentMsgId, conv.id, result.replyText, JSON.stringify(metadata), now);

    res.json({
      success: true,
      agentMessage: {
        id: agentMsgId,
        sender: 'agent',
        content: result.replyText,
        metadata,
        created_at: now,
      },
      plan: result.plan,
      build: result.build,
      checkpointId: checkpointCreatedId,
    });
  } catch (err: any) {
    console.error('Erro na rota de mensagens:', err);
    res.status(500).json({ error: err.message });
  }
});

// Approve plan and trigger build
router.post('/conversations/:projectId/plan/approve', async (req: Request, res: Response) => {
  try {
    const { planId } = req.body;
    const now = new Date().toISOString();

    const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND project_id = ?').get(planId, req.params.projectId) as any;
    if (!plan) {
      return res.status(404).json({ error: 'Plano não encontrado.' });
    }

    db.prepare('UPDATE plans SET status = "approved", updated_at = ? WHERE id = ?').run(now, planId);

    // Switch conversation to build mode and trigger implementation
    const existingFiles = WorkspaceManager.getAllFilesContent(req.params.projectId);
    const buildResult = await LLMAdapterService.executePrompt({
      prompt: `Plano aprovado: ${plan.objective}. Escopo: ${plan.scope_in}. Implemente o código correspondente.`,
      mode: 'build',
      projectId: req.params.projectId,
      existingFiles,
      appliedSkills: ['typescript-react', 'ui-premium'],
      conversationHistory: [],
    });

    let checkpointId: string | null = null;
    if (buildResult.build && buildResult.build.files) {
      for (const file of buildResult.build.files) {
        WorkspaceManager.writeFile(req.params.projectId, file.path, file.content);
      }
      checkpointId = WorkspaceManager.createCheckpoint(
        req.params.projectId,
        `Build de Plano Aprovado`,
        plan.objective
      );
    }

    const conv = db.prepare('SELECT id FROM conversations WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(req.params.projectId) as any;
    if (conv) {
      db.prepare(`
        INSERT INTO messages (id, conversation_id, sender, content, metadata_json, created_at)
        VALUES (?, ?, 'agent', ?, ?, ?)
      `).run(
        'msg-agent-' + Date.now(),
        conv.id,
        `✅ **Plano Aprovado!** O código foi gerado e aplicado no workspace.\n\nO preview foi atualizado e o checkpoint \`${checkpointId || 'novo'}\` foi salvo com sucesso.`,
        JSON.stringify({ planId, checkpointId, mode: 'build' }),
        now
      );
    }

    res.json({ success: true, message: 'Plano aprovado e executado com sucesso.', checkpointId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. PROVIDERS & MODELS API
// ==========================================

router.get('/providers', (req: Request, res: Response) => {
  try {
    const providers = db.prepare('SELECT id, provider_key, name, base_url, model_id, is_configured, connection_status, context_limit, created_at FROM providers').all();
    res.json({ providers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/providers/update', (req: Request, res: Response) => {
  try {
    const { providerKey, baseUrl, modelId } = req.body;
    if (!providerKey) return res.status(400).json({ error: 'providerKey obrigatório.' });

    db.prepare('UPDATE providers SET base_url = COALESCE(?, base_url), model_id = COALESCE(?, model_id) WHERE provider_key = ?').run(
      baseUrl || null,
      modelId || null,
      providerKey
    );

    res.json({ success: true, message: 'Configuração atualizada com sucesso.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. SKILLS API
// ==========================================

router.get('/skills', (req: Request, res: Response) => {
  try {
    const skills = db.prepare('SELECT * FROM skills ORDER BY name ASC').all();
    res.json({ skills });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/skills/toggle', (req: Request, res: Response) => {
  try {
    const { skillId, isActive } = req.body;
    db.prepare('UPDATE skills SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, skillId);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 5. GITHUB INTEGRATION API
// ==========================================

router.get('/github/status', async (req: Request, res: Response) => {
  try {
    const status = await GitHubService.verifyConnection();
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/github/repos', async (req: Request, res: Response) => {
  try {
    const result = await GitHubService.listUserRepos();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/github/create-repo', async (req: Request, res: Response) => {
  try {
    const { name, description, isPrivate } = req.body;
    const result = await GitHubService.createRepository({ name, description, isPrivate: Boolean(isPrivate) });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 6. INTEGRATIONS LIST
// ==========================================

router.get('/integrations', (req: Request, res: Response) => {
  try {
    const integrations = db.prepare('SELECT * FROM integrations').all();
    res.json({ integrations });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 7. LIVE PREVIEW SANDBOX
// ==========================================

router.get('/preview/:projectId/*', (req: Request, res: Response) => {
  const projectId = req.params.projectId;
  const projectDir = WorkspaceManager.getProjectDir(projectId);

  // Extract relative path from URL
  const requestedFile = req.params[0] || 'index.html';
  const safeRel = path.normalize(requestedFile).replace(/^(\.\.[\/\\])+/, '');
  let filePath = path.join(projectDir, safeRel);

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(projectDir, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Preview não disponível para este projeto.');
  }

  // Set sandbox headers
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.sendFile(filePath);
});
