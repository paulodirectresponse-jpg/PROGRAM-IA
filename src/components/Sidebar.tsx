import React from 'react';
import {
  FolderGit2,
  Plus,
  Sparkles,
  History,
  Copy,
  Trash2,
  Download,
  User,
  Sliders,
  CheckCircle2,
  AlertCircle,
  Cpu,
} from 'lucide-react';
import { Project, Provider, GitHubStatus, AuthUser } from '../types';
import { SettingsTab } from './SettingsProfileModal';

interface SidebarProps {
  projects: Project[];
  activeProject: Project | null;
  currentUser: AuthUser | null;
  onOpenAuth: () => void;
  onOpenProfileSettings: (tab?: SettingsTab) => void;
  onSelectProject: (p: Project) => void;
  onOpenNewProject: () => void;
  onOpenSkills: () => void;
  onOpenProviders: () => void;
  onOpenIntegrations: () => void;
  onOpenCredentials: () => void;
  onOpenCheckpoints: () => void;
  onDuplicateProject?: (id: string) => void;
  onDeleteProject?: (project: Project) => void;
  onExportZip?: (id: string) => void;
  activeProvider: Provider | null;
  githubStatus: GitHubStatus | null;
}

export const Sidebar: React.FC<SidebarProps> = ({
  projects,
  activeProject,
  currentUser,
  onOpenProfileSettings,
  onSelectProject,
  onOpenNewProject,
  onOpenSkills,
  onOpenCheckpoints,
  onDuplicateProject,
  onDeleteProject,
  onExportZip,
  activeProvider,
}) => {
  return (
    <aside
      id="forge-sidebar"
      className="w-64 bg-slate-950 border-r border-slate-800/80 flex flex-col justify-between select-none shrink-0 h-full"
    >
      {/* Top Header & Brand */}
      <div className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-cyan-500 flex items-center justify-center font-black text-slate-950 text-sm shadow-sm">
              ⚡
            </div>
            <div>
              <div className="text-sm font-bold text-slate-100 tracking-tight flex items-center gap-1.5">
                Forge Agent
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-400 font-mono border border-cyan-800/50 font-normal">v2.4</span>
              </div>
              <p className="text-[11px] text-slate-400">Software Workspace</p>
            </div>
          </div>
        </div>

        {/* New Project Button */}
        <button
          id="btn-sidebar-new-project"
          onClick={onOpenNewProject}
          className="w-full py-2 px-3 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-semibold text-xs flex items-center justify-center gap-1.5 shadow-sm transition cursor-pointer"
        >
          <Plus size={15} />
          Novo Projeto
        </button>

        {/* Projects Section */}
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-2 py-1 flex items-center justify-between">
            <span>Seus Projetos</span>
            <span className="text-[10px] font-mono text-slate-500">{projects.length}</span>
          </div>

          <div className="space-y-0.5 max-h-48 overflow-y-auto pr-1 custom-scrollbar">
            {projects.length === 0 ? (
              <div className="p-3 text-center text-xs text-slate-500 italic bg-slate-900/40 rounded-lg border border-slate-900">
                Nenhum projeto ativo nesta conta.
              </div>
            ) : (
              projects.map((proj) => {
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
                        {onDeleteProject && (
                          <button
                            type="button"
                            id={`btn-delete-project-${proj.id}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteProject(proj);
                            }}
                            title={`Excluir projeto "${proj.name}"`}
                            aria-label={`Excluir projeto ${proj.name}`}
                            className="p-1 rounded text-slate-400 hover:text-rose-400 hover:bg-rose-950/40 cursor-pointer transition"
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
              })
            )}
          </div>
        </div>

        {/* Clean Shortcuts & Navigation */}
        <div className="space-y-1 pt-2 border-t border-slate-900">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-2 py-1">
            Espaço de Trabalho
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
          </button>

          <button
            id="btn-nav-checkpoints"
            onClick={onOpenCheckpoints}
            className="w-full text-left px-2.5 py-1.5 rounded-md text-xs flex items-center justify-between text-slate-300 hover:bg-slate-900 hover:text-slate-100 transition cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <History size={14} className="text-blue-400" />
              Checkpoints & Histórico
            </span>
          </button>

          <button
            id="btn-nav-settings"
            onClick={() => onOpenProfileSettings('credentials')}
            className="w-full text-left px-2.5 py-1.5 rounded-md text-xs flex items-center justify-between text-slate-300 hover:bg-slate-900 hover:text-slate-100 transition cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <Sliders size={14} className="text-cyan-400" />
              Configurações & Chaves
            </span>
          </button>
        </div>
      </div>

      {/* User Profile & Engine Status Footer */}
      <div className="p-3 border-t border-slate-900/90 bg-slate-950/90 space-y-2">
        {/* User Account Button with direct access to Profile & Settings */}
        <button
          id="btn-sidebar-user-profile"
          onClick={() => onOpenProfileSettings('profile')}
          title="Abrir Perfil & Configurações"
          className={`w-full p-2 rounded-xl border flex items-center justify-between text-left transition cursor-pointer ${
            currentUser
              ? 'bg-slate-900/90 border-slate-800 hover:border-slate-700'
              : 'bg-cyan-950/40 border-cyan-800/60 hover:bg-cyan-900/50'
          }`}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-slate-800 text-cyan-400 flex items-center justify-center font-bold text-xs shrink-0">
              {currentUser ? currentUser.name.slice(0, 2).toUpperCase() : <User size={14} />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-slate-200 truncate">
                {currentUser ? currentUser.name : 'Perfil de Usuário'}
              </div>
              <div className="text-[10px] text-slate-400 truncate">
                {currentUser ? currentUser.email : 'Configurações e Acesso'}
              </div>
            </div>
          </div>
          <Sliders size={13} className="text-slate-400 hover:text-cyan-300 shrink-0 ml-1" />
        </button>

        {/* Minimal Engine status */}
        <div className="px-2 py-1.5 rounded-lg bg-slate-900/50 border border-slate-800/60 flex items-center justify-between text-[11px]">
          <span className="flex items-center gap-1.5 text-slate-400 font-medium truncate">
            <Cpu size={12} className="text-cyan-400 shrink-0" />
            <span className="truncate">{activeProvider?.name || 'Gemini 3.5 Flash'}</span>
          </span>
          {activeProvider?.is_configured ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400 shrink-0">
              <CheckCircle2 size={11} /> Conectado
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[10px] text-amber-400 shrink-0">
              <AlertCircle size={11} /> Fallback
            </span>
          )}
        </div>

        <div className="flex items-center justify-between px-1 text-[10px] text-slate-400 font-mono">
          <span>Port 3000</span>
          <span className="text-emerald-400 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
            Online
          </span>
        </div>
      </div>
    </aside>
  );
};
