import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { db } from '../db/index.js';
import { ContextEngineV2 } from '../context-engine/contextEngine.js';
import { WorkspaceManager } from '../services/workspaceManager.js';
import { ToolPolicy } from './toolPolicy.js';

export type SandboxStatus='active'|'validated'|'failed'|'stale'|'merged'|'interrupted'|'cleaned';

export interface SandboxRecord {
  id:string;
  projectId:string;
  userId:string;
  runId?:string|null;
  stepId?:string|null;
  status:SandboxStatus;
  rootPath:string;
  baseHash:string;
  baseManifest:Record<string,string>;
  validation?:unknown;
  mergedCheckpointId?:string|null;
  createdAt:string;
  updatedAt:string;
}

function sandboxRoot(){
  return path.resolve(process.env.FORGE_SANDBOX_DIR || path.join(os.tmpdir(),'program-ia-sandboxes'));
}

function ignoredRelative(relative:string){
  const normalized=relative.replace(/\\/g,'/').replace(/^\.\//,'');
  if(!normalized)return false;
  const parts=normalized.split('/');
  if(parts.includes('.git')||parts.includes('node_modules')||parts.includes('.DS_Store')||parts.includes('.forge-home'))return true;
  return ToolPolicy.isSensitivePath(normalized);
}

function ignoredOfficialStageRelative(relative:string){
  const normalized=relative.replace(/\\/g,'/').replace(/^\.\//,'');
  if(!normalized)return false;
  const parts=normalized.split('/');
  return parts.includes('.git')||parts.includes('node_modules')||parts.includes('.DS_Store')||parts.includes('.forge-home');
}

function safeCopyFilter(root:string,sourcePath:string){
  const rel=path.relative(root,sourcePath).replace(/\\/g,'/');
  if(!rel)return true;
  try{if(fs.lstatSync(sourcePath).isSymbolicLink())return false;}catch{return false;}
  return !ignoredRelative(rel);
}

function safeOfficialStageCopyFilter(root:string,sourcePath:string){
  const rel=path.relative(root,sourcePath).replace(/\\/g,'/');
  if(!rel)return true;
  try{if(fs.lstatSync(sourcePath).isSymbolicLink())return false;}catch{return false;}
  return !ignoredOfficialStageRelative(rel);
}

function safeJoin(root:string,relativePath:string){
  const normalized=ToolPolicy.normalizeRelativePath(relativePath);
  const resolved=path.resolve(root,normalized);
  const base=path.resolve(root);
  if(resolved!==base&&!resolved.startsWith(base+path.sep))throw Object.assign(new Error('Caminho escapou do sandbox.'),{code:'sandbox_path_escape'});
  let cursor=resolved;
  while(cursor!==base){
    if(fs.existsSync(cursor)&&fs.lstatSync(cursor).isSymbolicLink())throw Object.assign(new Error('Symlink não permitido no sandbox.'),{code:'sandbox_symlink'});
    cursor=path.dirname(cursor);
  }
  return resolved;
}

function manifestFrom(root:string){
  const manifest:Record<string,string>={};
  const walk=(dir:string,base:string)=>{
    if(!fs.existsSync(dir))return;
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      if(entry.isSymbolicLink())continue;
      const rel=path.join(base,entry.name).replace(/\\/g,'/');
      if(ignoredRelative(rel))continue;
      const full=path.join(dir,entry.name);
      if(entry.isDirectory())walk(full,rel);
      else manifest[rel]=crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root,'');
  return manifest;
}

function fingerprint(manifest:Record<string,string>){
  return crypto.createHash('sha256').update(
    Object.entries(manifest).sort(([a],[b])=>a.localeCompare(b)).map(([file,hash])=>`${file}:\0${hash}`).join('\n')
  ).digest('hex');
}

function hydrate(row:any):SandboxRecord{
  return {
    id:row.id,projectId:row.project_id,userId:row.user_id,runId:row.run_id||null,stepId:row.step_id||null,
    status:row.status,rootPath:row.root_path,baseHash:row.base_hash,
    baseManifest:(()=>{try{return JSON.parse(row.base_manifest_json||'{}')}catch{return{}}})(),
    validation:(()=>{try{return JSON.parse(row.validation_json||'null')}catch{return null}})(),
    mergedCheckpointId:row.merged_checkpoint_id||null,createdAt:row.created_at,updatedAt:row.updated_at,
  };
}

export class SandboxManager {
  static projectFingerprint(projectId:string){
    return fingerprint(manifestFrom(WorkspaceManager.getProjectDir(projectId)));
  }

  static create(input:{userId:string;projectId:string;runId?:string|null;stepId?:string|null}) {
    if(!WorkspaceManager.verifyProjectOwnership(input.projectId,input.userId))throw Object.assign(new Error('Projeto não pertence ao usuário.'),{code:'project_forbidden'});
    const rootBase=sandboxRoot();
    fs.mkdirSync(rootBase,{recursive:true});
    const id=`sbx-${crypto.randomUUID()}`;
    const root=path.join(rootBase,id);
    const source=WorkspaceManager.getProjectDir(input.projectId);
    const baseManifest=manifestFrom(source);
    const baseHash=fingerprint(baseManifest);
    fs.mkdirSync(root,{recursive:true});
    fs.cpSync(source,root,{
      recursive:true,
      force:true,
      filter:(sourcePath)=>safeCopyFilter(source,sourcePath),
    });
    const now=new Date().toISOString();
    db.prepare(`INSERT INTO sandboxes(id,project_id,user_id,run_id,step_id,status,root_path,base_hash,base_manifest_json,validation_json,created_at,updated_at)
      VALUES(?,?,?,?,?,'active',?,?,?,'null',?,?)`).run(
      id,input.projectId,input.userId,input.runId||null,input.stepId||null,root,baseHash,JSON.stringify(baseManifest),now,now
    );
    return this.get(id)!;
  }

  static get(id:string){
    const row=db.prepare('SELECT * FROM sandboxes WHERE id=?').get(id) as any;
    return row?hydrate(row):null;
  }

  static assertAccess(id:string,userId:string,projectId?:string){
    const record=this.get(id);
    if(!record)throw Object.assign(new Error('Sandbox não encontrado.'),{code:'sandbox_not_found'});
    if(record.userId!==userId||(projectId&&record.projectId!==projectId))throw Object.assign(new Error('Sandbox não pertence ao contexto atual.'),{code:'sandbox_forbidden'});
    if(['cleaned','merged'].includes(record.status))throw Object.assign(new Error(`Sandbox indisponível no estado ${record.status}.`),{code:'sandbox_inactive'});
    if(!fs.existsSync(record.rootPath))throw Object.assign(new Error('Diretório do sandbox não existe.'),{code:'sandbox_missing'});
    return record;
  }

  static rootPath(id:string,userId:string,projectId?:string){
    return this.assertAccess(id,userId,projectId).rootPath;
  }

  static resolveSafePath(id:string,userId:string,relativePath:string,projectId?:string){
    return safeJoin(this.rootPath(id,userId,projectId),relativePath);
  }

  static getFiles(id:string,userId:string,projectId?:string){
    const root=this.rootPath(id,userId,projectId);
    const rows:Array<{path:string;size:number;isBinary:boolean;updatedAt:string}>=[];
    const walk=(dir:string,base:string)=>{
      for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
        if(entry.isSymbolicLink())continue;
        const rel=path.join(base,entry.name).replace(/\\/g,'/');
        if(ignoredRelative(rel))continue;
        const full=path.join(dir,entry.name);
        if(entry.isDirectory())walk(full,rel);
        else {
          const stat=fs.statSync(full);
          rows.push({path:rel,size:stat.size,isBinary:WorkspaceManager.isBinaryPath(rel),updatedAt:stat.mtime.toISOString()});
        }
      }
    };
    walk(root,'');
    return rows;
  }

  static getAllFilesContent(id:string,userId:string,projectId?:string){
    const out:Record<string,string>={};
    for(const file of this.getFiles(id,userId,projectId)){
      if(file.isBinary)continue;
      out[file.path]=fs.readFileSync(safeJoin(this.rootPath(id,userId,projectId),file.path),'utf8');
    }
    return out;
  }

  static readFile(id:string,userId:string,relativePath:string,projectId?:string){
    const full=this.resolveSafePath(id,userId,relativePath,projectId);
    if(!fs.existsSync(full)||fs.statSync(full).isDirectory())return null;
    return fs.readFileSync(full,'utf8');
  }

  static writeFile(id:string,userId:string,relativePath:string,content:string,projectId?:string){
    const full=this.resolveSafePath(id,userId,relativePath,projectId);
    fs.mkdirSync(path.dirname(full),{recursive:true});
    fs.writeFileSync(full,content,'utf8');
  }

  static deleteFile(id:string,userId:string,relativePath:string,projectId?:string){
    const full=this.resolveSafePath(id,userId,relativePath,projectId);
    if(!fs.existsSync(full))return false;
    if(fs.statSync(full).isDirectory())throw Object.assign(new Error('Remoção recursiva de diretório não é permitida pela tool.'),{code:'directory_delete_blocked'});
    fs.unlinkSync(full);
    return true;
  }

  static manifest(id:string,userId:string,projectId?:string){
    return manifestFrom(this.rootPath(id,userId,projectId));
  }

  static changedFiles(id:string,userId:string,projectId?:string){
    const record=this.assertAccess(id,userId,projectId);
    const current=this.manifest(id,userId,projectId);
    const paths=new Set([...Object.keys(record.baseManifest),...Object.keys(current)]);
    return [...paths].sort().flatMap(file=>{
      const before=record.baseManifest[file];
      const after=current[file];
      if(before===after)return[];
      return [{path:file,action:before===undefined?'create':after===undefined?'delete':'modify'}];
    });
  }

  static assertExpectedChanges(
    id:string,
    userId:string,
    projectId:string,
    changes:Array<{path:string;action:string;content?:string}>,
    options:{allowExtraPaths?:boolean}={}
  ){
    const record=this.assertAccess(id,userId,projectId);
    const expected=new Map<string,{path:string;action:string;content?:string}>();
    for(const change of changes){
      const normalized=ToolPolicy.normalizeRelativePath(change.path);
      if(ToolPolicy.isSensitivePath(normalized))throw Object.assign(new Error(`Mudança sensível não permitida: ${normalized}`),{code:'sensitive_path'});
      if(expected.has(normalized))throw Object.assign(new Error(`Caminho duplicado na proposta: ${normalized}`),{code:'duplicate_change_path'});
      expected.set(normalized,{...change,path:normalized});
    }

    const actual=this.changedFiles(id,userId,projectId);
    if(!options.allowExtraPaths){
      const extras=actual.filter(item=>!expected.has(item.path));
      if(extras.length)throw Object.assign(new Error('O sandbox contém alterações fora da proposta aprovada.'),{
        code:'sandbox_proposal_mismatch',
        paths:extras.map(item=>item.path),
      });
    }

    for(const change of expected.values()){
      const source=safeJoin(record.rootPath,change.path);
      const exists=fs.existsSync(source);
      if(change.action==='delete'){
        if(exists)throw Object.assign(new Error(`Arquivo deveria estar removido no sandbox: ${change.path}`),{code:'sandbox_proposal_mismatch'});
        continue;
      }
      if(!exists)throw Object.assign(new Error(`Arquivo esperado não existe no sandbox: ${change.path}`),{code:'sandbox_proposal_mismatch'});
      const stat=fs.lstatSync(source);
      if(stat.isSymbolicLink()||!stat.isFile())throw Object.assign(new Error(`Tipo de arquivo inválido no sandbox: ${change.path}`),{code:'sandbox_proposal_mismatch'});
      if(typeof change.content==='string'){
        const content=fs.readFileSync(source,'utf8');
        if(content!==change.content)throw Object.assign(new Error(`Conteúdo do sandbox divergiu da proposta: ${change.path}`),{code:'sandbox_proposal_mismatch'});
      }
    }
    return {expectedPaths:[...expected.keys()],actualChangedPaths:actual.map(item=>item.path)};
  }

  static markValidation(id:string,userId:string,validation:unknown,projectId?:string){
    const record=this.assertAccess(id,userId,projectId);
    const status=(validation as any)?.status==='failed'?'failed':'validated';
    db.prepare('UPDATE sandboxes SET status=?,validation_json=?,updated_at=? WHERE id=?')
      .run(status,JSON.stringify(validation??null),new Date().toISOString(),record.id);
    return this.get(record.id);
  }

  static baseMatches(id:string,userId:string,projectId?:string){
    const record=this.assertAccess(id,userId,projectId);
    return this.projectFingerprint(record.projectId)===record.baseHash;
  }

  static mergeAtomic(input:{
    sandboxId:string;
    userId:string;
    projectId:string;
    title:string;
    description?:string;
    allowedChanges:Array<{path:string;action:string;content?:string}>;
  }) {
    const record=this.assertAccess(input.sandboxId,input.userId,input.projectId);
    const currentHash=this.projectFingerprint(input.projectId);
    if(currentHash!==record.baseHash){
      db.prepare("UPDATE sandboxes SET status='stale',updated_at=? WHERE id=?").run(new Date().toISOString(),record.id);
      throw Object.assign(new Error('A revisão-base mudou desde a criação da proposta.'),{code:'stale_base_revision'});
    }

    this.assertExpectedChanges(record.id,input.userId,input.projectId,input.allowedChanges,{allowExtraPaths:true});
    const normalizedChanges=input.allowedChanges.map(change=>({...change,path:ToolPolicy.normalizeRelativePath(change.path)}));
    const changedFiles=normalizedChanges
      .filter(change=>record.baseManifest[change.path]!==undefined || change.action!=='delete')
      .map(change=>({path:change.path,action:change.action==='update'?'modify':change.action}));
    let beforeCheckpointId:string|null=null;

    const official=WorkspaceManager.getProjectDir(input.projectId);
    const parent=path.dirname(official);
    const token=crypto.randomUUID();
    const stage=path.join(parent,`.merge-stage-${input.projectId}-${token}`);
    const backup=path.join(parent,`.merge-backup-${input.projectId}-${token}`);
    let backupCreated=false;
    let replacementActive=false;
    let checkpointId:string|null=null;

    try{
      fs.cpSync(official,stage,{recursive:true,force:true,filter:(sourcePath)=>safeOfficialStageCopyFilter(official,sourcePath)});
      for(const change of normalizedChanges){
        const target=safeJoin(stage,change.path);
        if(change.action==='delete'){
          if(fs.existsSync(target)){
            const stat=fs.lstatSync(target);
            if(stat.isDirectory())throw Object.assign(new Error(`Merge não remove diretório recursivamente: ${change.path}`),{code:'directory_delete_blocked'});
            fs.unlinkSync(target);
          }
          continue;
        }
        const source=safeJoin(record.rootPath,change.path);
        if(!fs.existsSync(source)||!fs.lstatSync(source).isFile()){
          throw Object.assign(new Error(`Arquivo do sandbox ausente no merge: ${change.path}`),{code:'sandbox_proposal_mismatch'});
        }
        fs.mkdirSync(path.dirname(target),{recursive:true});
        fs.copyFileSync(source,target);
      }

      // Close the TOCTOU window immediately before the directory swap.
      if(this.projectFingerprint(input.projectId)!==record.baseHash){
        db.prepare("UPDATE sandboxes SET status='stale',updated_at=? WHERE id=?").run(new Date().toISOString(),record.id);
        throw Object.assign(new Error('A revisão-base mudou durante a preparação do merge.'),{code:'stale_base_revision'});
      }

      beforeCheckpointId=WorkspaceManager.createCheckpoint(
        input.projectId,
        `Antes: ${input.title.slice(0,60)}`,
        'Checkpoint automático antes do merge atômico do sandbox.'
      );

      fs.renameSync(official,backup);
      backupCreated=true;
      fs.renameSync(stage,official);
      replacementActive=true;

      // Finalization is part of the merge transaction. Keep the backup until every
      // durable state update succeeds so a DB/context failure cannot leave a partial apply.
      ContextEngineV2.syncProject({projectId:input.projectId,files:WorkspaceManager.getAllFilesContent(input.projectId)});
      checkpointId=WorkspaceManager.createCheckpoint(
        input.projectId,
        input.title.slice(0,100),
        input.description||'Merge atômico aprovado a partir de sandbox validado.'
      );
      db.prepare("UPDATE sandboxes SET status='merged',merged_checkpoint_id=?,updated_at=? WHERE id=?")
        .run(checkpointId,new Date().toISOString(),record.id);

      const mergedHash=this.projectFingerprint(input.projectId);
      try{if(fs.existsSync(backup))fs.rmSync(backup,{recursive:true,force:true});}catch{}
      backupCreated=false;
      replacementActive=false;
      return {checkpointId,beforeCheckpointId:beforeCheckpointId!,changedFiles,baseHash:record.baseHash,mergedHash};
    }catch(error){
      try{if(fs.existsSync(stage))fs.rmSync(stage,{recursive:true,force:true});}catch{}

      if(backupCreated){
        try{
          if(replacementActive&&fs.existsSync(official))fs.rmSync(official,{recursive:true,force:true});
          if(fs.existsSync(backup))fs.renameSync(backup,official);
          replacementActive=false;
          backupCreated=false;
          try{ContextEngineV2.syncProject({projectId:input.projectId,files:WorkspaceManager.getAllFilesContent(input.projectId)});}catch{}
        }catch{}
      }

      if(checkpointId){
        try{db.prepare('DELETE FROM file_changes WHERE checkpoint_id=?').run(checkpointId);}catch{}
        try{db.prepare('DELETE FROM checkpoints WHERE id=?').run(checkpointId);}catch{}
      }
      if((error as any)?.code!=='stale_base_revision'){
        try{
          db.prepare("UPDATE sandboxes SET status='failed',merged_checkpoint_id=NULL,updated_at=? WHERE id=?")
            .run(new Date().toISOString(),record.id);
        }catch{}
      }
      throw error;
    }
  }

  static markRolledBack(id:string,userId:string,projectId:string){
    const record=this.get(id);
    if(!record) return null;
    if(record.userId!==userId||record.projectId!==projectId) return null;
    db.prepare("UPDATE sandboxes SET status='failed',merged_checkpoint_id=NULL,updated_at=? WHERE id=?")
      .run(new Date().toISOString(),id);
    return this.get(id);
  }

  static cleanup(id:string,userId:string){
    const record=this.get(id);
    if(!record||record.userId!==userId)return false;
    if(fs.existsSync(record.rootPath))fs.rmSync(record.rootPath,{recursive:true,force:true});
    db.prepare("UPDATE sandboxes SET status='cleaned',updated_at=? WHERE id=?").run(new Date().toISOString(),id);
    return true;
  }

  static recoverInterrupted() {
    const rows=db.prepare("SELECT * FROM sandboxes WHERE status IN ('active','validated','failed','interrupted')").all() as any[];
    let missing=0;
    for(const row of rows){
      if(!fs.existsSync(row.root_path)){
        db.prepare("UPDATE sandboxes SET status='interrupted',updated_at=? WHERE id=?").run(new Date().toISOString(),row.id);
        missing++;
      }
    }
    return {checked:rows.length,missing};
  }
}
