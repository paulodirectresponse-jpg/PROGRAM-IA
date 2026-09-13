# PROGRAM-IA — Handoff para Codex

Atualizado em 2026-09-13 após a consolidação B→I no ChatGPT.

Este arquivo contém somente o que **não deve ser tratado como concluído** pela camada atual. A main deve permanecer verde antes e depois de qualquer item abaixo.

## Regras

- Não reimplementar blocos já consolidados em B, D, E ou F.
- Não substituir execução real por mock.
- Não habilitar loops infinitos. Correções automáticas precisam ter limite de tentativas, budget e AbortSignal.
- Não permitir que um perfil do Agent Engine escape silenciosamente para outro provider/modelo.
- Não expor secrets ao browser, preview ou worker.
- Não alterar Supabase remoto sem migration versionada e reconciliação.
- Manter Firebase como identidade do Forge; Firebase de projetos continua sendo integração externa separada.

## C — Runtime de frameworks e preview executável

### Falta
1. Criar uma camada de runtime/process manager para projetos com frameworks reais.
2. Detectar package manager e framework a partir dos arquivos do projeto.
3. Instalar dependências em sandbox controlado, com allowlist, timeout, limite de saída e cancelamento.
4. Subir e derrubar dev servers sem processos órfãos.
5. Reservar portas com segurança e registrar lifecycle/erros.
6. Encaminhar preview para o servidor real do projeto quando aplicável.
7. Garantir que env/secrets do Forge não sejam herdados pelo processo do projeto.
8. Integrar AbortSignal ao processo e aos comandos de instalação/build.
9. Testar React/Vite e pelo menos mais um framework suportado de ponta a ponta.
10. Rodar smoke/browser test no preview real e validar cleanup após abort/erro.

### Gate
- Importar projeto de framework real → instalar → iniciar → abrir preview → editar → recarregar → validar → encerrar sem processo órfão.

## G — Integrações externas com credenciais reais

### Falta
1. Executar E2E real de GitHub com repo de teste.
2. Executar E2E real de Cloudflare Pages no fluxo Git-trigger já implementado.
3. Executar E2E real do teste de integração Supabase.
4. Executar E2E real do teste de integração Firebase via service account.
5. Implementar Cloudflare Direct Upload somente depois do runtime/build da Fase C produzir artefato confiável.
6. Confirmar que falha externa permanece registrada como erro e não como conectado.

### Gate
- Cada integração deve provar uma operação real e uma falha real com estado persistido correto.

## H — Agent Engine: state machine completa

A infraestrutura atual já possui: 5 agentes, perfis de modelo, candidates, circuit breaker, telemetria, budget, runs/steps, UI e feature flag. O que falta é a orquestração completa.

### Falta
1. Implementar state machine determinística no backend.
2. Fluxo mínimo:
   - SCOUT mapeia contexto/plano;
   - STUDIO entra apenas quando houver trabalho visual/UX;
   - FORGE produz a proposta;
   - ValidatorEngine executa gates reais;
   - SENTINEL interpreta somente evidência real de falha e pede correção localizada;
   - FORGE corrige apenas o step bloqueado;
   - SHIP prepara publicação quando solicitado.
3. Persistir cada transição em agent_steps.
4. Usar context packages MICRO/LOCAL/TASK entre steps.
5. Escalonar BASE_FREE → EXPERT_PAID somente no step bloqueado.
6. Retornar automaticamente ao BASE_FREE no step seguinte.
7. PREMIUM_OVERRIDE deve continuar desabilitado por padrão e exigir confirmação explícita.
8. Limitar correções automáticas. Sugestão do plano aprovado: execução + 1 correção quando surgir erro novo; nunca loop infinito.
9. Abort deve cancelar provider e worker.
10. Atualizar spent_usd do run com invocações reais.
11. Timeline deve mostrar eventos, modelo, custo, validator e retries sem expor cadeia de pensamento.
12. Executar benchmark com 30 tarefas reais antes de aumentar autonomia/tentativas.

### Gate
- Uma tarefa real deve atravessar mais de um agente, falhar em gate, corrigir apenas o step, passar, registrar custo/telemetria e finalizar sem intervenção manual.

## B / I — remoção física do snapshot legado

O fluxo operacional já usa persistência canônica normalizada. O snapshot antigo permanece apenas como leitor de bootstrap/migração.

### Falta
1. Validar em ambiente real que todas as contas existentes foram reconciliadas com as tabelas canônicas e Storage.
2. Comparar contagens, ownership, hashes e decryptability de secrets.
3. Depois da janela de rollback aprovada, remover:
   - leitura de forge_sync_snapshots;
   - métodos de snapshot legado no CloudSyncService;
   - migration/tabela antiga apenas por migration destrutiva versionada e revisada.
4. Remover testes exclusivamente ligados ao snapshot depois do gate de migração.

### Gate
- Banco/Storage canônico reconstruindo a conta completa em runtime limpo sem consultar forge_sync_snapshots.

## B / E / I — colunas espelho antigas

projects.repo_url, projects.branch, projects.provider_id e projects.model_id ainda existem por compatibilidade/migração. Os consumidores GitHub já usam repositories + branches; provider/modelo ativo é por conta/perfil.

### Falta
1. Fazer backfill/reconciliação final das colunas espelho.
2. Confirmar zero consumidor operacional.
3. Remover as colunas apenas via migration segura depois da aceitação dos dados.

## Validação final do Codex

Antes de declarar o pacote concluído:

1. lint/typecheck;
2. testes Node;
3. testes HTTP/security;
4. build;
5. Playwright/browser real;
6. runtime framework E2E;
7. integração GitHub real;
8. integração Cloudflare real;
9. benchmark Agent Engine;
10. confirmar CI verde na main.
