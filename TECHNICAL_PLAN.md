# PROGRAM-IA — Plano técnico atual

Atualizado em 2026-09-14.

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

Estado atual: state machine determinística implementada com `forcedAgentKey`, Context Engine V2, Tool-First/Sandbox, ValidatorEngine, Browser Quality Gate real, repair bounded/escalonamento local e merge atômico após aprovação. Próximos blocos independentes: benchmark da Fase 4 e runtime/HMR de produto.

## 5.1 Tool-First — Fase 2

A Fase 2 está implementada como camada operacional do Agent Engine.

- Tool Registry backend com contratos de risco, schema, availability e resume policy.
- Tool journal durável por project/run/step/sandbox, com request hash, idempotency, status, erro e duração.
- Reads podem consultar workspace oficial ou sandbox conforme o contexto.
- Writes, deletes, patches e processos exigem sandbox.
- FORGE materializa propostas em sandbox; o workspace oficial permanece intocado até aprovação.
- Provider pode solicitar tools read-only em loop bounded por rounds, execuções e evidence budget.
- Processos usam cwd do sandbox, HOME/TMP/config sintéticos, env allowlisted, output redacted, timeout, AbortSignal e process-tree cleanup.
- ValidatorEngine continua sendo o único quality gate canônico.
- Approval verifica conteúdo candidato, revisão-base e allowlist de paths.
- Build/test artifacts extras não são promovidos automaticamente.
- Merge final usa staging + segunda verificação de base + swap atômico + checkpoint + Context Engine sync.
- Falha durante finalização ou persistência do workflow aciona restauração do estado oficial anterior.
- Restart converte execução incerta em `interrupted`; mutation/process com side effect incerto não é repetido silenciosamente.
- Continuação pode recuperar sandbox sobrevivente e contexto persistido.

O sandbox desta fase é uma fronteira lógica do PROGRAM-IA. Ele não deve ser descrito como container/microVM ou isolamento adversarial de kernel; esse hardening pertence à infraestrutura caso o produto passe a executar código deliberadamente hostil.



## 5.2 Browser Agent + Quality Gate — Fase 3

A Fase 3 observa o candidato real no sandbox antes do merge oficial.

Fluxo canônico:
`ValidatorEngine -> browser.inspect_page -> evidência desktop/mobile -> SENTINEL em falha executável -> um FORGE repair localizado -> ValidatorEngine -> browser.inspect_page -> merge ou bloqueio`.

Implementado:
- Playwright/Chromium real;
- inspeção desktop 1280x720 e mobile 390x844;
- projetos estáticos servidos por HTTP local diretamente do sandbox;
- projetos com scripts `dev` ou `start` executados por instância isolada do `RuntimeManager`;
- requests externos do browser não são liberados durante o gate;
- coleta de page errors, console errors, requests locais falhos, respostas HTTP ruins, overflow horizontal, controles sem nome acessível, imagens sem alt e IDs duplicados;
- screenshots, hashes e métricas registrados como evidência;
- `browser_quality_runs` persiste o resultado e `tool_executions` preserva provenance;
- falha executável cria SENTINEL e no máximo um FORGE repair;
- depois do repair, ValidatorEngine e browser são executados novamente;
- segunda falha bloqueia o merge;
- Chromium indisponível resulta em `unverified`, nunca em sucesso falso;
- screenshots são expostos apenas por rota autenticada e vinculada ao owner;
- warnings de layout/a11y são evidência e não disparam autocorreção sozinhos.

O Browser Quality Gate complementa o ValidatorEngine. Ele não cria um segundo validator de código.


## 6. Validação

`ValidatorEngine` permanece o gate canônico de código/processo. O Browser Quality Gate adiciona evidência runtime/DOM sobre o mesmo candidato no sandbox. Falha executável impede promoção; capacidade ausente fica `unverified`, nunca `passed`.

## 7. GitHub

Fonte canônica: `repositories` + `branches`. Campos antigos em `projects` são espelhos de migração e só devem ser removidos após reconciliação.

## 8. Integrações

Estados: `pending_credentials`, `connected`, `error`.

Cloudflare Pages:
- Git-trigger existente;
- Direct Upload em código exige build real, output compatível e Wrangler controlado pelo Forge.

## 9. Gates de conclusão

A versão completa exige CI verde, runtime framework E2E, HMR, integrações reais, Agent Engine com correção localizada e benchmark de 30 tarefas, reconciliação cloud e remoção destrutiva pós-gate.
