export type ContextScope = 'MICRO' | 'LOCAL' | 'TASK' | 'PROJECT';

export type ContextAgentKey = 'SCOUT' | 'STUDIO' | 'FORGE' | 'SENTINEL' | 'SHIP' | string;

export interface ProjectFileRecord {
  projectId: string;
  path: string;
  hash: string;
  sizeBytes: number;
  language: string;
  summary: string;
  symbols: string[];
  imports: string[];
  exports: string[];
  moduleKey: string;
  updatedAt: string;
}

export interface ProjectFileSyncResult {
  projectId: string;
  projectHash: string;
  changedPaths: string[];
  unchangedPaths: string[];
  removedPaths: string[];
  totalFiles: number;
}

export interface ArchitectureEntity {
  key: string;
  name: string;
  files: string[];
  kind: 'module' | 'service' | 'route' | 'model' | 'component' | 'integration';
}

export interface ArchitectureDependency {
  from: string;
  to: string;
  type: 'local_import' | 'package_import';
  source: string;
}

export interface ArchitectureGraph {
  projectId: string;
  hash: string;
  generatedAt: string;
  modules: ArchitectureEntity[];
  services: ArchitectureEntity[];
  routes: ArchitectureEntity[];
  models: ArchitectureEntity[];
  components: ArchitectureEntity[];
  integrations: ArchitectureEntity[];
  dependencies: ArchitectureDependency[];
}

export interface ContextCommitInput {
  projectId: string;
  runId?: string | null;
  taskId?: string | null;
  agentKey?: ContextAgentKey | null;
  scope?: ContextScope;
  task: string;
  decisions?: string[];
  changedFiles?: string[];
  requirementIds?: string[];
  validation?: unknown;
  blockers?: string[];
  nextState?: unknown;
}

export interface ContextCommitRecord extends ContextCommitInput {
  id: string;
  createdAt: string;
}

export interface ContextTask {
  id?: string;
  title?: string;
  objective: string;
  acceptanceCriteria?: string[];
  currentFile?: string;
  changedFiles?: string[];
}

export interface ContextCompileInput {
  projectId: string;
  agentKey: ContextAgentKey;
  scope: ContextScope;
  task: ContextTask;
  requirementIds?: string[];
  runId?: string | null;
  stepId?: string | null;
  focusPaths?: string[];
  tokenBudget?: number;
}

export interface ContextFileSelection {
  file: ProjectFileRecord;
  score: number;
  reasons: string[];
  estimatedTokens: number;
}

export interface ContextOmittedFile {
  path: string;
  estimatedTokens: number;
  reason: 'budget_exhausted';
}

export interface ContextArchitectureSlice {
  graphHash: string;
  modules: ArchitectureEntity[];
  services: ArchitectureEntity[];
  routes: ArchitectureEntity[];
  models: ArchitectureEntity[];
  components: ArchitectureEntity[];
  integrations: ArchitectureEntity[];
  dependencies: ArchitectureDependency[];
}

export interface ContextPack {
  id: string;
  schemaVersion: 2;
  projectId: string;
  runId?: string | null;
  stepId?: string | null;
  agentKey: ContextAgentKey;
  scope: ContextScope;
  task: ContextTask;
  requirementIds: string[];
  selectedFiles: ContextFileSelection[];
  omittedFiles: ContextOmittedFile[];
  architecture: ContextArchitectureSlice;
  recentCommits: ContextCommitRecord[];
  projectHash: string;
  tokenBudget: number;
  estimatedTokens: number;
  createdAt: string;
}
