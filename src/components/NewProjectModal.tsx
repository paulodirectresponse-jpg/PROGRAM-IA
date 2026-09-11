import React, { useState } from 'react';
import { X, Sparkles, FolderPlus, GitBranch, Upload, ArrowRight } from 'lucide-react';

interface NewProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateProject: (data: { name: string; description: string; origin: 'novo' | 'local' | 'github'; repo_url?: string }) => void;
}

export const NewProjectModal: React.FC<NewProjectModalProps> = ({ isOpen, onClose, onCreateProject }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [origin, setOrigin] = useState<'novo' | 'local' | 'github'>('novo');
  const [repoUrl, setRepoUrl] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setIsSubmitting(true);
    onCreateProject({
      name: name.trim(),
      description: description.trim(),
      origin,
      repo_url: repoUrl.trim(),
    });
    setIsSubmitting(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl animate-fade-in">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-cyan-600/20 text-cyan-400 flex items-center justify-center font-bold text-sm">
              +
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">Criar ou Importar Projeto</h2>
              <p className="text-[11px] text-slate-400">Configure o workspace inicial para o Forge Agent</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Origin selector */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-300">Modo de Início</label>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setOrigin('novo')}
                className={`p-2.5 rounded-xl border text-left transition cursor-pointer ${
                  origin === 'novo'
                    ? 'bg-cyan-950/60 border-cyan-600 text-cyan-200'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <FolderPlus size={16} className="mb-1.5 text-cyan-400" />
                <div className="text-xs font-bold">Do Zero</div>
                <div className="text-[10px] text-slate-400 mt-0.5">Template web inicial</div>
              </button>

              <button
                type="button"
                onClick={() => setOrigin('github')}
                className={`p-2.5 rounded-xl border text-left transition cursor-pointer ${
                  origin === 'github'
                    ? 'bg-cyan-950/60 border-cyan-600 text-cyan-200'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <GitBranch size={16} className="mb-1.5 text-purple-400" />
                <div className="text-xs font-bold">GitHub</div>
                <div className="text-[10px] text-slate-400 mt-0.5">Repositório remoto</div>
              </button>

              <button
                type="button"
                onClick={() => setOrigin('local')}
                className={`p-2.5 rounded-xl border text-left transition cursor-pointer ${
                  origin === 'local'
                    ? 'bg-cyan-950/60 border-cyan-600 text-cyan-200'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <Upload size={16} className="mb-1.5 text-amber-400" />
                <div className="text-xs font-bold">Arquivo / ZIP</div>
                <div className="text-[10px] text-slate-400 mt-0.5">Importação local</div>
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-300">Nome do Projeto *</label>
            <input
              type="text"
              required
              placeholder="Ex: SaaS Landing Page, Calculadora Financeira..."
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-300">Objetivo / Descrição</label>
            <textarea
              rows={2}
              placeholder="Descreva o que você deseja que a aplicação faça..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500 resize-none"
            />
          </div>

          {origin === 'github' && (
            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-300">URL do Repositório GitHub</label>
              <input
                type="text"
                placeholder="https://github.com/usuario/meu-repo"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500 font-mono"
              />
            </div>
          )}

          {origin === 'local' && (
            <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-400 space-y-1">
              <div className="text-slate-300 font-semibold">Nota da Versão Web:</div>
              <div>Aplicações em navegador operam em sandbox. O workspace será criado imediatamente e você poderá colar ou enviar seus arquivos na aba Arquivos.</div>
            </div>
          )}

          <div className="pt-2 flex justify-end gap-2 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200 transition cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={!name.trim() || isSubmitting}
              className="px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-slate-950 text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
            >
              <span>Criar Workspace</span>
              <ArrowRight size={13} />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
