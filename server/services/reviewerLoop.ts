export interface ReviewVerdict { approved: boolean; issues: string[] }
export interface ReviewEvent { iteration:number; stage:'validate'|'review'|'repair'; details:string }

/** No workspace writes here. A rejected or interrupted candidate is never applied. */
export async function reviewUntilAccepted<T>(options:{
  initial:T;
  validate:(candidate:T)=>string[];
  review:(candidate:T,signal:AbortSignal)=>Promise<ReviewVerdict>;
  repair:(candidate:T,issues:string[],signal:AbortSignal)=>Promise<T>;
  signal?:AbortSignal;
  maxIterations?:number;
  timeoutMs?:number;
}):Promise<{candidate:T; events:ReviewEvent[]}> {
  const limit=Math.max(1,Math.min(options.maxIterations||3,5));
  const deadline=AbortSignal.timeout(Math.max(1000,Math.min(options.timeoutMs||120000,300000)));
  const signal=options.signal?AbortSignal.any([deadline,options.signal]):deadline;
  const events:ReviewEvent[]=[];
  async function interruptible<R>(operation:Promise<R>):Promise<R> {
    signal.throwIfAborted();
    return new Promise<R>((resolve,reject)=>{
      const abort=()=>reject(signal.reason);
      signal.addEventListener('abort',abort,{once:true});
      operation.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    });
  }
  let candidate=options.initial;
  for(let iteration=1;iteration<=limit;iteration++) {
    signal.throwIfAborted();
    let issues=options.validate(candidate);
    events.push({iteration,stage:'validate',details:issues.length?issues.join('\n'):'Validação estrutural aprovada.'});
    if(!issues.length) {
      const verdict=await interruptible(options.review(candidate,signal));
      if(typeof verdict?.approved!=='boolean'||!Array.isArray(verdict.issues)||!verdict.issues.every(i=>typeof i==='string')) throw new Error('O revisor retornou um parecer inválido. Nenhum arquivo foi aplicado.');
      events.push({iteration,stage:'review',details:verdict.approved?'Revisão de código aprovada.':verdict.issues.join('\n')});
      if(verdict.approved&&verdict.issues.length===0) return {candidate,events};
      issues=verdict.issues.length?verdict.issues:['O revisor não aprovou a alteração.'];
    }
    if(iteration===limit) throw new Error(`Revisão não aprovada após ${limit} tentativas: ${issues.join('; ')}. Nenhum arquivo foi aplicado.`);
    events.push({iteration,stage:'repair',details:'Programador corrigindo os problemas encontrados.'});
    candidate=await interruptible(options.repair(candidate,issues,signal));
  }
  throw new Error('Revisão interrompida.');
}
