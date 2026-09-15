import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { db } from '../db/index.js';
import { LLMAdapterService } from './llmAdapter.js';

export type IncomingAttachment = {
  name: string;
  mimeType?: string;
  size?: number;
  dataBase64: string;
};

export type ProcessedAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  analysis: string;
  kind: 'text'|'image'|'video'|'audio'|'pdf'|'binary';
};

const ROOT=path.resolve(process.env.FORGE_DATA_DIR||path.join(process.cwd(),'.data'),'attachments');
const MAX_FILES=6;
const MAX_FILE_BYTES=20*1024*1024;
const MAX_TOTAL_BYTES=35*1024*1024;
const TEXT_EXTENSIONS=new Set(['.txt','.md','.markdown','.json','.jsonl','.csv','.tsv','.xml','.html','.htm','.css','.js','.jsx','.ts','.tsx','.py','.rb','.php','.java','.kt','.swift','.go','.rs','.c','.h','.cpp','.hpp','.sql','.yaml','.yml','.toml','.ini','.env','.log','.sh','.ps1']);

function safeName(input:string){
  const base=path.basename(String(input||'arquivo')).replace(/[^a-zA-Z0-9._ -]/g,'_').trim();
  return base.slice(0,180)||'arquivo';
}
function kindOf(mime:string,name:string):ProcessedAttachment['kind']{
  const m=String(mime||'').toLowerCase(),ext=path.extname(name).toLowerCase();
  if(m.startsWith('image/'))return'image';
  if(m.startsWith('video/'))return'video';
  if(m.startsWith('audio/'))return'audio';
  if(m==='application/pdf'||ext==='.pdf')return'pdf';
  if(m.startsWith('text/')||TEXT_EXTENSIONS.has(ext)||/(json|xml|yaml|javascript|typescript|csv)/i.test(m))return'text';
  return'binary';
}
function cleanBase64(value:string){
  return String(value||'').replace(/^data:[^;]+;base64,/i,'').replace(/\s+/g,'');
}

