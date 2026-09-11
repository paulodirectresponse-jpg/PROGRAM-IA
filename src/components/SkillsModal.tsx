import React from 'react';
import { X, Sparkles, Check, ToggleLeft, ToggleRight, ShieldAlert, Code2, Paintbrush } from 'lucide-react';
import { Skill } from '../types';

interface SkillsModalProps {
  isOpen: boolean;
  onClose: () => void;
  skills: Skill[];
  onToggleSkill: (skillId: string, isActive: boolean) => void;
}

export const SkillsModal: React.FC<SkillsModalProps> = ({
  isOpen,
  onClose,
  skills,
  onToggleSkill,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl animate-fade-in flex flex-col max-h-[85vh]">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-amber-600/20 text-amber-400 flex items-center justify-center font-bold text-sm">
              <Sparkles size={16} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">Skills do Workspace & Projeto</h2>
              <p className="text-[11px] text-slate-400">Instruções especializadas injetadas no contexto do agente</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-3 overflow-y-auto flex-1 custom-scrollbar">
          <div className="text-xs text-slate-400 mb-2">
            Skills ativas guiam a geração de código, verificação e qualidade do agente. Você também pode invocar qualquer skill diretamente na conversa digitando <code className="text-amber-300 font-mono">@nome-da-skill</code>.
          </div>

          <div className="space-y-2">
            {skills.map((skill) => {
              const isActive = Boolean(skill.is_active);
              return (
                <div
                  key={skill.id}
                  className={`p-3.5 rounded-xl border transition flex items-start justify-between gap-3 ${
                    isActive
                      ? 'bg-slate-950/80 border-slate-800'
                      : 'bg-slate-950/30 border-slate-900 opacity-60'
                  }`}
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-100 text-xs">{skill.name}</span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-900 text-amber-400 border border-slate-800">
                        @{skill.slug}
                      </span>
                      <span className="text-[9px] uppercase px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 font-mono">
                        {skill.scope}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400">{skill.description}</p>
                    <div className="text-[11px] text-slate-500 font-mono italic pt-1">
                      "{skill.system_instructions.slice(0, 110)}..."
                    </div>
                  </div>

                  <button
                    onClick={() => onToggleSkill(skill.id, !isActive)}
                    className="p-1 text-slate-400 hover:text-slate-200 transition cursor-pointer shrink-0 mt-0.5"
                    title={isActive ? 'Desativar skill' : 'Ativar skill'}
                  >
                    {isActive ? (
                      <ToggleRight size={26} className="text-emerald-400" />
                    ) : (
                      <ToggleLeft size={26} className="text-slate-600" />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="p-3 border-t border-slate-800 flex justify-end shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition cursor-pointer"
          >
            Concluir
          </button>
        </div>
      </div>
    </div>
  );
};
