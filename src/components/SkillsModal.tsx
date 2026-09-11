import React, { useState } from 'react';
import { X, Sparkles, Check, ToggleLeft, ToggleRight, Plus, Trash2, ShieldAlert, Code2, Paintbrush, AlertCircle, ArrowLeft } from 'lucide-react';
import { Skill } from '../types';

interface SkillsModalProps {
  isOpen: boolean;
  onClose: () => void;
  skills: Skill[];
  onToggleSkill: (skillId: string, isActive: boolean) => void;
  onCreateSkill?: (skillData: {
    name: string;
    slug?: string;
    description: string;
    system_instructions: string;
    scope: 'message' | 'project' | 'workspace';
  }) => Promise<boolean>;
  onDeleteSkill?: (skillId: string) => Promise<boolean>;
}

export const SkillsModal: React.FC<SkillsModalProps> = ({
  isOpen,
  onClose,
  skills,
  onToggleSkill,
  onCreateSkill,
  onDeleteSkill,
}) => {
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [scope, setScope] = useState<'project' | 'workspace'>('project');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setFormError('O nome da skill é obrigatório.');
      return;
    }
    if (!instructions.trim()) {
      setFormError('As instruções do sistema para o agente são obrigatórias.');
      return;
    }

    setFormError(null);
    setIsSubmitting(true);
    try {
      if (onCreateSkill) {
        const ok = await onCreateSkill({
          name: name.trim(),
          slug: slug.trim() || undefined,
          description: description.trim(),
          system_instructions: instructions.trim(),
          scope,
        });
        if (ok) {
          setIsCreating(false);
          setName('');
          setSlug('');
          setDescription('');
          setInstructions('');
        } else {
          setFormError('Falha ao salvar a nova skill.');
        }
      }
    } catch (err: any) {
      setFormError(err.message || 'Erro ao criar skill.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl animate-fade-in flex flex-col max-h-[88vh]">
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-amber-600/20 text-amber-400 flex items-center justify-center font-bold text-sm">
              <Sparkles size={16} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">
                {isCreating ? 'Nova Skill para o Agente' : 'Skills do Workspace & Projeto'}
              </h2>
              <p className="text-[11px] text-slate-400">
                {isCreating
                  ? 'Defina instruções especializadas e comportamento para o agente'
                  : 'Instruções personalizadas injetadas no contexto de raciocínio do agente'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!isCreating && (
              <button
                onClick={() => setIsCreating(true)}
                className="px-2.5 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium flex items-center gap-1.5 transition cursor-pointer"
              >
                <Plus size={14} />
                <span>Nova Skill</span>
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition cursor-pointer"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        {isCreating ? (
          <form onSubmit={handleCreateSubmit} className="p-5 space-y-4 overflow-y-auto flex-1 custom-scrollbar">
            {formError && (
              <div className="p-3 rounded-xl bg-red-950/40 border border-red-800/60 text-red-300 text-xs flex items-center gap-2">
                <AlertCircle size={15} className="shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs text-slate-300 font-medium">Nome da Skill *</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slug) {
                    setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-'));
                  }
                }}
                placeholder="Ex: Otimizador de Performance & Acessibilidade"
                className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-100 text-xs placeholder:text-slate-600 focus:outline-hidden focus:border-cyan-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs text-slate-300 font-medium">Slug (Identificador)</label>
                <input
                  type="text"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="ex: perf-accessibility"
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-100 text-xs placeholder:text-slate-600 focus:outline-hidden focus:border-cyan-500 font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-slate-300 font-medium">Escopo de Aplicação</label>
                <select
                  value={scope}
                  onChange={(e) => setScope(e.target.value as any)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-100 text-xs focus:outline-hidden focus:border-cyan-500 cursor-pointer"
                >
                  <option value="project">Apenas neste Projeto</option>
                  <option value="workspace">Todo o Workspace</option>
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-slate-300 font-medium">Descrição Breve</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Ex: Garante boas práticas de acessibilidade WCAG e code splitting"
                className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-100 text-xs placeholder:text-slate-600 focus:outline-hidden focus:border-cyan-500"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-slate-300 font-medium">Instruções do Sistema (Prompt da Skill) *</label>
              <p className="text-[11px] text-slate-500">
                Estas diretrizes serão estritamente incorporadas ao raciocínio e geração de código do agente.
              </p>
              <textarea
                required
                rows={5}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="Ex: Ao gerar componentes React, sempre valide contraste de cores WCAG AA, adicione tags semânticas acessíveis (aria-label, role), e divida renderizações pesadas em módulos independentes..."
                className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-100 text-xs placeholder:text-slate-600 focus:outline-hidden focus:border-cyan-500 font-mono resize-none leading-relaxed"
              />
            </div>

            <div className="pt-3 border-t border-slate-800 flex items-center justify-between">
              <button
                type="button"
                onClick={() => { setIsCreating(false); setFormError(null); }}
                className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-xs font-medium transition cursor-pointer flex items-center gap-1.5"
              >
                <ArrowLeft size={13} />
                <span>Voltar</span>
              </button>

              <button
                type="submit"
                disabled={isSubmitting}
                className="px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold transition cursor-pointer disabled:opacity-50 flex items-center gap-1.5 shadow-lg shadow-cyan-900/30"
              >
                <span>{isSubmitting ? 'Criando Skill...' : 'Salvar Skill Personalizada'}</span>
              </button>
            </div>
          </form>
        ) : (
          <div className="p-5 space-y-3 overflow-y-auto flex-1 custom-scrollbar">
            <div className="text-xs text-slate-400 mb-2 flex items-center justify-between">
              <span>Skills ativas orientam a geração de código, verificação e qualidade do agente.</span>
              <span className="text-[11px] font-mono text-slate-500">{skills.length} skills disponíveis</span>
            </div>

            <div className="space-y-2">
              {skills.map((skill) => {
                const isActive = Boolean(skill.is_active);
                const isCustom = Boolean(skill.is_custom);
                return (
                  <div
                    key={skill.id}
                    className={`p-3.5 rounded-xl border transition flex items-start justify-between gap-3 ${
                      isActive
                        ? 'bg-slate-950/80 border-slate-800'
                        : 'bg-slate-950/30 border-slate-900 opacity-60'
                    }`}
                  >
                    <div className="space-y-1 flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-slate-100 text-xs">{skill.name}</span>
                        {isCustom && (
                          <span className="text-[9px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 font-mono">
                            Personalizada
                          </span>
                        )}
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-900 text-slate-300 border border-slate-800">
                          {skill.slug}
                        </span>
                        <span className="text-[9px] uppercase px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 font-mono">
                          {skill.scope}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400">{skill.description}</p>
                      <div className="text-[11px] text-slate-500 font-mono italic pt-1 truncate">
                        "{skill.system_instructions}"
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 mt-0.5">
                      {isCustom && onDeleteSkill && (
                        <button
                          onClick={() => {
                            if (confirm(`Deseja excluir a skill personalizada "${skill.name}"?`)) {
                              onDeleteSkill(skill.id);
                            }
                          }}
                          className="p-1 text-slate-500 hover:text-red-400 hover:bg-red-950/30 rounded transition cursor-pointer"
                          title="Excluir skill personalizada"
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                      <button
                        onClick={() => onToggleSkill(skill.id, !isActive)}
                        className="p-1 text-slate-400 hover:text-slate-200 transition cursor-pointer"
                        title={isActive ? 'Desativar skill' : 'Ativar skill'}
                      >
                        {isActive ? (
                          <ToggleRight size={26} className="text-emerald-400" />
                        ) : (
                          <ToggleLeft size={26} className="text-slate-600" />
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!isCreating && (
          <div className="p-3 border-t border-slate-800 flex justify-end shrink-0">
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition cursor-pointer"
            >
              Concluir
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
