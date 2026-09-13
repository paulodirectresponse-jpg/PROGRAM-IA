import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase, db } from '../server/db/index.js';
import { AgentEngine, AgentWorkflowEngine } from '../server/agent-engine/agentEngine.js';
import { RunService } from '../server/services/runService.js';
import { ModelRouter } from '../server/services/modelRouter.js';
import { LLMAdapterService } from '../server/services/llmAdapter.js';
import { SecretService } from '../server/services/secretService.js';

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
    const result = await AgentWorkflowEngine.executeWorkflow({
      prompt:'publique no github quando estiver pronto',
      mode:'publish',projectId,existingFiles:{'server.ts':'export {}'},appliedSkills:[],conversationHistory:[],userId,runId,stepId
    });
    const keys=(db.prepare('SELECT agent_key FROM agent_steps WHERE run_id=? ORDER BY order_index').all(runId) as any[]).map(x=>x.agent_key);
    assert.deepEqual(keys,['SHIP']);
    assert.equal(keys.includes('STUDIO'),false);
    assert.equal(result.agentKey,'SHIP');
    assert.equal(result.workflow.shipRequested,true);
  } finally {
    db.prepare('DELETE FROM model_invocations WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM agent_steps WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM agent_runs WHERE id=?').run(runId);
  }
});


test('manual plan and review modes are owned by SCOUT and SENTINEL instead of FORGE', async () => {
  for (const scenario of [
    {mode:'plan' as const, agent:'SCOUT'},
    {mode:'review' as const, agent:'SENTINEL'},
  ]) {
    const unique=Date.now().toString(36)+Math.random().toString(36).slice(2);
    const userId=`agent-role-user-${scenario.mode}-${unique}`;
    const projectId=`agent-role-project-${unique}`;
    const conversationId=`agent-role-conv-${unique}`;
    const {runId,stepId}=RunService.start(userId,projectId,conversationId,scenario.mode,0.5);
    try {
      const result=await AgentWorkflowEngine.executeWorkflow({
        prompt:scenario.mode==='plan'?'planeje um painel':'revise este código',
        mode:scenario.mode,
        projectId,
        existingFiles:{'index.html':'<html></html>'},
        appliedSkills:[],
        conversationHistory:[],
        userId,
        runId,
        stepId,
      });
      const steps=db.prepare('SELECT agent_key FROM agent_steps WHERE run_id=? ORDER BY order_index').all(runId) as any[];
      assert.deepEqual(steps.map(s=>s.agent_key),[scenario.agent]);
      assert.equal(result.agentKey,scenario.agent);
    } finally {
      db.prepare('DELETE FROM model_invocations WHERE run_id=?').run(runId);
      db.prepare('DELETE FROM agent_steps WHERE run_id=?').run(runId);
      db.prepare('DELETE FROM agent_runs WHERE id=?').run(runId);
    }
  }
});

