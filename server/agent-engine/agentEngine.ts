import { LLMAdapterService, type AgentMode, type LLMExecutionResult } from '../services/llmAdapter.js';
import { ModelRouter, type FailureKind, type ProfileKey } from '../services/modelRouter.js';
import { RunService } from '../services/runService.js';
import { selectAgent } from './agentRegistry.js';

type Input = {
  prompt: string;
  mode: AgentMode;
  projectId: string;
  existingFiles: Record<string, string>;
  appliedSkills: string[];
  conversationHistory: Array<{ sender: string; content: string }>;
  userId: string;
  runId: string;
  stepId: string;
  signal?: AbortSignal;
  reliableBuild?: {
    requestedFiles: string[];
    objective: string;
    scopeIn?: string;
    scopeOut?: string;
    acceptanceCriteria?: string[];
  };
};

type ExecuteOptions = { profile?: ProfileKey; forcedAgentKey?: string; allowExpertEscalation?: boolean; repair?: boolean };

function relevantFiles(files: Record<string, string>, limit: number) {
  return Object.entries(files).slice(0, limit).map(([file, content]) => ({ file, chars: content.length, preview: content.slice(0, 240) }));
}

function needsStudio(prompt: string, mode: AgentMode) {
  return mode === 'auto' && /interface|layout|design|visual|tela|css|responsiv|premium|ux|ui/i.test(prompt);
}

function needsShip(prompt: string, mode: AgentMode) {
  return mode === 'publish' || /\b(public(?:ar|a|e)|deploy|lançar|release)\b/i.test(prompt);
}

export class AgentEngine {
  static async execute(x: Input, profileOrOptions: ProfileKey | ExecuteOptions = 'BASE_FREE'): Promise<LLMExecutionResult & { agentKey: string; profileKey: ProfileKey }> {
    const options: ExecuteOptions = typeof profileOrOptions === 'string' ? { profile: profileOrOptions } : profileOrOptions;
    const profile = options.profile || 'BASE_FREE';
    try {
      return await this.executeWithProfile(x, profile, options);
    } catch (error: any) {
      const canEscalate = options.allowExpertEscalation
        && profile === 'BASE_FREE'
        && !x.signal?.aborted
        && (
          error?.kind === 'incompatible'
          || error?.kind === 'operational'
          || /Nenhum modelo disponivel|Nenhum modelo disponível|Nenhum candidate|incompatible|bloqueado|Provider indisponivel|Provider indisponível/i.test(String(error?.message || error))
        );
      if (!canEscalate) throw error;
      const expertAvailable = ModelRouter.candidates(x.userId, 'EXPERT_PAID')
        .some(candidate => LLMAdapterService.getProviderConfig(candidate.provider_key, x.userId).isConfigured);
      if (!expertAvailable) {
        if (error?.reason === 'no_candidate') {
          return await this.executeWithProfile(x, profile, { ...options, allowExpertEscalation: false });
        }
        throw error;
      }
      return await this.executeWithProfile(x, 'EXPERT_PAID', { ...options, profile: 'EXPERT_PAID' });
    }
  }

  private static async executeWithProfile(x: Input, profile: ProfileKey, options: ExecuteOptions): Promise<LLMExecutionResult & { agentKey: string; profileKey: ProfileKey }> {
    const agentKey = options.forcedAgentKey || selectAgent(x.mode, x.prompt);
    RunService.assignAgent(x.stepId, agentKey);
    const available = ModelRouter.candidates(x.userId, profile).filter(c => LLMAdapterService.getProviderConfig(c.provider_key, x.userId).isConfigured);
    if (!available.length) {
      if (options.allowExpertEscalation) {
        throw Object.assign(
          new Error(`Nenhum candidate utilizável no perfil ${profile}.`),
          { kind: 'capacity', reason: 'no_candidate' }
        );
      }
      const fallback = await LLMAdapterService.executePrompt({ ...x, providerKey: undefined, allowActiveFallback: false });
      return { ...fallback, agentKey, profileKey: profile };
    }
    const candidates = available.slice(0, Math.max(1, Number(available[0]?.max_attempts || 1)));
    let last: unknown;
    for (let i = 0; i < candidates.length; i++) {
      x.signal?.throwIfAborted();
      RunService.recordAttempt(x.stepId);
      const c = candidates[i];
      const started = Date.now();
      try {
        ModelRouter.assertBudget(x.userId, Number(c.max_cost_usd || 0), { runId: x.runId });
        const result = x.reliableBuild && x.mode === 'build'
          ? await LLMAdapterService.buildApprovedPlanReliably({
              projectId: x.projectId,
              providerKey: c.provider_key,
              modelId: c.model_id,
              userId: x.userId,
              existingFiles: x.existingFiles,
              requestedFiles: x.reliableBuild.requestedFiles,
              objective: x.reliableBuild.objective,
              scopeIn: x.reliableBuild.scopeIn,
              scopeOut: x.reliableBuild.scopeOut,
              acceptanceCriteria: x.reliableBuild.acceptanceCriteria,
              signal: x.signal,
            })
          : await LLMAdapterService.executePrompt({
              ...x,
              providerKey: c.provider_key,
              modelId: c.model_id === 'auto' ? undefined : c.model_id,
            });
        if (result.isDemonstrativeFallback || result.hasErrors) {
          const reason = String(result.errorReason || result.errorMessage || 'provider_error');
          const operational = /timeout|network|rate_limit|provider_error|429|5\d\d/i.test(reason);
          throw Object.assign(Error(result.errorMessage || 'Provider indisponível'), { kind: operational ? 'operational' : 'incompatible', reason });
        }
        ModelRouter.recordCandidateResult(c.id, true);
        ModelRouter.recordInvocation({
          userId: x.userId,
          projectId: x.projectId,
          runId: x.runId,
          stepId: x.stepId,
          agentKey,
          profileKey: profile,
          providerKey: c.provider_key,
          modelId: c.model_id,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          costUsd: result.usage?.billedCostUsd,
          latencyMs: Date.now() - started,
          status: 'success',
          retryIndex: i,
        });
        return { ...result, agentKey, profileKey: profile };
      } catch (e: any) {
        last = e;
        const operational = /429|5\d\d|timeout|fetch|network|indispon/i.test(String(e.message));
        const kind: FailureKind = operational ? 'operational' : 'incompatible';
        ModelRouter.recordCandidateResult(c.id, false, kind);
        ModelRouter.recordInvocation({
          userId: x.userId,
          projectId: x.projectId,
          runId: x.runId,
          stepId: x.stepId,
          agentKey,
          profileKey: profile,
          providerKey: c.provider_key,
          modelId: c.model_id,
          latencyMs: Date.now() - started,
          status: x.signal?.aborted ? 'aborted' : 'failed',
          errorCode: x.signal?.aborted ? 'aborted' : kind,
          retryIndex: i,
        });
        if (x.signal?.aborted) throw e;
      }
    }
    throw last || Error('Nenhum modelo disponível.');
  }
}

