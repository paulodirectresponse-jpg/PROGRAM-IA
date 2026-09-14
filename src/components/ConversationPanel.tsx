import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  Sparkles,
  FileCode2,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Square,
  Terminal,
  ChevronDown,
  ChevronUp,
  Zap,
  Check,
  X,
  Code2,
  CheckCheck,
} from 'lucide-react';
import { Message, AgentMode, Skill, Plan, ChangeProposal, FileChangeProposal } from '../types';
import { PlanResponseCard, parsePlanForDisplay } from './PlanResponseCard';
import { ChatMarkdown } from './ChatMarkdown';

interface ConversationPanelProps {
  messages: Message[];
  activeMode: AgentMode;
  onChangeMode: (m: AgentMode) => void;
  onSendMessage: (text: string, skills: string[]) => void;
  onApprovePlan: (planId: string) => void;
  onApplyProposal?: (proposal: ChangeProposal) => void;
  onRejectProposal?: (proposal: ChangeProposal) => void;
  activePlan: Plan | null;
  isLoading: boolean;
  activeAgentTrace?: any[];
  activeAgentRunStatus?: string | null;
  activeAgentRun?: any | null;
  onContinueRun?: () => void;
  onAbort: () => void;
  availableSkills: Skill[];
  canSend: boolean;
  sidebarCollapsed?: boolean;
}

