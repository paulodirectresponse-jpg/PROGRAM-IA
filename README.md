# Forge Agent — AI Software Workspace

> **Especificação Oficial:** Baseado nos requisitos estabelecidos em `GOOGLE_AI_STUDIO_PROJECT_SPEC.md` e no plano técnico em `TECHNICAL_PLAN.md`.

O **Forge Agent** é uma plataforma web full-stack para criar, importar, editar, testar, revisar e publicar projetos de software por conversa contínua com um agente de inteligência artificial. O produto é desenhado como um workspace de engenharia real, integrando preview ao vivo em tempo real, sandbox isolado, persistência relacional com migrações, qualidade de código (quality gates), checkpoints versionados e abstração agnóstica de provedores LLM.

---

## 🚀 O Que Funciona Agora (Primeira Versão Vertical)

1. **Criação e Gerenciamento de Projetos**:
   - Criação de novos projetos a partir do zero com template funcional HTML5/Tailwind/JS pronto no sandbox.
   - Suporte a múltiplos projetos com persistência durável no SQLite (`.data/forge.db`) com migrações automáticas de schema.
   - Histórico e seleção de projetos na barra lateral.

2. **Área Central de Conversa Multimodal com 4 Modos Operacionais**:
   - **Planejar (`plan`)**: Elabora plano técnico detalhado com objetivo, escopo incluído/excluído, arquivos afetados, riscos e critérios de aceite antes de tocar no código.
   - **Construir (`build`)**: Aplica mudanças de código diretamente nos arquivos do workspace do projeto, cria checkpoints automáticos e atualiza o preview.
   - **Revisar (`review`)**: Analisa quality gates, segurança de credenciais, build e conformidade dos critérios.
   - **Publicar (`publish`)**: Prepara o pacote de exportação e verifica o destino de deploy.
   - Invocação de skills por botões e comandos rápidos `@skill` (ex: `@ui-premium`, `@seguranca`, `@typescript-react`).
   - Botão para **Aprovar Plano** com transição automática para construção.
   - Botão de **Interromper Execução** com suporte a `AbortController`.

3. **Abstração Agnóstica de Provedores de IA**:
   - Suporte a provedores no formato OpenAI-compatible, permitindo endpoints customizados como **UseOneAI** (`https://api.useoneai.app/v1`, modelo `chatgpt-5.5`) e **OpenAI Oficial**.
   - Suporte nativo a **Google Gemini** através do SDK `@google/genai`.
   - **Fallback demonstrativo local transparente**: quando nenhuma chave de API estiver configurada ou se houver falha de rede, o sistema exibe claramente o aviso de modo demonstrativo e permite continuar interagindo sem travamentos.
   - Segurança rigorosa: nenhuma chave de API é enviada para o cliente.

4. **Live Preview ao Vivo em Sandbox**:
   - Iframe isolado renderizando a aplicação do projeto sob `/api/preview/:projectId/index.html`.
   - Controles de resolução de tela: Desktop (100%), Tablet (768px) e Mobile (375px).
   - Recarregamento manual com nonce e botão para abrir em nova aba.

5. **Visualizador e Editor de Código**:
   - Navegação por arquivos do workspace.
   - Edição de código com botão de salvamento e criação de checkpoints.
   - Criação de novos arquivos no projeto.

6. **Quality Gates & Auditoria**:
   - **Secret Leaks Guard**: Varredura automática contra exposição acidental de tokens e chaves privadas nos arquivos do projeto.
   - **Build & Syntax**: Validação de arquivos estruturados e integridade do HTML.
   - **Histórico de Verificações**: Registro persistente de conformidade por checkpoint.

7. **Checkpoints & Rollback Git-like**:
   - Cada ciclo de alteração gera um snapshot completo dos arquivos do workspace.
   - Modal de histórico com restauração em um clique para qualquer versão anterior.

