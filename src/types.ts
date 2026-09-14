export type AgentMode = 'auto' | 'plan' | 'build' | 'review' | 'publish';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  created_at: string;
}

export interface SecretSummary {
  id: string;
  service_key: string;
  masked_hint: string;
  status: string;
  is_default: boolean;
  is_active: boolean;
  last_tested_at?: string;
  last_error?: string;
  updated_at: string;
}

export interface ConnectionTestResult {
  success: boolean;
  code: 'approved' | 'invalid_key' | 'invalid_model' | 'invalid_url' | 'network_error' | 'timeout' | 'incompatible_response';
  message: string;
  details?: any;
}

export interface FileChangeProposal {
  path: string;
  action: 'create' | 'modify' | 'delete';
  content: string;
  diff?: string;
}

export interface ChangeProposal {
  id: string;
  summary: string;
  diffSummary?: string;
  requiresConfirmation: boolean;
  files: FileChangeProposal[];
  status: 'pending' | 'previewing' | 'applied' | 'rejected' | 'failed_validation' | 'superseded';
  sandboxId?: string;
  baseRevision?: string;
  sandboxValidation?: unknown;
  toolExecutionIds?: string[];
}

export interface BrowserQualityIssue {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  viewport?: string;
  url?: string;
  resourceType?: string;
}

export interface BrowserViewportEvidence {
  name: string;
  width: number;
  height: number;
  finalUrl: string;
  title: string;
  bodyTextChars: number;
  interactiveCount: number;
  unlabeledInteractiveCount: number;
  imagesWithoutAlt: number;
  duplicateIds: string[];
  horizontalOverflowPx: number;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: Array<{url:string;resourceType:string;failure:string}>;
  badResponses: Array<{url:string;resourceType:string;status:number}>;
  blockedExternalRequests: string[];
  screenshotSha256?: string;
  screenshotBytes?: number;
}

export interface BrowserQualityResult {
  id: string;
  status: 'passed' | 'failed' | 'unverified' | 'skipped';
  projectId: string;
  sandboxId: string;
  runId?: string | null;
  stepId?: string | null;
  runtimeKind: 'static' | 'framework' | 'none';
  framework?: string;
  entryPath?: string;
  url?: string;
  issues: BrowserQualityIssue[];
  viewports: BrowserViewportEvidence[];
  durationMs: number;
  reason?: string;
  createdAt: string;
}

export interface Project {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  origin: 'novo' | 'local' | 'github';
  repo_url?: string;
  branch: string;
  status: 'active' | 'archived';
  current_checkpoint_id?: string;
  provider_id?: string;
  model_id?: string;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  project_id: string;
  title: string;
  mode: AgentMode;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender: 'user' | 'agent' | 'system';
  content: string;
  metadata_json?: string;
  created_at: string;
  metadata?: {
    mode?: AgentMode;
    appliedSkills?: string[];
    isDemonstrativeFallback?: boolean;
    providerUsed?: string;
    modelUsed?: string;
    planId?: string;
    plan?: Record<string, unknown>;
    checkpointId?: string;
    filesAffected?: string[];
    isWelcome?: boolean;
    proposal?: ChangeProposal;
    decisionType?: 'explanation' | 'plan' | 'change' | 'review' | 'publish';
    diffSummary?: string;
    hasErrors?: boolean;
    errorMessage?: string;
    runId?: string;
    agentKey?: string;
    profileKey?: string;
    workflow?: {
      runId?: string;
      status?: string;
      shipRequested?: boolean;
      steps?: string[];
      trace?: Array<{
        id: string;
        agent_key: string;
        title: string;
        status: string;
        attempt_count?: number;
        invocations?: Array<{
          id: string;
          profile_key?: string;
          provider_key?: string;
          model_id?: string;
          status?: string;
          error_code?: string;
          latency_ms?: number;
          cost_usd?: number;
        }>;
      }>;
    };
    validation?: {passed:boolean;status:'passed'|'failed'|'unverified';results:Array<{tool:string;status:string;summary?:string}>;advisory?:{status:string;checks:string[];issues:string[]}}|null;
    browserQuality?: BrowserQualityResult | null;
    browserRepair?: {
      attempted: boolean;
      status: string;
      profileKey?: string;
      files?: string[];
      error?: string;
    } | null;
  };
}

export interface Plan {
  id: string;
  task_id?: string;
  project_id: string;
  objective: string;
  scope_in: string;
  scope_out: string;
  files_affected_json: string;
  integrations_json?: string;
  risks_json?: string;
  acceptance_criteria_json: string;
  status: 'draft' | 'approved' | 'rejected';
  created_at: string;
  updated_at: string;
}

export interface Skill {
  id: string;
  user_id?: string;
  name: string;
  slug: string;
  description: string;
  system_instructions: string;
  scope: 'message' | 'project' | 'workspace';
  is_active: number | boolean;
  is_custom?: number | boolean;
  created_at: string;
}

export interface Provider {
  id: string;
  provider_key: string;
  name: string;
  base_url: string;
  model_id: string;
  is_configured: number | boolean;
  is_active: number | boolean;
  connection_status: 'untested' | 'connected' | 'not_configured' | 'error';
  context_limit: number;
  masked_hint?: string;
  last_verified_at?: string | null;
  last_error?: string | null;
  created_at: string;
}

export interface Checkpoint {
  id: string;
  project_id: string;
  title: string;
  description?: string;
  parent_id?: string;
  created_at: string;
}

export interface Verification {
  id: string;
  project_id: string;
  checkpoint_id?: string;
  gate_type: 'build' | 'typecheck' | 'lint' | 'security' | 'preview';
  status: 'pass' | 'fail' | 'warn';
  details_json?: string;
  created_at: string;
}

export interface ProjectFileItem {
  name: string;
  path: string;
  size: number;
  updatedAt: string;
}

export interface GitHubStatus {
  isConnected: boolean;
  status: 'connected' | 'pending_credentials' | 'invalid_token' | 'rate_limited';
  username?: string;
  avatarUrl?: string;
  scopes?: string[];
  missingConfig: string[];
  message: string;
}

export interface Integration {
  id: string;
  service_name: string;
  config_json: string;
  status: 'connected' | 'pending_credentials' | 'error';
  last_verified_at: string;
}

