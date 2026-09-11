import React, { useState } from 'react';
import { X, Cpu, CheckCircle2, AlertCircle, Shield, Info, Save } from 'lucide-react';
import { Provider } from '../types';

interface ProvidersModalProps {
  isOpen: boolean;
  onClose: () => void;
  providers: Provider[];
  onUpdateProvider: (providerKey: string, baseUrl: string, modelId: string) => void;
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

  if (!isOpen) return null;

  const handleSelectProvider = (key: string) => {
    setSelectedKey(key);
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
              <div className="text-[11px] text-slate-400 mt-0.5">
                Conforme a especificação oficial, as chaves de API nunca são expostas ao frontend. Elas são injetadas exclusivamente no servidor via variáveis de ambiente (<code className="text-cyan-400">OPENAI_API_KEY</code>, <code className="text-cyan-400">GEMINI_API_KEY</code>).
              </div>
            </div>
          </div>

          {/* Provider Selector Tabs */}
          <div className="flex gap-2 border-b border-slate-800 pb-2">
            {providers.map((p) => (
              <button
                key={p.provider_key}
                type="button"
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
                <label className="text-xs font-semibold text-slate-300">Status da Conexão</label>
                <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    {activeProv.is_configured ? (
                      <CheckCircle2 size={14} className="text-emerald-400" />
                    ) : (
                      <AlertCircle size={14} className="text-amber-400" />
                    )}
                    <span className="text-slate-200">
                      {activeProv.is_configured
                        ? 'Chave configurada e ativa no servidor'
                        : 'Nenhuma chave detectada (Fallback ativo)'}
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
                  type="text"
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                />
                <div className="text-[10px] text-slate-400">Ex: chatgpt-5.5, gpt-4o ou gemini-2.5-flash</div>
              </div>

              <div className="pt-3 flex items-center justify-between border-t border-slate-800">
                {savedNotice ? (
                  <span className="text-xs text-emerald-400 flex items-center gap-1 font-medium">
                    <CheckCircle2 size={13} /> Salvo com sucesso!
                  </span>
                ) : (
                  <span />
                )}

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
