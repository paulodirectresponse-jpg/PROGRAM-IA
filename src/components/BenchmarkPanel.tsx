import React, { useEffect, useMemo, useState } from 'react';
import { Activity, Play, RefreshCw, RotateCcw, ShieldCheck, StopCircle } from 'lucide-react';

type Candidate={providerKey:string;modelId:string;maxCostUsd:number;priority:number};
type Preflight={
  suiteKey:string;totalCases:number;realProviderRequired:boolean;canRun:boolean;
  baseCandidates:Candidate[];expertCandidates:Candidate[];
  minimumCaseReserveUsd:number|null;dailyLimitUsd:number;spentTodayUsd:number;remainingDailyUsd:number;maxBenchmarkBudgetUsd:number;
};
type BenchmarkCase={
  id:string;caseId:string;order:number;category:string;mode:string;agentKey:string;status:string;score:number;passed:boolean;
  profileKey?:string|null;providerKey?:string|null;modelId?:string|null;providerReal:boolean;costUsd:number;latencyMs:number;
  attempts:number;repairs:number;expertEscalations:number;validatorStatus?:string|null;browserStatus?:string|null;failureReason?:string|null;
};
type BenchmarkRun={
  id:string;suiteKey:string;status:string;totalCases:number;completedCases:number;passedCases:number;failedCases:number;
  maxCostUsd:number;spentUsd:number;allowExpert:boolean;summary:any;createdAt:string;startedAt?:string|null;finishedAt?:string|null;cases:BenchmarkCase[];
};
type ReleaseGate={version:string;eligible:boolean;passed:boolean;criteria:Record<string,boolean>;thresholds:Record<string,number>;summary:any};

const SMOKE_CASES=['P4-01','P4-11','P4-28'];
const terminal=new Set(['completed','failed','interrupted','cancelled','budget_exhausted']);

function pct(value:number|undefined){return `${Math.round(Number(value||0)*100)}%`;}
function money(value:number|undefined){return `$${Number(value||0).toFixed(4)}`;}
function statusTone(status:string){
  if(status==='completed'||status==='passed')return 'text-emerald-300 border-emerald-900/60 bg-emerald-950/30';
  if(status==='failed')return 'text-rose-300 border-rose-900/60 bg-rose-950/30';
  if(status==='running')return 'text-cyan-300 border-cyan-900/60 bg-cyan-950/30';
  if(status==='budget_exhausted'||status==='interrupted'||status==='cancelled')return 'text-amber-300 border-amber-900/60 bg-amber-950/30';
  return 'text-slate-400 border-slate-800 bg-slate-900';
}

async function jsonFetch(url:string,options?:RequestInit){
  const response=await fetch(url,options);
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||'Falha na operação de benchmark.');
  return data;
}

