import React, { useState } from 'react';
import { X, History, RotateCcw, Plus, Clock, Tag, FileText, CheckCircle2, AlertCircle } from 'lucide-react';
import { Checkpoint } from '../types';

interface CheckpointsModalProps {
  isOpen: boolean;
  onClose: () => void;
  checkpoints: Checkpoint[];
  currentCheckpointId?: string;
  onRestoreCheckpoint: (checkpointId: string) => void;
  onRollbackPrevious?: () => void;
  projectId?: string;
  onRefreshCheckpoints?: () => void;
}

export const CheckpointsModal: React.FC<CheckpointsModalProps> = ({
  isOpen,
  onClose,
  checkpoints,
  currentCheckpointId,
  onRestoreCheckpoint,
  onRollbackPrevious,
  projectId,
  onRefreshCheckpoints,
}) => {
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [versionTitle, setVersionTitle] = useState('');
  const [versionDesc, setVersionDesc] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleCreateNamedVersion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || !versionTitle.trim()) return;

    setIsSaving(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/checkpoints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: versionTitle.trim(),
          description: versionDesc.trim() || 'Versão nomeada manualmente pelo usuário',
        }),
      });
      const data = await res.json();
      if (res.ok && data.checkpointId) {
        setVersionTitle('');
        setVersionDesc('');
        setShowCreateForm(false);
        if (onRefreshCheckpoints) onRefreshCheckpoints();
      } else {
        setErrorMsg(data.error || 'Falha ao salvar versão nomeada.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Erro ao conectar ao servidor.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl animate-fade-in flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-600/20 text-blue-400 flex items-center justify-center font-bold text-sm">
              <History size={18} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                Histórico de Versões & Restauração
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                  {checkpoints.length} {checkpoints.length === 1 ? 'versão' : 'versões'}
                </span>
              </h2>
              <p className="text-[11px] text-slate-400">
                Cada versão registra detalhadamente o que foi alterado e pode ser restaurada com um clique.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Quick Actions Bar */}
        <div className="px-5 py-3 bg-slate-950/60 border-b border-slate-800 flex items-center justify-between gap-3 shrink-0 flex-wrap">
          <div className="flex items-center gap-2">
            {onRollbackPrevious && checkpoints.length >= 2 && (
              <button
                type="button"
                id="btn-rollback-prev-modal"
                onClick={() => {
                  onRollbackPrevious();
                  onClose();
                }}
                className="px-3 py-1.5 rounded-lg bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/40 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
              >
                <RotateCcw size={13} />
                Restaurar Versão Anterior
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-slate-950 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer shadow-sm"
          >
            <Plus size={13} />
            {showCreateForm ? 'Cancelar' : 'Criar Nova Versão Nomeada'}
          </button>
        </div>

        {/* Create Named Version Form */}
        {showCreateForm && (
          <form
            onSubmit={handleCreateNamedVersion}
            className="p-4 bg-slate-950/90 border-b border-cyan-900/40 space-y-3 shrink-0 animate-in fade-in duration-150"
          >
            <div className="flex items-center gap-2 text-xs font-semibold text-cyan-300">
              <Tag size={14} />
              Registrar Nova Versão (Snapshot do Workspace)
            </div>

            {errorMsg && (
              <div className="p-2 rounded-lg bg-rose-950/40 border border-rose-800 text-rose-300 text-xs flex items-center gap-2">
                <AlertCircle size={14} className="shrink-0" />
                {errorMsg}
              </div>
            )}

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-slate-300 flex items-center gap-1">
                Nome da Versão <span className="text-rose-400">*</span>
              </label>
              <input
                type="text"
                value={versionTitle}
                onChange={(e) => setVersionTitle(e.target.value)}
                placeholder="Ex: v1.1.0 - Suporte a novos cards de produto"
                required
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-hidden focus:border-cyan-500"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-slate-300 flex items-center gap-1">
                O que esta atualização fez? (Descrição detalhada)
              </label>
              <textarea
                value={versionDesc}
                onChange={(e) => setVersionDesc(e.target.value)}
                placeholder="Descreva as alterações efetuadas (ex: ajustada a responsividade mobile e integrado o endpoint de checkout)"
                rows={2}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-hidden focus:border-cyan-500 resize-none"
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowCreateForm(false)}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={isSaving || !versionTitle.trim()}
                className="px-3.5 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 cursor-pointer shadow-sm"
              >
                <CheckCircle2 size={13} />
                {isSaving ? 'Salvando...' : 'Salvar Ponto de Versão'}
              </button>
            </div>
          </form>
        )}

        {/* Checkpoints List */}
        <div className="p-5 space-y-3 overflow-y-auto flex-1 custom-scrollbar">
          {checkpoints.length === 0 ? (
            <div className="text-center py-10 space-y-2">
              <div className="w-10 h-10 rounded-full bg-slate-800 text-slate-500 flex items-center justify-center mx-auto">
                <History size={20} />
              </div>
              <div className="text-xs text-slate-400 font-medium">Nenhum histórico de versão registrado ainda.</div>
              <p className="text-[11px] text-slate-500 max-w-xs mx-auto">
                Versões são criadas automaticamente a cada sincronização no GitHub, comandos do assistente ou manualmente acima.
              </p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {checkpoints.map((cp, idx) => {
                const isCurrent = currentCheckpointId === cp.id || idx === 0;
                return (
                  <div
                    key={cp.id}
                    className={`p-3.5 rounded-xl border flex items-start justify-between gap-3 transition ${
                      isCurrent
                        ? 'bg-blue-950/25 border-blue-700/60 shadow-xs'
                        : 'bg-slate-950/70 border-slate-800/90 hover:border-slate-700'
                    }`}
                  >
                    <div className="space-y-1 min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-slate-100 text-xs break-words">
                          {cp.title}
                        </span>
                        {isCurrent && (
                          <span className="text-[10px] font-mono px-2 py-0.2 rounded-full bg-blue-900/60 text-blue-300 border border-blue-700/80">
                            Versão Atual
                          </span>
                        )}
                      </div>

                      {cp.description && (
                        <p className="text-[11px] text-slate-300/90 leading-relaxed bg-slate-900/50 p-2 rounded-lg border border-slate-800/60">
                          {cp.description}
                        </p>
                      )}

                      <div className="text-[10px] text-slate-500 flex items-center gap-1.5 font-mono pt-0.5">
                        <Clock size={11} />
                        {new Date(cp.created_at).toLocaleString('pt-BR')}
                      </div>
                    </div>

                    {!isCurrent && (
                      <button
                        type="button"
                        onClick={() => {
                          onRestoreCheckpoint(cp.id);
                          onClose();
                        }}
                        className="py-1.5 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer shrink-0 border border-slate-700 hover:border-slate-600"
                        title="Restaurar esta versão de arquivos"
                      >
                        <RotateCcw size={12} className="text-cyan-400" />
                        Restaurar
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-slate-800 flex justify-between items-center shrink-0 bg-slate-950/40">
          <div className="text-[11px] text-slate-500">
            Dica: Ao restaurar, todos os arquivos voltam para o estado exato daquela versão.
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition cursor-pointer"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
};
