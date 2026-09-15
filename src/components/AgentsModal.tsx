import React, { useEffect, useState } from 'react';
import { Activity, AlertTriangle, ArrowDown, ArrowUp, Bot, CheckCircle2, CircleDollarSign, Gauge, ListChecks, Network, Plus, RefreshCcw, Route, ShieldCheck, StopCircle, Trash2, X } from 'lucide-react';

type Candidate={id:string;provider_key:string;model_id:string;priority:number;enabled:number;health_state:string};
type Profile={id:string;profile_key:string;name:string;max_attempts:number;max_cost_usd:number;candidates:Candidate[]};
type Agent={key:string;label:string;profile:string;metrics:{calls:number;cost_usd:number;budget_cost_usd?:number;unknown_cost_calls?:number;successes:number;executions?:number;completed?:number}};
type Invocation={id:string;agent_key:string;profile_key:string;provider_key:string;model_id:string;status:string;error_code?:string;retry_index:number;latency_ms:number;cost_usd:number|null;cost_status?:'reported'|'known_zero'|'unknown'|'partial'|'legacy';budget_cost_usd?:number};
type AgentStageEvent={type?:string;stage?:string;status?:string;at?:string;error?:string;reason?:string;providerKey?:string;modelId?:string;latencyMs?:number;targetCount?:number;requirementCount?:number;taskCount?:number;retryAllowed?:boolean;escalateAllowed?:boolean;nextStrategy?:string};
type TraceStep={id:string;agent_key:string;title:string;status:string;attempt_count:number;invocations:Invocation[];context?:{events?:AgentStageEvent[]}|null};
type AgentRun={id:string;project_id:string;mode:string;status:string;spent_usd:number;budget_usd:number;known_cost_usd?:number;budget_accounted_usd?:number;unknown_cost_calls?:number;created_at:string;trace:TraceStep[]};
type Requirement={id:string;requirement_key:string;title:string;priority:string;status:string;verification:string[];files:string[];evidence:any[]};
type TabKey='overview'|'runs'|'requirements'|'routing';
type DetailMode='basic'|'advanced';
type RunFilter='all'|'running'|'failed'|'completed';

const stageLabel=(stage?:string)=>({
  'agent.selected':'Agente selecionado',
  'model.routing':'Roteamento do modelo',
  'model.routing.empty':'Nenhum modelo disponível',
  'context.compile':'Compilação do contexto',
  'model.request':'Chamada ao modelo',
  'model.response':'Resposta do modelo',
  'contract.validation':'Validação do contrato',
  'attempt.failed':'Tentativa falhou',
  'retry.decision':'Decisão de retry',
  'profile.escalation':'Escalonamento de perfil',
  'planning.model_result':'Resultado do planejamento',
  'planning.architecture_validation':'Validação da arquitetura',
  'planning.deterministic_repair':'Reparo estrutural local',
  'planning.architecture_repair':'Reparo da arquitetura',
  'requirements.persistence':'Persistência dos requisitos',
  'paid_call.guard':'Controle de chamada paga',
}[String(stage||'')]||String(stage||'Etapa'));

const stageTone=(status?:string)=>status==='completed'?'text-emerald-400':status==='failed'?'text-rose-400':status==='started'?'text-cyan-400':'text-amber-400';

const invocationCostLabel=(inv:Invocation)=>{
  const known=inv.cost_usd===null||inv.cost_usd===undefined?null:Number(inv.cost_usd);
  if(inv.cost_status==='unknown')return 'custo não informado';
  if(inv.cost_status==='partial')return `custo parcial ≥ US$ ${Number(known||0).toFixed(4)}`;
  if(inv.cost_status==='known_zero')return 'US$ 0,0000 confirmado';
  if(known!==null)return `US$ ${known.toFixed(4)}`;
  return 'custo legado';
};

const runStatusLabel=(status?:string)=>({
  running:'Em execução',completed:'Concluída',failed:'Falhou',aborted:'Interrompida',
  rejected:'Rejeitada',waiting_approval:'Aguardando aprovação',needs_verification:'Requer verificação',
}[String(status||'')]||String(status||'Desconhecido'));

const runEvents=(run:AgentRun)=>(run.trace||[]).flatMap(step=>
  (step.context?.events||[]).filter(event=>event.type==='agent_stage').map(event=>({...event,agentKey:step.agent_key}))
);
const runFailure=(run:AgentRun)=>[...runEvents(run)].reverse().find(event=>event.status==='failed')||null;
const runLatest=(run:AgentRun)=>[...runEvents(run)].reverse()[0]||null;


