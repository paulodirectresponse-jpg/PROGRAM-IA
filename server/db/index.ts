import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Store the SQLite database in a persistent directory
const DATA_DIR = path.resolve(process.env.FORGE_DATA_DIR || path.join(process.cwd(), '.data'));
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'forge.db');
export const db = new DatabaseSync(DB_PATH);

function ensureColumn(tableName: string, columnName: string, columnDef: string) {
  try {
    const tableInfo = db.prepare(`PRAGMA table_info(${tableName})`).all() as any[];
    const exists = tableInfo.some((col) => col.name === columnName);
    if (!exists) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef};`);
    }
  } catch (err) {
    console.error(`Error ensuring column ${columnName} on ${tableName}:`, err);
  }
}

// Run migrations and initial seeds
export function initializeDatabase() {
  // Read and execute schema
  const schemaPath = path.resolve(process.cwd(), 'server', 'db', 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    db.exec(schemaSql);
  }

  // Check if migration 1 is logged
  const migrationRow = db.prepare('SELECT version FROM schema_migrations WHERE version = 1').get() as { version: number } | undefined;
  if (!migrationRow) {
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      1,
      '001_initial_schema',
      new Date().toISOString()
    );
  }

  // Migration 002: Multi-tenant user accounts, sessions, encrypted secrets
  ensureColumn('users', 'password_hash', "TEXT");
  ensureColumn('users', 'firebase_uid', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_firebase_uid ON users(firebase_uid)');
  ensureColumn('users', 'avatar_url', "TEXT");
  ensureColumn('users', 'updated_at', "TEXT");

  ensureColumn('workspaces', 'user_id', "TEXT DEFAULT 'user-default'");
  ensureColumn('projects', 'user_id', "TEXT DEFAULT 'user-default'");
  ensureColumn('skills', 'user_id', "TEXT DEFAULT 'user-default'");
  ensureColumn('providers', 'user_id', "TEXT DEFAULT 'user-default'");
  ensureColumn('integrations', 'user_id', "TEXT DEFAULT 'user-default'");
  ensureColumn('attachments', 'user_id', "TEXT DEFAULT 'user-default'");
  ensureColumn('logs', 'user_id', "TEXT DEFAULT 'user-default'");
  ensureColumn('skills', 'is_custom', "INTEGER DEFAULT 0");

  // Replace legacy global uniqueness with per-user uniqueness, preserving records.
  for (const [table, key] of [['providers', 'provider_key'], ['skills', 'slug']]) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as {sql:string};
    if (row.sql.includes(`${key} TEXT UNIQUE`)) {
      const replacement = row.sql.replace(`CREATE TABLE ${table}`, `CREATE TABLE ${table}_migrating`)
        .replace(`CREATE TABLE IF NOT EXISTS ${table}`, `CREATE TABLE ${table}_migrating`)
        .replace(`${key} TEXT UNIQUE`, `${key} TEXT`);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(replacement);
        db.exec(`INSERT INTO ${table}_migrating SELECT * FROM ${table}`);
        db.exec(`DROP TABLE ${table}`);
        db.exec(`ALTER TABLE ${table}_migrating RENAME TO ${table}`);
        db.exec(`CREATE UNIQUE INDEX ${table}_user_key ON ${table}(user_id, ${key})`);
        db.exec('COMMIT');
      } catch (err) { db.exec('ROLLBACK'); throw err; }
    }
  }

  // Create sessions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      user_agent TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Create user_secrets table
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_secrets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      service_key TEXT NOT NULL,
      encrypted_value TEXT NOT NULL,
      iv TEXT NOT NULL,
      tag TEXT NOT NULL,
      masked_hint TEXT NOT NULL,
      status TEXT DEFAULT 'configured',
      is_default INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      last_tested_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, service_key)
    );
  `);

  const migration2Row = db.prepare('SELECT version FROM schema_migrations WHERE version = 2').get() as { version: number } | undefined;
  if (!migration2Row) {
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      2,
      '002_multitenancy_and_secrets',
      new Date().toISOString()
    );
  }

  // Seed default workspace and user if not exists
  const salt = 'a1b2c3d4e5f67890';
  const derivedKey = crypto.scryptSync('ForgeDev#2026', salt, 64, { N: 16384, r: 8, p: 1 });
  const defaultPasswordHash = `scrypt$${salt}$${derivedKey.toString('hex')}`;

  const defaultUser = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get('user-default') as any;
  if (!defaultUser) {
    db.prepare('INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'user-default',
      'developer@forgeagent.dev',
      'Forge Developer',
      'developer',
      defaultPasswordHash,
      new Date().toISOString(),
      new Date().toISOString()
    );
  } else if (!defaultUser.password_hash) {
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
      defaultPasswordHash,
      new Date().toISOString(),
      'user-default'
    );
  }

  const defaultWs = db.prepare('SELECT id FROM workspaces WHERE id = ?').get('ws-default');
  if (!defaultWs) {
    db.prepare('INSERT INTO workspaces (id, user_id, name, root_path, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'ws-default',
      'user-default',
      'Default Workspace',
      '/workspace',
      new Date().toISOString()
    );
  }


  // Seed standard skills from specification
  const seedSkills = [
    {
      id: 'skill-ts-react',
      name: 'TypeScript & React',
      slug: 'typescript-react',
      description: 'Especialista em React 19, componentes funcionais, hooks estáveis e tipagem estrita com TypeScript.',
      system_instructions: 'Aplique as melhores práticas do ecossistema React 19 e TypeScript: componentes tipados, hooks puros, sem any, modularidade de arquivos e tratamento resiliente de erros.',
      scope: 'project',
    },
    {
      id: 'skill-ui-premium',
      name: 'UI Premium & Design System',
      slug: 'ui-premium',
      description: 'Garante layout sofisticado, alto contraste, tipografia elegante, sem cores neon ou clichés de IA slop.',
      system_instructions: 'Desenvolva interfaces escuras ou neutras profundas com contraste WCAG AA, bordas refinadas de 1px, sem gradientes roxo-azul genéricos, usando espaçamento rítmico consistente e transições suaves.',
      scope: 'project',
    },
    {
      id: 'skill-security',
      name: 'Segurança & Secrets Guard',
      slug: 'seguranca',
      description: 'Bloqueia exposição de chaves privadas, valida inputs e protege contra injeções de código.',
      system_instructions: 'Nunca exponha chaves secretas ou credenciais no frontend ou em mensagens. Valide entradas e garanta que secrets fiquem exclusivamente em variáveis de ambiente no servidor.',
      scope: 'workspace',
    },
    {
      id: 'skill-reviewer-loop',
      name: 'Reviewer Loop',
      slug: 'reviewer-loop',
      description: 'Revisa diffs, checagens de integridade, logs e sugere correções antes de aprovar publicações.',
      system_instructions: 'Analise o diff completo após cada alteração. Valide se os critérios de aceite foram atendidos, aponte potenciais falhas de runtime e pare para confirmação humana se houver riscos.',
      scope: 'project',
    },
    {
      id: 'skill-github-workflow',
      name: 'GitHub Workflow',
      slug: 'github-workflow',
      description: 'Gerencia branches, commits semânticos, checagem de pull requests e sincronização de repositórios.',
      system_instructions: 'Nunca faça push na branch principal sem confirmação. Estruture mensagens de commit no padrão Conventional Commits e valide status do repositório antes de propor alterações remotas.',
      scope: 'project',
    },
    {
      id: 'skill-accessibility',
      name: 'Acessibilidade WCAG',
      slug: 'acessibilidade',
      description: 'Garante contraste visual, navegação via teclado, roles ARIA e acessibilidade.',
      system_instructions: 'Certifique-se de que todos os controles interativos possuem rótulos acessíveis, contraste mínimo de 4.5:1, foco visível e compatibilidade com leitores de tela.',
      scope: 'project',
    },
  ];

  for (const skill of seedSkills) {
    const exists = db.prepare('SELECT id FROM skills WHERE slug = ?').get(skill.slug);
    if (!exists) {
      db.prepare(`
        INSERT INTO skills (id, name, slug, description, system_instructions, scope, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      `).run(skill.id, skill.name, skill.slug, skill.description, skill.system_instructions, skill.scope, new Date().toISOString());
    }
  }

  // Seed default providers
  const defaultProviders = [
    {
      id: 'prov-useoneai',
      provider_key: 'useoneai',
      name: 'UseOneAI (OpenAI-Compatible)',
      base_url: process.env.OPENAI_BASE_URL || 'https://api.useoneai.app/v1',
      model_id: process.env.OPENAI_MODEL_ID || 'chatgpt-5.5',
      is_configured: Boolean(process.env.OPENAI_API_KEY) ? 1 : 0,
      connection_status: Boolean(process.env.OPENAI_API_KEY) ? 'connected' : 'not_configured',
      context_limit: 128000,
    },
    {
      id: 'prov-gemini',
      provider_key: 'gemini',
      name: 'Google Gemini',
      base_url: 'https://generativelanguage.googleapis.com',
      model_id: 'gemini-3.5-flash-lite',
      is_configured: Boolean(process.env.GEMINI_API_KEY) ? 1 : 0,
      connection_status: Boolean(process.env.GEMINI_API_KEY) ? 'connected' : 'not_configured',
      context_limit: 1000000,
    },
    {
      id: 'prov-openai',
      provider_key: 'openai',
      name: 'OpenAI Oficial',
      base_url: 'https://api.openai.com/v1',
      model_id: 'gpt-4o',
      is_configured: 0,
      connection_status: 'not_configured',
      context_limit: 128000,
    },
    {
      id: 'prov-anthropic',
      provider_key: 'anthropic',
      name: 'Anthropic Claude',
      base_url: 'https://api.anthropic.com/v1',
      model_id: 'claude-3-7-sonnet',
      is_configured: 0,
      connection_status: 'not_configured',
      context_limit: 200000,
    },
    {
      id: 'prov-deepseek',
      provider_key: 'deepseek',
      name: 'DeepSeek AI',
      base_url: 'https://api.deepseek.com',
      model_id: 'deepseek-chat',
      is_configured: 0,
      connection_status: 'not_configured',
      context_limit: 64000,
    },
    {
      id: 'prov-groq',
      provider_key: 'groq',
      name: 'Groq Cloud LPU',
      base_url: 'https://api.groq.com/openai/v1',
      model_id: 'llama-3.3-70b-versatile',
      is_configured: 0,
      connection_status: 'not_configured',
      context_limit: 128000,
    },
    {
      id: 'prov-openrouter',
      provider_key: 'openrouter',
      name: 'OpenRouter Multi-Model',
      base_url: 'https://openrouter.ai/api/v1',
      model_id: 'anthropic/claude-3.5-sonnet',
      is_configured: 0,
      connection_status: 'not_configured',
      context_limit: 128000,
    },
    {
      id: 'prov-ollama',
      provider_key: 'ollama',
      name: 'Ollama (Local / On-Premise)',
      base_url: 'http://localhost:11434/v1',
      model_id: 'llama3:latest',
      is_configured: 0,
      connection_status: 'not_configured',
      context_limit: 32000,
    },
  ];

  for (const prov of defaultProviders) {
    const exists = db.prepare('SELECT id FROM providers WHERE provider_key = ?').get(prov.provider_key);
    if (!exists) {
      db.prepare(`
        INSERT INTO providers (
          id, provider_key, name, base_url, model_id, is_configured, connection_status, context_limit, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        prov.id,
        prov.provider_key,
        prov.name,
        prov.base_url,
        prov.model_id,
        prov.is_configured,
        prov.connection_status,
        prov.context_limit,
        new Date().toISOString()
      );
    }
  }

  // Ensure Gemini provider uses gemini-3.5-flash-lite
  try {
    db.prepare("UPDATE providers SET model_id = 'gemini-3.5-flash-lite' WHERE provider_key = 'gemini' AND (model_id LIKE '%2.5%' OR model_id = '')").run();
  } catch {}

  // Seed default integrations (GitHub, UseOneAI, Gemini)
  const defaultIntegrations = [
    {
      id: 'integ-github',
      service_name: 'github',
      status: Boolean(process.env.GITHUB_TOKEN) ? 'connected' : 'pending_credentials',
      config_json: JSON.stringify({
        has_token: Boolean(process.env.GITHUB_TOKEN),
        default_owner: process.env.GITHUB_DEFAULT_OWNER || '',
        note: 'Requer GITHUB_TOKEN no servidor para sincronização de commits e branches.'
      })
    },
    {
      id: 'integ-useoneai',
      service_name: 'useoneai',
      status: Boolean(process.env.OPENAI_API_KEY) ? 'connected' : 'pending_credentials',
      config_json: JSON.stringify({
        base_url: process.env.OPENAI_BASE_URL || 'https://api.useoneai.app/v1',
        model_id: process.env.OPENAI_MODEL_ID || 'chatgpt-5.5',
        has_key: Boolean(process.env.OPENAI_API_KEY)
      })
    },
    {
      id: 'integ-gemini',
      service_name: 'gemini',
      status: Boolean(process.env.GEMINI_API_KEY) ? 'connected' : 'pending_credentials',
      config_json: JSON.stringify({
        has_key: Boolean(process.env.GEMINI_API_KEY),
        model_id: 'gemini-2.5-flash'
      })
    }
  ];

  for (const integ of defaultIntegrations) {
    const exists = db.prepare('SELECT id FROM integrations WHERE service_name = ?').get(integ.service_name);
    if (!exists) {
      db.prepare(`
        INSERT INTO integrations (id, service_name, config_json, status, last_verified_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        integ.id,
        integ.service_name,
        integ.config_json,
        integ.status,
        new Date().toISOString(),
        new Date().toISOString()
      );
    }
  }

  // Seed an initial demo project if database has 0 projects, so user immediately sees a working project
  const countProjects = db.prepare('SELECT COUNT(*) as c FROM projects').get() as { c: number };
  if (countProjects.c === 0) {
    createInitialProject();
  }
}

