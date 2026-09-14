# PROGRAM-IA — Plano técnico atual

Atualizado em 2026-09-13.

## 1. Princípios

1. Uma única experiência PROGRAM-IA para o usuário.
2. Modelos são recursos substituíveis, não donos de estado.
3. Firebase identifica; Supabase persiste; workspace local executa.
4. GitHub, Cloudflare, Supabase e Firebase de projetos são adapters/ferramentas.
5. Nenhuma operação deve fingir sucesso.
6. Gates determinísticos vêm antes de revisão por IA.
7. Autocorreção nunca é infinita: toda repetição precisa de limite, budget e abort.
8. Projetos importados não executam lifecycle scripts de dependência de forma silenciosa.

## 2. Camadas

### Frontend
React 19 + TypeScript com projetos, conversa, workspace/preview, checkpoints, providers, integrações e agentes/perfis.

### Backend
Express + TypeScript com auth/session, workspace, provider adapters, model routing, validator/worker, runtime manager, GitHub, integrações, cloud persistence e Agent Engine.

### Persistência
- SQLite local = estado operacional/cache;
- Supabase Postgres/Storage = cloud canônico;
- snapshot antigo = somente bootstrap de migração até gate de remoção.

## 3. Runtime e preview

`RuntimeManager` é responsável por:
- detectar package manager/framework;
- instalar com `--ignore-scripts` por padrão;
- iniciar dev server com env allowlisted;
- retry limitado de porta;
- proxy HTTP seguro;
- cleanup de árvore de processos;
- build controlado para operações que precisam de artefato.

Ainda falta WebSocket/HMR autenticado e E2E real por framework.

## 4. Providers e roteamento

`LLMAdapterService` suporta OpenAI-compatible e Gemini. Usuário autenticado usa credenciais próprias.

`ModelRouter` mantém BASE_FREE, EXPERT_PAID, PREMIUM_OVERRIDE, candidates, health/circuit breaker, max attempts, budget e telemetria.

## 5. Agent Engine

O Context Engine V2 é a fonte primária de contexto para chamadas de agente. Cada step material compila um ContextPack por escopo, requirements recuperados do Ledger e arquivos de foco; o provider recebe os arquivos full/partial descritos pelo pack sem truncamento oculto posterior, e a invocation registra referência/context telemetry.

Papéis:
- SCOUT — contexto/plano;
- STUDIO — direção visual quando aplicável;
- FORGE — proposta de código;
- SENTINEL — interpretação de falha concreta;
- SHIP — publicação solicitada.

Estado atual: state machine determinística implementada com `forcedAgentKey`, vínculo ao ValidatorEngine, repair bounded/escalonamento local e Context Engine V2 integrado ao prompt real. Próximo gate fora da Fase 1: WebSocket/HMR, E2E framework real e benchmark real.

## 6. Validação

`ValidatorEngine` é a única fonte de quality gates. Falha de gate após aplicação restaura o workspace ao checkpoint anterior. Gates skipped geram `unverified`, não falha.

## 7. GitHub

Fonte canônica: `repositories` + `branches`. Campos antigos em `projects` são espelhos de migração e só devem ser removidos após reconciliação.

## 8. Integrações

Estados: `pending_credentials`, `connected`, `error`.

Cloudflare Pages:
- Git-trigger existente;
- Direct Upload em código exige build real, output compatível e Wrangler controlado pelo Forge.

## 9. Gates de conclusão

A versão completa exige CI verde, runtime framework E2E, HMR, integrações reais, Agent Engine com correção localizada e benchmark de 30 tarefas, reconciliação cloud e remoção destrutiva pós-gate.
