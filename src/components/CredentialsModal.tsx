import React, { useState, useEffect } from 'react';
import {
  X,
  Key,
  Shield,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Trash2,
  Eye,
  EyeOff,
  GitBranch,
  Cpu,
  Lock,
  ExternalLink,
} from 'lucide-react';
import { SecretSummary, ConnectionTestResult } from '../types';

interface CredentialsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCredentialsUpdated?: () => void;
}

interface ServiceDef {
  key: string;
  name: string;
  category: 'llm' | 'git';
  desc: string;
  placeholder: string;
  defaultModel?: string;
  defaultUrl?: string;
  docsUrl: string;
}

const SUPPORTED_SERVICES: ServiceDef[] = [
  {
    key: 'useoneai',
    name: 'UseOneAI (OpenAI-Compatible)',
    category: 'llm',
    desc: 'Gateway de múltiplos modelos (ChatGPT 5.5, Claude, Llama). Endpoint com compatibilidade OpenAI.',
    placeholder: 'sk-...',
    defaultModel: 'chatgpt-5.5',
    defaultUrl: 'https://api.useoneai.app/v1',
    docsUrl: 'https://useoneai.app',
  },
  {
    key: 'gemini',
    name: 'Google Gemini',
    category: 'llm',
    desc: 'API nativa do Google Gemini 3.5 Flash Lite para geração ultra-rápida de código.',
    placeholder: 'AIzaSy...',
    defaultModel: 'gemini-3.5-flash-lite',
    defaultUrl: 'https://generativelanguage.googleapis.com',
    docsUrl: 'https://aistudio.google.com',
  },
  {
    key: 'github',
    name: 'GitHub Personal Access Token (PAT)',
    category: 'git',
    desc: 'Token de acesso para importar repositórios, sincronizar branches, criar commits e Pull Requests.',
    placeholder: 'ghp_...',
    docsUrl: 'https://github.com/settings/tokens',
  },
  {
    key: 'openai',
    name: 'OpenAI Oficial',
    category: 'llm',
    desc: 'Chave oficial da OpenAI para modelos GPT-4o e o1.',
    placeholder: 'sk-proj-...',
    defaultModel: 'gpt-4o',
    defaultUrl: 'https://api.openai.com/v1',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
];

export const CredentialsModal: React.FC<CredentialsModalProps> = ({
  isOpen,
  onClose,
  onCredentialsUpdated,
}) => {
  const [secrets, setSecrets] = useState<SecretSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'llm' | 'git'>('llm');

  // Input states per service
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [showPlain, setShowPlain] = useState<Record<string, boolean>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ConnectionTestResult>>({});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadSecrets();
    }
  }, [isOpen]);

  const loadSecrets = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/secrets');
      if (!res.ok) throw new Error('Não foi possível carregar as credenciais.');
      const data = await res.json();
      setSecrets(data.secrets || []);
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveSecret = async (serviceKey: string) => {
    const raw = inputValues[serviceKey];
    if (!raw || raw.trim().length === 0) {
      setErrorMsg('Informe o valor da chave antes de salvar.');
      return;
    }

    setSavingKey(serviceKey);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await fetch('/api/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerKey: serviceKey,
          secretValue: raw.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao salvar credencial.');

      // Clear input
      setInputValues((prev) => ({ ...prev, [serviceKey]: '' }));
      setSuccessMsg(`Credencial de ${serviceKey} salva e criptografada com sucesso!`);
      await loadSecrets();
      if (onCredentialsUpdated) onCredentialsUpdated();
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setSavingKey(null);
    }
  };

  const handleTestSecret = async (serviceKey: string) => {
    setTestingKey(serviceKey);
    setErrorMsg(null);

    try {
      const rawInput = inputValues[serviceKey]?.trim() || undefined;
      const res = await fetch('/api/secrets/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerKey: serviceKey,
          secretValue: rawInput,
        }),
      });

      const result: ConnectionTestResult = await res.json();
      setTestResults((prev) => ({ ...prev, [serviceKey]: result }));
    } catch (err: any) {
      setTestResults((prev) => ({
        ...prev,
        [serviceKey]: {
          success: false,
          code: 'network_error',
          message: `Falha na requisição de teste: ${err.message}`,
        },
      }));
    } finally {
      setTestingKey(null);
    }
  };

  const handleDeleteSecret = async (serviceKey: string) => {
    if (!confirm(`Deseja realmente remover a credencial de ${serviceKey}?`)) return;

    try {
      const res = await fetch(`/api/secrets/${serviceKey}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Falha ao remover credencial.');
      setTestResults((prev) => {
        const copy = { ...prev };
        delete copy[serviceKey];
        return copy;
      });
      await loadSecrets();
      if (onCredentialsUpdated) onCredentialsUpdated();
    } catch (err: any) {
      setErrorMsg(err.message);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl animate-fade-in flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-cyan-600/20 text-cyan-400 border border-cyan-800/50 flex items-center justify-center font-bold text-sm">
              <Key size={18} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">Integrações e Credenciais</h2>
              <p className="text-[11px] text-slate-400">
                Chaves de API criptografadas individualmente (AES-256-GCM) por usuário
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

        {/* Security Notice Banner */}
        <div className="px-5 py-2.5 bg-slate-950 border-b border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <Shield size={14} className="text-emerald-400 shrink-0" />
            <span>Chaves armazenadas de forma criptografada. Nunca exibidas em plain text ou logs.</span>
          </div>
          <span className="text-[10px] font-mono text-emerald-500 bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/40">
            AES-256-GCM
          </span>
        </div>

        {/* Tab switch */}
        <div className="p-3 border-b border-slate-800 flex gap-2">
          <button
            onClick={() => setActiveTab('llm')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition cursor-pointer ${
              activeTab === 'llm'
                ? 'bg-cyan-950 text-cyan-300 border border-cyan-800'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Cpu size={14} />
            Modelos de IA & LLMs
          </button>
          <button
            onClick={() => setActiveTab('git')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition cursor-pointer ${
              activeTab === 'git'
                ? 'bg-purple-950 text-purple-300 border border-purple-800'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <GitBranch size={14} />
            GitHub & Controle de Versão
          </button>
        </div>

        {/* Feedback alerts */}
        {errorMsg && (
          <div className="mx-4 mt-3 p-3 rounded-xl bg-red-950/40 border border-red-800/60 text-red-300 text-xs flex items-start gap-2">
            <AlertCircle size={15} className="shrink-0 mt-0.5" />
            <span>{errorMsg}</span>
          </div>
        )}

        {successMsg && (
          <div className="mx-4 mt-3 p-3 rounded-xl bg-emerald-950/40 border border-emerald-800/60 text-emerald-300 text-xs flex items-start gap-2">
            <CheckCircle2 size={15} className="shrink-0 mt-0.5" />
            <span>{successMsg}</span>
          </div>
        )}

        {/* Services List */}
        <div className="p-4 space-y-4 overflow-y-auto flex-1 custom-scrollbar">
          {SUPPORTED_SERVICES.filter((s) => s.category === activeTab).map((service) => {
            const savedSecret = secrets.find((s) => s.service_key === service.key);
            const isConfigured = Boolean(savedSecret);
            const testResult = testResults[service.key];

            return (
              <div
                key={service.key}
                className={`p-4 rounded-xl border space-y-3 transition ${
                  isConfigured
                    ? 'bg-slate-950/90 border-slate-800'
                    : 'bg-slate-950/40 border-slate-800/60'
                }`}
              >
                {/* Header of Item */}
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-100 text-xs">{service.name}</span>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase ${
                          isConfigured
                            ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-800/60'
                            : 'bg-amber-950/60 text-amber-300 border border-amber-800/40'
                        }`}
                      >
                        {isConfigured ? 'Chave Configurada' : 'Não Configurada'}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1 max-w-lg">{service.desc}</p>
                  </div>
                  <a
                    href={service.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1 shrink-0"
                  >
                    Obter Chave <ExternalLink size={11} />
                  </a>
                </div>

                {/* Masked display if configured */}
                {isConfigured && savedSecret && (
                  <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800/80 flex items-center justify-between text-xs font-mono">
                    <div className="flex items-center gap-2 text-slate-300">
                      <Lock size={12} className="text-emerald-400" />
                      <span>{savedSecret.masked_hint}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleDeleteSecret(service.key)}
                        className="p-1 text-slate-500 hover:text-red-400 transition cursor-pointer"
                        title="Remover chave salva"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                )}

                {/* Input area */}
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <input
                        type={showPlain[service.key] ? 'text' : 'password'}
                        value={inputValues[service.key] || ''}
                        onChange={(e) =>
                          setInputValues((prev) => ({ ...prev, [service.key]: e.target.value }))
                        }
                        placeholder={
                          isConfigured ? 'Substituir chave existente...' : service.placeholder
                        }
                        className="w-full px-3 py-1.5 pr-8 rounded-lg bg-slate-900 border border-slate-800 text-slate-100 text-xs font-mono placeholder:text-slate-600 focus:outline-hidden focus:border-cyan-500"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setShowPlain((prev) => ({ ...prev, [service.key]: !prev[service.key] }))
                        }
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                      >
                        {showPlain[service.key] ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                    </div>

                    <button
                      onClick={() => handleSaveSecret(service.key)}
                      disabled={savingKey === service.key || !inputValues[service.key]}
                      className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white text-xs font-semibold transition cursor-pointer shrink-0"
                    >
                      {savingKey === service.key ? 'Salvando...' : 'Salvar Chave'}
                    </button>

                    <button
                      onClick={() => handleTestSecret(service.key)}
                      disabled={testingKey === service.key || (!isConfigured && !inputValues[service.key])}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer shrink-0"
                    >
                      <RefreshCw size={12} className={testingKey === service.key ? 'animate-spin' : ''} />
                      {testingKey === service.key ? 'Testando...' : 'Testar Conexão'}
                    </button>
                  </div>

                  {/* Diagnostic Test Result */}
                  {testResult && (
                    <div
                      className={`p-2.5 rounded-lg text-xs flex items-start gap-2 border ${
                        testResult.success
                          ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                          : 'bg-red-950/40 border-red-800/60 text-red-300'
                      }`}
                    >
                      {testResult.success ? (
                        <CheckCircle2 size={14} className="shrink-0 mt-0.5 text-emerald-400" />
                      ) : (
                        <AlertCircle size={14} className="shrink-0 mt-0.5 text-red-400" />
                      )}
                      <div>
                        <p className="font-semibold">
                          {testResult.success ? 'Conexão Aprovada!' : 'Falha na Validação'}
                        </p>
                        <p className="text-[11px] mt-0.5 opacity-90">{testResult.message}</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-slate-800 flex items-center justify-between shrink-0">
          <span className="text-[11px] text-slate-500">
            Forge Agent v2.4 • Camada Criptográfica Ativa
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition cursor-pointer"
          >
            Concluir
          </button>
        </div>
      </div>
    </div>
  );
};
