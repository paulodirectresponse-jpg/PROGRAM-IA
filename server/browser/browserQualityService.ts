import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { db } from '../db/index.js';
import { RuntimeManager } from '../services/runtimeManager.js';
import { SandboxManager } from '../tooling/sandboxManager.js';

export type BrowserQualityStatus='passed'|'failed'|'unverified'|'skipped';
export type BrowserIssueSeverity='error'|'warning'|'info';

export interface BrowserQualityIssue {
  code:string;
  severity:BrowserIssueSeverity;
  message:string;
  viewport?:string;
  url?:string;
  resourceType?:string;
}
export interface BrowserViewportEvidence {
  name:string;width:number;height:number;finalUrl:string;title:string;
  bodyTextChars:number;interactiveCount:number;unlabeledInteractiveCount:number;
  imagesWithoutAlt:number;duplicateIds:string[];horizontalOverflowPx:number;
  consoleErrors:string[];pageErrors:string[];
  failedRequests:Array<{url:string;resourceType:string;failure:string}>;
  badResponses:Array<{url:string;resourceType:string;status:number}>;
  blockedExternalRequests:string[];
  screenshotPath?:string;screenshotSha256?:string;screenshotBytes?:number;
}
export interface BrowserQualityResult {
  id:string;status:BrowserQualityStatus;projectId:string;sandboxId:string;
  runId?:string|null;stepId?:string|null;runtimeKind:'static'|'framework'|'none';
  framework?:string;entryPath?:string;url?:string;issues:BrowserQualityIssue[];
  viewports:BrowserViewportEvidence[];durationMs:number;reason?:string;createdAt:string;
}

const VIEWPORTS=[{name:'desktop',width:1280,height:720},{name:'mobile',width:390,height:844}] as const;
const NAVIGATION_TIMEOUT_MS=20000;
const NETWORK_IDLE_TIMEOUT_MS=3000;
const MAX_EVIDENCE_ITEMS=50;
const artifactRoot=()=>path.resolve(process.env.FORGE_BROWSER_ARTIFACT_DIR||path.join(os.tmpdir(),'program-ia-browser-evidence'));

