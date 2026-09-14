# PROGRAM-IA — Implementation status

Atualizado em 2026-09-14 após conclusão técnica da Fase 3 — Browser Agent + Quality Gate.

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
- workflow determinístico persiste steps, ContextPacks e evidence;
- FORGE pode ser executado com `forcedAgentKey`;
- consistency gate garante `agent_steps.agent_key === model_invocations.agent_key`;
- falha executável de ValidatorEngine ou Browser Quality Gate gera SENTINEL evidence;
- repair FORGE é localizado, bounded e revalidado;
- escalonamento BASE_FREE -> EXPERT_PAID ocorre somente no step bloqueado;
- browser repair não cria loop infinito.

Pendência do Agent Engine fora da Fase 3: benchmark real de 30 tarefas com providers reais.

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

### Fase 2 — Tool-First + Sandbox + Resumability — CONCLUÍDA

Implementado e coberto por suíte:
- Tool Registry tipado com reads, writes, delete, patch e process;
- policy de path/sensitive files, symlink e traversal;
- journal durável de `tool_executions` com sandbox provenance, request hash, idempotency e resume policy;
- sandbox por proposta/run com base manifest/hash e stale detection;
- FORGE e fluxo direct-LLM materializam alterações no sandbox sem mutar o workspace oficial antes da aprovação;
- tool loop real do provider usa somente reads e possui budgets/rounds bounded;
- mutation tools escrevem apenas no sandbox;
- `process.run` usa cwd isolado, HOME/TMP/config sintéticos, env allowlisted, redaction, timeout, AbortSignal e cleanup de árvore;
- ValidatorEngine executa quality gates no sandbox e permanece canônico;
- repair automático é localizado, tem no máximo uma tentativa por falha e revalidação;
- approval verifica base revision e integridade do candidato;
- arquivos extras gerados por build/test não entram no merge;
- merge final promove somente paths allowlisted, usa staging/swap e rollback em falhas de finalização;
- falha pós-merge de Requirement Ledger/ContextCommit/run state restaura o workspace anterior;
- Context Engine é sincronizado depois de merge/rollback;
- restart marca side effects incertos como `interrupted` e não os repete silenciosamente;
- continue pode reutilizar sandbox sobrevivente;
- não existe hard cap lógico de arquivos introduzido pela Fase 2;
- migrations locais 005/006 cobrem tool journal e sandboxes;
- Supabase remoto não foi alterado.

Limite explicitamente documentado: o sandbox é uma fronteira lógica de filesystem/processo do PROGRAM-IA, não uma microVM/container de kernel para código deliberadamente hostil.



### Fase 3 — Browser Agent + Quality Gate — CONCLUÍDA

Implementado e coberto por suíte:
- `browser.inspect_page` registrado no Tool Registry e executado somente com sandbox;
- BrowserQualityService usa Playwright/Chromium real;
- preview estático do candidato é servido localmente sem escrever no workspace oficial;
- projetos com `dev`/`start` usam runtime isolado sobre o sandbox;
- inspeção desktop e mobile coleta page errors, console errors, requests/responses ruins e sinais básicos de layout/a11y;
- requests externos do browser são bloqueados durante o gate;
- screenshots são persistidos como evidence com hash/bytes, sem expor path interno no payload normal;
- Migration 007 adiciona `browser_quality_runs` local;
- APIs autenticadas permitem executar, consultar evidence e obter screenshot somente pelo owner;
- o apply-proposal executa Browser Quality Gate após ValidatorEngine;
- falha executável cria SENTINEL real e exatamente um FORGE browser repair;
- após o repair, ValidatorEngine e browser são reexecutados;
- segunda falha bloqueia merge;
- browser indisponível produz `unverified`, não sucesso falso;
- resultado final combina ValidatorEngine + Browser Quality Gate;
- fluxo sem Agent Engine também não consegue promover candidato que falha no browser;
- Phase 2 continua verde sem regressão;
- Supabase remoto não foi alterado.

Limite deliberado: warnings heurísticos de visual/a11y são evidence, não motivo automático para uma IA redesenhar a interface. A autocorreção é reservada a falhas executáveis para evitar alterações subjetivas sem pedido do usuário.


## Pendências que bloqueiam “release completa”

Pendências após a Fase 3: benchmark real de 30 tarefas da Fase 4, WebSocket/HMR + E2E ampliado de frameworks, E2E de integrações externas e remoções destrutivas somente após reconciliação.
