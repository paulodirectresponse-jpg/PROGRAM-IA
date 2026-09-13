import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { ConversationPanel } from './components/ConversationPanel';
import { WorkspaceArea } from './components/WorkspaceArea';
import { NewProjectModal } from './components/NewProjectModal';
import { SkillsModal } from './components/SkillsModal';
import { AgentsModal } from './components/AgentsModal';
import { CheckpointsModal } from './components/CheckpointsModal';
import { AuthModal } from './components/AuthModal';
import { SettingsProfileModal, SettingsTab } from './components/SettingsProfileModal';
import { DeleteProjectModal } from './components/DeleteProjectModal';
import { CheckCircle2, AlertCircle, X } from 'lucide-react';
import {
  Project,
  Conversation,
  Message,
  Skill,
  Provider,
  Checkpoint,
  Verification,
  ProjectFileItem,
  GitHubStatus,
  AgentMode,
  Plan,
  ChangeProposal,
  AuthUser,
} from './types';

export default function App() {
  type SyncStatus = 'checking'|'not_configured'|'local_only'|'restoring'|'synced'|'conflict'|'error';
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activePlan, setActivePlan] = useState<Plan | null>(null);
  const [activeMode, setActiveMode] = useState<AgentMode>('auto');
  const [files, setFiles] = useState<ProjectFileItem[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [verifications, setVerifications] = useState<Verification[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState<number>(Date.now());

  // Modal visibility states
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [isNewProjectOpen, setIsNewProjectOpen] = useState(false);
  const [isSkillsOpen, setIsSkillsOpen] = useState(false);
  const [isAgentsOpen,setIsAgentsOpen]=useState(false);
  const [isCheckpointsOpen, setIsCheckpointsOpen] = useState(false);
  const [isSettingsProfileOpen, setIsSettingsProfileOpen] = useState(false);
  const [settingsProfileTab, setSettingsProfileTab] = useState<SettingsTab>('profile');
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [syncStatus,setSyncStatus]=useState<SyncStatus>('checking');
  const [isAccountHydrating,setIsAccountHydrating]=useState(true);
  const [localContinuationApproved,setLocalContinuationApproved]=useState(false);
  const [buildInfo,setBuildInfo]=useState<{version:string;sha:string}|null>(null);

  // Abort controller ref
  const abortControllerRef = useRef<AbortController | null>(null);

  // Initial load
  useEffect(() => {
    checkCurrentUser();
    fetch('/api/version').then(r=>r.json()).then(setBuildInfo).catch(()=>setBuildInfo(null));

  }, []);

  const checkCurrentUser = async () => {
    setIsAccountHydrating(true);
    setLocalContinuationApproved(false);
    setSyncStatus('restoring');
    try {
      const res = await fetch('/api/auth/me');
      const data = await res.json();
      if (data.authenticated && data.user) {
        setCurrentUser(data.user);
        setSyncStatus(normalizeSyncStatus(data.sync?.status));
        if(data.sync?.status!=='error'&&data.sync?.status!=='conflict')await Promise.all([loadProjects(), loadSkills(), loadProviders(), loadGitHubStatus()]);
      } else {
        setCurrentUser(null);
        setSyncStatus('not_configured');
      }
    } catch {
      setCurrentUser(null);
      setSyncStatus('error');
    } finally {
      setIsAccountHydrating(false);
    }
  };

  const handleLoginSuccess = (_user: AuthUser) => {
    void checkCurrentUser();
  };

  const normalizeSyncStatus=(status:unknown):SyncStatus=>{
    if(status==='restored'||status==='synced')return 'synced';
    if(status==='not_configured'||status==='local_only'||status==='restoring'||status==='conflict'||status==='error')return status;
    return 'error';
  };
  const refreshSyncStatus=async()=>{try{const r=await fetch('/api/sync/status');const d=await r.json();setSyncStatus(r.ok?normalizeSyncStatus(d.status):'error');}catch{setSyncStatus('error')}};

  const handleLogout = () => {
    setCurrentUser(null);
    setProjects([]);
    setActiveProject(null);
    setMessages([]);
    setFiles([]);
    setSkills([]); setProviders([]); setGithubStatus(null);
  };

  const loadProjects = async () => {
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Falha ao carregar projetos (${res.status})`);
      if (data.projects) {
        setProjects(data.projects);
        setProjectLoadError(null);
        if (data.projects.length > 0 && (!activeProject || !data.projects.some((p: Project) => p.id === activeProject.id))) {
          const remembered = localStorage.getItem('forge:lastActiveProjectId');
          setActiveProject(data.projects.find((p: Project) => p.id === remembered) || data.projects[0]);
        }
      }
    } catch (err: any) {
      console.error('Falha ao carregar projetos:', err);
      setProjectLoadError(err.message || 'Não foi possível carregar seus projetos.');
      setToastMessage({text: err.message || 'Não foi possível carregar seus projetos. Tente novamente.', type:'error'});
    }
  };

  const loadSkills = async () => {
    try {
      const res = await fetch('/api/skills');
      const data = await res.json();
      if (data.skills) setSkills(data.skills);
    } catch (err) {
      console.error('Falha ao carregar skills:', err);
    }
  };

  const loadProviders = async () => {
    try {
      const res = await fetch('/api/providers');
      const data = await res.json();
      if (data.providers) setProviders(data.providers);
    } catch (err) {
      console.error('Falha ao carregar provedores:', err);
    }
  };

  const loadGitHubStatus = async () => {
    try {
      const res = await fetch('/api/github/status');
      const data = await res.json();
      setGithubStatus(data);
    } catch (err) {
      console.error('Falha ao carregar status do GitHub:', err);
    }
  };

  // Load project details whenever activeProject changes
  const loadProjectDetails = useCallback(async (projectId: string) => {
    setMessages([]); setFiles([]); setActivePlan(null); setCheckpoints([]); setVerifications([]);
    try {
      // 1. Files
      const filesRes = await fetch(`/api/projects/${projectId}/files`);
      const filesData = await filesRes.json();
      if (!filesRes.ok) throw new Error(filesData.error || 'Falha ao carregar arquivos.');
      setFiles(Array.isArray(filesData.files) ? filesData.files : []);

      // 2. Conversation & Messages
      const convRes = await fetch(`/api/conversations/${projectId}`);
      const convData = await convRes.json();
      if (!convRes.ok) throw new Error(convData.error || 'Falha ao carregar conversa.');
      setMessages(Array.isArray(convData.messages) ? convData.messages : []);
      setActivePlan(convData.activePlan || null);
      if (convData.conversation?.mode) setActiveMode(convData.conversation.mode);

      // 3. Project Details (Checkpoints & Verifications)
      const projRes = await fetch(`/api/projects/${projectId}`);
      const projData = await projRes.json();
      if (!projRes.ok) throw new Error(projData.error || 'Falha ao carregar projeto.');
      setCheckpoints(Array.isArray(projData.checkpoints) ? projData.checkpoints : []);
      setVerifications(Array.isArray(projData.verifications) ? projData.verifications : []);
      setProjectLoadError(null);
    } catch (err: any) {
      console.error('Falha ao carregar detalhes do projeto:', err);
      setProjectLoadError(err.message || 'Não foi possível abrir este projeto.');
      setToastMessage({text: err.message || 'Não foi possível abrir este projeto. Tente novamente.', type:'error'});
    }
  }, []);

  useEffect(() => {
    if (activeProject) {
      localStorage.setItem('forge:lastActiveProjectId', activeProject.id);
      loadProjectDetails(activeProject.id);
    }
  }, [activeProject, loadProjectDetails]);

  // Handle create project
  const handleCreateProject = async (data: {
    name: string;
    description: string;
    origin: 'novo' | 'local' | 'github';
    repo_url?: string;
    zipData?: string;
  }) => {
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (!res.ok || !result.success || !result.projectId) {
        throw new Error(result.error || 'Não foi possível criar/importar o projeto.');
      }
      if (result.success && result.projectId) {
        await loadProjects();
        const createdProj = result.project || {
          id: result.projectId,
          workspace_id: '',
          name: data.name,
          description: data.description,
          origin: data.origin,
          repo_url: data.repo_url,
          branch: 'main',
          status: 'active' as const,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        setActiveProject(createdProj);
        setToastMessage({ text: 'Projeto criado/importado com sucesso.', type: 'success' });
      }
    } catch (err: any) {
      console.error('Erro ao criar projeto:', err);
      setToastMessage({ text: err?.message || 'Erro ao criar/importar projeto.', type: 'error' });
      throw err;
    }
  };

  // Handle send message
  const handleSendMessage = async (text: string, appliedSkills: string[]) => {
    if (!activeProject || isLoading) return;

    // Optimistically add user message
    const tempUserMsg: Message = {
      id: 'temp-' + Date.now(),
      conversation_id: 'active',
      sender: 'user',
      content: text,
      created_at: new Date().toISOString(),
      metadata: { mode: activeMode, appliedSkills },
    };
    setMessages((prev) => [...prev, tempUserMsg]);
    setIsLoading(true);

    abortControllerRef.current = new AbortController();

    try {
      const res = await fetch(`/api/conversations/${activeProject.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortControllerRef.current.signal,
        body: JSON.stringify({
          content: text,
          mode: activeMode,
          appliedSkills,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Não foi possível concluir o pedido.');
      if (data.agentMessage) {
        setMessages((prev) => [...prev, data.agentMessage]);
        if (data.plan) {
          setActivePlan(data.plan);
        }
        // Refresh files and preview
        await loadProjectDetails(activeProject.id);
        setPreviewNonce(Date.now());
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.error('Falha ao enviar mensagem:', err);
        const errMsg: Message = {
          id: 'err-' + Date.now(),
          conversation_id: 'active',
          sender: 'system',
          content: `Falha na requisição: ${err.message}`,
          created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, errMsg]);
      }
    } finally {
      setIsLoading(false);
      abortControllerRef.current = null;
    }
  };

  // Handle plan approval
  const handleApprovePlan = async (planId: string) => {
    if (!activeProject) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/conversations/${activeProject.id}/plan/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Não foi possível aprovar e construir o plano.');
      }

      setActiveMode('build');
      setActivePlan(null);
      if (data.agentMessage) {
        setMessages((prev) => [...prev, data.agentMessage]);
      }
      setToastMessage({ text: 'Plano aprovado. A proposta de construção foi gerada para sua revisão.', type: 'success' });
      await loadProjectDetails(activeProject.id);
      setPreviewNonce(Date.now());
    } catch (err: any) {
      console.error('Erro ao aprovar plano:', err);
      setToastMessage({ text: err?.message || 'Erro ao aprovar e construir o plano.', type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  // Handle applying a code change proposal (approved by user)
  const handleApplyProposal = async (proposal: ChangeProposal) => {
    if (!activeProject) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/conversations/${activeProject.id}/apply-proposal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposalId: proposal.id,
          summary: proposal.summary,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'A proposta não pôde ser aplicada.');
      if (data.success) {
        await loadProjectDetails(activeProject.id);
        setPreviewNonce(Date.now());
      }
    } catch (err: any) {
      console.error('Falha ao aplicar proposta:', err);
      await loadProjectDetails(activeProject.id);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRejectProposal = async (proposal: ChangeProposal) => {
    if (!activeProject) return;
    const res = await fetch(`/api/conversations/${activeProject.id}/reject-proposal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proposalId: proposal.id }),
    });
    if (res.ok) await loadProjectDetails(activeProject.id);
  };

  // Abort execution
  const handleAbort = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsLoading(false);
      abortControllerRef.current = null;
    }
  };

  // Restore checkpoint
  const handleRestoreCheckpoint = async (checkpointId: string) => {
    if (!activeProject) return;
    try {
      const res = await fetch(`/api/projects/${activeProject.id}/checkpoints/${checkpointId}/restore`, {
        method: 'POST',
      });
      const data = await res.json();
      if (data.success) {
        await loadProjectDetails(activeProject.id);
        setPreviewNonce(Date.now());
      }
    } catch (err) {
      console.error('Falha ao restaurar checkpoint:', err);
    }
  };

  // Toggle skill
  const handleToggleSkill = async (skillId: string, isActive: boolean) => {
    try {
      await fetch('/api/skills/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillId, isActive }),
      });
      await loadSkills();
    } catch (err) {
      console.error('Falha ao alternar skill:', err);
    }
  };

  // Duplicate project
  const handleDuplicateProject = async (projectId: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/duplicate`, { method: 'POST' });
      const data = await res.json();
      if (data.success && data.projectId) {
        await loadProjects();
        const pRes = await fetch(`/api/projects/${data.projectId}`);
        const pData = await pRes.json();
        if (pData.project) {
          setActiveProject(pData.project);
        }
      }
    } catch (err) {
      console.error('Falha ao duplicar projeto:', err);
    }
  };

  // Request project deletion (opens confirmation modal)
  const handleRequestDeleteProject = (proj: Project) => {
    setProjectToDelete(proj);
    setIsDeleteModalOpen(true);
  };

  // Perform project deletion
  const handleConfirmDeleteProject = async (projectId: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Falha ao excluir o projeto no servidor.');
      }

      const remaining = projects.filter((p) => p.id !== projectId);
      setProjects(remaining);

      if (activeProject?.id === projectId) {
        if (remaining.length > 0) {
          setActiveProject(remaining[0]);
          await loadProjectDetails(remaining[0].id);
        } else {
          setActiveProject(null);
          setFiles([]);
          setMessages([]);
          setActivePlan(null);
          setCheckpoints([]);
          setVerifications([]);
        }
      }

      await loadProjects();

      setToastMessage({
        text: `Projeto "${projectToDelete?.name || ''}" excluído com sucesso.`,
        type: 'success',
      });
      setTimeout(() => setToastMessage(null), 4000);

      return true;
    } catch (err: any) {
      console.error('Falha ao excluir projeto:', err);
      setToastMessage({
        text: err?.message || 'Erro ao excluir o projeto.',
        type: 'error',
      });
      setTimeout(() => setToastMessage(null), 5000);
      throw err;
    }
  };

  // Export project as ZIP
  const handleExportZip = (projectId: string) => {
    window.location.href = `/api/projects/${projectId}/export/zip`;
  };

  const activeProvider = providers.find((p) => Boolean(p.is_active)) || null;
  const previewProposalId=[...messages].reverse().map(message=>{try{return (message.metadata||JSON.parse(message.metadata_json||'{}'))?.proposal;}catch{return null;}}).find(proposal=>proposal?.status==='pending')?.id;
  const syncLabel:Record<SyncStatus,string>={synced:'● Nuvem sincronizada',not_configured:'○ Nuvem não configurada',local_only:'○ Somente local',restoring:'◌ Restaurando',conflict:'! Conflito de sincronização',error:'× Erro de sincronização',checking:'◌ Sincronizando'};

  return (
    <div id="forge-agent-root" className="flex h-screen w-screen overflow-hidden bg-slate-950 text-slate-100 font-sans select-none">
      {isAccountHydrating&&<div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950"><div className="rounded-xl border border-cyan-900/60 bg-slate-900 px-6 py-4 text-sm text-cyan-200 shadow-2xl">Restaurando sua conta...</div></div>}
      {!isAccountHydrating&&!localContinuationApproved&&(syncStatus==='error'||syncStatus==='conflict')&&<div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950 p-4"><div className="w-full max-w-md rounded-2xl border border-rose-900/60 bg-slate-900 p-6 shadow-2xl"><h2 className="text-base font-bold text-slate-100">{syncStatus==='conflict'?'Conflito de sincronização':'Não foi possível restaurar sua conta da nuvem.'}</h2><p className="mt-2 text-sm text-slate-400">Se continuar localmente, os dados deste dispositivo podem estar incompletos.</p><div className="mt-5 flex gap-3"><button onClick={()=>void checkCurrentUser()} className="rounded-lg bg-cyan-600 px-4 py-2 text-xs font-semibold text-slate-950">Tentar novamente</button>{syncStatus==='error'&&<button onClick={async()=>{setLocalContinuationApproved(true);setSyncStatus('local_only');await Promise.all([loadProjects(),loadSkills(),loadProviders(),loadGitHubStatus()])}} className="rounded-lg border border-slate-700 px-4 py-2 text-xs text-slate-300">Continuar somente localmente</button>}</div></div></div>}
      {currentUser&&<button onClick={async()=>{setSyncStatus('checking');try{const r=await fetch('/api/sync/push',{method:'POST'});const d=await r.json();setSyncStatus(r.ok?normalizeSyncStatus(d.status):'error')}catch{setSyncStatus('error')}}} className="fixed right-4 bottom-4 z-40 rounded-full border border-slate-700 bg-slate-900/90 px-3 py-1.5 text-[10px] text-slate-300 shadow-xl" title="Clique para sincronizar agora">{syncLabel[syncStatus]}</button>}
      {buildInfo&&<span className="fixed right-4 bottom-12 z-40 rounded border border-slate-800 bg-slate-950/80 px-2 py-1 text-[9px] font-mono text-slate-500">v{buildInfo.version} · {buildInfo.sha.slice(0,8)}</span>}
      {/* 1. Sidebar */}
      <Sidebar
        projects={projects}
        activeProject={activeProject}
        currentUser={currentUser}
        onOpenAuth={() => {
          setSettingsProfileTab('profile');
          setIsSettingsProfileOpen(true);
        }}
        onOpenProfileSettings={(tab?: SettingsTab) => {
          setSettingsProfileTab(tab || 'profile');
          setIsSettingsProfileOpen(true);
        }}
        onSelectProject={(p) => setActiveProject(p)}
        onOpenNewProject={() => setIsNewProjectOpen(true)}
        onOpenSkills={() => setIsSkillsOpen(true)}
        onOpenProviders={() => {
          setSettingsProfileTab('providers');
          setIsSettingsProfileOpen(true);
        }}
        onOpenIntegrations={() => {
          setSettingsProfileTab('integrations');
          setIsSettingsProfileOpen(true);
        }}
        onOpenCredentials={() => {
          setSettingsProfileTab('integrations');
          setIsSettingsProfileOpen(true);
        }}
        onOpenCheckpoints={() => setIsCheckpointsOpen(true)}
        onOpenAgents={() => setIsAgentsOpen(true)}
        onDuplicateProject={handleDuplicateProject}
        onDeleteProject={handleRequestDeleteProject}
        onExportZip={handleExportZip}
        activeProvider={activeProvider}
        githubStatus={githubStatus}
      />

      {/* 2. Conversation Panel */}
      <ConversationPanel
        messages={messages}
        activeMode={activeMode}
        onChangeMode={(m) => setActiveMode(m)}
        onSendMessage={handleSendMessage}
        onApprovePlan={handleApprovePlan}
        onApplyProposal={handleApplyProposal}
        onRejectProposal={handleRejectProposal}
        activePlan={activePlan}
        isLoading={isLoading}
        onAbort={handleAbort}
        availableSkills={skills}
        canSend={Boolean(activeProject) && !projectLoadError}
      />

      {/* 3. Main Workspace Area */}
      <WorkspaceArea
        project={activeProject}
        files={files}
        verifications={verifications}
        checkpoints={checkpoints}
        onRefreshFiles={() => activeProject && loadProjectDetails(activeProject.id)}
        onRestoreCheckpoint={handleRestoreCheckpoint}
        githubStatus={githubStatus}
        previewNonce={previewNonce}
        previewProposalId={previewProposalId}
        onDeleteProject={handleRequestDeleteProject}
        onDuplicateProject={handleDuplicateProject}
        onExportZip={handleExportZip}
        onOpenNewProject={() => setIsNewProjectOpen(true)}
      />

      {/* Modals */}
      <AuthModal
        isOpen={isAuthOpen || !currentUser}
        isMandatory={!currentUser}
        onClose={() => setIsAuthOpen(false)}
        currentUser={currentUser}
        onLoginSuccess={handleLoginSuccess}
        onLogout={handleLogout}
      />

      <NewProjectModal
        isOpen={isNewProjectOpen}
        onClose={() => setIsNewProjectOpen(false)}
        onCreateProject={handleCreateProject}
      />

      <SkillsModal
        isOpen={isSkillsOpen}
        onClose={() => setIsSkillsOpen(false)}
        skills={skills}
        onToggleSkill={handleToggleSkill}
        onCreateSkill={async data => {
          const res=await fetch('/api/skills',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
          const result=await res.json();if(!res.ok)throw new Error(result.error);
          await loadSkills();return true;
        }}
        onUpdateSkill={async (id,data) => {
          const res=await fetch(`/api/skills/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
          const result=await res.json();if(!res.ok)throw new Error(result.error);
          await loadSkills();return true;
        }}
        onDeleteSkill={async id => {
          const res=await fetch(`/api/skills/${id}`,{method:'DELETE'});
          if(!res.ok){setToastMessage({text:'Não foi possível excluir a skill.',type:'error'});return false;}
          await loadSkills();return true;
        }}
      />
      <AgentsModal isOpen={isAgentsOpen} onClose={()=>setIsAgentsOpen(false)}/>

      <CheckpointsModal
        isOpen={isCheckpointsOpen}
        onClose={() => setIsCheckpointsOpen(false)}
        checkpoints={checkpoints}
        currentCheckpointId={activeProject?.current_checkpoint_id}
        onRestoreCheckpoint={handleRestoreCheckpoint}
      />

      {/* Unified User Profile & Settings Modal */}
      <SettingsProfileModal
        isOpen={isSettingsProfileOpen}
        onClose={() => setIsSettingsProfileOpen(false)}
        currentUser={currentUser}
        onLoginSuccess={handleLoginSuccess}
        onLogout={handleLogout}
        defaultTab={settingsProfileTab}
        providers={providers}
        githubStatus={githubStatus}
        onRefreshGitHub={loadGitHubStatus}
        activeProject={activeProject}
        onCredentialsUpdated={() => {
          loadProviders();
          loadGitHubStatus();
        }}
      />

      {/* Delete Project Confirmation Modal */}
      <DeleteProjectModal
        isOpen={isDeleteModalOpen}
        project={projectToDelete}
        onClose={() => {
          setIsDeleteModalOpen(false);
          setProjectToDelete(null);
        }}
        onConfirmDelete={handleConfirmDeleteProject}
      />

      {/* Floating Status Notification Toast */}
      {toastMessage && (
        <div
          id="forge-toast-notice"
          className={`fixed bottom-5 right-5 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl border shadow-xl animate-in slide-in-from-bottom-3 duration-200 ${
            toastMessage.type === 'success'
              ? 'bg-slate-900 border-emerald-500/40 text-emerald-300 shadow-emerald-950/20'
              : 'bg-slate-900 border-rose-500/40 text-rose-300 shadow-rose-950/20'
          }`}
        >
          {toastMessage.type === 'success' ? (
            <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />
          ) : (
            <AlertCircle size={16} className="text-rose-400 shrink-0" />
          )}
          <span className="text-xs font-medium text-slate-200">{toastMessage.text}</span>
          <button
            type="button"
            onClick={() => setToastMessage(null)}
            className="p-0.5 rounded text-slate-400 hover:text-slate-200 transition ml-2 cursor-pointer"
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}


