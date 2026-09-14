import { LLMAdapterService, type AgentMode, type LLMExecutionResult } from '../services/llmAdapter.js';
import { ModelRouter, type FailureKind, type ProfileKey } from '../services/modelRouter.js';
import { RunService } from '../services/runService.js';
import { ProgressRetryController, type AttemptEvidence } from '../services/progressRetryController.js';
import { contractPrompt } from './agentContracts.js';
import { selectAgent } from './agentRegistry.js';
import { ContextEngineV2, type ContextAgentKey, type ContextPack, type ContextScope } from '../context-engine/contextEngine.js';
import { DEFAULT_CONTEXT_TOKEN_BUDGETS } from '../context-engine/contextCompiler.js';
import { RequirementLedgerService } from '../services/requirementLedgerService.js';
import { ProposalSandboxService } from '../tooling/proposalSandboxService.js';
import { WorkspaceManager } from '../services/workspaceManager.js';

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
  requirementIds?: string[];
  focusPaths?: string[];
  contextPack?: ContextPack;
  contextBrief?: string;
  skipContextSync?: boolean;
  reliableBuild?: {
    requestedFiles: string[];
    objective: string;
    scopeIn?: string;
    scopeOut?: string;
    acceptanceCriteria?: string[];
  };
};

type ExecuteOptions = { profile?: ProfileKey; forcedAgentKey?: string; allowExpertEscalation?: boolean; repair?: boolean };
type RetryStrategy = 'same_candidate'|'next_candidate'|'reduce_context'|'fragment_task'|'expert'|'stop';

function relevantFiles(files: Record<string, string>, previewLimit: number) {
  // Never hide the project tree. Content previews remain bounded until Context Engine V2,
  // but every path is visible to the planning agents.
  return Object.entries(files).map(([file, content], index) => ({
    file,
    chars: content.length,
    preview: index < previewLimit ? content.slice(0, 480) : '',
  }));
}

function resolvedRequirementIds(x: Input) {
  const persisted = x.runId
    ? RequirementLedgerService.listByRun(x.runId).map(item => item.requirement_key)
    : [];
  return [...new Set([...(x.requirementIds || []),...persisted].map(String).filter(Boolean))];
}
function contextScopeFor(agentKey: string, mode: AgentMode, repair?: boolean, filesCount = 0): ContextScope {
  if (agentKey === 'SENTINEL') return repair ? 'LOCAL' : 'MICRO';
  if (agentKey === 'STUDIO') return 'LOCAL';
  if (agentKey === 'SHIP') return 'TASK';
  if (agentKey === 'SCOUT') return mode === 'plan' || filesCount > 80 ? 'PROJECT' : 'TASK';
  if (agentKey === 'FORGE') return repair ? 'LOCAL' : 'TASK';
  return 'TASK';
}

