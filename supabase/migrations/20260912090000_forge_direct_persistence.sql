-- Phase 3: incremental account persistence. The legacy snapshot table remains
-- temporarily available only as a migration/recovery source.

create table if not exists public.forge_accounts (
  user_id text primary key,
  firebase_uid text not null unique,
  email text,
  display_name text,
  schema_version integer not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists public.forge_entities (
  user_id text not null references public.forge_accounts(user_id) on delete cascade,
  firebase_uid text not null,
  entity_type text not null,
  entity_id text not null,
  project_id text,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, entity_type, entity_id)
);

create index if not exists forge_entities_project
  on public.forge_entities(user_id, project_id, entity_type);

create table if not exists public.forge_project_files (
  user_id text not null references public.forge_accounts(user_id) on delete cascade,
  firebase_uid text not null,
  project_id text not null,
  path text not null,
  storage_path text not null unique,
  sha256 text not null,
  size_bytes bigint not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, project_id, path)
);

alter table public.forge_accounts enable row level security;
alter table public.forge_entities enable row level security;
alter table public.forge_project_files enable row level security;

revoke all on public.forge_accounts, public.forge_entities, public.forge_project_files from anon;
grant select, insert, update, delete on public.forge_accounts, public.forge_entities, public.forge_project_files to authenticated;

drop policy if exists "forge account owner" on public.forge_accounts;
create policy "forge account owner" on public.forge_accounts for all to authenticated
  using ((select auth.jwt()->>'sub') = firebase_uid)
  with check ((select auth.jwt()->>'sub') = firebase_uid);

drop policy if exists "forge entity owner" on public.forge_entities;
create policy "forge entity owner" on public.forge_entities for all to authenticated
  using ((select auth.jwt()->>'sub') = firebase_uid)
  with check ((select auth.jwt()->>'sub') = firebase_uid);

drop policy if exists "forge file metadata owner" on public.forge_project_files;
create policy "forge file metadata owner" on public.forge_project_files for all to authenticated
  using ((select auth.jwt()->>'sub') = firebase_uid)
  with check ((select auth.jwt()->>'sub') = firebase_uid);

insert into storage.buckets (id, name, public, file_size_limit)
values ('forge-project-files', 'forge-project-files', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "forge storage owner read" on storage.objects;
create policy "forge storage owner read" on storage.objects for select to authenticated
  using (bucket_id = 'forge-project-files' and (storage.foldername(name))[1] = (select auth.jwt()->>'sub'));

drop policy if exists "forge storage owner insert" on storage.objects;
create policy "forge storage owner insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'forge-project-files' and (storage.foldername(name))[1] = (select auth.jwt()->>'sub'));

drop policy if exists "forge storage owner update" on storage.objects;
create policy "forge storage owner update" on storage.objects for update to authenticated
  using (bucket_id = 'forge-project-files' and (storage.foldername(name))[1] = (select auth.jwt()->>'sub'))
  with check (bucket_id = 'forge-project-files' and (storage.foldername(name))[1] = (select auth.jwt()->>'sub'));

drop policy if exists "forge storage owner delete" on storage.objects;
create policy "forge storage owner delete" on storage.objects for delete to authenticated
  using (bucket_id = 'forge-project-files' and (storage.foldername(name))[1] = (select auth.jwt()->>'sub'));

