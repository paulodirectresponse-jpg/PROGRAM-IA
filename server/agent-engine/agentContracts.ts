export type AgentKey='SCOUT'|'STUDIO'|'FORGE'|'SENTINEL'|'SHIP';

export interface AgentContract {
  key:AgentKey;
  mission:string;
  requiredInputs:string[];
  requiredOutputs:string[];
  allowedTools:string[];
  doneWhen:string[];
}

export const AGENT_CONTRACTS:Record<AgentKey,AgentContract>={
  SCOUT:{
    key:'SCOUT',
    mission:'Entender a solicitação e transformar o estado do projeto em arquitetura, requisitos e tarefas verificáveis.',
    requiredInputs:['user_intent','project_state','existing_architecture','constraints'],
    requiredOutputs:['objective','architecture_summary','routes','modules','file_plan','requirements','task_graph','risks','verification_plan'],
    allowedTools:['read','search'],
    doneWhen:[
      'objetivo inequívoco',
      'requisitos identificados',
      'tarefas com dependências',
      'páginas/rotas calculadas pela necessidade real do produto',
      'file_plan contém caminhos concretos suficientes para a arquitetura',
      'arquitetura não limitada pelos arquivos existentes',
      'sistema não trivial não está comprimido artificialmente em um único arquivo',
    ],
  },
  STUDIO:{
    key:'STUDIO',
    mission:'Definir critérios de interface e interação que o FORGE deve implementar e que o Browser Agent poderá verificar.',
    requiredInputs:['visual_requirements','architecture_summary','relevant_ui_state'],
    requiredOutputs:['design_contract','navigation_contract','responsive_rules','interaction_requirements','state_requirements','visual_acceptance_criteria'],
    allowedTools:['read','preview'],
    doneWhen:[
      'critérios visuais objetivos',
      'mobile e desktop considerados',
      'navegação entre rotas/telas definida',
      'estados/interações descritos',
      'controles visíveis possuem comportamento ou estado previsto',
    ],
  },
  FORGE:{
    key:'FORGE',
    mission:'Implementar tarefas concretas preservando arquitetura, requisitos e compatibilidade do workspace.',
    requiredInputs:['task','requirements','architecture','relevant_context','prior_evidence'],
    requiredOutputs:['code_changes','requirement_progress','implementation_evidence'],
    allowedTools:['read','search','propose'],
    doneWhen:['alteração concreta produzida','requisitos associados atualizados','nenhum sucesso falso'],
  },
  SENTINEL:{
    key:'SENTINEL',
    mission:'Comparar a implementação com requisitos e evidências, localizar causas de falha e produzir repair tasks objetivas.',
    requiredInputs:['requirements','diff','technical_evidence','runtime_evidence'],
    requiredOutputs:['requirement_results','root_causes','repair_tasks'],
    allowedTools:['read','validate','propose'],
    doneWhen:['cada falha possui evidência','repair é localizado','unverified não é tratado como verified'],
  },
  SHIP:{
    key:'SHIP',
    mission:'Preparar e executar publicação somente após os gates obrigatórios.',
    requiredInputs:['validated_artifact','release_request','release_evidence'],
    requiredOutputs:['release_action','release_evidence'],
    allowedTools:['github','integrations'],
    doneWhen:['release solicitada','gates satisfeitos','resultado rastreável'],
  },
};

export function contractPrompt(key:AgentKey){
  const c=AGENT_CONTRACTS[key];
  return [
    `PAPEL INTERNO: ${c.key}`,
    `MISSÃO: ${c.mission}`,
    `ENTRADAS OBRIGATÓRIAS: ${c.requiredInputs.join(', ')}`,
    `SAÍDAS OBRIGATÓRIAS: ${c.requiredOutputs.join(', ')}`,
    `FERRAMENTAS PERMITIDAS: ${c.allowedTools.join(', ')}`,
    'DEFINIÇÃO DE DONE:',
    ...c.doneWhen.map(item=>'- '+item),
  ].join('\n');
}
