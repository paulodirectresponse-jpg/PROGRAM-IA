import type { ToolDefinition } from './types.js';

const DEFINITIONS: ToolDefinition[] = [
  {
    key:'workspace.list_tree',
    version:'1',
    description:'Lista a árvore de arquivos do workspace sem ler conteúdo.',
    risk:'read',
    availability:'ready',
    resumePolicy:'replay_safe',
    inputSchema:{
      pathPrefix:{type:'string',description:'Prefixo opcional para filtrar caminhos.'},
    },
  },
  {
    key:'workspace.read_file',
    version:'1',
    description:'Lê um arquivo de texto do workspace, opcionalmente por range explícito.',
    risk:'read',
    availability:'ready',
    resumePolicy:'replay_safe',
    inputSchema:{
      path:{type:'string',required:true,description:'Caminho relativo do arquivo.'},
      start:{type:'integer',min:0,description:'Índice inicial inclusivo.'},
      end:{type:'integer',min:0,description:'Índice final exclusivo.'},
    },
  },
  {
    key:'workspace.search_text',
    version:'1',
    description:'Pesquisa texto nos arquivos do workspace. maxMatches é explícito quando fornecido.',
    risk:'read',
    availability:'ready',
    resumePolicy:'replay_safe',
    inputSchema:{
      query:{type:'string',required:true,description:'Texto literal a pesquisar.'},
      pathPrefix:{type:'string',description:'Prefixo opcional de caminho.'},
      maxMatches:{type:'integer',min:1,description:'Limite explícito opcional de ocorrências retornadas.'},
    },
  },
  {
    key:'workspace.write_file',
    version:'1',
    description:'Escreve arquivo apenas dentro de sandbox/worktree isolado.',
    risk:'write',
    availability:'requires_sandbox',
    resumePolicy:'sandbox_required',
    inputSchema:{
      path:{type:'string',required:true,description:'Caminho relativo.'},
      content:{type:'string',required:true,description:'Conteúdo completo.'},
    },
  },
  {
    key:'workspace.delete_file',
    version:'1',
    description:'Remove um arquivo dentro do sandbox isolado.',
    risk:'write',
    availability:'requires_sandbox',
    resumePolicy:'sandbox_required',
    inputSchema:{
      path:{type:'string',required:true,description:'Caminho relativo do arquivo.'},
    },
  },
  {
    key:'workspace.apply_patch',
    version:'1',
    description:'Aplica patch JSON determinístico em sandbox. Formato: {"path":"...","search":"...","replace":"..."}.',
    risk:'write',
    availability:'requires_sandbox',
    resumePolicy:'sandbox_required',
    inputSchema:{
      patch:{type:'string',required:true,description:'Patch textual.'},
    },
  },
  {
    key:'process.run',
    version:'1',
    description:'Executa processo supervisionado somente em sandbox isolado.',
    risk:'process',
    availability:'requires_sandbox',
    resumePolicy:'sandbox_required',
    inputSchema:{
      script:{type:'string',required:true,description:'Nome de script npm declarado no package.json do sandbox.'},
      timeoutMs:{type:'integer',min:1,description:'Timeout explícito.'},
    },
  },
];

export class ToolRegistry {
  private static definitions = new Map(DEFINITIONS.map(definition => [definition.key, definition]));

  static list() {
    return [...this.definitions.values()].map(definition => ({...definition,inputSchema:{...definition.inputSchema}}));
  }

  static get(key: string) {
    return this.definitions.get(key) || null;
  }

  static validate(key: string, input: Record<string, unknown>) {
    const definition = this.get(key);
    if (!definition) return ['tool_unknown'];
    const errors: string[] = [];
    for (const [name,field] of Object.entries(definition.inputSchema)) {
      const value=input?.[name];
      if (field.required && (value===undefined || value===null || value==='')) {
        errors.push(`${name}:required`);
        continue;
      }
      if (value===undefined || value===null) continue;
      if (field.type==='string' && typeof value!=='string') errors.push(`${name}:string`);
      if (field.type==='boolean' && typeof value!=='boolean') errors.push(`${name}:boolean`);
      if (field.type==='integer') {
        if (!Number.isInteger(value)) errors.push(`${name}:integer`);
        else {
          const number=Number(value);
          if (field.min!==undefined && number<field.min) errors.push(`${name}:min`);
          if (field.max!==undefined && number>field.max) errors.push(`${name}:max`);
        }
      }
    }
    for (const name of Object.keys(input || {})) {
      if (!definition.inputSchema[name]) errors.push(`${name}:unknown`);
    }
    return errors;
  }
}
