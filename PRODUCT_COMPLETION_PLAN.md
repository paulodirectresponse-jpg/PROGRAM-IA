# Forge — Plano de conclusão do produto sem alterar o agente

Data de referência: 2026-09-11

## Regra desta rodada

O fluxo de agente atualmente existente fica congelado no estado do commit `486ce9a87e6548591ff57158f5957d80118e5a8d`.

Nesta rodada não serão alterados:
- `server/services/reviewerLoop.ts`
- `server/services/reviewBuild.ts`
- a lógica de iteração Programador -> Revisor -> Correção
- o desenho futuro de múltiplos agentes
- o Execution Engine específico do agente

A branch de trabalho para concluir o restante do produto é `codex/product-completion`.

---

## Etapa 1 — Limpeza e consolidação de Configurações + Autenticação

Objetivo: deixar login, Modelos de IA e Integrações com uma única fonte de verdade.

Entregas:
- manter Firebase Auth como login obrigatório;
- remover caminhos de login local antigos da interface;
- remover UI e handlers legados de "Credenciais & Chaves";
- garantir que APIs de modelos fiquem somente em "Modelos de IA";
- garantir que GitHub, Cloudflare, Supabase e Firebase fiquem somente em "Integrações";
- remover componentes/estados órfãos e mensagens antigas;
- preservar isolamento por usuário, CSRF e secrets criptografados;
- adicionar testes de regressão da interface e APIs de configurações.

Critério de aceite:
- usuário anônimo não acessa o workspace;
- login Firebase é o único login funcional;
- não existe tela paralela para credenciais;
- nenhum segredo é devolvido ao frontend;
- CI completa verde.

## Etapa 2 — Versionamento, checkpoints e restauração

Objetivo: tornar a versão nomeada e o rollback confiáveis de ponta a ponta.

Entregas:
- nome e descrição obrigatórios/claros para versões manuais;
- checkpoint automático antes de mudanças destrutivas;
- restauração de texto e binários;
- restauração remove arquivos criados depois da versão escolhida;
- restauração nunca apaga a possibilidade de voltar ao estado anterior;
- histórico identifica versão atual de forma correta;
- sincronização com GitHub cria novo commit em vez de reescrever histórico;
- detectar conflito remoto antes de push/restauração sincronizada;
- testes end-to-end de criação, restauração e nova sincronização.

Critério de aceite:
- é possível ir para uma versão antiga e voltar;
- binários sobrevivem;
- histórico remoto não é reescrito;
- conflito remoto bloqueia operação insegura.

## Etapa 3 — Ciclo de vida de projetos

Objetivo: terminar todos os fluxos de projeto sem depender do agente.

Entregas:
- criar projeto do zero;
- importar repositório GitHub;
- importar ZIP;
- duplicar projeto;
- excluir projeto;
- exportar ZIP completo;
- preservar arquivos binários;
- validar limites de tamanho, path traversal e arquivos inválidos;
- estados de loading, erro e vazio coerentes;
- isolamento por proprietário em todas as rotas.

Critério de aceite:
- todos os fluxos funcionam para dois usuários independentes;
- importação/exportação mantém a estrutura do projeto.

## Etapa 4 — GitHub completo

Objetivo: transformar a integração GitHub atual em fluxo remoto completo e seguro.

Entregas:
- testar permissões reais do token;
- listar repositórios;
- importar branch;
- listar e criar branches;
- commit/push de texto e binários;
- registrar SHA remoto por projeto/branch;
- pull/refresh do remoto;
- detectar clean/ahead/behind/diverged corretamente;
- criar Pull Request;
- mensagens de erro reais para permissão, conflito e branch protegida.

Critério de aceite:
- fluxo GitHub é executado em repositório real sem operação simulada;
- divergência nunca é sobrescrita silenciosamente.

## Etapa 5 — Cloudflare funcional

Objetivo: permitir publicação real e configuração de domínio.

