import React, { useState, useEffect } from 'react';
import {
  X,
  User,
  Key,
  Cpu,
  GitBranch,
  ShieldCheck,
  LogOut,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Trash2,
  Eye,
  EyeOff,
  Save,
  Play,
  Loader2,
  Lock,
  ExternalLink,
  Flame,
  Layers,
  Database,
  Sliders,
} from 'lucide-react';
import {
  AuthUser,
  SecretSummary,
  Provider,
  GitHubStatus,
  Project,
  ConnectionTestResult,
} from '../types';

export type SettingsTab = 'profile' | 'credentials' | 'providers' | 'integrations' | 'security';

interface SettingsProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: AuthUser | null;
  onLoginSuccess: (user: AuthUser) => void;
  onLogout: () => void;
  defaultTab?: SettingsTab;
  providers: Provider[];
  onUpdateProvider: (providerKey: string, baseUrl: string, modelId: string) => void;
  githubStatus: GitHubStatus | null;
  onRefreshGitHub: () => void;
  activeProject: Project | null;
  onCredentialsUpdated?: () => void;
}

interface ServiceDef {
  key: string;
  name: string;
  category: 'git' | 'cloud' | 'backend';
  desc: string;
  placeholder: string;
  docsUrl: string;
}

const SUPPORTED_CREDENTIALS: ServiceDef[] = [
  {
    key: 'github',
    name: 'GitHub Personal Access Token (PAT)',
    category: 'git',
    desc: 'Token de autenticação do GitHub com permissão repo para commits, push, branches e pull requests.',
    placeholder: 'ghp_...',
    docsUrl: 'https://github.com/settings/tokens',
  },
  {
    key: 'firebase',
    name: 'Firebase / Google Cloud API Key & Project ID',
    category: 'cloud',
    desc: 'Credenciais do projeto Firebase (gen-lang-client-... ou Web API Key) para Firestore e Auth.',
    placeholder: 'AIzaSy... ou ID do Projeto',
    docsUrl: 'https://console.firebase.google.com',
  },
  {
    key: 'cloudflare',
    name: 'Cloudflare API Token',
    category: 'cloud',
    desc: 'Token de API da Cloudflare com permissões de Workers, Pages ou DNS para deploy na borda.',
    placeholder: 'Token de API Cloudflare...',
    docsUrl: 'https://dash.cloudflare.com/profile/api-tokens',
  },
  {
    key: 'supabase',
    name: 'Supabase Project Key / Service Role',
    category: 'backend',
    desc: 'Chave de acesso anon ou service_role da sua instância Supabase PostgreSQL.',
    placeholder: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    docsUrl: 'https://supabase.com/dashboard/project/_/settings/api',
  },
];