export function AgentsModal({isOpen,onClose,projectId}:{isOpen:boolean;onClose:()=>void;projectId?:string|null}){
  const [agents,setAgents]=useState<Agent[]>([]),[profiles,setProfiles]=useState<Profile[]>([]),[runs,setRuns]=useState<AgentRun[]>([]),[requirements,setRequirements]=useState<Requirement[]>([]),[providerKey,setProviderKey]=useState('omniroute'),[modelId,setModelId]=useState('auto'),[profileKey,setProfileKey]=useState('BASE_FREE'),[error,setError]=useState(''),[engineEnabled,setEngineEnabled]=useState<boolean|null>(null);
  const [tab,setTab]=useState<TabKey>('overview'),[detailMode,setDetailMode]=useState<DetailMode>('basic'),[runFilter,setRunFilter]=useState<RunFilter>('all'),[refreshing,setRefreshing]=useState(false);
  const load=async(silent=false)=>{if(!silent)setRefreshing(true);
    const [a,p,v,runsData,requirementsData]=await Promise.allSettled([
      fetch('/api/agents').then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error||'Falha ao carregar agentes');return d}),
      fetch('/api/model-profiles').then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error||'Falha ao carregar perfis');return d}),
      fetch('/api/version').then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error||'Falha ao carregar versão');return d}),
      fetch(projectId?`/api/agent-runs?projectId=${encodeURIComponent(projectId)}`:'/api/agent-runs').then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error||'Falha ao carregar execuções');return d}),
      projectId
        ? fetch(`/api/projects/${encodeURIComponent(projectId)}/requirements`).then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error||'Falha ao carregar requisitos');return d})
        : Promise.resolve({requirements:[],summary:{total:0,counts:{}}}),
    ]);
    const failures:string[]=[];
    if(a.status==='fulfilled')setAgents(a.value.agents||[]);else failures.push('agentes');
    if(p.status==='fulfilled')setProfiles(p.value.profiles||[]);else failures.push('perfis');
    if(v.status==='fulfilled')setEngineEnabled(Boolean(v.value.agentEngineEnabled));else failures.push('status');
    if(runsData.status==='fulfilled')setRuns(runsData.value.runs||[]);else failures.push('execuções');
    if(requirementsData.status==='fulfilled')setRequirements(requirementsData.value.requirements||[]);else failures.push('requisitos');
    setError(failures.length?`Falha parcial ao carregar: ${failures.join(', ')}.`:'');
    setRefreshing(false);
  };
  useEffect(()=>{if(!isOpen)return;load().catch(()=>{setRefreshing(false);setError('Não foi possível carregar a Central de Agentes.')});const timer=setInterval(()=>load(true).catch(()=>{}),2000);return()=>clearInterval(timer)},[isOpen,projectId]);
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
  const terminalRuns=runs.filter(run=>['completed','failed','aborted','rejected','needs_verification'].includes(run.status));
  const completedRuns=runs.filter(run=>run.status==='completed').length;
  const failedRuns=runs.filter(run=>['failed','aborted'].includes(run.status)).length;
  const activeRuns=runs.filter(run=>run.status==='running');
  const successRate=terminalRuns.length?Math.round((completedRuns/terminalRuns.length)*100):0;
  const verifiedRequirements=requirements.filter(req=>req.status==='verified').length;
  const requirementRate=requirements.length?Math.round((verifiedRequirements/requirements.length)*100):0;
  const knownCost=runs.reduce((sum,run)=>sum+Number(run.known_cost_usd||0),0);
  const accountedCost=runs.reduce((sum,run)=>sum+Number(run.budget_accounted_usd??run.spent_usd??0),0);
  const unknownCostCalls=runs.reduce((sum,run)=>sum+Number(run.unknown_cost_calls||0),0);
  if(!isOpen)return null;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-3 backdrop-blur-sm md:p-5"><div className="flex max-h-[92vh] w-full max-w-7xl flex-col overflow-hidden rounded-2xl border border-slate-700/80 bg-slate-950 shadow-2xl">
    <header className="shrink-0 border-b border-slate-800 bg-slate-950/95 px-4 py-4 backdrop-blur md:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="flex items-center gap-2 text-lg font-semibold text-white"><Bot size={20} className="text-cyan-400"/>Central de Agentes</h2><p className="mt-1 text-xs text-slate-400">O PROGRAM-IA coordena SCOUT, STUDIO, FORGE, SENTINEL e SHIP como uma única IA operacional.</p></div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-slate-800 bg-slate-900 p-0.5 text-[10px]"><button onClick={()=>setDetailMode('basic')} className={'rounded-md px-2.5 py-1.5 '+(detailMode==='basic'?'bg-slate-700 text-white':'text-slate-500 hover:text-slate-300')}>Básico</button><button onClick={()=>setDetailMode('advanced')} className={'rounded-md px-2.5 py-1.5 '+(detailMode==='advanced'?'bg-cyan-950 text-cyan-200':'text-slate-500 hover:text-slate-300')}>Avançado</button></div>
          <button onClick={()=>load().catch(()=>{})} title="Atualizar" className="rounded-lg border border-slate-800 p-2 text-slate-400 hover:bg-slate-900 hover:text-white"><RefreshCcw size={15} className={refreshing?'animate-spin':''}/></button>
          <button onClick={onClose} title="Fechar" className="rounded-lg p-2 text-slate-400 hover:bg-slate-900 hover:text-white"><X size={18}/></button>
        </div>
      </div>
      <nav className="mt-4 flex gap-1 overflow-x-auto" aria-label="Seções da Central de Agentes">
        {([
          ['overview','Visão geral',Gauge],['runs','Execuções',Activity],['requirements','Requisitos',ListChecks],['routing','Modelos & Roteamento',Network]
        ] as [TabKey,string,React.ComponentType<{size?:number}>][]).map(([key,label,Icon])=><button key={key} onClick={()=>setTab(key)} aria-selected={tab===key} className={'flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-[11px] font-medium '+(tab===key?'bg-cyan-950/70 text-cyan-200 ring-1 ring-cyan-900':'text-slate-500 hover:bg-slate-900 hover:text-slate-300')}><Icon size={13}/>{label}</button>)}
      </nav>
    </header>
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 md:p-6">
      {error&&<div className="flex items-start gap-2 rounded-xl border border-rose-900/60 bg-rose-950/25 px-3 py-2.5 text-xs text-rose-200"><AlertTriangle size={14} className="mt-0.5 shrink-0"/><span>{error}</span></div>}
      {tab==='overview'&&<>
      {engineEnabled===false&&<section className="rounded-xl border border-amber-800/60 bg-amber-950/30 px-4 py-3 text-xs text-amber-200">O Agent Engine está configurado, mas desativado neste runtime. Os perfis podem ser preparados aqui sem executar orquestração multiagente até <span className="font-mono">AGENT_ENGINE_ENABLED=true</span>.</section>}
      {engineEnabled===true&&<section className="rounded-xl border border-emerald-800/60 bg-emerald-950/25 px-4 py-3 text-xs text-emerald-200">Agent Engine ativo neste runtime. Roteamento por perfil, telemetria e limites de custo estão habilitados.</section>}
      </>}
      {tab==='overview'&&<>
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-slate-800 bg-slate-900/55 p-3.5"><div className="flex items-center gap-2 text-[9px] uppercase tracking-wider text-slate-500"><Activity size={13} className="text-cyan-300"/>Execuções ativas</div><div className="mt-3 text-xl font-semibold text-slate-100">{activeRuns.length}</div><div className="mt-1 text-[10px] text-slate-500">{runs.length} execução(ões) carregada(s)</div></div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/55 p-3.5"><div className="flex items-center gap-2 text-[9px] uppercase tracking-wider text-slate-500"><CheckCircle2 size={13} className="text-emerald-300"/>Taxa de conclusão</div><div className="mt-3 text-xl font-semibold text-slate-100">{successRate}%</div><div className="mt-1 text-[10px] text-slate-500">{completedRuns} concluída(s) · {failedRuns} falha(s)/interrupção(ões)</div></div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/55 p-3.5"><div className="flex items-center gap-2 text-[9px] uppercase tracking-wider text-slate-500"><ListChecks size={13} className="text-amber-300"/>Requisitos verificados</div><div className="mt-3 text-xl font-semibold text-slate-100">{requirementRate}%</div><div className="mt-1 text-[10px] text-slate-500">{verifiedRequirements} de {requirements.length} requisito(s)</div></div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/55 p-3.5"><div className="flex items-center gap-2 text-[9px] uppercase tracking-wider text-slate-500"><CircleDollarSign size={13} className="text-cyan-300"/>Orçamento contabilizado</div><div className="mt-3 text-xl font-semibold text-slate-100">US$ {accountedCost.toFixed(3)}</div><div className="mt-1 text-[10px] text-slate-500">US$ {knownCost.toFixed(3)} confirmado{unknownCostCalls?' · '+unknownCostCalls+' sem preço':''}</div></div>
      </section>
      <section><h3 className="mb-3 text-xs uppercase tracking-wider text-slate-500">Equipe interna</h3><div className="grid grid-cols-2 lg:grid-cols-5 gap-3">{agents.map(a=><div key={a.key} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3"><div className="font-semibold text-slate-100">{a.key}</div><div className="text-[11px] text-slate-400 mt-1">{a.label}</div><div className="mt-3 text-[10px] text-cyan-300">{a.profile}</div><div className="text-[10px] text-slate-400 mt-1">{a.metrics.executions||0} execuções · {a.metrics.calls||0} chamadas IA</div><div className="text-[10px] text-slate-500 mt-0.5">{a.metrics.successes||0} OK · US$ {Number(a.metrics.cost_usd||0).toFixed(3)} confirmado{Number(a.metrics.unknown_cost_calls||0)>0?` · ${Number(a.metrics.unknown_cost_calls)} sem custo informado`:''}</div></div>)}</div></section>
      </>}
      {tab==='runs'&&<section><div className="flex flex-wrap items-center justify-between gap-3 mb-3"><div className="flex items-center gap-2"><Activity size={15} className="text-cyan-400"/><div><h3 className="text-sm font-semibold text-slate-100">Execuções</h3><p className="text-[10px] text-slate-500 mt-0.5">Timeline, falha exata, retries, escalamentos, custo e retomada segura.</p></div></div><div className="flex rounded-lg border border-slate-800 bg-slate-900 p-0.5 text-[9px]">{(['all','running','failed','completed'] as RunFilter[]).map(filter=><button key={filter} onClick={()=>setRunFilter(filter)} className={'rounded-md px-2 py-1.5 '+(runFilter===filter?'bg-slate-700 text-white':'text-slate-500')}>{filter==='all'?'Todas':filter==='running'?'Ativas':filter==='failed'?'Falhas':'Concluídas'}</button>)}</div></div><div className="space-y-3">{runs.filter(run=>runFilter==='all'||(runFilter==='failed'?['failed','aborted'].includes(run.status):run.status===runFilter)).slice(0,20).map(run=><div key={run.id} className="rounded-xl border border-slate-800 bg-slate-900/50 p-3"><div className="flex flex-wrap items-center justify-between gap-2 text-[10px]"><div className="font-mono text-slate-300">{run.mode?.toUpperCase()} · <span className={run.status==='completed'?'text-emerald-400':run.status==='failed'?'text-rose-400':run.status==='waiting_approval'?'text-amber-400':run.status==='aborted'?'text-slate-400':'text-cyan-400'}>{run.status}</span><span className="ml-2 text-slate-600">· {new Date(run.created_at).toLocaleString('pt-BR')} · {run.id.slice(-8)}</span></div><div className="flex items-center gap-2"><span className="text-slate-500">custo confirmado US$ {Number(run.known_cost_usd||0).toFixed(3)} · orçamento consumido US$ {Number(run.budget_accounted_usd ?? run.spent_usd ?? 0).toFixed(3)} / US$ {Number(run.budget_usd||0).toFixed(2)}{Number(run.unknown_cost_calls||0)>0?` · ${Number(run.unknown_cost_calls)} sem preço`:''}</span>{run.status==='running'&&<button onClick={()=>cancelRun(run)} className="inline-flex items-center gap-1 rounded border border-rose-900/70 bg-rose-950/30 px-2 py-1 text-rose-300 hover:bg-rose-950/60"><StopCircle size={11}/>Cancelar</button>}{(['failed','aborted'].includes(run.status)&&['build','auto'].includes(run.mode)&&run.trace?.some(step=>step.agent_key==='SCOUT'&&step.status==='completed'))&&<button onClick={()=>continueRun(run)} className="inline-flex items-center gap-1 rounded border border-cyan-900/70 bg-cyan-950/30 px-2 py-1 text-cyan-300 hover:bg-cyan-950/60"><Route size={11}/>Continuar do progresso salvo</button>}</div></div>
        <div className="mt-2 rounded-md border border-slate-800 bg-slate-950/70 px-2.5 py-2 text-[10px]">
          <span className="text-slate-600">{runFailure(run)?'Ponto da falha':'Etapa atual/final'} · </span>
          <span className={runFailure(run)?'text-rose-300':'text-slate-300'}>{stageLabel((runFailure(run)||runLatest(run))?.stage)}</span>
          {(runFailure(run)?.error||runFailure(run)?.reason)&&<span className="text-rose-400"> · {runFailure(run)?.error||runFailure(run)?.reason}</span>}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">{(run.trace||[]).map(step=>{const stageEvents=(step.context?.events||[]).filter(event=>event.type==='agent_stage');return <div key={step.id} className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1.5 text-[10px]"><div className="flex items-center gap-1.5"><span className="font-semibold text-cyan-300">{step.agent_key}</span><span className="text-slate-500">{step.status}</span>{step.attempt_count>0&&<span className="text-slate-600">· {step.attempt_count} tent.</span>}</div><div className="text-slate-500 mt-0.5 max-w-56 truncate">{step.title}</div>{detailMode==='advanced'&&(step.invocations||[]).map(inv=><div key={inv.id} className="mt-1 border-t border-slate-800 pt-1 text-slate-400"><span className={inv.status==='success'?'text-emerald-400':'text-rose-400'}>{inv.status}</span> · {inv.profile_key} · {inv.provider_key}/{inv.model_id} · {inv.latency_ms}ms · {invocationCostLabel(inv)}{inv.error_code?` · ${inv.error_code}`:''}</div>)}{detailMode==='advanced'&&stageEvents.length>0&&<details className="mt-1.5 border-t border-slate-800 pt-1.5"><summary className="cursor-pointer select-none text-cyan-400 hover:text-cyan-300">Diagnóstico · {stageEvents.length} etapas</summary><div className="mt-1.5 max-h-64 space-y-1 overflow-auto pr-1">{stageEvents.map((event,index)=><div key={`${event.stage||'stage'}-${event.at||index}-${index}`} className="rounded border border-slate-800/80 bg-slate-900/70 px-2 py-1.5"><div className="flex items-start justify-between gap-2"><span className="text-slate-300">{stageLabel(event.stage)}</span><span className={`shrink-0 font-mono ${stageTone(event.status)}`}>{event.status||'info'}</span></div><div className="mt-0.5 text-[9px] text-slate-500">{event.providerKey&&<span>{event.providerKey}{event.modelId?`/${event.modelId}`:''}</span>}{typeof event.latencyMs==='number'&&<span> · {event.latencyMs}ms</span>}{typeof event.targetCount==='number'&&<span> · {event.targetCount} arquivo(s)</span>}{typeof event.requirementCount==='number'&&<span> · {event.requirementCount} requisito(s)</span>}{typeof event.taskCount==='number'&&<span> · {event.taskCount} tarefa(s)</span>}{event.nextStrategy&&<span> · próximo: {event.nextStrategy}</span>}{event.reason&&<span> · {event.reason}</span>}</div>{event.error&&<div className="mt-1 break-words text-[9px] text-rose-300">{event.error}</div>}</div>)}</div></details>}</div>})}</div></div>)}{runs.filter(run=>runFilter==='all'||(runFilter==='failed'?['failed','aborted'].includes(run.status):run.status===runFilter)).length===0&&<div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 text-xs text-slate-500">Nenhuma execução corresponde ao filtro atual.</div>}</div><div className="mt-3 rounded-lg border border-slate-800 bg-slate-900/35 px-3 py-2 text-[9px] text-slate-600">“Continuar do progresso salvo” só aparece quando o backend consegue retomar sem repetir etapas já concluídas. A Central não simula retry localizado.</div></section>}
      {tab==='requirements'&&!projectId&&<section className="rounded-xl border border-amber-900/60 bg-amber-950/20 p-4 text-xs text-amber-200">Abra um projeto para visualizar o Requirement Ledger correspondente.</section>}
      {tab==='requirements'&&projectId&&<section>
        <div className="flex items-center gap-2 mb-3"><Activity size={15} className="text-amber-400"/><h3 className="text-sm font-semibold text-slate-100">Requirement Ledger</h3><span className="text-[10px] text-slate-500">{requirements.length} requisito(s)</span></div>
        {requirements.length===0?<div className="text-xs text-slate-500">Nenhum requisito estruturado registrado para este projeto ainda.</div>:<div className="grid md:grid-cols-2 gap-2">{requirements.slice(-20).map(req=><div key={req.id} className="rounded-lg border border-slate-800 bg-slate-900/50 p-2.5">
          <div className="flex items-center justify-between gap-2"><span className="font-mono text-[9px] text-cyan-400">{req.requirement_key}</span><span className={`text-[9px] uppercase ${req.status==='verified'?'text-emerald-400':req.status==='failed'?'text-rose-400':req.status==='implemented'?'text-amber-400':'text-slate-500'}`}>{req.status}</span></div>
          <div className="mt-1 text-[11px] font-medium text-slate-200">{req.title}</div>
          <div className="mt-1 text-[9px] text-slate-500">{req.priority}{req.files?.length?` · ${req.files.length} arquivo(s)`:''}{req.evidence?.length?` · ${req.evidence.length} evidência(s)`:''}</div>
          {detailMode==='advanced'&&(req.verification||[]).length>0&&<div className="mt-2 border-t border-slate-800 pt-2"><div className="mb-1 text-[8px] uppercase tracking-wider text-slate-600">Verificação</div>{req.verification.map((item,index)=><div key={index} className="text-[9px] text-slate-400">• {item}</div>)}</div>}
        </div>)}</div>}
      </section>}
      {tab==='routing'&&<>
      <section><div className="flex items-center gap-2 mb-3"><Network size={15} className="text-emerald-400"/><div><h3 className="text-sm font-semibold text-slate-100">Modelos & Roteamento</h3><p className="mt-0.5 text-[10px] text-slate-500">Agentes fixos; modelos substituíveis por perfil, disponibilidade e custo.</p></div></div><div className="grid lg:grid-cols-3 gap-3">{profiles.map(p=><div key={p.id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4"><div className="flex justify-between"><div><div className="font-semibold text-slate-100">{p.name}</div><div className="text-[10px] font-mono text-slate-500">{p.profile_key}</div></div><div className="text-[10px] text-slate-400">até ${p.max_cost_usd}</div></div><div className="mt-3 space-y-2">{p.candidates.map((c,i)=><div key={c.id} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950 p-2"><button onClick={()=>mutate(`/api/model-candidates/${c.id}`,'PATCH',{priority:Math.max(0,c.priority-1)}).catch(e=>setError(e.message))} title="Subir"><ArrowUp size={12}/></button><button onClick={()=>mutate(`/api/model-candidates/${c.id}`,'PATCH',{priority:c.priority+1}).catch(e=>setError(e.message))} title="Descer"><ArrowDown size={12}/></button><div className="min-w-0 flex-1"><div className="truncate text-[11px] text-slate-200">{c.provider_key} · {c.model_id}</div><div className="text-[9px] text-slate-500">#{i+1} · {c.health_state}</div></div><button onClick={()=>mutate(`/api/model-candidates/${c.id}`,'PATCH',{enabled:!c.enabled}).catch(e=>setError(e.message))} className={`text-[9px] px-1.5 py-1 rounded ${c.enabled?'text-emerald-300 bg-emerald-950':'text-slate-400 bg-slate-800'}`}>{c.enabled?'ativo':'pausado'}</button><button onClick={()=>mutate(`/api/model-candidates/${c.id}`,'DELETE').catch(e=>setError(e.message))}><Trash2 size={12} className="text-rose-400"/></button></div>)}</div></div>)}</div></section>
      <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"><h3 className="text-sm font-semibold text-slate-100 mb-3 flex items-center gap-2"><Plus size={14}/>Adicionar modelo ao perfil</h3><div className="grid sm:grid-cols-4 gap-2"><select value={profileKey} onChange={e=>setProfileKey(e.target.value)} className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs">{profiles.map(p=><option key={p.id} value={p.profile_key}>{p.name}</option>)}</select><input value={providerKey} onChange={e=>setProviderKey(e.target.value)} placeholder="provedor" className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs"/><input value={modelId} onChange={e=>setModelId(e.target.value)} placeholder="modelo" className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs"/><button onClick={()=>mutate(`/api/model-profiles/${profileKey}/candidates`,'PUT',{providerKey,modelId,priority:99}).catch(e=>setError(e.message))} className="rounded-lg bg-cyan-500 text-slate-950 text-xs font-semibold">Adicionar</button></div>{error&&<p className="mt-3 text-xs text-rose-300">{error}</p>}</section>
      </>}
    </div></div></div>
}

