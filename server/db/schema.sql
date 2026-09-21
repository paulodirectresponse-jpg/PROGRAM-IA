-- Migration 001: Initial schema with all 21 entities specified in GOOGLE_AI_STUDIO_PROJECT_SPEC.md

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

-- 1. users
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'developer',
  created_at TEXT NOT NULL
);

-- 2. workspaces
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 3. projects
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  origin TEXT NOT NULL, -- 'novo', 'local', 'github'
  repo_url TEXT,
  branch TEXT DEFAULT 'main',
  status TEXT DEFAULT 'active', -- 'active', 'archived'
  current_checkpoint_id TEXT,
  provider_id TEXT,
  model_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 4. project_sources
CREATE TABLE IF NOT EXISTS project_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL, -- 'scratch', 'github_repo', 'zip_upload'
  original_path_or_url TEXT,
  created_at TEXT NOT NULL
);

-- 5. repositories
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  remote_url TEXT,
  default_branch TEXT DEFAULT 'main',
  visibility TEXT DEFAULT 'private',
  is_connected INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 6. branches
CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_current INTEGER DEFAULT 1,
  head_commit_hash TEXT,
  created_at TEXT NOT NULL
);

-- 7. conversations
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  mode TEXT DEFAULT 'plan', -- 'plan', 'build', 'review', 'publish'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 8. messages
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender TEXT NOT NULL, -- 'user', 'agent', 'system'
  content TEXT NOT NULL,
  metadata_json TEXT, -- tools used, files affected, plan id
  created_at TEXT NOT NULL
);

-- 9. attachments
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL,
  hash TEXT,
  storage_path TEXT,
  status TEXT DEFAULT 'processed',
  analysis_text TEXT,
  created_at TEXT NOT NULL
);

-- 10. tasks
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT DEFAULT 'pending', -- 'pending', 'in_progress', 'completed', 'failed'
  mode TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 11. plans
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  project_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  scope_in TEXT NOT NULL,
  scope_out TEXT NOT NULL,
  architecture_summary TEXT NOT NULL DEFAULT '',
  existing_files_json TEXT NOT NULL DEFAULT '[]',
  new_files_json TEXT NOT NULL DEFAULT '[]',
  files_to_delete_json TEXT NOT NULL DEFAULT '[]',
  files_affected_json TEXT NOT NULL,
  integrations_json TEXT,
  risks_json TEXT,
  acceptance_criteria_json TEXT NOT NULL,
  requirements_json TEXT NOT NULL DEFAULT '[]',
  task_graph_json TEXT NOT NULL DEFAULT '[]',
  status TEXT DEFAULT 'draft', -- 'draft', 'approved', 'rejected'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 11b. requirement ledger
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
CREATE INDEX IF NOT EXISTS idx_requirements_project_status ON requirements(project_id,status);
CREATE INDEX IF NOT EXISTS idx_requirements_run ON requirements(run_id);

-- Phase 1: Context Engine V2
CREATE TABLE IF NOT EXISTS context_project_files (
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  language TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  symbols_json TEXT NOT NULL DEFAULT '[]',
  imports_json TEXT NOT NULL DEFAULT '[]',
  exports_json TEXT NOT NULL DEFAULT '[]',
  module_key TEXT NOT NULL DEFAULT 'root',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id,path)
);
CREATE INDEX IF NOT EXISTS idx_context_project_files_hash ON context_project_files(project_id,hash);
CREATE INDEX IF NOT EXISTS idx_context_project_files_module ON context_project_files(project_id,module_key);

CREATE TABLE IF NOT EXISTS context_architecture_graphs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  graph_hash TEXT NOT NULL,
  graph_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,graph_hash)
);
CREATE INDEX IF NOT EXISTS idx_context_architecture_project ON context_architecture_graphs(project_id,created_at);

