import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { ArchitectureGraphService } from './architectureGraph.js';
import { ContextCommitService } from './contextCommit.js';
import { ProjectFileIndex } from './projectFileIndex.js';
import type {
  ArchitectureEntity, ContextArchitectureSlice, ContextCompileInput, ContextFileSelection,
  ContextOmittedFile, ContextPack, ContextScope, ProjectFileRecord,
} from './types.js';

export const DEFAULT_CONTEXT_TOKEN_BUDGETS: Record<ContextScope,number> = {
  MICRO: 3500,
  LOCAL: 8000,
  TASK: 16000,
  PROJECT: 48000,
};

function tokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function metadataTokenEstimate(file: ProjectFileRecord) {
  return tokens([file.path,file.language,file.summary,file.symbols.join(' '),file.imports.join(' '),file.exports.join(' '),file.moduleKey].join('\n'));
}

function contentTokenEstimate(file: ProjectFileRecord, fileContents?: Record<string,string>) {
  const content = fileContents?.[file.path];
  if (typeof content === 'string') return tokens(content);
  return Math.max(1, Math.ceil(Math.max(0, file.sizeBytes) / 4));
}

function fileTokenEstimate(file: ProjectFileRecord, fileContents?: Record<string,string>) {
  return metadataTokenEstimate(file) + contentTokenEstimate(file, fileContents);
}

function words(input: string) {
  return [...new Set((input.toLowerCase().match(/[a-z0-9_.$/-]{3,}/g) || []).filter(word => !['para','com','the','and','from','this','that'].includes(word)))];
}

function architectureSlice(graph: ReturnType<typeof ArchitectureGraphService.build>, selectedPaths: Set<string>): ContextArchitectureSlice {
  const filterEntities = (entities: ArchitectureEntity[]) => entities.filter(entity => entity.files.some(file => selectedPaths.has(file)));
  return {
    graphHash:graph.hash,
    modules:filterEntities(graph.modules),
    services:filterEntities(graph.services),
    routes:filterEntities(graph.routes),
    models:filterEntities(graph.models),
    components:filterEntities(graph.components),
    integrations:filterEntities(graph.integrations),
    dependencies:graph.dependencies.filter(dep => selectedPaths.has(dep.from) || selectedPaths.has(dep.to)),
  };
}

