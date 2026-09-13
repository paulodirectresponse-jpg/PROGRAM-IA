import React, { useEffect, useState } from 'react';
import { Activity, ArrowDown, ArrowUp, Bot, Plus, StopCircle, Trash2, X } from 'lucide-react';

type Candidate={id:string;provider_key:string;model_id:string;priority:number;enabled:number;health_state:string};
type Profile={id:string;profile_key:string;name:string;max_attempts:number;max_cost_usd:number;candidates:Candidate[]};
type Agent={key:string;label:string;profile:string;metrics:{calls:number;cost_usd:number;successes:number;executions?:number;completed?:number}};
type Invocation={id:string;agent_key:string;profile_key:string;provider_key:string;model_id:string;status:string;error_code?:string;retry_index:number;latency_ms:number;cost_usd:number};
type TraceStep={id:string;agent_key:string;title:string;status:string;attempt_count:number;invocations:Invocation[]};
type AgentRun={id:string;project_id:string;mode:string;status:string;spent_usd:number;budget_usd:number;created_at:string;trace:TraceStep[]};

export function AgentsModal({isOpen,onClose}:{isOpen:boolean;onClose:()=>void}){
  const [agents,setAgents]=useState<Agent[]>([]),[profiles,setProfiles]=useState<Profile[]>([]),[runs,setRuns]=useState<AgentRun[]>([]),[providerKey,setProviderKey]=useState('omniroute'),[modelId,setModelId]=useState('auto'),[profileKey,setProfileKey]=useState('BASE_FREE'),[error,setError]=useState(''),[engineEnabled,setEngineEnabled]=useState<boolean|null>(null);
  const load=async()=>{
    const [a,p,v,runsData]=await Promise.allSettled([
      fetch('/api/agents').then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error||'Falha ao carregar agentes');return d}),
      fetch('/api/model-profiles').then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error||'Falha ao carregar perfis');return d}),
      fetch('/api/version').then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error||'Falha ao carregar versão');return d}),
      fetch('/api/agent-runs').then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error||'Falha ao carregar execuções');return d}),
    ]);
    const failures:string[]=[];
    if(a.status==='fulfilled')setAgents(a.value.agents||[]);else failures.push('agentes');
    if(p.status==='fulfilled')setProfiles(p.value.profiles||[]);else failures.push('perfis');
    if(v.status==='fulfilled')setEngineEnabled(Boolean(v.value.agentEngineEnabled));else failures.push('status');
    if(runsData.status==='fulfilled')setRuns(runsData.value.runs||[]);else failures.push('execuções');
    setError(failures.length?`Falha parcial ao carregar: ${failures.join(', ')}.`:'');
  };
  useEffect(()=>{if(!isOpen)return;load().catch(()=>setError('Não foi possível carregar agentes e perfis.'));const timer=setInterval(()=>load().catch(()=>{}),2000);return()=>clearInterval(timer)},[isOpen]);
  const mutate=async(url:string,method:string,body?:unknown)=>{setError('');const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw Error(data.error||'Operação falhou.');setProfiles(data.profiles||[])};
  const cancelRun=async(run:AgentRun)=>{
    setError('');
    try{
      const r=await fetch(`/api/conversations/${run.project_id}/abort`,{method:'POST'});
      const data=await r.json().catch(()=>({}));
      if(!r.ok&&r.status!==404)throw Error(data.error||'Não foi possível cancelar a execução.');
      await load();
    }catch(e:any){setError(e?.message||'Não foi possível cancelar a execução.')}
  };
  const continueRun=async(run:AgentRun)=>{
    setError('');
    try{
      const r=await fetch(`/api/agent-runs/${run.id}/continue`,{method:'POST'});
      const data=await r.json().catch(()=>({}));
      if(!r.ok)throw Error(data.error||'Não foi possível continuar a execução.');
      await load();
    }catch(e:any){setError(e?.message||'Não foi possível continuar a execução.')}
  };
  if(!isOpen)return null;
  return <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-5"><div className="w-full max-w-5xl max-h-[88vh] overflow-auto rounded-2xl border border-slate-700/80 bg-slate-950 shadow-2xl">
    <header className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/95 backdrop-blur"><div><h2 className="text-lg font-semibold text-white flex items-center gap-2"><Bot size={19} className="text-cyan-400"/>Agentes e roteamento</h2><p className="text-xs text-slate-400 mt-1">Papéis fixos, modelos substituíveis, custo e saúde observáveis.</p></div><button onClick={onClose} className="p-2 text-slate-400 hover:text-white"><X size={18}/></button></header>
    <div className="p-6 space-y-7">
      {engineEnabled===false&&<section className="rounded-xl border border-amber-800/60 bg-amber-950/30 px-4 py-3 text-xs text-amber-200">O Agent Engine está configurado, mas desativado neste runtime. Os perfis podem ser preparados aqui sem executar orquestração multiagente até <span className="font-mono">AGENT_ENGINE_ENABLED=true</span>.</section>}
      {engineEnabled===true&&<section className="rounded-xl border border-emerald-800/60 bg-emerald-950/25 px-4 py-3 text-xs text-emerald-200">Agent Engine ativo neste runtime. Roteamento por perfil, telemetria e limites de custo estão habilitados.</section>}
      <section><h3 className="text-xs uppercase tracking-wider text-slate-500 mb-3">Equipe do MVP</h3><div className="grid grid-cols-2 lg:grid-cols-5 gap-3">{agents.map(a=><div key={a.key} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3"><div className="font-semibold text-slate-100">{a.key}</div><div className="text-[11px] text-slate-400 mt-1">{a.label}</div><div className="mt-3 text-[10px] text-cyan-300">{a.profile}</div><div className="text-[10px] text-slate-400 mt-1">{a.metrics.executions||0} execuções · {a.metrics.calls||0} chamadas IA</div><div className="text-[10px] text-slate-500 mt-0.5">{a.metrics.successes||0} OK · ${Number(a.metrics.cost_usd||0).toFixed(3)}</div></div>)}</div></section>
      <section><div className="flex items-center gap-2 mb-3"><Activity size={15} className="text-cyan-400"/><h3 className="text-sm font-semibold text-slate-100">Últimas execuções</h3></div><div className="space-y-3">{runs.slice(0,8).map(run=><div key={run.id} className="rounded-xl border border-slate-800 bg-slate-900/50 p-3"><div className="flex flex-wrap items-center justify-between gap-2 text-[10px]"><div className="font-mono text-slate-300">{run.mode?.toUpperCase()} · <span className={run.status==='completed'?'text-emerald-400':run.status==='failed'?'text-rose-400':run.status==='waiting_approval'?'text-amber-400':run.status==='aborted'?'text-slate-400':'text-cyan-400'}>{run.status}</span><span className="ml-2 text-slate-600">· {new Date(run.created_at).toLocaleString('pt-BR')} · {run.id.slice(-8)}</span></div><div className="flex items-center gap-2"><span className="text-slate-500">custo ${Number(run.spent_usd||0).toFixed(3)} / ${Number(run.budget_usd||0).toFixed(2)}</span>{run.status==='running'&&<button onClick={()=>cancelRun(run)} className="inline-flex items-center gap-1 rounded border border-rose-900/70 bg-rose-950/30 px-2 py-1 text-rose-300 hover:bg-rose-950/60"><StopCircle size={11}/>Cancelar</button>}{(['failed','aborted'].includes(run.status)&&run.trace?.some(step=>step.agent_key==='SCOUT'&&step.status==='completed'))&&<button onClick={()=>continueRun(run)} className="inline-flex items-center gap-1 rounded border border-cyan-900/70 bg-cyan-950/30 px-2 py-1 text-cyan-300 hover:bg-cyan-950/60">Continuar</button>}</div></div><div className="mt-2 flex flex-wrap gap-1.5">{(run.trace||[]).map(step=><div key={step.id} className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1.5 text-[10px]"><div className="flex items-center gap-1.5"><span className="font-semibold text-cyan-300">{step.agent_key}</span><span className="text-slate-500">{step.status}</span>{step.attempt_count>0&&<span className="text-slate-600">· {step.attempt_count} tent.</span>}</div><div className="text-slate-500 mt-0.5 max-w-56 truncate">{step.title}</div>{(step.invocations||[]).map(inv=><div key={inv.id} className="mt-1 border-t border-slate-800 pt-1 text-slate-400"><span className={inv.status==='success'?'text-emerald-400':'text-rose-400'}>{inv.status}</span> · {inv.profile_key} · {inv.provider_key}/{inv.model_id} · {inv.latency_ms}ms{inv.error_code?` · ${inv.error_code}`:''}</div>)}</div>)}</div></div>)}{runs.length===0&&<div className="text-xs text-slate-500">Nenhuma execução registrada ainda.</div>}</div></section>
      <section><div className="flex items-center gap-2 mb-3"><Activity size={15} className="text-emerald-400"/><h3 className="text-sm font-semibold text-slate-100">Perfis de modelo</h3></div><div className="grid lg:grid-cols-3 gap-3">{profiles.map(p=><div key={p.id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4"><div className="flex justify-between"><div><div className="font-semibold text-slate-100">{p.name}</div><div className="text-[10px] font-mono text-slate-500">{p.profile_key}</div></div><div className="text-[10px] text-slate-400">até ${p.max_cost_usd}</div></div><div className="mt-3 space-y-2">{p.candidates.map((c,i)=><div key={c.id} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950 p-2"><button onClick={()=>mutate(`/api/model-candidates/${c.id}`,'PATCH',{priority:Math.max(0,c.priority-1)}).catch(e=>setError(e.message))} title="Subir"><ArrowUp size={12}/></button><button onClick={()=>mutate(`/api/model-candidates/${c.id}`,'PATCH',{priority:c.priority+1}).catch(e=>setError(e.message))} title="Descer"><ArrowDown size={12}/></button><div className="min-w-0 flex-1"><div className="truncate text-[11px] text-slate-200">{c.provider_key} · {c.model_id}</div><div className="text-[9px] text-slate-500">#{i+1} · {c.health_state}</div></div><button onClick={()=>mutate(`/api/model-candidates/${c.id}`,'PATCH',{enabled:!c.enabled}).catch(e=>setError(e.message))} className={`text-[9px] px-1.5 py-1 rounded ${c.enabled?'text-emerald-300 bg-emerald-950':'text-slate-400 bg-slate-800'}`}>{c.enabled?'ativo':'pausado'}</button><button onClick={()=>mutate(`/api/model-candidates/${c.id}`,'DELETE').catch(e=>setError(e.message))}><Trash2 size={12} className="text-rose-400"/></button></div>)}</div></div>)}</div></section>
      <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"><h3 className="text-sm font-semibold text-slate-100 mb-3 flex items-center gap-2"><Plus size={14}/>Adicionar modelo ao perfil</h3><div className="grid sm:grid-cols-4 gap-2"><select value={profileKey} onChange={e=>setProfileKey(e.target.value)} className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs">{profiles.map(p=><option key={p.id} value={p.profile_key}>{p.name}</option>)}</select><input value={providerKey} onChange={e=>setProviderKey(e.target.value)} placeholder="provedor" className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs"/><input value={modelId} onChange={e=>setModelId(e.target.value)} placeholder="modelo" className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs"/><button onClick={()=>mutate(`/api/model-profiles/${profileKey}/candidates`,'PUT',{providerKey,modelId,priority:99}).catch(e=>setError(e.message))} className="rounded-lg bg-cyan-500 text-slate-950 text-xs font-semibold">Adicionar</button></div>{error&&<p className="mt-3 text-xs text-rose-300">{error}</p>}</section>
    </div></div></div>
}

