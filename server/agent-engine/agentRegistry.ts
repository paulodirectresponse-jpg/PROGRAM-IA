export type AgentKey='SCOUT'|'STUDIO'|'FORGE'|'SENTINEL'|'SHIP';
export const AGENTS:Record<AgentKey,{role:string;defaultProfile:'BASE_FREE';escalationProfile:'EXPERT_PAID';tools:string[]}>= {
 SCOUT:{role:'Mapear contexto e produzir plano',defaultProfile:'BASE_FREE',escalationProfile:'EXPERT_PAID',tools:['read','search']},
 STUDIO:{role:'Definir direção e critérios de interface',defaultProfile:'BASE_FREE',escalationProfile:'EXPERT_PAID',tools:['read','preview']},
 FORGE:{role:'Propor alterações de código',defaultProfile:'BASE_FREE',escalationProfile:'EXPERT_PAID',tools:['read','propose']},
 SENTINEL:{role:'Interpretar evidências e corrigir falhas',defaultProfile:'BASE_FREE',escalationProfile:'EXPERT_PAID',tools:['read','validate','propose']},
 SHIP:{role:'Preparar publicação solicitada',defaultProfile:'BASE_FREE',escalationProfile:'EXPERT_PAID',tools:['github','integrations']},
};
export function selectAgent(mode:string,prompt:string):AgentKey{if(mode==='plan')return'SCOUT';if(mode==='review')return'SENTINEL';if(mode==='publish')return'SHIP';if(/interface|layout|design|tela|css|responsiv/i.test(prompt))return'STUDIO';return'FORGE';}

