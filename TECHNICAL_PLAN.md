# Forge Agent — Plano Técnico da Primeira Versão Vertical

Este documento atende aos requisitos da especificação oficial `GOOGLE_AI_STUDIO_PROJECT_SPEC.md` e estabelece a base para o desenvolvimento do Forge Agent.

---

## 1. Arquitetura

O sistema é construído como uma aplicação web full-stack estruturada em camadas independentes:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (React 19 + TypeScript)                │
│  - Workspace Principal (Layout denso, visual escuro premium)          │
│  - Sidebar: Projetos, Conversas, Skills, Provedores, Checkpoints       │
│  - Painel de Conversa: Modos (Plan/Build/Review/Publish), @skills      │
│  - Work Area: Preview ao Vivo (iframe sandbox), Código/Diff,          │
│    Verificações (Quality Gates), Explorador de Arquivos, Deploy, Logs  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ REST API / SSE
┌───────────────────────────────────▼────────────────────────────────────┐
│                    BACKEND (Node.js + Express + TypeScript)            │
│  ┌─────────────────────────┐  ┌─────────────────────────────────────┐  │
│  │     API & Middlewares   │  │        Domain Services              │  │
│  │  - /api/projects        │  │  - ProjectManager                   │  │
│  │  - /api/conversations   │  │  - WorkspaceFileManager (Sandbox)   │  │
│  │  - /api/tasks & plans   │  │  - ExecutionEngine                  │  │
│  │  - /api/providers       │  │  - VerificationEngine (Gates)       │  │
│  │  - /api/skills          │  │  - CheckpointManager (Git-like)     │  │
│  │  - /api/github          │  │  - AuditLogger                      │  │
│  └─────────────────────────┘  └─────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                     Adaptadores de Integração                    │  │
│  │  - LLMAdapterFactory:                                            │  │
│  │      * OpenAICompatibleAdapter (UseOneAI, OpenAI, Groq, etc.)     │  │
│  │      * GeminiAdapter (@google/genai)                             │  │
│  │      * FallbackDemonstrativeAdapter (quando não configurado)      │  │
│  │  - GitHubAdapter (Octokit-compatible REST real, com status       │  │
│  │    PENDING transparente quando faltam credenciais)               │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                 Camada de Persistência com Migrações             │  │
│  │  - SQLite Engine (nativo Node 22 com schema migrations)          │  │
│  │  - Repositórios tipados para todas as 20 entidades mínimas       │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Entidades Persistidas (20 Entidades da Especificação)

A camada de dados conta com migrações automáticas versionadas (`schema_migrations`):

1. **users**: id, email, name, role, created_at.
2. **workspaces**: id, name, root_path, created_at.
3. **projects**: id, workspace_id, name, description, origin (`novo`, `local`, `github`), repo_url, branch, status, current_checkpoint_id, provider_id, model_id, created_at, updated_at.
4. **project_sources**: id, project_id, type (`scratch`, `github_repo`, `zip_upload`), original_path_or_url.
5. **repositories**: id, project_id, remote_url, default_branch, visibility, is_connected.
6. **branches**: id, project_id, name, is_current, head_commit_hash.
7. **conversations**: id, project_id, title, mode (`plan`, `build`, `review`, `publish`), created_at.
8. **messages**: id, conversation_id, sender (`user`, `agent`, `system`), content, metadata_json, created_at.
9. **attachments**: id, message_id, project_id, name, file_type, size_bytes, hash, storage_path, status.
10. **tasks**: id, project_id, conversation_id, title, status (`pending`, `in_progress`, `completed`, `failed`), mode, created_at.
11. **plans**: id, task_id, project_id, objective, scope_in, scope_out, files_affected_json, integrations_json, risks_json, acceptance_criteria_json, status (`draft`, `approved`, `rejected`), created_at.
12. **skills**: id, name, slug, description, system_instructions, scope (`message`, `project`, `workspace`), is_active, created_at.
13. **providers**: id, provider_key (`useoneai`, `openai`, `gemini`), name, base_url, model_id, streaming_supported, vision_supported, tools_supported, json_supported, context_limit, is_configured, created_at.
14. **models**: id, provider_id, model_code, display_name, description.
15. **checkpoints**: id, project_id, title, description, parent_id, files_snapshot_json, created_at.
16. **file_changes**: id, checkpoint_id, project_id, file_path, action (`create`, `modify`, `delete`), old_content, new_content, diff_patch, created_at.
17. **verifications**: id, project_id, checkpoint_id, gate_type (`build`, `typecheck`, `lint`, `security`, `preview`), status (`pass`, `fail`, `warn`), details_json, created_at.
18. **logs**: id, project_id, category, level (`info`, `warn`, `error`), message, meta_json, created_at.
19. **deployments**: id, project_id, target (`preview`, `github_pages`, `cloud_run`), status (`pending`, `active`, `failed`), url, created_at.
20. **integrations**: id, service_name (`github`, `useoneai`, `gemini`), config_json, status (`connected`, `pending_credentials`, `error`), last_verified_at.
21. **audit_events**: id, user_id, project_id, action, details_json, created_at.

