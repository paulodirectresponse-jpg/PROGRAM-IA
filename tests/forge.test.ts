import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, initializeDatabase } from '../server/db/index.js';
import { WorkspaceManager } from '../server/services/workspaceManager.js';
import { LLMAdapterService } from '../server/services/llmAdapter.js';
import { GitHubService } from '../server/services/githubService.js';

describe('Forge Agent Core Engine Tests', () => {
  test('Database initialization and migrations', () => {
    initializeDatabase();
    const migration = db.prepare('SELECT version, name FROM schema_migrations WHERE version = 1').get() as any;
    assert.equal(migration.version, 1);
    assert.equal(migration.name, '001_initial_schema');

    const skillsCount = db.prepare('SELECT COUNT(*) as c FROM skills').get() as any;
    assert.ok(skillsCount.c >= 6, 'Skills mínimas devem estar populadas no banco.');

    const providersCount = db.prepare('SELECT COUNT(*) as c FROM providers').get() as any;
    assert.ok(providersCount.c >= 3, 'Provedores padrão devem estar inicializados.');
  });

  test('Workspace file operations and checkpoints', () => {
    const testProjectId = 'proj-test-' + Date.now();
    WorkspaceManager.writeFile(testProjectId, 'index.html', '<h1>Teste Forge</h1>');

    const content = WorkspaceManager.readFile(testProjectId, 'index.html');
    assert.equal(content, '<h1>Teste Forge</h1>');

    const files = WorkspaceManager.getFiles(testProjectId);
    assert.ok(files.some(f => f.path === 'index.html'));

    // Checkpoint creation and quality gates
    const cpId = WorkspaceManager.createCheckpoint(testProjectId, 'Checkpoint de Teste');
    assert.ok(cpId.startsWith('cp-'));

    // Modify file
    WorkspaceManager.writeFile(testProjectId, 'index.html', '<h1>Modificado</h1>');
    assert.equal(WorkspaceManager.readFile(testProjectId, 'index.html'), '<h1>Modificado</h1>');

    // Restore checkpoint
    const restored = WorkspaceManager.restoreCheckpoint(testProjectId, cpId);
    assert.equal(restored, true);
    assert.equal(WorkspaceManager.readFile(testProjectId, 'index.html'), '<h1>Teste Forge</h1>');
  });

  test('Quality Gate: Secret Leaks Protection', () => {
    const testProjectId = 'proj-sec-test-' + Date.now();
    WorkspaceManager.writeFile(testProjectId, 'safe.js', 'const x = 10;');
    const cpId = WorkspaceManager.createCheckpoint(testProjectId, 'Safety Check');

    const verifications = db.prepare('SELECT * FROM verifications WHERE project_id = ? AND gate_type = ?').all(testProjectId, 'security') as any[];
    assert.ok(verifications.length > 0);
    assert.equal(verifications[0].status, 'pass');
  });

  test('LLM Adapter Fallback Engine in Plan Mode', async () => {
    const fallback = LLMAdapterService.generateDemonstrativeFallback(
      'Criar uma tela de checkout com resumo',
      'plan',
      { 'index.html': '<html></html>' },
      ['ui-premium']
    );

    assert.equal(fallback.isDemonstrativeFallback, true);
    assert.equal(fallback.mode, 'plan');
    assert.ok(fallback.plan);
    assert.ok(fallback.plan.acceptance_criteria.length > 0);
  });

  test('GitHub Service transparent pending state', async () => {
    const status = await GitHubService.verifyConnection();
    // In default container environment without GITHUB_TOKEN configured
    if (!process.env.GITHUB_TOKEN) {
      assert.equal(status.isConnected, false);
      assert.equal(status.status, 'pending_credentials');
      assert.ok(status.missingConfig.includes('GITHUB_TOKEN'));
    }
  });

  test('Project lifecycle: Duplicate and ZIP export', async () => {
    const sourceId = 'proj-dup-test-' + Date.now();
    WorkspaceManager.writeFile(sourceId, 'App.tsx', 'export const App = () => <h1>Original</h1>;');
    WorkspaceManager.writeFile(sourceId, 'package.json', '{"name": "original"}');

    // Duplicate project
    const targetId = 'proj-dup-target-' + Date.now();
    const dupSuccess = WorkspaceManager.duplicateProject(sourceId, targetId, 'Cópia Teste');
    assert.equal(dupSuccess, true);

    const dupAppContent = WorkspaceManager.readFile(targetId, 'App.tsx');
    assert.equal(dupAppContent, 'export const App = () => <h1>Original</h1>;');

    // ZIP export
    const zipBuffer = await WorkspaceManager.generateZip(targetId);
    assert.ok(Buffer.isBuffer(zipBuffer));
    assert.ok(zipBuffer.length > 0);

    // Clean up
    WorkspaceManager.deleteProject(sourceId);
    WorkspaceManager.deleteProject(targetId);
  });

  test('Auto mode intent classification', () => {
    assert.equal(LLMAdapterService.classifyIntent('Como funciona o useEffect?'), 'explanation');
    assert.equal(LLMAdapterService.classifyIntent('Planeje a arquitetura do banco de dados'), 'plan');
    assert.equal(LLMAdapterService.classifyIntent('Crie um componente de botão azul e adicione no App.tsx'), 'build');
    assert.equal(LLMAdapterService.classifyIntent('Revise este código procurando por bugs'), 'review');
    assert.equal(LLMAdapterService.classifyIntent('Faça deploy ou commit para o GitHub'), 'publish');
  });
});
