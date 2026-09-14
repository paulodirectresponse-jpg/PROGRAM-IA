# FASE 2 — Tool-First + Sandbox + Resumability — Handoff Codex

Base desta fase:
`c95705d4148913438ad83f862daed1a5a7f36dd9`

## O que já está implementado nesta branch

A fundação (~30%) foi iniciada sem fingir sandbox:

- `server/tooling/types.ts`: contratos de ToolDefinition, risco, disponibilidade, resume policy, request/result/record.
- `server/tooling/toolRegistry.ts`: registry backend determinístico.
- `server/tooling/toolPolicy.ts`: normalização de path, traversal guard e bloqueio de arquivos sensíveis conhecidos.
- `server/tooling/toolExecutionJournal.ts`: journal durável por project/run/step com versão, status, request hash, idempotency key, resume policy e timestamps.
- `server/tooling/toolExecutionService.ts`: executor real apenas para reads seguros.
- Ferramentas prontas:
  - `workspace.list_tree`
  - `workspace.read_file`
  - `workspace.search_text`
- Ferramentas declaradas, mas BLOQUEADAS até sandbox real:
  - `workspace.write_file`
  - `workspace.apply_patch`
  - `process.run`
- Migration 005 local para enriquecer `tool_executions`.
- APIs autenticadas:
  - `GET /projects/:projectId/tools`
  - `POST /projects/:projectId/tools/execute`
  - `GET /projects/:projectId/tool-executions/:runId`
- Testes `tests/phase2.test.ts`.

Não aplique migration remota de Supabase nesta fase sem autorização.

## Regra arquitetural

Tool-first NÃO significa permitir que o modelo escreva diretamente no workspace oficial.

Fluxo alvo:

Agent step
→ Tool Registry
→ isolated worktree/sandbox
→ tool execution journal
→ ValidatorEngine / preview
→ user approval
→ base-revision check
→ atomic merge
→ official workspace/checkpoint

Reads podem vir do workspace oficial. Writes/processos devem acontecer apenas no ambiente isolado.

## Parte do Codex (~70%)

### 1. Worktree real por execução
Implementar lifecycle real de Git worktree ou equivalente isolado por run/proposal:
- criar a partir da revisão-base;
- metadata persistente do worktree/sandbox;
- cleanup seguro;
- zero escrita direta no workspace oficial durante proposal/build;
- stale/base revision detection.

### 2. Sandbox isolado
Implementar executor real para:
- `workspace.write_file`
- `workspace.apply_patch`
- `process.run`

Requisitos:
- cwd sempre no sandbox/worktree;
- env allowlisted;
- sem secrets do Forge;
- sem symlink escape;
- timeout/AbortSignal;
- output limitado e redacted;
- lifecycle scripts bloqueados por default;
- process tree cleanup.

### 3. Tool loop dos agentes
Integrar tools ao fluxo real do provider/Agent Engine:
- SCOUT usa preferencialmente read tools quando precisar inspecionar;
- FORGE altera exclusivamente via mutation tools no sandbox;
- SENTINEL usa read/process tools para evidência localizada;
- tool calls bounded por attempts/budget/abort;
- nenhuma chamada de ferramenta fora do registry;
- sem supervisor LLM.

O Context Engine V2 continua fonte primária de seleção inicial; tools refinam/atuam sobre essa visão.

### 4. Resumability após restart
Implementar recovery durável:
- persistir sandbox/worktree identity;
- reconciliar `tool_executions` em `queued/running/interrupted`;
- `replay_safe` pode ser reexecutado;
- mutation/process só pode retomar com idempotency + sandbox consistente;
- nunca repetir side effect incerto silenciosamente;
- retomada reconstrói estado a partir de DB + ContextCommit + Requirement Ledger + tool journal.

### 5. Atomic merge
Após aprovação:
- validar base revision;
- rodar ValidatorEngine aplicável no sandbox;
- se base mudou, não aplicar;
- se gates falham, não aplicar;
- se aprovado, merge/aplicação atômica no workspace oficial;
- criar checkpoint;
- sync Context Engine;
- registrar changed files/requirements/tool provenance.

### 6. ExecutionWorker / Runtime
Não criar um segundo validator.
`ValidatorEngine` continua canônico.

`ExecutionWorker` pode ser adaptado para usar process supervisor/sandbox, mas ValidatorEngine continua decidindo gates.

### 7. Telemetria
Cada tool execution precisa guardar:
- runId / stepId / projectId;
- tool key/version;
- status;
- duration;
- attempt index;
- request hash;
- idempotency key quando aplicável;
- resume policy;
- error code;
- summary sem secrets.

Não persistir chain-of-thought nem raw secrets.

## Gates da Fase 2

Só marcar concluída quando:

- [ ] FORGE não escreve diretamente no workspace oficial durante proposal/build.
- [ ] mutation tools executam em worktree/sandbox real.
- [ ] process.run executa supervisionado e sem secrets.
- [ ] tool loop real funciona com provider.
- [ ] read/write/process tools têm provenance em `tool_executions`.
- [ ] restart recovery é testado.
- [ ] side effect incerto não é repetido silenciosamente.
- [ ] approval valida base revision.
- [ ] merge/aplicação final é atômico.
- [ ] Context Engine é sincronizado após merge.
- [ ] ValidatorEngine continua canônico.
- [ ] AbortSignal encerra provider + tools + process tree relacionado.
- [ ] nenhum loop infinito.
- [ ] nenhum hard cap lógico de arquivos.
- [ ] lint, suíte direcionada, npm test, build e Playwright verdes.
- [ ] Supabase remoto não foi alterado sem autorização.

## Fora da Fase 2

Não iniciar Browser Agent / browser repair loop da Fase 3.
Não iniciar benchmark pesado de 30 tarefas da Fase 4.
