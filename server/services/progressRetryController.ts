import crypto from 'node:crypto';

export type RetryFailureKind='operational'|'incompatible'|'capacity'|'aborted'|'unknown';

export interface AttemptEvidence {
  failureKind:RetryFailureKind;
  errorMessage:string;
  strategy:string;
  outputFingerprint?:string;
  diffFingerprint?:string;
  progressMarkers?:string[];
}

export interface RetryDecision {
  retryAllowed:boolean;
  escalateAllowed:boolean;
  nextStrategy:'same_candidate'|'next_candidate'|'reduce_context'|'fragment_task'|'expert'|'stop';
  reason:string;
  signature:string;
}

export class ProgressRetryController {
  static signature(evidence:AttemptEvidence){
    return crypto.createHash('sha256').update(JSON.stringify({
      failureKind:evidence.failureKind,
      errorMessage:String(evidence.errorMessage||'').replace(/\d+/g,'#').slice(0,500),
      strategy:evidence.strategy,
      outputFingerprint:evidence.outputFingerprint||'',
      diffFingerprint:evidence.diffFingerprint||'',
    })).digest('hex').slice(0,20);
  }

  static decide(current:AttemptEvidence,history:AttemptEvidence[],input:{attempt:number;maxAttempts:number;hasNextCandidate:boolean;canEscalate:boolean}):RetryDecision{
    const signature=this.signature(current);
    const same=history.filter(item=>this.signature(item)===signature).length;
    if(current.failureKind==='aborted')return{retryAllowed:false,escalateAllowed:false,nextStrategy:'stop',reason:'cancelamento explícito',signature};
    if(same>=1){
      if(input.hasNextCandidate)return{retryAllowed:true,escalateAllowed:false,nextStrategy:'next_candidate',reason:'mesma falha não deve repetir no mesmo candidate',signature};
      if(input.canEscalate)return{retryAllowed:false,escalateAllowed:true,nextStrategy:'expert',reason:'mesma falha repetida sem progresso no BASE_FREE',signature};
      return{retryAllowed:false,escalateAllowed:false,nextStrategy:'stop',reason:'no-progress: erro/estratégia repetidos',signature};
    }
    if(input.attempt>=input.maxAttempts){
      return input.canEscalate
        ? {retryAllowed:false,escalateAllowed:true,nextStrategy:'expert',reason:'orçamento de tentativas BASE_FREE esgotado',signature}
        : {retryAllowed:false,escalateAllowed:false,nextStrategy:'stop',reason:'orçamento de tentativas esgotado',signature};
    }
    if(current.failureKind==='operational'){
      return{retryAllowed:true,escalateAllowed:false,nextStrategy:input.hasNextCandidate?'next_candidate':'reduce_context',reason:'falha operacional: repetir somente com mudança de estratégia/candidate',signature};
    }
    if(current.failureKind==='incompatible'){
      return{retryAllowed:true,escalateAllowed:false,nextStrategy:'fragment_task',reason:'resposta incompatível: reduzir unidade de trabalho',signature};
    }
    return{retryAllowed:true,escalateAllowed:false,nextStrategy:input.hasNextCandidate?'next_candidate':'reduce_context',reason:'nova falha ainda não repetida',signature};
  }
}
