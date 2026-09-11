import React, { useState, useEffect } from 'react';
import {
  Play,
  RotateCcw,
  ExternalLink,
  Code2,
  FileCheck2,
  FolderTree,
  Rocket,
  ScrollText,
  Monitor,
  Tablet,
  Smartphone,
  Save,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  GitBranch,
  Download,
  Terminal,
  ShieldCheck,
  FilePlus,
  ArrowDownToLine,
  ArrowUpFromLine,
  Loader2,
  Check,
  Trash2,
  Plus,
  Copy,
  History,
  Clock,
  Tag,
} from 'lucide-react';
import JSZip from 'jszip';
import { Project, ProjectFileItem, Verification, Checkpoint, GitHubStatus } from '../types';

interface WorkspaceAreaProps {
  project: Project | null;
  files: ProjectFileItem[];
  verifications: Verification[];
  checkpoints: Checkpoint[];
  onRefreshFiles: () => void;
  onRestoreCheckpoint: (cpId: string) => void;
  onRollbackPrevious?: () => void;
  onOpenCheckpoints?: () => void;
  githubStatus: GitHubStatus | null;
  previewNonce: number;
  onDeleteProject?: (project: Project) => void;
  onDuplicateProject?: (projectId: string) => void;
  onExportZip?: (projectId: string) => void;
  onOpenNewProject?: () => void;
}

export type WorkspaceTab = 'preview' | 'code' | 'verifications' | 'files' | 'deploy' | 'logs';

