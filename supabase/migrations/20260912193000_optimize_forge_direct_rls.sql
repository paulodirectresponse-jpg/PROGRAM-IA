drop policy if exists "forge account owner" on public.forge_accounts;
create policy "forge account owner" on public.forge_accounts for all to authenticated
  using (((select auth.jwt())->>'sub') = firebase_uid)
  with check (((select auth.jwt())->>'sub') = firebase_uid);

drop policy if exists "forge entity owner" on public.forge_entities;
create policy "forge entity owner" on public.forge_entities for all to authenticated
  using (((select auth.jwt())->>'sub') = firebase_uid)
  with check (((select auth.jwt())->>'sub') = firebase_uid);

drop policy if exists "forge file metadata owner" on public.forge_project_files;
create policy "forge file metadata owner" on public.forge_project_files for all to authenticated
  using (((select auth.jwt())->>'sub') = firebase_uid)
  with check (((select auth.jwt())->>'sub') = firebase_uid);
