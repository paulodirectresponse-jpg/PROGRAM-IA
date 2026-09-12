import React, {useEffect, useState} from 'react';
import {CheckCircle2, Settings2, Loader2, X, Github, Cloud, Database, Flame} from 'lucide-react';
const definitions = [
  {key:'github',name:'GitHub',description:'Repositórios, commits, branches e pull requests.',fields:[['token','Token de acesso (Contents e Pull requests)']]},
  {key:'cloudflare',name:'Cloudflare',description:'Configuração da conta para Pages e domínios.',fields:[['token','API Token (Account Pages e Zone DNS)'],['accountId','Account ID'],['zoneId','Zone ID (opcional, para domínios)']]},
  {key:'supabase',name:'Supabase',description:'Vincule o projeto de banco de dados e armazenamento.',fields:[['token','Personal Access Token de gerenciamento'],['projectRef','Project Ref']]},
  {key:'firebase',name:'Firebase',description:'Projeto Firebase do site que você está construindo. Independente do login no Forge.',fields:[['serviceAccount','JSON da conta de serviço do seu projeto']]},
];
const icons:Record<string,React.ReactNode>={github:<Github size={20}/>,cloudflare:<Cloud size={20}/>,supabase:<Database size={20}/>,firebase:<Flame size={20}/>};
export function IntegrationSettings() {
  const [selected,setSelected]=useState<string|null>(null);
  const [values,setValues]=useState<Record<string,string>>({});
  const [summaries,setSummaries]=useState<any[]>([]);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState<{success:boolean;message:string}|null>(null);
  const refresh=async()=>{const r=await fetch('/api/integrations');if(!r.ok)throw new Error('Não foi possível carregar integrações.');setSummaries((await r.json()).integrations);};
  useEffect(()=>{refresh().catch(e=>setNotice({success:false,message:e.message}));},[]);
  const definition=definitions.find(d=>d.key===selected);
  const run=async(test:boolean)=>{
    setBusy(true);setNotice(null);
    try {
      const saved=await fetch(`/api/integrations/${selected}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({fields:values})});
      const data=await saved.json();if(!saved.ok)throw new Error(data.error);
      setValues(data.fields||{});
      if(test){const r=await fetch(`/api/integrations/${selected}/test`,{method:'POST'});const d=await r.json();if(!r.ok||!d.success)throw new Error(d.error||d.message);setNotice(d);}
      else setNotice({success:true,message:'Configuração salva. Teste para confirmar o acesso.'});
      await refresh();
    }catch(e:any){setNotice({success:false,message:e.message});}finally{setBusy(false);}
  };
  return <div className="space-y-3">
    {definitions.map(d=>{const summary=summaries.find(s=>s.service===d.key);const tested=summary?.status==='connected'||summary?.last_test_success===1;return <div key={d.key} className="rounded-xl border border-slate-700/60 bg-slate-950/60 p-4 flex justify-between gap-4">
      <div className="flex gap-3"><span className="mt-0.5 text-cyan-400">{icons[d.key]}</span><div><h3 className="font-semibold text-slate-100">{d.name}</h3><p className="text-xs text-slate-400 mt-1">{d.description}</p><p className={`text-xs mt-2 ${tested?'text-emerald-400':summary?.configured?'text-amber-400':'text-slate-500'}`}>{tested?'Conectado e testado':summary?.configured?'Salvo, teste pendente':'Não configurado'}</p></div></div>
      <button className="text-cyan-300 flex items-center gap-2 text-xs" onClick={()=>{setSelected(d.key);setValues(summaries.find(s=>s.service===d.key)?.fields||{});setNotice(null);}}><Settings2 size={15}/>Configurar</button>
    </div>})}
    {definition&&<div className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"><section role="dialog" aria-modal="true" aria-label={`Configurar ${definition.name}`} className="w-full max-w-lg rounded-2xl border border-slate-600 bg-slate-900 shadow-2xl p-6 space-y-4">
      <div className="flex justify-between"><h2 className="text-lg font-semibold">Configurar {definition.name}</h2><button disabled={busy} aria-label="Fechar" onClick={()=>{setValues({});setSelected(null);}}><X size={18}/></button></div>
      <p className="text-xs text-slate-400">As credenciais ficam criptografadas no servidor e vinculadas à sua conta. Deixe um segredo vazio para manter o salvo.</p>
      {definition.fields.map(([key,label])=><label key={key} className="block text-xs text-slate-300">{label}{key==='serviceAccount'?<textarea aria-label={label} className="mt-2 w-full bg-slate-950 border border-slate-700 rounded-lg p-3 h-28" value={values[key]||''} onChange={e=>setValues({...values,[key]:e.target.value})}/>:<input autoComplete="off" type={key==='token'?'password':'text'} className="mt-2 w-full bg-slate-950 border border-slate-700 rounded-lg p-3" value={values[key]||''} onChange={e=>setValues({...values,[key]:e.target.value})}/>}</label>)}
      {notice&&<p role="status" className={`text-xs ${notice.success?'text-emerald-400':'text-rose-400'}`}>{notice.message}</p>}
      <div className="flex gap-3"><button disabled={busy} className="px-4 py-2 rounded-lg border border-slate-600 text-sm" onClick={()=>run(false)}>Salvar</button><button disabled={busy} className="px-4 py-2 rounded-lg bg-cyan-600 text-sm flex items-center gap-2" onClick={()=>run(true)}>{busy?<Loader2 size={15} className="animate-spin"/>:<CheckCircle2 size={15}/>}Salvar e testar</button></div>
    </section></div>}
  </div>;
}

