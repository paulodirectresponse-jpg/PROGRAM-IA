# Forge Agent — especificação para o Google AI Studio

## Prompt de abertura

Construa o Forge Agent como uma plataforma web full-stack para criar, importar, editar, testar, revisar e publicar projetos de software por conversa com um agente de IA.

O produto deve ser tratado como um workspace de desenvolvimento real, e não como uma landing page ou uma demonstração visual. A primeira versão precisa ter fluxos funcionais, persistência de dados, estados claros, tratamento de erros e uma arquitetura preparada para receber diferentes provedores de LLM. Não invente integrações que não estejam configuradas: quando uma chave ou autorização não existir, mostre o estado “não configurado” e explique o que falta.

Use React com TypeScript no frontend e Node.js no backend. Separe a interface, os serviços de domínio, os adaptadores de provedores de IA, as integrações externas e a persistência. O código deve poder ser sincronizado com GitHub e desenvolvido localmente depois.

Antes de gerar muitos arquivos, produza um plano técnico curto contendo: arquitetura, entidades persistidas, fluxos da primeira versão, limites da primeira versão e pontos de extensão para recursos futuros. Depois implemente a primeira versão vertical funcional.

## 1. Objetivo do produto

O Forge Agent deve permitir que uma pessoa comece um projeto do zero ou continue um projeto existente, converse com um agente, veja o resultado em um preview ao vivo, revise as mudanças e publique o trabalho.

O sistema deve atender três perfis:
- Pessoa iniciante, que descreve o que deseja e precisa de orientação.
- Pessoa que cria aplicações web e quer iterar rapidamente com preview.
- Pessoa desenvolvedora, que importa projetos existentes, trabalha com branches, diffs, testes e GitHub.

O produto precisa manter contexto por projeto. Cada projeto tem suas próprias conversas, arquivos, instruções, skills, integrações, histórico e verificações.

## 2. Modos de uso
### 2.1 Criar um projeto do zero
### 2.2 Importar projeto do GitHub
### 2.3 Importar projeto local (ZIP / arquivos)
### 2.4 Continuar projeto remoto
### 2.5 Modo Planejar
### 2.6 Modo Construir
### 2.7 Modo Revisar e verificar
### 2.8 Modo Publicar

## 3. Interface principal
- Navegação lateral (projetos, conversas, skills, provedores, integrações, checkpoints, configs).
- Painel vertical de conversa (mensagens, chips de arquivos, aprovação de plano, seletor de modo, skills `@skill`).
- Área de trabalho e preview (Preview ao vivo, Código e diff, Verificações, Arquivos, Deploy, Logs).

## 4. Abstração de LLM e provedores
Interface para OpenAI-compatible (ex: UseOneAI, OpenAI, Groq, Ollama) e Google Gemini.
Campos: providerId, nome, baseUrl, apiKey (armazenada segura no backend), modelId, streaming, visão, tool calling, contextLimit, status de conexão.
Nunca enviar chaves para o frontend.

## 5. Skills
Skills de projeto e de mensagem (`@nome-da-skill`), design system, UI premium, segurança, reviewer loop, etc.

## 6. Fluxo de execução e verificação
Entender -> Ler contexto -> Planejar -> Aprovar -> Modificar em workspace/checkpoint -> Testar/Lint/Preview -> Revisar diff.

## 7. Dados e persistência com migrações
Tabelas: users, workspaces, projects, project_sources, repositories, branches, conversations, messages, attachments, tasks, plans, skills, providers, models, checkpoints, file_changes, verifications, logs, deployments, integrations, audit_events.

## 8. GitHub
Integração real preparada (OAuth / Personal Access Token): listar repos, branches, criar repo/branch/commit. Mostrar estado pendente claro quando não configurado. Nunca simular operações com mock enganoso.

## 9. Anexos e multimodalidade
Texto, código, imagens e ZIPs com hash, status e processamento.

## 10. Recursos futuros
Geração de imagem, aplicativo desktop via Electron, múltiplos agentes, marketplace de skills, CI/CD avançado.
