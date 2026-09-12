# Forge Agent — Arquitetura Oficial

Este documento é normativo. Em caso de conflito com documentação ou código legado, esta arquitetura define a direção de migração.

## Fontes de verdade

| Responsabilidade | Fonte oficial |
| --- | --- |
| Identidade e login | Firebase Auth. O backend valida o Firebase ID Token e mantém a sessão do Forge em cookie HttpOnly. |
| Dados da conta e dos projetos | Supabase Postgres, com isolamento por usuário e RLS nas tabelas expostas. |
| Arquivos dos projetos | Supabase Storage, com políticas por proprietário. |
| API e orquestração | Backend do Forge. O navegador nunca acessa chaves privilegiadas nem decide autorização. |
| Execução de código | Sandbox isolado, descartável e sem os secrets ou o `process.env` do Forge. |
| Cache e runtime | Workspace local descartável. Sua perda não pode causar perda dos dados oficiais. |
| Versionamento externo | GitHub opcional, vinculado por projeto. |
| Publicação | Cloudflare opcional, acionado explicitamente pelo usuário. |

## Limites obrigatórios

- Firebase Auth identifica a conta; Firestore não persiste dados internos do Forge.
- Supabase interno é infraestrutura do Forge. As integrações Supabase e Firebase exibidas na UI pertencem aos projetos dos usuários e usam credenciais separadas.
- A chave privilegiada do Supabase e as chaves mestras ficam somente no backend.
- Dados expostos pela Data API usam RLS e políticas de propriedade. Storage aplica o mesmo princípio aos objetos.
- Providers, modelos, integrações, repositórios e branches possuem uma única representação canônica. Campos legados só permanecem durante migração compatível.
- Propostas de alteração são imutáveis no servidor, vinculadas a uma revisão-base e avaliadas em sandbox antes da aprovação.
- O frontend aprova uma proposta pelo identificador; ele não reenvia código como fonte de verdade.
- `skipped` significa não verificado. Somente uma verificação executada e falha pode provocar rollback automático.

## Pipeline oficial de alteração

1. A IA cria uma proposta imutável no backend.
2. O backend aplica a proposta em sandbox temporário.
3. Os validadores aplicáveis são executados e o preview temporário é produzido.
4. O usuário revisa preview, diff e verificações e aprova ou rejeita.
5. Na aprovação, o backend confere a revisão-base e aplica a proposta de forma atômica.
6. O Forge cria checkpoint, persiste dados no Postgres e arquivos no Storage e atualiza o preview oficial.

## Regra de transição

SQLite, snapshots de cloud sync e filesystem podem servir temporariamente como origem de migração ou cache. Eles não são a arquitetura final. Nenhum legado será removido antes de existir migração verificável, rollback operacional e confirmação de integridade dos dados.
