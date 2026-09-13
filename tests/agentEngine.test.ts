import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase, db } from '../server/db/index.js';
import { AgentEngine } from '../server/agent-engine/agentEngine.js';
import { RunService } from '../server/services/runService.js';
import { ModelRouter } from '../server/services/modelRouter.js';

initializeDatabase();

test('agent profile without configured candidates stays blocked instead of escaping to active provider', async (t) => {
  let networkCalled = false;
  t.mock.method(globalThis, 'fetch', async () => {
    networkCalled = true;
    return new Response('{}', { status: 200 });
  });

  const result = await AgentEngine.execute({
    prompt: 'Crie um componente simples',
    mode: 'build',
    projectId: 'agent-test-project-no-candidate',
    existingFiles: {},
    appliedSkills: [],
    conversationHistory: [],
    userId: 'agent-test-user-no-candidate',
    runId: 'agent-test-run-no-candidate',
    stepId: 'agent-test-step-no-candidate',
  });

  assert.equal(result.decisionType, 'blocked_no_provider');
  assert.equal(result.isDemonstrativeFallback, true);
  assert.equal(networkCalled, false);
});

test('agent run persists selected agent, attempts and accumulated spend', () => {
  const unique = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const userId = `agent-test-user-${unique}`;
  const projectId = `agent-test-project-${unique}`;
  const conversationId = `agent-test-conv-${unique}`;

  const { runId, stepId } = RunService.start(userId, projectId, conversationId, 'build', 0.5);

  try {
    RunService.assignAgent(stepId, 'FORGE');
    RunService.recordAttempt(stepId);
    RunService.recordAttempt(stepId);

    ModelRouter.recordInvocation({
      userId,
      projectId,
      runId,
      stepId,
      agentKey: 'FORGE',
      profileKey: 'EXPERT_PAID',
      providerKey: 'test-provider',
      modelId: 'test-model',
      costUsd: 0.12,
      latencyMs: 25,
      status: 'success',
    });

    const step = db.prepare('SELECT agent_key,attempt_count FROM agent_steps WHERE id=?').get(stepId) as any;
    const run = db.prepare('SELECT spent_usd FROM agent_runs WHERE id=?').get(runId) as any;

    assert.equal(step.agent_key, 'FORGE');
    assert.equal(step.attempt_count, 2);
    assert.equal(Number(run.spent_usd), 0.12);
  } finally {
    db.prepare('DELETE FROM model_invocations WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM agent_steps WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM agent_runs WHERE id=?').run(runId);
  }
});
