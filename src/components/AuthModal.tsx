import React, { useState } from 'react';
import { X, Lock, Mail, User, ShieldCheck, LogOut, ArrowRight, CheckCircle2, AlertCircle, Flame } from 'lucide-react';
import { AuthUser } from '../types';
import {
  loginWithFirebaseEmail,
  registerWithFirebaseEmail,
  loginWithFirebaseGoogle,
  logoutFirebase
} from '../lib/firebase';

const friendlyAuthError = (err: unknown) => {
  const raw = err instanceof Error ? err.message : String(err || '');
  const host = window.location.hostname;
  if (raw.includes('auth/unauthorized-domain')) {
    return `O domínio ${host} precisa ser adicionado no Firebase Console em Authentication > Settings > Authorized domains. Enquanto isso, use e-mail e senha.`;
  }
  if (raw.includes('auth/invalid-credential')) return 'E-mail ou senha inválidos.';
  if (raw.includes('auth/email-already-in-use')) return 'Este e-mail já possui uma conta. Use a opção Entrar.';
  if (raw.includes('auth/weak-password')) return 'A senha precisa ter pelo menos 8 caracteres.';
  if (raw.includes('auth/operation-not-allowed')) return 'Este método de login ainda não foi habilitado no Firebase Console.';
  if (raw.includes('auth/popup-closed-by-user')) return 'A janela de login foi fechada antes da conclusão.';
  return raw || 'Falha na comunicação com o serviço de autenticação.';
};

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: AuthUser | null;
  onLoginSuccess: (user: AuthUser) => void;
  onLogout: () => void;
  isMandatory?: boolean;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  onLoginSuccess,
  onLogout,
  isMandatory = false,
}) => {
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setIsLoading(true);

    try {
      const fbUser = tab === 'login'
        ? await loginWithFirebaseEmail(email, password)
        : await registerWithFirebaseEmail(email, password);
      const res = await fetch('/api/auth/firebase-login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: await fbUser.getIdToken() }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Erro ao processar autenticação.');
      }

      setSuccessMsg(tab === 'login' ? 'Login autenticado com sucesso!' : 'Conta criada e autenticada!');
      onLoginSuccess(data.user);
      setTimeout(() => {
        onClose();
        setError(null);
        setSuccessMsg(null);
      }, 600);
    } catch (err: any) {
      setError(friendlyAuthError(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setError(null);
    setSuccessMsg(null);
    setIsLoading(true);

    try {
      const fbUser = await loginWithFirebaseGoogle();
      const res = await fetch('/api/auth/firebase-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken: await fbUser.getIdToken(),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao conectar via Google.');

      setSuccessMsg('Autenticado com sucesso via Google & Firebase!');
      onLoginSuccess(data.user);
      setTimeout(() => {
        onClose();
        setError(null);
        setSuccessMsg(null);
      }, 600);
    } catch (err: any) {
      setError(friendlyAuthError(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogoutClick = async () => {
    setIsLoading(true);
    try {
      await logoutFirebase().catch(() => {});
      await fetch('/api/auth/logout', { method: 'POST' });
      onLogout();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-fade-in flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-cyan-600/20 text-cyan-400 border border-cyan-800/50 flex items-center justify-center font-bold text-sm">
              <ShieldCheck size={18} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100 flex items-center gap-1.5">
                {currentUser ? 'Perfil do Desenvolvedor' : tab === 'login' ? 'Entrar no Forge Agent' : 'Criar Conta Individual'}
                <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-[10px] text-amber-400 font-normal">
                  <Flame size={10} className="text-amber-400" /> Firebase Auth
                </span>
              </h2>
              <p className="text-[11px] text-slate-400">
                {currentUser ? 'Sessão ativa e isolada' : 'Login obrigatório para acesso aos projetos, histórico e modelos'}
              </p>
            </div>
          </div>
          {(!isMandatory || currentUser) && (
            <button
              onClick={onClose}
              className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition cursor-pointer"
            >
              <X size={16} />
            </button>
          )}
        </div>

        {/* Mandatory notice */}
        {isMandatory && !currentUser && (
          <div className="bg-cyan-950/40 border-b border-cyan-900/40 px-4 py-2.5 flex items-center gap-2 text-xs text-cyan-300">
            <ShieldCheck size={14} className="shrink-0 text-cyan-400" />
            <span>O login é <strong>obrigatório</strong> para inicializar o ambiente seguro.</span>
          </div>
        )}

        {/* Profile Mode (if already logged in) */}
        {currentUser ? (
          <div className="p-6 space-y-5">
            <div className="flex items-center gap-3 p-3.5 rounded-xl bg-slate-950 border border-slate-800">
              <div className="w-12 h-12 rounded-full bg-cyan-950/80 border border-cyan-700 text-cyan-300 flex items-center justify-center font-bold text-base">
                {currentUser.name.slice(0, 2).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-slate-200 text-sm truncate">{currentUser.name}</h3>
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-mono uppercase bg-cyan-950 text-cyan-300 border border-cyan-800">
                    {currentUser.role}
                  </span>
                </div>
                <p className="text-xs text-slate-400 truncate">{currentUser.email}</p>
                <p className="text-[10px] text-slate-500 font-mono mt-0.5">ID: {currentUser.id}</p>
              </div>
            </div>

            <div className="space-y-2 text-xs text-slate-300">
              <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/80 space-y-1.5">
                <div className="flex items-center justify-between text-slate-400">
                  <span>Isolamento Multi-Tenant</span>
                  <span className="text-emerald-400 font-medium">Ativo (AES-256-GCM)</span>
                </div>
                <div className="flex items-center justify-between text-slate-400">
                  <span>Firebase Authentication</span>
                  <span className="text-amber-400 font-medium">Sincronizado</span>
                </div>
                <div className="flex items-center justify-between text-slate-400">
                  <span>Acesso a Projetos</span>
                  <span className="text-cyan-400 font-medium">Restrito ao Proprietário</span>
                </div>
              </div>
            </div>

            <div className="pt-2 flex justify-end gap-2 border-t border-slate-800">
              <button
                onClick={handleLogoutClick}
                disabled={isLoading}
                className="w-full py-2 px-3 rounded-xl bg-red-950/40 hover:bg-red-900/50 text-red-300 border border-red-800/50 text-xs font-semibold flex items-center justify-center gap-2 transition cursor-pointer"
              >
                <LogOut size={14} />
                Encerrar Sessão
              </button>
            </div>
          </div>
        ) : (
          /* Login / Register Mode */
          <div className="p-6 space-y-4">
            {/* Quick Google Sign In */}
            <button
              type="button"
              onClick={handleGoogleLogin}
              disabled={isLoading}
              className="w-full py-2.5 px-4 rounded-xl bg-slate-950 hover:bg-slate-800/80 border border-slate-700/80 text-slate-100 text-xs font-medium flex items-center justify-center gap-2.5 transition cursor-pointer disabled:opacity-50"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path fill="#EA4335" d="M12 5c1.6 0 3 .6 4.1 1.7l3.1-3.1C17.3 1.8 14.8 1 12 1 7.5 1 3.7 3.6 1.9 7.4l3.7 2.9C6.5 7.4 9 5 12 5z" />
                <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.6h6.5c-.3 1.5-1.1 2.8-2.4 3.7l3.7 2.9c2.2-2 3.7-5 3.7-8.9z" />
                <path fill="#FBBC05" d="M5.6 14.7c-.2-.7-.4-1.5-.4-2.7s.2-2 .4-2.7L1.9 6.4C.7 8.8 0 10.3 0 12s.7 3.2 1.9 5.6l3.7-2.9z" />
                <path fill="#34A853" d="M12 23c3.2 0 6-1.1 8-3l-3.7-2.9c-1.1.7-2.5 1.2-4.3 1.2-3 0-5.5-2.4-6.4-5.3L1.9 16c1.8 3.8 5.6 7 10.1 7z" />
              </svg>
              <span>Continuar com o Google (Firebase)</span>
            </button>

            <div className="flex items-center gap-3">
              <div className="h-px bg-slate-800 flex-1" />
              <span className="text-[11px] text-slate-500 uppercase tracking-wider font-mono">ou e-mail</span>
              <div className="h-px bg-slate-800 flex-1" />
            </div>

            {/* Tab switch */}
            <div className="flex p-1 rounded-xl bg-slate-950 border border-slate-800 text-xs">
              <button
                type="button"
                onClick={() => { setTab('login'); setError(null); }}
                className={`flex-1 py-1.5 rounded-lg font-medium transition cursor-pointer ${
                  tab === 'login' ? 'bg-slate-800 text-slate-100 shadow-xs' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Entrar
              </button>
              <button
                type="button"
                onClick={() => { setTab('register'); setError(null); }}
                className={`flex-1 py-1.5 rounded-lg font-medium transition cursor-pointer ${
                  tab === 'register' ? 'bg-slate-800 text-slate-100 shadow-xs' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Criar Conta
              </button>
            </div>

            {error && (
              <div className="p-3 rounded-xl bg-red-950/40 border border-red-800/60 text-red-300 text-xs flex items-start gap-2">
                <AlertCircle size={15} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {successMsg && (
              <div className="p-3 rounded-xl bg-emerald-950/40 border border-emerald-800/60 text-emerald-300 text-xs flex items-start gap-2">
                <CheckCircle2 size={15} className="shrink-0 mt-0.5" />
                <span>{successMsg}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-3.5">
              {tab === 'register' && (
                <div className="space-y-1.5">
                  <label className="text-xs text-slate-300 font-medium flex items-center gap-1.5">
                    <User size={13} className="text-slate-400" />
                    Nome Completo
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ex: Paulo Silva"
                    className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-100 text-xs placeholder:text-slate-600 focus:outline-hidden focus:border-cyan-500"
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs text-slate-300 font-medium flex items-center gap-1.5">
                  <Mail size={13} className="text-slate-400" />
                  E-mail
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="seu.email@exemplo.com"
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-100 text-xs placeholder:text-slate-600 focus:outline-hidden focus:border-cyan-500"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-slate-300 font-medium flex items-center gap-1.5">
                  <Lock size={13} className="text-slate-400" />
                  Senha
                </label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Mínimo 8 caracteres"
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-100 text-xs placeholder:text-slate-600 focus:outline-hidden focus:border-cyan-500"
                />
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full mt-2 py-2.5 px-4 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold flex items-center justify-center gap-2 transition cursor-pointer shadow-lg shadow-cyan-900/30 disabled:opacity-50"
              >
                <span>{isLoading ? 'Autenticando...' : tab === 'login' ? 'Entrar com Firebase Auth' : 'Criar Conta com Firebase Auth'}</span>
                <ArrowRight size={14} />
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};


