# PROGRAM-IA

Workspace full-stack para criar, importar, editar, validar e publicar projetos de software com IA, mantendo identidade, persistência, providers, GitHub, quality gates e roteamento de modelos sob controle do backend.

## Estado atual

A base atual já possui:

- Firebase Auth obrigatório para identidade do PROGRAM-IA;
- persistência cloud normalizada em Supabase Postgres/Storage;
- workspace/SQLite local como camada operacional;
- criação do zero, importação GitHub e ZIP backend com binários;
- conversa nos modos `auto`, `plan`, `build`, `review` e `publish`;
- providers OpenAI-compatible e Gemini configurados por conta;
- profiles de modelos, candidates, budget, circuit breaker e telemetria;
- cinco papéis do Agent Engine: SCOUT, STUDIO, FORGE, SENTINEL e SHIP;
- propostas/checkpoints, `ValidatorEngine`, `ExecutionWorker` e rollback;
- GitHub real: vínculo, pull, push, branch, status, PR e publicação;
- integrações GitHub, Cloudflare, Supabase e Firebase;
- Cloudflare Pages por Git-trigger.

O que ainda não deve ser chamado de concluído está documentado em `CODEX_HANDOFF.md`: runtime geral de frameworks, E2E externo, state machine multiagente completa e remoções destrutivas pós-reconciliação.

## Arquitetura

```text
React 19 + TypeScript
        |
Express API
        |
        +-- Firebase Identity / Forge Session
        +-- WorkspaceManager
        +-- ValidatorEngine -> ExecutionWorker
        +-- LLMAdapterService -> ModelRouter
        +-- AgentEngine (feature flag)
        +-- GitHubService
        +-- IntegrationService
        +-- CloudSyncService
                |
                +-- Supabase Postgres/Storage (canônico)
                +-- snapshot legado (somente bootstrap de migração)
```

### Fontes canônicas

- identidade: Firebase UID;
- dados cloud: Supabase normalizado;
- arquivos: Supabase Storage + workspace local;
- GitHub: `repositories` + `branches`;
- provider selecionado: provider ativo da conta ou candidate do perfil;
- validação: `ValidatorEngine`.

## Estrutura principal

```text
server/
  agent-engine/
    agentEngine.ts
    agentRegistry.ts
  db/
  repositories/
  services/
    authService.ts
    cloudSyncService.ts
    executionWorker.ts
    githubService.ts
    integrationService.ts
    llmAdapter.ts
    modelRouter.ts
    runService.ts
    supabasePersistenceService.ts
    validatorEngine.ts
    workspaceManager.ts
  routes.ts

src/
  components/
    AgentsModal.tsx
    AuthModal.tsx
    CheckpointsModal.tsx
    ConversationPanel.tsx
    IntegrationSettings.tsx
    NewProjectModal.tsx
    SettingsProfileModal.tsx
    Sidebar.tsx
    SkillsModal.tsx
    WorkspaceArea.tsx
```

## Providers

Providers são configurados por usuário na aplicação. UseOneAI continua suportado como provider OpenAI-compatible opcional, mas não é fallback implícito para usuário autenticado.

O Agent Engine usa perfis:

- `BASE_FREE`;
- `EXPERT_PAID`;
- `PREMIUM_OVERRIDE` — desabilitado por padrão.

Um perfil sem candidate configurado não pode escapar silenciosamente para o provider ativo da conta.

## Agent Engine

Ative no runtime somente para validação controlada:

```bash
AGENT_ENGINE_ENABLED=true
```

Quando desligado, o fluxo simples continua funcionando. A interface de Agentes informa explicitamente o estado do feature flag.

A state machine completa e o benchmark do MVP ainda estão em `CODEX_HANDOFF.md`.

## Ambiente

Copie `.env.example` e configure somente secrets do backend. Chaves de providers de usuários devem ser salvas pela UI e ficam no vault da conta.

Variáveis críticas de persistência:

```bash
SUPABASE_URL=
SUPABASE_SECRET_KEY=
SECRETS_MASTER_KEY=
FORGE_REQUIRE_CLOUD_SYNC=true
```

## Desenvolvimento

```bash
npm install
npm run dev
```

## Validação

```bash
npm run lint
npm test
npm run build
```

O workflow de CI executa a validação oficial da `main`.

## Documentos

- `IMPLEMENTATION_STATUS.md` — estado atual;
- `LEGACY_INVENTORY.md` — resíduos e compatibilidade;
- `TECHNICAL_PLAN.md` — arquitetura e gates;
- `CODEX_HANDOFF.md` — trabalho restante que exige runtime/credenciais/validação mais pesada.
