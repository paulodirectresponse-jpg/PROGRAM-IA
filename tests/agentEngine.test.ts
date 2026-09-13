import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase, db } from '../server/db/index.js';
import { AgentEngine, AgentWorkflowEngine } from '../server/agent-engine/agentEngine.js';
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


test('agent workflow persists SCOUT, STUDIO, FORGE and validation handoff for visual work', async () => {
  const unique = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const userId = `agent-flow-user-${unique}`;
  const projectId = `agent-flow-project-${unique}`;
  const conversationId = `agent-flow-conv-${unique}`;
  const {runId,stepId}=RunService.start(userId,projectId,conversationId,'auto',0.5);
  try {
    const result = await AgentWorkflowEngine.executeWorkflow({
      prompt:'melhore o layout visual premium desta tela',
      mode:'auto',projectId,existingFiles:{'index.html':'<html></html>'},appliedSkills:[],conversationHistory:[],userId,runId,stepId
    });
    assert.equal(result.workflow.runId,runId);
    const steps=db.prepare('SELECT agent_key,status,order_index FROM agent_steps WHERE run_id=? ORDER BY order_index').all(runId) as any[];
    assert.deepEqual(steps.map(s=>s.agent_key),['SCOUT','STUDIO','FORGE','SENTINEL']);
    assert.ok(steps.every(s=>s.status==='completed' || s.status==='failed'));
    assert.equal(steps.filter(s=>s.agent_key==='FORGE').length,1);
  } finally {
    db.prepare('DELETE FROM model_invocations WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM agent_steps WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM agent_runs WHERE id=?').run(runId);
  }
});

test('agent workflow skips STUDIO for backend-only work and only adds SHIP when publish is requested', async () => {
  const unique = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const userId = `agent-flow-user-${unique}`;
  const projectId = `agent-flow-project-${unique}`;
  const conversationId = `agent-flow-conv-${unique}`;
  const {runId,stepId}=RunService.start(userId,projectId,conversationId,'publish',0.5);
  try {
    await AgentWorkflowEngine.executeWorkflow({
      prompt:'publique no github quando estiver pronto',
      mode:'publish',projectId,existingFiles:{'server.ts':'export {}'},appliedSkills:[],conversationHistory:[],userId,runId,stepId
    });
    const keys=(db.prepare('SELECT agent_key FROM agent_steps WHERE run_id=? ORDER BY order_index').all(runId) as any[]).map(x=>x.agent_key);
    assert.deepEqual(keys,['SCOUT','FORGE','SENTINEL','SHIP']);
    assert.equal(keys.includes('STUDIO'),false);
  } finally {
    db.prepare('DELETE FROM model_invocations WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM agent_steps WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM agent_runs WHERE id=?').run(runId);
  }
});
