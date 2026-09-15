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

export function applyBootstrapSchemaIfNeeded(database:DatabaseSync,schemaSql:string){
  const existingSchema=database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if(!existingSchema)database.exec(schemaSql);
}

// Run migrations and initial seeds
export function initializeDatabase() {
  // schema.sql is a bootstrap snapshot, not an incremental migration. Replaying it
  // against an older persistent database can reference additive columns before the
  // corresponding migration has created them (for example Phase 2 indexes).
  const schemaPath = path.resolve(process.cwd(), 'server', 'db', 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    applyBootstrapSchemaIfNeeded(db,schemaSql);
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
  ensureColumn('attachments', 'mime_type', "TEXT");
  ensureColumn('attachments', 'analysis_text', "TEXT");
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
    CREATE TABLE IF NOT EXISTS model_invocations (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,project_id TEXT,run_id TEXT,step_id TEXT,agent_key TEXT,profile_key TEXT,provider_key TEXT NOT NULL,model_id TEXT NOT NULL,input_tokens INTEGER DEFAULT 0,output_tokens INTEGER DEFAULT 0,cost_usd REAL,cost_status TEXT NOT NULL DEFAULT 'legacy',budget_cost_usd REAL NOT NULL DEFAULT 0,latency_ms INTEGER NOT NULL,status TEXT NOT NULL,error_code TEXT,retry_index INTEGER DEFAULT 0,context_pack_id TEXT,context_scope TEXT,project_hash TEXT,context_tokens INTEGER DEFAULT 0,context_selected_files_json TEXT NOT NULL DEFAULT '[]',context_omitted_files_count INTEGER DEFAULT 0,created_at TEXT NOT NULL);
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

  ensureColumn('model_invocations', 'cost_status', "TEXT NOT NULL DEFAULT 'legacy'");
  ensureColumn('model_invocations', 'budget_cost_usd', 'REAL NOT NULL DEFAULT 0');

  const migration8Row = db.prepare('SELECT version,applied_at FROM schema_migrations WHERE version = 8').get() as { version: number; applied_at?:string } | undefined;
  if (!migration8Row) {
    db.prepare("UPDATE model_invocations SET cost_status=CASE WHEN cost_status IS NULL OR cost_status='' OR cost_status='legacy' THEN CASE WHEN COALESCE(cost_usd,0)>0 THEN 'reported' ELSE 'unknown' END ELSE cost_status END").run();
    db.prepare(`UPDATE model_invocations
      SET budget_cost_usd=CASE
        WHEN budget_cost_usd IS NOT NULL AND budget_cost_usd>0 THEN budget_cost_usd
        WHEN cost_status IN ('reported','known_zero') THEN COALESCE(cost_usd,0)
        ELSE COALESCE((
          SELECT max_cost_usd FROM model_profiles p
          WHERE p.user_id=model_invocations.user_id AND p.profile_key=model_invocations.profile_key
          LIMIT 1
        ),COALESCE(cost_usd,0))
      END`).run();
    db.prepare('UPDATE agent_runs SET spent_usd=COALESCE((SELECT SUM(mi.budget_cost_usd) FROM model_invocations mi WHERE mi.run_id=agent_runs.id),0)').run();
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      8,
      '008_cost_telemetry_truthfulness',
      new Date().toISOString()
    );
  }

  // Migration 013: undo conservative reservations that were retroactively assigned
  // to pre-telemetry legacy rows. Conservative reservation remains mandatory for
  // every unknown invocation created after migration 008.
  const migration13Row = db.prepare('SELECT version FROM schema_migrations WHERE version = 13').get() as { version:number } | undefined;
  if (!migration13Row) {
    const migration8 = db.prepare('SELECT applied_at FROM schema_migrations WHERE version = 8').get() as { applied_at?:string } | undefined;
    const cutoff=String(migration8?.applied_at||'');
    if(cutoff){
      db.prepare(`UPDATE model_invocations
        SET budget_cost_usd=0,cost_status='legacy'
        WHERE created_at<=?
          AND cost_status='unknown'
          AND COALESCE(cost_usd,0)=0`).run(cutoff);
      db.prepare('UPDATE agent_runs SET spent_usd=COALESCE((SELECT SUM(mi.budget_cost_usd) FROM model_invocations mi WHERE mi.run_id=agent_runs.id),0)').run();
    }
    db.prepare('INSERT INTO schema_migrations (version,name,applied_at) VALUES(?,?,?)').run(
      13,'013_repair_legacy_cost_reservations',new Date().toISOString()
    );
  }

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

  // Migration 005: Tool-first execution journal foundation.
  ensureColumn('tool_executions', 'project_id', 'TEXT');
  ensureColumn('tool_executions', 'tool_version', "TEXT NOT NULL DEFAULT '1'");
  ensureColumn('tool_executions', 'error_code', 'TEXT');
  ensureColumn('tool_executions', 'attempt_index', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('tool_executions', 'idempotency_key', 'TEXT');
  ensureColumn('tool_executions', 'request_hash', 'TEXT');
  ensureColumn('tool_executions', 'resume_policy', "TEXT NOT NULL DEFAULT 'inspect_only'");
  ensureColumn('tool_executions', 'started_at', 'TEXT');
  ensureColumn('tool_executions', 'finished_at', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS tool_executions_run_created ON tool_executions(run_id,created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS tool_executions_step_created ON tool_executions(step_id,created_at)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS tool_executions_run_idempotency ON tool_executions(run_id,idempotency_key) WHERE run_id IS NOT NULL AND idempotency_key IS NOT NULL');

  const migration5Row = db.prepare('SELECT version FROM schema_migrations WHERE version = 5').get() as { version: number } | undefined;
  if (!migration5Row) {
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      5,
      '005_tool_execution_journal_foundation',
      new Date().toISOString()
    );
  }

  // Migration 006: isolated sandbox lifecycle.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sandboxes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      run_id TEXT,
      step_id TEXT,
      status TEXT NOT NULL,
      root_path TEXT NOT NULL,
      base_hash TEXT NOT NULL,
      base_manifest_json TEXT NOT NULL DEFAULT '{}',
      validation_json TEXT NOT NULL DEFAULT 'null',
      merged_checkpoint_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sandboxes_project_status ON sandboxes(project_id,status);
    CREATE INDEX IF NOT EXISTS sandboxes_run ON sandboxes(run_id,created_at);
  `);
  ensureColumn('tool_executions', 'sandbox_id', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS tool_executions_sandbox_created ON tool_executions(sandbox_id,created_at)');
  const migration6Row = db.prepare('SELECT version FROM schema_migrations WHERE version = 6').get() as { version: number } | undefined;
  if (!migration6Row) {
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      6,
      '006_phase2_isolated_sandboxes',
      new Date().toISOString()
    );
  }

  // Migration 007: Browser Agent + Quality Gate evidence.
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_quality_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      run_id TEXT,
      step_id TEXT,
      sandbox_id TEXT NOT NULL,
      status TEXT NOT NULL,
      runtime_kind TEXT NOT NULL,
      framework TEXT,
      entry_path TEXT,
      url TEXT,
      issues_json TEXT NOT NULL DEFAULT '[]',
      viewports_json TEXT NOT NULL DEFAULT '[]',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS browser_quality_project_created ON browser_quality_runs(project_id,created_at);
    CREATE INDEX IF NOT EXISTS browser_quality_run_created ON browser_quality_runs(run_id,created_at);
    CREATE INDEX IF NOT EXISTS browser_quality_sandbox_created ON browser_quality_runs(sandbox_id,created_at);
  `);
  const migration7Row = db.prepare('SELECT version FROM schema_migrations WHERE version = 7').get() as { version: number } | undefined;
  if (!migration7Row) {
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      7,
      '007_phase3_browser_quality_gate',
      new Date().toISOString()
    );
  }

  // Migration 009: Phase 4 benchmark framework. Migration 008 is cost telemetry.
  db.exec(`
    CREATE TABLE IF NOT EXISTS benchmark_runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      suite_key TEXT NOT NULL,
      status TEXT NOT NULL,
      total_cases INTEGER NOT NULL,
      completed_cases INTEGER NOT NULL DEFAULT 0,
      passed_cases INTEGER NOT NULL DEFAULT 0,
      failed_cases INTEGER NOT NULL DEFAULT 0,
      max_cost_usd REAL NOT NULL,
      spent_usd REAL NOT NULL DEFAULT 0,
      allow_expert INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL DEFAULT '{}',
      summary_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS benchmark_runs_user_created ON benchmark_runs(user_id,created_at);
    CREATE TABLE IF NOT EXISTS benchmark_case_runs (
      id TEXT PRIMARY KEY,
      benchmark_run_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      case_order INTEGER NOT NULL,
      category TEXT NOT NULL,
      mode TEXT NOT NULL,
      agent_key TEXT NOT NULL,
      status TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      passed INTEGER NOT NULL DEFAULT 0,
      project_id TEXT,
      agent_run_id TEXT,
      provider_real INTEGER NOT NULL DEFAULT 0,
      profile_key TEXT,
      provider_key TEXT,
      model_id TEXT,
      cost_usd REAL NOT NULL DEFAULT 0,
      budget_cost_usd REAL NOT NULL DEFAULT 0,
      unknown_cost_calls INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      repairs INTEGER NOT NULL DEFAULT 0,
      expert_escalations INTEGER NOT NULL DEFAULT 0,
      validator_status TEXT,
      browser_status TEXT,
      failure_reason TEXT,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      UNIQUE(benchmark_run_id,case_id)
    );
    CREATE INDEX IF NOT EXISTS benchmark_case_runs_run_order ON benchmark_case_runs(benchmark_run_id,case_order);
    CREATE INDEX IF NOT EXISTS benchmark_case_runs_case ON benchmark_case_runs(case_id,created_at);
  `);
  ensureColumn('benchmark_case_runs','budget_cost_usd','REAL NOT NULL DEFAULT 0');
  ensureColumn('benchmark_case_runs','unknown_cost_calls','INTEGER NOT NULL DEFAULT 0');
  const migration9Row = db.prepare('SELECT version FROM schema_migrations WHERE version = 9').get() as { version: number } | undefined;
  if (!migration9Row) {
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      9,'009_phase4_benchmark_framework',new Date().toISOString()
    );
  }

  // Migration 010: retain benchmark invocation provenance while ephemeral projects are removed.
  ensureColumn('model_invocations','benchmark_run_id','TEXT');
  ensureColumn('model_invocations','benchmark_case_id','TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS model_invocations_benchmark_run ON model_invocations(benchmark_run_id,created_at)');
  const migration10Row = db.prepare('SELECT version FROM schema_migrations WHERE version = 10').get() as { version: number } | undefined;
  if (!migration10Row) {
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      10,'010_phase4_benchmark_invocation_provenance',new Date().toISOString()
    );
  }

  // Migration 011: one paid benchmark may be active per user.
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS benchmark_runs_one_active_user ON benchmark_runs(user_id) WHERE status IN ('queued','running')");
  const migration11Row = db.prepare('SELECT version FROM schema_migrations WHERE version = 11').get() as { version: number } | undefined;
  if (!migration11Row) {
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      11,'011_phase4_single_active_benchmark_per_user',new Date().toISOString()
    );
  }

  // Migration 012: idempotent server-side Phase 4 smoke requests.
  db.exec(`
    CREATE TABLE IF NOT EXISTS benchmark_smoke_requests (
      request_id TEXT PRIMARY KEY,
      user_id TEXT,
      benchmark_run_id TEXT,
      status TEXT NOT NULL,
      max_cost_usd REAL NOT NULL,
      case_ids_json TEXT NOT NULL DEFAULT '[]',
      report_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS benchmark_smoke_requests_created ON benchmark_smoke_requests(created_at);
  `);
  const migration12Row = db.prepare('SELECT version FROM schema_migrations WHERE version = 12').get() as { version: number } | undefined;
  if (!migration12Row) {
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      12,'012_phase4_server_side_smoke_request',new Date().toISOString()
    );
  }

  db.prepare("UPDATE tool_executions SET status='interrupted',error_code=COALESCE(error_code,'worker_interrupted'),finished_at=COALESCE(finished_at,?) WHERE status IN ('queued','running')").run(new Date().toISOString());
  const restartRecoveryAt=new Date().toISOString();
  db.prepare("UPDATE agent_steps SET status='aborted',finished_at=? WHERE status='running' AND run_id IN (SELECT DISTINCT run_id FROM tool_executions WHERE status='interrupted' AND run_id IS NOT NULL)")
    .run(restartRecoveryAt);
  db.prepare("UPDATE agent_runs SET status='failed',finished_at=? WHERE status='running' AND id IN (SELECT DISTINCT run_id FROM tool_executions WHERE status='interrupted' AND run_id IS NOT NULL)")
    .run(restartRecoveryAt);

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
