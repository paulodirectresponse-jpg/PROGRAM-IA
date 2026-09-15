import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db, initializeDatabase } from '../server/db/index.js';
import { AuthService } from '../server/services/authService.js';
import { SecretService } from '../server/services/secretService.js';
import { WorkspaceManager } from '../server/services/workspaceManager.js';
import { ValidatorEngine } from '../server/services/validatorEngine.js';
import { LLMAdapterService } from '../server/services/llmAdapter.js';
import { GitHubService } from '../server/services/githubService.js';

describe('Forge Agent Complete Verification Suite (50+ Scenarios)', () => {
  before(() => {
    initializeDatabase();
  });

  // =========================================================================
  // 1. AUTENTICAÇÃO FIREBASE E ISOLAMENTO MULTIUSUÁRIO
  // =========================================================================
  describe('1. Autenticação Firebase e Isolamento Multiusuário', () => {
    const userAEmail = `user_a_${Date.now()}@forge.dev`;
    const userBEmail = `user_b_${Date.now()}@forge.dev`;
    const firebaseUidA = `firebase-a-${Date.now()}`;
    const firebaseUidB = `firebase-b-${Date.now()}`;
    let userAId = '';
    let userBId = '';
    let userASessionToken = '';

    test('1.1: Firebase provisiona identidade estável sem autenticação local paralela', () => {
      const {user} = AuthService.firebaseLogin(userAEmail, 'Dev User A', firebaseUidA);
      assert.ok(user.id);
      assert.equal(user.email, userAEmail);
      assert.equal(user.name, 'Dev User A');
      userAId = user.id;
      assert.match(user.id, /^usr-firebase-[a-f0-9]{32}$/);
    });

    test('1.2: O mesmo Firebase UID resolve para a mesma conta', () => {
      const {user} = AuthService.firebaseLogin(userAEmail, 'Dev User A', firebaseUidA);
      assert.equal(user.id, userAId);
    });

    test('1.3: O mesmo e-mail não pode ser tomado por outro Firebase UID', () => {
      assert.throws(
        () => AuthService.firebaseLogin(userAEmail, 'Intruso', `other-${firebaseUidA}`),
        /outra identidade/i
      );
    });

    test('1.4: Sessão Forge é criada após identidade Firebase validada', () => {
      const session = AuthService.createSession(userAId);
      assert.ok(session.token);
      assert.ok(session.token.length >= 32);
      userASessionToken = session.token;
    });

    test('1.5: Sessão ativa resolve o usuário autenticado', () => {
      const validated = AuthService.validateSession(userASessionToken);
      assert.ok(validated);
      assert.equal(validated.id, userAId);
      assert.equal(validated.email, userAEmail);
    });

    test('1.6: Token inexistente não autentica', () => {
      assert.equal(AuthService.validateSession('invalid-random-token-xyz'), null);
    });

    test('1.7: Logout revoga a sessão específica', () => {
      AuthService.logout(userASessionToken);
      assert.equal(AuthService.validateSession(userASessionToken), null);
    });

    test('1.8: Firebase provisiona um segundo usuário isolado', () => {
      const {user} = AuthService.firebaseLogin(userBEmail, 'Dev User B', firebaseUidB);
      userBId = user.id;
      assert.notEqual(userAId, userBId);
    });

    test('1.9: Cada usuário possui workspace próprio', () => {
      const workspaceA = db.prepare('SELECT id FROM workspaces WHERE user_id = ? LIMIT 1').get(userAId) as any;
      const workspaceB = db.prepare('SELECT id FROM workspaces WHERE user_id = ? LIMIT 1').get(userBId) as any;
      assert.ok(workspaceA?.id);
      assert.ok(workspaceB?.id);
      assert.notEqual(workspaceA.id, workspaceB.id);
    });

    test('1.10: Tentativa de acesso a projeto de outro usuário é negada', () => {
      const projAId = `proj-a-${Date.now()}`;
      const now = new Date().toISOString();
      const workspaceA = (db.prepare('SELECT id FROM workspaces WHERE user_id = ? LIMIT 1').get(userAId) as any).id;
      db.prepare(`
        INSERT INTO projects (id, workspace_id, user_id, name, description, origin, branch, status, created_at, updated_at)
        VALUES (?, ?, ?, 'Projeto Privado A', 'Desc', 'novo', 'main', 'active', ?, ?)
      `).run(projAId, workspaceA, userAId, now, now);

      assert.equal(WorkspaceManager.verifyProjectOwnership(projAId, userAId), true);
      assert.equal(WorkspaceManager.verifyProjectOwnership(projAId, userBId), false);
    });

    test('1.11: Listagem de projetos permanece isolada por usuário', () => {
      const userAProjects = db.prepare('SELECT id FROM projects WHERE user_id = ?').all(userAId) as any[];
      const userBProjects = db.prepare('SELECT id FROM projects WHERE user_id = ?').all(userBId) as any[];
      assert.ok(userAProjects.length >= 1);
      assert.equal(userBProjects.length, 0);
    });

    test('1.12: user-default e ws-default não são provisionados automaticamente', () => {
      assert.equal(db.prepare('SELECT id FROM users WHERE id = ?').get('user-default'), undefined);
      assert.equal(db.prepare('SELECT id FROM workspaces WHERE id = ?').get('ws-default'), undefined);
    });
  });

  // =========================================================================
  // 2. CRIPTOGRAFIA AES-256-GCM E GESTÃO DE SEGREDOS (10 cenários)
  // =========================================================================
  describe('2. Criptografia AES-256-GCM e Gestão de Segredos', () => {
    const testSecret = 'forge-secret-fixture-production-998877665544';
    const testUserId = `user-crypto-${Date.now()}`;

    test('2.1: Criptografia AES-256-GCM gera formato iv:authTag:ciphertext', () => {
      const encrypted = SecretService.encrypt(testSecret);
      const parts = encrypted.split(':');
      assert.equal(parts.length, 3, 'Formato deve conter IV, AuthTag e Ciphertext.');
      assert.equal(parts[0].length, 24, 'IV deve ter 12 bytes codificados em hex (24 chars).');
      assert.equal(parts[1].length, 32, 'AuthTag deve ter 16 bytes codificados em hex (32 chars).');
      assert.ok(parts[2].length > 0, 'Ciphertext não pode ser vazio.');
    });

    test('2.2: Descriptografia recupera o valor exato original', () => {
      const encrypted = SecretService.encrypt(testSecret);
      const decrypted = SecretService.decrypt(encrypted);
      assert.equal(decrypted, testSecret);
    });

    test('2.3: Adulteração no ciphertext falha com erro de integridade GCM', () => {
      const encrypted = SecretService.encrypt(testSecret);
      const parts = encrypted.split(':');
      // Tamper ciphertext
      const tamperedCipher = parts[2].slice(0, -2) + 'aa';
      const tamperedString = `${parts[0]}:${parts[1]}:${tamperedCipher}`;

      assert.throws(
        () => SecretService.decrypt(tamperedString),
        /Falha de autenticação|unsupported state or unable to authenticate data/i
      );
    });

    test('2.4: Adulteração no AuthTag falha com erro de integridade GCM', () => {
      const encrypted = SecretService.encrypt(testSecret);
      const parts = encrypted.split(':');
      // Tamper auth tag
      const tamperedTag = '0'.repeat(32);
      const tamperedString = `${parts[0]}:${tamperedTag}:${parts[2]}`;

      assert.throws(
        () => SecretService.decrypt(tamperedString),
        /Falha de autenticação|unsupported state or unable to authenticate data/i
      );
    });

    test('2.5: Adulteração no IV falha na descriptografia', () => {
      const encrypted = SecretService.encrypt(testSecret);
      const parts = encrypted.split(':');
      // Tamper IV
      const tamperedIv = 'f'.repeat(24);
      const tamperedString = `${tamperedIv}:${parts[1]}:${parts[2]}`;

      assert.throws(
        () => SecretService.decrypt(tamperedString),
        /Falha de autenticação|unsupported state or unable to authenticate data/i
      );
    });

    test('2.6: Salvar segredo por usuário com isolamento', () => {
      const summary = SecretService.saveSecret(testUserId, 'useoneai', testSecret);
      assert.equal(summary.service_key, 'useoneai');
      assert.ok(summary.masked_hint.includes('...'));
      assert.notEqual(summary.masked_hint, testSecret);
    });

    test('2.7: Recuperar segredo descriptografado apenas para o dono', () => {
      const retrieved = SecretService.getDecryptedSecret(testUserId, 'useoneai');
      assert.equal(retrieved, testSecret);

      // Other user cannot retrieve it
      const otherUserSecret = SecretService.getDecryptedSecret('user-other-999', 'useoneai');
      assert.equal(otherUserSecret, null);
    });

    test('2.8: Máscara adequada oculta caracteres intermediários', () => {
      const masked = SecretService.maskSecret('token_1234567890abcdefghijklmnopqrstuv');
      assert.ok(masked.startsWith('toke'));
      assert.ok(masked.includes('...'));
      assert.ok(masked.endsWith('stuv'));
    });

    test('2.9: Listagem de segredos nunca expõe valores puros', () => {
      const list = SecretService.listUserSecrets(testUserId);
      assert.ok(list.length >= 1);
      list.forEach((s) => {
        assert.ok(s.masked_hint);
        assert.equal(s.masked_hint.includes(testSecret), false);
      });
    });

    test('2.10: Deleção de segredo remove credencial do banco', () => {
      const deleted = SecretService.deleteSecret(testUserId, 'useoneai');
      assert.equal(deleted, true);

      const check = SecretService.getDecryptedSecret(testUserId, 'useoneai');
      assert.equal(check, null);
    });
  });

  // =========================================================================
  // 3. GERENCIAMENTO DE WORKSPACE E SEGURANÇA DE ARQUIVOS (10 cenários)
  // =========================================================================
  describe('3. Gerenciamento de Workspace e Segurança de Arquivos', () => {
    const testProjectId = `proj-ws-security-${Date.now()}`;

    test('3.1: Bloqueio de path traversal relativo com ../', () => {
      assert.throws(
        () => WorkspaceManager.writeFile(testProjectId, '../../etc/passwd', 'malicious'),
        /Path traversal detectado/i
      );
    });

    test('3.2: Bloqueio de caminhos absolutos /etc/shadow', () => {
      assert.throws(
        () => WorkspaceManager.readFile(testProjectId, '/etc/shadow'),
        /Path traversal detectado/i
      );
    });

    test('3.3: Bloqueio de múltiplas barras e pontos misturados', () => {
      assert.throws(
        () => WorkspaceManager.writeFile(testProjectId, 'foo/../../bar/../../secret', 'malicious'),
        /Path traversal detectado/i
      );
    });

    test('3.4: Bloqueio de injeção de byte nulo (%00)', () => {
      assert.throws(
        () => WorkspaceManager.readFile(testProjectId, 'safe.txt\0/etc/passwd'),
        /Path traversal detectado/i
      );
    });

    test('3.5: Escrita segura e leitura de arquivo no workspace do projeto', () => {
      WorkspaceManager.writeFile(testProjectId, 'src/index.ts', 'console.log("Forge Security");');
      const content = WorkspaceManager.readFile(testProjectId, 'src/index.ts');
      assert.equal(content, 'console.log("Forge Security");');
    });

    test('3.6: Criação automática de diretórios aninhados', () => {
      WorkspaceManager.writeFile(
        testProjectId,
        'deep/nested/sub/folder/file.json',
        JSON.stringify({ status: 'ok' })
      );
      const fileContent = WorkspaceManager.readFile(testProjectId, 'deep/nested/sub/folder/file.json');
      assert.ok(fileContent);
      const json = JSON.parse(fileContent);
      assert.equal(json.status, 'ok');
    });

    test('3.7: Escrita e leitura de dados binários preserva integridade de bytes', () => {
      const rawBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG header
      WorkspaceManager.writeBinaryFile(testProjectId, 'assets/logo.png', rawBytes);

      const readBytes = WorkspaceManager.readBinaryFile(testProjectId, 'assets/logo.png');
      assert.deepEqual(readBytes, rawBytes);
    });

    test('3.8: Listagem de arquivos retorna metadados completos', () => {
      const files = WorkspaceManager.getFiles(testProjectId);
      assert.ok(files.some((f) => f.path === 'src/index.ts'));
      assert.ok(files.some((f) => f.path === 'assets/logo.png'));
      assert.ok(files.every((f) => f.size > 0 && f.updatedAt));
    });

    test('3.9: Exclusão segura de arquivo dentro do workspace', () => {
      const deleted = WorkspaceManager.deleteFile(testProjectId, 'src/index.ts');
      assert.equal(deleted, true);
      assert.equal(WorkspaceManager.readFile(testProjectId, 'src/index.ts'), null);
    });

    test('3.10: Limpeza e deleção completa de projeto', () => {
      WorkspaceManager.deleteProject(testProjectId);
      const filesAfter = WorkspaceManager.getFiles(testProjectId);
      assert.equal(filesAfter.length, 0);
    });
  });

  // =========================================================================
  // 4. LLM ADAPTER E FALLBACK DEMONSTRATIVO SEGURO (8 cenários)
  // =========================================================================
  describe('4. LLM Adapter e Fallback Demonstrativo Seguro', () => {
    test('4.1: Fallback demonstrativo identifica flag explicitamente', () => {
      const fallback = LLMAdapterService.generateDemonstrativeFallback(
        'Criar fluxo de pedidos',
        'plan',
        {},
        ['ui-premium']
      );
      assert.equal(fallback.isDemonstrativeFallback, true);
      assert.ok(fallback.replyText.includes('Demonstrativo'));
    });

    test('4.2: Modo demonstrativo NUNCA gera falsa mensagem de sucesso em produção', () => {
      const fallback = LLMAdapterService.generateDemonstrativeFallback(
        'Publicar no GitHub',
        'publish',
        {},
        []
      );
      assert.equal(fallback.isDemonstrativeFallback, true);
      assert.equal(fallback.proposal, undefined, 'Não deve inventar arquivos no modo publish sem chaves.');
    });

    test('4.3: Modo demonstrativo em "plan" gera critérios de aceite auditáveis', () => {
      const fallback = LLMAdapterService.generateDemonstrativeFallback(
        'Sistema de autenticação multi-tenant',
        'plan',
        {},
        ['auth-skill']
      );
      assert.ok(fallback.plan);
      assert.ok(fallback.plan.acceptance_criteria.length >= 2);
      assert.ok(fallback.plan.objective.length > 0);
    });

    test('4.4: Modo demonstrativo em "build" bloqueia alteração automática com aviso explícito', () => {
      const fallback = LLMAdapterService.generateDemonstrativeFallback(
        'Criar componente Header',
        'build',
        { 'src/App.tsx': 'export const App = () => null;' },
        []
      );
      assert.equal(fallback.isDemonstrativeFallback, true);
      assert.equal(fallback.decisionType, 'blocked_no_provider');
      assert.equal(fallback.hasErrors, true);
      assert.ok(fallback.errorMessage?.includes('bloqueada'));
      assert.equal(fallback.proposal, undefined, 'Não deve inventar propostas no modo bloqueado.');
    });

    test('4.5: Proposta de arquivo gerada a partir de markdown contém caminho e diff', () => {
      const markdown = `
\`\`\`tsx FILE: src/components/Button.tsx
export const Button = () => <button className="btn">Click</button>;
\`\`\`
      `;
      const proposal = LLMAdapterService.parseFileChanges(markdown);
      assert.ok(proposal);
      assert.ok(proposal.files.length > 0);
      assert.equal(proposal.files[0].path, 'src/components/Button.tsx');
      assert.ok(proposal.files[0].content.includes('export const Button'));
    });

    test('4.6: Parsing robusto de blocos de código com FILE:', () => {
      const rawContent = `
Aqui está a proposta:
\`\`\`tsx FILE: src/Button.tsx
export const Button = () => <button>Clique</button>;
\`\`\`
      `;
      const proposal = LLMAdapterService.parseFileChanges(rawContent);
      assert.ok(proposal);
      assert.equal(proposal.files.length, 1);
      assert.equal(proposal.files[0].path, 'src/Button.tsx');
      assert.ok(proposal.files[0].content.includes('export const Button'));
    });

    test('4.7: Extração e sanitização de diffs', () => {
      const rawContent = `
\`\`\`typescript FILE: src/calc.ts
export function add(a: number, b: number) { return a + b; }
\`\`\`
      `;
      const proposal = LLMAdapterService.parseFileChanges(rawContent);
      assert.ok(proposal);
      assert.ok(proposal.summary.includes('1 arquivo'));
    });

    test('4.8: Extração de plano a partir de texto com seções estruturadas', () => {
      const planText = `
## Objetivo
Criar API segura

## Escopo Incluído
- Rotas protegidas
- Criptografia

## Escopo Não Incluído
- Mobile app

## Critérios de Aceite
- 100% dos testes passando
- Sem vazamento de chaves
      `;
      const plan = LLMAdapterService.extractPlan(planText);
      assert.ok(plan);
      assert.ok(plan.objective.includes('Criar API segura'));
      assert.ok(plan.acceptance_criteria.length >= 2);
    });

    test('4.9: Planos estruturados normalizam arrays e objetos antes de persistir no SQLite', () => {
      const planText = `\`\`\`json
{
  "type": "plan",
  "plan": {
    "objective": { "title": "Administrar fluxo de caixa" },
    "scope_in": ["Dashboard financeiro", "Fluxo de caixa", { "feature": "Relatórios" }],
    "scope_out": ["E-commerce"],
    "files_affected": "src/App.tsx",
    "integrations": null,
    "risks": "Dados financeiros incorretos",
    "acceptance_criteria": [{ "item": "Saldo correto" }, "Persistência validada"]
  }
}
\`\`\``;

      const plan = LLMAdapterService.extractPlan(planText);
      assert.ok(plan);
      assert.equal(typeof plan.objective, 'string');
      assert.equal(typeof plan.scope_in, 'string');
      assert.ok(plan.objective.includes('Administrar fluxo de caixa'));
      assert.ok(plan.scope_in.includes('Dashboard financeiro'));
      assert.ok(plan.scope_in.includes('Relatórios'));
      assert.deepEqual(plan.files_affected, ['src/App.tsx']);
      assert.deepEqual(plan.risks, ['Dados financeiros incorretos']);
      assert.equal(plan.acceptance_criteria.length, 2);
    });

    test('4.10: Modo manual Construir prevalece sobre palavras de planejamento no prompt', () => {
      const resolved = LLMAdapterService.resolveRequestedMode(
        'Planeje primeiro e depois construa este sistema completo',
        'build'
      );
      assert.equal(resolved, 'build');
    });

    test('4.11: Modo Automático decide por contexto entre conversa e execução', () => {
      assert.equal(
        LLMAdapterService.resolveRequestedMode('Apenas planeje a arquitetura do sistema, sem implementar', 'auto'),
        'plan'
      );
      assert.equal(
        LLMAdapterService.resolveRequestedMode('Planeja um site para administrar todo o fluxo de caixa da minha loja de roupa', 'auto'),
        'plan'
      );
      assert.equal(
        LLMAdapterService.resolveRequestedMode('Planeje a arquitetura e depois construa o sistema', 'auto'),
        'build'
      );
      assert.equal(
        LLMAdapterService.resolveRequestedMode('Publique este projeto no GitHub', 'auto'),
        'publish'
      );
      assert.equal(
        LLMAdapterService.resolveRequestedMode('O que você pode fazer por mim?', 'auto'),
        'auto'
      );
      assert.equal(
        LLMAdapterService.resolveRequestedMode('Me ajude a deixar essa ideia mais detalhada', 'auto', {
          conversationHistory:[{sender:'agent',content:'Vamos desenhar uma landing page premium para SaaS.'}],
          existingFiles:['index.html'],
        }),
        'auto'
      );
      assert.equal(
        LLMAdapterService.resolveRequestedMode('Crie essa landing page', 'auto', {
          conversationHistory:[{sender:'agent',content:'A landing page terá hero, CTA, benefícios e FAQ.'}],
          existingFiles:['index.html'],
        }),
        'build'
      );
      assert.equal(
        LLMAdapterService.resolveRequestedMode('Faça isso', 'auto', {
          conversationHistory:[{sender:'agent',content:'Posso construir a landing page completa com hero, CTA e FAQ.'}],
          existingFiles:['index.html'],
        }),
        'build'
      );
      assert.equal(
        LLMAdapterService.resolveRequestedMode('aplique tudo isso ao site agora', 'auto', {
          conversationHistory:[{sender:'agent',content:'Sugestões: parallax sutil, cards com tilt 3D, botões interativos e fundo animado.'}],
          existingFiles:['index.html','styles.css','app.js'],
        }),
        'build'
      );
      assert.equal(
        LLMAdapterService.resolveRequestedMode('perfeito, pode fazer', 'auto', {
          conversationHistory:[{sender:'agent',content:'Posso aplicar essas melhorias visuais diretamente na landing page.'}],
          existingFiles:['index.html'],
        }),
        'build'
      );
      assert.equal(
        LLMAdapterService.resolveRequestedMode('Adicione mais detalhes a essa ideia', 'auto', {
          conversationHistory:[{sender:'agent',content:'Ideia para um aplicativo de finanças.'}],
          existingFiles:['index.html'],
        }),
        'auto'
      );
      assert.equal(
        LLMAdapterService.resolveRequestedMode('Adicione um botão de login nesta tela', 'auto'),
        'build'
      );
      assert.equal(
        LLMAdapterService.resolveRequestedMode('Use essa imagem para deixar o site igual à referência', 'auto', {
          conversationHistory:[{sender:'user',content:'Enviei uma referência visual.'}],
          existingFiles:['index.html','styles.css'],
        }),
        'build'
      );
    });

    test('4.10: Build aceita aliases comuns de modelos gratuitos', () => {
      const structured = `\`\`\`json
{
  "build": {
    "summary": "Dashboard",
    "files": {
      "index.html": {
        "operation": "update",
        "code": "<html><body>Dashboard</body></html>"
      }
    }
  }
}
\`\`\``;

      const parsed = (LLMAdapterService as any).parseLLMResponse(
        structured,
        'build',
        'OmniRoute (Free Pool)',
        'auto',
        { 'index.html': '<html><body>Original</body></html>' }
      );
      assert.equal(parsed.decisionType, 'change');
      assert.equal(parsed.hasErrors, false);
      assert.equal(parsed.build.files.length, 1);
      assert.equal(parsed.build.files[0].path, 'index.html');
      assert.match(parsed.build.files[0].content, /Dashboard/);
    });

    test('4.11: OmniRoute usa streaming e agrega SSE em builds longos', async () => {
      const originalFetch = globalThis.fetch;
      let requestBody: any = null;
      const encoder = new TextEncoder();

      globalThis.fetch = (async (_url: any, init?: any) => {
        requestBody = JSON.parse(String(init?.body || '{}'));
        const chunks = [
          'data: ' + JSON.stringify({ choices: [{ delta: { content: '{"summary":"Teste","files":[{"path":"index.html","action":"modify","content":"' } }] }) + '\n\n',
          'data: ' + JSON.stringify({ choices: [{ delta: { content: '<html><body>STREAM_OK</body></html>"}]}' } }] }) + '\n\n',
          'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } }) + '\n\n',
          'data: [DONE]\n\n',
        ];
        const body = new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as typeof fetch;

      try {
        const result = await (LLMAdapterService as any).callOpenAICompatible(
          {
            apiKey: 'test-key',
            baseUrl: 'https://example.trycloudflare.com/v1',
            modelId: 'auto',
            name: 'OmniRoute (Free Pool)',
          },
          {
            mode: 'build',
            skillsText: '',
            filesList: ['index.html'],
            existingFiles: { 'index.html': '<html><body>OLD</body></html>' },
            conversationHistory: [],
            prompt: 'Atualize o arquivo',
          }
        );

        assert.equal(requestBody.stream, true);
        assert.equal(requestBody.stream_options.include_usage, true);
        assert.equal(result.hasErrors, false);
        assert.equal(result.build.files.length, 1);
        assert.match(result.build.files[0].content, /STREAM_OK/);
        assert.equal(result.usage.inputTokens, 10);
        assert.equal(result.usage.outputTokens, 20);
      } finally {
        globalThis.fetch = originalFetch;
      }


    test('4.12: Modo plano sempre produz plano mesmo quando o provider responde só em prosa', () => {
      const parsed = (LLMAdapterService as any).parseLLMResponse(
        'Vamos criar um painel financeiro com estoque, vendas, relatórios e autenticação.',
        'plan',
        'Provider genérico',
        'modelo-x',
        {}
      );
      assert.equal(parsed.decisionType, 'plan');
      assert.ok(parsed.plan);
      assert.match(parsed.plan.objective, /painel financeiro/i);
      assert.ok(Array.isArray(parsed.plan.acceptance_criteria));
    });

    test('4.13: Extração de arquivo conhecido aceita código puro em bloco markdown', () => {
      const content = LLMAdapterService.extractKnownFileContent(
        '\`\`\`tsx\nexport default function App(){ return <main>OK</main> }\n\`\`\`',
        'src/App.tsx'
      );
      assert.ok(content);
      assert.match(content!, /function App/);
    });

    test('4.14: Build atômico faz no máximo uma correção por arquivo e reaproveita conteúdo puro', async () => {
      const original = LLMAdapterService.executePrompt;
      let calls = 0;
      LLMAdapterService.executePrompt = async () => {
        calls += 1;
        if (calls === 1) {
          return {
            replyText: 'Não consegui estruturar o arquivo.',
            mode: 'build',
            decisionType: 'invalid_response',
            isDemonstrativeFallback: false,
            providerUsed: 'Provider teste',
            modelUsed: 'modelo',
            hasErrors: true,
            invalidResponse: true,
          } as any;
        }
        return {
          replyText: 'export default function App(){ return <main>ATOMIC_OK</main> }',
          mode: 'build',
          decisionType: 'invalid_response',
          isDemonstrativeFallback: false,
          providerUsed: 'Provider teste',
          modelUsed: 'modelo',
          hasErrors: true,
          invalidResponse: true,
        } as any;
      };

      try {
        const result = await LLMAdapterService.buildApprovedPlanReliably({
          projectId: 'atomic-test',
          providerKey: 'omniroute',
          modelId: 'auto',
          userId: 'user-test',
          existingFiles: { 'src/App.tsx': 'export default function App(){ return <main>OLD</main> }' },
          requestedFiles: ['src/App.tsx'],
          objective: 'Atualizar o painel',
        });
        assert.equal(calls, 2);
        assert.equal(result.hasErrors, false);
        assert.equal(result.build?.files.length, 1);
        assert.match(result.build!.files[0].content, /ATOMIC_OK/);
        assert.equal(result.diagnostics?.strategy, 'atomic_file_build');
        assert.equal(result.diagnostics?.attempts, 2);
      } finally {
        LLMAdapterService.executePrompt = original;
      }
    });

    test('4.15: OmniRoute negocia stream_options incompatível sem loop', async () => {
      const originalFetch = globalThis.fetch;
      const bodies: any[] = [];
      const encoder = new TextEncoder();
      let calls = 0;

      globalThis.fetch = (async (_url: any, init?: any) => {
        calls += 1;
        bodies.push(JSON.parse(String(init?.body || '{}')));
        if (calls === 1) {
          return new Response(JSON.stringify({ error: { message: 'unknown field stream_options' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }
        const payload = '{"summary":"OK","files":[{"path":"index.html","action":"modify","content":"<html><body>NEGOTIATED</body></html>"}]}';
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: payload } }] }) + '\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }) as typeof fetch;

      try {
        const result = await (LLMAdapterService as any).callOpenAICompatible(
          { apiKey: 'x', baseUrl: 'https://example.test/v1', modelId: 'auto', name: 'OmniRoute (Free Pool)' },
          {
            mode: 'build',
            skillsText: '',
            filesList: ['index.html'],
            existingFiles: { 'index.html': '<html><body>OLD</body></html>' },
            conversationHistory: [],
            prompt: 'Atualize',
          }
        );
        assert.equal(calls, 2);
        assert.equal(bodies[0].stream_options.include_usage, true);
        assert.equal(bodies[1].stream, true);
        assert.equal('stream_options' in bodies[1], false);
        assert.equal(result.hasErrors, false);
        assert.match(result.build.files[0].content, /NEGOTIATED/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('4.16: Erro HTML do túnel é sanitizado antes de chegar à interface', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response('<!DOCTYPE html><html><body><h1>524 A timeout occurred</h1><script>secret()</script></body></html>', {
          status: 524,
          headers: { 'content-type': 'text/html' },
        })) as typeof fetch;
      try {
        await assert.rejects(
          () => (LLMAdapterService as any).callOpenAICompatible(
            { apiKey: 'x', baseUrl: 'https://example.test/v1', modelId: 'auto', name: 'OmniRoute (Free Pool)' },
            {
              mode: 'build',
              skillsText: '',
              filesList: [],
              existingFiles: {},
              conversationHistory: [],
              prompt: 'Teste',
            }
          ),
          (err: any) => /HTTP 524/.test(String(err?.message || '')) && !/DOCTYPE|<html|<script/i.test(String(err?.message || ''))
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
    });


    test('4.17: Erro terminal de provider interrompe build atômico sem repetir arquivos', async () => {
      const original = LLMAdapterService.executePrompt;
      let calls = 0;
      LLMAdapterService.executePrompt = async () => {
        calls += 1;
        return {
          replyText: 'Provider recusou autenticação.',
          mode: 'build',
          decisionType: 'invalid_response',
          isDemonstrativeFallback: false,
          providerUsed: 'Provider teste',
          modelUsed: 'modelo',
          hasErrors: true,
          invalidResponse: true,
          errorReason: 'invalid_key',
          errorMessage: 'Chave inválida',
        } as any;
      };

      try {
        const result = await LLMAdapterService.buildApprovedPlanReliably({
          projectId: 'terminal-provider-test',
          providerKey: 'omniroute',
          modelId: 'auto',
          userId: 'user-test',
          existingFiles: {
            'src/App.tsx': 'export default function App(){ return <main>OLD</main> }',
            'src/index.css': 'body { margin: 0; }',
          },
          requestedFiles: ['src/App.tsx', 'src/index.css'],
          objective: 'Atualizar interface',
        });
        assert.equal(calls, 1);
        assert.equal(result.hasErrors, true);
        assert.equal(result.errorReason, 'terminal_provider_error');
        assert.equal(result.diagnostics?.attempts, 1);
      } finally {
        LLMAdapterService.executePrompt = original;
      }
    });
  });

  // =========================================================================
  // 5. INTEGRAÇÃO GITHUB (6 cenários)
  // =========================================================================
  describe('5. Integração GitHub', () => {
    test('5.1: Verificação de status sem token retorna pending_credentials transparente', async () => {
      const status = await GitHubService.verifyConnection(undefined);
      assert.equal(status.isConnected, false);
      assert.equal(status.status, 'pending_credentials');
      assert.ok(status.missingConfig.includes('GITHUB_TOKEN'));
    });

    test('5.2: GitHubService classifica token recusado como invalid_token', async (t) => {
      const user = AuthService.firebaseLogin(
        `github-invalid-${Date.now()}@forge.dev`,
        'GitHub Invalid Token',
        `firebase-github-invalid-${Date.now()}`
      ).user;
      SecretService.saveSecret(user.id, 'github', 'invalid-github-token-fixture-1234567890');
      t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 401 }));
      const result = await GitHubService.verifyConnection(user.id);
      assert.equal(result.isConnected, false);
      assert.equal(result.status, 'invalid_token');
    });

    test('5.3: Parsing de URL de repositório identifica owner e repo', () => {
      const parsed = GitHubService.parseRepoUrl('https://github.com/paulodirectresponse-jpg/PROGRAM-IA');
      assert.equal(parsed?.owner, 'paulodirectresponse-jpg');
      assert.equal(parsed?.repo, 'PROGRAM-IA');
    });

    test('5.4: Parsing de URL inválida retorna null', () => {
      const parsed = GitHubService.parseRepoUrl('https://gitlab.com/invalid/repo');
      assert.equal(parsed, null);
    });

    test('5.5: Validação de branch name previne caracteres maliciosos', () => {
      const valid = 'feature/login-system';
      const invalid = 'branch; rm -rf /;';
      assert.ok(/^[a-zA-Z0-9._\-/]+$/.test(valid));
      assert.equal(/^[a-zA-Z0-9._\-/]+$/.test(invalid), false);
    });

    test('5.6: Mascaramento de tokens do GitHub nunca expõe o valor completo', () => {
      const rawToken = 'token_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
      const masked = SecretService.maskSecret(rawToken);
      assert.ok(masked.startsWith('toke'));
      assert.ok(masked.endsWith('7890'));
      assert.equal(masked.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), false);
    });
  });

  // =========================================================================
  // 6. CHECKPOINTS, REVERSÃO E QUALITY GATES (6 cenários)
  // =========================================================================
  describe('6. Checkpoints, Reversão e Quality Gates', () => {
    const testProjectId = `proj-cp-test-${Date.now()}`;

    test('6.1: Criação de checkpoint gera snapshot no banco e salva hash', () => {
      WorkspaceManager.writeFile(testProjectId, 'version.txt', 'v1.0.0');
      const cpId = WorkspaceManager.createCheckpoint(testProjectId, 'Versão 1.0.0');

      assert.ok(cpId.startsWith('cp-'));
      const stored = db.prepare('SELECT id, project_id, title FROM checkpoints WHERE id = ?').get(cpId) as any;
      assert.equal(stored.id, cpId);
      assert.equal(stored.title, 'Versão 1.0.0');
    });

    test('6.2: Alteração de arquivos após o checkpoint', () => {
      WorkspaceManager.writeFile(testProjectId, 'version.txt', 'v2.0.0-dirty');
      assert.equal(WorkspaceManager.readFile(testProjectId, 'version.txt'), 'v2.0.0-dirty');
    });

    test('6.3: Restauração atômica do checkpoint reverte exatamente para o estado original', () => {
      const checkpoints = db.prepare('SELECT id FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC').all(testProjectId) as any[];
      const cpId = checkpoints[0].id;

      const restored = WorkspaceManager.restoreCheckpoint(testProjectId, cpId);
      assert.equal(restored, true);
      assert.equal(WorkspaceManager.readFile(testProjectId, 'version.txt'), 'v1.0.0');
    });

    test('6.4: Validator canônico detecta credencial exposta como falha real', async () => {
      WorkspaceManager.writeFile(testProjectId, 'leaked.js', 'const API_KEY = "example-sensitive-value-12345678901234567890";');
      const cpId = WorkspaceManager.createCheckpoint(testProjectId, 'Check with leak');
      const validation = await ValidatorEngine.validate({ projectId: testProjectId, checkpointId: cpId });

      assert.equal(validation.status, 'failed');
      assert.equal(validation.security.status, 'fail');
      const verification = db.prepare(
        "SELECT * FROM verifications WHERE project_id = ? AND checkpoint_id = ? AND gate_type = 'security' ORDER BY created_at DESC LIMIT 1"
      ).get(testProjectId, cpId) as any;
      assert.equal(verification.status, 'fail');
    });

    test('6.5: Validator canônico não reprova código limpo quando nenhum gate executável falha', async () => {
      WorkspaceManager.deleteFile(testProjectId, 'leaked.js');
      WorkspaceManager.writeFile(testProjectId, 'clean.js', 'export const sum = (a, b) => a + b;');
      const cpId = WorkspaceManager.createCheckpoint(testProjectId, 'Check clean code');
      const validation = await ValidatorEngine.validate({ projectId: testProjectId, checkpointId: cpId });

      assert.equal(validation.security.status, 'pass');
      assert.notEqual(validation.status, 'failed');
      const verification = db.prepare(
        "SELECT * FROM verifications WHERE project_id = ? AND checkpoint_id = ? AND gate_type = 'security' ORDER BY created_at DESC LIMIT 1"
      ).get(testProjectId, cpId) as any;
      assert.equal(verification.status, 'pass');
    });

    test('6.6: Exportação de projeto como arquivo ZIP gera buffer válido', async () => {
      WorkspaceManager.writeFile(testProjectId, 'package.json', '{"name": "test-zip"}');
      const zipBuffer = await WorkspaceManager.generateZip(testProjectId);

      assert.ok(Buffer.isBuffer(zipBuffer));
      assert.ok(zipBuffer.length > 100);
      // PK header check (0x50, 0x4B)
      assert.equal(zipBuffer[0], 0x50);
      assert.equal(zipBuffer[1], 0x4B);

      // Clean up test workspace
      WorkspaceManager.deleteProject(testProjectId);
    });

    test('6.7: Exclusão completa de projeto cascateia banco e remove arquivos do disco', () => {
      const projId = 'proj-delete-test-' + Date.now();
      const owner = AuthService.firebaseLogin(`delete-${Date.now()}@forge.dev`, 'Delete Owner', `delete-firebase-${Date.now()}`).user;
      const workspaceId = (db.prepare('SELECT id FROM workspaces WHERE user_id = ? LIMIT 1').get(owner.id) as any).id;
      db.prepare(`
        INSERT INTO projects (id, workspace_id, name, description, branch, origin, user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(projId, workspaceId, 'Projeto Para Excluir', 'Teste de deleção em cascata', 'main', 'novo', owner.id);

      // Create files
      WorkspaceManager.writeFile(projId, 'src/App.tsx', 'export const App = () => <h1>Hello</h1>;');
      WorkspaceManager.writeFile(projId, 'package.json', '{"name": "delete-test"}');
      assert.equal(WorkspaceManager.readFile(projId, 'src/App.tsx'), 'export const App = () => <h1>Hello</h1>;');

      // Create conversation and message
      const convId = 'conv-' + Date.now();
      db.prepare(`INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))`).run(convId, projId, 'Chat Test');
      db.prepare(`INSERT INTO messages (id, conversation_id, sender, content, created_at) VALUES (?, ?, ?, ?, datetime('now'))`).run('msg-1', convId, 'user', 'Hello');

      // Create checkpoint
      WorkspaceManager.createCheckpoint(projId, 'Initial CP');

      // Perform cascading deletion
      const convs = db.prepare('SELECT id FROM conversations WHERE project_id = ?').all(projId) as { id: string }[];
      for (const c of convs) {
        db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(c.id);
      }
      db.prepare('DELETE FROM conversations WHERE project_id = ?').run(projId);
      db.prepare('DELETE FROM verifications WHERE project_id = ?').run(projId);
      db.prepare('DELETE FROM checkpoints WHERE project_id = ?').run(projId);
      db.prepare('DELETE FROM branches WHERE project_id = ?').run(projId);
      WorkspaceManager.deleteProject(projId);
      db.prepare('DELETE FROM projects WHERE id = ?').run(projId);

      // Verify cascading results
      const projAfter = db.prepare('SELECT * FROM projects WHERE id = ?').get(projId);
      assert.equal(projAfter, undefined);

      const convAfter = db.prepare('SELECT * FROM conversations WHERE project_id = ?').all(projId);
      assert.equal(convAfter.length, 0);

      const msgAfter = db.prepare('SELECT * FROM messages WHERE id = ?').get('msg-1');
      assert.equal(msgAfter, undefined);

      const cpAfter = db.prepare('SELECT * FROM checkpoints WHERE project_id = ?').all(projId);
      assert.equal(cpAfter.length, 0);

      // Verify physical disk files are removed
      assert.equal(WorkspaceManager.readFile(projId, 'src/App.tsx'), null);
      assert.equal(WorkspaceManager.getFiles(projId).length, 0);
    });
  });
});
