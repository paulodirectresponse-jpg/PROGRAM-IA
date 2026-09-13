# PROGRAM-IA — Handoff para Codex

Atualizado em 2026-09-13 após endurecimento local de C/H/G sobre `19aa28f`.

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

O core isolado da Fase 1 já está implementado e validado. O handoff operacional exclusivo está em `PHASE1_CODEX_HANDOFF.md`.

**Não reimplementar** `ProjectFileIndex`, `ArchitectureGraphService`, `ContextCommitService`, `ContextCompiler`, schemas ou APIs do Context Engine V2. A responsabilidade restante é a integração profunda desses contratos nos fluxos existentes.

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

### Implementado localmente
1. State machine determinística básica: SCOUT, STUDIO quando visual, FORGE, SENTINEL e SHIP quando publicação é solicitada.
2. SCOUT/STUDIO registram pacotes de contexto sem chain-of-thought.
3. FORGE executa com `forcedAgentKey`, impedindo divergência entre `agent_steps.agent_key` e `model_invocations.agent_key`.
4. ValidatorEngine é registrado no fluxo definitivo de `apply-proposal`.
5. Falha de validation cria evidência SENTINEL e rollback seguro já existente.
6. Testes cobrem backend sem STUDIO, visual com STUDIO, publish com SHIP e consistência de agent key.

### Ainda falta para gate completo
1. WebSocket/runtime error evidence acoplado ao SENTINEL.
2. Correção automática localizada após falha executada, com uma tentativa bounded e revalidação success/fail.
3. Escalonamento BASE_FREE → EXPERT_PAID somente no step bloqueado, com retorno ao BASE_FREE no step seguinte.
4. Abort cobrindo provider, worker, runtime relacionado e promises pendentes em teste integrado.
5. Benchmark real de 30 tarefas com providers reais.

## B / I — remoção física do snapshot legado

O fluxo operacional usa persistência canônica normalizada. `forge_sync_snapshots` permanece apenas como leitor de bootstrap/migração.

### Falta
1. Validar em ambiente real que todas as contas existentes foram reconciliadas com tabelas canônicas e Storage.
2. Comparar contagens, ownership, hashes e decryptability de secrets.
3. Depois da janela de rollback aprovada, remover leitura de snapshot legado e tabela antiga por migration destrutiva versionada.
4. Remover colunas espelho antigas somente após reconciliação real.

## Validação local desta rodada

- Suíte direcionada `foundation/http/directPersistence/regression/agentEngine`: 67/67 PASS.
- Os demais gates devem ser registrados no relatório final da rodada.
