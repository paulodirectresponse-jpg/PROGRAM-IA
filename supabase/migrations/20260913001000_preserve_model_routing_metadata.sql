alter table public.forge_model_profiles add column if not exists profile_key text;
alter table public.forge_model_profiles add column if not exists level integer not null default 0;
alter table public.forge_model_profiles add column if not exists max_attempts integer not null default 1;
alter table public.forge_model_profiles add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.forge_model_candidates add column if not exists provider_key text;
alter table public.forge_model_candidates add column if not exists health_state text not null default 'healthy';
alter table public.forge_model_candidates add column if not exists consecutive_failures integer not null default 0;
alter table public.forge_model_candidates add column if not exists circuit_open_until timestamptz;
alter table public.forge_model_candidates add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.forge_model_invocations add column if not exists run_id text;
alter table public.forge_model_invocations add column if not exists step_id text;
alter table public.forge_model_invocations add column if not exists agent_key text;
alter table public.forge_model_invocations add column if not exists profile_key text;
alter table public.forge_model_invocations add column if not exists provider_key text;
alter table public.forge_model_invocations add column if not exists latency_ms integer;
alter table public.forge_model_invocations add column if not exists error_code text;
alter table public.forge_model_invocations add column if not exists retry_index integer;
