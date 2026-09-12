import React from 'react';

type State = { error: Error | null };

export class AppErrorBoundary extends React.Component<{ children?: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Forge Agent render failure', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="min-h-screen bg-slate-950 text-slate-100 grid place-items-center p-6">
        <section className="w-full max-w-lg rounded-2xl border border-rose-900/60 bg-slate-900 p-6 shadow-2xl">
          <h1 className="text-lg font-bold">A interface encontrou um erro</h1>
          <p className="mt-2 text-sm text-slate-400">Seus dados continuam salvos. Recarregue a interface para tentar novamente.</p>
          <p className="mt-3 rounded-lg bg-slate-950 p-3 font-mono text-xs text-rose-300 break-words">{this.state.error.message}</p>
          <button className="mt-4 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-bold text-slate-950" onClick={() => window.location.reload()}>Recarregar</button>
        </section>
      </main>
    );
  }
}