export type WorkflowResult = LLMExecutionResult & { agentKey: string; profileKey: ProfileKey; workflow: { runId: string; steps: string[]; status: 'waiting_approval' | 'completed' | 'failed' | 'aborted'; shipRequested?: boolean } };

export class AgentWorkflowEngine extends AgentEngine {
  static async executeWorkflow(x: Input): Promise<WorkflowResult> {
    const steps: string[] = [x.stepId];
    RunService.assignAgent(x.stepId, 'SCOUT');
    RunService.finishStep(x.stepId, 'completed', RunService.context('task', {
      objective: x.prompt,
      acceptanceCriteria: ['Sem sucesso falso', 'Preservar preview antes da aplicação definitiva', 'Rodar ValidatorEngine após aplicação real'],
      snippets: relevantFiles(x.existingFiles, 12),
      constraints: ['Não carregar projeto inteiro para o agente', 'Não publicar sem solicitação explícita'],
    }));
    let order = RunService.nextOrderIndex(x.runId);

    if (needsStudio(x.prompt, x.mode)) {
      const studio = RunService.createStep(x.runId, 'STUDIO', 'Definir critérios visuais aplicáveis', order++, 'local', RunService.context('local', {
        objective: 'Transformar solicitação visual em critérios objetivos para o FORGE',
        acceptanceCriteria: ['Layout coerente', 'Responsividade', 'Hierarquia visual clara'],
        snippets: relevantFiles(x.existingFiles, 6),
        constraints: ['STUDIO não modifica arquivos', 'STUDIO não chama provider quando critérios determinísticos bastam'],
      }));
      steps.push(studio);
      RunService.finishStep(studio, 'completed');
    }

    const forge = RunService.createStep(x.runId, 'FORGE', 'Gerar proposta de código', order++, 'local', RunService.context('local', {
      objective: x.prompt,
      snippets: relevantFiles(x.existingFiles, 10),
      constraints: ['Gerar proposta sem alterar definitivamente o workspace', 'Manter alteração limitada ao objetivo'],
    }));
    steps.push(forge);

    let result: LLMExecutionResult & { agentKey: string; profileKey: ProfileKey };
    try {
      result = await AgentEngine.execute(
        { ...x, stepId: forge },
        { profile: 'BASE_FREE', forcedAgentKey: 'FORGE', allowExpertEscalation: true }
      );
      RunService.finishStep(forge, result.hasErrors ? 'failed' : 'completed', {
        decisionType: result.decisionType,
        providerUsed: result.providerUsed,
        modelUsed: result.modelUsed,
        profileKey: result.profileKey,
        files: result.build?.files?.map(f => f.path) || result.proposal?.files?.map(f => f.path) || [],
      });
    } catch (error: any) {
      RunService.finishStep(forge, x.signal?.aborted ? 'aborted' : 'failed', { error: String(error?.message || error) });
      const sentinel = RunService.createStep(x.runId, 'SENTINEL', 'Diagnosticar falha executável', order++, 'micro', RunService.context('micro', {
        objective: 'Interpretar falha concreta de provider/modelo',
        errors: [String(error?.message || error)],
        constraints: ['Sem revisão genérica', 'Sem segunda tentativa sem evidência nova'],
      }));
      steps.push(sentinel);
      RunService.finishStep(sentinel, x.signal?.aborted ? 'aborted' : 'completed');
      throw error;
    }

    const hasReviewableChanges = Boolean(result.proposal?.files?.length || result.build?.files?.length);
    const sentinelStatus = RunService.createStep(x.runId, 'SENTINEL', hasReviewableChanges ? 'Aguardar aplicação para validar proposta' : 'Registrar ausência de validação aplicável', order++, 'micro', {
      status: hasReviewableChanges ? 'pending_user_apply' : 'not_applicable',
      reason: hasReviewableChanges ? 'Preview antes de aplicar é intencional; ValidatorEngine roda na aplicação definitiva.' : 'Sem proposta de código para validar.',
      validator: 'ValidatorEngine',
    });
    steps.push(sentinelStatus);
    RunService.finishStep(sentinelStatus, 'completed');

    return {
      ...result,
      workflow: {
        runId: x.runId,
        steps,
        status: result.hasErrors ? 'failed' : hasReviewableChanges ? 'waiting_approval' : 'completed',
        shipRequested: needsShip(x.prompt, x.mode),
      },
    };
  }
}
