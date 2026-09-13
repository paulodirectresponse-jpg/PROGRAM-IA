import test from 'node:test';
import assert from 'node:assert/strict';
import { db, initializeDatabase } from '../server/db/index.js';
import {
  ArchitectureGraphService, ContextCommitService, ContextCompiler, ContextEngineV2, ProjectFileIndex,
} from '../server/context-engine/contextEngine.js';

initializeDatabase();

function cleanup(projectId: string) {
  db.prepare('DELETE FROM context_packs WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM context_commits WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM context_architecture_graphs WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM context_project_files WHERE project_id=?').run(projectId);
}

test('phase1 project file index hashes, extracts symbols and invalidates incrementally', () => {
  const projectId=`phase1-index-${Date.now()}-${Math.random()}`;
  try {
    const first=ProjectFileIndex.syncProject(projectId,{
      'src/domain/Product.ts':`export interface Product { id:string }\nexport const makeProduct=()=>({id:'1'})`,
      'src/services/products.ts':`import { makeProduct } from '../domain/Product';\nexport function listProducts(){ return [makeProduct()]; }`,
    });
    assert.equal(first.changedPaths.length,2);
    const product=ProjectFileIndex.get(projectId,'src/domain/Product.ts');
    assert.ok(product?.symbols.includes('Product'));
    assert.ok(product?.exports.includes('makeProduct'));

    const second=ProjectFileIndex.syncProject(projectId,{
      'src/domain/Product.ts':`export interface Product { id:string }\nexport const makeProduct=()=>({id:'1'})`,
      'src/services/products.ts':`import { makeProduct } from '../domain/Product';\nexport function listProducts(){ return [makeProduct(),makeProduct()]; }`,
    });
    assert.deepEqual(second.changedPaths,['src/services/products.ts']);
    assert.deepEqual(second.unchangedPaths,['src/domain/Product.ts']);
    assert.notEqual(first.projectHash,second.projectHash);

    const third=ProjectFileIndex.syncProject(projectId,{
      'src/domain/Product.ts':`export interface Product { id:string }\nexport const makeProduct=()=>({id:'1'})`,
    });
    assert.deepEqual(third.removedPaths,['src/services/products.ts']);
    assert.equal(third.totalFiles,1);
  } finally { cleanup(projectId); }
});

test('phase1 architecture graph classifies structure and resolves dependencies', () => {
  const projectId=`phase1-graph-${Date.now()}-${Math.random()}`;
  try {
    ProjectFileIndex.syncProject(projectId,{
      'src/domain/Product.ts':`export interface Product { id:string }`,
      'src/services/productService.ts':`import type { Product } from '../domain/Product'; export const save=(x:Product)=>x;`,
      'src/components/ProductForm.tsx':`import { save } from '../services/productService'; export function ProductForm(){ return null }`,
      'src/integrations/supabaseClient.ts':`import { createClient } from '@supabase/supabase-js'; export const client=createClient('x','y');`,
      'src/routes/products.route.ts':`import { save } from '../services/productService'; export const route=save;`,
    });
    const graph=ArchitectureGraphService.buildAndPersist(projectId);
    assert.ok(graph.models.some(item=>item.files.includes('src/domain/Product.ts')));
    assert.ok(graph.services.some(item=>item.files.includes('src/services/productService.ts')));
    assert.ok(graph.components.some(item=>item.files.includes('src/components/ProductForm.tsx')));
    assert.ok(graph.integrations.some(item=>item.files.includes('src/integrations/supabaseClient.ts')));
    assert.ok(graph.routes.some(item=>item.files.includes('src/routes/products.route.ts')));
    assert.ok(graph.dependencies.some(dep=>dep.from==='src/components/ProductForm.tsx'&&dep.to==='src/services/productService.ts'));
    assert.ok(graph.dependencies.some(dep=>dep.to==='pkg:@supabase/supabase-js'));
  } finally { cleanup(projectId); }
});

test('phase1 context commits persist decisions, requirements and next state', () => {
  const projectId=`phase1-commit-${Date.now()}-${Math.random()}`;
  try {
    const created=ContextCommitService.create({
      projectId,runId:'run-1',taskId:'task-1',agentKey:'FORGE',scope:'TASK',
      task:'Implementar cadastro de produto',decisions:['usar serviço de domínio'],
      changedFiles:['src/services/products.ts'],requirementIds:['REQ-001'],
      validation:{status:'passed'},blockers:[],nextState:{action:'verify-browser'},
    });
    const recent=ContextCommitService.listRecent(projectId);
    assert.equal(recent[0].id,created.id);
    assert.deepEqual(recent[0].requirementIds,['REQ-001']);
    assert.deepEqual(recent[0].nextState,{action:'verify-browser'});
  } finally { cleanup(projectId); }
});

test('phase1 context compiler has no file-count cap and preserves dependency evidence', () => {
  const projectId=`phase1-compile-${Date.now()}-${Math.random()}`;
  try {
    const files:Record<string,string>={
      'src/domain/Product.ts':`export interface Product { id:string }`,
      'src/services/productService.ts':`import type { Product } from '../domain/Product'; export const save=(x:Product)=>x;`,
      'src/components/ProductForm.tsx':`import { save } from '../services/productService'; export function ProductForm(){ return null }`,
    };
    for(let i=0;i<40;i++) files[`src/other/module-${i}.ts`]=`export const value${i}=${i};`;
    ContextEngineV2.syncProject({projectId,files});
    ContextCommitService.create({
      projectId,task:'Cadastro de produto',agentKey:'FORGE',scope:'TASK',
      changedFiles:['src/services/productService.ts'],requirementIds:['REQ-001'],decisions:['persistir produto'],
    });
    const pack=ContextCompiler.compile({
      projectId,agentKey:'FORGE',scope:'TASK',
      task:{objective:'Implementar cadastro de produto',currentFile:'src/components/ProductForm.tsx'},
      requirementIds:['REQ-001'],focusPaths:['src/components/ProductForm.tsx'],tokenBudget:50000,
    });
    const selected=pack.selectedFiles.map(item=>item.file.path);
    assert.ok(selected.includes('src/components/ProductForm.tsx'));
    assert.ok(selected.includes('src/services/productService.ts'));
    assert.equal(pack.omittedFiles.length,0);
    assert.equal(selected.length,43);
  } finally { cleanup(projectId); }
});

test('phase1 compiler makes context budget omissions explicit and persists telemetry', () => {
  const projectId=`phase1-budget-${Date.now()}-${Math.random()}`;
  try {
    const files:Record<string,string>={};
    for(let i=0;i<25;i++) files[`src/features/feature-${i}.ts`]=`export function feature${i}(){ return 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }`;
    ContextEngineV2.syncProject({projectId,files});
    const pack=ContextCompiler.compile({
      projectId,agentKey:'SCOUT',scope:'MICRO',task:{objective:'Entender feature 1'},tokenBudget:256,
    });
    assert.ok(pack.omittedFiles.length>0);
    assert.ok(pack.omittedFiles.every(item=>item.reason==='budget_exhausted'));
    const telemetry=ContextCompiler.listTelemetry(projectId);
    assert.equal(telemetry[0].id,pack.id);
    assert.equal(telemetry[0].tokenBudget,256);
  } finally { cleanup(projectId); }
});

test('phase1 database exposes context engine v2 tables', () => {
  const tables=new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(row=>row.name));
  for(const table of ['context_project_files','context_architecture_graphs','context_commits','context_packs']) assert.ok(tables.has(table),`missing ${table}`);
});
