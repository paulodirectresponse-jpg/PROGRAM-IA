import React from 'react';
import { AlertTriangle, Boxes, Check, CheckCircle2, FileCode2, GitBranch, Plus, Sparkles, Trash2 } from 'lucide-react';

type Requirement={id:string;title:string;description?:string;priority?:string;verification:string[]};
type PlanTask={id:string;title:string;requirementIds:string[];dependsOn:string[]};
type PresentablePlan = {
  objective:string;
  architecture:string;
  scopeIn:string[];
  scopeOut:string[];
  existingFiles:string[];
  newFiles:string[];
  deleteFiles:string[];
  files:string[];
  integrations:string[];
  risks:string[];
  acceptance:string[];
  requirements:Requirement[];
  tasks:PlanTask[];
};

const asList=(value:unknown):string[]=>{
  if(value==null)return[];
  if(Array.isArray(value))return value.flatMap(asList).map(v=>v.trim()).filter(Boolean);
  if(typeof value==='object'){
    return Object.entries(value as Record<string,unknown>).map(([key,nested])=>{
      const parts=asList(nested);return parts.length?key+': '+parts.join(', '):key;
    }).filter(Boolean);
  }
  const text=String(value).trim();
  if(!text)return[];
  if((text.startsWith('[')&&text.endsWith(']'))||(text.startsWith('{')&&text.endsWith('}'))){
    try{return asList(JSON.parse(text))}catch{}
  }
  return text.split('\n').map(v=>v.replace(/^\s*[-*•]\s*/,'').trim()).filter(Boolean);
};

const parseJsonCandidate=(content:string)=>{
  const raw=String(content||'').trim();
  if(!raw)return null;
  const fenced=raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const first=raw.indexOf('{'),last=raw.lastIndexOf('}');
  const candidates=[fenced,raw,first>=0&&last>first?raw.slice(first,last+1):''].filter(Boolean) as string[];
  for(const candidate of candidates){try{const value=JSON.parse(candidate);if(value&&typeof value==='object')return value}catch{}}
  return null;
};

export const parsePlanForDisplay=(content:string):PresentablePlan|null=>{
  const parsed:any=parseJsonCandidate(content);
  if(!parsed)return null;
  const root=parsed.plan&&typeof parsed.plan==='object'
    ? parsed.plan
    : parsed.architecture_brief&&typeof parsed.architecture_brief==='object'
      ? parsed.architecture_brief
      : parsed;
  const filePlan=root.file_plan&&typeof root.file_plan==='object'?root.file_plan:{};
  const existingFiles=asList(root.existing_files_to_modify??root.existingFilesToModify??filePlan.modify);
  const newFiles=asList(root.new_files_to_create??root.newFilesToCreate??filePlan.create);
  const deleteFiles=asList(root.files_to_delete??root.filesToDelete??filePlan.delete);
  const legacy=asList(root.files_affected??root.filesAffected??root.arquivos);
  const requirements:Requirement[]=Array.isArray(root.requirements)?root.requirements.map((r:any,index:number)=>({
    id:String(r?.id||`REQ-${String(index+1).padStart(3,'0')}`),
    title:String(r?.title||r?.name||r?.description||`Requisito ${index+1}`),
    description:r?.description?String(r.description):undefined,
    priority:r?.priority?String(r.priority):undefined,
    verification:asList(r?.verification??r?.verification_steps??r?.acceptance_criteria),
  })):[];
  const rawTasks=Array.isArray(root.task_graph)?root.task_graph:Array.isArray(root.tasks)?root.tasks:[];
  const tasks:PlanTask[]=rawTasks.map((t:any,index:number)=>({
    id:String(t?.id||`TASK-${String(index+1).padStart(3,'0')}`),
    title:String(t?.title||t?.name||t?.description||`Tarefa ${index+1}`),
    requirementIds:asList(t?.requirement_ids??t?.requirements),
    dependsOn:asList(t?.depends_on??t?.dependencies),
  })):[];
  const plan:PresentablePlan={
    objective:String(root.objective??root.objetivo??'').trim(),
    architecture:String(root.architecture_summary??root.architecture??'').trim(),
    scopeIn:asList(root.scope_in??root.scopeIn??root.escopo??root.scope),
    scopeOut:asList(root.scope_out??root.scopeOut??root.fora_do_escopo),
    existingFiles,newFiles,deleteFiles,
    files:[...new Set([...existingFiles,...newFiles,...deleteFiles,...legacy])],
    integrations:asList(root.integrations??root.integracoes),
    risks:asList(root.risks??root.riscos),
    acceptance:asList(root.acceptance_criteria??root.acceptanceCriteria??root.criterios_de_aceite),
    requirements,tasks,
  };
  return plan.objective||plan.architecture||plan.files.length||plan.requirements.length||plan.tasks.length?plan:null;
};

const FilePill=({file,kind}:{file:string;kind:'existing'|'new'|'delete'})=>{
  const icon=kind==='new'?<Plus size={10}/>:kind==='delete'?<Trash2 size={10}/>:<FileCode2 size={10}/>;
  const classes=kind==='new'?'border-emerald-900/70 text-emerald-300':kind==='delete'?'border-rose-900/70 text-rose-300':'border-slate-700 text-cyan-300';
  return <span className={`inline-flex items-center gap-1 rounded-md border bg-slate-950 px-1.5 py-1 font-mono text-[10px] ${classes}`}>{icon}{file}</span>;
};