test('workflow forced FORGE keeps agent_steps and model_invocations agent_key consistent', async (t) => {
  const unique = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const userId = `agent-consistency-user-${unique}`;
  const projectId = `agent-consistency-project-${unique}`;
  const conversationId = `agent-consistency-conv-${unique}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO providers(id,user_id,provider_key,name,base_url,model_id,is_configured,connection_status,context_limit,created_at) VALUES(?,?,?,?,?,?,1,'connected',128000,?)")
    .run(`prov-${unique}`, userId, 'omniroute', 'OmniRoute', 'https://example.test/v1', 'auto', now);
  db.prepare('INSERT INTO model_profiles(id,user_id,profile_key,level,max_attempts,max_cost_usd,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(`profile-${unique}`, userId, 'BASE_FREE', 0, 1, 0.01, 1, now, now);
  db.prepare('INSERT INTO model_candidates(id,profile_id,provider_key,model_id,priority,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(`candidate-${unique}`, `profile-${unique}`, 'omniroute', 'auto', 0, 1, now, now);
  SecretService.saveSecret(userId, 'omniroute', 'secret-for-test');
  t.mock.method(LLMAdapterService, 'executePrompt', async () => ({
    replyText: 'ok',
    mode: 'auto',
    decisionType: 'change',
    isDemonstrativeFallback: false,
    providerUsed: 'OmniRoute',
    modelUsed: 'auto',
    proposal: { id: `prop-${unique}`, summary: 'ok', requiresConfirmation: false, files: [{ path: 'index.html', action: 'modify', content: '<html></html>' }], status: 'pending' },
    build: { summary: 'ok', explanation: 'ok', files: [{ path: 'index.html', action: 'modify', content: '<html></html>' }] },
    usage: { inputTokens: 1, outputTokens: 1, billedCostUsd: 0.001 },
  } as any));
  const {runId,stepId}=RunService.start(userId,projectId,conversationId,'auto',0.5);
  try {
    await AgentWorkflowEngine.executeWorkflow({
      prompt:'melhore o visual premium desta tela',
      mode:'auto',projectId,existingFiles:{'index.html':'<html>old</html>'},appliedSkills:[],conversationHistory:[],userId,runId,stepId
    });
    const rows = db.prepare(`SELECT s.agent_key step_agent, i.agent_key invocation_agent
      FROM model_invocations i JOIN agent_steps s ON s.id=i.step_id WHERE i.run_id=?`).all(runId) as any[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].step_agent, 'FORGE');
    assert.equal(rows[0].invocation_agent, 'FORGE');
  } finally {
    db.prepare('DELETE FROM model_invocations WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM agent_steps WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM agent_runs WHERE id=?').run(runId);
    db.prepare('DELETE FROM model_candidates WHERE profile_id=?').run(`profile-${unique}`);
    db.prepare('DELETE FROM model_profiles WHERE id=?').run(`profile-${unique}`);
    db.prepare('DELETE FROM user_secrets WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM providers WHERE id=?').run(`prov-${unique}`);
  }
});

test('BASE_FREE max_attempts retries the same configured candidate before paid escalation', async (t) => {
  const unique=Date.now().toString(36)+Math.random().toString(36).slice(2);
  const userId=`agent-retry-user-${unique}`;
  const projectId=`agent-retry-project-${unique}`;
  const conversationId=`agent-retry-conv-${unique}`;
  const now=new Date().toISOString();
  db.prepare("INSERT INTO providers(id,user_id,provider_key,name,base_url,model_id,is_configured,connection_status,context_limit,created_at) VALUES(?,?,?,?,?,?,1,'connected',128000,?)")
    .run(`prov-${unique}`,userId,'omniroute','OmniRoute','https://example.test/v1','auto',now);
  db.prepare('INSERT INTO model_profiles(id,user_id,profile_key,level,max_attempts,max_cost_usd,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(`profile-${unique}`,userId,'BASE_FREE',0,2,0,1,now,now);
  db.prepare('INSERT INTO model_candidates(id,profile_id,provider_key,model_id,priority,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(`candidate-${unique}`,`profile-${unique}`,'omniroute','auto',0,1,now,now);
  SecretService.saveSecret(userId,'omniroute','retry-secret');
  let calls=0;
  t.mock.method(LLMAdapterService,'executePrompt',async()=>{
    calls+=1;
    if(calls===1) return {
      replyText:'invalid',
      mode:'build',
      decisionType:'invalid_response',
      isDemonstrativeFallback:false,
      providerUsed:'OmniRoute',
      modelUsed:'auto',
      hasErrors:true,
      invalidResponse:true,
      errorReason:'incompatible_response',
      errorMessage:'Resposta incompatível',
    } as any;
    return {
      replyText:'ok',
      mode:'build',
      decisionType:'change',
      isDemonstrativeFallback:false,
      providerUsed:'OmniRoute',
      modelUsed:'auto',
      hasErrors:false,
      build:{summary:'ok',explanation:'ok',files:[{path:'index.html',action:'modify',content:'<html>ok</html>'}]},
      usage:{inputTokens:1,outputTokens:1,billedCostUsd:0},
    } as any;
  });
  const {runId,stepId}=RunService.start(userId,projectId,conversationId,'build',0.5);
  try {
    const result=await AgentEngine.execute({
      prompt:'construa',
      mode:'build',
      projectId,
      existingFiles:{'index.html':'<html>old</html>'},
      appliedSkills:[],
      conversationHistory:[],
      userId,
      runId,
      stepId,
    },{profile:'BASE_FREE',forcedAgentKey:'FORGE',allowExpertEscalation:true});
    assert.equal(calls,2);
    assert.equal(result.profileKey,'BASE_FREE');
    const invocations=db.prepare('SELECT status,retry_index FROM model_invocations WHERE run_id=? ORDER BY created_at').all(runId) as any[];
    assert.equal(invocations.length,2);
    assert.equal(invocations[0].status,'failed');
    assert.equal(invocations[1].status,'success');
  } finally {
    db.prepare('DELETE FROM model_invocations WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM agent_steps WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM agent_runs WHERE id=?').run(runId);
    db.prepare('DELETE FROM model_candidates WHERE profile_id=?').run(`profile-${unique}`);
    db.prepare('DELETE FROM model_profiles WHERE id=?').run(`profile-${unique}`);
    db.prepare('DELETE FROM user_secrets WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM providers WHERE id=?').run(`prov-${unique}`);
  }
});

test('abort before repair/provider attempt records no invocation or attempt', async (t) => {
  const unique = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const userId = `agent-abort-user-${unique}`;
  const projectId = `agent-abort-project-${unique}`;
  const conversationId = `agent-abort-conv-${unique}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO providers(id,user_id,provider_key,name,base_url,model_id,is_configured,connection_status,context_limit,created_at) VALUES(?,?,?,?,?,?,1,'connected',128000,?)")
    .run(`prov-${unique}`, userId, 'omniroute', 'OmniRoute', 'https://example.test/v1', 'auto', now);
  db.prepare('INSERT INTO model_profiles(id,user_id,profile_key,level,max_attempts,max_cost_usd,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(`profile-${unique}`, userId, 'BASE_FREE', 0, 1, 0.01, 1, now, now);
  db.prepare('INSERT INTO model_candidates(id,profile_id,provider_key,model_id,priority,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(`candidate-${unique}`, `profile-${unique}`, 'omniroute', 'auto', 0, 1, now, now);
  SecretService.saveSecret(userId, 'omniroute', 'secret-for-test');
  let providerCalls = 0;
  t.mock.method(LLMAdapterService, 'executePrompt', async () => {
    providerCalls++;
    return {} as any;
  });
  const {runId,stepId}=RunService.start(userId,projectId,conversationId,'build',0.5);
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(() => AgentEngine.execute({prompt:'corrija',mode:'build',projectId,existingFiles:{},appliedSkills:[],conversationHistory:[],userId,runId,stepId,signal:controller.signal},{profile:'BASE_FREE',forcedAgentKey:'FORGE',allowExpertEscalation:true}), /aborted|Abort/i);
    assert.equal(providerCalls, 0);
    assert.equal((db.prepare('SELECT attempt_count FROM agent_steps WHERE id=?').get(stepId) as any).attempt_count,0);
    assert.equal((db.prepare('SELECT COUNT(*) c FROM model_invocations WHERE run_id=?').get(runId) as any).c,0);
  } finally {
    db.prepare('DELETE FROM model_invocations WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM agent_steps WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM agent_runs WHERE id=?').run(runId);
    db.prepare('DELETE FROM model_candidates WHERE profile_id=?').run(`profile-${unique}`);
    db.prepare('DELETE FROM model_profiles WHERE id=?').run(`profile-${unique}`);
    db.prepare('DELETE FROM user_secrets WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM providers WHERE id=?').run(`prov-${unique}`);
  }
});