export class ContextCompiler {
  static compile(input: ContextCompileInput): ContextPack {
    const files = ProjectFileIndex.list(input.projectId);
    const graph = ArchitectureGraphService.latest(input.projectId) || ArchitectureGraphService.buildAndPersist(input.projectId, files);
    const commits = ContextCommitService.listRecent(input.projectId, 100);
    const focus = new Set((input.focusPaths || []).map(item => item.replace(/\\/g,'/').replace(/^\.\//,'')));
    if (input.task.currentFile) focus.add(input.task.currentFile);
    for (const file of input.task.changedFiles || []) focus.add(file);

    const taskText = [input.task.title || '',input.task.objective,...(input.task.acceptanceCriteria || []),...(input.requirementIds || [])].join(' ');
    const taskWords = words(taskText);
    const recentRelevant = new Set<string>();
    for (const commit of commits) {
      const requirementMatch = (input.requirementIds || []).some(id => (commit.requirementIds || []).includes(id));
      if (requirementMatch || words(commit.task).some(word => taskWords.includes(word))) {
        for (const file of commit.changedFiles || []) recentRelevant.add(file);
      }
    }

    const neighborPaths = new Set<string>();
    for (const dep of graph.dependencies) {
      if (focus.has(dep.from)) neighborPaths.add(dep.to);
      if (focus.has(dep.to)) neighborPaths.add(dep.from);
    }

    const ranked: ContextFileSelection[] = files.map(file => {
      let score = 0;
      const reasons: string[] = [];
      if (focus.has(file.path)) { score += 1000; reasons.push('explicit_focus'); }
      if (neighborPaths.has(file.path)) { score += 180; reasons.push('dependency_neighbor'); }
      if (recentRelevant.has(file.path)) { score += 140; reasons.push('recent_requirement_context'); }

      const haystack = [file.path,file.moduleKey,file.summary,...file.symbols,...file.exports].join(' ').toLowerCase();
      const matches = taskWords.filter(word => haystack.includes(word));
      if (matches.length) {
        score += matches.length * 24;
        reasons.push(`task_match:${matches.slice(0,8).join(',')}`);
      }
      if (input.agentKey === 'STUDIO' && /\.(tsx|jsx|css|scss|vue|svelte|html)$/.test(file.path)) {
        score += 35; reasons.push('studio_visual');
      }
      if (input.agentKey === 'SENTINEL' && (focus.has(file.path) || recentRelevant.has(file.path))) {
        score += 30; reasons.push('sentinel_evidence');
      }
      if (input.agentKey === 'SCOUT') {
        score += file.moduleKey === 'root' ? 20 : 8; reasons.push('scout_structure');
      }
      return {file,score,reasons,estimatedTokens:fileTokenEstimate(file,input.fileContents)};
    }).sort((a,b) => b.score - a.score || a.file.path.localeCompare(b.file.path));

    const tokenBudget = Math.max(256, Math.floor(input.tokenBudget || DEFAULT_CONTEXT_TOKEN_BUDGETS[input.scope]));
    const selectedFiles: ContextFileSelection[] = [];
    const omittedFiles: ContextOmittedFile[] = [];
    let estimatedTokens = tokens(JSON.stringify({task:input.task,requirements:input.requirementIds || [],agent:input.agentKey,scope:input.scope}));

    for (const item of ranked) {
      const mustInclude = focus.has(item.file.path);
      const metadataCost = metadataTokenEstimate(item.file);
      const remaining = Math.max(0, tokenBudget - estimatedTokens);
      const content = input.fileContents?.[item.file.path];

      if (estimatedTokens + item.estimatedTokens <= tokenBudget) {
        const end = typeof content === 'string' ? content.length : item.file.sizeBytes;
        selectedFiles.push({
          ...item,
          content: {
            path:item.file.path,
            mode:'full',
            start:0,
            end,
            estimatedTokens:item.estimatedTokens,
            omittedChars:0,
            reason:'fits_budget',
          },
        });
        estimatedTokens += item.estimatedTokens;
      } else if (mustInclude && typeof content === 'string' && remaining > metadataCost + 16) {
        const availableContentTokens = Math.max(1, remaining - metadataCost);
        const end = Math.min(content.length, availableContentTokens * 4);
        const actualContentTokens = tokens(content.slice(0,end));
        const partialCost = metadataCost + actualContentTokens;
        selectedFiles.push({
          ...item,
          estimatedTokens:partialCost,
          reasons:[...new Set([...item.reasons,'partial_oversized_focus'])],
          content:{
            path:item.file.path,
            mode:'partial',
            start:0,
            end,
            estimatedTokens:partialCost,
            omittedChars:Math.max(0,content.length-end),
            reason:'oversized_focus',
          },
        });
        estimatedTokens += partialCost;
      } else {
        omittedFiles.push({path:item.file.path,estimatedTokens:item.estimatedTokens,reason:'budget_exhausted'});
      }
    }

    const selectedPaths = new Set(selectedFiles.map(item => item.file.path));
    const commitBudgetShare: Record<ContextScope,number> = {MICRO:.10,LOCAL:.15,TASK:.20,PROJECT:.25};
    const remainingCommitBudget = Math.max(0, tokenBudget - estimatedTokens);
    const maxCommitTokens = Math.min(remainingCommitBudget, Math.max(256, Math.floor(tokenBudget * commitBudgetShare[input.scope])));
    const recentCommits = [];
    let commitTokens = 0;
    for (const commit of commits) {
      const cost = tokens(JSON.stringify(commit));
      if (commitTokens + cost > maxCommitTokens) continue;
      const relevant = input.scope === 'PROJECT'
        || (commit.changedFiles || []).some(file => selectedPaths.has(file))
        || (input.requirementIds || []).some(id => (commit.requirementIds || []).includes(id));
      if (!relevant) continue;
      recentCommits.push(commit);
      commitTokens += cost;
    }
    estimatedTokens += commitTokens;

    const pack: ContextPack = {
      id:`ctx-pack-${crypto.randomUUID()}`,
      schemaVersion:2,
      projectId:input.projectId,
      runId:input.runId || null,
      stepId:input.stepId || null,
      agentKey:input.agentKey,
      scope:input.scope,
      task:input.task,
      requirementIds:input.requirementIds || [],
      selectedFiles,
      omittedFiles,
      architecture:architectureSlice(graph, selectedPaths),
      recentCommits,
      projectHash:ProjectFileIndex.fingerprint(files),
      tokenBudget,
      estimatedTokens,
      createdAt:new Date().toISOString(),
    };

    db.prepare(`INSERT INTO context_packs(
      id,project_id,run_id,step_id,agent_key,scope,project_hash,token_budget,estimated_tokens,
      selected_files_json,omitted_files_json,pack_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      pack.id,pack.projectId,pack.runId ?? null,pack.stepId ?? null,pack.agentKey,pack.scope,pack.projectHash,
      pack.tokenBudget,pack.estimatedTokens,
      JSON.stringify(pack.selectedFiles.map(item=>({path:item.file.path,score:item.score,reasons:item.reasons}))),
      JSON.stringify(pack.omittedFiles),JSON.stringify(pack),pack.createdAt
    );
    return pack;
  }

  static listTelemetry(projectId: string, limit = 50) {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    return (db.prepare('SELECT * FROM context_packs WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?').all(projectId,safeLimit) as any[]).map(row => ({
      id:row.id,projectId:row.project_id,runId:row.run_id,stepId:row.step_id,agentKey:row.agent_key,
      scope:row.scope,projectHash:row.project_hash,tokenBudget:Number(row.token_budget),
      estimatedTokens:Number(row.estimated_tokens),
      selectedFiles:JSON.parse(row.selected_files_json || '[]'),
      omittedFiles:JSON.parse(row.omitted_files_json || '[]'),
      createdAt:row.created_at,
    }));
  }

  static get(packId: string): ContextPack | null {
    const row = db.prepare('SELECT pack_json FROM context_packs WHERE id=?').get(packId) as any;
    return row ? JSON.parse(row.pack_json) as ContextPack : null;
  }
}
