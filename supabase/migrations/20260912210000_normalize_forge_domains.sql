-- Phase A: canonical, normalized persistence. Legacy tables remain read-only migration sources.
create table if not exists public.forge_profiles (
  firebase_uid text primary key, email text, display_name text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.forge_projects (
  id text primary key, firebase_uid text not null references public.forge_profiles(firebase_uid) on delete cascade,
  workspace_id text, name text not null, description text, origin text not null,
  status text not null default 'active', current_checkpoint_id text, revision bigint not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(firebase_uid,id)
);
create index if not exists forge_projects_owner_updated on public.forge_projects(firebase_uid,updated_at desc);

create table if not exists public.forge_conversations (
  id text primary key, firebase_uid text not null references public.forge_profiles(firebase_uid) on delete cascade,
  project_id text not null references public.forge_projects(id) on delete cascade, title text not null, mode text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.forge_messages (
  id text primary key, firebase_uid text not null references public.forge_profiles(firebase_uid) on delete cascade,
  conversation_id text not null references public.forge_conversations(id) on delete cascade,
  sender text not null, content text not null, metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table if not exists public.forge_providers (
  id text primary key, firebase_uid text not null references public.forge_profiles(firebase_uid) on delete cascade,
  provider_key text not null, name text not null, base_url text not null, model_id text not null,
  extra_headers jsonb not null default '{}'::jsonb, configured boolean not null default false,
  active boolean not null default false, health text not null default 'untested', last_error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(firebase_uid,provider_key)
);
create table if not exists public.forge_provider_secrets (
  id text primary key, firebase_uid text not null references public.forge_profiles(firebase_uid) on delete cascade,
  provider_id text references public.forge_providers(id) on delete cascade, service_key text not null,
  encrypted_value text not null, iv text not null, tag text not null, masked_hint text not null,
  status text not null default 'configured', last_tested_at timestamptz, last_error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(firebase_uid,service_key)
);
create table if not exists public.forge_integrations (
  id text primary key, firebase_uid text not null references public.forge_profiles(firebase_uid) on delete cascade,
  service_name text not null, config jsonb not null default '{}'::jsonb, status text not null default 'pending_credentials',
  last_verified_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(firebase_uid,service_name)
);
create table if not exists public.forge_skills (
  id text primary key, firebase_uid text not null references public.forge_profiles(firebase_uid) on delete cascade,
  project_id text references public.forge_projects(id) on delete cascade, name text not null, slug text not null,
  description text not null, system_instructions text not null, scope text not null default 'project', active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(firebase_uid,project_id,slug)
);
create table if not exists public.forge_checkpoints (
  id text primary key, firebase_uid text not null references public.forge_profiles(firebase_uid) on delete cascade,
  project_id text not null references public.forge_projects(id) on delete cascade, title text not null, description text,
  parent_id text, files_manifest jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create table if not exists public.forge_repositories (
  id text primary key, firebase_uid text not null references public.forge_profiles(firebase_uid) on delete cascade,
  project_id text not null references public.forge_projects(id) on delete cascade, remote_url text,
  default_branch text, visibility text, connected boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(project_id)
);
create table if not exists public.forge_branches (
  id text primary key, firebase_uid text not null references public.forge_profiles(firebase_uid) on delete cascade,
  project_id text not null references public.forge_projects(id) on delete cascade, name text not null,
  current boolean not null default false, head_sha text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(project_id,name)
);
create unique index if not exists forge_one_current_branch on public.forge_branches(project_id) where current;
create table if not exists public.forge_model_profiles (
  id text primary key, firebase_uid text not null references public.forge_profiles(firebase_uid) on delete cascade,
  name text not null, profile_type text not null, max_cost_usd numeric, active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.forge_model_candidates (
  id text primary key, firebase_uid text not null references public.forge_profiles(firebase_uid) on delete cascade,
  profile_id text not null references public.forge_model_profiles(id) on delete cascade, provider_id text,
  model_id text not null, priority integer not null default 0, active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.forge_model_invocations (
  id text primary key, firebase_uid text not null references public.forge_profiles(firebase_uid) on delete cascade,
  project_id text references public.forge_projects(id) on delete set null, provider_id text, model_id text,
  status text not null, cost_usd numeric, tokens_input bigint, tokens_output bigint, metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.forge_project_files add column if not exists content_type text;
alter table public.forge_project_files add column if not exists created_at timestamptz not null default now();

do $$ declare t text; begin
  foreach t in array array['forge_profiles','forge_projects','forge_conversations','forge_messages','forge_providers','forge_provider_secrets','forge_integrations','forge_skills','forge_checkpoints','forge_repositories','forge_branches','forge_model_profiles','forge_model_candidates','forge_model_invocations'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon',t);
    execute format('grant select,insert,update,delete on public.%I to authenticated',t);
    execute format('drop policy if exists %I on public.%I','forge_owner_'||t,t);
    execute format('create policy %I on public.%I for all to authenticated using (((select auth.jwt())->>''sub'') = firebase_uid) with check (((select auth.jwt())->>''sub'') = firebase_uid)','forge_owner_'||t,t);
  end loop;
end $$;
