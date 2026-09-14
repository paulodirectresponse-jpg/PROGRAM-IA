export type ToolRisk = 'read' | 'write' | 'process' | 'network';
export type ToolAvailability = 'ready' | 'requires_sandbox';
export type ToolResumePolicy = 'replay_safe' | 'inspect_only' | 'sandbox_required';
export type ToolExecutionStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'aborted' | 'blocked' | 'interrupted';

export type ToolInputType = 'string' | 'integer' | 'boolean';

export interface ToolInputField {
  type: ToolInputType;
  required?: boolean;
  min?: number;
  max?: number;
  description: string;
}

export interface ToolDefinition {
  key: string;
  version: string;
  description: string;
  risk: ToolRisk;
  availability: ToolAvailability;
  resumePolicy: ToolResumePolicy;
  inputSchema: Record<string, ToolInputField>;
}

export interface ToolExecutionContext {
  userId: string;
  projectId: string;
  runId?: string | null;
  stepId?: string | null;
  sandboxId?: string | null;
  signal?: AbortSignal;
}

export interface ToolExecutionRequest {
  toolKey: string;
  input: Record<string, unknown>;
  idempotencyKey?: string | null;
}

export interface ToolExecutionResult<T = unknown> {
  executionId: string;
  toolKey: string;
  toolVersion: string;
  status: ToolExecutionStatus;
  output?: T;
  errorCode?: string;
  message?: string;
  durationMs: number;
}

export interface ToolExecutionRecord {
  id: string;
  projectId?: string | null;
  runId?: string | null;
  stepId?: string | null;
  sandboxId?: string | null;
  toolKey: string;
  toolVersion: string;
  status: ToolExecutionStatus;
  durationMs: number;
  errorCode?: string | null;
  attemptIndex: number;
  idempotencyKey?: string | null;
  requestHash?: string | null;
  resumePolicy: ToolResumePolicy;
  summary: Record<string, unknown>;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}
