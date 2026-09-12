# Implementation status — 2026-09-11

This is a working revision undergoing release validation.

## Corrected in this revision

- Removed automatic authentication as `user-default`.
- Firebase login passes an ID token; backend retrieves the identity from Firebase Auth. Client email and uid are not trusted.
- Removed local password-login fallback from public routes.
- Enforced project ownership and CSRF checks; added client CSRF header transport.
- Scoped provider configuration, skills, and secrets to the authenticated user; migrated legacy global provider/skill uniqueness.
- Removed host credential fallback for logged-in users.
- Consolidated integration settings with service-specific fields and actual read-access tests.
- Removed fake Firebase/custom-key success responses and false build/preview pass results.
- Added named pre-change checkpoints and path validation before application.
- Preserved URLs and source text when parsing structured JSON model responses.
- Excluded runtime database and encryption material from source distribution.
- Completed create, edit, and delete flows for user-owned Skills.
- Added an explicit explanation for Firebase authorized-domain failures in temporary previews.

## Verification

The release workflow runs typecheck, foundation and HTTP security tests, the original test suite, production build, and mandatory-login browser verification. Merge is allowed only after this workflow succeeds.

## Concluído nesta revisão

- Persistência direta e incremental no Supabase Postgres/Storage, com restauração antes do carregamento local e fallback legado de migração.
- Criação do zero, importação GitHub e upload ZIP validado pelo backend com preservação de binários.
- Propostas imutáveis no servidor, preview temporário, aprovação por ID, rejeição e rollback somente quando um gate executado falha.
- Execução de gates com ambiente filtrado, sem credenciais do Forge, e estado `unverified` quando nenhum gate se aplica.
- GitHub com criação/vínculo de repositório, pull, push, branches, pull requests e checkpoints nomeados.
- Provedores OpenAI-compatible/Gemini com endpoint e modelo configuráveis, teste real e seleção persistida por conta.
- Integrações GitHub, Cloudflare, Supabase e Firebase com vault, teste real e estado persistido; deploy Cloudflare Pages disponível.
- Login Firebase obrigatório, Google/e-mail e redefinição de senha.

## Fora do escopo deliberado desta revisão

- Multi-agent programmer/reviewer orchestration permanece pausada por decisão de produto.
- Gestão avançada de DNS/domínios e provisionamento de projetos externos continuam como expansão posterior.
- Empacotamento desktop desta nova base web permanece uma etapa de distribuição posterior.
- Rotate any real credentials that were stored in the previously committed database. Removing files from the latest commit does not erase Git history.

Sources used for protocols: https://firebase.google.com/docs/reference/rest/auth and https://supabase.com/docs/reference/api/v1-list-all-projects .

