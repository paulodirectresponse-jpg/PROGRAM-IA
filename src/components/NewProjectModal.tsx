import React, { useState } from 'react';
import { X, FolderPlus, GitBranch, Upload, Check, AlertCircle, FileArchive, Loader2 } from 'lucide-react';
import JSZip from 'jszip';

interface NewProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateProject: (data: {
    name: string;
    description: string;
    origin: 'novo' | 'local' | 'github';
    repo_url?: string;
    initialFiles?: Record<string, string>;
  }) => void;
}

export const NewProjectModal: React.FC<NewProjectModalProps> = ({ isOpen, onClose, onCreateProject }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [origin, setOrigin] = useState<'novo' | 'local' | 'github'>('novo');
  const [repoUrl, setRepoUrl] = useState('');
  const [zipFiles, setZipFiles] = useState<Record<string, string>>({});
  const [zipFileName, setZipFileName] = useState<string>('');
  const [isProcessingZip, setIsProcessingZip] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleZipFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessingZip(true);
    setZipError(null);
    setZipFileName(file.name);

    try {
      const zip = new JSZip();
      const loadedZip = await zip.loadAsync(file);
      const extracted: Record<string, string> = {};

      const entries = Object.keys(loadedZip.files);
      for (const relativePath of entries) {
        const zipEntry = loadedZip.files[relativePath];
        if (zipEntry.dir) continue;

        // Strip Mac OSX metadata folders
        if (relativePath.includes('__MACOSX') || relativePath.startsWith('.')) continue;

        // Check text file extensions
        const isText = /\.(html|css|js|jsx|ts|tsx|json|md|txt|svg)$/i.test(relativePath);
        if (isText) {
          const content = await zipEntry.async('text');
          // Clean root folder prefix if entire zip was in one folder
          const cleanPath = relativePath.replace(/^[^/]+\//, '');
          extracted[cleanPath || relativePath] = content;
        }
      }

      if (Object.keys(extracted).length === 0) {
        setZipError('Nenhum arquivo web ou texto legível (.html, .js, .css, etc.) encontrado no arquivo ZIP.');
        setZipFiles({});
      } else {
        setZipFiles(extracted);
        if (!name.trim()) {
          const defaultName = file.name.replace(/\.zip$/i, '').replace(/[-_]/g, ' ');
          setName(defaultName.charAt(0).toUpperCase() + defaultName.slice(1));
        }
      }
    } catch (err: any) {
      setZipError(`Falha ao descompactar arquivo ZIP: ${err.message || 'Arquivo corrompido'}`);
      setZipFiles({});
    } finally {
      setIsProcessingZip(false);
    }
  };

  const isGitHubUrlValid = (url: string) => {
    if (!url.trim()) return false;
    return (
      /(?:https?:\/\/)?(?:www\.)?github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+/.test(url.trim()) ||
      /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(url.trim())
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isSubmitting) return;

    if (origin === 'github' && !isGitHubUrlValid(repoUrl)) {
      alert('Por favor, informe uma URL de repositório válida do GitHub (Ex: https://github.com/usuario/repo ou usuario/repo).');
      return;
    }

    if (origin === 'local' && Object.keys(zipFiles).length === 0) {
      alert('Por favor, selecione um arquivo ZIP válido contendo os arquivos do projeto.');
      return;
    }

    setIsSubmitting(true);
    onCreateProject({
      name: name.trim(),
      description: description.trim(),
      origin,
      repo_url: repoUrl.trim(),
      initialFiles: origin === 'local' ? zipFiles : undefined,
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
            <label className="text-xs font-semibold text-slate-300">Origem do Projeto</label>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                id="btn-origin-novo"
                onClick={() => setOrigin('novo')}
                className={`p-2.5 rounded-xl border text-left transition cursor-pointer ${
                  origin === 'novo'
                    ? 'bg-cyan-950/60 border-cyan-600 text-cyan-200 shadow-xs'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <FolderPlus size={16} className="mb-1.5 text-cyan-400" />
                <div className="text-xs font-bold">Criar do Zero</div>
                <div className="text-[10px] text-slate-400 mt-0.5">Template web com live preview</div>
              </button>

              <button
                type="button"
                id="btn-origin-github"
                onClick={() => setOrigin('github')}
                className={`p-2.5 rounded-xl border text-left transition cursor-pointer ${
                  origin === 'github'
                    ? 'bg-cyan-950/60 border-cyan-600 text-cyan-200 shadow-xs'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <GitBranch size={16} className="mb-1.5 text-purple-400" />
                <div className="text-xs font-bold">Importar GitHub</div>
                <div className="text-[10px] text-slate-400 mt-0.5">Repositório remoto real</div>
              </button>

              <button
                type="button"
                id="btn-origin-local"
                onClick={() => setOrigin('local')}
                className={`p-2.5 rounded-xl border text-left transition cursor-pointer ${
                  origin === 'local'
                    ? 'bg-cyan-950/60 border-cyan-600 text-cyan-200 shadow-xs'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <Upload size={16} className="mb-1.5 text-amber-400" />
                <div className="text-xs font-bold">Importar ZIP</div>
                <div className="text-[10px] text-slate-400 mt-0.5">Descompactação no workspace</div>
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-300">Nome do Projeto *</label>
            <input
              id="input-project-name"
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
              id="input-project-desc"
              rows={2}
              placeholder="Descreva o que você deseja que a aplicação faça..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500 resize-none"
            />
          </div>

          {/* GitHub Input */}
          {origin === 'github' && (
            <div className="space-y-2 p-3 rounded-xl bg-slate-950 border border-slate-800 animate-fade-in">
              <label className="text-xs font-semibold text-slate-300 flex items-center justify-between">
                <span>URL do Repositório GitHub *</span>
                {repoUrl && isGitHubUrlValid(repoUrl) && (
                  <span className="text-[10px] text-emerald-400 flex items-center gap-1 font-mono">
                    <Check size={11} /> Formato válido
                  </span>
                )}
              </label>
              <input
                id="input-repo-url"
                type="text"
                required
                placeholder="https://github.com/usuario/meu-repo ou usuario/meu-repo"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500 font-mono"
              />
              <p className="text-[10px] text-slate-400">
                Os arquivos da branch principal serão baixados diretamente via REST API para o sandbox.
              </p>
            </div>
          )}

          {/* ZIP File Input */}
          {origin === 'local' && (
            <div className="space-y-2 p-3 rounded-xl bg-slate-950 border border-slate-800 animate-fade-in">
              <label className="text-xs font-semibold text-slate-300 flex items-center justify-between">
                <span>Arquivo ZIP do Projeto *</span>
                {Object.keys(zipFiles).length > 0 && (
                  <span className="text-[10px] text-emerald-400 flex items-center gap-1 font-mono">
                    <Check size={11} /> {Object.keys(zipFiles).length} arquivo(s) extraídos
                  </span>
                )}
              </label>

              <div className="relative border-2 border-dashed border-slate-700 hover:border-cyan-500/80 rounded-xl p-4 text-center transition bg-slate-900/50">
                <input
                  type="file"
                  id="zip-file-input"
                  accept=".zip,application/zip"
                  onChange={handleZipFileChange}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
                <div className="space-y-1.5 pointer-events-none">
                  <FileArchive size={24} className="mx-auto text-amber-400" />
                  <div className="text-xs font-medium text-slate-200">
                    {zipFileName ? zipFileName : 'Clique para selecionar ou arraste o arquivo .zip'}
                  </div>
                  <div className="text-[10px] text-slate-400">
                    Suporta arquivos HTML, CSS, JS, JSX, TS, TSX, JSON e imagens
                  </div>
                </div>
              </div>

              {isProcessingZip && (
                <div className="flex items-center gap-2 text-xs text-cyan-400 font-mono">
                  <Loader2 size={13} className="animate-spin" />
                  <span>Processando e descompactando arquivo ZIP...</span>
                </div>
              )}

              {zipError && (
                <div className="p-2 rounded bg-rose-950/60 border border-rose-800 text-[11px] text-rose-300 flex items-center gap-1.5">
                  <AlertCircle size={13} className="shrink-0" />
                  <span>{zipError}</span>
                </div>
              )}
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
              id="btn-confirm-create-project"
              disabled={
                !name.trim() ||
                isSubmitting ||
                isProcessingZip ||
                (origin === 'github' && !isGitHubUrlValid(repoUrl)) ||
                (origin === 'local' && Object.keys(zipFiles).length === 0)
              }
              className="px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:pointer-events-none text-slate-950 font-bold text-xs transition cursor-pointer flex items-center gap-1.5"
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  <span>Inicializando...</span>
                </>
              ) : (
                <span>Criar Projeto</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
