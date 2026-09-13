import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

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
  ensureColumn('users', 'firebase_uid', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_firebase_uid ON users(firebase_uid)');
  ensureColumn('users', 'avatar_url', "TEXT");
  ensureColumn('users', 'updated_at', "TEXT");

  ensureColumn('workspaces', 'user_id', "TEXT");
  ensureColumn('projects', 'user_id', "TEXT");
  ensureColumn('skills', 'user_id', "TEXT");
  ensureColumn('providers', 'user_id', "TEXT");
  ensureColumn('providers', 'is_active', 'INTEGER DEFAULT 0');
  ensureColumn('integrations', 'user_id', "TEXT");
  ensureColumn('attachments', 'user_id', "TEXT");
  ensureColumn('logs', 'user_id', "TEXT");
  ensureColumn('users', 'last_active_project_id', 'TEXT');
  ensureColumn('skills', 'is_custom', "INTEGER DEFAULT 0");
  // Migrate the legacy overloaded provider status into independent activity and health states.
  db.exec("UPDATE providers SET is_active = 1 WHERE connection_status = 'active'");
  db.exec("UPDATE providers SET connection_status = CASE WHEN is_configured = 1 THEN 'untested' ELSE 'not_configured' END WHERE connection_status IN ('active','configured')");
  const duplicateActiveUsers = db.prepare('SELECT user_id FROM providers WHERE is_active = 1 GROUP BY user_id HAVING COUNT(*) > 1').all() as any[];
  for (const {user_id} of duplicateActiveUsers) {
    const keep = db.prepare('SELECT id FROM providers WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1').get(user_id) as any;
    db.prepare('UPDATE providers SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE user_id = ?').run(keep.id, user_id);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_profiles (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,profile_key TEXT NOT NULL,level INTEGER NOT NULL,max_attempts INTEGER NOT NULL DEFAULT 1,max_cost_usd REAL NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(user_id,profile_key));
    CREATE TABLE IF NOT EXISTS model_candidates (id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,provider_key TEXT NOT NULL,model_id TEXT NOT NULL,priority INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 1,health_state TEXT NOT NULL DEFAULT 'healthy',consecutive_failures INTEGER NOT NULL DEFAULT 0,circuit_open_until TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(profile_id,provider_key,model_id));
    CREATE TABLE IF NOT EXISTS model_invocations (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,project_id TEXT,run_id TEXT,step_id TEXT,agent_key TEXT,profile_key TEXT,provider_key TEXT NOT NULL,model_id TEXT NOT NULL,input_tokens INTEGER DEFAULT 0,output_tokens INTEGER DEFAULT 0,cost_usd REAL DEFAULT 0,latency_ms INTEGER NOT NULL,status TEXT NOT NULL,error_code TEXT,retry_index INTEGER DEFAULT 0,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS model_invocations_user_created ON model_invocations(user_id,created_at);
    CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,project_id TEXT NOT NULL,conversation_id TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,budget_usd REAL NOT NULL DEFAULT .5,spent_usd REAL NOT NULL DEFAULT 0,created_at TEXT NOT NULL,finished_at TEXT);
    CREATE TABLE IF NOT EXISTS agent_steps (id TEXT PRIMARY KEY,run_id TEXT NOT NULL,agent_key TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,order_index INTEGER NOT NULL,scope_level TEXT NOT NULL DEFAULT 'task',attempt_count INTEGER NOT NULL DEFAULT 0,parent_step_id TEXT,acceptance_json TEXT NOT NULL DEFAULT '[]',context_json TEXT,created_at TEXT NOT NULL,finished_at TEXT);
    CREATE TABLE IF NOT EXISTS tool_executions (id TEXT PRIMARY KEY,run_id TEXT,step_id TEXT,tool_key TEXT NOT NULL,status TEXT NOT NULL,duration_ms INTEGER NOT NULL,summary_json TEXT NOT NULL,created_at TEXT NOT NULL);
  `);

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
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS providers_one_active_per_user ON providers(user_id) WHERE is_active = 1');

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

  // Per-user defaults are provisioned only after verified Firebase authentication.

  // No global skills/providers/integrations are seeded; AuthService.seedUserData owns account defaults.

  // Project creation is explicit and user-owned; no anonymous demo project is created.
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


