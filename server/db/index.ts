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
  // Phase 0 — richer architecture plans without breaking legacy rows.
  ensureColumn('plans', 'architecture_summary', "TEXT DEFAULT ''");
  ensureColumn('plans', 'existing_files_json', "TEXT DEFAULT '[]'");
  ensureColumn('plans', 'new_files_json', "TEXT DEFAULT '[]'");
  ensureColumn('plans', 'files_to_delete_json', "TEXT DEFAULT '[]'");
  ensureColumn('plans', 'requirements_json', "TEXT DEFAULT '[]'");
  ensureColumn('plans', 'task_graph_json', "TEXT DEFAULT '[]'");
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
    CREATE TABLE IF NOT EXISTS model_invocations (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,project_id TEXT,run_id TEXT,step_id TEXT,agent_key TEXT,profile_key TEXT,provider_key TEXT NOT NULL,model_id TEXT NOT NULL,input_tokens INTEGER DEFAULT 0,output_tokens INTEGER DEFAULT 0,cost_usd REAL DEFAULT 0,latency_ms INTEGER NOT NULL,status TEXT NOT NULL,error_code TEXT,retry_index INTEGER DEFAULT 0,context_pack_id TEXT,context_scope TEXT,project_hash TEXT,context_tokens INTEGER DEFAULT 0,context_selected_files_json TEXT NOT NULL DEFAULT '[]',context_omitted_files_count INTEGER DEFAULT 0,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS model_invocations_user_created ON model_invocations(user_id,created_at);
    CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,project_id TEXT NOT NULL,conversation_id TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,budget_usd REAL NOT NULL DEFAULT .5,spent_usd REAL NOT NULL DEFAULT 0,created_at TEXT NOT NULL,finished_at TEXT);
    CREATE TABLE IF NOT EXISTS agent_steps (id TEXT PRIMARY KEY,run_id TEXT NOT NULL,agent_key TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,order_index INTEGER NOT NULL,scope_level TEXT NOT NULL DEFAULT 'task',attempt_count INTEGER NOT NULL DEFAULT 0,parent_step_id TEXT,acceptance_json TEXT NOT NULL DEFAULT '[]',context_json TEXT,created_at TEXT NOT NULL,finished_at TEXT);
    CREATE TABLE IF NOT EXISTS tool_executions (id TEXT PRIMARY KEY,run_id TEXT,step_id TEXT,tool_key TEXT NOT NULL,status TEXT NOT NULL,duration_ms INTEGER NOT NULL,summary_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requirements (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      conversation_id TEXT,
      run_id TEXT,
      plan_id TEXT,
      requirement_key TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'high',
      status TEXT NOT NULL DEFAULT 'pending',
      verification_json TEXT NOT NULL DEFAULT '[]',
      files_json TEXT NOT NULL DEFAULT '[]',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, plan_id, requirement_key)
    );
    CREATE INDEX IF NOT EXISTS requirements_project_status ON requirements(project_id,status);
    CREATE INDEX IF NOT EXISTS requirements_run ON requirements(run_id);
  `);

  ensureColumn('model_invocations', 'context_pack_id', 'TEXT');
  ensureColumn('model_invocations', 'context_scope', 'TEXT');
  ensureColumn('model_invocations', 'project_hash', 'TEXT');
  ensureColumn('model_invocations', 'context_tokens', 'INTEGER DEFAULT 0');
  ensureColumn('model_invocations', 'context_selected_files_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('model_invocations', 'context_omitted_files_count', 'INTEGER DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS model_invocations_context_pack ON model_invocations(context_pack_id)');

  const migration3Row = db.prepare('SELECT version FROM schema_migrations WHERE version = 3').get() as { version: number } | undefined;
  if (!migration3Row) {
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      3,
      '003_agent_core_requirements_and_architecture_plans',
      new Date().toISOString()
    );
  }

  // Migration 004: Context Engine V2 core persistence.
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_project_files (
      project_id TEXT NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,size_bytes INTEGER NOT NULL,
      language TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',symbols_json TEXT NOT NULL DEFAULT '[]',
      imports_json TEXT NOT NULL DEFAULT '[]',exports_json TEXT NOT NULL DEFAULT '[]',
      module_key TEXT NOT NULL DEFAULT 'root',updated_at TEXT NOT NULL,PRIMARY KEY(project_id,path)
    );
    CREATE INDEX IF NOT EXISTS idx_context_project_files_hash ON context_project_files(project_id,hash);
    CREATE INDEX IF NOT EXISTS idx_context_project_files_module ON context_project_files(project_id,module_key);
    CREATE TABLE IF NOT EXISTS context_architecture_graphs (
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,graph_hash TEXT NOT NULL,graph_json TEXT NOT NULL,
      created_at TEXT NOT NULL,UNIQUE(project_id,graph_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_context_architecture_project ON context_architecture_graphs(project_id,created_at);
    CREATE TABLE IF NOT EXISTS context_commits (
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,run_id TEXT,task_id TEXT,agent_key TEXT,
      scope TEXT NOT NULL DEFAULT 'TASK',task TEXT NOT NULL,decisions_json TEXT NOT NULL DEFAULT '[]',
      changed_files_json TEXT NOT NULL DEFAULT '[]',requirement_ids_json TEXT NOT NULL DEFAULT '[]',
      validation_json TEXT NOT NULL DEFAULT 'null',blockers_json TEXT NOT NULL DEFAULT '[]',
      next_state_json TEXT NOT NULL DEFAULT 'null',created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_context_commits_project ON context_commits(project_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_context_commits_run ON context_commits(run_id,created_at);
    CREATE TABLE IF NOT EXISTS context_packs (
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,run_id TEXT,step_id TEXT,agent_key TEXT NOT NULL,
      scope TEXT NOT NULL,project_hash TEXT NOT NULL,token_budget INTEGER NOT NULL,estimated_tokens INTEGER NOT NULL,
      selected_files_json TEXT NOT NULL DEFAULT '[]',omitted_files_json TEXT NOT NULL DEFAULT '[]',
      pack_json TEXT NOT NULL,created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_context_packs_project ON context_packs(project_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_context_packs_run ON context_packs(run_id,created_at);
  `);
  const migration4Row = db.prepare('SELECT version FROM schema_migrations WHERE version = 4').get() as { version: number } | undefined;
  if (!migration4Row) {
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      4,
      '004_context_engine_v2_core',
      new Date().toISOString()
    );
  }

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
