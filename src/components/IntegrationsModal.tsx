import React, { useState } from 'react';
import {
  X,
  GitBranch,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  ExternalLink,
  GitPullRequest,
  UploadCloud,
  DownloadCloud,
  Key,
  Lock,
  Plus,
} from 'lucide-react';
import { GitHubStatus, Project } from '../types';

interface IntegrationsModalProps {
  isOpen: boolean;
  onClose: () => void;
  githubStatus: GitHubStatus | null;
  onRefreshGitHub: () => void;
  activeProject: Project | null;
}

export const IntegrationsModal: React.FC<IntegrationsModalProps> = ({
  isOpen,
  onClose,
  githubStatus,
  onRefreshGitHub,
  activeProject,
}) => {
  const [tokenInput, setTokenInput] = useState('');
  const [isSavingToken, setIsSavingToken] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<{ success: boolean; message: string } | null>(null);

  // PR Form
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [prBase, setPrBase] = useState('main');
  const [showPrForm, setShowPrForm] = useState(false);

  // New Branch Form
  const [branchName, setBranchName] = useState('');
  const [showBranchForm, setShowBranchForm] = useState(false);

  if (!isOpen) return null;

  const handleSaveToken = async () => {
    if (!tokenInput.trim()) return;
    setIsSavingToken(true);
    setActionResult(null);
    try {
      const res = await fetch('/api/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerKey: 'github',
          secretValue: tokenInput.trim(),
        }),
      });
      if (!res.ok) throw new Error('Falha ao salvar token do GitHub.');
      setTokenInput('');
      await onRefreshGitHub();
      setActionResult({ success: true, message: 'Token do GitHub salvo e criptografado com sucesso!' });
    } catch (err: any) {
      setActionResult({ success: false, message: err.message });
    } finally {
      setIsSavingToken(false);
    }
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setActionResult(null);
    try {
      const res = await fetch('/api/secrets/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerKey: 'github' }),
      });
      const data = await res.json();
      await onRefreshGitHub();
      setActionResult({
        success: data.success,
        message: data.message || (data.success ? 'Conexão aprovada!' : 'Falha na conexão.'),
      });
    } catch (err: any) {
      setActionResult({ success: false, message: err.message });
    } finally {
      setIsTesting(false);
    }
  };

  const handlePullChanges = async () => {
    if (!activeProject) return;
    setActionLoading('pull');
    setActionResult(null);
    try {
      const res = await fetch('/api/github/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: activeProject.id,
          branch: activeProject.branch || 'main',
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Falha ao sincronizar (pull).');
      setActionResult({ success: true, message: data.message || 'Repositório sincronizado com sucesso.' });
    } catch (err: any) {
      setActionResult({ success: false, message: err.message });
    } finally {
      setActionLoading(null);
    }
  };

  const handlePushChanges = async () => {
    if (!activeProject) return;
    setActionLoading('push');
    setActionResult(null);
    try {
      const res = await fetch('/api/github/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: activeProject.id,
          branch: activeProject.branch || 'main',
          message: `Update from Forge Agent - ${new Date().toLocaleTimeString()}`,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Falha ao enviar (push).');
      setActionResult({ success: true, message: `Push realizado! Commit: ${data.commitSha?.slice(0, 7) || 'OK'}` });
    } catch (err: any) {
      setActionResult({ success: false, message: err.message });
    } finally {
      setActionLoading(null);
    }
  };

  const handleCreateBranch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProject || !branchName.trim()) return;
    setActionLoading('branch');
    setActionResult(null);
    try {
      const res = await fetch('/api/github/branch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: activeProject.id,
          branchName: branchName.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Falha ao criar branch.');
      setActionResult({ success: true, message: `Branch "${data.branch}" criada e vinculada com sucesso.` });
      setShowBranchForm(false);
      setBranchName('');
    } catch (err: any) {
      setActionResult({ success: false, message: err.message });
    } finally {
      setActionLoading(null);
    }
  };

  const handleCreatePR = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProject || !prTitle.trim()) return;
    setActionLoading('pr');
    setActionResult(null);
    try {
      const res = await fetch('/api/github/pull-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: activeProject.id,
          title: prTitle.trim(),
          body: prBody.trim(),
          base: prBase.trim() || 'main',
          head: activeProject.branch || 'feature/forge-updates',
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Falha ao criar Pull Request.');
      setActionResult({
        success: true,
        message: `Pull Request #${data.prNumber} aberto com sucesso!`,
      });
      setShowPrForm(false);
      setPrTitle('');
      setPrBody('');
    } catch (err: any) {
      setActionResult({ success: false, message: err.message });
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl animate-fade-in flex flex-col max-h-[88vh]">
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-purple-600/20 text-purple-400 border border-purple-800/50 flex items-center justify-center font-bold text-sm">
              <GitBranch size={18} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">GitHub & Controle de Versão</h2>
              <p className="text-[11px] text-slate-400">
                Integração real com repositórios, sincronização, branches e Pull Requests
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 overflow-y-auto flex-1 custom-scrollbar">
          {/* Action Result Notification */}
          {actionResult && (
            <div
              className={`p-3 rounded-xl border text-xs flex items-start gap-2.5 ${
                actionResult.success
                  ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                  : 'bg-red-950/40 border-red-800/60 text-red-300'
              }`}
            >
              {actionResult.success ? (
                <CheckCircle2 size={16} className="text-emerald-400 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
              )}
              <div className="flex-1">{actionResult.message}</div>
            </div>
          )}

          {/* GitHub Connection Box */}
          <div
            className={`p-4 rounded-xl border space-y-3.5 ${
              githubStatus?.isConnected
                ? 'bg-purple-950/20 border-purple-800/50'
                : 'bg-slate-950 border-slate-800'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <GitBranch size={16} className="text-purple-400" />
                <span className="font-semibold text-slate-100 text-xs">Conta GitHub Pessoal</span>
              </div>
              <span
                className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase ${
                  githubStatus?.isConnected
                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                    : 'bg-amber-950 text-amber-300 border border-amber-800'
                }`}
              >
                {githubStatus?.isConnected ? 'Conectado' : 'Pendente de Configuração'}
              </span>
            </div>

            <p className="text-xs text-slate-300">
              {githubStatus?.message || 'Insira um Personal Access Token com escopo de repositório.'}
            </p>

            {githubStatus?.username && (
              <div className="flex items-center gap-3 p-2.5 rounded-lg bg-slate-900/80 border border-slate-800 text-xs">
                {githubStatus.avatarUrl && (
                  <img
                    src={githubStatus.avatarUrl}
                    alt={githubStatus.username}
                    referrerPolicy="no-referrer"
                    className="w-8 h-8 rounded-full border border-slate-700"
                  />
                )}
                <div>
                  <div className="font-semibold text-slate-200">@{githubStatus.username}</div>
                  <div className="text-[10px] text-slate-400 font-mono">
                    Escopos: {githubStatus.scopes?.join(', ') || 'repo'}
                  </div>
                </div>
              </div>
            )}

            {/* Token Input or update */}
            <div className="pt-2 border-t border-slate-800/80 space-y-2">
              <label className="text-[11px] font-medium text-slate-400 flex items-center justify-between">
                <span className="flex items-center gap-1">
                  <Key size={12} className="text-purple-400" />
                  GitHub Personal Access Token (PAT)
                </span>
                <a
                  href="https://github.com/settings/tokens/new?scopes=repo,workflow"
                  target="_blank"
                  rel="noreferrer"
                  className="text-cyan-400 hover:text-cyan-300 flex items-center gap-1 text-[10px]"
                >
                  Criar Token no GitHub <ExternalLink size={10} />
                </a>
              </label>

              <div className="flex gap-2">
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder={githubStatus?.isConnected ? 'Substituir token existente (ghp_...)' : 'ghp_xxxxxxxxxxxx...'}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-100 text-xs font-mono placeholder:text-slate-600 focus:outline-hidden focus:border-purple-500"
                />
                <button
                  onClick={handleSaveToken}
                  disabled={isSavingToken || !tokenInput.trim()}
                  className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white text-xs font-semibold transition cursor-pointer"
                >
                  {isSavingToken ? 'Salvando...' : 'Salvar Token'}
                </button>
                <button
                  onClick={handleTestConnection}
                  disabled={isTesting}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
                >
                  <RefreshCw size={12} className={isTesting ? 'animate-spin' : ''} />
                  Testar
                </button>
              </div>
            </div>
          </div>

          {/* Project Repository Operations (Push, Pull, Branch, PR) */}
          {activeProject && (
            <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-bold text-slate-200">Operações do Projeto Ativo</h3>
                  <p className="text-[11px] text-slate-400">
                    {activeProject.name} • Branch: <span className="font-mono text-cyan-400">{activeProject.branch}</span>
                  </p>
                </div>
                {activeProject.repo_url && (
                  <a
                    href={activeProject.repo_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-purple-400 hover:text-purple-300 flex items-center gap-1 font-mono truncate max-w-[200px]"
                  >
                    {activeProject.repo_url.replace('https://github.com/', '')}
                    <ExternalLink size={11} />
                  </a>
                )}
              </div>

              {/* Action Buttons */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <button
                  onClick={handlePullChanges}
                  disabled={!githubStatus?.isConnected || actionLoading === 'pull'}
                  className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 hover:bg-slate-800/80 disabled:opacity-40 text-left transition cursor-pointer"
                >
                  <DownloadCloud size={16} className="text-cyan-400 mb-1" />
                  <div className="text-xs font-semibold text-slate-200">Pull Changes</div>
                  <div className="text-[10px] text-slate-400">Atualizar do remoto</div>
                </button>

                <button
                  onClick={handlePushChanges}
                  disabled={!githubStatus?.isConnected || actionLoading === 'push'}
                  className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 hover:bg-slate-800/80 disabled:opacity-40 text-left transition cursor-pointer"
                >
                  <UploadCloud size={16} className="text-emerald-400 mb-1" />
                  <div className="text-xs font-semibold text-slate-200">Push Commit</div>
                  <div className="text-[10px] text-slate-400">Enviar alterações</div>
                </button>

                <button
                  onClick={() => setShowBranchForm(!showBranchForm)}
                  disabled={!githubStatus?.isConnected}
                  className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 hover:bg-slate-800/80 disabled:opacity-40 text-left transition cursor-pointer"
                >
                  <Plus size={16} className="text-purple-400 mb-1" />
                  <div className="text-xs font-semibold text-slate-200">Nova Branch</div>
                  <div className="text-[10px] text-slate-400">Criar no GitHub</div>
                </button>

                <button
                  onClick={() => setShowPrForm(!showPrForm)}
                  disabled={!githubStatus?.isConnected}
                  className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 hover:bg-slate-800/80 disabled:opacity-40 text-left transition cursor-pointer"
                >
                  <GitPullRequest size={16} className="text-amber-400 mb-1" />
                  <div className="text-xs font-semibold text-slate-200">Abrir PR</div>
                  <div className="text-[10px] text-slate-400">Pull Request real</div>
                </button>
              </div>

              {/* Create Branch Form */}
              {showBranchForm && (
                <form onSubmit={handleCreateBranch} className="p-3 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
                  <span className="text-xs font-semibold text-slate-200">Criar Nova Branch</span>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      required
                      value={branchName}
                      onChange={(e) => setBranchName(e.target.value)}
                      placeholder="feature/minha-feature"
                      className="flex-1 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100 text-xs font-mono placeholder:text-slate-600 focus:outline-hidden focus:border-purple-500"
                    />
                    <button
                      type="submit"
                      disabled={actionLoading === 'branch'}
                      className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold transition cursor-pointer"
                    >
                      {actionLoading === 'branch' ? 'Criando...' : 'Confirmar'}
                    </button>
                  </div>
                </form>
              )}

              {/* Create Pull Request Form */}
              {showPrForm && (
                <form onSubmit={handleCreatePR} className="p-3 rounded-xl bg-slate-900 border border-slate-800 space-y-2.5">
                  <span className="text-xs font-semibold text-slate-200">Abrir Pull Request no GitHub</span>
                  <input
                    type="text"
                    required
                    value={prTitle}
                    onChange={(e) => setPrTitle(e.target.value)}
                    placeholder="Título do Pull Request..."
                    className="w-full px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100 text-xs placeholder:text-slate-600 focus:outline-hidden focus:border-purple-500"
                  />
                  <textarea
                    rows={3}
                    value={prBody}
                    onChange={(e) => setPrBody(e.target.value)}
                    placeholder="Descrição das alterações e notas de revisão..."
                    className="w-full px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100 text-xs placeholder:text-slate-600 focus:outline-hidden focus:border-purple-500"
                  />
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-xs text-slate-400">
                      <span>Base:</span>
                      <input
                        type="text"
                        value={prBase}
                        onChange={(e) => setPrBase(e.target.value)}
                        className="w-20 px-2 py-1 rounded bg-slate-950 border border-slate-800 text-slate-200 font-mono text-xs"
                      />
                      <span>Head:</span>
                      <span className="font-mono text-slate-200 text-xs">{activeProject.branch}</span>
                    </div>
                    <button
                      type="submit"
                      disabled={actionLoading === 'pr'}
                      className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold transition cursor-pointer"
                    >
                      {actionLoading === 'pr' ? 'Enviando PR...' : 'Submeter PR'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
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
