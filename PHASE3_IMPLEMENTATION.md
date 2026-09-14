# FASE 3 — Browser Agent + Quality Gate — Contrato implementado

Base da fase:
`6e77da2d229bfe27170392c6beb6bca983737c36`

## Objetivo

Adicionar observação real do candidato já isolado pela Fase 2, antes de promover mudanças ao workspace oficial.

O Browser Agent não substitui o ValidatorEngine e não escreve diretamente no workspace oficial.

## Pipeline

```
candidate sandbox
  -> ValidatorEngine
  -> browser.inspect_page
  -> BrowserQualityService / Playwright
  -> pass: merge permitido conforme qualidade combinada
  -> fail: SENTINEL evidence
           -> um FORGE repair localizado
           -> ValidatorEngine
           -> browser.inspect_page
           -> pass/unverified/fail
```

## Browser real

- Playwright + Chromium headless.
- Viewports fixos de evidência: desktop 1280x720 e mobile 390x844.
- Static HTML: servidor HTTP local owner-scoped sobre o sandbox.
- Framework: RuntimeManager iniciado contra o diretório do sandbox.
- Browser não recebe secrets do Forge.
- Requests externos da página são bloqueados durante o gate; recursos locais continuam disponíveis.
- AbortSignal encerra inspeção/runtime relacionados.

## Evidência

Cada execução registra:
- status `passed | failed | unverified | skipped`;
- runtime/framework/entry path;
- page errors;
- console errors;
- requests locais falhos e respostas HTTP ruins;
- overflow horizontal;
- interativos sem nome acessível;
- imagens sem `alt`;
- IDs duplicados;
- screenshot desktop/mobile, SHA-256 e bytes;
- duração e reason.

Persistência:
- `browser_quality_runs`;
- `tool_executions` via `browser.inspect_page`;
- `verifications` com `gate_type=preview` para a timeline canônica.

Console/URLs são redacted antes de serem persistidos como evidence. Screenshot não é enviado ao provider automaticamente.

## Quality semantics

Falhas executáveis:
- page exception;
- console fatal conhecido;
- request local crítico falho;
- HTTP crítico ruim;
- runtime que não inicia;
- falha interna real da inspeção.

Essas falhas podem acionar exatamente um repair.

Warnings:
- overflow horizontal;
- elemento interativo sem nome detectável;
- imagem sem alt;
- IDs duplicados;
- página sem texto visível.

Warnings são evidence e não autorizam redesign automático subjetivo.

`browser_unavailable` resulta em `unverified`; nunca em sucesso falso.

## Repair

Quando existe run do Agent Engine e o browser falha:
1. SENTINEL recebe somente evidence estruturada.
2. ContextCommit MICRO registra blockers.
3. FORGE recebe scope LOCAL e focus paths.
4. Mudanças passam pelas mutation tools do sandbox.
5. ValidatorEngine é executado novamente.
6. Browser é executado novamente.
7. Segunda falha encerra o run sem merge.

Não existe terceiro repair automático.

Fluxos sem run também passam pelo browser gate; em falha executável, a proposta é bloqueada sem mutar o workspace oficial.

## Segurança e ownership

- evidence/screenshot exige owner do projeto;
- paths internos de screenshot não entram no payload público/tool output;
- screenshot é servido por rota autenticada;
- artifact cleanup acompanha exclusão do projeto;
- nenhum Supabase remoto é alterado pela Fase 3;
- sandbox continua sendo fronteira lógica de filesystem/process/env, não microVM.

## Fora da Fase 3

- benchmark pesado de 30 tarefas com providers reais: Fase 4;
- WebSocket/HMR autenticado do preview de produto;
- E2E externos que dependem de credenciais reais;
- isolamento adversarial de kernel/container/microVM.


## Production / Railway hardening

A conclusão da Fase 3 também fecha dois riscos de produção:

- `playwright` é dependência de runtime, não somente devDependency;
- a imagem de produção usa `node:24-bookworm` e instala Chromium + dependências do sistema com `playwright install --with-deps chromium`;
- o Dockerfile é smoke-tested em PR: build da imagem, boot real do servidor e `GET /api/health`;
- o bootstrap SQLite só executa `schema.sql` em banco realmente novo. Bancos persistentes existentes passam apenas pelas migrations incrementais;
- isso evita o crash introduzido na Fase 2 em bancos legados, onde o snapshot de schema podia tentar criar índices de `tool_executions` usando colunas ainda não adicionadas pela Migration 005/006;
- `Phase2RecoveryService.recoverStartup()` passou a ser best-effort: uma recuperação de sandbox inconsistente não derruba o processo principal depois de uma migration válida.

Esses hardenings preservam o volume existente e não exigem reset destrutivo do banco.