function mimeType(filePath:string){
  const ext=path.extname(filePath).toLowerCase();
  const table:Record<string,string>={
    '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8',
    '.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.map':'application/json; charset=utf-8',
    '.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp',
    '.gif':'image/gif','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2',
  };
  return table[ext]||'application/octet-stream';
}
function findEntryPath(sandboxId:string,userId:string,projectId:string,requested?:string){
  const files=SandboxManager.getFiles(sandboxId,userId,projectId);
  if(requested){
    const normalized=String(requested).replace(/\\/g,'/').replace(/^\.\//,'').replace(/^\//,'');
    if(files.some(file=>file.path===normalized))return normalized;
  }
  if(files.some(file=>file.path==='index.html'))return 'index.html';
  return files.find(file=>/(^|\/)index\.html$/i.test(file.path))?.path;
}
function safeArtifactPath(runId:string,viewport:string){
  const dir=path.join(artifactRoot(),runId);
  const file=path.resolve(dir,`${viewport.replace(/[^a-z0-9_-]/gi,'')}.png`);
  const base=path.resolve(dir);
  if(!file.startsWith(base+path.sep))throw new Error('Artifact path inválido.');
  return file;
}
function localBrowserUrl(url:string){
  try{return ['127.0.0.1','localhost','::1'].includes(new URL(url).hostname);}catch{return false;}
}
function allowedBrowserRequest(url:string){
  return url.startsWith('data:')||url.startsWith('blob:')||url.startsWith('about:')||localBrowserUrl(url);
}
function fatalConsoleMessage(text:string){
  return /\b(?:uncaught|referenceerror|typeerror|syntaxerror)\b|failed to resolve module|hydration failed|error boundary/i.test(text);
}
function pushBounded<T>(target:T[],value:T){if(target.length<MAX_EVIDENCE_ITEMS)target.push(value);}

async function openStaticServer(input:{sandboxId:string;userId:string;projectId:string;entryPath:string;signal?:AbortSignal}){
  const server=http.createServer((req,res)=>{
    try{
      if(!['GET','HEAD'].includes(String(req.method||'GET').toUpperCase())){res.statusCode=405;res.end('Method not allowed');return;}
      const raw=decodeURIComponent(String(req.url||'/').split('?')[0]||'/').replace(/^\//,'');
      let candidate=raw||input.entryPath;
      let full:string;
      try{full=SandboxManager.resolveSafePath(input.sandboxId,input.userId,candidate,input.projectId);}catch{res.statusCode=400;res.end('Bad path');return;}
      if(!fs.existsSync(full)||fs.statSync(full).isDirectory()){
        if(path.extname(candidate)){res.statusCode=404;res.end('Not found');return;}
        candidate=input.entryPath;
        full=SandboxManager.resolveSafePath(input.sandboxId,input.userId,candidate,input.projectId);
      }
      if(!fs.existsSync(full)||!fs.statSync(full).isFile()){res.statusCode=404;res.end('Not found');return;}
      res.statusCode=200;res.setHeader('Content-Type',mimeType(full));res.setHeader('Cache-Control','no-store');
      if(req.method==='HEAD'){res.end();return;}
      fs.createReadStream(full).pipe(res);
    }catch(error:any){res.statusCode=500;res.end(String(error?.message||error));}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
  const address=server.address();const port=typeof address==='object'&&address?address.port:0;
  const stop=()=>new Promise<void>(resolve=>server.close(()=>resolve()));
  const abort=()=>{void stop();};input.signal?.addEventListener('abort',abort,{once:true});
  return {url:`http://127.0.0.1:${port}/${input.entryPath}`,stop:async()=>{input.signal?.removeEventListener('abort',abort);await stop();}};
}

async function inspectViewport(input:{browser:Browser;baseUrl:string;viewport:{name:string;width:number;height:number};artifactRunId:string;signal?:AbortSignal}):Promise<BrowserViewportEvidence>{
  const context:BrowserContext=await input.browser.newContext({viewport:{width:input.viewport.width,height:input.viewport.height},acceptDownloads:false,serviceWorkers:'block'});
  const page:Page=await context.newPage();
  const consoleErrors:string[]=[],pageErrors:string[]=[],blockedExternalRequests:string[]=[];
  const failedRequests:Array<{url:string;resourceType:string;failure:string}>=[],badResponses:Array<{url:string;resourceType:string;status:number}>=[];
  await context.route('**/*',async route=>{
    const request=route.request();
    if(allowedBrowserRequest(request.url()))return route.continue();
    pushBounded(blockedExternalRequests,request.url());return route.abort('blockedbyclient');
  });
  page.on('console',m=>{if(m.type()==='error')pushBounded(consoleErrors,m.text());});
  page.on('pageerror',e=>pushBounded(pageErrors,String(e?.message||e)));
  page.on('requestfailed',r=>{if(localBrowserUrl(r.url()))pushBounded(failedRequests,{url:r.url(),resourceType:r.resourceType(),failure:r.failure()?.errorText||'request_failed'});});
  page.on('response',r=>{if(localBrowserUrl(r.url())&&r.status()>=400)pushBounded(badResponses,{url:r.url(),resourceType:r.request().resourceType(),status:r.status()});});
  const abort=()=>{void page.close().catch(()=>undefined);};input.signal?.addEventListener('abort',abort,{once:true});
  try{
    await page.goto(input.baseUrl,{waitUntil:'domcontentloaded',timeout:NAVIGATION_TIMEOUT_MS});
    await page.waitForLoadState('networkidle',{timeout:NETWORK_IDLE_TIMEOUT_MS}).catch(()=>undefined);
    input.signal?.throwIfAborted();
    const dom=await page.evaluate(`(() => {
      const body=document.body;
      const doc=document.documentElement;
      const interactive=Array.from(document.querySelectorAll('button,a,input,select,textarea,[role="button"],[role="link"]'));
      let unlabeledInteractiveCount=0;
      for(const el of interactive){
        const aria=el.getAttribute('aria-label')||el.getAttribute('aria-labelledby')||'';
        const text=((el.innerText||'')||el.getAttribute('title')||el.getAttribute('alt')||'').trim();
        const name=el.getAttribute('name')||'';
        if(!((aria+' '+text+' '+name).trim()))unlabeledInteractiveCount++;
      }
      const counts={};
      for(const el of Array.from(document.querySelectorAll('[id]'))){
        const id=el.id;
        if(id)counts[id]=(counts[id]||0)+1;
      }
      const duplicateIds=Object.keys(counts).filter(id=>counts[id]>1);
      const images=Array.from(document.querySelectorAll('img'));
      let imagesWithoutAlt=0;
      for(const image of images)if(!image.hasAttribute('alt'))imagesWithoutAlt++;
      return {
        title:document.title||'',
        bodyTextChars:((body&&body.innerText)||'').trim().length,
        interactiveCount:interactive.length,
        unlabeledInteractiveCount,
        imagesWithoutAlt,
        duplicateIds,
        horizontalOverflowPx:Math.max(0,((doc&&doc.scrollWidth)||0)-window.innerWidth),
      };
    })()`) as any;
    const screenshotPath=safeArtifactPath(input.artifactRunId,input.viewport.name);
    fs.mkdirSync(path.dirname(screenshotPath),{recursive:true});await page.screenshot({path:screenshotPath,fullPage:true});
    const screenshot=fs.readFileSync(screenshotPath);
    return {name:input.viewport.name,width:input.viewport.width,height:input.viewport.height,finalUrl:page.url(),title:dom.title,
      bodyTextChars:dom.bodyTextChars,interactiveCount:dom.interactiveCount,unlabeledInteractiveCount:dom.unlabeledInteractiveCount,
      imagesWithoutAlt:dom.imagesWithoutAlt,duplicateIds:dom.duplicateIds,horizontalOverflowPx:dom.horizontalOverflowPx,
      consoleErrors,pageErrors,failedRequests,badResponses,blockedExternalRequests,screenshotPath,
      screenshotSha256:crypto.createHash('sha256').update(screenshot).digest('hex'),screenshotBytes:screenshot.length};
  }finally{input.signal?.removeEventListener('abort',abort);await context.close().catch(()=>undefined);}
}

function issuesForViewport(e:BrowserViewportEvidence):BrowserQualityIssue[]{
  const issues:BrowserQualityIssue[]=[];
  for(const message of e.pageErrors)issues.push({code:'page_error',severity:'error',message,viewport:e.name,url:e.finalUrl});
  for(const message of e.consoleErrors)issues.push({code:'console_error',severity:fatalConsoleMessage(message)?'error':'warning',message,viewport:e.name,url:e.finalUrl});
  for(const item of e.failedRequests)issues.push({code:'request_failed',severity:['document','script','stylesheet'].includes(item.resourceType)?'error':'warning',message:item.failure,viewport:e.name,url:item.url,resourceType:item.resourceType});
  for(const item of e.badResponses)issues.push({code:'bad_response',severity:item.status>=500||['document','script','stylesheet'].includes(item.resourceType)?'error':'warning',message:`HTTP ${item.status}`,viewport:e.name,url:item.url,resourceType:item.resourceType});
  if(e.bodyTextChars===0)issues.push({code:'empty_document',severity:'warning',message:'A página renderizou sem conteúdo textual visível.',viewport:e.name,url:e.finalUrl});
  if(e.horizontalOverflowPx>8)issues.push({code:'horizontal_overflow',severity:'warning',message:`Overflow horizontal de ${e.horizontalOverflowPx}px.`,viewport:e.name,url:e.finalUrl});
  if(e.unlabeledInteractiveCount>0)issues.push({code:'unlabeled_interactive',severity:'warning',message:`${e.unlabeledInteractiveCount} elemento(s) interativo(s) sem nome acessível detectável.`,viewport:e.name,url:e.finalUrl});
  if(e.imagesWithoutAlt>0)issues.push({code:'image_without_alt',severity:'warning',message:`${e.imagesWithoutAlt} imagem(ns) sem atributo alt.`,viewport:e.name,url:e.finalUrl});
  if(e.duplicateIds.length)issues.push({code:'duplicate_ids',severity:'warning',message:`IDs duplicados: ${e.duplicateIds.slice(0,10).join(', ')}`,viewport:e.name,url:e.finalUrl});
  if(e.blockedExternalRequests.length)issues.push({code:'external_requests_blocked',severity:'info',message:`${e.blockedExternalRequests.length} request(s) externo(s) bloqueado(s) na inspeção.`,viewport:e.name,url:e.finalUrl});
  return issues;
}
function persist(result:BrowserQualityResult,userId:string){
  db.prepare(`INSERT INTO browser_quality_runs(id,project_id,user_id,run_id,step_id,sandbox_id,status,runtime_kind,framework,entry_path,url,issues_json,viewports_json,duration_ms,reason,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(result.id,result.projectId,userId,result.runId||null,result.stepId||null,result.sandboxId,result.status,result.runtimeKind,
    result.framework||null,result.entryPath||null,result.url||null,JSON.stringify(result.issues),JSON.stringify(result.viewports),result.durationMs,result.reason||null,result.createdAt);
}
function hydrate(row:any):BrowserQualityResult{return {id:row.id,status:row.status,projectId:row.project_id,sandboxId:row.sandbox_id,runId:row.run_id||null,stepId:row.step_id||null,
  runtimeKind:row.runtime_kind,framework:row.framework||undefined,entryPath:row.entry_path||undefined,url:row.url||undefined,
  issues:(()=>{try{return JSON.parse(row.issues_json||'[]')}catch{return[]}})(),viewports:(()=>{try{return JSON.parse(row.viewports_json||'[]')}catch{return[]}})(),
  durationMs:Number(row.duration_ms||0),reason:row.reason||undefined,createdAt:row.created_at};}

export class BrowserQualityService {
  static async inspect(input:{userId:string;projectId:string;sandboxId:string;runId?:string|null;stepId?:string|null;entryPath?:string;signal?:AbortSignal}):Promise<BrowserQualityResult>{
    const started=Date.now(),id=`browser-quality-${crypto.randomUUID()}`,createdAt=new Date().toISOString();
    SandboxManager.assertAccess(input.sandboxId,input.userId,input.projectId);
    const root=SandboxManager.rootPath(input.sandboxId,input.userId,input.projectId);
    const entryPath=findEntryPath(input.sandboxId,input.userId,input.projectId,input.entryPath);
    let pkg:any=null;
    try{pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));}catch{}
    const hasRuntimeScript=Boolean(pkg?.scripts?.dev||pkg?.scripts?.start);
    if(!entryPath&&!hasRuntimeScript){
      const result:BrowserQualityResult={id,status:'skipped',projectId:input.projectId,sandboxId:input.sandboxId,runId:input.runId||null,stepId:input.stepId||null,runtimeKind:'none',issues:[],viewports:[],durationMs:Date.now()-started,reason:'no_browser_entrypoint',createdAt};persist(result,input.userId);return result;
    }
    let browser:Browser|null=null;let stopRuntime:()=>Promise<void>=async()=>{};let url='';let runtimeKind:'static'|'framework'=hasRuntimeScript?'framework':'static';let framework:string|undefined;
    try{
      if(hasRuntimeScript){
        const runtimeKey=`browser:${input.sandboxId}`,runtime=await RuntimeManager.ensureAt(runtimeKey,root,input.signal,true);
        if(runtime.status!=='running'||!runtime.url){
          const result:BrowserQualityResult={id,status:'failed',projectId:input.projectId,sandboxId:input.sandboxId,runId:input.runId||null,stepId:input.stepId||null,runtimeKind:'framework',framework:runtime.framework,entryPath,
            issues:[{code:'runtime_start_failed',severity:'error',message:runtime.lastError||'Runtime do sandbox não iniciou.'}],viewports:[],durationMs:Date.now()-started,reason:'runtime_start_failed',createdAt};persist(result,input.userId);return result;
        }
        url=runtime.url;framework=runtime.framework;stopRuntime=async()=>{await RuntimeManager.stop(runtimeKey);};
      }else{
        const staticRuntime=await openStaticServer({sandboxId:input.sandboxId,userId:input.userId,projectId:input.projectId,entryPath:entryPath!,signal:input.signal});url=staticRuntime.url;stopRuntime=staticRuntime.stop;
      }
      try{browser=await chromium.launch({headless:true,args:process.env.FORGE_BROWSER_NO_SANDBOX==='true'?['--no-sandbox']:[]});}
      catch(error:any){
        const result:BrowserQualityResult={id,status:'unverified',projectId:input.projectId,sandboxId:input.sandboxId,runId:input.runId||null,stepId:input.stepId||null,runtimeKind,framework,entryPath,url,issues:[],viewports:[],durationMs:Date.now()-started,reason:`browser_unavailable:${String(error?.message||error).slice(0,500)}`,createdAt};persist(result,input.userId);return result;
      }
      const viewports:BrowserViewportEvidence[]=[];
      for(const viewport of VIEWPORTS){input.signal?.throwIfAborted();viewports.push(await inspectViewport({browser,baseUrl:url,viewport,artifactRunId:id,signal:input.signal}));}
      const issues=viewports.flatMap(issuesForViewport),status:BrowserQualityStatus=issues.some(issue=>issue.severity==='error')?'failed':'passed';
      const result:BrowserQualityResult={id,status,projectId:input.projectId,sandboxId:input.sandboxId,runId:input.runId||null,stepId:input.stepId||null,runtimeKind,framework,entryPath,url,issues,viewports,durationMs:Date.now()-started,createdAt};persist(result,input.userId);return result;
    }catch(error:any){
      if(input.signal?.aborted||error?.name==='AbortError')throw error;
      const result:BrowserQualityResult={id,status:'failed',projectId:input.projectId,sandboxId:input.sandboxId,runId:input.runId||null,stepId:input.stepId||null,runtimeKind,framework,entryPath,url,
        issues:[{code:'browser_inspection_failed',severity:'error',message:String(error?.message||error).slice(0,1000)}],viewports:[],durationMs:Date.now()-started,reason:'browser_inspection_failed',createdAt};persist(result,input.userId);return result;
    }finally{if(browser)await browser.close().catch(()=>undefined);await stopRuntime().catch(()=>undefined);}
  }
  static get(id:string){const row=db.prepare('SELECT * FROM browser_quality_runs WHERE id=?').get(id) as any;return row?hydrate(row):null;}
  static listByRun(runId:string){return (db.prepare('SELECT * FROM browser_quality_runs WHERE run_id=? ORDER BY created_at ASC').all(runId) as any[]).map(hydrate);}
  static screenshotPath(id:string,viewport:string,userId:string,projectId:string){
    const row=db.prepare('SELECT user_id,project_id,viewports_json FROM browser_quality_runs WHERE id=?').get(id) as any;if(!row||row.user_id!==userId||row.project_id!==projectId)return null;
    const viewports=(()=>{try{return JSON.parse(row.viewports_json||'[]')}catch{return[]}})() as BrowserViewportEvidence[],item=viewports.find(v=>v.name===viewport);if(!item?.screenshotPath)return null;
    const expected=safeArtifactPath(id,viewport);return path.resolve(item.screenshotPath)===path.resolve(expected)&&fs.existsSync(expected)?expected:null;
  }
}