function normalizeFocus(paths: string[] = []) {
  return [...new Set(paths.filter(Boolean).map(path => path.replace(/\\/g,'/').replace(/^\.\//,'')))];
}

function compileContextForStep(x: Input, agentKey: string, options: ExecuteOptions, retryStrategy: RetryStrategy = 'same_candidate'): ContextPack {
  if(!x.skipContextSync) ContextEngineV2.syncProject({ projectId: x.projectId, files: x.existingFiles });
  const focusPaths = normalizeFocus([
    ...(x.focusPaths || []),
    ...(x.reliableBuild?.requestedFiles || []),
  ]);
  const requirementIds = resolvedRequirementIds(x);
  let scope = contextScopeFor(agentKey, x.mode, options.repair, Object.keys(x.existingFiles).length);
  let tokenBudget: number | undefined;
  if (retryStrategy === 'reduce_context') {
    if (scope === 'PROJECT' || scope === 'TASK') scope = 'LOCAL';
    tokenBudget = Math.max(512, Math.floor(DEFAULT_CONTEXT_TOKEN_BUDGETS[scope] * 0.65));
  } else if (retryStrategy === 'fragment_task') {
    scope = agentKey === 'SENTINEL' ? 'MICRO' : 'LOCAL';
    tokenBudget = Math.max(512, Math.floor(DEFAULT_CONTEXT_TOKEN_BUDGETS[scope] * 0.45));
  }
  return ContextEngineV2.compile({
    projectId: x.projectId,
    runId: x.runId,
    stepId: x.stepId,
    agentKey: agentKey as ContextAgentKey,
    scope,
    task: {
      objective: retryStrategy === 'same_candidate' || retryStrategy === 'next_candidate'
        ? x.prompt
        : `${x.prompt}\nRetry strategy: ${retryStrategy}`,
      title: x.reliableBuild?.objective || x.prompt.slice(0, 120),
      acceptanceCriteria: x.reliableBuild?.acceptanceCriteria || [],
      currentFile: focusPaths[0],
      changedFiles: focusPaths,
    },
    requirementIds,
    focusPaths,
    tokenBudget,
    fileContents:x.existingFiles,
  });
}

function contextSelectedFiles(x: Input, pack: ContextPack): Record<string,string> {
  const selections = new Map(pack.selectedFiles.map(item => [
    item.file.path,
    item.content || {
      path:item.file.path,
      mode:'full' as const,
      start:0,
      end:Number.MAX_SAFE_INTEGER,
      estimatedTokens:item.estimatedTokens,
      omittedChars:0,
      reason:'fits_budget' as const,
    },
  ]));
  const out: Record<string,string> = {};
  for (const [path, content] of Object.entries(x.existingFiles)) {
    const normalized = path.replace(/\\/g,'/').replace(/^\.\//,'');
    const selection = selections.get(normalized);
    if (!selection) continue;
    out[normalized] = selection.mode === 'partial'
      ? content.slice(selection.start,selection.end)
      : content;
  }
  return out;
}

function serializeContextPack(pack: ContextPack) {
  const fileLines = pack.selectedFiles.map(item => [
    `- ${item.file.path}`,
    `  language=${item.file.language}; module=${item.file.moduleKey}; tokens≈${item.estimatedTokens}`,
    item.content ? `  content=${item.content.mode}; range=${item.content.start}-${item.content.end}; omittedChars=${item.content.omittedChars}` : '  content=legacy-full',
    item.file.summary ? `  summary=${item.file.summary}` : '',
    item.file.symbols.length ? `  symbols=${item.file.symbols.slice(0,20).join(', ')}` : '',
    item.file.imports.length ? `  imports=${item.file.imports.slice(0,20).join(', ')}` : '',
    item.file.exports.length ? `  exports=${item.file.exports.slice(0,20).join(', ')}` : '',
    item.reasons.length ? `  selectedBecause=${item.reasons.join(', ')}` : '',
  ].filter(Boolean).join('\n')).join('\n');
  const commits = pack.recentCommits.map(commit => [
    `- ${commit.agentKey || 'SYSTEM'}: ${commit.task}`,
    commit.requirementIds?.length ? `  requirements=${commit.requirementIds.join(', ')}` : '',
    commit.changedFiles?.length ? `  files=${commit.changedFiles.join(', ')}` : '',
    commit.decisions?.length ? `  decisions=${commit.decisions.join(' | ')}` : '',
    commit.blockers?.length ? `  blockers=${commit.blockers.join(' | ')}` : '',
    commit.nextState ? `  nextState=${JSON.stringify(commit.nextState).slice(0,600)}` : '',
  ].filter(Boolean).join('\n')).join('\n');
  const graph = pack.architecture;
  return [
    `ContextPack ${pack.id}`,
    `agent=${pack.agentKey}; scope=${pack.scope}; projectHash=${pack.projectHash}; estimatedTokens=${pack.estimatedTokens}/${pack.tokenBudget}`,
    pack.requirementIds.length ? `requirements=${pack.requirementIds.join(', ')}` : 'requirements=none',
    `task=${pack.task.objective}`,
    '',
    'Selected files:',
    fileLines || '- nenhum arquivo selecionado',
    pack.omittedFiles.length ? `\nOmitted by explicit budget (${pack.omittedFiles.length}):\n${pack.omittedFiles.slice(0,40).map(f=>`- ${f.path}: ${f.reason} (${f.estimatedTokens})`).join('\n')}` : '',
    '',
    `Architecture slice: modules=${graph.modules.length}; services=${graph.services.length}; routes=${graph.routes.length}; models=${graph.models.length}; components=${graph.components.length}; integrations=${graph.integrations.length}; dependencies=${graph.dependencies.length}`,
    commits ? `\nRelevant context commits:\n${commits}` : '\nRelevant context commits: none',
  ].filter(Boolean).join('\n');
}

function withCompiledContext(x: Input, agentKey: string, options: ExecuteOptions, retryStrategy: RetryStrategy = 'same_candidate'): Input {
  const requirementIds = resolvedRequirementIds(x);
  const canReuseProvidedPack = retryStrategy === 'same_candidate'
    && Boolean(x.contextPack)
    && requirementIds.every(id => x.contextPack?.requirementIds.includes(id));
  const pack = canReuseProvidedPack && x.contextPack
    ? x.contextPack
    : compileContextForStep({ ...x, requirementIds }, agentKey, options, retryStrategy);
  return {
    ...x,
    requirementIds,
    existingFiles: contextSelectedFiles(x, pack),
    contextPack: pack,
    contextBrief: serializeContextPack(pack),
  };
}

function recordContextCommitFromStep(x: Input, agentKey: string, scope: ContextScope, task: string, details: { decisions?: string[]; changedFiles?: string[]; validation?: unknown; blockers?: string[]; nextState?: unknown } = {}) {
  ContextEngineV2.recordCommit({
    projectId: x.projectId,
    runId: x.runId,
    taskId: x.stepId,
    agentKey,
    scope,
    task,
    decisions: details.decisions || [],
    changedFiles: details.changedFiles || [],
    requirementIds: resolvedRequirementIds(x),
    validation: details.validation ?? null,
    blockers: details.blockers || [],
    nextState: details.nextState ?? null,
  });
}

function needsStudio(prompt: string, mode: AgentMode) {
  return (mode === 'auto' || mode === 'build') && /interface|layout|design|visual|tela|css|responsiv|premium|ux|ui|dashboard|painel/i.test(prompt);
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
      const contextual = withCompiledContext(x, agentKey, options);
      const fallback = await LLMAdapterService.executePrompt({ ...contextual, providerKey: undefined, allowActiveFallback: false });
      return { ...fallback, agentKey, profileKey: profile };
    }
    const maxAttempts = Math.max(1, Number(available[0]?.max_attempts || 1));
    let last: any;
    const attemptHistory:AttemptEvidence[]=[];
    let retryStrategy:RetryStrategy='same_candidate';
    for (let i = 0; i < maxAttempts; i++) {
      x.signal?.throwIfAborted();
      RunService.recordAttempt(x.stepId);
      const candidateIndex=retryStrategy==='next_candidate' ? Math.min(i,available.length-1) : i % available.length;
      const candidate = available[candidateIndex];
      const started = Date.now();
      const contextBase = withCompiledContext(x, agentKey, options, retryStrategy);
      try {
        ModelRouter.assertBudget(x.userId, Number(candidate.max_cost_usd || 0), { runId: x.runId });
        const attemptInput = retryStrategy==='reduce_context' || retryStrategy==='fragment_task'
          ? {
              ...contextBase,
              conversationHistory: x.conversationHistory.slice(-2),
              prompt: [
                x.prompt,
                retryStrategy==='fragment_task'
                  ? 'RETRY STRATEGY: a tentativa anterior foi incompatível. Produza a menor alteração coerente possível, estritamente estruturada, sem expandir o escopo.'
                  : 'RETRY STRATEGY: a tentativa anterior falhou operacionalmente. Use o contexto reduzido e responda de forma objetiva e estruturada.',
              ].join('\n\n'),
            }
          : contextBase;
        const result = attemptInput.reliableBuild && attemptInput.mode === 'build'
          ? await LLMAdapterService.buildApprovedPlanReliably({
              projectId: attemptInput.projectId,
              providerKey: candidate.provider_key,
              modelId: candidate.model_id,
              userId: attemptInput.userId,
              existingFiles: attemptInput.existingFiles,
              requestedFiles: attemptInput.reliableBuild.requestedFiles,
              objective: attemptInput.reliableBuild.objective,
              scopeIn: attemptInput.reliableBuild.scopeIn,
              scopeOut: attemptInput.reliableBuild.scopeOut,
              acceptanceCriteria: attemptInput.reliableBuild.acceptanceCriteria,
              contextBrief: attemptInput.contextBrief,
              contextPackId: attemptInput.contextPack?.id,
              signal: attemptInput.signal,
              onProgress:(event)=>RunService.appendProgressEvent(attemptInput.stepId,event),
            })
          : await LLMAdapterService.executePrompt({
              ...attemptInput,
              providerKey: candidate.provider_key,
              modelId: candidate.model_id === 'auto' ? undefined : candidate.model_id,
              contextBrief: attemptInput.contextBrief,
              contextPackId: attemptInput.contextPack?.id,
            });
        if (result.isDemonstrativeFallback || result.hasErrors) {
          const reason = String(result.errorReason || result.errorMessage || 'provider_error');
          const operational = /timeout|network|rate_limit|provider_error|429|5\d\d/i.test(reason);
          throw Object.assign(Error(result.errorMessage || 'Provider indisponível'), { kind: operational ? 'operational' : 'incompatible', reason });
        }
        ModelRouter.recordCandidateResult(candidate.id, true);
        ModelRouter.recordInvocation({
          userId: x.userId,
          projectId: x.projectId,
          runId: x.runId,
          stepId: x.stepId,
          agentKey,
          profileKey: profile,
          providerKey: candidate.provider_key,
          modelId: candidate.model_id,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          costUsd: result.usage?.billedCostUsd,
          latencyMs: Date.now() - started,
          status: 'success',
          retryIndex: i,
          contextPackId: attemptInput.contextPack?.id,
          contextScope: attemptInput.contextPack?.scope,
          projectHash: attemptInput.contextPack?.projectHash,
          contextTokens: attemptInput.contextPack?.estimatedTokens,
          contextSelectedFiles: attemptInput.contextPack?.selectedFiles.map(item=>item.file.path),
          contextOmittedFilesCount: attemptInput.contextPack?.omittedFiles.length,
        });
        if (agentKey === 'SENTINEL') {
          recordContextCommitFromStep(attemptInput, 'SENTINEL', attemptInput.contextPack?.scope || 'MICRO', 'Sentinel diagnostic completed', {
            decisions:[result.replyText || 'diagnostic completed'],
            changedFiles:attemptInput.contextPack?.selectedFiles.map(item=>item.file.path) || [],
            nextState:{ status:'diagnosed' },
          });
        }
        return { ...result, agentKey, profileKey: profile };
      } catch (e: any) {
        last = e;
        const operational = /429|5\d\d|timeout|fetch|network|indispon/i.test(String(e.message));
        const kind: FailureKind = operational ? 'operational' : 'incompatible';
        ModelRouter.recordCandidateResult(candidate.id, false, kind);
        ModelRouter.recordInvocation({
          userId: x.userId,
          projectId: x.projectId,
          runId: x.runId,
          stepId: x.stepId,
          agentKey,
          profileKey: profile,
          providerKey: candidate.provider_key,
          modelId: candidate.model_id,
          latencyMs: Date.now() - started,
          status: x.signal?.aborted ? 'aborted' : 'failed',
          errorCode: x.signal?.aborted ? 'aborted' : kind,
          retryIndex: i,
          contextPackId: contextBase.contextPack?.id,
          contextScope: contextBase.contextPack?.scope,
          projectHash: contextBase.contextPack?.projectHash,
          contextTokens: contextBase.contextPack?.estimatedTokens,
          contextSelectedFiles: contextBase.contextPack?.selectedFiles.map(item=>item.file.path),
          contextOmittedFilesCount: contextBase.contextPack?.omittedFiles.length,
        });
        if (x.signal?.aborted) throw e;

        const evidence:AttemptEvidence={
          failureKind:kind,
          errorMessage:String(e?.message||e),
          strategy:retryStrategy,
          progressMarkers:[],
        };
        const decision=ProgressRetryController.decide(evidence,attemptHistory,{
          attempt:i+1,
          maxAttempts,
          hasNextCandidate:available.length>candidateIndex+1,
          canEscalate:Boolean(options.allowExpertEscalation&&profile==='BASE_FREE'),
        });
        attemptHistory.push(evidence);
        retryStrategy=decision.nextStrategy;
        if(!decision.retryAllowed){
          if(decision.escalateAllowed){
            throw Object.assign(e,{kind:e?.kind||kind,reason:e?.reason||kind,retryDecision:decision});
          }
          throw Object.assign(e,{kind:e?.kind||kind,reason:e?.reason||kind,retryDecision:decision});
        }
      }
    }
    throw last || Error('Nenhum modelo disponível.');
  }
}

export type WorkflowResult = LLMExecutionResult & {
  agentKey: string;
  profileKey: ProfileKey;
  workflow: {
    runId: string;
    steps: string[];
    status: 'waiting_approval' | 'completed' | 'failed' | 'aborted';
    shipRequested?: boolean;
    trace?: ReturnType<typeof RunService.trace>;
  };
};

export class AgentWorkflowEngine extends AgentEngine {
  static async executeWorkflow(x: Input): Promise<WorkflowResult> {
    const steps: string[] = [x.stepId];

    // Forced modes map to the agent that actually owns that job.
    // This prevents PLAN/REVIEW/PUBLISH from being mislabeled as FORGE work.
    if (x.mode === 'plan' || x.mode === 'review' || x.mode === 'publish') {
      const owner = x.mode === 'plan' ? 'SCOUT' : x.mode === 'review' ? 'SENTINEL' : 'SHIP';
      RunService.assignAgent(x.stepId, owner);
      try {
        const result = await AgentEngine.execute(
          { ...x, stepId: x.stepId },
          { profile: 'BASE_FREE', forcedAgentKey: owner, allowExpertEscalation: true }
        );
        RunService.finishStep(x.stepId, result.hasErrors ? 'failed' : 'completed', {
          decisionType: result.decisionType,
          providerUsed: result.providerUsed,
          modelUsed: result.modelUsed,
          profileKey: result.profileKey,
        });
        return {
          ...result,
          workflow: {
            runId: x.runId,
            steps,
            status: result.hasErrors ? 'failed' : 'completed',
            shipRequested: x.mode === 'publish',
            trace: RunService.trace(x.runId),
          },
        };
      } catch (error: any) {
        RunService.finishStep(x.stepId, x.signal?.aborted ? 'aborted' : 'failed', { error: String(error?.message || error) });
        throw error;
      }
    }

    // SCOUT analyzes the request before FORGE. It prefers a real BASE_FREE call,
    // but falls back to deterministic context if no free model is usable.
    RunService.assignAgent(x.stepId, 'SCOUT');
    const visibleFiles = relevantFiles(x.existingFiles, 12);
    const deterministicScout = [
      'Objetivo: ' + x.prompt,
      'Arquivos visíveis: ' + (visibleFiles.map(item => item.file).join(', ') || 'nenhum'),
      'Restrições: preservar o projeto existente, não ampliar escopo e manter a alteração revisável.',
    ].join('\n');
    let scoutBrief = deterministicScout;
    let scoutSource = 'deterministic_fallback';
    try {
      const scoutResult = await AgentEngine.execute(
        {
          ...x,
          mode: 'review',
          prompt: [
            contractPrompt('SCOUT'),
            'Analise o pedido e o workspace e produza um briefing estruturado para o próximo agente.',
            'Inclua: objetivo real, arquivos/áreas provavelmente relevantes, dependências, riscos e critérios de aceite.',
            'Não gere código. Não altere arquivos. Não responda ao usuário final.',
            '',
            'PEDIDO:',
            x.prompt,
          ].join('\n'),
          stepId: x.stepId,
        },
        { profile: 'BASE_FREE', forcedAgentKey: 'SCOUT', allowExpertEscalation: false }
      );
      if (!scoutResult.hasErrors && !scoutResult.isDemonstrativeFallback && scoutResult.replyText?.trim()) {
        scoutBrief = scoutResult.replyText.trim();
        scoutSource = 'model';
      }
    } catch {}
    recordContextCommitFromStep(x, 'SCOUT', 'TASK', 'SCOUT briefing concluído', { decisions: [scoutBrief], nextState: { next: needsStudio(x.prompt, x.mode) ? 'STUDIO' : 'FORGE' } });
    RunService.finishStep(x.stepId, 'completed', {
      ...RunService.context('task', {
        objective: x.prompt,
        acceptanceCriteria: [
          'Atender ao pedido sem ampliar escopo',
          'Preservar o projeto existente',
          'Produzir alteração revisável antes da aplicação',
          'Rodar ValidatorEngine após aplicação real',
        ],
        snippets: visibleFiles,
        constraints: [
          'Não publicar sem solicitação explícita',
          'Não aplicar arquivos antes da aprovação quando houver proposta',
          'Manter contexto limitado aos arquivos relevantes',
        ],
      }),
      brief: scoutBrief,
      source: scoutSource,
    });
    let order = RunService.nextOrderIndex(x.runId);

    let studioGuidance = '';
    if (needsStudio(x.prompt, x.mode)) {
      const deterministicStudio = [
        'Critérios do STUDIO para esta implementação:',
        '- preservar hierarquia visual clara e consistência entre seções',
        '- garantir responsividade mobile e desktop',
        '- evitar componentes visualmente quebrados, overflow e contraste insuficiente',
        '- manter a direção visual coerente com o pedido do usuário e com o projeto existente',
      ].join('\n');
      const studio = RunService.createStep(
        x.runId,
        'STUDIO',
        'Definir direção e critérios visuais para o FORGE',
        order++,
        'local',
        RunService.context('local', {
          objective: x.prompt,
          acceptanceCriteria: [
            'Layout coerente',
            'Responsividade',
            'Hierarquia visual clara',
            'Sem regressão visual óbvia',
          ],
          snippets: relevantFiles(x.existingFiles, 6),
          constraints: ['STUDIO não altera arquivos diretamente', 'Os critérios produzidos devem orientar o FORGE'],
        })
      );
      steps.push(studio);
      studioGuidance = deterministicStudio;
      let studioSource = 'deterministic_fallback';
      try {
        const studioResult = await AgentEngine.execute(
          {
            ...x,
            mode: 'review',
            prompt: [
              contractPrompt('STUDIO'),
              'Transforme o pedido visual e o briefing do SCOUT em critérios objetivos para o FORGE.',
              'Foque em composição, hierarquia, responsividade, estados, consistência e regressões visuais prováveis.',
              'Não gere código. Não altere arquivos. Não responda ao usuário final.',
              '',
              'PEDIDO:',
              x.prompt,
              '',
              'BRIEF DO SCOUT:',
              scoutBrief,
            ].join('\n'),
            stepId: studio,
          },
          { profile: 'BASE_FREE', forcedAgentKey: 'STUDIO', allowExpertEscalation: false }
        );
        if (!studioResult.hasErrors && !studioResult.isDemonstrativeFallback && studioResult.replyText?.trim()) {
          studioGuidance = studioResult.replyText.trim();
          studioSource = 'model';
        }
      } catch {}
      recordContextCommitFromStep({ ...x, stepId: studio }, 'STUDIO', 'LOCAL', 'Direção visual definida', { decisions: [studioGuidance], nextState: { next: 'FORGE' } });
      RunService.finishStep(studio, 'completed', {
        guidance: studioGuidance,
        source: studioSource,
      });
    }

    const forge = RunService.createStep(
      x.runId,
      'FORGE',
      'Gerar proposta de código',
      order++,
      'local',
      RunService.context('local', {
        objective: x.prompt,
        acceptanceCriteria: ['Alteração concreta', 'Compatibilidade com o workspace', 'Sem sucesso falso'],
        snippets: relevantFiles(x.existingFiles, 10),
        constraints: ['Gerar proposta sem alterar definitivamente o workspace', 'Manter alteração limitada ao objetivo'],
      })
    );
    steps.push(forge);

    const forgePrompt = [
      contractPrompt('FORGE'),
      x.prompt,
      'BRIEF INTERNO DO SCOUT:\n' + scoutBrief,
      studioGuidance ? 'CRITÉRIOS INTERNOS DO STUDIO:\n' + studioGuidance : '',
    ].filter(Boolean).join('\n\n');
    const reliableBuild = x.reliableBuild
      ? {
          ...x.reliableBuild,
          scopeIn: [x.reliableBuild.scopeIn, studioGuidance].filter(Boolean).join('\n\n'),
        }
      : undefined;

    let result: LLMExecutionResult & { agentKey: string; profileKey: ProfileKey };
    try {
      result = await AgentEngine.execute(
        { ...x, prompt: forgePrompt, reliableBuild, stepId: forge },
        { profile: 'BASE_FREE', forcedAgentKey: 'FORGE', allowExpertEscalation: true }
      );
      const proposalFiles=result.proposal?.files || result.build?.files || [];
      if(!result.hasErrors && proposalFiles.length && WorkspaceManager.verifyProjectOwnership(x.projectId,x.userId)){
        if(!result.proposal){
          result.proposal={
            id:`proposal-${x.runId}-${forge}`,
            summary:result.build?.summary || 'Proposta de alteração',
            requiresConfirmation:true,
            files:proposalFiles,
            status:'pending',
          };
        }
        const sandboxEvidence=await ProposalSandboxService.materialize({
          userId:x.userId,
          projectId:x.projectId,
          runId:x.runId,
          stepId:forge,
          proposalId:result.proposal.id,
          files:proposalFiles,
          signal:x.signal,
        });
        result.proposal.sandboxId=sandboxEvidence.sandboxId;
        result.proposal.baseRevision=sandboxEvidence.baseRevision;
        result.proposal.sandboxValidation=sandboxEvidence.validation;
        result.proposal.toolExecutionIds=sandboxEvidence.toolExecutionIds;
      }
      recordContextCommitFromStep({ ...x, stepId: forge }, 'FORGE', 'TASK', 'Proposta de código gerada', { changedFiles: result.build?.files?.map(f => f.path) || result.proposal?.files?.map(f => f.path) || [], nextState: { next: result.hasErrors ? 'failed' : 'waiting_approval' } });
      RunService.finishStep(forge, result.hasErrors ? 'failed' : 'completed', {
        decisionType: result.decisionType,
        providerUsed: result.providerUsed,
        modelUsed: result.modelUsed,
        profileKey: result.profileKey,
        files: result.build?.files?.map(f => f.path) || result.proposal?.files?.map(f => f.path) || [],
      });
    } catch (error: any) {
      RunService.finishStep(forge, x.signal?.aborted ? 'aborted' : 'failed', { error: String(error?.message || error) });
      const sentinel = RunService.createStep(
        x.runId,
        'SENTINEL',
        'Diagnosticar falha executável',
        order++,
        'micro',
        RunService.context('micro', {
          objective: 'Interpretar falha concreta de provider/modelo',
          errors: [String(error?.message || error)],
          constraints: ['Sem revisão genérica', 'Sem nova tentativa sem evidência'],
        })
      );
      steps.push(sentinel);
      RunService.finishStep(sentinel, x.signal?.aborted ? 'aborted' : 'completed');
      throw error;
    }

    const hasReviewableChanges = Boolean(result.proposal?.files?.length || result.build?.files?.length);
    const sentinelStatus = RunService.createStep(
      x.runId,
      'SENTINEL',
      hasReviewableChanges ? 'Aguardar aplicação para executar quality gates' : 'Registrar ausência de alteração validável',
      order++,
      'micro',
      {
        status: hasReviewableChanges ? 'pending_user_apply' : 'not_applicable',
        reason: hasReviewableChanges
          ? 'A proposta será validada pelo ValidatorEngine somente após aplicação aprovada pelo usuário.'
          : 'Sem proposta de código para validar.',
        validator: 'ValidatorEngine',
      }
    );
    steps.push(sentinelStatus);
    recordContextCommitFromStep({ ...x, stepId: sentinelStatus }, 'SENTINEL', 'MICRO', hasReviewableChanges ? 'Aguardar aprovação para validação' : 'Sem alteração validável', { nextState: { status: hasReviewableChanges ? 'waiting_approval' : 'completed' } });
    RunService.finishStep(sentinelStatus, 'completed');

    return {
      ...result,
      workflow: {
        runId: x.runId,
        steps,
        status: result.hasErrors ? 'failed' : hasReviewableChanges ? 'waiting_approval' : 'completed',
        shipRequested: needsShip(x.prompt, x.mode),
        trace: RunService.trace(x.runId),
      },
    };
  }
}

