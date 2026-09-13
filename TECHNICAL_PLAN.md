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

## 2. Camadas

### Frontend
React 19 + TypeScript com:
- projetos;
- conversa;
- workspace/preview;
- checkpoints;
- providers;
- integrações;
- agentes/perfis.

### Backend
Express + TypeScript com:
- auth/session;
- workspace;
- provider adapters;
- model routing;
- validator/worker;
- GitHub;
- integrações;
- cloud persistence;
- Agent Engine.

### Persistência
- SQLite local = estado operacional/cache;
- Supabase Postgres/Storage = cloud canônico;
- snapshot antigo = somente bootstrap de migração até gate de remoção.

## 3. Identidade e segurança

- ID token Firebase é validado no backend.
- UID Firebase é a identidade estável.
- sessão Forge é HttpOnly.
- secrets permanecem no backend e são criptografados.
- processos do projeto usam environment filtrado.
- preview não recebe secrets do Forge.

## 4. Providers e roteamento

### Provider layer
`LLMAdapterService` suporta:
- OpenAI-compatible;
- Gemini.

Usuário autenticado usa credenciais próprias. Não existe fallback implícito para credencial do host.

### Model layer
`ModelRouter` mantém:
- `BASE_FREE`;
- `EXPERT_PAID`;
- `PREMIUM_OVERRIDE`;
- candidates ordenados;
- health/circuit breaker;
- max attempts;
- budget;
- telemetria.

O Agent Engine não pode executar um provider fora do perfil apenas porque ele é o provider ativo da conta.

## 5. Agent Engine

Papéis:
- SCOUT — contexto/plano;
- STUDIO — direção visual;
- FORGE — proposta de código;
- SENTINEL — interpretação de falhas/revisão;
- SHIP — publicação.

Infraestrutura existente:
- registry;
- engine;
- runs/steps;
- model invocations;
- UI;
- feature flag.

Próxima etapa, reservada ao Codex: state machine determinística multi-step com correção localizada, escalonamento por step, abort e benchmark. Especificação executável em `CODEX_HANDOFF.md`.

## 6. Validação

`ValidatorEngine` é a única fonte de quality gates.

`ExecutionWorker` executa somente ferramentas allowlisted e declaradas no projeto, com:
- env filtrado;
- timeout;
- output limitado;
- AbortSignal.

Falha de gate após aplicação deve restaurar o workspace ao checkpoint anterior.

## 7. GitHub

Fonte canônica:
- `repositories`;
- `branches`.

Funcionalidades:
- criar/vincular repo;
- import/pull;
- push com binários e deleções;
- status;
- branch;
- PR;
- publicação via chat.

Campos antigos em `projects` são apenas espelhos de migração.

## 8. Integrações

`IntegrationService` separa “salvo” de “conectado”.

Estados:
- `pending_credentials`;
- `connected`;
- `error`.

Cloudflare Pages atual = deploy Git-trigger. Direct Upload só deve ser implementado quando a Fase C entregar build/runtime confiável.

## 9. Gates de conclusão

A versão completa exige:
1. CI verde;
2. runtime de framework real;
3. browser smoke test real;
4. GitHub E2E;
5. Cloudflare E2E;
6. Supabase/Firebase integration E2E;
7. Agent Engine multi-step com falha + correção + sucesso;
8. benchmark de 30 tarefas;
9. reconciliação cloud;
10. remoção pós-gate do snapshot e colunas espelho.

Detalhes: `CODEX_HANDOFF.md`.