---

## 3. Fluxos da Primeira Versão Vertical

1. **Criação de Projeto**:
   - Do zero (scratch com template funcional HTML/TS/React no workspace do projeto).
   - Importação via ZIP ou repositório GitHub.
2. **Conversação com o Agente com Suporte a 4 Modos**:
   - **Planejar**: Gera plano estruturado (objetivo, escopo incluído/excluído, arquivos, riscos, critérios de aceite). Não altera arquivos antes da aprovação.
   - **Construir**: Aplica alterações diretamente aos arquivos do projeto, gera checkpoints e atualiza o preview ao vivo em tempo real.
   - **Revisar e Verificar**: Executa quality gates (verificação de integridade, syntax/build, secrets expostos, console logs e diff de arquivos).
   - **Publicar**: Confirmação prévia para sincronização e exportação.
3. **Gestão de Provedores e Secrets no Servidor**:
   - Configuração de OpenAI-compatible (ex: UseOneAI `https://api.useoneai.app/v1`, modelo `chatgpt-5.5`) e Gemini.
   - Chave de API nunca enviada para o frontend; apenas status de conectividade e modelo são expostos.
   - Detecção transparente: quando a chave não existe, o sistema exibe estado "Não configurado / Pendente" e ativa o modo demonstrativo guiado explicitamente identificado.
4. **Workspace & Preview ao Vivo**:
   - Gerenciador de arquivos do projeto no servidor em sandbox de workspace.
   - Visualização de arquivos e diff lado a lado/unificado antes e após alterações.
   - Preview ao vivo em tempo real dentro do sandbox iframe com reload imediato.
5. **Checkpoints e Rollback**:
   - Cada intervenção do agente cria um checkpoint com snapshot dos arquivos.
   - Permite restaurar qualquer checkpoint anterior com um clique.
6. **Integração Real com GitHub**:
   - Status claro de conexão com GitHub (Token de Acesso / OAuth).
   - Se configurado: lista repositórios reais e cria commit/branch.
   - Se não configurado: exibe "Integração GitHub Pendente", instruindo o usuário sobre variáveis necessárias (`GITHUB_TOKEN`), sem fingir ou simular um falso commit.

---

## 4. Integrações Necessárias

- **Provedor LLM (OpenAI-Compatible / UseOneAI / Gemini)**: Conexão via backend seguro para geração de planos e código.
- **GitHub API**: Integração com GitHub REST API para gerenciamento de repositórios e branches.
- **Preview Server / Sandbox**: Servidor de arquivos estáticos/HTML seguro para renderização do aplicativo desenvolvido dentro do iframe de preview.
- **Persistência SQLite com Migrações**: Armazenamento durável no servidor.

---

## 5. Limites da Primeira Versão

- Não executa comandos de terminal arbitrário sem sandbox (segurança garantida por operações declarativas de arquivos e build estático/web).
- Não há autenticação multi-tenant complexa (usuário local padrão de workspace).
- Não há geração de imagens por IA (marcada como recurso futuro na spec).
- Sincronização com GitHub requer `GITHUB_TOKEN` configurado no backend. Sem ele, a interface exibe claramente o formulário e as instruções sem realizar mock enganoso.

---

## 6. Pontos de Extensão para Recursos Futuros

- **Electron Desktop Bridge**: Abstração `IDesktopBridge` para acesso ao sistema de arquivos local e terminal Git nativo.
- **Múltiplos Provedores Concorrentes & Marketplace de Skills**: Injeção dinâmica de skills via repositório `.agents/skills`.
- **Geração de Imagens & Multimodalidade com Vídeo**: Interface `IImageGenAdapter` desacoplada do adaptador de texto.
- **Deploy Direto (Cloud Run / Vercel)**: Módulo de publicação com webhooks e build containers.
