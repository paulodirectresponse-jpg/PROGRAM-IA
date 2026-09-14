import React, { useEffect, useState } from 'react';
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
  Bot,
  PanelLeftClose,
  PanelLeftOpen,
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
  onOpenAgents: () => void;
  agentEngineEnabled?: boolean;
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
  onOpenAgents,
  agentEngineEnabled = false,
  onDuplicateProject,
  onDeleteProject,
  onExportZip,
  activeProvider,
  onCollapsedChange,
}) => {
  const [collapsed,setCollapsed]=useState(()=>{try{return localStorage.getItem('forge.sidebar.collapsed')==='1'}catch{return false}});
  useEffect(()=>{
    try{localStorage.setItem('forge.sidebar.collapsed',collapsed?'1':'0')}catch{}
    onCollapsedChange?.(collapsed);
  },[collapsed,onCollapsedChange]);
  return (
    <aside
      id="forge-sidebar"
      className={`${collapsed?'w-16':'w-64'} bg-slate-950 border-r border-slate-800/80 flex flex-col justify-between select-none shrink-0 h-full transition-[width] duration-200`}
    >
      {/* Top Header & Brand */}
      <div className={`${collapsed?'p-2':'p-4'} space-y-4`}>
        <div className={`flex items-center ${collapsed?'flex-col gap-2':'justify-between'}`}>
          <div className="flex items-center gap-2.5 min-w-0">
            <button type="button" onClick={()=>setCollapsed(v=>!v)} title={collapsed?'Expandir barra lateral':'Recolher barra lateral'} className="w-9 h-9 rounded-xl bg-cyan-500 flex items-center justify-center font-black text-slate-950 text-base shadow-sm shrink-0">
              ⚡
            </button>
            {!collapsed&&<div className="min-w-0">
              <div className="text-sm font-bold text-slate-100 tracking-tight flex items-center gap-1.5">
                Forge Agent
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-400 font-mono border border-cyan-800/50 font-normal">v2.4</span>
              </div>
              <p className="text-[11px] text-slate-400">Software Workspace</p>
            </div>}
          </div>
          {!collapsed&&<button type="button" onClick={()=>setCollapsed(true)} title="Recolher barra lateral" className="h-9 w-9 inline-flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-900"><PanelLeftClose size={18}/></button>}
          {collapsed&&<button type="button" onClick={()=>setCollapsed(false)} title="Expandir barra lateral" className="h-9 w-9 inline-flex items-center justify-center rounded-lg text-slate-500 hover:text-cyan-300 hover:bg-slate-900"><PanelLeftOpen size={18}/></button>}
        </div>

        {/* New Project Button */}
        <button
          id="btn-sidebar-new-project"
          onClick={onOpenNewProject}
          title={collapsed?'Novo Projeto':undefined}
          className={`w-full py-2 ${collapsed?'px-2':'px-3'} rounded-lg bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-semibold text-xs flex items-center justify-center gap-1.5 shadow-sm transition cursor-pointer`}
        >
          <Plus size={18} />
          {!collapsed&&'Novo Projeto'}
        </button>

        {/* Projects Section */}
        <div className="space-y-1">
          {!collapsed&&<div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-2 py-1 flex items-center justify-between">
            <span>Seus Projetos</span>
            <span className="text-[10px] font-mono text-slate-500">{projects.length}</span>
          </div>}

          <div className="space-y-0.5 max-h-48 overflow-y-auto custom-scrollbar">
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
                      title={collapsed?proj.name:undefined}
                      className={`${collapsed?'justify-center':'truncate'} flex items-center gap-2 flex-1 text-left cursor-pointer`}
                    >
                      <FolderGit2 size={13} className={isSelected ? 'text-cyan-400 shrink-0' : 'text-slate-400 shrink-0'} />
                      {!collapsed&&<span className="truncate">{proj.name}</span>}
                    </button>

                    {!collapsed&&<div className="flex items-center gap-1 shrink-0 ml-1">
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
                    </div>}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Clean Shortcuts & Navigation */}
        <div className="space-y-1 pt-2 border-t border-slate-900">
          {!collapsed&&<div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-2 py-1">
            Espaço de Trabalho
          </div>}

          <button
            id="btn-nav-skills"
            onClick={onOpenSkills}
            className="w-full text-left px-2.5 py-1.5 rounded-md text-xs flex items-center justify-between text-slate-300 hover:bg-slate-900 hover:text-slate-100 transition cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <Sparkles size={14} className="text-amber-400" />
              {!collapsed&&'Skills do Agente'}
            </span>
          </button>

          <button
            id="btn-nav-checkpoints"
            onClick={onOpenCheckpoints}
            className="w-full text-left px-2.5 py-1.5 rounded-md text-xs flex items-center justify-between text-slate-300 hover:bg-slate-900 hover:text-slate-100 transition cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <History size={14} className="text-blue-400" />
              {!collapsed&&'Checkpoints & Histórico'}
            </span>
          </button>

          <button
            id="btn-nav-settings"
            onClick={() => onOpenProfileSettings('integrations')}
            className="w-full text-left px-2.5 py-1.5 rounded-md text-xs flex items-center justify-between text-slate-300 hover:bg-slate-900 hover:text-slate-100 transition cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <Sliders size={14} className="text-cyan-400" />
              {!collapsed&&'Configurações'}
            </span>
          </button>
          <button
            type="button"
            onClick={agentEngineEnabled ? onOpenAgents : undefined}
            disabled={!agentEngineEnabled}
            title={agentEngineEnabled ? 'Abrir agentes, perfis e métricas' : 'Agent Engine desativado neste runtime'}
            className={`w-full text-left px-2.5 py-1.5 rounded-md text-xs flex items-center justify-between transition ${
              agentEngineEnabled
                ? 'text-slate-300 hover:bg-slate-900 hover:text-slate-100 cursor-pointer'
                : 'text-slate-500 cursor-not-allowed'
            }`}
          >
            <span className="flex items-center gap-2">
              <Bot size={14} className={agentEngineEnabled ? 'text-emerald-400' : ''} />
              {!collapsed&&'Agentes & Métricas'}
            </span>
            {!collapsed&&<span className={`text-[9px] uppercase border rounded px-1.5 ${
              agentEngineEnabled
                ? 'border-emerald-800/70 bg-emerald-950/30 text-emerald-400'
                : 'border-slate-700 text-slate-500'
            }`}>
              {agentEngineEnabled ? 'Ativo' : 'Pausado'}
            </span>}
          </button>
        </div>
      </div>

      {/* User Profile & Engine Status Footer */}
      <div className={`${collapsed?'p-2':'p-3'} border-t border-slate-900/90 bg-slate-950/90 space-y-2`}>
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
            {!collapsed&&<div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-slate-200 truncate">
                {currentUser ? currentUser.name : 'Perfil de Usuário'}
              </div>
              <div className="text-[10px] text-slate-400 truncate">
                {currentUser ? currentUser.email : 'Configurações e Acesso'}
              </div>
            </div>}
          </div>
          {!collapsed&&<Sliders size={13} className="text-slate-400 hover:text-cyan-300 shrink-0 ml-1" />}
        </button>

        {/* Minimal Engine status */}
        {!collapsed&&<div className="px-2 py-1.5 rounded-lg bg-slate-900/50 border border-slate-800/60 flex items-center justify-between text-[11px]">
          <span className="flex items-center gap-1.5 text-slate-400 font-medium truncate">
            <Cpu size={12} className="text-cyan-400 shrink-0" />
            <span className="truncate">{activeProvider?.model_id || 'Nenhum modelo ativo'}</span>
          </span>
          {activeProvider?.is_configured ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400 shrink-0">
              <CheckCircle2 size={11} /> Conectado
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[10px] text-amber-400 shrink-0">
              <AlertCircle size={11} /> Configurar
            </span>
          )}
        </div>}

        {!collapsed&&<div className="flex items-center justify-between px-1 text-[10px] text-slate-400 font-mono">
          <span>Port 3000</span>
          <span className="text-emerald-400 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
            Online
          </span>
        </div>}
      </div>
    </aside>
  );
};


