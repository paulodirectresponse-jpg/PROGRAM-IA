# PROGRAM-IA — Inventário final de legado

Atualizado em 2026-09-13. Este documento descreve o estado atual, não o histórico original.

| Item | Estado | Regra atual |
| --- | --- | --- |
| Firebase ID Token + sessão Forge | KEEP | Firebase é a identidade do produto; backend valida o token e cria sessão HttpOnly. |
| Firestore interno do Forge | REMOVED | Não é backend do produto. Firebase de projetos é integração externa separada. |
| Login/registro/senha local | REMOVED | Rotas antigas retornam 410; UI usa Firebase. |
| `password_hash` | REMOVED FROM CURRENT SCHEMA | Não é necessário para contas novas. |
| `user-default` / `ws-default` | REMOVED OPERATIONALLY | Só aparecem em testes/documentação como prova de ausência. |
| `CredentialsModal` / `ProvidersModal` / `IntegrationsModal` | REMOVED | `SettingsProfileModal`, `IntegrationSettings` e `AgentsModal` são as interfaces atuais. |
| `SecretService.testConnection` | REMOVED | Providers usam `LLMAdapterService.testConnection`; integrações usam `IntegrationService.test`. |
| `WorkspaceManager.runQualityGates` | REMOVED | `ValidatorEngine` é canônico. |
| ZIP no browser | REMOVED | Upload vai ao importador backend; JSZip em outras funções não é importador paralelo. |
| Firestore rules/blueprint interno | REMOVED | Não fazem parte do runtime atual. |
| `forge_sync_snapshots` | MIGRATION-ONLY | Não recebe writes operacionais. Pode ser lido somente no bootstrap legado até reconciliação final. |
| SQLite local | KEEP AS OPERATIONAL CACHE | Ainda sustenta o runtime local; cloud canônico é Supabase normalizado. |
| `projects.repo_url` / `projects.branch` | COMPATIBILITY MIRROR | GitHub lê `repositories` + `branches`; remover colunas só após migration/reconciliação. |
| `projects.provider_id` / `projects.model_id` | COMPATIBILITY MIRROR | Provider/model routing canônico é por conta/perfis; remover colunas só após migration segura. |
| UseOneAI | SUPPORTED OPTIONAL PROVIDER | Não é provider ativo implícito para usuário autenticado. Continua disponível se o usuário configurar. |
| Host provider env vars | INTERNAL/LEGACY COMPATIBILITY | Usuário autenticado usa secrets da conta. Env pode existir apenas para fluxos sem identidade/diagnóstico interno. |
| Agent Engine | FEATURE FLAG | Infraestrutura existe; state machine completa ainda não está liberada como concluída. |

## Regra para remoções destrutivas

Não remover snapshot antigo ou colunas espelho apenas para “limpar o schema”. Primeiro executar reconciliação real, provar restauração em runtime limpo e só então aplicar migration versionada. Os gates estão em `CODEX_HANDOFF.md`.
