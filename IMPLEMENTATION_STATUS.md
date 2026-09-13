# PROGRAM-IA — Implementation status

Atualizado em 2026-09-13 após a consolidação B→I.

A `main` representa uma base funcional em validação de release. O CI oficial deve permanecer verde a cada mudança.

## Arquitetura canônica atual

- Firebase Auth = identidade do PROGRAM-IA.
- Sessão Forge = cookie HttpOnly emitido pelo backend após validação do ID token Firebase.
- Supabase Postgres/Storage = persistência cloud canônica.
- SQLite/workspace local = camada operacional/cache reconstruível.
- `repositories` + `branches` = estado canônico do GitHub.
- `ValidatorEngine` + `ExecutionWorker` = validação e gates executáveis.
- `LLMAdapterService` = execução de providers.
- `ModelRouter` = perfis, candidates, budget, circuit breaker e telemetria.
- Agent Engine = feature flag de runtime; infraestrutura presente, state machine completa ainda pendente.

## Consolidado

### B — Fundação, auth e persistência
- login local removido do fluxo público e da UI;
- identidade Firebase estável por UID;
- `user-default` e `ws-default` não são provisionados;
- Firestore interno removido; Firebase permanece apenas para autenticação do Forge;
- escrita cloud normal usa tabelas normalizadas + Storage;
- pull/push manuais usam somente a persistência canônica;
- snapshot legado permanece apenas como leitor de bootstrap/migração.

### C — Projetos, ZIP e preview
- criação/importação aguarda sucesso real do backend;
- ZIP é validado no backend, preserva binários e trata wrapper root;
- preview permite rede controlada por CSP;
- `ExecutionWorker` executa scripts allowlisted com env filtrado, timeout e AbortSignal.

O runtime geral de frameworks/dev servers ainda não está concluído. Ver `CODEX_HANDOFF.md`.

### D — Providers
- tester canônico em `LLMAdapterService`;
- taxonomia de erro para timeout, key/model, rate limit, network e upstream;
- provider ativo por usuário;
- status e timestamps de verificação persistidos;
- profiles/candidates, telemetria, circuit breaker e budget implementados;
- Agent Engine não pode mais escapar silenciosamente do perfil para o provider ativo.

### E — GitHub
- criação/vínculo, pull, push, branches, status, PR e publicação via chat;
- SHA real de branch;
- status inconclusivo fica `unknown`;
- push propaga deleções e suporta binários;
- consumidores operacionais usam `repositories` + `branches`, com campos de `projects` apenas como compatibilidade transitória.

### F — Validator
- `ValidatorEngine` é o validator canônico;
- verificações ligadas a checkpoint;
- gates executam em worker real quando aplicáveis;
- `unverified` é usado quando não existe gate executável;
- rollback após gate executado falhar possui teste HTTP real.

### G — Integrações
- GitHub, Cloudflare, Supabase e Firebase possuem configuração no vault e teste real;
- salvar configuração volta para `pending_credentials`;
- falha de teste persiste `error`;
- Cloudflare Pages atual é Git-trigger e registra sucesso/falha.

Direct Upload e E2E com credenciais reais permanecem pendentes. Ver `CODEX_HANDOFF.md`.

### H — Agent Engine
Já existem:
- SCOUT, STUDIO, FORGE, SENTINEL e SHIP;
- BASE_FREE, EXPERT_PAID e PREMIUM_OVERRIDE;
- candidates substituíveis;
- budget, telemetria e circuit breaker;
- `agent_runs`, `agent_steps` e `tool_executions`;
- UI de agentes/perfis;
- feature flag transparente no runtime.

A state machine multi-step, escalonamento por step, loop de correção limitado e benchmark final ainda são trabalho pendente do Codex.

### I — Limpeza
- modais antigos removidos;
- segunda UI de credenciais removida;
- tester duplicado removido;
- bootstrap/demo morto removido;
- Firestore operacional removido;
- documentação atualizada para a arquitetura canônica.

## Pendências que bloqueiam “release completa”

O backlog executável está em `CODEX_HANDOFF.md`. Os principais gates restantes são runtime real de frameworks, E2E externo, state machine multiagente e remoção destrutiva do snapshot/colunas espelho somente depois de reconciliação real.
