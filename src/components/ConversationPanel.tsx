import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  Sparkles,
  FileCode2,
  CheckCircle2,
  AlertTriangle,
  Play,
  RotateCcw,
  Square,
  Shield,
  Layers,
  ArrowRight,
  Info,
  Clock,
  Terminal,
} from 'lucide-react';
import { Message, AgentMode, Skill, Plan } from '../types';

interface ConversationPanelProps {
  messages: Message[];
  activeMode: AgentMode;
  onChangeMode: (m: AgentMode) => void;
  onSendMessage: (text: string, skills: string[]) => void;
  onApprovePlan: (planId: string) => void;
  activePlan: Plan | null;
  isLoading: boolean;
  onAbort: () => void;
  availableSkills: Skill[];
}

export const ConversationPanel: React.FC<ConversationPanelProps> = ({
  messages,
  activeMode,
  onChangeMode,
  onSendMessage,
  onApprovePlan,
  activePlan,
  isLoading,
  onAbort,
  availableSkills,
}) => {
  const [inputText, setInputText] = useState('');
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || isLoading) return;

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

  const getModeBadge = (mode: AgentMode) => {
    switch (mode) {
      case 'plan':
        return { label: 'Planejar', color: 'bg-amber-950/80 text-amber-300 border-amber-800/60' };
      case 'build':
        return { label: 'Construir', color: 'bg-cyan-950/80 text-cyan-300 border-cyan-800/60' };
      case 'review':
        return { label: 'Revisar', color: 'bg-emerald-950/80 text-emerald-300 border-emerald-800/60' };
      case 'publish':
        return { label: 'Publicar', color: 'bg-purple-950/80 text-purple-300 border-purple-800/60' };
    }
  };

  return (
    <div
      id="conversation-panel"
      className="w-96 min-w-[340px] max-w-[420px] bg-slate-950 border-r border-slate-800/80 flex flex-col h-full shrink-0 select-text"
    >
      {/* Top Mode Selector Bar */}
      <div className="p-3 border-b border-slate-800/80 bg-slate-900/40">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            <Terminal size={13} className="text-cyan-400" />
            Modo do Agente
          </span>
          <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${getModeBadge(activeMode).color}`}>
            {getModeBadge(activeMode).label}
          </span>
        </div>

        {/* 4 Mode Tabs */}
        <div className="grid grid-cols-4 gap-1 p-1 bg-slate-950 rounded-lg border border-slate-800">
          {(['plan', 'build', 'review', 'publish'] as AgentMode[]).map((mode) => {
            const isSelected = activeMode === mode;
            const labels: Record<AgentMode, string> = {
              plan: 'Planejar',
              build: 'Construir',
              review: 'Revisar',
              publish: 'Publicar',
            };
            return (
              <button
                key={mode}
                id={`btn-mode-${mode}`}
                onClick={() => onChangeMode(mode)}
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

      {/* Messages Stream */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar text-xs">
        {messages.map((msg) => {
          const isUser = msg.sender === 'user';
          const meta = msg.metadata || (msg.metadata_json ? JSON.parse(msg.metadata_json) : {});

          return (
            <div
              key={msg.id}
              id={`message-${msg.id}`}
              className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
            >
              <div className="flex items-center gap-1.5 mb-1 text-[10px] text-slate-500 font-mono">
                <span>{isUser ? 'Você' : 'Forge Agent'}</span>
                {meta.mode && (
                  <span className="text-slate-600">• [{meta.mode.toUpperCase()}]</span>
                )}
                {meta.providerUsed && (
                  <span className="text-slate-600">• {meta.providerUsed}</span>
                )}
              </div>

              <div
                className={`max-w-[92%] rounded-xl p-3 leading-relaxed whitespace-pre-wrap ${
                  isUser
                    ? 'bg-cyan-950/70 border border-cyan-800/60 text-slate-100 rounded-br-xs'
                    : 'bg-slate-900/90 border border-slate-800 text-slate-200 rounded-bl-xs shadow-sm'
                }`}
              >
                {/* Fallback Notice Badge if triggered */}
                {meta.isDemonstrativeFallback && (
                  <div className="mb-2 p-2 rounded bg-amber-950/50 border border-amber-800/60 text-[11px] text-amber-300 flex items-start gap-1.5">
                    <AlertTriangle size={13} className="shrink-0 mt-0.5 text-amber-400" />
                    <span>
                      Modo Demonstrativo local. Configure credenciais em <strong>Provedores</strong> para chamadas reais.
                    </span>
                  </div>
                )}

                <div>{msg.content}</div>

                {/* Chips of affected files */}
                {meta.filesAffected && meta.filesAffected.length > 0 && (
                  <div className="mt-2.5 pt-2 border-t border-slate-800/80 flex flex-wrap gap-1">
                    {meta.filesAffected.map((f: string) => (
                      <span
                        key={f}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-950 border border-slate-800 text-[10px] text-cyan-400 font-mono"
                      >
                        <FileCode2 size={11} />
                        {f}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Active Plan Approval Box if in plan mode */}
        {activePlan && activePlan.status === 'draft' && (
          <div
            id="plan-approval-box"
            className="p-3.5 rounded-xl bg-slate-900/90 border border-amber-800/60 space-y-2.5 shadow-sm"
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-amber-400 flex items-center gap-1.5">
                <Sparkles size={13} />
                Plano Técnico Aguardando Aprovação
              </span>
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-950 text-amber-300 font-mono border border-amber-800">
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
                id="btn-approve-plan"
                onClick={() => onApprovePlan(activePlan.id)}
                disabled={isLoading}
                className="flex-1 py-1.5 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer"
              >
                <CheckCircle2 size={14} />
                Aprovar Plano & Construir
              </button>
            </div>
          </div>
        )}

        {/* Loading Indicator with Abort Button */}
        {isLoading && (
          <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 flex items-center justify-between text-xs text-cyan-300">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping"></span>
              <span>Processando {activeMode}...</span>
            </div>
            <button
              id="btn-abort-execution"
              onClick={onAbort}
              className="px-2 py-1 text-[11px] text-rose-400 hover:bg-rose-950/60 rounded border border-rose-800/60 flex items-center gap-1 transition cursor-pointer"
            >
              <Square size={11} /> Interromper
            </button>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Selected Skills Chips */}
      {selectedSkills.length > 0 && (
        <div className="px-3 py-1.5 bg-slate-900/50 border-t border-slate-900 flex flex-wrap gap-1">
          {selectedSkills.map((slug) => (
            <span
              key={slug}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-950/80 border border-amber-800/60 text-[10px] text-amber-300"
            >
              @{slug}
              <button
                onClick={() => toggleSkill(slug)}
                className="hover:text-amber-100 ml-0.5 cursor-pointer"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Skill Picker dropdown toggle */}
      {showSkillPicker && (
        <div className="p-2.5 bg-slate-900 border-t border-slate-800 space-y-1.5 max-h-40 overflow-y-auto custom-scrollbar">
          <div className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">
            Selecione Skills para anexar à mensagem:
          </div>
          <div className="grid grid-cols-2 gap-1">
            {availableSkills.map((s) => {
              const active = selectedSkills.includes(s.slug);
              return (
                <button
                  key={s.slug}
                  onClick={() => toggleSkill(s.slug)}
                  className={`text-left p-1.5 rounded text-[11px] border transition cursor-pointer ${
                    active
                      ? 'bg-amber-950/60 border-amber-700 text-amber-200'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="font-semibold truncate">@{s.slug}</div>
                  <div className="text-[9px] text-slate-500 truncate">{s.name}</div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Input Box */}
      <form onSubmit={handleSubmit} className="p-3 border-t border-slate-800/80 bg-slate-950 space-y-2">
        <div className="relative">
          <textarea
            id="chat-input"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
            placeholder={`No modo ${getModeBadge(activeMode).label}: descreva funcionalidades, use @skill...`}
            rows={3}
            disabled={isLoading}
            className="w-full p-2.5 pr-8 rounded-xl bg-slate-900/90 border border-slate-800 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500/80 resize-none"
          />

          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              id="btn-toggle-skill-picker"
              onClick={() => setShowSkillPicker(!showSkillPicker)}
              className="text-[11px] text-amber-400 hover:text-amber-300 flex items-center gap-1 transition cursor-pointer"
            >
              <Sparkles size={13} />
              <span>{selectedSkills.length > 0 ? `${selectedSkills.length} skills ativas` : '+ @skill'}</span>
            </button>

            <button
              type="submit"
              id="btn-send-message"
              disabled={!inputText.trim() || isLoading}
              className="py-1 px-3 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-slate-950 font-bold text-xs flex items-center gap-1.5 transition cursor-pointer"
            >
              <span>Enviar</span>
              <Send size={12} />
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};