export const PlanResponseCard:React.FC<{content:string}>=({content})=>{
  const plan=parsePlanForDisplay(content);
  if(!plan)return <div>{content}</div>;
  const visibleScope=plan.scopeIn.slice(0,4);
  const extraScope=Math.max(0,plan.scopeIn.length-visibleScope.length);
  return <div className="space-y-2">
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-400"><Sparkles size={12}/>Plano preparado</div>
      {plan.objective&&<div className="text-[13px] font-semibold leading-relaxed text-slate-100">{plan.objective}</div>}
      {visibleScope.length>0&&<div className="space-y-1 pt-1">{visibleScope.map((item,index)=><div key={item+'-'+index} className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-300"><CheckCircle2 size={12} className="mt-0.5 shrink-0 text-emerald-400"/><span>{item}</span></div>)}{extraScope>0&&<div className="pl-5 text-[10px] text-slate-500">+ {extraScope} item(ns) no detalhamento técnico</div>}</div>}
    </div>

    <details className="rounded-xl border border-slate-800/80 bg-slate-950/40 p-2.5">
      <summary className="cursor-pointer select-none text-[10px] font-medium text-slate-500 hover:text-slate-300">Ver detalhes técnicos</summary>
      <div className="mt-3 space-y-3">
        {plan.architecture&&<div>
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-cyan-400"><Boxes size={11}/>Arquitetura</div>
          <div className="text-[11px] leading-relaxed text-slate-400">{plan.architecture}</div>
        </div>}

        {(plan.existingFiles.length>0||plan.newFiles.length>0||plan.deleteFiles.length>0||plan.files.length>0)&&<div className="space-y-2">
          {plan.existingFiles.length>0&&<div><div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600">Modificar</div><div className="flex flex-wrap gap-1">{plan.existingFiles.map(file=><FilePill key={'m-'+file} file={file} kind="existing"/>)}</div></div>}
          {plan.newFiles.length>0&&<div><div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600">Criar</div><div className="flex flex-wrap gap-1">{plan.newFiles.map(file=><FilePill key={'n-'+file} file={file} kind="new"/>)}</div></div>}
          {plan.deleteFiles.length>0&&<div><div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600">Remover</div><div className="flex flex-wrap gap-1">{plan.deleteFiles.map(file=><FilePill key={'d-'+file} file={file} kind="delete"/>)}</div></div>}
          {plan.existingFiles.length===0&&plan.newFiles.length===0&&plan.deleteFiles.length===0&&plan.files.length>0&&<div><div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600">Arquivos previstos</div><div className="flex flex-wrap gap-1">{plan.files.map(file=><FilePill key={file} file={file} kind="existing"/>)}</div></div>}
        </div>}

        {plan.requirements.length>0&&<div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">Requisitos verificáveis</div>
          <div className="space-y-1.5">{plan.requirements.map(req=><div key={req.id} className="rounded-md border border-slate-800 bg-slate-950/60 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2"><span className="font-mono text-[9px] text-cyan-400">{req.id}</span>{req.priority&&<span className="text-[9px] uppercase text-slate-600">{req.priority}</span>}</div>
            <div className="mt-0.5 text-[11px] font-medium text-slate-300">{req.title}</div>
            {req.verification.length>0&&<div className="mt-1 text-[9px] text-slate-600">Prova: {req.verification.join(' · ')}</div>}
          </div>)}</div>
        </div>}

        {plan.tasks.length>0&&<div>
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600"><GitBranch size={11}/>Grafo de tarefas</div>
          <div className="space-y-1">{plan.tasks.map(task=><div key={task.id} className="text-[10px] text-slate-500"><span className="font-mono text-cyan-500">{task.id}</span> · {task.title}{task.dependsOn.length>0&&<span className="text-slate-700"> · depende de {task.dependsOn.join(', ')}</span>}</div>)}</div>
        </div>}

        {plan.integrations.length>0&&<div><div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">Integrações</div><div className="flex flex-wrap gap-1">{plan.integrations.map(item=><span key={item} className="rounded-md border border-blue-900/50 bg-blue-950/20 px-2 py-1 text-[10px] text-blue-300">{item}</span>)}</div></div>}
        {plan.acceptance.length>0&&<div><div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">Critérios de aceite</div><div className="space-y-1">{plan.acceptance.map((item,index)=><div key={item+'-'+index} className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-400"><Check size={11} className="mt-0.5 shrink-0 text-cyan-500"/><span>{item}</span></div>)}</div></div>}
        {plan.risks.length>0&&<div><div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-500"><AlertTriangle size={11}/>Pontos de atenção</div><div className="space-y-1">{plan.risks.map((item,index)=><div key={item+'-'+index} className="text-[10px] leading-relaxed text-amber-200/70">• {item}</div>)}</div></div>}
        {plan.scopeOut.length>0&&<div><div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">Fora do escopo</div><div className="space-y-1">{plan.scopeOut.map((item,index)=><div key={item+'-'+index} className="text-[10px] leading-relaxed text-slate-500">• {item}</div>)}</div></div>}
      </div>
    </details>
  </div>;
};