8. **Integração Preparada com GitHub Sem Operações Falsas**:
   - O sistema verifica o estado real da variável `GITHUB_TOKEN`.
   - Quando não configurado: exibe o estado transparente **"Pendente de Configuração"**, explicando exatamente o que falta, sem inventar commits ou pushes falsos.
   - Quando configurado: valida autenticação diretamente com a API do GitHub (`/user`) e lista repositórios reais do usuário.

9. **Exportação do Projeto**:
   - Download do bundle completo do projeto em formato JSON/código para execução local.

---

## 🛠️ Arquitetura

```text
├── server.ts                    # Servidor Express + Vite Middleware (Port 3000)
├── server/
│   ├── db/
│   │   ├── schema.sql           # Schema DDL com as 21 entidades
│   │   └── index.ts             # Inicializador SQLite e migrações versionadas
│   ├── routes.ts                # Endpoints REST (projects, conversations, providers, skills, github, preview)
│   └── services/
│       ├── workspaceManager.ts  # Manipulação de arquivos em sandbox (.data/projects/) e checkpoints
│       ├── llmAdapter.ts        # Adaptadores UseOneAI, Gemini e Fallback demonstrativo
│       └── githubService.ts     # Integração real com a API do GitHub
├── src/
│   ├── main.tsx                 # Entrypoint React
│   ├── App.tsx                  # Workspace principal
│   ├── types.ts                 # Tipagens TypeScript do sistema
│   └── components/
│       ├── Sidebar.tsx          # Barra de navegação e status
│       ├── ConversationPanel.tsx# Painel vertical de conversa e modos
│       ├── WorkspaceArea.tsx    # Preview ao vivo, editor, verificações, arquivos, deploy e logs
│       ├── NewProjectModal.tsx  # Modal de criação de projetos
│       ├── ProvidersModal.tsx   # Configuração de provedores e modelos
│       ├── SkillsModal.tsx      # Gerenciamento de skills
│       ├── CheckpointsModal.tsx # Histórico de snapshots e rollback
│       └── IntegrationsModal.tsx# Status de integrações
├── tests/
│   └── forge.test.ts            # Suite de testes automatizados com node:test
├── GOOGLE_AI_STUDIO_PROJECT_SPEC.md # Especificação do produto
└── TECHNICAL_PLAN.md            # Plano técnico da versão vertical
```

---

## ⚙️ Variáveis de Ambiente

Crie um arquivo `.env` baseado em `.env.example`:

```bash
# Provedor OpenAI-compatible (ex: UseOneAI, OpenAI, Groq)
OPENAI_API_KEY="sua_chave_aqui"
OPENAI_BASE_URL="https://api.useoneai.app/v1"
OPENAI_MODEL_ID="chatgpt-5.5"

# Google Gemini (opcional)
GEMINI_API_KEY="sua_chave_gemini"

# GitHub Integration (opcional para commits e repos reais)
GITHUB_TOKEN="ghp_seu_token_aqui"
```

> **Nota:** Se você não configurar nenhuma chave, a aplicação continuará funcionando perfeitamente através do **Modo Demonstrativo Local**, sinalizando o estado pendente conforme exigido na especificação.

---

## 📦 Instalação e Execução

### Modo de Desenvolvimento
```bash
npm run dev
```
Acesse `http://localhost:3000`.

### Executar Testes
```bash
npm test
```

### Build de Produção
```bash
npm run build
npm start
```

---

## 🔮 Funcionalidades Futuras (Planejadas)

- Sincronização bidirecional completa com GitHub (pull requests remotos e webhook de status de CI).
- Desktop Bridge com Electron para acesso direto ao sistema de arquivos local e terminal Git nativo.
- Interface especializada para geração de imagens (`IImageGenAdapter`).
- Transcrição e multimodalidade para vídeo e voz.
- Colaboração em tempo real com múltiplos usuários.
- Banco de dados PostgreSQL com Drizzle ORM para deploys multi-tenant em nuvem.
- Deploy automatizado com 1 clique para Cloud Run e Vercel.
