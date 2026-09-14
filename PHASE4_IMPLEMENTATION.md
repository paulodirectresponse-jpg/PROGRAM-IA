# FASE 4 — Benchmark real, qualidade e custo

Status: **EM IMPLEMENTAÇÃO**.

Base de início:
`fcb8b9a781956c77931122f6b5989badb940b052`

Branch:
`codex/phase4-benchmark-quality`

A Fase 4 não adiciona outro agente. Ela mede, com provider real e evidência persistida, se a arquitetura das Fases 0–3 entrega qualidade suficiente para release.

## Objetivos

1. Executar uma suíte canônica de 30 tarefas reais.
2. Medir qualidade por categoria sem depender apenas de julgamento subjetivo de LLM.
3. Provar que o provider foi realmente chamado; fallback demonstrativo nunca conta como benchmark válido.
4. Medir custo, latência, tokens, attempts, repairs, ContextPacks, tool usage e escalonamento.
5. Verificar o fluxo de produção `BASE_FREE -> EXPERT_PAID` somente quando necessário.
6. Produzir um release gate versionado e reproduzível.
7. Não gastar créditos sem confirmação explícita do usuário.

## 4A — Harness e dataset — IMPLEMENTADO NA BRANCH

### Suite `phase4-v1-30`

30 casos fixos, versionados e independentes:
- planning;
- context;
- build;
- visual;
- repair;
- review.

Os casos usam fixtures efêmeras e requisitos observáveis, como caminhos permitidos, conteúdo literal obrigatório, ValidatorEngine e Browser Quality Gate.

O catálogo não é exposto com o source completo das fixtures pela API.

### Persistência

Migration 008:
- `benchmark_runs`;
- `benchmark_case_runs`.

Migration 009:
- `model_invocations.benchmark_run_id`;
- `model_invocations.benchmark_case_id`.

Migration 010:
- somente um benchmark pago `queued/running` por usuário.

A invocation real é preservada para accounting diário e provenance, mas o projeto efêmero é removido. Antes da limpeza, `project_id` da invocation é zerado para não criar referência a projeto temporário removido.

### Runner

`BenchmarkService`:
- preflight de providers e budget;
- confirmação explícita de custo;
- execução sequencial;
- budget global bounded;
- AbortController/cancel;
- resume de run interrompido;
- recuperação de restart;
- projetos efêmeros por caso;
- cleanup de workspace, sandbox, runtime e evidence;
- score determinístico;
- agregação de métricas;
- release gate.

O benchmark nunca roda automaticamente no startup.

### APIs

- `GET /api/benchmarks/preflight`
- `GET /api/benchmarks/catalog`
- `GET /api/benchmarks`
- `GET /api/benchmarks/:benchmarkRunId`
- `GET /api/benchmarks/:benchmarkRunId/release-gate`
- `POST /api/benchmarks`
- `POST /api/benchmarks/:benchmarkRunId/cancel`
- `POST /api/benchmarks/:benchmarkRunId/resume`

Para iniciar:
- `confirmRealProviderCosts: true` é obrigatório;
- `maxCostUsd` deve ficar entre US$0.05 e US$3.00;
- o budget diário do ModelRouter continua valendo;
- pelo menos um candidate real configurado precisa existir.

## Score

Cada caso exige provider real. O score é composto por critérios determinísticos conforme o tipo:

### Plan
- output estruturado;
- requirements;
- task graph;
- acceptance criteria;
- links task -> requirement;
- termos exigidos pelo caso.

### Review
- evidência concreta exigida pelo fixture;
- caminho/marker literal.

### Build/Visual/Repair
- output estruturado;
- paths obrigatórios;
- precisão de escopo;
- paths proibidos intocados;
- assertions de conteúdo;
- apply real;
- ValidatorEngine quando exigido;
- Browser Quality Gate quando exigido.

Fallback demonstrativo, erro de provider ou gate obrigatório falho impede aprovação do caso.

## Métricas

Por caso:
- score/pass;
- provider/model/profile;
- custo;
- latência;
- input/output tokens;
- attempts do Agent Engine;
- repairs;
- expert escalations;
- validator/browser status;
- quantidade de tools e ContextPacks;
- evidence compacta.

Por run:
- pass rate;
- average score;
- first-pass rate;
- expert escalation rate;
- repair rate;
- verified rate;
- custo total;
- latência média;
- breakdown por provider;
- breakdown por categoria.

## Release gate v1

Somente um run completo de 30 casos pode ser elegível.

Threshold inicial versionado:
- 30/30 casos concluídos;
- 30/30 com provider real;
- pass rate >= 80%;
- average score >= 80;
- verified rate >= 90%;
- cada categoria >= 60% de aprovação;
- no máximo 2 repairs por caso;
- custo total dentro do budget confirmado.

Esses thresholds podem ser recalibrados após o primeiro run real, mas qualquer mudança precisa gerar nova versão do gate; não editar retrospectivamente o gate v1.

## Segurança e custo

- nenhuma credencial entra nas fixtures/evidence;
- nenhum benchmark usa fallback como sucesso;
- um usuário não pode disparar dois benchmarks pagos simultâneos;
- invocations reais permanecem no accounting diário mesmo após cleanup do projeto efêmero;
- restart não apaga gasto já ocorrido;
- o runner não altera Supabase remoto como parte da implementação;
- nenhuma execução real de 30 casos deve ser disparada sem decisão explícita do usuário sobre budget.

## Ainda pendente para concluir a Fase 4

1. Validar 4A no CI final da branch.
2. Adicionar visualização de benchmark/relatório na interface ou painel operacional.
3. Executar smoke real de poucos casos com provider configurado.
4. Executar a suíte canônica completa de 30 casos com provider real.
5. Auditar falsos positivos/falsos negativos do score.
6. Rodar o release gate e registrar resultado final.
7. Só então marcar a Fase 4 como concluída e integrar à `main`.

Não confundir a existência do harness com a conclusão do benchmark real.