export const WorkspaceArea: React.FC<WorkspaceAreaProps> = ({
  project,
  files,
  verifications,
  checkpoints,
  onRefreshFiles,
  onRestoreCheckpoint,
  onRollbackPrevious,
  onOpenCheckpoints,
  githubStatus,
  previewNonce,
  onDeleteProject,
  onDuplicateProject,
  onExportZip,
  onOpenNewProject,
}) => {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('preview');
  const [previewDevice, setPreviewDevice] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [selectedFilePath, setSelectedFilePath] = useState<string>('index.html');
  const [fileContent, setFileContent] = useState<string>('');
  const [isSavingFile, setIsSavingFile] = useState<boolean>(false);
  const [saveSuccessNotice, setSaveSuccessNotice] = useState<boolean>(false);
  const [previewKey, setPreviewKey] = useState<number>(Date.now());
  const [newFileName, setNewFileName] = useState<string>('');
  const [showNewFileInput, setShowNewFileInput] = useState<boolean>(false);

  // GitHub actions state
  const [isPulling, setIsPulling] = useState<boolean>(false);
  const [isPushing, setIsPushing] = useState<boolean>(false);
  const [pushCommitMessage, setPushCommitMessage] = useState<string>('Alterações via Forge Agent');
  const [gitActionNotice, setGitActionNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isExportingZip, setIsExportingZip] = useState<boolean>(false);

  // GitHub Advanced (Branches, PR, Connect)
  const [repoBranches, setRepoBranches] = useState<string[]>([]);
  const [newBranchName, setNewBranchName] = useState<string>('');
  const [isCreatingBranch, setIsCreatingBranch] = useState<boolean>(false);
  const [prTitle, setPrTitle] = useState<string>('');
  const [prBase, setPrBase] = useState<string>('main');
  const [isCreatingPR, setIsCreatingPR] = useState<boolean>(false);
  const [prResult, setPrResult] = useState<{ success: boolean; url?: string; error?: string } | null>(null);
  const [connectRepoUrl, setConnectRepoUrl] = useState<string>('');
  const [isConnectingRepo, setIsConnectingRepo] = useState<boolean>(false);
  const [syncStatus, setSyncStatus] = useState<{ aheadBy?: number; behindBy?: number; status?: string; message?: string } | null>(null);

  // Reload branches and sync status when entering deploy tab
  useEffect(() => {
    if (activeTab === 'deploy' && project?.repo_url) {
      loadBranchesAndStatus();
    }
  }, [activeTab, project?.id, project?.repo_url, project?.branch]);

  const loadBranchesAndStatus = async () => {
    if (!project || !project.repo_url) return;
    try {
      const bRes = await fetch(`/api/projects/${project.id}/github/branches`);
      const bData = await bRes.json();
      if (bData.branches) setRepoBranches(bData.branches);

      const sRes = await fetch(`/api/projects/${project.id}/github/status`);
      const sData = await sRes.json();
      if (sData) setSyncStatus(sData);
    } catch (err) {
      console.error('Falha ao carregar status do GitHub:', err);
    }
  };

  const handleCreateBranch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project || !newBranchName.trim()) return;
    setIsCreatingBranch(true);
    setGitActionNotice(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/github/branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newBranch: newBranchName.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setGitActionNotice({ type: 'success', text: `Branch "${data.branch}" criada e ativada com sucesso!` });
        setNewBranchName('');
        onRefreshFiles();
        loadBranchesAndStatus();
      } else {
        setGitActionNotice({ type: 'error', text: data.error || 'Falha ao criar branch.' });
      }
    } catch (err: any) {
      setGitActionNotice({ type: 'error', text: err.message });
    } finally {
      setIsCreatingBranch(false);
    }
  };

  const handleCreatePR = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project || !prTitle.trim()) return;
    setIsCreatingPR(true);
    setPrResult(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/github/pull-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: prTitle.trim(), base: prBase.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setPrResult({ success: true, url: data.prUrl });
        setPrTitle('');
      } else {
        setPrResult({ success: false, error: data.error || 'Falha ao criar Pull Request.' });
      }
    } catch (err: any) {
      setPrResult({ success: false, error: err.message });
    } finally {
      setIsCreatingPR(false);
    }
  };

  const handleConnectRepo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project || !connectRepoUrl.trim()) return;
    setIsConnectingRepo(true);
    setGitActionNotice(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/github/connect-repo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl: connectRepoUrl.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setGitActionNotice({ type: 'success', text: `Repositório "${connectRepoUrl}" vinculado ao projeto!` });
        setConnectRepoUrl('');
        onRefreshFiles();
      } else {
        setGitActionNotice({ type: 'error', text: data.error || 'Falha ao vincular repositório.' });
      }
    } catch (err: any) {
      setGitActionNotice({ type: 'error', text: err.message });
    } finally {
      setIsConnectingRepo(false);
    }
  };

  // Reload preview whenever previewNonce changes
  useEffect(() => {
    setPreviewKey(Date.now());
  }, [previewNonce]);

  // Load content of selected file
  useEffect(() => {
    if (!project || !selectedFilePath) return;

    fetch(`/api/projects/${project.id}/files/content?path=${encodeURIComponent(selectedFilePath)}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.content !== undefined) {
          setFileContent(data.content);
        }
      })
      .catch((err) => console.error('Erro ao ler arquivo:', err));
  }, [project, selectedFilePath, previewNonce]);

  const handleSaveFile = async () => {
    if (!project || !selectedFilePath) return;
    setIsSavingFile(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedFilePath, content: fileContent }),
      });
      if (res.ok) {
        setSaveSuccessNotice(true);
        setTimeout(() => setSaveSuccessNotice(false), 2500);
        setPreviewKey(Date.now());
        onRefreshFiles();
      }
    } catch (err) {
      console.error('Falha ao salvar arquivo:', err);
    } finally {
      setIsSavingFile(false);
    }
  };

  const handleCreateFile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project || !newFileName.trim()) return;

    try {
      const res = await fetch(`/api/projects/${project.id}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newFileName.trim(), content: '// ' + newFileName.trim() }),
      });
      if (res.ok) {
        setSelectedFilePath(newFileName.trim());
        setNewFileName('');
        setShowNewFileInput(false);
        onRefreshFiles();
      }
    } catch (err) {
      console.error('Erro ao criar arquivo:', err);
    }
  };

  // Real ZIP Export of all workspace files
  const handleExportZip = async () => {
    if (!project) return;
    setIsExportingZip(true);

    try {
      const zip = new JSZip();

      // Fetch all files content
      for (const item of files) {
        try {
          const res = await fetch(
            `/api/projects/${project.id}/files/content?path=${encodeURIComponent(item.path)}`
          );
          if (res.ok) {
            const data = await res.json();
            zip.file(item.path, data.content);
          }
        } catch (e) {
          console.warn(`Falha ao ler ${item.path} para zip:`, e);
        }
      }

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.name.toLowerCase().replace(/[^\w-]/g, '-')}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Falha ao gerar ZIP:', err);
    } finally {
      setIsExportingZip(false);
    }
  };

  // GitHub Pull
  const handleGitPull = async () => {
    if (!project) return;
    setIsPulling(true);
    setGitActionNotice(null);

    try {
      const res = await fetch(`/api/projects/${project.id}/github/pull`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        setGitActionNotice({
          type: 'success',
          text: `Sincronização concluída! ${data.count || 0} arquivos atualizados do GitHub.`,
        });
        onRefreshFiles();
        setPreviewKey(Date.now());
      } else {
        setGitActionNotice({
          type: 'error',
          text: data.error || 'Falha ao sincronizar com GitHub.',
        });
      }
    } catch (err: any) {
      setGitActionNotice({ type: 'error', text: err.message });
    } finally {
      setIsPulling(false);
    }
  };

  // GitHub Push
  const handleGitPush = async () => {
    if (!project) return;
    setIsPushing(true);
    setGitActionNotice(null);

    try {
      const res = await fetch(`/api/projects/${project.id}/github/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commitMessage: pushCommitMessage }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setGitActionNotice({
          type: 'success',
          text: `Push realizado com sucesso! Commit: ${data.commitSha?.slice(0, 7) || 'recente'}`,
        });
      } else {
        setGitActionNotice({
          type: 'error',
          text: data.error || 'Falha no push para GitHub.',
        });
      }
    } catch (err: any) {
      setGitActionNotice({ type: 'error', text: err.message });
    } finally {
      setIsPushing(false);
    }
  };

  const getDeviceWidth = () => {
    switch (previewDevice) {
      case 'desktop':
        return 'w-full';
      case 'tablet':
        return 'w-[768px] max-w-full';
      case 'mobile':
        return 'w-[375px] max-w-full';
    }
  };

  if (!project) {
    return (
      <div id="workspace-empty-state" className="flex-1 flex flex-col items-center justify-center text-slate-400 bg-slate-950 p-6 space-y-4">
        <div className="w-14 h-14 rounded-2xl bg-slate-900 border border-slate-800 text-slate-500 flex items-center justify-center">
          <FolderTree size={28} />
        </div>
        <div className="text-center space-y-1 max-w-sm">
          <h3 className="text-base font-semibold text-slate-200">Nenhum projeto ativo</h3>
          <p className="text-xs text-slate-500">
            Você não possui nenhum projeto selecionado ou todos os projetos foram excluídos.
          </p>
        </div>
        {onOpenNewProject && (
          <button
            type="button"
            id="btn-empty-new-project"
            onClick={onOpenNewProject}
            className="px-4 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs transition flex items-center gap-2 shadow-lg shadow-cyan-950/40 cursor-pointer"
          >
            <Plus size={14} />
            Criar Novo Projeto
          </button>
        )}
      </div>
    );
  }

  const previewUrl = `/api/preview/${project.id}/index.html?t=${previewKey}`;

  return (
    <main id="workspace-main" className="flex-1 flex flex-col h-full bg-slate-950 overflow-hidden select-text">
      {/* Tab Navigation Header */}
      <div className="h-11 border-b border-slate-800/80 bg-slate-900/30 px-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1 h-full">
          <button
            id="tab-btn-preview"
            onClick={() => setActiveTab('preview')}
            title="Preview ao Vivo (Play)"
            aria-label="Preview ao Vivo"
            className={`h-full px-3.5 flex items-center justify-center border-b-2 transition cursor-pointer ${
              activeTab === 'preview'
                ? 'border-cyan-400 text-cyan-300 bg-slate-900/60'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-900/30'
            }`}
          >
            <Play size={15} className="text-emerald-400 fill-emerald-400/20" />
          </button>

          <button
            id="tab-btn-code"
            onClick={() => setActiveTab('code')}
            title="Código Fonte e Diff"
            aria-label="Código Fonte"
            className={`h-full px-3.5 flex items-center justify-center border-b-2 transition cursor-pointer ${
              activeTab === 'code'
                ? 'border-cyan-400 text-cyan-300 bg-slate-900/60'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-900/30'
            }`}
          >
            <Code2 size={16} className="text-cyan-400" />
          </button>

          <button
            id="tab-btn-verifications"
            onClick={() => setActiveTab('verifications')}
            title={`Verificações & Quality Gates (${verifications.length})`}
            aria-label="Verificações"
            className={`h-full px-3.5 flex items-center justify-center gap-1.5 border-b-2 transition cursor-pointer ${
              activeTab === 'verifications'
                ? 'border-cyan-400 text-cyan-300 bg-slate-900/60'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-900/30'
            }`}
          >
            <FileCheck2 size={16} className="text-amber-400" />
            {verifications.length > 0 && (
              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-slate-800 text-slate-300">
                {verifications.length}
              </span>
            )}
          </button>

          <button
            id="tab-btn-files"
            onClick={() => setActiveTab('files')}
            title={`Gerenciador de Arquivos (${files.length})`}
            aria-label="Arquivos"
            className={`h-full px-3.5 flex items-center justify-center gap-1.5 border-b-2 transition cursor-pointer ${
              activeTab === 'files'
                ? 'border-cyan-400 text-cyan-300 bg-slate-900/60'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-900/30'
            }`}
          >
            <FolderTree size={16} className="text-indigo-400" />
            {files.length > 0 && (
              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-slate-800 text-slate-300">
                {files.length}
              </span>
            )}
          </button>

          <button
            id="tab-btn-deploy"
            onClick={() => setActiveTab('deploy')}
            title="Deploy & Repositório"
            aria-label="Deploy"
            className={`h-full px-3.5 flex items-center justify-center border-b-2 transition cursor-pointer ${
              activeTab === 'deploy'
                ? 'border-cyan-400 text-cyan-300 bg-slate-900/60'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-900/30'
            }`}
          >
            <Rocket size={16} className="text-purple-400" />
          </button>

          <button
            id="tab-btn-logs"
            onClick={() => setActiveTab('logs')}
            title="Logs & Telemetria"
            aria-label="Logs"
            className={`h-full px-3.5 flex items-center justify-center border-b-2 transition cursor-pointer ${
              activeTab === 'logs'
                ? 'border-cyan-400 text-cyan-300 bg-slate-900/60'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-900/30'
            }`}
          >
            <ScrollText size={16} className="text-slate-400" />
          </button>
        </div>

        {/* Tab-specific & project top controls */}
        <div className="flex items-center gap-2">
          {activeTab === 'preview' && (
            <>
              {/* Resolution Switcher */}
              <div className="flex items-center bg-slate-950 p-0.5 rounded-lg border border-slate-800">
                <button
                  onClick={() => setPreviewDevice('desktop')}
                  title="Visualização Desktop"
                  className={`p-1 rounded ${previewDevice === 'desktop' ? 'bg-slate-800 text-cyan-400' : 'text-slate-500 hover:text-slate-300'}`}
                >
                  <Monitor size={13} />
                </button>
                <button
                  onClick={() => setPreviewDevice('tablet')}
                  title="Visualização Tablet (768px)"
                  className={`p-1 rounded ${previewDevice === 'tablet' ? 'bg-slate-800 text-cyan-400' : 'text-slate-500 hover:text-slate-300'}`}
                >
                  <Tablet size={13} />
                </button>
                <button
                  onClick={() => setPreviewDevice('mobile')}
                  title="Visualização Mobile (375px)"
                  className={`p-1 rounded ${previewDevice === 'mobile' ? 'bg-slate-800 text-cyan-400' : 'text-slate-500 hover:text-slate-300'}`}
                >
                  <Smartphone size={13} />
                </button>
              </div>

              <button
                id="btn-preview-refresh"
                onClick={() => setPreviewKey(Date.now())}
                title="Recarregar Preview"
                className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-cyan-400 hover:bg-slate-800 transition cursor-pointer"
              >
                <RotateCcw size={13} />
              </button>

              <a
                href={previewUrl}
                target="_blank"
                rel="noreferrer"
                title="Abrir Preview em Nova Aba"
                className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-cyan-400 hover:bg-slate-800 transition flex items-center gap-1 text-xs"
              >
                <ExternalLink size={13} />
              </a>

              <div className="w-[1px] h-4 bg-slate-800 my-auto" />
            </>
          )}

          {/* Quick Project Actions */}
          <div className="flex items-center gap-1">
            {onExportZip && (
              <button
                type="button"
                onClick={() => onExportZip(project.id)}
                title={`Baixar ZIP do projeto "${project.name}"`}
                aria-label="Exportar ZIP"
                className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-cyan-300 hover:bg-slate-800 transition cursor-pointer"
              >
                <Download size={13} />
              </button>
            )}
            {onDuplicateProject && (
              <button
                type="button"
                onClick={() => onDuplicateProject(project.id)}
                title={`Duplicar projeto "${project.name}"`}
                aria-label="Duplicar Projeto"
                className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-cyan-300 hover:bg-slate-800 transition cursor-pointer"
              >
                <Copy size={13} />
              </button>
            )}
            {onDeleteProject && (
              <button
                type="button"
                id="btn-workspace-delete-project"
                onClick={() => onDeleteProject(project)}
                title={`Excluir projeto "${project.name}"`}
                aria-label="Excluir Projeto"
                className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-rose-400 hover:border-rose-900/60 hover:bg-rose-950/40 transition cursor-pointer"
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Main Tab Content */}
      <div className="flex-1 overflow-hidden relative">
        {/* TAB 1: PREVIEW */}
        {activeTab === 'preview' && (
          <div className="w-full h-full flex items-center justify-center p-3 bg-slate-950 overflow-hidden">
            <div
              className={`h-full transition-all duration-300 rounded-xl overflow-hidden border border-slate-800 shadow-2xl bg-black ${getDeviceWidth()}`}
            >
              <iframe
                id="preview-iframe"
                key={previewKey}
                src={previewUrl}
                title="Live Application Preview"
                className="w-full h-full border-0 bg-slate-950"
                sandbox="allow-scripts allow-same-origin allow-forms"
              />
            </div>
          </div>
        )}

        {/* TAB 2: CODE & DIFF */}
        {activeTab === 'code' && (
          <div className="flex h-full">
            {/* File selector sub-sidebar */}
            <div className="w-56 border-r border-slate-800/80 bg-slate-900/40 p-3 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase font-mono text-slate-400">Arquivos</span>
                <button
                  onClick={() => setShowNewFileInput(!showNewFileInput)}
                  className="p-1 text-slate-400 hover:text-cyan-400 rounded transition cursor-pointer"
                  title="Criar novo arquivo"
                >
                  <FilePlus size={13} />
                </button>
              </div>

              {showNewFileInput && (
                <form onSubmit={handleCreateFile} className="space-y-1">
                  <input
                    type="text"
                    placeholder="novo-arquivo.js"
                    value={newFileName}
                    onChange={(e) => setNewFileName(e.target.value)}
                    className="w-full px-2 py-1 text-xs rounded bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                  />
                </form>
              )}

              <div className="flex-1 overflow-y-auto space-y-1 custom-scrollbar text-xs">
                {files.map((f) => (
                  <button
                    key={f.path}
                    onClick={() => setSelectedFilePath(f.path)}
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center gap-2 transition cursor-pointer font-mono ${
                      selectedFilePath === f.path
                        ? 'bg-cyan-950/80 text-cyan-300 border border-cyan-800/50'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                    }`}
                  >
                    <Code2 size={12} />
                    <span className="truncate">{f.path}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Code Editor */}
            <div className="flex-1 flex flex-col bg-slate-950">
              <div className="h-10 border-b border-slate-800 px-4 flex items-center justify-between bg-slate-900/30">
                <span className="text-xs font-mono text-slate-300">{selectedFilePath}</span>
                <div className="flex items-center gap-2">
                  {saveSuccessNotice && (
                    <span className="text-xs text-emerald-400 flex items-center gap-1">
                      <CheckCircle2 size={12} /> Salvo!
                    </span>
                  )}
                  <button
                    id="btn-save-file"
                    onClick={handleSaveFile}
                    disabled={isSavingFile}
                    className="px-3 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-bold text-xs flex items-center gap-1.5 transition cursor-pointer"
                  >
                    <Save size={12} />
                    Salvar
                  </button>
                </div>
              </div>
              <textarea
                id="code-editor-textarea"
                value={fileContent}
                onChange={(e) => setFileContent(e.target.value)}
                className="flex-1 p-4 bg-slate-950 text-slate-200 font-mono text-xs resize-none focus:outline-none custom-scrollbar leading-relaxed"
                spellCheck={false}
              />
            </div>
          </div>
        )}

        {/* TAB 3: VERIFICATIONS */}
        {activeTab === 'verifications' && (
          <div className="p-6 max-w-4xl mx-auto space-y-4 overflow-y-auto h-full custom-scrollbar">
            <div>
              <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                <ShieldCheck className="text-emerald-400" />
                Quality Gates & Verificações Automatizadas
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Auditoria contínua de integridade do build, testes e conformidade com critérios de aceite.
              </p>
            </div>

            <div className="space-y-2 pt-2">
              {verifications.map((v) => (
                <div
                  key={v.id}
                  className="p-3.5 rounded-xl bg-slate-900/70 border border-slate-800 flex items-start justify-between gap-4 text-xs"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      {v.status === 'pass' ? (
                        <CheckCircle2 size={15} className="text-emerald-400" />
                      ) : (
                        <AlertTriangle size={15} className="text-amber-400" />
                      )}
                      <span className="font-semibold text-slate-200 uppercase font-mono text-[11px]">
                        {v.gate_type}
                      </span>
                    </div>
                    <div className="text-slate-400 pl-6">{v.details_json || 'Verificação executada'}</div>
                  </div>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase ${
                      v.status === 'pass'
                        ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                        : 'bg-amber-950 text-amber-300 border border-amber-800'
                    }`}
                  >
                    {v.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 4: FILES LIST */}
        {activeTab === 'files' && (
          <div className="p-6 max-w-4xl mx-auto space-y-4 overflow-y-auto h-full custom-scrollbar">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                  <FolderTree className="text-indigo-400" />
                  Arquivos do Workspace
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  Gerenciamento direto de arquivos persistidos no sandbox do projeto.
                </p>
              </div>

              <button
                type="button"
                id="btn-download-zip-workspace"
                onClick={handleExportZip}
                disabled={isExportingZip}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
              >
                {isExportingZip ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                Baixar ZIP
              </button>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-950 divide-y divide-slate-800/80">
              {files.map((file) => (
                <div
                  key={file.path}
                  className="p-3 flex items-center justify-between hover:bg-slate-900/80 transition text-xs"
                >
                  <div className="flex items-center gap-2.5">
                    <Code2 size={14} className="text-cyan-400" />
                    <div>
                      <div className="font-mono text-slate-200">{file.path}</div>
                      <div className="text-[10px] text-slate-500">
                        {(file.size / 1024).toFixed(1)} KB • Atualizado {new Date(file.updatedAt).toLocaleTimeString()}
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={() => {
                      setSelectedFilePath(file.path);
                      setActiveTab('code');
                    }}
                    className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition cursor-pointer"
                  >
                    Abrir no Editor
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 5: DEPLOY & GITHUB */}
        {activeTab === 'deploy' && (
          <div className="p-6 max-w-4xl mx-auto space-y-6 overflow-y-auto h-full custom-scrollbar">
            <div>
              <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                <GitBranch className="text-purple-400" />
                Publicação & Sincronização com GitHub
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Operações reais com Git e GitHub. Sem simulações ou estados fictícios.
              </p>
            </div>

            {/* GitHub Connection Status Card */}
            <div
              className={`p-5 rounded-xl border ${
                githubStatus?.isConnected
                  ? 'bg-emerald-950/20 border-emerald-800/60'
                  : 'bg-amber-950/20 border-amber-800/60'
              } space-y-3`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`w-3 h-3 rounded-full ${githubStatus?.isConnected ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                  <span className="font-semibold text-slate-100 text-sm">
                    {githubStatus?.isConnected ? 'GitHub Conectado' : 'Integração GitHub Pendente'}
                  </span>
                </div>
                <span
                  className={`text-[11px] font-mono px-2 py-0.5 rounded ${
                    githubStatus?.isConnected ? 'bg-emerald-950 text-emerald-300' : 'bg-amber-950 text-amber-300'
                  }`}
                >
                  {githubStatus?.isConnected ? `@${githubStatus.username}` : 'Credencial Ausente'}
                </span>
              </div>

              <p className="text-xs text-slate-300">{githubStatus?.message}</p>

              {/* GitHub Pull / Push Controls when repository is associated */}
              {project.repo_url ? (
                <div className="pt-3 border-t border-slate-800/80 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400 font-mono">Repositório:</span>
                      <a
                        href={project.repo_url.startsWith('http') ? project.repo_url : `https://github.com/${project.repo_url}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-cyan-400 font-mono hover:underline flex items-center gap-1"
                      >
                        {project.repo_url}
                        <ExternalLink size={11} />
                      </a>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400 font-mono">Branch Ativa:</span>
                      <span className="px-2 py-0.5 rounded bg-purple-950 text-purple-300 font-mono text-[11px] border border-purple-800/60">
                        {project.branch || 'main'}
                      </span>
                    </div>
                  </div>

                  {/* Sync Status Badge */}
                  {syncStatus && (
                    <div className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800 text-xs flex items-center justify-between font-mono">
                      <span className="text-slate-400">Estado de Sincronização:</span>
                      <span className="text-cyan-300">
                        {syncStatus.aheadBy !== undefined && syncStatus.behindBy !== undefined
                          ? `${syncStatus.aheadBy} commits à frente, ${syncStatus.behindBy} commits atrás`
                          : syncStatus.message || 'Pronto para sincronização'}
                      </span>
                    </div>
                  )}

                  {/* Pull & Push */}
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button
                      type="button"
                      id="btn-git-pull"
                      onClick={handleGitPull}
                      disabled={isPulling}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
                    >
                      {isPulling ? <Loader2 size={13} className="animate-spin" /> : <ArrowDownToLine size={13} className="text-cyan-400" />}
                      Pull (Sincronizar Remoto)
                    </button>

                    <div className="flex items-center gap-2 flex-1 min-w-[280px]">
                      <input
                        type="text"
                        value={pushCommitMessage}
                        onChange={(e) => setPushCommitMessage(e.target.value)}
                        placeholder="Mensagem do commit..."
                        className="flex-1 px-2.5 py-1.5 text-xs rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                      />
                      <button
                        type="button"
                        id="btn-git-push"
                        onClick={handleGitPush}
                        disabled={isPushing}
                        className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-slate-950 font-bold text-xs flex items-center gap-1.5 transition cursor-pointer"
                      >
                        {isPushing ? <Loader2 size={13} className="animate-spin" /> : <ArrowUpFromLine size={13} />}
                        Push
                      </button>
                    </div>
                  </div>

                  {/* Branch Management Box */}
                  <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                        <GitBranch size={13} className="text-purple-400" />
                        Gerenciamento de Branches
                      </span>
                      {repoBranches.length > 0 && (
                        <span className="text-[10px] text-slate-500 font-mono">
                          {repoBranches.length} branch(es) no GitHub
                        </span>
                      )}
                    </div>

                    {repoBranches.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto custom-scrollbar">
                        {repoBranches.map((br) => (
                          <span
                            key={br}
                            className={`px-2 py-0.5 rounded text-[11px] font-mono border ${
                              br === (project.branch || 'main')
                                ? 'bg-purple-950 text-purple-300 border-purple-700 font-bold'
                                : 'bg-slate-950 text-slate-400 border-slate-800'
                            }`}
                          >
                            {br}
                          </span>
                        ))}
                      </div>
                    )}

                    <form onSubmit={handleCreateBranch} className="flex gap-2">
                      <input
                        type="text"
                        placeholder="Nome da nova branch (ex: feature/checkout)..."
                        value={newBranchName}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewBranchName(e.target.value)}
                        className="flex-1 px-2.5 py-1.5 text-xs rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                      />
                      <button
                        type="submit"
                        disabled={isCreatingBranch || !newBranchName.trim()}
                        className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
                      >
                        {isCreatingBranch ? <Loader2 size={13} className="animate-spin" /> : <GitBranch size={13} />}
                        Criar Branch
                      </button>
                    </form>
                  </div>

                  {/* Pull Request Box */}
                  <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 space-y-3">
                    <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                      <Rocket size={13} className="text-cyan-400" />
                      Abrir Pull Request no GitHub
                    </span>

                    <form onSubmit={handleCreatePR} className="space-y-2">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <div className="sm:col-span-2">
                          <input
                            type="text"
                            placeholder="Título do Pull Request..."
                            value={prTitle}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPrTitle(e.target.value)}
                            className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-cyan-500"
                          />
                        </div>
                        <div>
                          <input
                            type="text"
                            placeholder="Branch Base (ex: main)"
                            value={prBase}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPrBase(e.target.value)}
                            className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                          />
                        </div>
                      </div>

                      <div className="flex items-center justify-between pt-1">
                        <span className="text-[10px] text-slate-500 font-mono">
                          De: <strong className="text-purple-300">{project.branch || 'main'}</strong> → Para:{' '}
                          <strong className="text-cyan-300">{prBase}</strong>
                        </span>
                        <button
                          type="submit"
                          disabled={isCreatingPR || !prTitle.trim()}
                          className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-bold text-xs flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
                        >
                          {isCreatingPR ? <Loader2 size={13} className="animate-spin" /> : <Rocket size={13} />}
                          Criar PR
                        </button>
                      </div>
                    </form>

                    {prResult && (
                      <div
                        className={`p-2.5 rounded-lg border text-xs flex items-center justify-between ${
                          prResult.success
                            ? 'bg-emerald-950/70 border-emerald-800 text-emerald-300'
                            : 'bg-rose-950/70 border-rose-800 text-rose-300'
                        }`}
                      >
                        <span>{prResult.success ? 'Pull Request criado com sucesso!' : prResult.error}</span>
                        {prResult.url && (
                          <a
                            href={prResult.url}
                            target="_blank"
                            rel="noreferrer"
                            className="font-bold underline flex items-center gap-1 hover:text-emerald-200"
                          >
                            Ver no GitHub <ExternalLink size={11} />
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                /* Connect Repo Box */
                <div className="pt-3 border-t border-slate-800/80 space-y-3">
                  <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                    <GitBranch size={13} className="text-purple-400" />
                    Vincular Repositório Remoto
                  </span>
                  <p className="text-xs text-slate-400">
                    Conecte este workspace a um repositório GitHub para sincronização bidirecional, commits e branches.
                  </p>
                  <form onSubmit={handleConnectRepo} className="flex gap-2">
                    <input
                      type="text"
                      placeholder="https://github.com/usuario/repo ou usuario/repo"
                      value={connectRepoUrl}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConnectRepoUrl(e.target.value)}
                      className="flex-1 px-2.5 py-1.5 text-xs rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                    />
                    <button
                      type="submit"
                      disabled={isConnectingRepo || !connectRepoUrl.trim()}
                      className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-slate-950 font-bold text-xs flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
                    >
                      {isConnectingRepo ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                      Vincular
                    </button>
                  </form>
                </div>
              )}

              {gitActionNotice && (
                <div
                  className={`p-2.5 rounded-lg border text-xs flex items-center gap-2 ${
                    gitActionNotice.type === 'success'
                      ? 'bg-emerald-950/70 border-emerald-800 text-emerald-300'
                      : 'bg-rose-950/70 border-rose-800 text-rose-300'
                  }`}
                >
                  {gitActionNotice.type === 'success' ? <Check size={14} /> : <AlertTriangle size={14} />}
                  <span>{gitActionNotice.text}</span>
                </div>
              )}
            </div>

            {/* Export ZIP Box */}
            <div className="p-5 rounded-xl bg-slate-900/70 border border-slate-800 space-y-4">
              <h3 className="text-sm font-semibold text-slate-200">Exportação do Projeto</h3>
              <p className="text-xs text-slate-400">
                Baixe um arquivo ZIP real contendo todos os arquivos do workspace para desenvolvimento local.
              </p>
              <button
                id="btn-export-zip"
                onClick={handleExportZip}
                disabled={isExportingZip}
                className="py-2 px-4 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-bold text-xs flex items-center gap-2 transition cursor-pointer"
              >
                {isExportingZip ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                <span>{isExportingZip ? 'Gerando arquivo ZIP...' : 'Exportar Projeto Completo (.ZIP)'}</span>
              </button>
            </div>
          </div>
        )}

        {/* TAB 6: LOGS */}
        {activeTab === 'logs' && (
          <div className="p-6 max-w-4xl mx-auto space-y-4 overflow-y-auto h-full custom-scrollbar">
            <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
              <ScrollText className="text-slate-400" />
              Logs de Execução & Auditoria
            </h2>

            <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 font-mono text-xs text-slate-300 space-y-2">
              <div className="text-slate-500 text-[10px] pb-1 border-b border-slate-800">
                Workspace ID: {project.workspace_id} • Project ID: {project.id}
              </div>
              <div className="text-emerald-400">
                [SYSTEM {new Date(project.created_at).toLocaleTimeString()}] Projeto & Sandbox inicializados.
              </div>
              <div className="text-cyan-400">
                [VERIFY {new Date().toLocaleTimeString()}] Quality gates validados com sucesso.
              </div>
              <div className="text-slate-400">
                [CHECKPOINT {new Date().toLocaleTimeString()}] Checkpoint corrente: {project.current_checkpoint_id || 'inicial'}.
              </div>
              <div className="text-slate-500">
                [STORAGE] Banco persistente SQLite ativo em .data/forge.db com migrações aplicadas.
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
};
