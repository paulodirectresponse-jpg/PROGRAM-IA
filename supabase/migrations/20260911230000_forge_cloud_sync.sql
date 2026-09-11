create table if not exists public.forge_sync_snapshots (
  user_id text primary key,
  revision bigint not null default 1,
  device_id text not null,
  schema_version integer not null default 1,
  payload jsonb not null,
  payload_hash text not null,
  updated_at timestamptz not null default now()
);
alter table public.forge_sync_snapshots enable row level security;
revoke all on public.forge_sync_snapshots from anon;
grant select, insert, update, delete on public.forge_sync_snapshots to authenticated;
create policy "firebase users read own snapshot" on public.forge_sync_snapshots for select to authenticated
using ((select auth.jwt()->>'sub') = user_id);
create policy "firebase users insert own snapshot" on public.forge_sync_snapshots for insert to authenticated
with check ((select auth.jwt()->>'sub') = user_id);
create policy "firebase users update own snapshot" on public.forge_sync_snapshots for update to authenticated
using ((select auth.jwt()->>'sub') = user_id) with check ((select auth.jwt()->>'sub') = user_id);
create policy "firebase users delete own snapshot" on public.forge_sync_snapshots for delete to authenticated
using ((select auth.jwt()->>'sub') = user_id);


