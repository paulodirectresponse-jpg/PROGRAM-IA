# Inventário de Legado — Fase 2

Classificação baseada nas referências atuais do código. Esta fase não remove dados nem executa refatoração destrutiva.

| Item verificado | Referências atuais | Decisão | Destino seguro |
| --- | --- | --- | --- |
| Firebase ID Token, sessão HttpOnly e autorização | `server/services/firebaseIdentity.ts`, `server/services/authService.ts`, `server/routes.ts` | KEEP | Preservar como identidade e sessão do Forge. |
| SQLite operacional e cloud snapshot | `server/db/index.ts`, `server/db/schema.sql`, `server/services/cloudSyncService.ts` | MIGRATE | Copiar dados para tabelas Supabase normalizadas e arquivos para Storage; manter leitura compatível até reconciliação. |
| `CredentialsModal` | `src/components/CredentialsModal.tsx`; não importado pelo fluxo principal | REMOVE | Confirmar ausência de import dinâmico e remover depois que `SettingsProfileModal` cobrir os fluxos testados. |
| `ProvidersModal` | `src/components/ProvidersModal.tsx`; não importado pelo fluxo principal | REMOVE | Remover após consolidar providers e modelos na configuração atual. |
| `IntegrationsModal` | `src/components/IntegrationsModal.tsx`; não importado pelo fluxo principal | REMOVE | Manter `IntegrationSettings`/configuração atual como interface canônica e então remover. |
| Login, registro e troca de senha locais | `AuthService.register`, `AuthService.login`, `AuthService.changePassword`; testes ainda os chamam | MIGRATE | Substituir fixtures por identidades Firebase e remover os métodos após migração de usuários. |
| `password_hash` | `server/services/authService.ts`, `server/db/index.ts`, `tests/forge.test.ts` | REMOVE | Validar mapeamento por Firebase UID; depois eliminar coluna e hashes artificiais. |
| `user-default` | seeds/defaults em `server/db/index.ts`; referências em testes | REMOVE | Associar registros legados ao Firebase UID estável antes de remover seeds e defaults. |
| `ws-default` | criação/duplicação em `server/routes.ts`; seeds e testes | MIGRATE | Criar workspace canônico por usuário/projeto, atualizar FKs e só então remover o default. |
| Firestore interno | `src/lib/firebase.ts`, import e deleção em `src/App.tsx`, arquivos `firestore.rules`/blueprint | REMOVE | Preservar Firebase Auth; remover probe e deleção de projeto em Firestore depois de confirmar persistência Supabase. |
| Rotas `/api/secrets` | `server/routes.ts`, `SettingsProfileModal.tsx` e modais legados | MIGRATE | Manter temporariamente como fachada autenticada; mover persistência para vault/backend canônico e retirar consumidores mortos. |
| `WorkspaceManager.runQualityGates` | chamada e implementação em `server/services/workspaceManager.ts` | REMOVE | Manter somente `ValidatorEngine`; migrar os pontos de chamada e comparar resultados antes da remoção. |
| Dois testers de conexão | `SecretService.testConnection` e `LLMAdapterService.testConnection`; ambos chamados em `server/routes.ts` | MIGRATE | Uma operação canônica deve validar provider/modelo e persistir status real; o serviço de secrets só fornece credencial. |
| Dois importadores ZIP | `NewProjectModal.tsx` usa JSZip no navegador; `WorkspaceManager.importZip` valida no backend | REMOVE | Encaminhar upload ao importador do backend, preservar caminhos/binários/limites e remover extração no navegador. |
| Provider/modelo no projeto | `projects.provider_id`, `projects.model_id` no schema, tipos e rotas; defaults hardcoded | MIGRATE | Definir a configuração canônica por conta/projeto e migrar valores antes de retirar duplicações/hardcodes. |
| `repo_url` versus `repositories` | `projects.repo_url` é usado por rotas GitHub; tabela `repositories` existe no schema | MIGRATE | Eleger `repositories` como entidade canônica, preencher com `repo_url` e manter compatibilidade de leitura durante a transição. |
| `projects.branch` versus `branches` | ambas aparecem no schema e rotas GitHub | MIGRATE | Eleger `branches` e garantir uma única branch atual por projeto; migrar `projects.branch` antes de removê-la. |
| Fallback de credenciais por ambiente | `githubService.ts`, `llmAdapter.ts`, `secretService.ts`, seeds em `db/index.ts` | REMOVE | Para usuário autenticado, usar somente vault da conta. Variáveis do host ficam restritas a tarefas internas explicitamente separadas. |
| Seeds globais de usuário, workspace, providers e integrações | `server/db/index.ts` | MIGRATE | Converter somente o que pertencer a usuários reais; remover seeds globais após testes de banco novo e banco migrado. |
| Documentação antiga | `README.md`, `TECHNICAL_PLAN.md`, `IMPLEMENTATION_STATUS.md`, `.env.example` | MIGRATE | Alinhar progressivamente a este documento e marcar claramente estado atual versus arquitetura-alvo. |

## Ordem segura de migração

1. Congelar mudanças de schema concorrentes e criar backup verificável do SQLite, snapshots e diretórios de projeto.
2. Definir schema Supabase versionado, RLS por proprietário, buckets e políticas de Storage; nunca expor `service_role` no cliente.
3. Criar mapeamento idempotente entre Firebase UID, usuário, workspace, projeto e objetos de Storage.
4. Executar migração somente aditiva: usuários, projetos, relações, providers, integrações, secrets e depois arquivos com hash.
5. Comparar contagens, proprietários, hashes e capacidade de descriptografar secrets com a chave mestra estável.
6. Fazer leitura dupla observável e escrita canônica no Supabase durante uma janela curta; bloquear avanço quando houver divergência.
7. Trocar loaders para Postgres/Storage e tratar o workspace local como cache reconstruível.
8. Consolidar, nesta ordem, auth local, Firestore, secrets/testers, ZIP, validator, provider/modelo e repo/branch.
9. Atualizar testes e documentação; validar Firebase login, isolamento entre contas, criação, chat, proposta/preview/aplicação, checkpoints, ZIP e GitHub.
10. Remover SQLite/snapshot e componentes mortos somente depois de migração reversível aprovada e teste em runtime limpo.

## Restrições para a próxima fase

- Nenhuma tabela, coluna, arquivo ou rota será removida antes da cópia e reconciliação dos dados.
- Nenhuma chave privilegiada será enviada ao browser ou ao sandbox.
- A Fase 3 começa com migrations aditivas e um migrador idempotente; a limpeza estrutural vem depois.
