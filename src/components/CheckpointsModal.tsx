import React from 'react';
import { X, History, RotateCcw, CheckCircle2, Clock } from 'lucide-react';
import { Checkpoint } from '../types';

interface CheckpointsModalProps {
  isOpen: boolean;
  onClose: () => void;
  checkpoints: Checkpoint[];
  currentCheckpointId?: string;
  onRestoreCheckpoint: (checkpointId: string) => void;
}

export const CheckpointsModal: React.FC<CheckpointsModalProps> = ({
  isOpen,
  onClose,
  checkpoints,
  currentCheckpointId,
  onRestoreCheckpoint,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl animate-fade-in flex flex-col max-h-[80vh]">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-blue-600/20 text-blue-400 flex items-center justify-center font-bold text-sm">
              <History size={16} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">Checkpoints & Histórico de Versões</h2>
              <p className="text-[11px] text-slate-400">Restaure qualquer snapshot anterior do workspace</p>
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
          {checkpoints.length === 0 ? (
            <div className="text-xs text-slate-500 text-center py-6">Nenhum checkpoint registrado ainda.</div>
          ) : (
            <div className="space-y-2">
              {checkpoints.map((cp, idx) => {
                const isCurrent = currentCheckpointId === cp.id || idx === 0;
                return (
                  <div
                    key={cp.id}
                    className={`p-3.5 rounded-xl border flex items-center justify-between gap-3 ${
                      isCurrent
                        ? 'bg-blue-950/30 border-blue-800/60'
                        : 'bg-slate-950/80 border-slate-800'
                    }`}
                  >
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-100 text-xs">{cp.title}</span>
                        {isCurrent && (
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-blue-950 text-blue-400 border border-blue-800">
                            Atual
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400">{cp.description || 'Snapshot automático de arquivos'}</p>
                      <div className="text-[10px] text-slate-500 flex items-center gap-1 font-mono pt-1">
                        <Clock size={10} />
                        {new Date(cp.created_at).toLocaleString()}
                      </div>
                    </div>

                    {!isCurrent && (
                      <button
                        onClick={() => {
                          onRestoreCheckpoint(cp.id);
                          onClose();
                        }}
                        className="py-1 px-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer shrink-0"
                      >
                        <RotateCcw size={12} />
                        Restaurar
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="p-3 border-t border-slate-800 flex justify-end shrink-0">
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
