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

## Status após integração final

### 1. Agentes integrados
`ContextEngineV2.compile(...)` agora é a fonte primária de contexto para SCOUT, STUDIO, FORGE e SENTINEL. SHIP permanece sem leitura profunda quando atua apenas como handoff de publicação. Cada chamada de modelo recebe um `ContextPack` serializado com provenance, escopo, arquivos selecionados, requirements, graph slice, commits relevantes e orçamento explícito.

### 2. Lifecycle e continuidade integrados
Steps materiais gravam `ContextCommit` compacto em SCOUT, STUDIO, FORGE, SENTINEL, apply-proposal, validation, repair, revalidation, waiting_approval e rejeição. `continue` e repair recebem requirement IDs/focus paths e compilam novo `ContextPack` a partir do estado persistido, não apenas da conversa recente.

### 3. Entradas e invalidação integradas
`WorkspaceManager` sincroniza o índice após escrita, binários, deleção, import ZIP, duplicação e restore de checkpoint. Fluxos de GitHub/cloud que materializam arquivos pelo workspace herdam essa invalidação. Arquivos com hash unchanged continuam sem reprocessamento.

### 4. Model routing integrado
`model_invocations` registra `context_pack_id`, scope, hash do projeto, tokens estimados, arquivos selecionados e quantidade de arquivos omitidos. A telemetria de provider/model/profile/custo/latência foi preservada.

### 5. Stale context fechado
Antes de compilar contexto para uma ação de agente, o projeto é sincronizado por hash. `ContextPack` antigo permanece evidência histórica imutável e uma nova alteração gera novo pack/fingerprint.

### 6. Compatibilidade cloud
Nenhuma alteração remota foi aplicada. A Fase 1 funciona localmente sobre SQLite/workspace; eventual persistência cloud do Context Engine fica para gate futuro versionado.

## Gate da Fase 1
1. agentes principais usam ContextPack como fonte primária;
2. continue/repair usam ContextPack;
3. import/pull/checkpoint sincronizam corretamente;
4. hash unchanged evita reprocessamento;
5. requirement IDs sobrevivem SCOUT → FORGE → SENTINEL;
6. ContextCommit permite continuidade sem reenviar projeto inteiro;
7. lint, suíte direcionada, npm test, build e Playwright verdes localmente;
8. regressão prova ausência de limite lógico de arquivos.

## Fora da Fase 1
Não iniciar Tool Registry real, Git worktree, sandbox, durable restart recovery ou Browser Agent. Esses itens pertencem às Fases 2 e 3.