export function BenchmarkPanel(){
  const [preflight,setPreflight]=useState<Preflight|null>(null);
  const [runs,setRuns]=useState<BenchmarkRun[]>([]);
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [selected,setSelected]=useState<BenchmarkRun|null>(null);
  const [gate,setGate]=useState<ReleaseGate|null>(null);
  const [allowExpert,setAllowExpert]=useState(false);
  const [budget,setBudget]=useState('1.00');
  const [confirmed,setConfirmed]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');

  const refresh=async()=>{
    const [p,r]=await Promise.all([
      jsonFetch(`/api/benchmarks/preflight?allowExpert=${allowExpert?'true':'false'}`),
      jsonFetch('/api/benchmarks'),
    ]);
    setPreflight(p);
    setRuns(r.runs||[]);
    const target=selectedId||(r.runs?.[0]?.id??null);
    if(target){
      setSelectedId(target);
      const detail=await jsonFetch(`/api/benchmarks/${encodeURIComponent(target)}`);
      setSelected(detail.run||null);
      if(detail.run?.status==='completed'&&detail.run?.totalCases===30){
        const g=await jsonFetch(`/api/benchmarks/${encodeURIComponent(target)}/release-gate`);
        setGate(g.gate||null);
      }else setGate(null);
    }else{
      setSelected(null);setGate(null);
    }
  };

  useEffect(()=>{refresh().catch(e=>setError(e.message));},[allowExpert]);
  useEffect(()=>{
    const timer=setInterval(()=>refresh().catch(()=>{}),2500);
    return()=>clearInterval(timer);
  },[allowExpert,selectedId]);

  const progress=selected?.totalCases?selected.completedCases/selected.totalCases:0;
  const running=selected&&['queued','running'].includes(selected.status);
  const start=async(full:boolean)=>{
    setBusy(true);setError('');
    try{
      const maxCostUsd=Number(budget);
      const data=await jsonFetch('/api/benchmarks',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          maxCostUsd,confirmRealProviderCosts:confirmed,allowExpert,
          caseIds:full?undefined:SMOKE_CASES,
        }),
      });
      setSelectedId(data.run.id);setSelected(data.run);setGate(null);setConfirmed(false);
      await refresh();
    }catch(e:any){setError(e.message);}finally{setBusy(false);}
  };
  const cancel=async()=>{
    if(!selected)return;
    setBusy(true);setError('');
    try{await jsonFetch(`/api/benchmarks/${selected.id}/cancel`,{method:'POST'});await refresh();}
    catch(e:any){setError(e.message);}finally{setBusy(false);}
  };
  const resume=async()=>{
    if(!selected)return;
    setBusy(true);setError('');
    try{
      await jsonFetch(`/api/benchmarks/${selected.id}/resume`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({maxCostUsd:Number(budget),confirmRealProviderCosts:confirmed}),
      });
      setConfirmed(false);await refresh();
    }catch(e:any){setError(e.message);}finally{setBusy(false);}
  };

  const categoryRows=useMemo(()=>Object.entries(selected?.summary?.categoryBreakdown||{}),[selected?.summary]);

  return <section className="rounded-xl border border-violet-900/50 bg-violet-950/10 p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-2"><Activity size={15} className="text-violet-400"/><h3 className="text-sm font-semibold text-slate-100">Benchmark da Fase 4</h3><span className="rounded border border-violet-900/60 bg-violet-950/30 px-1.5 py-0.5 text-[9px] font-mono text-violet-300">phase4-v1-30</span></div>
        <p className="mt-1 max-w-2xl text-[10px] text-slate-500">Suíte canônica com provider real, custo limitado, scoring determinístico e release gate. Nenhuma execução paga inicia sem confirmação explícita.</p>
      </div>
      <button onClick={()=>refresh().catch(e=>setError(e.message))} className="inline-flex items-center gap-1 rounded border border-slate-800 px-2 py-1 text-[10px] text-slate-400 hover:text-white"><RefreshCw size={11}/>Atualizar</button>
    </div>

    <div className="mt-4 grid gap-3 lg:grid-cols-4">
      <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3"><div className="text-[9px] uppercase text-slate-600">Provider BASE_FREE</div><div className="mt-1 text-[11px] text-slate-200">{preflight?.baseCandidates?.[0]?<>{preflight.baseCandidates[0].providerKey}<span className="text-slate-600"> / </span>{preflight.baseCandidates[0].modelId}</>:'Nenhum configurado'}</div></div>
      <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3"><div className="text-[9px] uppercase text-slate-600">Budget diário</div><div className="mt-1 text-[11px] text-slate-200">{money(preflight?.spentTodayUsd)} usado · {money(preflight?.remainingDailyUsd)} restante</div></div>
      <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3"><div className="text-[9px] uppercase text-slate-600">Suíte</div><div className="mt-1 text-[11px] text-slate-200">{preflight?.totalCases??30} casos · 6 categorias</div></div>
      <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3"><div className="text-[9px] uppercase text-slate-600">Reserva mínima/caso</div><div className="mt-1 text-[11px] text-slate-200">{preflight?.minimumCaseReserveUsd==null?'indisponível':money(preflight.minimumCaseReserveUsd)}</div></div>
    </div>

    <div className="mt-3 grid gap-2 md:grid-cols-[130px_1fr]">
      <label className="text-[10px] text-slate-400">Budget máximo (USD)<input value={budget} onChange={e=>setBudget(e.target.value)} inputMode="decimal" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100"/></label>
      <div className="flex flex-wrap items-end gap-2">
        <label className="mb-1 inline-flex items-center gap-2 text-[10px] text-slate-400"><input type="checkbox" checked={allowExpert} onChange={e=>setAllowExpert(e.target.checked)} className="accent-violet-500"/>Permitir EXPERT_PAID somente quando o step bloquear</label>
        <label className="mb-1 inline-flex items-center gap-2 text-[10px] text-amber-300"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} className="accent-amber-500"/>Confirmo uso de créditos reais até o budget informado</label>
      </div>
    </div>

    <div className="mt-3 flex flex-wrap gap-2">
      <button disabled={busy||!confirmed||!preflight?.canRun||Boolean(running)} onClick={()=>start(false)} className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-800 bg-cyan-950/40 px-3 py-2 text-[10px] font-semibold text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"><Play size={11}/>Smoke 3 casos</button>
      <button disabled={busy||!confirmed||!preflight?.canRun||Boolean(running)} onClick={()=>start(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-violet-500 px-3 py-2 text-[10px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"><ShieldCheck size={11}/>Executar 30 casos</button>
      {running&&<button disabled={busy} onClick={cancel} className="inline-flex items-center gap-1.5 rounded-lg border border-rose-900 bg-rose-950/30 px-3 py-2 text-[10px] text-rose-300"><StopCircle size={11}/>Cancelar</button>}
      {selected&&['interrupted','cancelled','budget_exhausted'].includes(selected.status)&&<button disabled={busy||!confirmed} onClick={resume} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-900 bg-amber-950/30 px-3 py-2 text-[10px] text-amber-300 disabled:opacity-40"><RotateCcw size={11}/>Retomar com confirmação</button>}
    </div>
    {!preflight?.canRun&&<p className="mt-2 text-[10px] text-amber-300">Nenhum candidate real utilizável está configurado nos perfis selecionados. O benchmark não pode usar fallback.</p>}
    {error&&<p className="mt-2 text-[10px] text-rose-300">{error}</p>}

    {runs.length>0&&<div className="mt-5">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-slate-600">Runs</div>
      <div className="flex gap-2 overflow-x-auto pb-1">{runs.slice(0,10).map(run=><button key={run.id} onClick={()=>{setSelectedId(run.id);setGate(null)}} className={`shrink-0 rounded-lg border px-2.5 py-2 text-left text-[10px] ${selectedId===run.id?'border-violet-700 bg-violet-950/30':'border-slate-800 bg-slate-950'}`}><div className="text-slate-300">{run.totalCases} casos · {run.status}</div><div className="mt-0.5 font-mono text-[9px] text-slate-600">{run.id.slice(-8)}</div></button>)}</div>
    </div>}

    {selected&&<div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/70 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><div className="text-[11px] font-semibold text-slate-200">{selected.completedCases}/{selected.totalCases} concluídos</div><div className="mt-0.5 font-mono text-[9px] text-slate-600">{selected.id}</div></div>
        <span className={`rounded-md border px-2 py-1 text-[9px] uppercase ${statusTone(selected.status)}`}>{selected.status}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-900"><div className="h-full bg-violet-500 transition-all" style={{width:`${Math.max(2,Math.round(progress*100))}%`}}/></div>
      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-6">
        <Metric label="Aprovados" value={`${selected.passedCases}/${selected.completedCases||0}`}/>
        <Metric label="Pass rate" value={pct(selected.summary?.passRate)}/>
        <Metric label="Score médio" value={String(selected.summary?.averageScore??0)}/>
        <Metric label="1ª tentativa" value={pct(selected.summary?.firstPassRate)}/>
        <Metric label="Repair" value={pct(selected.summary?.repairRate)}/>
        <Metric label="Custo" value={`${money(selected.spentUsd)} / ${money(selected.maxCostUsd)}`}/>
      </div>

      {categoryRows.length>0&&<div className="mt-3 flex flex-wrap gap-1.5">{categoryRows.map(([name,value]:any)=><span key={name} className="rounded border border-slate-800 bg-slate-900 px-2 py-1 text-[9px] text-slate-400">{name}: {value.passed}/{value.cases} · score {value.averageScore}</span>)}</div>}

      <div className="mt-3 max-h-56 overflow-auto rounded-lg border border-slate-900">
        {(selected.cases||[]).map(item=><div key={item.id} className="grid grid-cols-[52px_1fr_auto] items-center gap-2 border-b border-slate-900 px-2 py-1.5 text-[9px] last:border-b-0"><span className="font-mono text-violet-300">{item.caseId}</span><div className="min-w-0"><div className="truncate text-slate-400">{item.category} · {item.agentKey} · {item.providerKey||'—'}/{item.modelId||'—'}</div>{item.failureReason&&<div className="truncate text-rose-400">{item.failureReason}</div>}</div><div className="flex items-center gap-2"><span className="text-slate-600">{money(item.costUsd)}</span><span className={item.passed?'text-emerald-400':item.status==='failed'?'text-rose-400':'text-slate-500'}>{item.status} · {item.score}</span></div></div>)}
      </div>
    </div>}

    {gate&&<div className={`mt-3 rounded-xl border p-3 ${gate.passed?'border-emerald-800 bg-emerald-950/20':'border-amber-900 bg-amber-950/20'}`}>
      <div className="flex items-center gap-2 text-[11px] font-semibold"><ShieldCheck size={13}/><span className={gate.passed?'text-emerald-300':'text-amber-300'}>Release gate {gate.version}: {gate.passed?'APROVADO':'NÃO APROVADO'}</span></div>
      <div className="mt-2 flex flex-wrap gap-1.5">{Object.entries(gate.criteria||{}).map(([key,value])=><span key={key} className={`rounded border px-2 py-1 text-[9px] ${value?'border-emerald-900 text-emerald-400':'border-rose-900 text-rose-400'}`}>{key}: {value?'pass':'fail'}</span>)}</div>
    </div>}
  </section>;
}

function Metric({label,value}:{label:string;value:string}){
  return <div className="rounded-lg border border-slate-900 bg-slate-900/40 p-2"><div className="text-[8px] uppercase text-slate-600">{label}</div><div className="mt-1 text-[10px] font-semibold text-slate-300">{value}</div></div>;
}