export class AttachmentService {
  static async ingest(input:{userId:string;projectId:string;messageId:string;attachments:IncomingAttachment[]}):Promise<ProcessedAttachment[]>{
    const items=Array.isArray(input.attachments)?input.attachments:[];
    if(items.length>MAX_FILES)throw new Error(`Envie no máximo ${MAX_FILES} arquivos por mensagem.`);
    let total=0;
    const processed:ProcessedAttachment[]=[];
    for(const item of items){
      const name=safeName(item.name);
      const encoded=cleanBase64(item.dataBase64);
      if(!encoded)continue;
      const bytes=Buffer.from(encoded,'base64');
      if(!bytes.length)continue;
      if(bytes.length>MAX_FILE_BYTES)throw new Error(`${name} excede o limite de 20 MB.`);
      total+=bytes.length;
      if(total>MAX_TOTAL_BYTES)throw new Error('Os anexos desta mensagem excedem o limite total de 35 MB.');
      const id='att-'+crypto.randomUUID();
      const mimeType=String(item.mimeType||'application/octet-stream').slice(0,160);
      const kind=kindOf(mimeType,name);
      const dir=path.join(ROOT,input.projectId);
      fs.mkdirSync(dir,{recursive:true});
      const storagePath=path.join(dir,`${id}-${name}`);
      fs.writeFileSync(storagePath,bytes);
      const analysis=await this.analyze({userId:input.userId,name,mimeType,kind,bytes});
      const now=new Date().toISOString();
      db.prepare(`INSERT INTO attachments(id,message_id,project_id,user_id,name,file_type,mime_type,size_bytes,hash,storage_path,status,analysis_text,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id,input.messageId,input.projectId,input.userId,name,kind,mimeType,bytes.length,
        crypto.createHash('sha256').update(bytes).digest('hex'),storagePath,'processed',analysis,now
      );
      processed.push({id,name,mimeType,size:bytes.length,analysis,kind});
    }
    return processed;
  }

  private static async analyze(input:{userId:string;name:string;mimeType:string;kind:ProcessedAttachment['kind'];bytes:Buffer}){
    if(input.kind==='text'){
      const text=input.bytes.toString('utf8').replace(/\0/g,'').trim();
      return text.slice(0,120000);
    }

    const ext=path.extname(input.name).toLowerCase();
    if(['.docx','.pptx','.xlsx','.zip'].includes(ext)){
      try{
        const JSZip=(await import('jszip')).default;
        const zip=await JSZip.loadAsync(input.bytes);
        const candidates=Object.keys(zip.files)
          .filter(name=>!zip.files[name].dir)
          .filter(name=>ext==='.docx'?/word\/(?:document|header|footer).*\.xml$/i.test(name):
            ext==='.pptx'?/ppt\/(?:slides|notesSlides)\/.*\.xml$/i.test(name):
            ext==='.xlsx'?/xl\/(?:sharedStrings|worksheets\/.*)\.xml$/i.test(name):
            /\.(?:txt|md|json|csv|xml|html|js|ts|css|py)$/i.test(name))
          .slice(0,80);
        const chunks:string[]=[];
        for(const name of candidates){
          const raw=await zip.files[name].async('string');
          const text=raw
            .replace(/<w:tab\s*\/>/gi,'\t')
            .replace(/<a:br\s*\/>/gi,'\n')
            .replace(/<[^>]+>/g,' ')
            .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
            .replace(/\s+/g,' ').trim();
          if(text)chunks.push(`[${name}] ${text}`);
          if(chunks.join('\n').length>120000)break;
        }
        if(chunks.length)return chunks.join('\n').slice(0,120000);
        if(ext==='.zip')return `Arquivo ZIP recebido. Conteúdo: ${Object.keys(zip.files).slice(0,200).join(', ')}`;
      }catch{}
    }

    const gemini=LLMAdapterService.getProviderConfig('gemini',input.userId);
    if(!gemini?.isConfigured){
      const active=LLMAdapterService.getActiveProviderConfig(input.userId);
      if(active?.isConfigured&&active.type==='openai_compatible'&&input.kind==='image'){
        try{
          const endpoint=`${active.baseUrl.replace(/\/+$/,'')}/chat/completions`;
          const response=await fetch(endpoint,{
            method:'POST',
            headers:{'Content-Type':'application/json',Authorization:`Bearer ${active.apiKey}`},
            body:JSON.stringify({
              model:active.modelId,
              messages:[{role:'user',content:[
                {type:'text',text:'Analise esta imagem como referência para edição/criação de software. Descreva layout, textos, hierarquia, cores, componentes, espaçamentos e detalhes visuais concretos. Responda em português e não invente detalhes.'},
                {type:'image_url',image_url:{url:`data:${input.mimeType};base64,${input.bytes.toString('base64')}`}}
              ]}],
              temperature:0.1,
            }),
          });
          if(response.ok){
            const data:any=await response.json();
            const text=String(data?.choices?.[0]?.message?.content||'').trim();
            if(text)return text.slice(0,60000);
          }
        }catch{}
      }
      return `Arquivo ${input.name} recebido (${input.mimeType}, ${input.bytes.length} bytes). O binário foi preservado, mas nenhum modelo multimodal configurado conseguiu extrair seu conteúdo semanticamente.`;
    }

    try{
      const ai=new GoogleGenAI({apiKey:gemini.apiKey});
      const instruction=[
        'Analise este arquivo como contexto para um agente que cria e edita software.',
        'Extraia somente informações concretas úteis para atender a um pedido posterior do usuário.',
        input.kind==='image'?'Descreva layout, textos visíveis, componentes, hierarquia, cores, espaçamentos, estados e detalhes visuais relevantes.':'',
        input.kind==='video'?'Descreva sequência visual, telas/cenas, mudanças ao longo do tempo, textos, interações e referências de UI relevantes.':'',
        input.kind==='audio'?'Transcreva o conteúdo falado quando possível e resuma instruções, requisitos e decisões.':'',
        input.kind==='pdf'?'Resuma estrutura, conteúdo, requisitos, tabelas e elementos visuais importantes.':'',
        input.kind==='binary'?'Identifique o formato e extraia qualquer conteúdo ou estrutura semanticamente útil que conseguir.':'',
        'Não invente detalhes ausentes. Responda em português, de forma objetiva.',
      ].filter(Boolean).join('\n');
      const res=await ai.models.generateContent({
        model:gemini.modelId||'gemini-2.5-flash',
        contents:[{role:'user',parts:[
          {text:instruction},
          {inlineData:{mimeType:input.mimeType,data:input.bytes.toString('base64')}}
        ]}]
      } as any);
      return String(res.text||'').trim().slice(0,60000)||`Arquivo ${input.name} recebido, mas sem análise textual retornada.`;
    }catch(error:any){
      return `Arquivo ${input.name} recebido. A análise multimodal falhou: ${String(error?.message||error).slice(0,300)}`;
    }
  }

  static formatContext(items:ProcessedAttachment[]){
    if(!items.length)return'';
    const chunks=['ANEXOS ENVIADOS PELO USUÁRIO — trate como contexto primário do pedido:'];
    let used=chunks[0].length;
    for(let index=0;index<items.length;index++){
      const item=items[index];
      const head=`[${index+1}] ${item.name} (${item.kind}, ${item.mimeType}, ${item.size} bytes)\n`;
      const remaining=Math.max(0,120000-used-head.length);
      if(!remaining)break;
      const chunk=head+item.analysis.slice(0,Math.min(40000,remaining));
      chunks.push(chunk);
      used+=chunk.length;
    }
    return chunks.join('\n\n');
  }
}