export const ConversationPanel: React.FC<ConversationPanelProps> = ({
  messages,
  activeMode,
  onChangeMode,
  onSendMessage,
  onApprovePlan,
  onApplyProposal,
  onRejectProposal,
  activePlan,
  isLoading,
  activeAgentTrace = [],
  activeAgentRunStatus = null,
  activeAgentRun = null,
  onContinueRun,
  onAbort,
  availableSkills,
  canSend,
  sidebarCollapsed = false,
}) => {
  const [inputText, setInputText] = useState('');
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const [showAdvancedModes, setShowAdvancedModes] = useState(false);
  const [expandedDiffs, setExpandedDiffs] = useState<Record<string, boolean>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [clockNow,setClockNow]=useState(()=>Date.now());

  useEffect(()=>{
    if(activeAgentRunStatus!=='running')return;
    setClockNow(Date.now());
    const timer=window.setInterval(()=>setClockNow(Date.now()),1000);
    return()=>window.clearInterval(timer);
  },[activeAgentRunStatus]);

  const elapsed=(start?:string|null,end?:string|null)=>{
    if(!start)return '00:00';
    const startMs=new Date(start).getTime();
    const endMs=end?new Date(end).getTime():clockNow;
    const seconds=Math.max(0,Math.floor((endMs-startMs)/1000));
    const minutes=Math.floor(seconds/60);
    const rest=seconds%60;
    return `${String(minutes).padStart(2,'0')}:${String(rest).padStart(2,'0')}`;
  };
  const executionBusy=isLoading||activeAgentRunStatus==='running';

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || executionBusy || !canSend) return;

    // Detect @skill mentions in message
    const mentionedSkills: string[] = [...selectedSkills];
    const skillRegex = /@([\w-]+)/g;
    let match;
    while ((match = skillRegex.exec(inputText)) !== null) {
      const slug = match[1];
      if (!mentionedSkills.includes(slug)) {
        mentionedSkills.push(slug);
      }
    }

    onSendMessage(inputText, mentionedSkills);
    setInputText('');
    setShowSkillPicker(false);
  };

  const toggleSkill = (slug: string) => {
    if (selectedSkills.includes(slug)) {
      setSelectedSkills(selectedSkills.filter((s) => s !== slug));
    } else {
      setSelectedSkills([...selectedSkills, slug]);
    }
  };

  const toggleDiff = (id: string) => {
    setExpandedDiffs((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const getModeInfo = (mode: AgentMode) => {
    switch (mode) {
      case 'auto':
        return { label: 'Automático', badge: 'bg-cyan-950/80 text-cyan-300 border-cyan-800/60', icon: Zap };
      case 'plan':
        return { label: 'Planejar', badge: 'bg-amber-950/80 text-amber-300 border-amber-800/60', icon: Sparkles };
      case 'build':
        return { label: 'Construir', badge: 'bg-emerald-950/80 text-emerald-300 border-emerald-800/60', icon: Code2 };
      case 'review':
        return { label: 'Revisar', badge: 'bg-blue-950/80 text-blue-300 border-blue-800/60', icon: CheckCheck };
      case 'publish':
        return { label: 'Publicar', badge: 'bg-purple-950/80 text-purple-300 border-purple-800/60', icon: Terminal };
    }
  };

  const currentModeInfo = getModeInfo(activeMode);
  const ModeIcon = currentModeInfo.icon;

  return (
    <div
      id="conversation-panel"
      className={`${sidebarCollapsed ? 'w-[540px] min-w-[440px] max-w-[620px]' : 'w-[460px] min-w-[400px] max-w-[520px]'} bg-slate-950 border-r border-slate-800/80 flex flex-col h-full shrink-0 select-text transition-[width,min-width,max-width] duration-200`}
    >
      {/* Top Mode Bar */}
      <div className="p-3 border-b border-slate-800/80 bg-slate-900/40 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              id="btn-mode-auto-main"
              onClick={() => onChangeMode('auto')}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition cursor-pointer border ${
                activeMode === 'auto'
                  ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/50 shadow-xs'
                  : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
              }`}
            >
              <Zap size={13} className={activeMode === 'auto' ? 'text-cyan-400' : 'text-slate-500'} />
              <span>Modo Automático</span>
              {activeMode === 'auto' && (
                <span className="text-[10px] text-cyan-400/90 font-mono font-normal">(padrão)</span>
              )}
            </button>
          </div>

          {/* Toggle for manual advanced mode override */}
          <button
            type="button"
            id="btn-toggle-advanced-modes"
            onClick={() => setShowAdvancedModes(!showAdvancedModes)}
            className="text-[11px] text-slate-400 hover:text-slate-200 flex items-center gap-1 cursor-pointer transition py-1 px-1.5 rounded hover:bg-slate-800/60"
          >
            <span className="font-mono">{currentModeInfo.label}</span>
            {showAdvancedModes ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        </div>

        {/* Secondary Advanced Modes (when user wants to manually force a phase) */}
        {showAdvancedModes && (
          <div className="pt-2 border-t border-slate-800/60 animate-fade-in">
            <div className="text-[10px] uppercase font-mono text-slate-500 mb-1.5">Forçar Modo Específico:</div>
            <div className="grid grid-cols-4 gap-1 p-1 bg-slate-950 rounded-lg border border-slate-800">
              {(['plan', 'build', 'review', 'publish'] as AgentMode[]).map((mode) => {
                const isSelected = activeMode === mode;
                const labels: Record<string, string> = {
                  plan: 'Planejar',
                  build: 'Construir',
                  review: 'Revisar',
                  publish: 'Publicar',
                };
                return (
                  <button
                    key={mode}
                    type="button"
                    id={`btn-mode-${mode}`}
                    onClick={() => {
                      onChangeMode(mode);
                    }}
                    className={`py-1 text-[11px] font-medium rounded transition cursor-pointer text-center ${
                      isSelected
                        ? 'bg-slate-800 text-cyan-300 font-semibold shadow-xs'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                    }`}
                  >
                    {labels[mode]}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Messages Stream */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar text-xs">
        {messages.map((msg) => {
          const isUser = msg.sender === 'user';
          let parsedMetadata: Record<string, any> = {};
          if (msg.metadata_json) {
            try { parsedMetadata = JSON.parse(msg.metadata_json); } catch { parsedMetadata = {}; }
          }
          const rawMeta = msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : parsedMetadata;
          const meta = rawMeta && typeof rawMeta === 'object' ? rawMeta : {};
          const rawProposal = meta.proposal && typeof meta.proposal === 'object' ? meta.proposal as ChangeProposal : undefined;
          const proposal = rawProposal && Array.isArray(rawProposal.files) ? rawProposal : undefined;
          const hasProposal = Boolean(proposal && proposal.files.length > 0);
          const filesAffected = Array.isArray(meta.filesAffected) ? meta.filesAffected.filter((f: unknown): f is string => typeof f === 'string') : [];
          const isDiffOpen = expandedDiffs[msg.id] ?? false;
          const shouldRenderPlanCard = !isUser && (meta.decisionType === 'plan' || typeof meta.planId === 'string') && Boolean(parsePlanForDisplay(msg.content));

          return (
            <div
              key={msg.id}
              id={`message-${msg.id}`}
              className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
            >
              <div className="mb-1 text-[10px] font-medium text-slate-500">
                {isUser ? 'Você' : 'Forge Agent'}
              </div>

              {!isUser && Array.isArray(meta.workflow?.trace) && meta.workflow.trace.length > 0 && (
                <details className="mb-1.5 text-[10px] text-slate-500">
                  <summary className="cursor-pointer select-none hover:text-slate-300">Detalhes da execução</summary>
                  <div className="mt-1.5 space-y-1 pl-1">
                    {meta.workflow.trace.map((step:any) => (
                      <div key={step.id} className="flex items-center gap-2 font-mono">
                        <span className={step.status==='completed'?'text-emerald-400':step.status==='failed'?'text-rose-400':'text-slate-500'}>
                          {step.status==='completed'?'✓':step.status==='failed'?'!':'·'}
                        </span>
                        <span>{step.agent_key}</span>
                        <span className="truncate text-slate-600">{step.title}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              <div
                className={`leading-relaxed ${
                  isUser
                    ? 'max-w-[92%] rounded-2xl rounded-br-md bg-cyan-950/70 border border-cyan-800/60 px-3.5 py-2.5 text-slate-100'
                    : 'w-full max-w-[98%] px-1 py-1 text-slate-200'
                }`}
              >
                {/* Fallback Notice Badge */}
                {meta.isDemonstrativeFallback && (
                  <div className="mb-2 p-2 rounded bg-amber-950/50 border border-amber-800/60 text-[11px] text-amber-300 flex items-start gap-1.5">
                    <AlertTriangle size={13} className="shrink-0 mt-0.5 text-amber-400" />
                    <span>
                      Modo Demonstrativo local. Configure credenciais em <strong>Provedores</strong> para chamadas reais.
                    </span>
                  </div>
                )}

                {/* Validation Error Badge */}
                {meta.hasErrors && (
                  <div className="mb-2 p-2.5 rounded bg-rose-950/60 border border-rose-800/70 text-[11px] text-rose-300 flex items-start gap-2">
                    <AlertTriangle size={14} className="shrink-0 mt-0.5 text-rose-400" />
                    <div>
                      <div className="font-semibold text-rose-200">Validação Estruturada Rejeitada</div>
                      <div className="text-rose-300/90 text-[10px] mt-0.5">
                        {meta.errorMessage ||
                          'A resposta do modelo não contém estrutura válida de arquivos. Nenhuma alteração foi aplicada.'}
                      </div>
                    </div>
                  </div>
                )}

                {shouldRenderPlanCard ? <PlanResponseCard content={msg.content} /> : <ChatMarkdown content={msg.content} />}

                {meta.validation?.status === 'failed' && (
                  <div className="mt-2 flex items-start gap-2 rounded-lg border border-rose-900/60 bg-rose-950/25 px-2.5 py-2 text-[10px] text-rose-300">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0"/>
                    <span>A revisão automática encontrou um problema e bloqueou a alteração.</span>
                  </div>
                )}
                {meta.validation && meta.validation.status !== 'failed' && (
                  <details className="mt-2 text-[10px] text-slate-600">
                    <summary className="cursor-pointer select-none hover:text-slate-400">Verificações técnicas</summary>
                    <div className="mt-1.5 space-y-1 border-l border-slate-800 pl-2">
                      <div className={meta.validation.status==='passed'?'text-emerald-500':'text-amber-500'}>
                        {meta.validation.status==='passed'?'Validação concluída':'Validação parcial'}
                      </div>
                      {Array.isArray(meta.validation.results) && meta.validation.results.map((item:any)=><div key={item.tool} className="flex max-w-xs justify-between gap-4"><span>{item.tool}</span><span>{item.status}</span></div>)}
                    </div>
                  </details>
                )}

                {/* Legacy manual proposal controls; completed proposals stay in technical details only. */}
                {hasProposal && proposal && proposal.status === 'pending' && (
                  <div
                    id={`proposal-card-${proposal.id}`}
                    className="mt-3 rounded-xl border border-cyan-900/60 bg-slate-950/60 p-3 space-y-2.5"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-cyan-300">
                        <Code2 size={13}/>
                        <span>Alterações prontas para aplicar</span>
                      </div>
                      <span className="text-[10px] text-slate-500">{proposal.files.length} arquivo(s)</span>
                    </div>
                    <div className="text-[11px] text-slate-400">{proposal.summary}</div>
                    <button
                      type="button"
                      onClick={() => toggleDiff(msg.id)}
                      className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-cyan-300"
                    >
                      {isDiffOpen ? <ChevronUp size={12}/> : <ChevronDown size={12}/>}
                      {isDiffOpen ? 'Ocultar detalhes' : 'Ver detalhes técnicos'}
                    </button>
                    {isDiffOpen && (
                      <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-slate-800 bg-slate-900/70 p-2 font-mono text-[10px]">
                        {proposal.files.map((file:FileChangeProposal)=><div key={file.path}>
                          <div className="text-cyan-400">[{file.action.toUpperCase()}] {file.path}</div>
                          <pre className="mt-1 whitespace-pre-wrap text-slate-500">{file.diff || `${String(file.content||'').slice(0,150)}...`}</pre>
                        </div>)}
                      </div>
                    )}
                    {onApplyProposal && (
                      <div className="flex gap-2 pt-1">
                        <button type="button" id={`btn-apply-proposal-${proposal.id}`} onClick={() => onApplyProposal(proposal)} disabled={executionBusy} className="flex-1 rounded-lg bg-cyan-600 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-500 disabled:opacity-50">
                          Aplicar alterações
                        </button>
                        {onRejectProposal&&<button type="button" onClick={()=>onRejectProposal(proposal)} disabled={executionBusy} className="rounded-lg border border-slate-800 px-3 py-2 text-xs text-slate-400 hover:border-rose-800 hover:text-rose-300">Rejeitar</button>}
                      </div>
                    )}
                  </div>
                )}
                {hasProposal && proposal && proposal.status !== 'pending' && (
                  <details className="mt-2 text-[10px] text-slate-600">
                    <summary className="cursor-pointer select-none hover:text-slate-400">Arquivos e alterações</summary>
                    <div className="mt-1.5 space-y-1 border-l border-slate-800 pl-2 font-mono">
                      {proposal.files.map((file:FileChangeProposal)=><div key={file.path} className="truncate">{file.action} · {file.path}</div>)}
                    </div>
                  </details>
                )}

                {filesAffected.length > 0 && !hasProposal && (
                  <details className="mt-2 text-[10px] text-slate-600">
                    <summary className="cursor-pointer select-none hover:text-slate-400">Arquivos alterados ({filesAffected.length})</summary>
                    <div className="mt-1.5 space-y-1 border-l border-slate-800 pl-2 font-mono">
                      {filesAffected.map((file:string)=><div key={file} className="truncate">{file}</div>)}
                    </div>
                  </details>
                )}
              </div>
            </div>
          );
        })}

        {/* Active Plan Approval Box if in plan mode */}
        {activeMode === 'plan' && activePlan && activePlan.status === 'draft' && (
          <div
            id="plan-approval-box"
            className="p-3.5 rounded-xl bg-slate-900/90 border border-amber-800/60 space-y-2.5 shadow-sm"
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-amber-400 flex items-center gap-1.5">
                <Sparkles size={13} />
                Plano Técnico Aguardando Aprovação
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-950 text-amber-300 font-mono border border-amber-800">
                Rascunho
              </span>
            </div>
            <p className="text-xs text-slate-300">{activePlan.objective}</p>
            <div className="text-[11px] text-slate-400 space-y-1">
              <div>
                <strong className="text-slate-300">Escopo:</strong> {activePlan.scope_in}
              </div>
            </div>
            <div className="pt-2 flex gap-2">
              <button
                type="button"
                id="btn-approve-plan"
                onClick={() => onApprovePlan(activePlan.id)}
                disabled={executionBusy}
                className="flex-1 py-1.5 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer"
              >
                <CheckCircle2 size={14} />
                Aprovar Plano & Construir
              </button>
            </div>
          </div>
        )}

        {/* Conversational agent activity */}
        {(isLoading || activeAgentRunStatus === 'running' || ((activeAgentRunStatus === 'failed' || activeAgentRunStatus === 'aborted') && activeAgentTrace.length > 0)) && (
          <div className="px-1 py-2 text-[11px] text-slate-400">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex items-center gap-2 text-slate-300">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activeAgentRunStatus==='failed'?'bg-rose-400':activeAgentRunStatus==='aborted'?'bg-slate-500':'bg-cyan-400 animate-pulse'}`}/>
                  <span>{
                    activeAgentRunStatus === 'failed'
                      ? 'A execução encontrou um problema. O progresso concluído foi preservado.'
                      : activeAgentRunStatus === 'aborted'
                        ? 'A execução foi interrompida. O progresso concluído foi preservado.'
                        : 'Trabalhando no seu pedido…'
                  }</span>
                  {activeAgentRun?.created_at&&<span className="font-mono text-[9px] text-slate-600">{elapsed(activeAgentRun.created_at,activeAgentRun.status==='running'?null:activeAgentRun.finished_at)}</span>}
                </div>
                {Array.isArray(activeAgentTrace) && activeAgentTrace.length > 0 && (
                  <div className="space-y-1 pl-3.5">
                    {activeAgentTrace.map((step:any) => {
                      const labels:Record<string,string>={
                        SCOUT:'Analisando projeto e requisitos',
                        STUDIO:'Definindo direção visual e experiência',
                        FORGE:'Construindo e corrigindo a implementação',
                        SENTINEL:'Revisando qualidade e possíveis falhas',
                        SHIP:'Preparando publicação',
                      };
                      const tone=step.status==='completed'?'text-emerald-400':step.status==='failed'?'text-rose-400':step.status==='aborted'?'text-slate-600':'text-cyan-300';
                      const symbol=step.status==='completed'?'✓':step.status==='failed'?'!':step.status==='aborted'?'–':'•';
                      return <div key={step.id} className="flex items-center gap-2">
                        <span className={`w-3 text-center ${tone}`}>{symbol}</span>
                        <span className={step.status==='running'?'text-slate-300':'text-slate-500'}>{labels[step.agent_key]||step.title||step.agent_key}</span>
                      </div>;
                    })}
                  </div>
                )}
              </div>
              {activeAgentRunStatus === 'running' || isLoading ? (
                <button
                  type="button"
                  id="btn-abort-request"
                  onClick={onAbort}
                  className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-900 hover:text-rose-400 transition cursor-pointer"
                  title="Interromper execução"
                >
                  <Square size={14} fill="currentColor" />
                </button>
              ) : (activeAgentRunStatus === 'failed' || activeAgentRunStatus === 'aborted') && onContinueRun ? (
                <button
                  type="button"
                  onClick={onContinueRun}
                  className="shrink-0 rounded-lg border border-slate-800 px-2.5 py-1.5 text-[10px] font-medium text-slate-300 hover:border-cyan-800 hover:text-cyan-300"
                >
                  Continuar
                </button>
              ) : null}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Form with Skills Picker */}
      <form onSubmit={handleSubmit} className="p-3 border-t border-slate-800/80 bg-slate-900/40 space-y-2">
        {/* Selected skills pills */}
        {selectedSkills.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1">
            {selectedSkills.map((slug) => {
              const skillObj = availableSkills.find((s) => s.slug === slug);
              return (
                <span
                  key={slug}
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-cyan-950/80 border border-cyan-800/60 text-[10px] text-cyan-300 font-medium"
                >
                  <span>{skillObj?.name || slug}</span>
                  <button
                    type="button"
                    onClick={() => toggleSkill(slug)}
                    className="hover:text-cyan-100 cursor-pointer text-cyan-400"
                  >
                    <X size={10} />
                  </button>
                </span>
              );
            })}
          </div>
        )}

        {showSkillPicker && (
          <div className="p-2 rounded-lg bg-slate-900 border border-slate-800 max-h-36 overflow-y-auto custom-scrollbar space-y-1 text-xs">
            <div className="text-[10px] font-semibold text-slate-400 px-1 uppercase tracking-wider">Skills do Agente:</div>
            {availableSkills.map((s) => {
              const isSel = selectedSkills.includes(s.slug);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggleSkill(s.slug)}
                  className={`w-full text-left px-2 py-1.5 rounded-md text-[11px] flex items-center justify-between transition cursor-pointer ${
                    isSel ? 'bg-cyan-950 text-cyan-300 border border-cyan-800/60' : 'text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  <span className="font-medium">{s.name}</span>
                  <span className="text-[10px] text-slate-400 font-mono">{s.slug}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="relative flex items-center">
          <textarea
            id="chat-input-textarea"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
            disabled={!canSend}
            placeholder={canSend ? 'Digite seu pedido... (Ex: crie uma tela de login, explique a arquitetura)' : 'Crie ou selecione um projeto para iniciar a conversa'}
            rows={2}
            className="w-full pl-3 pr-20 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-600 resize-none"
          />

          <div className="absolute right-2 bottom-2.5 flex items-center gap-1">
            <button
              type="button"
              id="btn-toggle-skills-picker"
              onClick={() => setShowSkillPicker(!showSkillPicker)}
              className="p-1 text-slate-400 hover:text-cyan-400 rounded transition cursor-pointer"
              title="Adicionar skills de contexto (@skill)"
            >
              <Sparkles size={14} />
            </button>
            <button
              type="submit"
              id="btn-send-message"
              disabled={!inputText.trim() || executionBusy || !canSend}
              className="p-1.5 rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-30 disabled:pointer-events-none text-slate-950 font-bold transition cursor-pointer"
            >
              <Send size={13} />
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};

