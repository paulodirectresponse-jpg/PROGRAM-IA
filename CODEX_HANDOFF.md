# PROGRAM-IA — Handoff para Codex

Atualizado em 2026-09-14 após conclusão técnica da Fase 3.

Este arquivo contém somente pendências reais. Não trate itens já implementados como abertos, e não declare gates externos sem credencial/teste real.

## Regras

- Não reimplementar blocos já consolidados.
- Não substituir execução real por mock quando o gate exigir runtime/integração real.
- Não habilitar loops infinitos. Correções automáticas precisam ter limite de tentativa, budget e AbortSignal.
- Não permitir que uma decisão explícita da state machine seja sobrescrita por seleção automática de agente.
- Não expor secrets ao browser, preview, worker ou processo de deploy.
- Não alterar Supabase remoto sem migration versionada, reconciliação e autorização explícita.
- Manter Firebase como identidade do Forge; Firebase de projetos continua sendo integração externa separada.

## Fase 1 — Context Engine V2

A Fase 1 está integrada localmente. `ContextEngineV2` alimenta SCOUT, STUDIO, FORGE e SENTINEL; `ContextPack` entra no prompt real do provider; requirements sobrevivem ao workflow; ContextCommit registra transitions materiais; workspace/import/checkpoint invalidam índice por hash; model_invocations guarda metadata contextual.

**Não reimplementar** `ProjectFileIndex`, `ArchitectureGraphService`, `ContextCommitService`, `ContextCompiler`, schemas ou APIs do Context Engine V2. Próximos trabalhos devem partir desse contrato já validado.

## Fase 2 — Tool-First + Sandbox + Resumability

A Fase 2 está implementada. Não reimplementar Tool Registry, ToolPolicy, ToolExecutionJournal, SandboxManager, process supervisor, proposal sandbox, bounded tool loop, restart recovery ou atomic merge.

Antes de alterar esse fluxo, leia `PHASE2_CODEX_HANDOFF.md`, que agora documenta o contrato final e seus gates.

Limite de segurança conhecido: o sandbox atual é lógico (filesystem/processo/env) e não deve ser promovido como microVM/container de kernel para execução adversarial. Se o threat model mudar para código deliberadamente hostil, adicionar isolamento infra sem enfraquecer os gates atuais.



## Fase 3 — Browser Agent + Quality Gate

A Fase 3 está implementada. Não reimplementar `BrowserQualityService`, `browser.inspect_page`, Migration 007, evidence/screenshot routes ou o browser repair loop.

Leia `PHASE3_IMPLEMENTATION.md` antes de alterar qualquer gate de browser/runtime.

Contrato existente:
- browser real roda sobre o candidato no sandbox;
- desktop/mobile evidence é persistida;
- ValidatorEngine continua canônico para código/processo;
- Browser Quality Gate adiciona runtime/DOM evidence;
- falha executável cria SENTINEL e um único FORGE repair;
- repair é revalidado por ValidatorEngine e browser;
- segunda falha bloqueia o merge;
- `unverified` nunca pode ser promovido a `passed` artificialmente;
- screenshots permanecem owner-scoped;
- não transformar warnings subjetivos em redesign automático.




## Fase 4 — Benchmark real + qualidade

A Fase 4 está **em implementação** na branch `codex/phase4-benchmark-quality`.

Leia `PHASE4_IMPLEMENTATION.md`.

Não reimplementar:
- catálogo `phase4-v1-30`;
- BenchmarkService;
- benchmark persistence;
- scoring;
- preflight;
- release gate v1;
- recovery/cancel/resume.

Pendência material: executar e auditar providers reais. Nenhum mock pode ser usado para declarar o gate final aprovado.


## C — Runtime de frameworks e preview executável

### Implementado localmente
1. Runtime/process manager para projetos com `package.json`.
2. Detecção de package manager e framework.
3. Instalação com env filtrado, timeout, saída limitada, AbortSignal e `--ignore-scripts` por padrão.
4. Start/stop/restart de dev server com cleanup de árvore de processos em Windows e POSIX.
5. Retry limitado para colisão de porta.
6. Proxy HTTP com método, body, query, status e headers seguros.
7. Preview estático preservado para projetos sem `package.json`.
8. Testes cobrindo start, proxy, segredo não vazado, erro, stop e lifecycle scripts bloqueados.

### Ainda falta para gate completo
1. WebSocket/HMR autenticado e validado por owner do projeto.
2. E2E com React/Vite real e um segundo framework real, incluindo editar arquivo e confirmar reload.
3. Prova operacional de zero processo órfão fora do ambiente de teste unitário.

## G — Integrações externas

### Implementado localmente
1. Cloudflare Direct Upload agora exige build real antes do deploy.
2. `public/` não é mais aceito automaticamente como artefato de build.
3. Output esperado é derivado de framework/configuração explícita.
4. Wrangler é resolvido a partir do Forge (`node_modules/.bin`) e não do projeto importado.
5. Processo de deploy tem timeout, AbortSignal, output limitado e redaction de token/account.
6. Estados continuam `pending` → `active` somente em sucesso real ou `failed` em erro.
7. Testes cobrem falta de credencial/artefato, build falhando e `public/` inválido.

### Ainda falta para gate completo
1. E2E real de GitHub com repo de teste.
2. E2E real de Cloudflare Pages Git-trigger.
3. E2E real de Cloudflare Direct Upload com credencial autorizada.
4. E2E real de Supabase/Firebase como integrações de projeto.

## H — Agent Engine

### Implementado
1. State machine determinística: SCOUT, STUDIO quando visual, FORGE, SENTINEL e SHIP.
2. Context Engine V2 é fonte primária e requirements sobrevivem ao workflow.
3. Tool loop read-only bounded integra provider e Tool Registry.
4. FORGE materializa proposta no sandbox; nenhuma alteração gerada é aplicada no workspace oficial antes da aprovação.
5. ValidatorEngine valida o sandbox antes de merge.
6. Falha executada produz SENTINEL evidence e um único FORGE repair localizado com revalidação.
7. BASE_FREE → EXPERT_PAID ocorre apenas no step bloqueado; steps seguintes voltam a BASE_FREE.
8. AbortSignal cobre provider/tool/process supervision testada.
9. Restart/interrupted side effects são recuperados sem replay silencioso.
10. Merge aprovado é base-aware, allowlisted e rollback-safe.

### Ainda falta fora da Fase 3
1. WebSocket/HMR autenticado no preview de produto.
2. E2E ampliado com frameworks reais e reload/HMR.
3. Benchmark real de 30 tarefas com providers reais da Fase 4.


## B / I — remoção física do snapshot legado

O fluxo operacional usa persistência canônica normalizada. `forge_sync_snapshots` permanece apenas como leitor de bootstrap/migração.

### Falta
1. Validar em ambiente real que todas as contas existentes foram reconciliadas com tabelas canônicas e Storage.
2. Comparar contagens, ownership, hashes e decryptability de secrets.
3. Depois da janela de rollback aprovada, remover leitura de snapshot legado e tabela antiga por migration destrutiva versionada.
4. Remover colunas espelho antigas somente após reconciliação real.

## Validação

A branch da Fase 3 só pode ser integrada à `main` com lint, suíte direcionada incluindo `phase3.test.ts`, regressão das Fases 0–2, `npm test`, build e Playwright em verde no HEAD final.
