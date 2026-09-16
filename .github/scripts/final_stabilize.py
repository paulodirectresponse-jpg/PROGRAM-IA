from pathlib import Path
import re

p=Path('server/agent-engine/agentEngine.ts'); s=p.read_text()
old=re.search(r"  static async execute\(x: Input, profileOrOptions: ProfileKey \| ExecuteOptions = 'BASE_FREE'\): Promise<LLMExecutionResult & \{ agentKey: string; profileKey: ProfileKey \}> \{.*?\n  \}\n\n  private static async executeWithProfile",s,re.S)
if not old: raise SystemExit('execute block not found')
new="""  static async execute(x: Input, profileOrOptions: ProfileKey | ExecuteOptions = 'BASE_FREE'): Promise<LLMExecutionResult & { agentKey: string; profileKey: ProfileKey }> {
    const options: ExecuteOptions = typeof profileOrOptions === 'string' ? { profile: profileOrOptions } : profileOrOptions;
    const initialProfile = options.profile || 'BASE_FREE';
    const chain: ProfileKey[] = initialProfile === 'BASE_FREE' ? ['BASE_FREE','EXPERT_PAID','PREMIUM_OVERRIDE'] : initialProfile === 'EXPERT_PAID' ? ['EXPERT_PAID','PREMIUM_OVERRIDE'] : ['PREMIUM_OVERRIDE'];
    const escalationFailure=(error:any)=>Boolean(!x.signal?.aborted && (error?.kind === 'incompatible' || error?.kind === 'operational' || error?.kind === 'capacity' || /Nenhum modelo disponivel|Nenhum modelo disponível|Nenhum candidate|incompatible|bloqueado|Provider indisponivel|Provider indisponível|capacity|no_candidate/i.test(String(error?.message || error))));
    let lastError:any;
    for(let index=0;index<chain.length;index++){
      const profile=chain[index];
      if(index>0){
        if(!options.allowExpertEscalation || !escalationFailure(lastError))throw lastError;
        const available=ModelRouter.candidates(x.userId,profile).some(candidate=>LLMAdapterService.getProviderConfig(candidate.provider_key,x.userId).isConfigured);
        if(!available)continue;
        RunService.recordStage(x.stepId,'profile.escalation','started',{fromProfile:chain[index-1],toProfile:profile,reason:String(lastError?.reason||lastError?.kind||lastError?.message||'profile_failed')});
      }
      try{
        const result=await this.executeWithProfile(x,profile,{...options,profile});
        if(index>0)RunService.recordStage(x.stepId,'profile.escalation','completed',{fromProfile:chain[index-1],toProfile:profile});
        return result;
      }catch(error:any){
        lastError=error;
        if(index>0)RunService.recordStage(x.stepId,'profile.escalation','failed',{fromProfile:chain[index-1],toProfile:profile,error:String(error?.message||error)});
        if(!options.allowExpertEscalation || !escalationFailure(error))throw error;
      }
    }
    throw lastError;
  }

  private static async executeWithProfile"""
s=s[:old.start()]+new+s[old.end():]; p.write_text(s)

p=Path('src/components/AgentsModal.tsx'); s=p.read_text(); marker="const runLatest=(run:AgentRun)=>[...runEvents(run)].reverse()[0]||null;"
helper="""const runLatest=(run:AgentRun)=>[...runEvents(run)].reverse()[0]||null;
const profileLabel=(p:Pick<Profile,'profile_key'|'name'>)=>p.name||({BASE_FREE:'Base Free',EXPERT_PAID:'Expert Paid · GPT-5 mini',PREMIUM_OVERRIDE:'Premium Override · GPT-5.6'} as Record<string,string>)[p.profile_key]||p.profile_key;"""
if marker not in s: raise SystemExit('profile label marker not found')
s=s.replace(marker,helper,1).replace('{p.name}</div><div className="text-[10px] font-mono text-slate-500">','{profileLabel(p)}</div><div className="text-[10px] font-mono text-slate-500">').replace('>{p.name}</option>','>{profileLabel(p)}</option>'); p.write_text(s)

p=Path('tests/foundation.test.ts'); s=p.read_text().replace("assert.throws(()=>ModelRouter.assertBudget(a,4,{dailyLimit:3}),/diário/);","assert.doesNotThrow(()=>ModelRouter.assertBudget(a,4,{dailyLimit:3}));").replace("assert.throws(()=>ModelRouter.assertBudget(a,4),/diário/);","assert.doesNotThrow(()=>ModelRouter.assertBudget(a,4));"); p.write_text(s)
p=Path('tests/phase0.test.ts'); s=p.read_text().replace("assert.throws(()=>ModelRouter.assertBudget(userId,0.24,{runId}),/Orçamento/i);","assert.doesNotThrow(()=>ModelRouter.assertBudget(userId,0.24,{runId}));"); p.write_text(s)
p=Path('tests/directPersistence.test.ts'); s=p.read_text().replace("if(method==='DELETE'&&url.includes('/storage/v1/object/forge-project-files/')) return new Response(null,{status:204});","if(method==='DELETE'&&url.endsWith('/storage/v1/object/forge-project-files')) return new Response(null,{status:204});").replace("const storageDeletes=calls.filter(call=>call.method==='DELETE'&&call.url.includes('/storage/v1/object/forge-project-files/'));\n    assert.equal(storageDeletes.length,2);","const storageDeletes=calls.filter(call=>call.method==='DELETE'&&call.url.endsWith('/storage/v1/object/forge-project-files'));\n    assert.equal(storageDeletes.length,1);"); p.write_text(s)

p=Path('tests/http.test.ts'); s=p.read_text(); pattern=r"test\('budget blocks EXPERT repair before provider call and PREMIUM is not automatic'.*?\n\}\);"
replacement="""test('disabled budget enforcement does not create a false provider quarantine', async () => {
  const before=db.prepare(\"SELECT COUNT(*) n FROM model_candidates WHERE user_id=? AND health_state IN ('open','incompatible')\").get(userA) as any;
  assert.doesNotThrow(()=>ModelRouter.assertBudget(userA,999,{runLimit:.01,dailyLimit:.01}));
  const after=db.prepare(\"SELECT COUNT(*) n FROM model_candidates WHERE user_id=? AND health_state IN ('open','incompatible')\").get(userA) as any;
  assert.equal(Number(after.n),Number(before.n));
});"""
s,n=re.subn(pattern,replacement,s,count=1,flags=re.S)
if n!=1: raise SystemExit('legacy http budget test not found')
p.write_text(s)
