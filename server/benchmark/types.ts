import type { AgentMode } from '../services/llmAdapter.js';

export type BenchmarkCategory='planning'|'context'|'build'|'visual'|'repair'|'review';
export type BenchmarkStatus='queued'|'running'|'completed'|'failed'|'interrupted'|'cancelled'|'budget_exhausted';
export type BenchmarkCaseStatus='pending'|'running'|'passed'|'failed'|'interrupted'|'budget_exhausted';

export interface BenchmarkContentCheck {
  path:string;
  includes?:string[];
  excludes?:string[];
}

export interface BenchmarkChecks {
  minRequirements?:number;
  minTasks?:number;
  minAcceptanceCriteria?:number;
  requiredPlanTerms?:string[];
  replyIncludes?:string[];
  replyIncludesAny?:string[][];
  requiredPaths?:string[];
  allowedChangedPaths?:string[];
  forbiddenChangedPaths?:string[];
  content?:BenchmarkContentCheck[];
  requireApplySuccess?:boolean;
  requireValidatorPass?:boolean;
  requireBrowserPass?:boolean;
}

export interface BenchmarkCaseDefinition {
  id:string;
  title:string;
  category:BenchmarkCategory;
  mode:Exclude<AgentMode,'auto'|'publish'>;
  agentKey:'SCOUT'|'STUDIO'|'FORGE'|'SENTINEL';
  prompt:string;
  fixtureFiles:Record<string,string>;
  focusPaths?:string[];
  checks:BenchmarkChecks;
  weight?:number;
}

export interface BenchmarkCaseScore {
  score:number;
  passed:boolean;
  checks:Array<{key:string;passed:boolean;weight:number;detail?:string}>;
}

export interface BenchmarkRunSummary {
  totalCases:number;
  completedCases:number;
  passedCases:number;
  failedCases:number;
  passRate:number;
  averageScore:number;
  firstPassRate:number;
  expertEscalationRate:number;
  repairRate:number;
  verifiedRate:number;
  totalCostUsd:number;
  budgetCostUsd:number;
  unknownCostCalls:number;
  averageLatencyMs:number;
  providerBreakdown:Record<string,{cases:number;costUsd:number;budgetCostUsd:number;unknownCostCalls:number;passed:number}>;
  categoryBreakdown:Record<string,{cases:number;passed:number;averageScore:number}>;
}
