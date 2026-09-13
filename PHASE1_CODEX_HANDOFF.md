# PROGRAM-IA — Fase 1 / Context Engine V2 — Handoff exclusivo para Codex

Base da Fase 0 aprovada: `f349d3755df14e11ac0dfa3b19585d7dca25d7d8`.

Este documento começa onde a implementação desta rodada termina. Não reimplemente o core do Context Engine V2.

## Já implementado nesta rodada

- `ProjectFileIndex` persistente, incremental e dirigido por hash.
- path, hash, bytes, linguagem, resumo, symbols, imports, exports e module key.
- invalidação incremental changed / unchanged / removed.
- fingerprint estrutural sem limite lógico de quantidade de arquivos.
- `ArchitectureGraphService` com modules, services, routes, models, components, integrations e dependencies.
- resolução determinística de imports locais e packages.
- snapshots versionados por hash do grafo.
- `ContextCommitService` persistindo task, decisões, changed files, requirements, validation, blockers e next state.
- escopos `MICRO | LOCAL | TASK | PROJECT`.
- `ContextCompiler` produzindo `ContextPack` determinístico por task/agente/requirements/foco.
- seleção por relevância e dependências.
- orçamento explícito de contexto; nenhum truncamento silencioso por número de arquivos.
- arquivos omitidos registrados como `budget_exhausted`.
- telemetria persistente por ContextPack.
- APIs autenticadas para sync, snapshot, compile, commits e telemetry.
- limpeza das tabelas de contexto ao excluir projeto.
- suíte `tests/phase1.test.ts`.

## CODEX STARTS / TAKES OWNERSHIP HERE

### 1. Substituir contexto legado nos agentes
Integrar `ContextEngineV2.compile(...)` em SCOUT, STUDIO, FORGE, SENTINEL e SHIP quando houver leitura de estado. Cada step deve receber o menor ContextPack suficiente. Não carregar o projeto inteiro por padrão.

### 2. Integrar lifecycle e continuidade
Usar Context Engine em execução inicial, `continue`, repair bounded, waiting_approval/resume, checkpoints e após apply-proposal/validation. Ao concluir step material, gravar ContextCommit com decisões e next state. Não persistir chain-of-thought.

### 3. Integrar entradas e invalidação
Após projeto novo, ZIP import, GitHub import/pull, restore checkpoint e sync cloud que altere workspace, executar sync incremental. Arquivo com hash unchanged não deve ser reprocessado.

### 4. Integrar model routing
O prompt real do provider deve ser derivado do ContextPack, preservando provenance, requirement IDs, arquivos selecionados, decisões relevantes, graph slice e budget explícito. Não deixar o ContextPack apenas em telemetria paralela ao prompt antigo.

### 5. Fechar stale detection
Mudanças de workspace fora do fluxo normal precisam invalidar/sincronizar o índice antes do próximo compile.

### 6. Compatibilidade cloud
Não aplicar migration remota automaticamente. Se persistência cloud for necessária, criar migration versionada e pedir autorização antes de alterar Supabase remoto.

## Gate da Fase 1
1. agentes principais deixam de usar o seletor legado como fonte primária;
2. continue/repair usam ContextPack;
3. import/pull/checkpoint sincronizam corretamente;
4. hash unchanged evita reprocessamento;
5. requirement IDs sobrevivem SCOUT → FORGE → SENTINEL;
6. ContextCommit permite continuidade sem reenviar projeto inteiro;
7. lint, suíte direcionada, npm test, build e Playwright verdes;
8. regressão prova ausência de limite lógico de arquivos.

## Fora da Fase 1
Não iniciar Tool Registry real, Git worktree, sandbox, durable restart recovery ou Browser Agent. Esses itens pertencem às Fases 2 e 3.
