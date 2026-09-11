import React, { useState, useEffect } from 'react';
import { X, Trash2, AlertTriangle, Loader2, FolderX, CheckCircle2 } from 'lucide-react';
import { Project } from '../types';

interface DeleteProjectModalProps {
  isOpen: boolean;
  project: Project | null;
  onClose: () => void;
  onConfirmDelete: (projectId: string) => Promise<boolean | void>;
}

export const DeleteProjectModal: React.FC<DeleteProjectModalProps> = ({
  isOpen,
  project,
  onClose,
  onConfirmDelete,
}) => {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setError(null);
      setIsDeleting(false);
    }
  }, [isOpen, project?.id]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen && !isDeleting) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isDeleting, onClose]);

  if (!isOpen || !project) return null;

  const handleDelete = async () => {
    setIsDeleting(true);
    setError(null);
    try {
      const result = await onConfirmDelete(project.id);
      if (result === false) {
        setError('Não foi possível excluir o projeto. Verifique suas permissões.');
        setIsDeleting(false);
      } else {
        // Successful deletion closes modal
        onClose();
      }
    } catch (err: any) {
      setError(err?.message || 'Erro inesperado ao excluir o projeto.');
      setIsDeleting(false);
    }
  };

  return (
    <div
      id="delete-project-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isDeleting) {
          onClose();
        }
      }}
    >
      <div
        id="delete-project-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-modal-title"
        className="relative w-full max-w-md bg-slate-900 border border-slate-800 rounded-xl shadow-2xl p-6 text-slate-100 overflow-hidden"
      >
        {/* Top accent border */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-rose-500" />

        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-rose-950/60 border border-rose-800/80 text-rose-400 flex items-center justify-center shrink-0">
              <Trash2 size={20} />
            </div>
            <div>
              <h2 id="delete-modal-title" className="text-base font-semibold text-slate-100">
                Excluir Projeto
              </h2>
              <p className="text-xs text-slate-400">Esta ação é permanente e irreversível</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isDeleting}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition disabled:opacity-50 cursor-pointer"
            aria-label="Fechar"
          >
            <X size={18} />
          </button>
        </div>

        {/* Project info card */}
        <div className="p-3 bg-slate-950/70 rounded-lg border border-slate-800/80 mb-4 space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">Nome do projeto:</span>
            <span className="font-semibold text-slate-200 max-w-[200px] truncate" title={project.name}>
              {project.name}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">Branch ativa:</span>
            <span className="font-mono text-cyan-400">{project.branch || 'main'}</span>
          </div>
          {project.repo_url && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">Origem:</span>
              <span className="text-purple-400 font-mono text-[11px] truncate max-w-[180px]">
                {project.repo_url}
              </span>
            </div>
          )}
        </div>

        {/* Warning bullet points */}
        <div className="p-3 bg-rose-950/20 rounded-lg border border-rose-900/40 text-rose-300 text-xs space-y-1.5 mb-5">
          <div className="flex items-center gap-1.5 font-semibold text-rose-200">
            <AlertTriangle size={14} className="shrink-0 text-rose-400" />
            <span>O que será removido:</span>
          </div>
          <ul className="list-disc list-inside space-y-0.5 text-rose-300/90 text-[11px] pl-1">
            <li>Todos os arquivos de código-fonte no workspace</li>
            <li>Histórico completo de mensagens e conversas com o agente</li>
            <li>Todos os checkpoints e branches locais</li>
            <li>Registros de verificação e quality gates</li>
          </ul>
        </div>

        {/* Error message */}
        {error && (
          <div className="p-2.5 mb-4 rounded-lg bg-rose-950/40 border border-rose-800 text-xs text-rose-200 flex items-center gap-2">
            <AlertTriangle size={14} className="shrink-0 text-rose-400" />
            <span>{error}</span>
          </div>
        )}

        {/* Modal action buttons */}
        <div className="flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={isDeleting}
            className="px-4 py-2 rounded-lg text-xs font-medium text-slate-300 hover:text-slate-100 hover:bg-slate-800 transition disabled:opacity-50 cursor-pointer"
          >
            Cancelar
          </button>
          <button
            type="button"
            id="btn-confirm-delete-project"
            onClick={handleDelete}
            disabled={isDeleting}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-950/50 flex items-center gap-2 transition disabled:opacity-50 cursor-pointer"
          >
            {isDeleting ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                <span>Excluindo...</span>
              </>
            ) : (
              <>
                <Trash2 size={14} />
                <span>Sim, Excluir Projeto</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
