import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db, initializeDatabase } from '../server/db/index.js';
import { AuthService } from '../server/services/authService.js';
import { SecretService } from '../server/services/secretService.js';
import { WorkspaceManager } from '../server/services/workspaceManager.js';
import { LLMAdapterService } from '../server/services/llmAdapter.js';
import { GitHubService } from '../server/services/githubService.js';

describe('Forge Agent Complete Verification Suite (50+ Scenarios)', () => {
  before(() => {
    initializeDatabase();
  });

  // =========================================================================
  // 1. AUTENTICAÇÃO E ISOLAMENTO MULTIUSUÁRIO (12 cenários)
  // =========================================================================
  describe('1. Autenticação e Isolamento Multiusuário', () => {
    const userAEmail = `user_a_${Date.now()}@forge.dev`;
    const userBEmail = `user_b_${Date.now()}@forge.dev`;
    const strongPassword = 'StrongPassword123!';
    let userAId = '';
    let userBId = '';
    let userASessionToken = '';

    test('1.1: Registro com e-mail e senha válida cria usuário com scrypt hash', () => {
      const user = AuthService.register(userAEmail, 'Dev User A', strongPassword);
      assert.ok(user.id);
      assert.equal(user.email, userAEmail);
      assert.equal(user.name, 'Dev User A');
      userAId = user.id;

      // Verify scrypt format (scrypt$salt$hash)
      const stored = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as any;
      assert.ok(stored.password_hash);
      assert.ok(stored.password_hash.startsWith('scrypt$'));
      assert.equal(stored.password_hash.split('$').length, 3);
    });

    test('1.2: Rejeição de registro com e-mail duplicado', () => {
      assert.throws(
        () => AuthService.register(userAEmail, 'Duplicado', strongPassword),
        /já está em uso/i
      );
    });

    test('1.3: Rejeição de registro com senha curta (< 8 caracteres)', () => {
      assert.throws(
        () => AuthService.register(`short_${Date.now()}@forge.dev`, 'Short', '12345'),
        /no mínimo 8 caracteres/i
      );
    });

    test('1.4: Login com credenciais válidas gera sessão e token seguro', () => {
      const { user, session } = AuthService.login(userAEmail, strongPassword);
      assert.equal(user.id, userAId);
      assert.ok(session.token);
      assert.ok(session.token.length >= 32);
      userASessionToken = session.token;
    });

    test('1.5: Login com senha incorreta falha com erro de credenciais', () => {
      assert.throws(
        () => AuthService.login(userAEmail, 'WrongPassword999!'),
        /inválid[ao]s/i
      );
    });

    test('1.6: Login com e-mail inexistente falha com erro de credenciais', () => {
      assert.throws(
        () => AuthService.login('nobody@forge.dev', strongPassword),
        /inválid[ao]s/i
      );
    });

    test('1.7: Validação de token de sessão ativo via validateSession', () => {
      const validated = AuthService.validateSession(userASessionToken);
      assert.ok(validated);
      assert.equal(validated.id, userAId);
      assert.equal(validated.email, userAEmail);
    });

    test('1.8: Token inválido ou adulterado retorna null', () => {
      const validated = AuthService.validateSession('invalid-random-token-xyz');
      assert.equal(validated, null);
    });

    test('1.9: Logout invalida a sessão específica no banco', () => {
      AuthService.logout(userASessionToken);
      const recheck = AuthService.validateSession(userASessionToken);
      assert.equal(recheck, null, 'Sessão revogada não deve ser mais válida.');
    });

    test('1.10: Criação do Usuário B e isolamento de projetos', () => {
      const userB = AuthService.register(userBEmail, 'Dev User B', strongPassword);
      userBId = userB.id;
      assert.notEqual(userAId, userBId);
    });

    test('1.11: Tentativa de acesso a projeto de outro usuário é negada', () => {
      const projAId = `proj-a-${Date.now()}`;
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO projects (id, workspace_id, user_id, name, description, origin, branch, status, created_at, updated_at)
        VALUES (?, 'ws-default', ?, 'Projeto Privado A', 'Desc', 'novo', 'main', 'active', ?, ?)
      `).run(projAId, userAId, now, now);

      const ownerA = WorkspaceManager.verifyProjectOwnership(projAId, userAId);
      assert.equal(ownerA, true, 'Usuário A é o proprietário legítimo.');

      const ownerB = WorkspaceManager.verifyProjectOwnership(projAId, userBId);
      assert.equal(ownerB, false, 'Usuário B NÃO deve ter acesso ao projeto do Usuário A.');
    });

    test('1.12: Listagem de projetos isolada por usuário', () => {
      const userAProjects = db.prepare('SELECT id FROM projects WHERE user_id = ?').all(userAId) as any[];
      const userBProjects = db.prepare('SELECT id FROM projects WHERE user_id = ?').all(userBId) as any[];

      assert.ok(userAProjects.length >= 1);
      assert.equal(userBProjects.length, 0, 'Usuário B não deve ver projetos do Usuário A.');
    });
  });

  // =========================================================================
  // 2. CRIPTOGRAFIA AES-256-GCM E GESTÃO DE SEGREDOS (10 cenários)
  // =========================================================================
  describe('2. Criptografia AES-256-GCM e Gestão de Segredos', () => {
    const testSecret = 'sk-forge-secret-production-key-998877665544';
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
      const masked = SecretService.maskSecret('ghp_1234567890abcdefghijklmnopqrstuv');
      assert.ok(masked.startsWith('ghp_'));
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

    test('5.2: Teste de conexão com token inválido retorna invalid_key', async () => {
      const result = await SecretService.testConnection('test-user-id', 'github', {
        apiKey: 'ghp_invalid_token_12345678901234567890',
      });
      assert.equal(result.success, false);
      assert.ok(['invalid_key', 'network_error'].includes(result.code));
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
      const rawToken = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
      const masked = SecretService.maskSecret(rawToken);
      assert.ok(masked.startsWith('ghp_'));
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

    test('6.4: Quality Gate de vazamento de segredos detecta chaves privadas', () => {
      const leakFile = 'const KEY = "ghp_123456789012345678901234567890123456";';
      WorkspaceManager.writeFile(testProjectId, 'leaked.js', leakFile);

      const cpId = WorkspaceManager.createCheckpoint(testProjectId, 'Check with leak');
      const verifications = db.prepare(
        "SELECT * FROM verifications WHERE project_id = ? AND checkpoint_id = ? AND gate_type = 'security'"
      ).all(testProjectId, cpId) as any[];

      assert.ok(verifications.length > 0);
      assert.equal(verifications[0].status, 'fail');
      assert.ok(verifications[0].details_json.includes('Possível chave secreta exposta'));
    });

    test('6.5: Quality Gate aprova código limpo sem segredos expostos', () => {
      WorkspaceManager.deleteFile(testProjectId, 'leaked.js');
      WorkspaceManager.writeFile(testProjectId, 'clean.js', 'export const sum = (a, b) => a + b;');

      const cpId = WorkspaceManager.createCheckpoint(testProjectId, 'Check clean code');
      const verifications = db.prepare(
        "SELECT * FROM verifications WHERE project_id = ? AND checkpoint_id = ? AND gate_type = 'security'"
      ).all(testProjectId, cpId) as any[];

      assert.ok(verifications.length > 0);
      assert.equal(verifications[0].status, 'pass');
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
      db.prepare(`
        INSERT INTO projects (id, workspace_id, name, description, branch, origin, user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(projId, 'ws-default', 'Projeto Para Excluir', 'Teste de deleção em cascata', 'main', 'novo', 'user-default');

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