CREATE TABLE IF NOT EXISTS context_commits (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT,
  task_id TEXT,
  agent_key TEXT,
  scope TEXT NOT NULL DEFAULT 'TASK',
  task TEXT NOT NULL,
  decisions_json TEXT NOT NULL DEFAULT '[]',
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  requirement_ids_json TEXT NOT NULL DEFAULT '[]',
  validation_json TEXT NOT NULL DEFAULT 'null',
  blockers_json TEXT NOT NULL DEFAULT '[]',
  next_state_json TEXT NOT NULL DEFAULT 'null',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_commits_project ON context_commits(project_id,created_at);
CREATE INDEX IF NOT EXISTS idx_context_commits_run ON context_commits(run_id,created_at);

CREATE TABLE IF NOT EXISTS context_packs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT,
  step_id TEXT,
  agent_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  project_hash TEXT NOT NULL,
  token_budget INTEGER NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  selected_files_json TEXT NOT NULL DEFAULT '[]',
  omitted_files_json TEXT NOT NULL DEFAULT '[]',
  pack_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_packs_project ON context_packs(project_id,created_at);
CREATE INDEX IF NOT EXISTS idx_context_packs_run ON context_packs(run_id,created_at);

-- Phase 2: Tool-first execution journal foundation
CREATE TABLE IF NOT EXISTS tool_executions (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  step_id TEXT,
  tool_key TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  project_id TEXT,
  tool_version TEXT NOT NULL DEFAULT '1',
  error_code TEXT,
  attempt_index INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  request_hash TEXT,
  resume_policy TEXT NOT NULL DEFAULT 'inspect_only',
  started_at TEXT,
  finished_at TEXT,
  sandbox_id TEXT
);
CREATE INDEX IF NOT EXISTS tool_executions_run_created ON tool_executions(run_id,created_at);
CREATE INDEX IF NOT EXISTS tool_executions_step_created ON tool_executions(step_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS tool_executions_run_idempotency ON tool_executions(run_id,idempotency_key)
  WHERE run_id IS NOT NULL AND idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS tool_executions_sandbox_created ON tool_executions(sandbox_id,created_at);

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

-- Phase 3: Browser Agent + Quality Gate
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

-- Phase 4: Benchmark + release gate
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
CREATE UNIQUE INDEX IF NOT EXISTS benchmark_runs_one_active_user ON benchmark_runs(user_id) WHERE status IN ('queued','running');

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

-- Spaces V2 Phase 1: atomic persisted canvas document
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT,
  title TEXT NOT NULL DEFAULT 'Space sem título',
  nodes_json TEXT NOT NULL DEFAULT '[]',
  edges_json TEXT NOT NULL DEFAULT '[]',
  viewport_json TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS spaces_user_updated ON spaces(user_id,updated_at);
CREATE INDEX IF NOT EXISTS spaces_project_updated ON spaces(project_id,updated_at);

-- 12. skills
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL,
  system_instructions TEXT NOT NULL,
  scope TEXT DEFAULT 'project', -- 'message', 'project', 'workspace'
  is_active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 13. providers
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  provider_key TEXT UNIQUE NOT NULL, -- 'useoneai', 'openai', 'gemini'
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model_id TEXT NOT NULL,
  extra_headers_json TEXT,
  streaming_supported INTEGER DEFAULT 1,
  vision_supported INTEGER DEFAULT 0,
  tools_supported INTEGER DEFAULT 1,
  json_supported INTEGER DEFAULT 1,
  context_limit INTEGER DEFAULT 128000,
  is_configured INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 0,
  connection_status TEXT DEFAULT 'not_configured', -- 'connected', 'not_configured', 'error'
  last_error TEXT,
  created_at TEXT NOT NULL
);

-- 14. models
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL
);

-- 15. checkpoints
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  parent_id TEXT,
  files_snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 16. file_changes
CREATE TABLE IF NOT EXISTS file_changes (
  id TEXT PRIMARY KEY,
  checkpoint_id TEXT,
  project_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  action TEXT NOT NULL, -- 'create', 'modify', 'delete'
  old_content TEXT,
  new_content TEXT,
  diff_patch TEXT,
  created_at TEXT NOT NULL
);

-- 17. verifications
CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  checkpoint_id TEXT,
  gate_type TEXT NOT NULL, -- 'build', 'typecheck', 'lint', 'security', 'preview'
  status TEXT NOT NULL, -- 'pass', 'fail', 'warn'
  details_json TEXT,
  created_at TEXT NOT NULL
);

-- 18. logs
CREATE TABLE IF NOT EXISTS logs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  category TEXT NOT NULL,
  level TEXT NOT NULL, -- 'info', 'warn', 'error'
  message TEXT NOT NULL,
  meta_json TEXT,
  created_at TEXT NOT NULL
);

-- 19. deployments
CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  target TEXT NOT NULL, -- 'preview', 'github_pages', 'cloud_run'
  status TEXT NOT NULL, -- 'pending', 'active', 'failed'
  url TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL
);

-- 20. integrations
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  service_name TEXT NOT NULL, -- 'github', 'useoneai', 'gemini'
  config_json TEXT,
  status TEXT DEFAULT 'pending_credentials', -- 'connected', 'pending_credentials', 'error'
  last_verified_at TEXT,
  created_at TEXT NOT NULL
);

-- 21. audit_events
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  project_id TEXT,
  action TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);

-- 22. sessions (Persistent auth sessions)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL
);

-- 23. user_secrets (AES-256-GCM encrypted per-user credentials)
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