export const SettingsProfileModal: React.FC<SettingsProfileModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  onLoginSuccess,
  onLogout,
  defaultTab = 'profile',
  providers,
  onUpdateProvider,
  githubStatus,
  onRefreshGitHub,
  activeProject,
  onCredentialsUpdated,
}) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>(defaultTab);

  // Auth Form State (when not logged in or switching)
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authName, setAuthName] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSuccess, setAuthSuccess] = useState<string | null>(null);

  // Secrets State
  const [secrets, setSecrets] = useState<SecretSummary[]>([]);
  const [loadingSecrets, setLoadingSecrets] = useState(false);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [showPlain, setShowPlain] = useState<Record<string, boolean>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ConnectionTestResult>>({});

  // Providers / AI Models State
  const [selectedProviderKey, setSelectedProviderKey] = useState<string>('gemini');
  const activeProv = providers.find((p) => p.provider_key === selectedProviderKey) || providers[0];
  const [provBaseUrl, setProvBaseUrl] = useState(activeProv?.base_url || '');
  const [provModelId, setProvModelId] = useState(activeProv?.model_id || '');
  const [provApiKey, setProvApiKey] = useState('');
  const [showProvKey, setShowProvKey] = useState(false);
  const [provSaveNotice, setProvSaveNotice] = useState(false);
  const [isTestingProv, setIsTestingProv] = useState(false);
  const [provTestResult, setProvTestResult] = useState<{ success: boolean; message: string; status?: string } | null>(null);

  // Update tab when defaultTab changes
  useEffect(() => {
    if (isOpen) {
      setActiveTab(defaultTab);
      loadSecrets();
    }
  }, [isOpen, defaultTab]);

  useEffect(() => {
    if (activeProv) {
      setProvBaseUrl(activeProv.base_url);
      setProvModelId(activeProv.model_id);
      setProvApiKey('');
      setProvTestResult(null);
    }
  }, [selectedProviderKey, activeProv?.provider_key]);

  const loadSecrets = async () => {
    setLoadingSecrets(true);
    try {
      const res = await fetch('/api/secrets');
      const data = await res.json();
      if (data.secrets) setSecrets(data.secrets);
    } catch (err) {
      console.error('Falha ao listar segredos:', err);
    } finally {
      setLoadingSecrets(false);
    }
  };

  if (!isOpen) return null;

  // Handle Auth Submit
  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthSuccess(null);
    setAuthLoading(true);

    try {
      const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body = authMode === 'login'
        ? { email: authEmail, password: authPassword }
        : { email: authEmail, password: authPassword, name: authName };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Erro ao processar autenticação.');
      }

      setAuthSuccess(authMode === 'login' ? 'Login realizado com sucesso!' : 'Conta criada com sucesso!');
      onLoginSuccess(data.user);
      loadSecrets();
      setTimeout(() => {
        setAuthSuccess(null);
      }, 1500);
    } catch (err: any) {
      setAuthError(err.message || 'Falha na comunicação com o servidor.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogoutClick = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      onLogout();
    } catch (err: any) {
      console.error('Erro ao sair:', err);
    }
  };

  // Handle Secret Save
  const handleSaveSecret = async (serviceKey: string) => {
    const val = inputValues[serviceKey];
    if (!val || !val.trim()) return;

    setSavingKey(serviceKey);
    try {
      const res = await fetch('/api/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerKey: serviceKey,
          secretValue: val.trim(),
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Falha ao criptografar segredo');
      }

      setInputValues((prev) => ({ ...prev, [serviceKey]: '' }));
      await loadSecrets();
      onCredentialsUpdated?.();
      onRefreshGitHub();
    } catch (err: any) {
      alert(`Erro: ${err.message}`);
    } finally {
      setSavingKey(null);
    }
  };

  const handleDeleteSecret = async (serviceKey: string) => {
    if (!confirm('Deseja realmente remover esta chave criptografada?')) return;
    try {
      await fetch(`/api/secrets/${serviceKey}`, { method: 'DELETE' });
      await loadSecrets();
      setTestResults((prev) => {
        const next = { ...prev };
        delete next[serviceKey];
        return next;
      });
      onCredentialsUpdated?.();
      onRefreshGitHub();
    } catch (err) {
      console.error('Falha ao deletar chave:', err);
    }
  };

  const handleTestSecret = async (serviceKey: string) => {
    setTestingKey(serviceKey);
    try {
      const res = await fetch('/api/secrets/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerKey: serviceKey }),
      });
      const data: ConnectionTestResult = await res.json();
      setTestResults((prev) => ({ ...prev, [serviceKey]: data }));
    } catch (err: any) {
      setTestResults((prev) => ({
        ...prev,
        [serviceKey]: {
          success: false,
          code: 'network_error',
          message: `Erro na validação: ${err.message}`,
        },
      }));
    } finally {
      setTestingKey(null);
    }
  };

  // Provider save with API Key
  const handleSaveProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProv) return;

    try {
      const res = await fetch('/api/providers/save-with-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerKey: activeProv.provider_key,
          baseUrl: provBaseUrl,
          modelId: provModelId,
          apiKey: provApiKey.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao salvar provedor e chave de API.');

      onUpdateProvider(activeProv.provider_key, provBaseUrl, provModelId);
      setProvApiKey('');
      await loadSecrets();
      onCredentialsUpdated?.();

      setProvSaveNotice(true);
      setTimeout(() => setProvSaveNotice(false), 2500);
    } catch (err: any) {
      alert(`Erro: ${err.message}`);
    }
  };

  const handleTestProvider = async () => {
    setIsTestingProv(true);
    setProvTestResult(null);
    try {
      const res = await fetch('/api/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerKey: activeProv?.provider_key || selectedProviderKey,
          baseUrl: provBaseUrl,
          modelId: provModelId,
        }),
      });
      const data = await res.json();
      setProvTestResult(data);
    } catch (err: any) {
      setProvTestResult({
        success: false,
        message: `Falha na requisição: ${err.message}`,
        status: 'network_error',
      });
    } finally {
      setIsTestingProv(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between shrink-0 bg-slate-900/80">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-cyan-600/20 text-cyan-400 border border-cyan-800/60 flex items-center justify-center font-bold text-sm">
              <Sliders size={16} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">Configurações & Perfil</h2>
              <p className="text-[11px] text-slate-400">Gerenciamento de conta, chaves criptografadas e integrações</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Clean Top Navigation Tabs */}
        <div className="flex items-center border-b border-slate-800 bg-slate-950/50 px-4 gap-1 shrink-0 overflow-x-auto">
          <button
            onClick={() => setActiveTab('profile')}
            className={`py-2.5 px-3 text-xs font-medium flex items-center gap-1.5 border-b-2 transition cursor-pointer ${
              activeTab === 'profile'
                ? 'border-cyan-400 text-cyan-300 font-semibold bg-slate-900/40'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <User size={14} />
            Perfil
          </button>

          <button
            onClick={() => setActiveTab('credentials')}
            className={`py-2.5 px-3 text-xs font-medium flex items-center gap-1.5 border-b-2 transition cursor-pointer ${
              activeTab === 'credentials'
                ? 'border-cyan-400 text-cyan-300 font-semibold bg-slate-900/40'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Key size={14} />
            Credenciais & Chaves
            {secrets.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-800 text-cyan-300 font-mono">
                {secrets.length}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('providers')}
            className={`py-2.5 px-3 text-xs font-medium flex items-center gap-1.5 border-b-2 transition cursor-pointer ${
              activeTab === 'providers'
                ? 'border-cyan-400 text-cyan-300 font-semibold bg-slate-900/40'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Cpu size={14} />
            Modelos de IA
          </button>

          <button
            onClick={() => setActiveTab('integrations')}
            className={`py-2.5 px-3 text-xs font-medium flex items-center gap-1.5 border-b-2 transition cursor-pointer ${
              activeTab === 'integrations'
                ? 'border-cyan-400 text-cyan-300 font-semibold bg-slate-900/40'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <GitBranch size={14} />
            Integrações
            {githubStatus?.isConnected && (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('security')}
            className={`py-2.5 px-3 text-xs font-medium flex items-center gap-1.5 border-b-2 transition cursor-pointer ${
              activeTab === 'security'
                ? 'border-cyan-400 text-cyan-300 font-semibold bg-slate-900/40'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <ShieldCheck size={14} />
            Segurança
          </button>
        </div>

        {/* Tab Body */}
        <div className="p-5 overflow-y-auto flex-1 custom-scrollbar space-y-4">
          {/* TAB: PROFILE */}
          {activeTab === 'profile' && (
            <div className="space-y-4">
              {currentUser ? (
                <div className="space-y-4">
                  <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-cyan-600 to-blue-700 text-white flex items-center justify-center font-black text-lg shadow-md">
                        {currentUser.name ? currentUser.name.slice(0, 2).toUpperCase() : 'US'}
                      </div>
                      <div>
                        <div className="text-sm font-bold text-slate-100 flex items-center gap-2">
                          {currentUser.name}
                          <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800/50 font-normal">
                            {currentUser.role}
                          </span>
                        </div>
                        <div className="text-xs text-slate-400">{currentUser.email}</div>
                        <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                          ID: {currentUser.id}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={handleLogoutClick}
                      className="px-3 py-1.5 rounded-lg border border-rose-900/60 bg-rose-950/30 hover:bg-rose-900/50 text-rose-300 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
                    >
                      <LogOut size={13} />
                      Sair da Conta
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-3 rounded-xl bg-slate-950/50 border border-slate-800 space-y-1">
                      <div className="text-[11px] text-slate-400 font-medium flex items-center gap-1.5">
                        <Lock size={12} className="text-emerald-400" />
                        Isolamento de Dados
                      </div>
                      <div className="text-xs text-slate-200">
                        Projetos, arquivos, conversas e chaves vinculados exclusivamente ao seu ID.
                      </div>
                    </div>

                    <div className="p-3 rounded-xl bg-slate-950/50 border border-slate-800 space-y-1">
                      <div className="text-[11px] text-slate-400 font-medium flex items-center gap-1.5">
                        <Key size={12} className="text-cyan-400" />
                        Chaves Criptografadas
                      </div>
                      <div className="text-xs text-slate-200">
                        {secrets.length} credenciais seguras registradas em cofre AES-256-GCM.
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="p-3 rounded-xl bg-cyan-950/30 border border-cyan-800/50 text-xs text-cyan-300 flex items-center gap-2">
                    <ShieldCheck size={16} className="shrink-0" />
                    <span>Cadastre-se ou entre para manter seus projetos e credenciais criptografadas salvas.</span>
                  </div>

                  <div className="flex border-b border-slate-800">
                    <button
                      onClick={() => setAuthMode('login')}
                      className={`flex-1 py-2 text-xs font-semibold text-center border-b-2 transition cursor-pointer ${
                        authMode === 'login'
                          ? 'border-cyan-400 text-cyan-300'
                          : 'border-transparent text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Entrar
                    </button>
                    <button
                      onClick={() => setAuthMode('register')}
                      className={`flex-1 py-2 text-xs font-semibold text-center border-b-2 transition cursor-pointer ${
                        authMode === 'register'
                          ? 'border-cyan-400 text-cyan-300'
                          : 'border-transparent text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Criar Conta
                    </button>
                  </div>

                  {authError && (
                    <div className="p-2.5 rounded-lg bg-rose-950/60 border border-rose-800 text-rose-300 text-xs flex items-center gap-2">
                      <AlertCircle size={14} className="shrink-0" />
                      <span>{authError}</span>
                    </div>
                  )}

                  {authSuccess && (
                    <div className="p-2.5 rounded-lg bg-emerald-950/60 border border-emerald-800 text-emerald-300 text-xs flex items-center gap-2">
                      <CheckCircle2 size={14} className="shrink-0" />
                      <span>{authSuccess}</span>
                    </div>
                  )}

                  <form onSubmit={handleAuthSubmit} className="space-y-3">
                    {authMode === 'register' && (
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-slate-300">Seu Nome</label>
                        <input
                          type="text"
                          required
                          value={authName}
                          onChange={(e) => setAuthName(e.target.value)}
                          placeholder="Ex: Maria Dev"
                          className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-cyan-600"
                        />
                      </div>
                    )}

                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-slate-300">Endereço de E-mail</label>
                      <input
                        type="email"
                        required
                        value={authEmail}
                        onChange={(e) => setAuthEmail(e.target.value)}
                        placeholder="dev@exemplo.com"
                        className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-cyan-600"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-slate-300">Senha Segura</label>
                      <input
                        type="password"
                        required
                        minLength={8}
                        value={authPassword}
                        onChange={(e) => setAuthPassword(e.target.value)}
                        placeholder="Mínimo 8 caracteres"
                        className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-cyan-600"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={authLoading}
                      className="w-full py-2 px-3 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-slate-950 font-bold text-xs transition cursor-pointer flex items-center justify-center gap-2"
                    >
                      {authLoading && <Loader2 size={13} className="animate-spin" />}
                      {authMode === 'login' ? 'Acessar Conta' : 'Concluir Cadastro'}
                    </button>
                  </form>
                </div>
              )}
            </div>
          )}

          {/* TAB: CREDENTIALS (NON-AI: GITHUB, FIREBASE, CLOUDFLARE, SUPABASE) */}
          {activeTab === 'credentials' && (
            <div className="space-y-4">
              <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 text-xs text-slate-300 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Lock size={15} className="text-cyan-400 shrink-0" />
                  <span>Cofre de credenciais para integrações externas (Git, Firebase, Cloudflare, Supabase). Chaves de modelos de IA são configuradas diretamente na aba <strong>Modelos de IA</strong>.</span>
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800/60 shrink-0">
                  AES-256-GCM
                </span>
              </div>

              <div className="space-y-3">
                {SUPPORTED_CREDENTIALS.map((serv) => {
                  const stored = secrets.find((s) => s.service_key === serv.key);
                  const isConfigured = Boolean(stored);
                  const inputVal = inputValues[serv.key] || '';
                  const isVisible = Boolean(showPlain[serv.key]);
                  const isSaving = savingKey === serv.key;
                  const isTesting = testingKey === serv.key;
                  const testRes = testResults[serv.key];

                  return (
                    <div
                      key={serv.key}
                      className="p-3.5 rounded-xl border border-slate-800 bg-slate-950/60 space-y-2.5 transition"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-xs font-semibold text-slate-200 flex items-center gap-2">
                            {serv.name}
                            {isConfigured ? (
                              <span className="text-[10px] px-2 py-0.2 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-800/60 font-mono">
                                Armazenada ({stored?.masked_hint})
                              </span>
                            ) : (
                              <span className="text-[10px] px-2 py-0.2 rounded-full bg-slate-800 text-slate-400 font-mono">
                                Não configurada
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-400 mt-0.5">{serv.desc}</p>
                        </div>

                        {isConfigured && (
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => handleTestSecret(serv.key)}
                              disabled={isTesting}
                              title="Validar conectividade"
                              className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] flex items-center gap-1 transition cursor-pointer"
                            >
                              {isTesting ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                              Testar
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteSecret(serv.key)}
                              title="Remover chave"
                              className="p-1 rounded text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition cursor-pointer"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        )}
                      </div>

                      {testRes && (
                        <div
                          className={`p-2 rounded-lg text-xs flex items-center gap-2 ${
                            testRes.success
                              ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-800/50'
                              : 'bg-rose-950/60 text-rose-300 border border-rose-800/50'
                          }`}
                        >
                          {testRes.success ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
                          <span>{testRes.message}</span>
                        </div>
                      )}

                      <div className="flex items-center gap-2">
                        <div className="relative flex-1">
                          <input
                            type={isVisible ? 'text' : 'password'}
                            value={inputVal}
                            onChange={(e) =>
                              setInputValues((prev) => ({ ...prev, [serv.key]: e.target.value }))
                            }
                            placeholder={isConfigured ? 'Atualizar chave...' : serv.placeholder}
                            className="w-full pl-3 pr-8 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-600 font-mono"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setShowPlain((prev) => ({ ...prev, [serv.key]: !prev[serv.key] }))
                            }
                            className="absolute right-2 top-2 text-slate-400 hover:text-slate-200 cursor-pointer"
                          >
                            {isVisible ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleSaveSecret(serv.key)}
                          disabled={!inputVal.trim() || isSaving}
                          className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-30 disabled:pointer-events-none text-slate-950 font-bold text-xs flex items-center gap-1.5 transition cursor-pointer"
                        >
                          {isSaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                          Salvar
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB: AI MODELS (WITH DIRECT API KEY & MODEL CONFIG) */}
          {activeTab === 'providers' && (
            <div className="space-y-4">
              <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 text-xs text-slate-300 flex items-center gap-2">
                <Cpu size={16} className="text-cyan-400 shrink-0" />
                <span>
                  Configure o Modelo de IA e sua Chave de API diretamente aqui. Ao salvar, a chave e as configurações do modelo são sincronizadas automaticamente.
                </span>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-300">Selecione o Provedor / Modelo de IA</label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {providers.map((prov) => {
                    const isSel = (activeProv?.provider_key || selectedProviderKey) === prov.provider_key;
                    return (
                      <button
                        key={prov.id}
                        type="button"
                        onClick={() => setSelectedProviderKey(prov.provider_key)}
                        className={`p-3 rounded-xl border text-left transition cursor-pointer flex flex-col justify-between ${
                          isSel
                            ? 'bg-slate-800/90 border-cyan-500/70 shadow-sm ring-1 ring-cyan-500/40'
                            : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center justify-between w-full">
                          <span className="text-xs font-bold text-slate-100">{prov.name}</span>
                          {prov.is_configured ? (
                            <span className="w-2 h-2 rounded-full bg-emerald-400" title="Chave configurada"></span>
                          ) : (
                            <span className="w-2 h-2 rounded-full bg-amber-500" title="Sem chave"></span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-400 font-mono mt-1 truncate">
                          {prov.model_id}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {activeProv && (
                <form onSubmit={handleSaveProvider} className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 space-y-3.5">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-bold text-slate-200 flex items-center gap-2">
                      <span>Configurações & Chave: {activeProv.name}</span>
                      {activeProv.is_configured ? (
                        <span className="text-[10px] px-2 py-0.2 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-800/60 font-mono">
                          Configurado ({activeProv.masked_hint || 'Chave Salva'})
                        </span>
                      ) : (
                        <span className="text-[10px] px-2 py-0.2 rounded-full bg-amber-950 text-amber-300 border border-amber-800/60 font-mono">
                          Necessita de Chave API
                        </span>
                      )}
                    </div>
                  </div>

                  {/* API Key Field */}
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-slate-300 flex items-center justify-between">
                      <span>Chave de API ({activeProv.name})</span>
                      {activeProv.masked_hint && (
                        <span className="text-[10px] text-slate-400 font-mono">
                          Atual: {activeProv.masked_hint}
                        </span>
                      )}
                    </label>
                    <div className="relative">
                      <input
                        type={showProvKey ? 'text' : 'password'}
                        value={provApiKey}
                        onChange={(e) => setProvApiKey(e.target.value)}
                        placeholder={activeProv.is_configured ? 'Digite uma nova chave para atualizar...' : 'Insira a sua chave de API aqui...'}
                        className="w-full pl-3 pr-8 py-2 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-600 font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => setShowProvKey(!showProvKey)}
                        className="absolute right-2 top-2.5 text-slate-400 hover:text-slate-200 cursor-pointer"
                      >
                        {showProvKey ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </div>

                  {/* API Base URL */}
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-slate-400">URL Base da API (Endpoint)</label>
                    <input
                      type="text"
                      value={provBaseUrl}
                      onChange={(e) => setProvBaseUrl(e.target.value)}
                      className="w-full px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-cyan-600 font-mono"
                    />
                  </div>

                  {/* Model ID */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <label className="text-[11px] font-medium text-slate-400">Identificador do Modelo (Model ID)</label>
                      {/* Presets based on provider */}
                      {activeProv.provider_key === 'gemini' && (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setProvModelId('gemini-2.5-flash')}
                            className="text-[10px] text-cyan-400 hover:underline cursor-pointer"
                          >
                            2.5-flash
                          </button>
                          <span className="text-slate-600">|</span>
                          <button
                            type="button"
                            onClick={() => setProvModelId('gemini-2.5-pro')}
                            className="text-[10px] text-cyan-400 hover:underline cursor-pointer"
                          >
                            2.5-pro
                          </button>
                        </div>
                      )}
                      {activeProv.provider_key === 'openai' && (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setProvModelId('gpt-4o')}
                            className="text-[10px] text-cyan-400 hover:underline cursor-pointer"
                          >
                            gpt-4o
                          </button>
                          <span className="text-slate-600">|</span>
                          <button
                            type="button"
                            onClick={() => setProvModelId('o3-mini')}
                            className="text-[10px] text-cyan-400 hover:underline cursor-pointer"
                          >
                            o3-mini
                          </button>
                        </div>
                      )}
                      {activeProv.provider_key === 'useoneai' && (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setProvModelId('chatgpt-5.5')}
                            className="text-[10px] text-cyan-400 hover:underline cursor-pointer"
                          >
                            chatgpt-5.5
                          </button>
                          <span className="text-slate-600">|</span>
                          <button
                            type="button"
                            onClick={() => setProvModelId('claude-3.7-sonnet')}
                            className="text-[10px] text-cyan-400 hover:underline cursor-pointer"
                          >
                            claude-3.7
                          </button>
                        </div>
                      )}
                    </div>
                    <input
                      type="text"
                      value={provModelId}
                      onChange={(e) => setProvModelId(e.target.value)}
                      className="w-full px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-cyan-600 font-mono"
                    />
                  </div>

                  {provTestResult && (
                    <div
                      className={`p-2.5 rounded-lg text-xs flex items-center gap-2 ${
                        provTestResult.success
                          ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-800/50'
                          : 'bg-rose-950/60 text-rose-300 border border-rose-800/50'
                      }`}
                    >
                      {provTestResult.success ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                      <span>{provTestResult.message}</span>
                    </div>
                  )}

                  <div className="flex items-center justify-between pt-2">
                    <button
                      type="button"
                      onClick={handleTestProvider}
                      disabled={isTestingProv}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
                    >
                      {isTestingProv ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                      Testar Conexão
                    </button>

                    <div className="flex items-center gap-2">
                      {provSaveNotice && (
                        <span className="text-xs text-emerald-400 font-medium flex items-center gap-1">
                          <CheckCircle2 size={13} /> Salvo com Sucesso!
                        </span>
                      )}
                      <button
                        type="submit"
                        className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-bold text-xs flex items-center gap-1.5 transition cursor-pointer"
                      >
                        <Save size={13} />
                        Salvar Modelo e Chave
                      </button>
                    </div>
                  </div>
                </form>
              )}
            </div>
          )}

          {/* TAB: INTEGRATIONS (CLOUDFLARE, SUPABASE, GITHUB, FIREBASE) */}
          {activeTab === 'integrations' && (
            <div className="space-y-4">
              {/* Cloudflare Card */}
              <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 border border-amber-600/40 flex items-center justify-center font-bold">
                      <Layers size={16} />
                    </div>
                    <div>
                      <div className="text-xs font-bold text-slate-200">Cloudflare Edge & Workers</div>
                      <div className="text-[11px] text-slate-400">Deploy na borda global, DNS e proteção de CDN</div>
                    </div>
                  </div>

                  {secrets.some((s) => s.service_key === 'cloudflare') ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-800/60 font-mono flex items-center gap-1">
                      <CheckCircle2 size={11} /> Token Configurado
                    </span>
                  ) : (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 font-mono">
                      Não configurado
                    </span>
                  )}
                </div>

                <div className="text-xs text-slate-300 space-y-2">
                  <p>
                    Integração para deploy de Workers e Pages com roteamento instantâneo. Configure o token de API na aba <strong>Credenciais & Chaves</strong> para habilitar publicação distribuída.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleTestSecret('cloudflare')}
                      disabled={testingKey === 'cloudflare'}
                      className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] flex items-center gap-1 transition cursor-pointer"
                    >
                      {testingKey === 'cloudflare' ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                      Testar Token Cloudflare
                    </button>
                    {testResults['cloudflare'] && (
                      <span className={`text-[11px] font-mono ${testResults['cloudflare'].success ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {testResults['cloudflare'].message}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Supabase Card */}
              <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 border border-emerald-600/40 flex items-center justify-center font-bold">
                      <Database size={16} />
                    </div>
                    <div>
                      <div className="text-xs font-bold text-slate-200">Supabase (PostgreSQL & Storage)</div>
                      <div className="text-[11px] text-slate-400">Banco de dados relacional e backend autogerenciado</div>
                    </div>
                  </div>

                  {secrets.some((s) => s.service_key === 'supabase') ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-800/60 font-mono flex items-center gap-1">
                      <CheckCircle2 size={11} /> Conectado
                    </span>
                  ) : (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 font-mono">
                      Não configurado
                    </span>
                  )}
                </div>

                <div className="text-xs text-slate-300 space-y-2">
                  <p>
                    Conecte instâncias Supabase para queries SQL, autenticação de usuários e subscriptions em tempo real. Configure a Service Key na aba <strong>Credenciais & Chaves</strong>.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleTestSecret('supabase')}
                      disabled={testingKey === 'supabase'}
                      className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] flex items-center gap-1 transition cursor-pointer"
                    >
                      {testingKey === 'supabase' ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                      Testar Chave Supabase
                    </button>
                    {testResults['supabase'] && (
                      <span className={`text-[11px] font-mono ${testResults['supabase'].success ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {testResults['supabase'].message}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* GitHub Card */}
              <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center text-slate-100 font-bold">
                      <GitBranch size={16} />
                    </div>
                    <div>
                      <div className="text-xs font-bold text-slate-200">GitHub Version Control</div>
                      <div className="text-[11px] text-slate-400">Sincronização remota de código, branches e Pull Requests</div>
                    </div>
                  </div>

                  {githubStatus?.isConnected ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-800/60 font-mono">
                      Conectado ({githubStatus.username || 'Autenticado'})
                    </span>
                  ) : (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-950 text-amber-300 border border-amber-800/60 font-mono">
                      Pendente de Chave
                    </span>
                  )}
                </div>

                <div className="text-xs text-slate-300">
                  {githubStatus?.isConnected ? (
                    <div className="space-y-1">
                      <p>Conta autenticada com sucesso no GitHub. Você pode criar branches, sincronizar arquivos (Pull/Push) e abrir Pull Requests diretamente pelo painel de Deploy.</p>
                      <p className="text-slate-400 text-[11px]">Repositório ativo: <code className="text-cyan-300 font-mono">{activeProject?.repo_url || 'Nenhum repo configurado'}</code></p>
                    </div>
                  ) : (
                    <p>Adicione um Personal Access Token (PAT) na aba <strong>Credenciais & Chaves</strong> para habilitar commits, push e branches automáticos.</p>
                  )}
                </div>
              </div>

              {/* Firebase Card */}
              <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-amber-950/50 text-amber-400 border border-amber-800/60 flex items-center justify-center font-bold">
                      <Flame size={16} />
                    </div>
                    <div>
                      <div className="text-xs font-bold text-slate-200">Firebase & Google Cloud</div>
                      <div className="text-[11px] text-slate-400">Banco Firestore e autenticação em nuvem</div>
                    </div>
                  </div>

                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-800/60 font-mono">
                    Conectado ao Projeto
                  </span>
                </div>

                <div className="text-xs text-slate-300 space-y-2">
                  <p>
                    O Forge Agent suporta conexão de banco de dados Firestore para projetos multiusuário e persistência duradoura. Para provisionar via Google Cloud, configure o Project ID e API Key no cofre de credenciais.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleTestSecret('firebase')}
                      disabled={testingKey === 'firebase'}
                      className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] flex items-center gap-1 transition cursor-pointer"
                    >
                      {testingKey === 'firebase' ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                      Testar Conexão Firebase
                    </button>
                    {testResults['firebase'] && (
                      <span className={`text-[11px] font-mono ${testResults['firebase'].success ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {testResults['firebase'].message}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB: SECURITY & AUDITING */}
          {activeTab === 'security' && (
            <div className="space-y-3">
              <div className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800 space-y-1.5">
                <div className="text-xs font-semibold text-slate-200 flex items-center gap-2">
                  <ShieldCheck size={15} className="text-emerald-400" />
                  Path Traversal Guard
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-emerald-950 text-emerald-300 border border-emerald-800/60">
                    Ativo
                  </span>
                </div>
                <p className="text-xs text-slate-400">
                  Todas as leituras e gravações do agente são canonicamente isoladas na pasta do workspace do projeto. Tentativas de travessia (ex: <code className="text-slate-300 font-mono">../</code>, caminhos absolutos ou bytes nulos) são bloqueadas com exceção imediata.
                </p>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800 space-y-1.5">
                <div className="text-xs font-semibold text-slate-200 flex items-center gap-2">
                  <Lock size={15} className="text-cyan-400" />
                  Quality Gate de Vazamento de Chaves
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-300 border border-cyan-800/60">
                    Verificado
                  </span>
                </div>
                <p className="text-xs text-slate-400">
                  Antes de cada deploy ou commit, o código é submetido à auditoria regex para impedir inclusão acidental de chaves privadas (ex: <code className="text-slate-300 font-mono">BEGIN PRIVATE KEY</code>, tokens de acesso ou secrets).
                </p>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800 space-y-1.5">
                <div className="text-xs font-semibold text-slate-200 flex items-center gap-2">
                  <Database size={15} className="text-blue-400" />
                  Isolamento Multiusuário no Banco de Dados
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-blue-950 text-blue-300 border border-blue-800/60">
                    SQLite WAL
                  </span>
                </div>
                <p className="text-xs text-slate-400">
                  Cada usuário autenticado possui escopo estrito de banco de dados (`WHERE user_id = ?`). Nenhuma requisição consegue consultar ou alterar dados de outros usuários.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3.5 border-t border-slate-800 bg-slate-950/70 flex justify-between items-center shrink-0">
          <span className="text-[11px] text-slate-400 font-mono">
            {currentUser ? `Autenticado: ${currentUser.email}` : 'Modo Visitante'}
          </span>
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
