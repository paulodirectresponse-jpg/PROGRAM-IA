import React, { useState } from 'react';
import { X, GitBranch, Cpu, CheckCircle2, AlertCircle, RefreshCw, ExternalLink } from 'lucide-react';
import { GitHubStatus, Provider } from '../types';

interface IntegrationsModalProps {
  isOpen: boolean;
  onClose: () => void;
  githubStatus: GitHubStatus | null;
  onRefreshGitHub: () => void;
  providers: Provider[];
}

export const IntegrationsModal: React.FC<IntegrationsModalProps> = ({
  isOpen,
  onClose,
  githubStatus,
  onRefreshGitHub,
  providers,
}) => {
  const [isRefreshing, setIsRefreshing] = useState(false);

  if (!isOpen) return null;

  const handleTestGitHub = async () => {
    setIsRefreshing(true);
    await onRefreshGitHub();
    setIsRefreshing(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl animate-fade-in flex flex-col max-h-[85vh]">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-emerald-600/20 text-emerald-400 flex items-center justify-center font-bold text-sm">
              <GitBranch size={16} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">Integrações Externas</h2>
              <p className="text-[11px] text-slate-400">Estado real de conexões com serviços de terceiros</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto flex-1 custom-scrollbar">
          {/* GitHub Integration */}
          <div className={`p-4 rounded-xl border space-y-3 ${
            githubStatus?.isConnected
              ? 'bg-emerald-950/20 border-emerald-800/60'
              : 'bg-slate-950 border-slate-800'
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <GitBranch size={16} className={githubStatus?.isConnected ? 'text-emerald-400' : 'text-purple-400'} />
                <span className="font-bold text-slate-100 text-xs">GitHub REST API</span>
              </div>
              <span className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase ${
                githubStatus?.isConnected
                  ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                  : 'bg-amber-950 text-amber-300 border border-amber-800'
              }`}>
                {githubStatus?.isConnected ? 'Conectado' : 'Pendente de Configuração'}
              </span>
            </div>

            <p className="text-xs text-slate-300">
              {githubStatus?.message || 'Verificando conexão com o GitHub...'}
            </p>

            {githubStatus?.username && (
              <div className="text-xs text-slate-400 flex items-center gap-2">
                <span>Usuário autenticado: <strong className="text-slate-200">@{githubStatus.username}</strong></span>
                {githubStatus.scopes && (
                  <span className="text-[10px] text-slate-500 font-mono">[{githubStatus.scopes.join(', ')}]</span>
                )}
              </div>
            )}

            <div className="pt-2 flex items-center justify-between border-t border-slate-800/80">
              <div className="text-[10px] text-slate-500 font-mono">Variável: GITHUB_TOKEN</div>
              <button
                onClick={handleTestGitHub}
                disabled={isRefreshing}
                className="py-1 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
              >
                <RefreshCw size={12} className={isRefreshing ? 'animate-spin' : ''} />
                Testar Conexão
              </button>
            </div>
          </div>

          {/* LLM Providers Integration Status */}
          <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu size={16} className="text-indigo-400" />
                <span className="font-bold text-slate-100 text-xs">Provedor LLM (UseOneAI / OpenAI / Gemini)</span>
              </div>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-slate-900 text-slate-300 border border-slate-800">
                Seguro no Servidor
              </span>
            </div>

            <p className="text-xs text-slate-300">
              O backend roteia chamadas de forma segura. Em caso de ausência de credenciais, o modo demonstrativo local é ativado com aviso legível.
            </p>

            <div className="space-y-1.5 pt-1 text-xs">
              {providers.map((p) => (
                <div key={p.provider_key} className="flex items-center justify-between p-2 rounded bg-slate-900/60 border border-slate-800/80">
                  <span className="text-slate-300 font-medium">{p.name}</span>
                  <span className={`text-[10px] font-mono flex items-center gap-1 ${
                    p.is_configured ? 'text-emerald-400' : 'text-amber-400'
                  }`}>
                    {p.is_configured ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}
                    {p.is_configured ? 'Configurado' : 'Não configurado'}
                  </span>
                </div>
              ))}
            </div>
          </div>
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