function createInitialProject() {
  const projectId = 'proj-initial-forge-showcase';
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO projects (
      id, workspace_id, name, description, origin, repo_url, branch, status, provider_id, model_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId,
    'ws-default',
    'Forge Dashboard Starter',
    'Aplicação full-stack inicial com métricas, visualização de status e gerenciamento de tarefas.',
    'novo',
    '',
    'main',
    'active',
    'prov-useoneai',
    'chatgpt-5.5',
    now,
    now
  );

  db.prepare(`
    INSERT INTO project_sources (id, project_id, type, original_path_or_url, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('src-initial', projectId, 'scratch', 'scratch-template', now);

  db.prepare(`
    INSERT INTO branches (id, project_id, name, is_current, head_commit_hash, created_at)
    VALUES (?, ?, ?, 1, 'init-001', ?)
  `).run('br-initial', projectId, 'main', now);

  const convId = 'conv-initial';
  db.prepare(`
    INSERT INTO conversations (id, project_id, title, mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(convId, projectId, 'Início do Projeto', 'plan', now, now);

  db.prepare(`
    INSERT INTO messages (id, conversation_id, sender, content, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'msg-init-1',
    convId,
    'agent',
    'Olá! Eu sou o Forge Agent. Posso criar novas funcionalidades, gerar planos técnicos com escopo e critérios de aceite, aplicar mudanças no código com preview ao vivo e sincronizar com seu repositório GitHub.\n\nUse o seletor de modo acima para alternar entre **Planejar**, **Construir**, **Revisar** e **Publicar**, ou mencione skills como `@ui-premium` e `@seguranca`.',
    JSON.stringify({ type: 'welcome' }),
    now
  );

  // Initialize workspace files for this project
  const projectDir = path.resolve(DATA_DIR, 'projects', projectId);
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }

  // Create starter app files that will run in the live preview
  const starterHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Forge Dashboard Starter</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Plus Jakarta Sans', sans-serif; background-color: #0c0f17; color: #f1f5f9; }
  </style>
</head>
<body class="p-6 md:p-8 min-h-screen">
  <div class="max-w-4xl mx-auto space-y-6">
    <header class="flex items-center justify-between border-b border-slate-800 pb-5">
      <div>
        <div class="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-emerald-950/80 border border-emerald-800/60 text-emerald-400 text-xs font-semibold uppercase tracking-wider mb-2">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
          Preview Ativo • Forge Agent
        </div>
        <h1 class="text-2xl font-bold text-slate-100">Forge Dashboard Starter</h1>
        <p class="text-sm text-slate-400">Aplicação web renderizada em sandbox em tempo real.</p>
      </div>
      <button id="btn-refresh" class="px-3.5 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 transition">
        Simular Ação
      </button>
    </header>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
        <span class="text-xs text-slate-400">Tempo de Resposta</span>
        <div class="text-2xl font-semibold text-slate-100 mt-1">12ms</div>
        <div class="text-xs text-emerald-400 mt-2">● Estável (Sandbox Local)</div>
      </div>
      <div class="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
        <span class="text-xs text-slate-400">Checkpoints</span>
        <div class="text-2xl font-semibold text-slate-100 mt-1" id="checkpoint-stat">1 criado</div>
        <div class="text-xs text-blue-400 mt-2">● Histórico Preservado</div>
      </div>
      <div class="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
        <span class="text-xs text-slate-400">Quality Gates</span>
        <div class="text-2xl font-semibold text-emerald-400 mt-1">Aprovado</div>
        <div class="text-xs text-slate-400 mt-2">Sem vulnerabilidades</div>
      </div>
    </div>

    <div class="p-5 rounded-xl bg-slate-900/90 border border-slate-800">
      <h3 class="text-sm font-semibold text-slate-200 mb-3">Feed de Atividades do Workspace</h3>
      <ul class="space-y-2 text-xs text-slate-300">
        <li class="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800/80 flex items-center justify-between">
          <span>Arquivo <code class="text-cyan-400 font-mono">index.html</code> gerado no sandbox</span>
          <span class="text-slate-500">Agora</span>
        </li>
        <li class="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800/80 flex items-center justify-between">
          <span>Quality gate <span class="text-emerald-400">Typecheck & Syntax</span> concluído</span>
          <span class="text-slate-500">Agora</span>
        </li>
      </ul>
    </div>
  </div>

  <script>
    document.getElementById('btn-refresh').addEventListener('click', () => {
      alert('Interação no Sandbox do Forge Agent funcionando perfeitamente!');
    });
  </script>
</body>
</html>`;

  fs.writeFileSync(path.join(projectDir, 'index.html'), starterHtml, 'utf8');

  // Create initial checkpoint
  const initialSnapshot = JSON.stringify({
    'index.html': starterHtml
  });

  const cpId = 'cp-init-1';
  db.prepare(`
    INSERT INTO checkpoints (id, project_id, title, description, parent_id, files_snapshot_json, created_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?)
  `).run(cpId, projectId, 'Versão Inicial', 'Criação do workspace inicial com layout básico', initialSnapshot, now);

  db.prepare('UPDATE projects SET current_checkpoint_id = ? WHERE id = ?').run(cpId, projectId);

  // Initial verification records
  db.prepare(`
    INSERT INTO verifications (id, project_id, checkpoint_id, gate_type, status, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('ver-1', projectId, cpId, 'build', 'pass', JSON.stringify({ message: 'Build e estrutura HTML válidos' }), now);

  db.prepare(`
    INSERT INTO verifications (id, project_id, checkpoint_id, gate_type, status, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('ver-2', projectId, cpId, 'security', 'pass', JSON.stringify({ message: 'Nenhuma chave de API detectada no código' }), now);

  db.prepare(`
    INSERT INTO verifications (id, project_id, checkpoint_id, gate_type, status, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('ver-3', projectId, cpId, 'preview', 'pass', JSON.stringify({ message: 'Preview pronto para renderização' }), now);
}

