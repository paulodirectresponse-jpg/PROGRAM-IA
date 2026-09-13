-- Phase A: preserve whether a restored skill was created by the user.

alter table public.forge_skills
  add column if not exists is_custom boolean not null default false;