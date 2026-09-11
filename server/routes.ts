import express, { Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { db } from './db/index.js';
import { WorkspaceManager } from './services/workspaceManager.js';
import { LLMAdapterService, AgentMode } from './services/llmAdapter.js';
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

router.post('/projects', async (req: Request, res: Response) => {
  try {
    const { name, description, origin = 'novo', repo_url = '', branch = 'main', initialFiles = {} } = req.body;
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'O nome do projeto é obrigatório.' });
    }

    const projectId = 'proj-' + Date.now();
    const now = new Date().toISOString();
    let effectiveBranch = branch || 'main';

    // Validate and handle GitHub origin
    if (origin === 'github') {
      if (!repo_url || repo_url.trim().length === 0) {
        return res.status(400).json({ error: 'URL do repositório GitHub é obrigatória para importação remota.' });
      }

      const parsed = GitHubService.parseRepoUrl(repo_url);
      if (!parsed) {
        return res.status(400).json({
          error: 'URL do GitHub inválida. Formatos válidos: https://github.com/usuario/repo ou usuario/repo',
        });
      }

      // Import real files from GitHub
      const importResult = await GitHubService.importRepoFiles(parsed.owner, parsed.repo, effectiveBranch);
      if (!importResult.success) {
        return res.status(400).json({
          error: importResult.error || 'Falha ao importar arquivos do repositório GitHub especificado.',
        });
      }

      effectiveBranch = importResult.branch || effectiveBranch;

      // Create Project row
      db.prepare(`
        INSERT INTO projects (
          id, workspace_id, name, description, origin, repo_url, branch, status, provider_id, model_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'prov-useoneai', 'chatgpt-5.5', ?, ?)
      `).run(projectId, 'ws-default', name.trim(), description || `Importado de ${repo_url}`, origin, repo_url.trim(), effectiveBranch, now, now);

      // Write imported files to workspace
      if (importResult.files && Object.keys(importResult.files).length > 0) {
        for (const [filePath, content] of Object.entries(importResult.files)) {
          WorkspaceManager.writeFile(projectId, filePath, content);
        }
      } else {
        // Starter fallback if repo was empty
        WorkspaceManager.writeFile(projectId, 'README.md', `# ${name}\n\nRepositório importado do GitHub: ${repo_url}`);
      }

      // Project source
      db.prepare(`
        INSERT INTO project_sources (id, project_id, type, original_path_or_url, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('src-' + Date.now(), projectId, origin, repo_url, now);

      // Branch
      db.prepare(`
        INSERT INTO branches (id, project_id, name, is_current, head_commit_hash, created_at)
        VALUES (?, ?, ?, 1, 'head-import', ?)
      `).run('br-' + Date.now(), projectId, effectiveBranch, now);

      // Conversation in auto mode
      const convId = 'conv-' + Date.now();
      db.prepare(`
        INSERT INTO conversations (id, project_id, title, mode, created_at, updated_at)
        VALUES (?, ?, 'Workspace GitHub', 'auto', ?, ?)
      `).run(convId, projectId, now, now);

      // Welcome message
      db.prepare(`
        INSERT INTO messages (id, conversation_id, sender, content, metadata_json, created_at)
        VALUES (?, ?, 'agent', ?, ?, ?)
      `).run(
        'msg-' + Date.now(),
        convId,
        'agent',
        `Repositório **${parsed.owner}/${parsed.repo}** (branch \`${effectiveBranch}\`) importado com sucesso!\n\nForam carregados **${importResult.filesCount || 0} arquivos** no workspace. Estou pronto para analisar, editar ou implementar novidades neste código.`,
        JSON.stringify({ isWelcome: true, mode: 'auto' }),
        now
      );

      // Initial checkpoint
      WorkspaceManager.createCheckpoint(projectId, 'Importação do GitHub', `Importado de ${parsed.owner}/${parsed.repo}`);

      return res.json({ success: true, projectId });
    }

    // Handle Local / ZIP file import
    if (origin === 'local' && initialFiles && Object.keys(initialFiles).length > 0) {
      db.prepare(`
        INSERT INTO projects (
          id, workspace_id, name, description, origin, repo_url, branch, status, provider_id, model_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, '', 'main', 'active', 'prov-useoneai', 'chatgpt-5.5', ?, ?)
      `).run(projectId, 'ws-default', name.trim(), description || 'Importado de arquivo ZIP', origin, now, now);

      for (const [filePath, content] of Object.entries(initialFiles)) {
        if (typeof content === 'string') {
          WorkspaceManager.writeFile(projectId, filePath, content);
        }
      }

      // Project source
      db.prepare(`
        INSERT INTO project_sources (id, project_id, type, original_path_or_url, created_at)
        VALUES (?, ?, ?, 'local-zip', ?)
      `).run('src-' + Date.now(), projectId, 'local_zip', now);

      // Main branch
      db.prepare(`
        INSERT INTO branches (id, project_id, name, is_current, head_commit_hash, created_at)
        VALUES (?, ?, 'main', 1, 'head-zip', ?)
      `).run('br-' + Date.now(), projectId, now);

      // Conversation in auto mode
      const convId = 'conv-' + Date.now();
      db.prepare(`
        INSERT INTO conversations (id, project_id, title, mode, created_at, updated_at)
        VALUES (?, ?, 'Workspace ZIP', 'auto', ?, ?)
      `).run(convId, projectId, now, now);

      // Welcome message
      db.prepare(`
        INSERT INTO messages (id, conversation_id, sender, content, metadata_json, created_at)
        VALUES (?, ?, 'agent', ?, ?, ?)
      `).run(
        'msg-' + Date.now(),
        convId,
        'agent',
        `Arquivo ZIP **${name}** extraído com sucesso!\n\nForam criados **${Object.keys(initialFiles).length} arquivos** no workspace. Você pode visualizar o live preview ao lado e solicitar edições.`,
        JSON.stringify({ isWelcome: true, mode: 'auto' }),
        now
      );

      WorkspaceManager.createCheckpoint(projectId, 'Importação de Arquivo ZIP', `Extração de ${Object.keys(initialFiles).length} arquivos`);

      return res.json({ success: true, projectId });
    }

    // Default: Create from scratch (novo)
    db.prepare(`
      INSERT INTO projects (
        id, workspace_id, name, description, origin, repo_url, branch, status, provider_id, model_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, '', 'main', 'active', 'prov-useoneai', 'chatgpt-5.5', ?, ?)
    `).run(projectId, 'ws-default', name.trim(), description || 'Novo projeto Forge Agent', 'novo', now, now);

    // Initial project source
    db.prepare(`
      INSERT INTO project_sources (id, project_id, type, original_path_or_url, created_at)
      VALUES (?, ?, ?, 'scratch', ?)
    `).run('src-' + Date.now(), projectId, 'scratch', now);

    // Main branch
    db.prepare(`
      INSERT INTO branches (id, project_id, name, is_current, head_commit_hash, created_at)
      VALUES (?, ?, 'main', 1, 'head-init', ?)
    `).run('br-' + Date.now(), projectId, now);

    // Initial conversation in auto mode
    const convId = 'conv-' + Date.now();
    db.prepare(`
      INSERT INTO conversations (id, project_id, title, mode, created_at, updated_at)
      VALUES (?, ?, 'Conversa Principal', 'auto', ?, ?)
    `).run(convId, projectId, now, now);

    // Welcome message in auto mode
    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender, content, metadata_json, created_at)
      VALUES (?, ?, 'agent', ?, ?, ?)
    `).run(
      'msg-' + Date.now(),
      convId,
      'agent',
      `Projeto **${name}** pronto!\n\nEstou operando no modo **Automático**. Diga o que deseja construir, modificar ou entender. Decidirei a melhor ação para o seu pedido (explicar, propor alterações com diff ou planejar).`,
      JSON.stringify({ isWelcome: true, mode: 'auto' }),
      now
    );

    // Populate initial starter files in workspace
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

// Update Project Metadata / Provider / Branch / Status
router.patch('/projects/:id', (req: Request, res: Response) => {
  try {
    const { name, description, branch, status, provider_id, model_id } = req.body;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as any;
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });

    const updatedName = name !== undefined ? name.trim() : project.name;
    const updatedDesc = description !== undefined ? description : project.description;
    const updatedBranch = branch !== undefined ? branch : project.branch;
    const updatedStatus = status !== undefined ? status : project.status;
    const updatedProv = provider_id !== undefined ? provider_id : project.provider_id;
    const updatedModel = model_id !== undefined ? model_id : project.model_id;
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE projects SET name = ?, description = ?, branch = ?, status = ?, provider_id = ?, model_id = ?, updated_at = ?
      WHERE id = ?
    `).run(updatedName, updatedDesc, updatedBranch, updatedStatus, updatedProv, updatedModel, now, req.params.id);

    res.json({
      success: true,
      project: {
        ...project,
        name: updatedName,
        description: updatedDesc,
        branch: updatedBranch,
        status: updatedStatus,
        provider_id: updatedProv,
        model_id: updatedModel,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete Project and Workspace Files
router.delete('/projects/:id', (req: Request, res: Response) => {
  try {
    const projectId = req.params.id;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });

    const convs = db.prepare('SELECT id FROM conversations WHERE project_id = ?').all(projectId) as any[];
    for (const c of convs) {
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(c.id);
    }
    db.prepare('DELETE FROM conversations WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM plans WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM checkpoints WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM verifications WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM branches WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM project_sources WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

    WorkspaceManager.deleteProject(projectId);

    res.json({ success: true, message: 'Projeto excluído com sucesso.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Duplicate Project
router.post('/projects/:id/duplicate', (req: Request, res: Response) => {
  try {
    const sourceId = req.params.id;
    const source = db.prepare('SELECT * FROM projects WHERE id = ?').get(sourceId) as any;
    if (!source) return res.status(404).json({ error: 'Projeto original não encontrado.' });

    const newId = 'proj-' + Date.now();
    const now = new Date().toISOString();
    const newName = `${source.name} (Cópia)`;

    db.prepare(`
      INSERT INTO projects (
        id, workspace_id, name, description, origin, repo_url, branch, status, provider_id, model_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(
      newId,
      source.workspace_id || 'ws-default',
      newName,
      source.description,
      source.origin || 'novo',
      source.repo_url || '',
      source.branch || 'main',
      source.provider_id || 'prov-gemini',
      source.model_id || 'gemini-3.5-flash-lite',
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
      `Projeto **${newName}** duplicado com sucesso! Todos os arquivos e histórico foram preservados.`,
      JSON.stringify({ isWelcome: true, mode: 'auto' }),
      now
    );

    WorkspaceManager.createCheckpoint(newId, 'Duplicação do Projeto', `Cópia criada a partir de ${source.name}`);

    res.json({ success: true, projectId: newId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Export Project as real ZIP
router.get('/projects/:id/export/zip', async (req: Request, res: Response) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as any;
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });

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

    // Fetch conversation history
    const history = db.prepare('SELECT sender, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 10').all(conv.id) as any[];

    // Fetch existing files
    const existingFiles = WorkspaceManager.getAllFilesContent(projectId);

    // Read project provider and model configuration
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    const providerKey = project?.provider_id ? project.provider_id.replace('prov-', '') : undefined;
    const modelId = project?.model_id;

    // Call LLM Adapter
    const result = await LLMAdapterService.executePrompt({
      prompt: content,
      mode: mode as AgentMode,
      projectId,
      providerKey,
      modelId,
      existingFiles,
      appliedSkills,
      conversationHistory: history,
    });

    let checkpointCreatedId: string | null = null;

    // Apply files strictly when validated
    // If in BUILD mode, only apply if no errors and files are valid
    if (mode === 'build') {
      if (result.build && result.build.files && result.build.files.length > 0 && !result.hasErrors) {
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
      }
    } else if (mode === 'auto') {
      // In auto mode, if changes do NOT require confirmation, apply them directly;
      // if they require confirmation, keep proposal pending for user approval
      if (result.build && result.build.files && result.build.files.length > 0 && !result.proposal?.requiresConfirmation) {
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
      errorMessage: result.errorMessage,
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
      proposal: result.proposal,
      checkpointId: checkpointCreatedId,
    });
  } catch (err: any) {
    console.error('Erro na rota de mensagens:', err);
    res.status(500).json({ error: err.message });
  }
});

// Apply proposed changes with confirmation
router.post('/conversations/:projectId/apply-proposal', (req: Request, res: Response) => {
  try {
    const { files, summary = 'Alterações aprovadas pelo usuário' } = req.body;
    const projectId = req.params.projectId;

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'Lista de arquivos proposta inválida ou vazia.' });
    }

    for (const file of files) {
      if (file.action === 'delete') {
        WorkspaceManager.deleteFile(projectId, file.path);
      } else if (typeof file.content === 'string') {
        WorkspaceManager.writeFile(projectId, file.path, file.content);
      }
    }

    const checkpointId = WorkspaceManager.createCheckpoint(projectId, 'Alterações Aplicadas', summary);

    res.json({ success: true, checkpointId, message: 'Alterações aplicadas com sucesso ao workspace.' });
  } catch (err: any) {
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
    if (buildResult.build && buildResult.build.files && !buildResult.hasErrors) {
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
    const providers = db.prepare('SELECT id, provider_key, name, base_url, model_id, is_configured, connection_status, context_limit, created_at FROM providers').all() as any[];

    // Synchronize is_configured with current server environment variables
    const openaiKey = process.env.OPENAI_API_KEY || process.env.USEONEAI_API_KEY || '';
    const geminiKey = process.env.GEMINI_API_KEY || '';

    const enriched = providers.map((p) => {
      let isConfig = Boolean(p.is_configured);
      if (p.provider_key === 'useoneai' || p.provider_key === 'openai') {
        isConfig = Boolean(openaiKey && openaiKey.trim().length > 0);
      } else if (p.provider_key === 'gemini') {
        isConfig = Boolean(geminiKey && geminiKey.trim().length > 0);
      }
      return {
        ...p,
        is_configured: isConfig ? 1 : 0,
        connection_status: isConfig ? 'connected' : 'not_configured',
      };
    });

    res.json({ providers: enriched });
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

// REAL PROVIDER CONNECTION TEST ENDPOINT
router.post('/providers/test', async (req: Request, res: Response) => {
  try {
    const { providerKey, baseUrl, modelId } = req.body;
    const result = await LLMAdapterService.testConnection({
      providerKey: providerKey || 'useoneai',
      baseUrl,
      modelId,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({
      success: false,
      status: 'network_error',
      message: `Erro interno ao testar conexão: ${err.message}`,
    });
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

// Pull files from GitHub into project workspace
router.post('/projects/:id/github/pull', async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });
    if (!project.repo_url) return res.status(400).json({ error: 'Projeto não possui URL do repositório configurada.' });

    const parsed = GitHubService.parseRepoUrl(project.repo_url);
    if (!parsed) return res.status(400).json({ error: 'URL do repositório inválida.' });

    const result = await GitHubService.importRepoFiles(parsed.owner, parsed.repo, project.branch || 'main');
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    if (result.files) {
      for (const [filePath, content] of Object.entries(result.files)) {
        WorkspaceManager.writeFile(projectId, filePath, content);
      }
    }

    const cpId = WorkspaceManager.createCheckpoint(projectId, `Git Pull: ${project.branch}`, `Sincronizados ${result.filesCount} arquivos do GitHub`);
    res.json({ success: true, count: result.filesCount, checkpointId: cpId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Push project files to GitHub
router.post('/projects/:id/github/push', async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id;
    const { commitMessage } = req.body;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });
    if (!project.repo_url) return res.status(400).json({ error: 'Projeto não possui URL do repositório configurada.' });

    const parsed = GitHubService.parseRepoUrl(project.repo_url);
    if (!parsed) return res.status(400).json({ error: 'URL do repositório inválida.' });

    const files = WorkspaceManager.getAllFilesContent(projectId);
    const result = await GitHubService.pushFilesToRepo({
      owner: parsed.owner,
      repo: parsed.repo,
      branch: project.branch || 'main',
      commitMessage: commitMessage || 'Alterações aplicadas via Forge Agent',
      files,
    });

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json({ success: true, commitSha: result.commitSha });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List repository branches
router.get('/projects/:id/github/branches', async (req: Request, res: Response) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as any;
    if (!project || !project.repo_url) {
      return res.status(400).json({ error: 'Repositório GitHub não configurado no projeto.' });
    }
    const parsed = GitHubService.parseRepoUrl(project.repo_url);
    if (!parsed) return res.status(400).json({ error: 'URL do repositório inválida.' });

    const result = await GitHubService.listBranches(parsed.owner, parsed.repo);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create new branch on GitHub and switch project to it
router.post('/projects/:id/github/branch', async (req: Request, res: Response) => {
  try {
    const { newBranch, fromBranch } = req.body;
    if (!newBranch) return res.status(400).json({ error: 'Nome da nova branch é obrigatório.' });

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as any;
    if (!project || !project.repo_url) {
      return res.status(400).json({ error: 'Repositório GitHub não configurado no projeto.' });
    }
    const parsed = GitHubService.parseRepoUrl(project.repo_url);
    if (!parsed) return res.status(400).json({ error: 'URL do repositório inválida.' });

    const baseBranch = fromBranch || project.branch || 'main';
    const result = await GitHubService.createBranch({
      owner: parsed.owner,
      repo: parsed.repo,
      newBranch: newBranch.trim(),
      fromBranch: baseBranch,
    });

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    // Update project active branch in DB
    const now = new Date().toISOString();
    db.prepare('UPDATE projects SET branch = ?, updated_at = ? WHERE id = ?').run(newBranch.trim(), now, req.params.id);

    // Record branch in branches table
    db.prepare(`
      INSERT INTO branches (id, project_id, name, is_current, head_commit_hash, created_at)
      VALUES (?, ?, ?, 1, 'head-new', ?)
    `).run('br-' + Date.now(), req.params.id, newBranch.trim(), now);

    res.json({ success: true, branch: newBranch.trim() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create Pull Request on GitHub
router.post('/projects/:id/github/pull-request', async (req: Request, res: Response) => {
  try {
    const { title, base = 'main', body } = req.body;
    if (!title) return res.status(400).json({ error: 'Título do Pull Request é obrigatório.' });

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as any;
    if (!project || !project.repo_url) {
      return res.status(400).json({ error: 'Repositório GitHub não configurado no projeto.' });
    }
    const parsed = GitHubService.parseRepoUrl(project.repo_url);
    if (!parsed) return res.status(400).json({ error: 'URL do repositório inválida.' });

    const headBranch = project.branch || 'main';
    if (headBranch === base) {
      return res.status(400).json({
        error: `A branch atual (${headBranch}) é a mesma que a branch base (${base}). Crie uma nova branch antes de abrir um PR.`,
      });
    }

    const result = await GitHubService.createPullRequest({
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

// Sync status with GitHub
router.get('/projects/:id/github/status', async (req: Request, res: Response) => {
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

// Connect an existing or newly created GitHub repo to project
router.post('/projects/:id/github/connect-repo', async (req: Request, res: Response) => {
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
  res.sendFile(filePath);
});
