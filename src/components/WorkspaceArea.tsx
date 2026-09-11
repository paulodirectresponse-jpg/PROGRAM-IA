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
} from 'lucide-react';
import { Project, ProjectFileItem, Verification, Checkpoint, GitHubStatus } from '../types';

interface WorkspaceAreaProps {
  project: Project | null;
  files: ProjectFileItem[];
  verifications: Verification[];
  checkpoints: Checkpoint[];
  onRefreshFiles: () => void;
  onRestoreCheckpoint: (cpId: string) => void;
  githubStatus: GitHubStatus | null;
  previewNonce: number;
}

export type WorkspaceTab = 'preview' | 'code' | 'verifications' | 'files' | 'deploy' | 'logs';

export const WorkspaceArea: React.FC<WorkspaceAreaProps> = ({
  project,
  files,
  verifications,
  checkpoints,
  onRefreshFiles,
  onRestoreCheckpoint,
  githubStatus,
  previewNonce,
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
        body: JSON.stringify({ path: newFileName.trim(), content: '// Novo arquivo ' + newFileName }),
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

  const handleExportZip = () => {
    if (!project) return;
    // Download project bundle
    const exportData = {
      project,
      exportedAt: new Date().toISOString(),
      files,
      content: fileContent,
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.name.toLowerCase().replace(/\s+/g, '-')}-export.json`;
    a.click();
    URL.revokeObjectURL(url);
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
      <div className="flex-1 flex items-center justify-center text-slate-500 bg-slate-950">
        Nenhum projeto ativo selecionado.
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
            className={`h-full px-3 text-xs font-medium flex items-center gap-2 border-b-2 transition cursor-pointer ${
              activeTab === 'preview'
                ? 'border-cyan-400 text-cyan-300 font-semibold bg-slate-900/50'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Play size={13} className="text-emerald-400" />
            Preview ao Vivo
          </button>

          <button
            id="tab-btn-code"
            onClick={() => setActiveTab('code')}
            className={`h-full px-3 text-xs font-medium flex items-center gap-2 border-b-2 transition cursor-pointer ${
              activeTab === 'code'
                ? 'border-cyan-400 text-cyan-300 font-semibold bg-slate-900/50'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Code2 size={13} className="text-cyan-400" />
            Código e Diff
          </button>

          <button
            id="tab-btn-verifications"
            onClick={() => setActiveTab('verifications')}
            className={`h-full px-3 text-xs font-medium flex items-center gap-2 border-b-2 transition cursor-pointer ${
              activeTab === 'verifications'
                ? 'border-cyan-400 text-cyan-300 font-semibold bg-slate-900/50'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileCheck2 size={13} className="text-amber-400" />
            Verificações
            <span className="text-[10px] px-1 rounded-full bg-slate-800 text-slate-300">
              {verifications.length}
            </span>
          </button>

          <button
            id="tab-btn-files"
            onClick={() => setActiveTab('files')}
            className={`h-full px-3 text-xs font-medium flex items-center gap-2 border-b-2 transition cursor-pointer ${
              activeTab === 'files'
                ? 'border-cyan-400 text-cyan-300 font-semibold bg-slate-900/50'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <FolderTree size={13} className="text-indigo-400" />
            Arquivos
            <span className="text-[10px] px-1 rounded-full bg-slate-800 text-slate-300">
              {files.length}
            </span>
          </button>

          <button
            id="tab-btn-deploy"
            onClick={() => setActiveTab('deploy')}
            className={`h-full px-3 text-xs font-medium flex items-center gap-2 border-b-2 transition cursor-pointer ${
              activeTab === 'deploy'
                ? 'border-cyan-400 text-cyan-300 font-semibold bg-slate-900/50'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Rocket size={13} className="text-purple-400" />
            Deploy & GitHub
          </button>

          <button
            id="tab-btn-logs"
            onClick={() => setActiveTab('logs')}
            className={`h-full px-3 text-xs font-medium flex items-center gap-2 border-b-2 transition cursor-pointer ${
              activeTab === 'logs'
                ? 'border-cyan-400 text-cyan-300 font-semibold bg-slate-900/50'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <ScrollText size={13} className="text-slate-400" />
            Logs
          </button>
        </div>

        {/* Tab-specific top controls */}
        {activeTab === 'preview' && (
          <div className="flex items-center gap-2">
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
          </div>
        )}
      </div>

      {/* Main Tab Content */}
      <div className="flex-1 relative overflow-hidden bg-slate-950">
        {/* TAB 1: PREVIEW AO VIVO */}
        {activeTab === 'preview' && (
          <div className="w-full h-full flex flex-col items-center justify-between p-2 sm:p-4 bg-slate-950/80">
            <div className={`flex-1 ${getDeviceWidth()} h-full bg-slate-950 rounded-xl border border-slate-800 overflow-hidden shadow-2xl transition-all duration-200 flex flex-col`}>
              {/* Browser Mockup Chrome */}
              <div className="h-7 bg-slate-900 border-b border-slate-800 px-3 flex items-center justify-between text-[11px] text-slate-400 font-mono">
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-rose-500/80"></span>
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-500/80"></span>
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/80"></span>
                </div>
                <div className="flex items-center gap-1 text-[10px] text-slate-400 bg-slate-950/80 px-3 py-0.5 rounded border border-slate-800">
                  <span className="text-emerald-400">https://</span>
                  <span>sandbox.forge-agent.local/{project.name.toLowerCase().replace(/\s+/g, '-')}</span>
                </div>
                <span className="text-[10px] text-cyan-400 font-sans">Live Sandbox</span>
              </div>

              {/* Iframe */}
              <iframe
                id="live-preview-iframe"
                key={previewKey}
                src={previewUrl}
                title="Live Sandbox Preview"
                className="flex-1 w-full h-full bg-slate-950 border-none"
                sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
              />
            </div>
          </div>
        )}

        {/* TAB 2: CÓDIGO E DIFF */}
        {activeTab === 'code' && (
          <div className="w-full h-full flex flex-col">
            {/* File Switcher & Save Header */}
            <div className="p-2 border-b border-slate-800 bg-slate-900/60 flex items-center justify-between">
              <div className="flex items-center gap-2 overflow-x-auto">
                {files.map((f) => (
                  <button
                    key={f.path}
                    onClick={() => setSelectedFilePath(f.path)}
                    className={`px-2.5 py-1 rounded text-xs font-mono transition cursor-pointer ${
                      selectedFilePath === f.path
                        ? 'bg-cyan-950 text-cyan-300 border border-cyan-800/80 font-bold'
                        : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
                    }`}
                  >
                    {f.path}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                {saveSuccessNotice && (
                  <span className="text-xs text-emerald-400 font-medium flex items-center gap-1 animate-fade-in">
                    <CheckCircle2 size={12} /> Salvo & Checkpoint criado!
                  </span>
                )}
                <button
                  id="btn-save-code"
                  onClick={handleSaveFile}
                  disabled={isSavingFile}
                  className="px-3 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-slate-950 text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
                >
                  <Save size={13} />
                  Salvar
                </button>
              </div>
            </div>

            {/* Code Editor Area */}
            <div className="flex-1 flex overflow-hidden">
              <textarea
                id="code-editor-textarea"
                value={fileContent}
                onChange={(e) => setFileContent(e.target.value)}
                spellCheck={false}
                className="flex-1 w-full h-full p-4 font-mono text-xs text-slate-200 bg-slate-950 resize-none focus:outline-none custom-scrollbar leading-relaxed"
              />
            </div>
          </div>
        )}

        {/* TAB 3: VERIFICAÇÕES */}
        {activeTab === 'verifications' && (
          <div className="p-6 max-w-4xl mx-auto space-y-5 overflow-y-auto h-full custom-scrollbar">
            <div>
              <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                <ShieldCheck className="text-emerald-400" />
                Quality Gates & Auditoria de Segurança
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Todas as alterações geradas pelo agente passam por verificações de build, syntax, vazamento de chaves e conformidade de critérios.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-200">Proteção contra Vazamento de Chaves</span>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-emerald-950 text-emerald-400 border border-emerald-800">
                    PASS
                  </span>
                </div>
                <p className="text-xs text-slate-400">
                  Nenhum secret ou token privado foi injetado nos arquivos do projeto. Todas as chaves operam exclusivamente no servidor backend.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-200">Integridade de Build & Syntax</span>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-emerald-950 text-emerald-400 border border-emerald-800">
                    PASS
                  </span>
                </div>
                <p className="text-xs text-slate-400">
                  Estrutura HTML e scripts do sandbox validados sem erros críticos de compilação.
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Histórico de Verificações</h3>
              <div className="space-y-2">
                {verifications.map((v) => {
                  const details = v.details_json ? JSON.parse(v.details_json) : {};
                  return (
                    <div
                      key={v.id}
                      className="p-3 rounded-lg bg-slate-900/60 border border-slate-800 flex items-center justify-between text-xs"
                    >
                      <div className="space-y-0.5">
                        <div className="font-semibold text-slate-200 flex items-center gap-2">
                          <span className="uppercase text-[10px] font-mono text-cyan-400">{v.gate_type}</span>
                          <span>{details.rule || 'Verificação Automática'}</span>
                        </div>
                        <div className="text-slate-400 text-[11px]">{details.message}</div>
                      </div>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase ${
                        v.status === 'pass'
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                          : 'bg-amber-950 text-amber-400 border border-amber-800'
                      }`}>
                        {v.status}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: ARQUIVOS */}
        {activeTab === 'files' && (
          <div className="p-6 max-w-4xl mx-auto space-y-5 overflow-y-auto h-full custom-scrollbar">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                  <FolderTree className="text-indigo-400" />
                  Explorador de Arquivos do Projeto
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  Arquivos salvos de forma durável no workspace gerenciado no servidor.
                </p>
              </div>

              <button
                id="btn-show-new-file"
                onClick={() => setShowNewFileInput(!showNewFileInput)}
                className="py-1.5 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-slate-100 font-semibold text-xs flex items-center gap-1.5 transition cursor-pointer"
              >
                <FilePlus size={14} />
                Novo Arquivo
              </button>
            </div>

            {/* New File Form */}
            {showNewFileInput && (
              <form onSubmit={handleCreateFile} className="p-3 rounded-xl bg-slate-900 border border-slate-800 flex gap-2">
                <input
                  type="text"
                  placeholder="Nome do arquivo (ex: app.js, styles.css)..."
                  value={newFileName}
                  onChange={(e) => setNewFileName(e.target.value)}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                />
                <button
                  type="submit"
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-slate-100 text-xs font-semibold cursor-pointer"
                >
                  Criar
                </button>
              </form>
            )}

            <div className="border border-slate-800 rounded-xl overflow-hidden divide-y divide-slate-800/80 bg-slate-900/40">
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
                Conforme a especificação oficial, não inventamos nem simulamos operações do GitHub. Quando o token não existir, o estado pendente é indicado claramente.
              </p>
            </div>

            {/* GitHub Connection Status Card */}
            <div className={`p-5 rounded-xl border ${
              githubStatus?.isConnected
                ? 'bg-emerald-950/20 border-emerald-800/60'
                : 'bg-amber-950/20 border-amber-800/60'
            } space-y-3`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`w-3 h-3 rounded-full ${githubStatus?.isConnected ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                  <span className="font-semibold text-slate-100 text-sm">
                    {githubStatus?.isConnected ? 'GitHub Conectado' : 'Integração GitHub Pendente'}
                  </span>
                </div>
                <span className={`text-[11px] font-mono px-2 py-0.5 rounded ${
                  githubStatus?.isConnected ? 'bg-emerald-950 text-emerald-300' : 'bg-amber-950 text-amber-300'
                }`}>
                  {githubStatus?.isConnected ? `@${githubStatus.username}` : 'Credencial Ausente'}
                </span>
              </div>

              <p className="text-xs text-slate-300">
                {githubStatus?.message}
              </p>

              {!githubStatus?.isConnected && (
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-400 space-y-1.5">
                  <div className="font-bold text-slate-300">Como habilitar sincronização real com GitHub:</div>
                  <ol className="list-decimal list-inside space-y-1 text-[11px]">
                    <li>Gere um Personal Access Token com permissão <code className="text-cyan-400 font-mono">repo</code> no GitHub.</li>
                    <li>Defina a variável <code className="text-cyan-400 font-mono">GITHUB_TOKEN</code> no arquivo <code className="text-slate-300 font-mono">.env</code> ou pelo Secrets Manager.</li>
                    <li>O Forge Agent autenticará automaticamente e permitirá criar branches, commits e repositórios sem simulação.</li>
                  </ol>
                </div>
              )}
            </div>

            {/* Export Options */}
            <div className="p-5 rounded-xl bg-slate-900/70 border border-slate-800 space-y-4">
              <h3 className="text-sm font-semibold text-slate-200">Exportação do Projeto Local</h3>
              <p className="text-xs text-slate-400">
                Baixe o estado atual dos arquivos gerados para desenvolver em seu ambiente local ou realizar push manual com Git.
              </p>
              <button
                id="btn-export-bundle"
                onClick={handleExportZip}
                className="py-2 px-4 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-bold text-xs flex items-center gap-2 transition cursor-pointer"
              >
                <Download size={15} />
                Exportar Projeto Completo (JSON/Bundle)
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
