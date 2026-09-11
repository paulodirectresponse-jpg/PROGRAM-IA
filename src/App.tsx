import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { ConversationPanel } from './components/ConversationPanel';
import { WorkspaceArea } from './components/WorkspaceArea';
import { NewProjectModal } from './components/NewProjectModal';
import { ProvidersModal } from './components/ProvidersModal';
import { SkillsModal } from './components/SkillsModal';
import { CheckpointsModal } from './components/CheckpointsModal';
import { IntegrationsModal } from './components/IntegrationsModal';
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
} from './types';

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activePlan, setActivePlan] = useState<Plan | null>(null);
  const [activeMode, setActiveMode] = useState<AgentMode>('plan');
  const [files, setFiles] = useState<ProjectFileItem[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [verifications, setVerifications] = useState<Verification[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [previewNonce, setPreviewNonce] = useState<number>(Date.now());

  // Modal visibility states
  const [isNewProjectOpen, setIsNewProjectOpen] = useState(false);
  const [isProvidersOpen, setIsProvidersOpen] = useState(false);
  const [isSkillsOpen, setIsSkillsOpen] = useState(false);
  const [isCheckpointsOpen, setIsCheckpointsOpen] = useState(false);
  const [isIntegrationsOpen, setIsIntegrationsOpen] = useState(false);

  // Abort controller ref
  const abortControllerRef = useRef<AbortController | null>(null);

  // Initial load
  useEffect(() => {
    loadProjects();
    loadSkills();
    loadProviders();
    loadGitHubStatus();
  }, []);

  const loadProjects = async () => {
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      if (data.projects) {
        setProjects(data.projects);
        if (!activeProject && data.projects.length > 0) {
          setActiveProject(data.projects[0]);
        }
      }
    } catch (err) {
      console.error('Falha ao carregar projetos:', err);
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
    try {
      // 1. Files
      const filesRes = await fetch(`/api/projects/${projectId}/files`);
      const filesData = await filesRes.json();
      if (filesData.files) setFiles(filesData.files);

      // 2. Conversation & Messages
      const convRes = await fetch(`/api/conversations/${projectId}`);
      const convData = await convRes.json();
      if (convData.messages) setMessages(convData.messages);
      if (convData.activePlan) setActivePlan(convData.activePlan);
      if (convData.conversation?.mode) setActiveMode(convData.conversation.mode);

      // 3. Project Details (Checkpoints & Verifications)
      const projRes = await fetch(`/api/projects/${projectId}`);
      const projData = await projRes.json();
      if (projData.checkpoints) setCheckpoints(projData.checkpoints);
      if (projData.verifications) setVerifications(projData.verifications);
    } catch (err) {
      console.error('Falha ao carregar detalhes do projeto:', err);
    }
  }, []);

  useEffect(() => {
    if (activeProject) {
      loadProjectDetails(activeProject.id);
    }
  }, [activeProject, loadProjectDetails]);

  // Handle create project
  const handleCreateProject = async (data: {
    name: string;
    description: string;
    origin: 'novo' | 'local' | 'github';
    repo_url?: string;
  }) => {
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (result.success && result.projectId) {
        await loadProjects();
        const createdProj = {
          id: result.projectId,
          workspace_id: 'ws-default',
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
      }
    } catch (err) {
      console.error('Erro ao criar projeto:', err);
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
      if (data.success && data.agentMessage) {
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
      if (data.success) {
        setActiveMode('build');
        setActivePlan(null);
        await loadProjectDetails(activeProject.id);
        setPreviewNonce(Date.now());
      }
    } catch (err) {
      console.error('Erro ao aprovar plano:', err);
    } finally {
      setIsLoading(false);
    }
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

  // Update provider
  const handleUpdateProvider = async (providerKey: string, baseUrl: string, modelId: string) => {
    try {
      await fetch('/api/providers/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerKey, baseUrl, modelId }),
      });
      await loadProviders();
    } catch (err) {
      console.error('Falha ao atualizar provedor:', err);
    }
  };

  const activeProvider = providers.find((p) => p.is_configured) || providers[0] || null;

  return (
    <div id="forge-agent-root" className="flex h-screen w-screen overflow-hidden bg-slate-950 text-slate-100 font-sans select-none">
      {/* 1. Sidebar */}
      <Sidebar
        projects={projects}
        activeProject={activeProject}
        onSelectProject={(p) => setActiveProject(p)}
        onOpenNewProject={() => setIsNewProjectOpen(true)}
        onOpenSkills={() => setIsSkillsOpen(true)}
        onOpenProviders={() => setIsProvidersOpen(true)}
        onOpenIntegrations={() => setIsIntegrationsOpen(true)}
        onOpenCheckpoints={() => setIsCheckpointsOpen(true)}
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
        activePlan={activePlan}
        isLoading={isLoading}
        onAbort={handleAbort}
        availableSkills={skills}
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
      />

      {/* Modals */}
      <NewProjectModal
        isOpen={isNewProjectOpen}
        onClose={() => setIsNewProjectOpen(false)}
        onCreateProject={handleCreateProject}
      />

      <ProvidersModal
        isOpen={isProvidersOpen}
        onClose={() => setIsProvidersOpen(false)}
        providers={providers}
        onUpdateProvider={handleUpdateProvider}
      />

      <SkillsModal
        isOpen={isSkillsOpen}
        onClose={() => setIsSkillsOpen(false)}
        skills={skills}
        onToggleSkill={handleToggleSkill}
      />

      <CheckpointsModal
        isOpen={isCheckpointsOpen}
        onClose={() => setIsCheckpointsOpen(false)}
        checkpoints={checkpoints}
        currentCheckpointId={activeProject?.current_checkpoint_id}
        onRestoreCheckpoint={handleRestoreCheckpoint}
      />

      <IntegrationsModal
        isOpen={isIntegrationsOpen}
        onClose={() => setIsIntegrationsOpen(false)}
        githubStatus={githubStatus}
        onRefreshGitHub={loadGitHubStatus}
        providers={providers}
      />
    </div>
  );
}
