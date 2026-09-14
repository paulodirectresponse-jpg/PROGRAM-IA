# PROGRAM-IA — Implementation status

Atualizado em 2026-09-13 após integração final local da Fase 1 — Context Engine V2.

A `main` está em consolidação para release. O CI remoto precisa terminar `success`; `cancelled`, `skipped` ou timeout não contam como verde.

## Arquitetura canônica atual

- Firebase Auth = identidade do PROGRAM-IA.
- Sessão Forge = cookie HttpOnly emitido pelo backend após validação do ID token Firebase.
- Supabase Postgres/Storage = persistência cloud canônica.
- SQLite/workspace local = camada operacional/cache reconstruível.
- `repositories` + `branches` = estado canônico do GitHub.
- `ValidatorEngine` + `ExecutionWorker` = validação e gates executáveis.
- `RuntimeManager` = runtime controlado de preview para projetos com framework.
- `LLMAdapterService` = execução de providers.
- `ModelRouter` = perfis, candidates, budget, circuit breaker e telemetria.
- Agent Engine = state machine determinística com Context Engine V2 como fonte primária de contexto dos agentes.

## Consolidado

### B — Fundação, auth e persistência
- login local removido do fluxo público e da UI;
- identidade Firebase estável por UID;
- `user-default` e `ws-default` não são provisionados;
- escrita cloud normal usa tabelas normalizadas + Storage;
- snapshot legado permanece apenas como leitor de bootstrap/migração.

### C — Projetos, ZIP e preview
- criação/importação aguarda sucesso real do backend;
- ZIP é validado no backend, preserva binários e trata wrapper root;
- preview estático preservado;
- runtime de framework inicia dev server real com env filtrado;
- instalação de dependências usa `--ignore-scripts` por padrão;
- proxy HTTP preserva método/body/query/status e headers seguros;
- cleanup de processo foi endurecido.

Ainda faltam WebSocket/HMR autenticado e E2E real de React/Vite + segundo framework.

### D — Providers
- tester canônico em `LLMAdapterService`;
- taxonomia de erro para timeout, key/model, rate limit, network e upstream;
- provider ativo por usuário;
- profiles/candidates, telemetria, circuit breaker e budget implementados.

### E — GitHub
- criação/vínculo, pull, push, branches, status, PR e publicação via chat;
- SHA real de branch;
- push propaga deleções e suporta binários;
- campos de `projects` permanecem apenas como compatibilidade transitória.

### F — Validator
- `ValidatorEngine` é o validator canônico;
- `unverified` é usado quando não existe gate executável;
- rollback após gate executado falhar possui teste HTTP real;
- `apply-proposal` agora registra o ValidatorEngine no workflow quando existe run.

### G — Integrações
- GitHub, Cloudflare, Supabase e Firebase possuem configuração no vault e teste real;
- salvar configuração volta para `pending_credentials`;
- falha de teste persiste `error`;
- Cloudflare Git-trigger permanece;
- Cloudflare Direct Upload exige build real, artefato correto e Wrangler controlado pelo Forge.

E2E externo real permanece bloqueado por credenciais/autorização.

### H — Agent Engine
- SCOUT, STUDIO, FORGE, SENTINEL e SHIP existem;
- workflow determinístico básico persiste steps;
- FORGE pode ser executado com `forcedAgentKey`;
- consistency gate garante `agent_steps.agent_key === model_invocations.agent_key` no step FORGE;
- SENTINEL registra evidência real em falha de validação definitiva.

Ainda faltam correção automática localizada com revalidação, escalonamento pago por step e benchmark real de 30 tarefas.

### I — Limpeza
- modais antigos removidos;
- tester duplicado removido;
- bootstrap/demo morto removido;
- Firestore operacional removido;
- remoções destrutivas de snapshot/colunas espelho continuam bloqueadas por reconciliação real.

### Fase 1 — Context Engine V2
- ProjectFileIndex incremental por hash implementado e integrado ao workspace;
- Architecture Graph persistente implementado;
- Context Commit durável implementado e gravado em transitions materiais;
- Context Scopes MICRO/LOCAL/TASK/PROJECT implementados;
- Context Compiler V2 + ContextPack + telemetria implementados;
- APIs de sync/snapshot/compile/commit/telemetry preservadas;
- ContextPack agora alimenta SCOUT, STUDIO, FORGE e SENTINEL como fonte primária do prompt real;
- requirement IDs são recuperados do Requirement Ledger pelo run e combinados com IDs explícitos;
- continue, repair, waiting_approval/resume, apply-proposal, validation e checkpoint restore preservam continuidade via ContextCommit/Requirement Ledger;
- retries contextuais recompilam novos ContextPacks por scope/budget/relevância, sem hard cap fixo de arquivos;
- token budget considera conteúdo real quando disponível; arquivos oversized entram como full/partial/omitted explicitamente;
- provider recebe o contexto representado pelo ContextPack sem truncamento oculto posterior;
- model_invocations registra metadata contextual por ID de ContextPack;
- ZIP/imports/checkpoints/workspace mutations sincronizam o índice;
- nenhum limite lógico de quantidade de arquivos foi introduzido;
- suíte da Fase 1 cobre integração real, invalidação, requirements, stale context, retry e budget explícito.

## Pendências que bloqueiam “release completa”

Ver `CODEX_HANDOFF.md`: WebSocket/HMR, E2E externo real, Agent Engine com repair bounded, benchmark real e remoção destrutiva pós-reconciliação.