Entregas:
- validar Account ID, Zone ID e token;
- listar projetos Pages quando permitido;
- criar/vincular projeto de deploy;
- publicar build/artefato suportado;
- consultar status do deploy;
- associar domínio customizado quando houver Zone ID e permissões;
- erros de DNS/permissão expostos claramente.

Critério de aceite:
- um projeto de teste pode ser publicado e seu status consultado pelo Forge.

## Etapa 6 — Supabase funcional

Objetivo: usar Supabase como backend conectado de verdade, não só teste de token.

Entregas:
- validar token e Project Ref;
- consultar projeto;
- configurar dados necessários para Database, Auth e Storage;
- operações mínimas seguras de Storage;
- metadados de conexão sem expor secrets;
- separar token de gerenciamento de chaves destinadas ao app;
- testes reais contra projeto de teste.

Critério de aceite:
- Forge consegue provar acesso e executar as ações explicitamente suportadas sem vazar credenciais.

## Etapa 7 — Firebase de projetos funcional

Objetivo: separar completamente o Firebase interno do Forge do Firebase que o usuário conecta a um projeto.

Entregas:
- manter Firebase Auth do Forge como infraestrutura do produto;
- configurar integração Firebase do projeto do usuário via service account;
- validar projeto e permissões;
- expor somente dados públicos necessários ao app;
- ações suportadas para Auth/Firestore/Storage claramente delimitadas;
- testar cadastro por e-mail e Google no Firebase do próprio Forge em ambiente real.

Critério de aceite:
- login do Forge e Firebase conectado pelo usuário não se confundem;
- ambos podem ser testados independentemente.

## Etapa 8 — Skills sem alterar a lógica do agente

Objetivo: finalizar gestão de skills como recurso de produto, sem redesenhar sua execução pelo agente.

Entregas:
- criar skill;
- editar skill personalizada;
- excluir skill personalizada;
- ativar/desativar;
- escopo por mensagem/projeto/workspace quando suportado pelo schema;
- vínculo por usuário;
- impedir edição indevida das skills padrão;
- validação e testes CRUD.

Critério de aceite:
- duas contas possuem bibliotecas independentes e CRUD consistente.

## Etapa 9 — Segurança, auditoria e dados

Objetivo: fechar os riscos restantes antes de chamar a versão de oficial.

Entregas:
- revisar sessões, CSRF, rate limiting e ownership de todas as rotas;
- garantir que secrets nunca apareçam em logs/respostas;
- revisar master key e estratégia de produção;
- registrar audit events relevantes;
- limpar documentação que ainda sugere credenciais por ENV global para usuários autenticados;
- tratar o histórico Git que já conteve banco/chave e documentar rotação necessária;
- verificar upload ZIP contra zip-slip e abuso de tamanho.

Critério de aceite:
- suíte de testes de acesso cruzado e secrets passa;
- nenhum fluxo normal depende de credencial global do host.

## Etapa 10 — Acabamento da interface e testes E2E

Objetivo: deixar a versão utilizável como produto completo, sem estados falsos.

Entregas:
- estados loading/error/empty;
- responsividade das telas principais;
- textos e nomenclaturas consistentes;
- eliminar componentes legados não utilizados;
- Playwright para login, configurações, projetos, versões e integrações;
- atualizar README e IMPLEMENTATION_STATUS com o estado real.

Critério de aceite:
- nenhuma área indica "aprovado/conectado/publicado" sem evidência real.

## Etapa 11 — Release oficial

Objetivo: transformar a branch validada em versão oficial.

Entregas:
- CI completa verde;
- revisão final do diff;
- merge de `codex/product-completion` na `main`;
- tag de versão;
- changelog;
- checklist de configuração de produção;
- teste final em instalação limpa.

---

## Ordem obrigatória

1. Configurações + Auth
2. Versionamento
3. Projetos
4. GitHub
5. Cloudflare
6. Supabase
7. Firebase
8. Skills
9. Segurança
10. UI/E2E
11. Release

O agente permanece congelado durante todas essas etapas.
