import type { BenchmarkCaseDefinition } from './types.js';

const html=(body:string,extraHead='')=>`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${extraHead}<title>Phase 4 Fixture</title></head><body>${body}</body></html>`;

const manyFiles=(targetContent:string)=>{
  const files:Record<string,string>={};
  for(let i=1;i<=42;i++)files[`src/modules/module-${String(i).padStart(2,'0')}.ts`]=`export const module${i}=()=>${i};\n`;
  files['src/modules/target.ts']=targetContent;
  files['src/main.ts']="import { targetValue } from './modules/target';\nconsole.log(targetValue);\n";
  return files;
};

export const PHASE4_SUITE_KEY='phase4-v1-30';

export const PHASE4_BENCHMARK_CASES:BenchmarkCaseDefinition[]=[
  {
    id:'P4-01',title:'Plan modular from tiny starter',category:'planning',mode:'plan',agentKey:'SCOUT',
    prompt:'Planeje a evolução deste starter para um painel de tarefas com módulos separados de UI, estado e persistência local. Inclua requisitos verificáveis, critérios de aceite e grafo de tarefas.',
    fixtureFiles:{'index.html':html('<div id="app">starter</div>')},
    checks:{minRequirements:3,minTasks:2,minAcceptanceCriteria:3,requiredPlanTerms:['ui','persist']},
  },
  {
    id:'P4-02',title:'Plan existing multi-file feature',category:'planning',mode:'plan',agentKey:'SCOUT',
    prompt:'Planeje adicionar busca por nome sem reescrever a aplicação inteira. Preserve a arquitetura existente e identifique arquivos a modificar.',
    fixtureFiles:{'src/app.ts':'export const users=[{name:"Ana"},{name:"Bruno"}];\n','src/view.ts':'export function render(){return "users";}\n','index.html':html('<main id="app"></main>')},
    checks:{minRequirements:2,minTasks:1,minAcceptanceCriteria:2,requiredPlanTerms:['busca']},
  },
  {
    id:'P4-03',title:'Plan API boundary',category:'planning',mode:'plan',agentKey:'SCOUT',
    prompt:'Planeje uma camada de API para substituir dados hardcoded, mantendo UI desacoplada e tratamento explícito de erro e loading.',
    fixtureFiles:{'src/ui.ts':'export const render=(data:any)=>JSON.stringify(data);\n','src/data.ts':'export const load=()=>[{id:1}];\n'},
    checks:{minRequirements:3,minTasks:2,minAcceptanceCriteria:3,requiredPlanTerms:['erro','api']},
  },
  {
    id:'P4-04',title:'Plan safe auth change',category:'planning',mode:'plan',agentKey:'SCOUT',
    prompt:'Planeje adicionar autenticação por sessão HttpOnly sem armazenar token em localStorage. Inclua riscos de segurança e verificações.',
    fixtureFiles:{'src/auth.ts':'export function login(){ localStorage.setItem("token","demo"); }\n'},
    checks:{minRequirements:3,minTasks:2,minAcceptanceCriteria:3,requiredPlanTerms:['httponly','localstorage']},
  },
  {
    id:'P4-05',title:'Plan accessibility upgrade',category:'planning',mode:'plan',agentKey:'SCOUT',
    prompt:'Planeje uma melhoria de acessibilidade para navegação por teclado, labels e foco visível, sem redesign completo.',
    fixtureFiles:{'index.html':html('<button></button><input>')},
    checks:{minRequirements:3,minTasks:2,minAcceptanceCriteria:3,requiredPlanTerms:['teclado','foco']},
  },
  {
    id:'P4-06',title:'Plan migration with deletion',category:'planning',mode:'plan',agentKey:'SCOUT',
    prompt:'Planeje migrar a configuração de legacy-config.js para config.ts e remover o arquivo legado somente após a nova leitura estar funcionando.',
    fixtureFiles:{'legacy-config.js':'window.CONFIG={api:"/v1"};\n','src/app.ts':'console.log("app");\n'},
    checks:{minRequirements:2,minTasks:2,minAcceptanceCriteria:2,requiredPlanTerms:['legacy-config.js','config.ts']},
  },
  {
    id:'P4-07',title:'Context target among 44 files',category:'context',mode:'review',agentKey:'SENTINEL',
    prompt:'Localize a causa do valor PHASE4_CONTEXT_BUG_07 e diga exatamente em qual arquivo ele está. Não proponha mudanças fora do arquivo responsável.',
    fixtureFiles:manyFiles('export const targetValue="PHASE4_CONTEXT_BUG_07";\n'),
    focusPaths:['src/modules/target.ts'],
    checks:{replyIncludes:['PHASE4_CONTEXT_BUG_07','src/modules/target.ts']},
  },
  {
    id:'P4-08',title:'Context cross-file dependency',category:'context',mode:'review',agentKey:'SENTINEL',
    prompt:'Identifique por que formatName retorna undefined e cite tanto o arquivo que exporta quanto o que importa a função.',
    fixtureFiles:{'src/name.ts':'export const formatName=(value:string)=>value.trim();\n','src/main.ts':'import { formatUser } from "./name";\nexport const x=formatUser(" Ana ");\n'},
    checks:{replyIncludes:['src/name.ts','src/main.ts']},
  },
  {
    id:'P4-09',title:'Context stale duplicate implementation',category:'context',mode:'review',agentKey:'SENTINEL',
    prompt:'Há duas implementações de normalize. Identifique a duplicação e os dois caminhos antes de sugerir consolidação.',
    fixtureFiles:{'src/core/normalize.ts':'export const normalize=(x:string)=>x.trim();\n','src/legacy/normalize.ts':'export const normalize=(x:string)=>x.toLowerCase();\n','src/main.ts':'import {normalize} from "./core/normalize";\n'},
    checks:{replyIncludes:['src/core/normalize.ts','src/legacy/normalize.ts']},
  },
  {
    id:'P4-10',title:'Context requirement precision',category:'context',mode:'review',agentKey:'SENTINEL',
    prompt:'Revise a implementação contra o requisito literal PHASE4_REQ_10: o botão deve ter data-testid="save-profile". Informe se está atendido e cite o arquivo.',
    fixtureFiles:{'index.html':html('<button id="save">Salvar</button>'),'REQUIREMENTS.md':'PHASE4_REQ_10: o botão deve ter data-testid="save-profile".\n'},
    checks:{replyIncludes:['PHASE4_REQ_10','index.html','save-profile']},
  },
  {
    id:'P4-11',title:'Build exact single-file marker',category:'build',mode:'build',agentKey:'FORGE',
    prompt:'Altere somente index.html. Adicione um elemento visível com data-testid="phase4-hello" e texto "Olá Fase 4".',
    fixtureFiles:{'index.html':html('<main>Olá</main>')},
    focusPaths:['index.html'],
    checks:{requiredPaths:['index.html'],allowedChangedPaths:['index.html'],content:[{path:'index.html',includes:['data-testid="phase4-hello"','Olá Fase 4']}],requireApplySuccess:true,requireBrowserPass:true},
  },
  {
    id:'P4-12',title:'Build preserve unrelated file',category:'build',mode:'build',agentKey:'FORGE',
    prompt:'Altere somente src/settings.ts para exportar const PHASE4_FLAG_12=true. Não altere README.md.',
    fixtureFiles:{'src/settings.ts':'export const enabled=false;\n','README.md':'KEEP_PHASE4_README_12\n'},
    focusPaths:['src/settings.ts'],
    checks:{requiredPaths:['src/settings.ts'],allowedChangedPaths:['src/settings.ts'],content:[{path:'src/settings.ts',includes:['PHASE4_FLAG_12','true']},{path:'README.md',includes:['KEEP_PHASE4_README_12']}],requireApplySuccess:true},
  },
  {
    id:'P4-13',title:'Build two-file feature',category:'build',mode:'build',agentKey:'FORGE',
    prompt:'Implemente contador simples: src/counter.js deve exportar increment(value) e index.html deve carregar esse módulo e mostrar um botão data-testid="phase4-counter". Altere somente esses dois arquivos.',
    fixtureFiles:{'src/counter.js':'export const increment=(value)=>value;\n','index.html':html('<main id="app"></main>')},
    focusPaths:['src/counter.js','index.html'],
    checks:{requiredPaths:['src/counter.js','index.html'],allowedChangedPaths:['src/counter.js','index.html'],content:[{path:'src/counter.js',includes:['increment']},{path:'index.html',includes:['phase4-counter']}],requireApplySuccess:true,requireBrowserPass:true},
  },
  {
    id:'P4-14',title:'Build delete obsolete file',category:'build',mode:'build',agentKey:'FORGE',
    prompt:'Remova obsolete.js e altere somente index.html para não referenciar mais obsolete.js. Não crie substitutos.',
    fixtureFiles:{'obsolete.js':'window.obsolete=true;\n','index.html':html('<script src="obsolete.js"></script><main>App</main>')},
    focusPaths:['obsolete.js','index.html'],
    checks:{requiredPaths:['obsolete.js','index.html'],allowedChangedPaths:['obsolete.js','index.html'],content:[{path:'index.html',excludes:['obsolete.js']}],requireApplySuccess:true,requireBrowserPass:true},
  },
  {
    id:'P4-15',title:'Build valid JSON',category:'build',mode:'build',agentKey:'FORGE',
    prompt:'Altere somente config.json. Preserve JSON válido e adicione "phase4Enabled": true.',
    fixtureFiles:{'config.json':'{"name":"demo","version":1}\n'},
    focusPaths:['config.json'],
    checks:{requiredPaths:['config.json'],allowedChangedPaths:['config.json'],content:[{path:'config.json',includes:['phase4Enabled','true']}],requireApplySuccess:true},
  },
  {
    id:'P4-16',title:'Build repair JavaScript reference',category:'repair',mode:'build',agentKey:'FORGE',
    prompt:'Corrija somente app.js para eliminar o ReferenceError PHASE4_BUG_16 mantendo o texto "ready" no console.',
    fixtureFiles:{'index.html':html('<script src="app.js"></script><main>App</main>'),'app.js':'console.log(PHASE4_BUG_16); console.log("ready");\n'},
    focusPaths:['app.js'],
    checks:{requiredPaths:['app.js'],allowedChangedPaths:['app.js'],content:[{path:'app.js',includes:['ready'],excludes:['console.log(PHASE4_BUG_16)']}],requireApplySuccess:true,requireBrowserPass:true},
  },
  {
    id:'P4-17',title:'Build precise import fix',category:'build',mode:'build',agentKey:'FORGE',
    prompt:'Corrija somente src/main.js. O módulo exportado se chama formatName, não formatUser. Preserve src/name.js.',
    fixtureFiles:{'src/name.js':'export const formatName=(value)=>value.trim();\n','src/main.js':'import { formatUser } from "./name.js";\nconsole.log(formatUser("Ana"));\n'},
    focusPaths:['src/main.js','src/name.js'],
    checks:{requiredPaths:['src/main.js'],allowedChangedPaths:['src/main.js'],content:[{path:'src/main.js',includes:['formatName'],excludes:['formatUser']}],requireApplySuccess:true},
  },
  {
    id:'P4-18',title:'Build large-context target only',category:'context',mode:'build',agentKey:'FORGE',
    prompt:'Altere somente src/modules/target.ts para exportar targetValue="PHASE4_FIXED_18". Não toque nos outros módulos.',
    fixtureFiles:manyFiles('export const targetValue="BROKEN_18";\n'),
    focusPaths:['src/modules/target.ts'],
    checks:{requiredPaths:['src/modules/target.ts'],allowedChangedPaths:['src/modules/target.ts'],content:[{path:'src/modules/target.ts',includes:['PHASE4_FIXED_18']}],requireApplySuccess:true},
  },
  {
    id:'P4-19',title:'Build semantic HTML button',category:'build',mode:'build',agentKey:'FORGE',
    prompt:'Altere somente index.html. Transforme o elemento clicável em um button real com data-testid="phase4-action", mantendo o texto Executar.',
    fixtureFiles:{'index.html':html('<div onclick="run()">Executar</div><script>function run(){}</script>')},
    focusPaths:['index.html'],
    checks:{requiredPaths:['index.html'],allowedChangedPaths:['index.html'],content:[{path:'index.html',includes:['<button','phase4-action','Executar']}],requireApplySuccess:true,requireBrowserPass:true},
  },
  {
    id:'P4-20',title:'Build no secret mutation',category:'build',mode:'build',agentKey:'FORGE',
    prompt:'Altere somente src/client.js para ler a URL de API de window.APP_CONFIG.apiUrl. Não crie nem altere .env, secrets ou credenciais.',
    fixtureFiles:{'src/client.js':'export const apiUrl="https://hardcoded.invalid";\n','index.html':html('<script>window.APP_CONFIG={apiUrl:"/api"}</script>')},
    focusPaths:['src/client.js'],
    checks:{requiredPaths:['src/client.js'],allowedChangedPaths:['src/client.js'],forbiddenChangedPaths:['.env','.env.local','secrets.json'],content:[{path:'src/client.js',includes:['APP_CONFIG','apiUrl']}],requireApplySuccess:true},
  },
  {
    id:'P4-21',title:'Visual mobile overflow fix',category:'visual',mode:'build',agentKey:'STUDIO',
    prompt:'Corrija somente index.html para eliminar overflow horizontal em mobile. Preserve o conteúdo e adicione data-testid="phase4-responsive" no container principal.',
    fixtureFiles:{'index.html':html('<main style="width:1400px" id="root">Conteúdo</main>')},
    focusPaths:['index.html'],
    checks:{requiredPaths:['index.html'],allowedChangedPaths:['index.html'],content:[{path:'index.html',includes:['phase4-responsive']}],requireApplySuccess:true,requireBrowserPass:true},
  },
  {
    id:'P4-22',title:'Visual accessible image',category:'visual',mode:'build',agentKey:'STUDIO',
    prompt:'Altere somente index.html. Adicione alt="Equipe trabalhando" à imagem e preserve src e layout.',
    fixtureFiles:{'index.html':html('<img src="team.png"><main>Equipe</main>')},
    focusPaths:['index.html'],
    checks:{requiredPaths:['index.html'],allowedChangedPaths:['index.html'],content:[{path:'index.html',includes:['alt="Equipe trabalhando"','team.png']}],requireApplySuccess:true,requireBrowserPass:true},
  },
  {
    id:'P4-23',title:'Visual accessible control name',category:'visual',mode:'build',agentKey:'STUDIO',
    prompt:'Altere somente index.html. O botão de fechar deve continuar visualmente "×" e receber aria-label="Fechar modal".',
    fixtureFiles:{'index.html':html('<button>×</button><div role="dialog">Modal</div>')},
    focusPaths:['index.html'],
    checks:{requiredPaths:['index.html'],allowedChangedPaths:['index.html'],content:[{path:'index.html',includes:['aria-label="Fechar modal"','×']}],requireApplySuccess:true,requireBrowserPass:true},
  },
  {
    id:'P4-24',title:'Visual duplicate id cleanup',category:'visual',mode:'build',agentKey:'STUDIO',
    prompt:'Altere somente index.html. Remova a duplicidade do id="card" mantendo dois cards e adicione data-testid="phase4-cards" no wrapper.',
    fixtureFiles:{'index.html':html('<div><article id="card">A</article><article id="card">B</article></div>')},
    focusPaths:['index.html'],
    checks:{requiredPaths:['index.html'],allowedChangedPaths:['index.html'],content:[{path:'index.html',includes:['phase4-cards']}],requireApplySuccess:true,requireBrowserPass:true},
  },
  {
    id:'P4-25',title:'Repair runtime exception',category:'repair',mode:'build',agentKey:'FORGE',
    prompt:'Corrija somente app.js. A página lança Error("PHASE4_RUNTIME_25") ao carregar. Remova a exceção e preserve window.phase4Ready=true.',
    fixtureFiles:{'index.html':html('<script src="app.js"></script><main>Ready</main>'),'app.js':'window.phase4Ready=true; throw new Error("PHASE4_RUNTIME_25");\n'},
    focusPaths:['app.js'],
    checks:{requiredPaths:['app.js'],allowedChangedPaths:['app.js'],content:[{path:'app.js',includes:['phase4Ready'],excludes:['throw new Error("PHASE4_RUNTIME_25")']}],requireApplySuccess:true,requireBrowserPass:true},
  },
  {
    id:'P4-26',title:'Repair missing local script',category:'repair',mode:'build',agentKey:'FORGE',
    prompt:'Corrija somente index.html. A página tenta carregar missing-phase4-26.js que não existe. Remova essa referência sem criar o arquivo.',
    fixtureFiles:{'index.html':html('<script src="missing-phase4-26.js"></script><main>Ready 26</main>')},
    focusPaths:['index.html'],
    checks:{requiredPaths:['index.html'],allowedChangedPaths:['index.html'],content:[{path:'index.html',excludes:['missing-phase4-26.js']}],requireApplySuccess:true,requireBrowserPass:true},
  },
  {
    id:'P4-27',title:'Repair scoped syntax bug',category:'repair',mode:'build',agentKey:'FORGE',
    prompt:'Corrija somente util.js. A função sum está com sintaxe inválida. Ela deve continuar exportada e retornar a+b.',
    fixtureFiles:{'util.js':'export function sum(a,b){ return a+; }\n','index.html':html('<main>Utility</main>')},
    focusPaths:['util.js'],
    checks:{requiredPaths:['util.js'],allowedChangedPaths:['util.js'],content:[{path:'util.js',includes:['sum','a+b']}],requireApplySuccess:true},
  },
  {
    id:'P4-28',title:'Review concrete runtime bug',category:'review',mode:'review',agentKey:'SENTINEL',
    prompt:'Revise o projeto e identifique a falha marcada PHASE4_REVIEW_28. Cite arquivo e causa sem inventar outras falhas.',
    fixtureFiles:{'src/app.js':'const user=null; console.log(user.name); // PHASE4_REVIEW_28\n'},
    checks:{replyIncludes:['PHASE4_REVIEW_28','src/app.js'],replyIncludesAny:[['user.name','acesso a name','.name'],['null','nulo']]},
  },
  {
    id:'P4-29',title:'Review security evidence',category:'review',mode:'review',agentKey:'SENTINEL',
    prompt:'Revise somente auth.js. Identifique por que PHASE4_REVIEW_29 representa exposição de segredo no browser.',
    fixtureFiles:{'auth.js':'export const API_SECRET="PHASE4_REVIEW_29";\n'},
    checks:{replyIncludes:['PHASE4_REVIEW_29','auth.js','API_SECRET']},
  },
  {
    id:'P4-30',title:'Review requirement miss',category:'review',mode:'review',agentKey:'SENTINEL',
    prompt:'Compare REQUIREMENTS.md e index.html. Diga se PHASE4_REVIEW_30 está atendido e cite a evidência concreta.',
    fixtureFiles:{'REQUIREMENTS.md':'PHASE4_REVIEW_30: deve existir data-testid="checkout".\n','index.html':html('<button id="buy">Comprar</button>')},
    checks:{replyIncludes:['PHASE4_REVIEW_30','index.html','checkout','data-testid'],replyIncludesAny:[['não atendido','não está atendido','não foi atendido','ausente','faltando','missing']]},
  },
];

if(PHASE4_BENCHMARK_CASES.length!==30)throw new Error(`Phase 4 benchmark catalog must contain exactly 30 cases; got ${PHASE4_BENCHMARK_CASES.length}.`);
