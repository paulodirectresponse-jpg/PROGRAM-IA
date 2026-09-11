import React, { useState } from 'react';
import { X, Cpu, CheckCircle2, AlertCircle, Shield, Save, Play, Loader2, RefreshCw } from 'lucide-react';
import { Provider } from '../types';

interface ProvidersModalProps {
  isOpen: boolean;
  onClose: () => void;
  providers: Provider[];
  onUpdateProvider: (providerKey: string, baseUrl: string, modelId: string) => void;
}

interface TestResult {
  success: boolean;
  status: 'success' | 'invalid_key' | 'invalid_model' | 'invalid_url' | 'network_error' | 'incompatible_response';
  message: string;
}

export const ProvidersModal: React.FC<ProvidersModalProps> = ({
  isOpen,
  onClose,
  providers,
  onUpdateProvider,
}) => {
  const [selectedKey, setSelectedKey] = useState<string>('useoneai');
  const activeProv = providers.find((p) => p.provider_key === selectedKey) || providers[0];

  const [baseUrl, setBaseUrl] = useState(activeProv?.base_url || '');
  const [modelId, setModelId] = useState(activeProv?.model_id || '');
  const [savedNotice, setSavedNotice] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  if (!isOpen) return null;

  const handleSelectProvider = (key: string) => {
    setSelectedKey(key);
    setTestResult(null);
    const p = providers.find((item) => item.provider_key === key);
    if (p) {
      setBaseUrl(p.base_url);
      setModelId(p.model_id);
    }
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProv) return;
    onUpdateProvider(activeProv.provider_key, baseUrl, modelId);
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2000);
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);

    try {
      const res = await fetch('/api/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerKey: activeProv?.provider_key || selectedKey,
          baseUrl,
          modelId,
        }),
      });

      const data = await res.json();
      setTestResult(data);
    } catch (err: any) {
      setTestResult({
        success: false,
        status: 'network_error',
        message: `Erro na requisição local: ${err.message}`,
      });
    } finally {
      setIsTesting(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'success':
        return {
          title: 'Conexão Aprovada',
          bg: 'bg-emerald-950/70 border-emerald-800 text-emerald-300',
          icon: CheckCircle2,
        };
      case 'invalid_key':
        return {
          title: 'Chave Inválida ou Ausente',
          bg: 'bg-rose-950/70 border-rose-800 text-rose-300',
          icon: AlertCircle,
        };
      case 'invalid_model':
        return {
          title: 'Modelo Inválido ou Indisponível',
          bg: 'bg-amber-950/70 border-amber-800 text-amber-300',
          icon: AlertCircle,
        };
      case 'invalid_url':
        return {
          title: 'URL Inválida ou Malformada',
          bg: 'bg-amber-950/70 border-amber-800 text-amber-300',
          icon: AlertCircle,
        };
      case 'network_error':
        return {
          title: 'Erro de Rede ou Timeout',
          bg: 'bg-rose-950/70 border-rose-800 text-rose-300',
          icon: AlertCircle,
        };
      default:
        return {
          title: 'Resposta Incompatível',
          bg: 'bg-slate-900 border-slate-700 text-slate-300',
          icon: AlertCircle,
        };
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl animate-fade-in">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-indigo-600/20 text-indigo-400 flex items-center justify-center font-bold text-sm">
              <Cpu size={16} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">Provedores de LLM & Modelos</h2>
              <p className="text-[11px] text-slate-400">Configuração de adaptadores OpenAI-compatible e Gemini</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Security Notice */}
          <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-300 flex items-start gap-2.5">
            <Shield size={16} className="shrink-0 text-cyan-400 mt-0.5" />
            <div>
              <strong className="text-slate-100">Segurança de Chaves e Secrets:</strong>
              <div className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                As chaves de API nunca são expostas ao frontend. Elas residem exclusivamente no servidor através das variáveis de ambiente (<code className="text-cyan-400">OPENAI_API_KEY</code>, <code className="text-cyan-400">GEMINI_API_KEY</code>).
              </div>
            </div>
          </div>

          {/* Provider Selector Tabs */}
          <div className="flex gap-2 border-b border-slate-800 pb-2">
            {providers.map((p) => (
              <button
                key={p.provider_key}
                type="button"
                id={`tab-provider-${p.provider_key}`}
                onClick={() => handleSelectProvider(p.provider_key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer flex items-center gap-1.5 ${
                  selectedKey === p.provider_key
                    ? 'bg-slate-800 text-cyan-300 border border-slate-700'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-950'
                }`}
              >
                <span>{p.name}</span>
                {p.is_configured ? (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                ) : (
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                )}
              </button>
            ))}
          </div>

          {/* Provider Edit Form */}
          {activeProv && (
            <form onSubmit={handleSave} className="space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">Status da Chave no Servidor</label>
                <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    {activeProv.is_configured ? (
                      <CheckCircle2 size={14} className="text-emerald-400" />
                    ) : (
                      <AlertCircle size={14} className="text-amber-400" />
                    )}
                    <span className="text-slate-200">
                      {activeProv.is_configured
                        ? 'Chave presente nas variáveis de ambiente do servidor'
                        : 'Nenhuma chave encontrada nas variáveis de ambiente'}
                    </span>
                  </div>
                  <span className="text-[10px] font-mono uppercase text-slate-400">
                    {activeProv.connection_status}
                  </span>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">Base URL do Endpoint</label>
                <input
                  id="input-provider-base-url"
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                />
                <div className="text-[10px] text-slate-400">Ex: https://api.useoneai.app/v1 ou https://api.openai.com/v1</div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">ID Exato do Modelo (Model ID)</label>
                <input
                  id="input-provider-model-id"
                  type="text"
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                />
                <div className="text-[10px] text-slate-400">Ex: chatgpt-5.5, gpt-4o ou gemini-2.5-flash</div>
              </div>

              {/* Test Connection Output */}
              {testResult && (
                <div
                  className={`p-3 rounded-xl border flex items-start gap-2.5 text-xs animate-fade-in ${
                    getStatusBadge(testResult.status).bg
                  }`}
                >
                  {React.createElement(getStatusBadge(testResult.status).icon, {
                    size: 15,
                    className: 'shrink-0 mt-0.5',
                  })}
                  <div>
                    <div className="font-bold">{getStatusBadge(testResult.status).title}</div>
                    <div className="text-[11px] mt-0.5 opacity-90">{testResult.message}</div>
                  </div>
                </div>
              )}

              <div className="pt-3 flex items-center justify-between border-t border-slate-800">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    id="btn-test-provider-connection"
                    onClick={handleTestConnection}
                    disabled={isTesting}
                    className="px-3 py-1.5 rounded-lg border border-cyan-800/80 bg-cyan-950/50 hover:bg-cyan-900/60 text-cyan-300 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
                  >
                    {isTesting ? (
                      <>
                        <Loader2 size={13} className="animate-spin text-cyan-400" />
                        <span>Testando Endpoint...</span>
                      </>
                    ) : (
                      <>
                        <Play size={12} className="text-cyan-400 fill-cyan-400" />
                        <span>Testar Conexão</span>
                      </>
                    )}
                  </button>

                  {savedNotice && (
                    <span className="text-xs text-emerald-400 flex items-center gap-1 font-medium animate-fade-in">
                      <CheckCircle2 size={13} /> Salvo!
                    </span>
                  )}
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200 transition cursor-pointer"
                  >
                    Fechar
                  </button>
                  <button
                    type="submit"
                    id="btn-save-provider-config"
                    className="px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-slate-950 text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
                  >
                    <Save size={13} />
                    Salvar Alterações
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
