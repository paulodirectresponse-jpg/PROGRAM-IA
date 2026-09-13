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
  size_bytes INTEGER NOT NULL,
  hash TEXT,
  storage_path TEXT,
  status TEXT DEFAULT 'processed',
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
  files_affected_json TEXT NOT NULL,
  integrations_json TEXT,
  risks_json TEXT,
  acceptance_criteria_json TEXT NOT NULL,
  status TEXT DEFAULT 'draft', -- 'draft', 'approved', 'rejected'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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


