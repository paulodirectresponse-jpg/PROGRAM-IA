-- Phase A: make project file metadata use canonical Firebase ownership.
-- Legacy forge_accounts remains available only for migration/compatibility reads.

do $$
declare
  constraint_name text;
begin
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'public.forge_project_files'::regclass
    and conname = 'forge_project_files_user_id_fkey';

  if constraint_name is not null then
    execute format('alter table public.forge_project_files drop constraint %I', constraint_name);
  end if;
end $$;

do $$
declare
  constraint_name text;
begin
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'public.forge_project_files'::regclass
    and contype = 'p'
    and conname = 'forge_project_files_pkey';

  if constraint_name is not null then
    execute format('alter table public.forge_project_files drop constraint %I', constraint_name);
  end if;
end $$;

alter table public.forge_project_files
  alter column user_id drop not null;

alter table public.forge_project_files
  add column if not exists firebase_uid text;

update public.forge_project_files files
set firebase_uid = coalesce(files.firebase_uid, accounts.firebase_uid)
from public.forge_accounts accounts
where files.user_id = accounts.user_id
  and files.firebase_uid is null;


alter table public.forge_project_files
  add column if not exists content_type text,
  add column if not exists created_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.forge_project_files'::regclass
      and conname = 'forge_project_files_firebase_uid_fkey'
  ) then
    alter table public.forge_project_files
      add constraint forge_project_files_firebase_uid_fkey
      foreign key (firebase_uid)
      references public.forge_profiles(firebase_uid)
      on delete cascade
      not valid;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.forge_project_files'::regclass
      and conname = 'forge_project_files_project_id_fkey'
  ) then
    alter table public.forge_project_files
      add constraint forge_project_files_project_id_fkey
      foreign key (project_id)
      references public.forge_projects(id)
      on delete cascade
      not valid;
  end if;
end $$;

create unique index if not exists forge_project_files_canonical_identity
  on public.forge_project_files(firebase_uid, project_id, path);

create index if not exists forge_project_files_owner
  on public.forge_project_files(firebase_uid);

create index if not exists forge_project_files_project
  on public.forge_project_files(project_id);

drop policy if exists "forge file metadata owner" on public.forge_project_files;
create policy "forge file metadata owner" on public.forge_project_files for all to authenticated
  using (((select auth.jwt())->>'sub') = firebase_uid)
  with check (((select auth.jwt())->>'sub') = firebase_uid);
