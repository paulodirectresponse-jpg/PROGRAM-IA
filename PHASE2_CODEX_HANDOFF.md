# FASE 2 — Tool-First + Sandbox + Resumability — Estado final

Base da fase:
`c95705d4148913438ad83f862daed1a5a7f36dd9`

A Fase 2 deixou de ser um handoff pendente. A implementação está integrada nesta branch e deve ser tratada como contrato existente, não como trabalho a recomeçar.

## Contrato implementado

Fluxo canônico:

Agent step
→ Context Engine V2
→ Tool Registry
→ sandbox isolado por proposta/run
→ tool execution journal
→ ValidatorEngine
→ aprovação do usuário
→ base-revision check
→ merge atômico allowlisted
→ checkpoint + Context Engine sync
→ Requirement Ledger / ContextCommit / estado do run

### Tool Registry e provenance

Ferramentas:
- `workspace.list_tree`
- `workspace.read_file`
- `workspace.search_text`
- `workspace.write_file`
- `workspace.delete_file`
- `workspace.apply_patch`
- `process.run`

Writes, deletes, patches e processos exigem sandbox. Cada execução registra project/run/step/sandbox, versão da ferramenta, status, duração, request hash, idempotency key, resume policy e erro estruturado sem persistir conteúdo bruto sensível.

### Sandbox

- snapshot isolado do projeto por execução/proposta;
- base manifest + SHA-256 para stale detection;
- symlinks, `.git`, `node_modules`, arquivos sensíveis e configurações de credencial não entram na visão de ferramentas;
- path traversal e symlink escape são bloqueados;
- sandbox fica fora da árvore de dados da aplicação por padrão;
- proposal/build não escreve código gerado no workspace oficial antes da aprovação.

### Process supervision

- cwd fixo no sandbox;
- HOME/USERPROFILE/TMP/config/cache sintéticos dentro do sandbox;
- env allowlisted, sem tokens/providers do Forge;
- lifecycle scripts de instalação desabilitados por padrão;
- timeout + AbortSignal + process-tree cleanup;
- saída limitada e redacted.

Observação de segurança: este sandbox é uma fronteira lógica de execução e filesystem do PROGRAM-IA, não uma microVM/container de kernel. Código de projeto deliberadamente hostil deve ser executado em infraestrutura containerizada/microVM antes de ser tratado como adversarial isolation.

### Tool loop

O provider pode solicitar batches bounded de tools read-only quando o ContextPack inicial não é suficiente. O loop possui limite de rounds, quantidade de execuções, evidence budget e AbortSignal. Mutation/process não são liberados nesse loop de inspeção; propostas FORGE são materializadas pela camada de ferramentas no sandbox.

### Approval e merge

- proposta aprovada é comparada ao conteúdo candidato validado;
- arquivos extras criados por build/test não entram no merge;
- conteúdo alterado fora da proposta/repair esperado causa `sandbox_proposal_mismatch`;
- base alterada causa `stale_base_revision`;
- merge copia somente paths allowlisted;
- há segunda checagem de base imediatamente antes do swap;
- falha durante finalização restaura o workspace anterior;
- falha ao persistir Requirement Ledger/ContextCommit/run state após merge também aciona rollback;
- Context Engine é sincronizado após merge/rollback.

### Resumability

- tools `queued/running` viram `interrupted` após restart;
- side effect incerto não é repetido silenciosamente;
- idempotency key impede repetição de mutation;
- run interrompido pode ser continuado;
- sandbox sobrevivente é recuperado e reutilizado pela continuação quando consistente.

## Gates validados

- [x] FORGE não escreve diretamente no workspace oficial durante proposal/build.
- [x] mutation tools executam somente no sandbox.
- [x] process.run é supervisionado, bounded e sem secrets do Forge no env.
- [x] tool loop real existe no Agent Engine.
- [x] read/write/process possuem provenance.
- [x] restart/interrupted recovery possui testes.
- [x] side effect incerto não é reexecutado silenciosamente.
- [x] approval valida revisão-base e candidato.
- [x] merge final é allowlisted e atômico com rollback.
- [x] Context Engine é sincronizado após aplicação.
- [x] ValidatorEngine permanece canônico.
- [x] AbortSignal encerra processos supervisionados.
- [x] não existe loop infinito.
- [x] não foi introduzido hard cap lógico de arquivos.
- [x] Supabase remoto não foi alterado.

## Fora da Fase 2

- Browser Agent / browser repair loop: Fase 3.
- benchmark pesado de 30 tarefas com providers reais: Fase 4.
- isolamento adversarial de kernel/container/microVM: hardening de infraestrutura, não deve ser confundido com o sandbox lógico desta fase.
