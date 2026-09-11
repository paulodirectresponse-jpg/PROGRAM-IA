import React from 'react';
import {
  FolderGit2,
  Plus,
  Cpu,
  Sparkles,
  GitBranch,
  Settings2,
  Layers,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  History,
  Terminal,
  Copy,
  Trash2,
  Download,
} from 'lucide-react';
import { Project, Provider, GitHubStatus } from '../types';

interface SidebarProps {
  projects: Project[];
  activeProject: Project | null;
  onSelectProject: (p: Project) => void;
  onOpenNewProject: () => void;
  onOpenSkills: () => void;
  onOpenProviders: () => void;
  onOpenIntegrations: () => void;
  onOpenCheckpoints: () => void;
  onDuplicateProject?: (id: string) => void;
  onDeleteProject?: (id: string) => void;
  onExportZip?: (id: string) => void;
  activeProvider: Provider | null;
  githubStatus: GitHubStatus | null;
}

export const Sidebar: React.FC<SidebarProps> = ({
  projects,
  activeProject,
  onSelectProject,
  onOpenNewProject,
  onOpenSkills,
  onOpenProviders,
  onOpenIntegrations,
  onOpenCheckpoints,
  onDuplicateProject,
  onDeleteProject,
  onExportZip,
  activeProvider,
  githubStatus,
}) => {
  return (
    <aside
      id="forge-sidebar"
      className="w-64 bg-slate-950 border-r border-slate-800/80 flex flex-col justify-between select-none shrink-0 h-full"
    >
      {/* Brand & New Project */}
      <div className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center font-black text-slate-950 text-sm shadow-md shadow-cyan-950/50">
              ⚡
            </div>
            <div>
              <div className="text-sm font-bold text-slate-100 tracking-tight flex items-center gap-1.5">
                Forge Agent
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-400 font-mono border border-cyan-800/50 font-normal">v1.0</span>
              </div>
              <p className="text-[11px] text-slate-400">AI Software Workspace</p>
            </div>
          </div>
        </div>

        <button
          id="btn-sidebar-new-project"
          onClick={onOpenNewProject}
          className="w-full py-2 px-3 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-semibold text-xs flex items-center justify-center gap-1.5 shadow-sm transition cursor-pointer"
        >
          <Plus size={15} />
          Novo Projeto
        </button>

        {/* Navigation Sections */}
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-2 py-1">
            Workspace
          </div>

          <div className="space-y-0.5 max-h-48 overflow-y-auto pr-1 custom-scrollbar">
            {projects.map((proj) => {
              const isSelected = activeProject?.id === proj.id;
              return (
                <div
                  key={proj.id}
                  id={`project-item-${proj.id}`}
                  className={`group w-full px-2.5 py-1.5 rounded-md text-xs flex items-center justify-between transition ${
                    isSelected
                      ? 'bg-slate-800/90 text-cyan-300 font-medium border border-slate-700/60'
                      : 'text-slate-300 hover:bg-slate-900 hover:text-slate-200'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectProject(proj)}
                    className="truncate flex items-center gap-2 flex-1 text-left cursor-pointer"
                  >
                    <FolderGit2 size={13} className={isSelected ? 'text-cyan-400 shrink-0' : 'text-slate-400 shrink-0'} />
                    <span className="truncate">{proj.name}</span>
                  </button>

                  <div className="flex items-center gap-1 shrink-0 ml-1">
                    {/* Action buttons on hover or when selected */}
                    <div className="hidden group-hover:flex items-center gap-0.5">
                      {onExportZip && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onExportZip(proj.id);
                          }}
                          title="Baixar ZIP do projeto"
                          className="p-1 rounded text-slate-400 hover:text-cyan-300 hover:bg-slate-700/60 cursor-pointer"
                        >
                          <Download size={11} />
                        </button>
                      )}
                      {onDuplicateProject && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDuplicateProject(proj.id);
                          }}
                          title="Duplicar projeto"
                          className="p-1 rounded text-slate-400 hover:text-cyan-300 hover:bg-slate-700/60 cursor-pointer"
                        >
                          <Copy size={11} />
                        </button>
                      )}
                      {onDeleteProject && projects.length > 1 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`Deseja realmente excluir o projeto "${proj.name}"? Esta ação não pode ser desfeita.`)) {
                              onDeleteProject(proj.id);
                            }
                          }}
                          title="Excluir projeto"
                          className="p-1 rounded text-slate-400 hover:text-rose-400 hover:bg-slate-700/60 cursor-pointer"
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                    </div>

                    <span className="text-[10px] text-slate-400 font-mono group-hover:hidden">
                      {proj.branch}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Controls & Tools */}
        <div className="space-y-1 pt-2 border-t border-slate-900">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-2 py-1">
            Ferramentas
          </div>

          <button
            id="btn-nav-skills"
            onClick={onOpenSkills}
            className="w-full text-left px-2.5 py-1.5 rounded-md text-xs flex items-center justify-between text-slate-300 hover:bg-slate-900 hover:text-slate-100 transition cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <Sparkles size={14} className="text-amber-400" />
              Skills do Agente
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-900 text-slate-400 border border-slate-800">
              @skill
            </span>
          </button>

          <button
            id="btn-nav-providers"
            onClick={onOpenProviders}
            className="w-full text-left px-2.5 py-1.5 rounded-md text-xs flex items-center justify-between text-slate-300 hover:bg-slate-900 hover:text-slate-100 transition cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <Cpu size={14} className="text-indigo-400" />
              Provedores & Modelos
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-900 text-slate-400 border border-slate-800">
              OpenAI / Gemini
            </span>
          </button>

          <button
            id="btn-nav-integrations"
            onClick={onOpenIntegrations}
            className="w-full text-left px-2.5 py-1.5 rounded-md text-xs flex items-center justify-between text-slate-300 hover:bg-slate-900 hover:text-slate-100 transition cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <GitBranch size={14} className="text-emerald-400" />
              GitHub & Integrações
            </span>
            {githubStatus?.isConnected ? (
              <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
            ) : (
              <span className="text-[10px] text-amber-500 font-mono">Pendente</span>
            )}
          </button>

          <button
            id="btn-nav-checkpoints"
            onClick={onOpenCheckpoints}
            className="w-full text-left px-2.5 py-1.5 rounded-md text-xs flex items-center justify-between text-slate-300 hover:bg-slate-900 hover:text-slate-100 transition cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <History size={14} className="text-blue-400" />
              Checkpoints & Rollback
            </span>
          </button>
        </div>
      </div>

      {/* Connection status footer */}
      <div className="p-3 border-t border-slate-900/90 bg-slate-950/90 space-y-2">
        <div className="p-2 rounded-lg bg-slate-900/80 border border-slate-800 text-[11px] space-y-1.5">
          <div className="flex items-center justify-between text-slate-400">
            <span className="flex items-center gap-1.5 font-medium">
              <Cpu size={12} className="text-cyan-400" />
              Motor IA
            </span>
            {activeProvider?.is_configured ? (
              <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400 font-mono">
                <CheckCircle2 size={11} /> Conectado
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[10px] text-amber-400 font-mono">
                <AlertCircle size={11} /> Fallback
              </span>
            )}
          </div>
          <div className="text-[10px] text-slate-400 font-mono truncate">
            {activeProvider?.name || 'OpenAI-compatible / Gemini'}
          </div>
        </div>

        <div className="flex items-center justify-between px-1 text-[10px] text-slate-400 font-mono">
          <span>Port 3000 • Ingress OK</span>
          <span className="text-emerald-400 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
            Online
          </span>
        </div>
      </div>
    </aside>
  );
};
