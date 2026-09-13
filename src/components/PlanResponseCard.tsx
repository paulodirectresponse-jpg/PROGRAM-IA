import React from 'react';
import { AlertTriangle, Check, CheckCircle2, FileCode2, Sparkles } from 'lucide-react';

type PresentablePlan = {
  objective: string;
  scopeIn: string[];
  scopeOut: string[];
  files: string[];
  integrations: string[];
  risks: string[];
  acceptance: string[];
};

const asList = (value: unknown): string[] => {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(asList).map((item) => item.trim()).filter(Boolean);
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([key, nested]) => {
      const parts = asList(nested);
      return parts.length ? key + ': ' + parts.join(', ') : key;
    }).filter(Boolean);
  }
  const text = String(value).trim();
  if (!text) return [];
  if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}'))) {
    try { return asList(JSON.parse(text)); } catch {}
  }
  return text.split('\n').map((item) => item.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean);
};

export const parsePlanForDisplay = (content: string): PresentablePlan | null => {
  const raw = String(content || '').trim();
  if (!raw) return null;

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  const candidates = [raw];
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(raw.slice(firstBrace, lastBrace + 1));

  let parsed: any = null;
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object') { parsed = value; break; }
    } catch {}
  }
  if (!parsed) return null;

  const root = parsed.plan && typeof parsed.plan === 'object' ? parsed.plan : parsed;
  const plan: PresentablePlan = {
    objective: String(root.objective ?? root.objetivo ?? '').trim(),
    scopeIn: asList(root.scope_in ?? root.scopeIn ?? root.escopo ?? root.scope),
    scopeOut: asList(root.scope_out ?? root.scopeOut ?? root.fora_do_escopo),
    files: asList(root.files_affected ?? root.filesAffected ?? root.arquivos),
    integrations: asList(root.integrations ?? root.integracoes),
    risks: asList(root.risks ?? root.riscos),
    acceptance: asList(root.acceptance_criteria ?? root.acceptanceCriteria ?? root.criterios_de_aceite),
  };

  return plan.objective || plan.scopeIn.length || plan.files.length || plan.integrations.length || plan.risks.length || plan.acceptance.length ? plan : null;
};

export const PlanResponseCard: React.FC<{ content: string }> = ({ content }) => {
  const plan = parsePlanForDisplay(content);
  if (!plan) return <div>{content}</div>;

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-amber-800/50 bg-amber-950/20 p-3">
        <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-400">
          <Sparkles size={12} />
          Plano técnico
        </div>
        {plan.objective && <div className="text-[13px] font-semibold leading-relaxed text-slate-100">{plan.objective}</div>}
      </div>

      {plan.scopeIn.length > 0 && (
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">O que será construído</div>
          <div className="space-y-1.5">
            {plan.scopeIn.map((item, index) => (
              <div key={item + '-' + index} className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-300">
                <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-emerald-400" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {plan.files.length > 0 && (
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Arquivos previstos</div>
          <div className="flex flex-wrap gap-1">
            {plan.files.map((file) => (
              <span key={file} className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono text-[10px] text-cyan-300">
                <FileCode2 size={10} />
                {file}
              </span>
            ))}
          </div>
        </div>
      )}

      {plan.integrations.length > 0 && (
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Integrações</div>
          <div className="flex flex-wrap gap-1">
            {plan.integrations.map((item) => <span key={item} className="rounded-md border border-blue-900/70 bg-blue-950/40 px-2 py-1 text-[10px] text-blue-300">{item}</span>)}
          </div>
        </div>
      )}

      {plan.acceptance.length > 0 && (
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Critérios de aceite</div>
          <div className="space-y-1">
            {plan.acceptance.map((item, index) => (
              <div key={item + '-' + index} className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-300">
                <Check size={11} className="mt-0.5 shrink-0 text-cyan-400" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {plan.risks.length > 0 && (
        <div className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-400">
            <AlertTriangle size={11} />
            Pontos de atenção
          </div>
          <div className="space-y-1">
            {plan.risks.map((item, index) => <div key={item + '-' + index} className="text-[10px] leading-relaxed text-amber-200/80">• {item}</div>)}
          </div>
        </div>
      )}

      {plan.scopeOut.length > 0 && (
        <details className="rounded-lg border border-slate-800 bg-slate-950/50 p-2">
          <summary className="cursor-pointer text-[10px] font-semibold text-slate-500">Fora do escopo</summary>
          <div className="mt-2 space-y-1">
            {plan.scopeOut.map((item, index) => <div key={item + '-' + index} className="text-[10px] leading-relaxed text-slate-500">• {item}</div>)}
          </div>
        </details>
      )}
    </div>
  );
};
