import crypto from 'node:crypto';
import path from 'node:path';
import { db } from '../db/index.js';
import { WorkspaceManager } from './workspaceManager.js';
import { ExecutionWorker, type WorkerResult } from './executionWorker.js';

export type ValidationStatus = 'passed' | 'failed' | 'unverified';
type SecurityResult = { status: 'pass' | 'fail'; issues: string[] };

export class ValidatorEngine {
  static lightweight(projectId: string) {
    const files = WorkspaceManager.getAllFilesContent(projectId);
    const names = new Set(Object.keys(files).map((name) => name.replace(/\\/g, '/')));
    const issues: string[] = [];
    const entry = ['index.html', 'public/index.html', 'src/index.html'].find((name) => names.has(name));

    if (!entry) issues.push('Nenhum arquivo HTML de entrada foi encontrado.');
    if (entry) {
      const html = files[entry] || '';
      if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) {
        issues.push(`${entry} não contém uma estrutura HTML completa.`);
      }
      for (const match of html.matchAll(/(?:src|href)=["']([^"'#?]+)["']/gi)) {
        const ref = match[1];
        if (/^(?:https?:|data:|mailto:|\/\/)/i.test(ref)) continue;
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry), ref.replace(/^\//, '')));
        if (!names.has(resolved)) issues.push(`Referência ausente: ${ref}`);
      }
    }

    for (const [fileName, source] of Object.entries(files)) {
      if (!fileName.endsWith('.json')) continue;
      try { JSON.parse(source); }
      catch { issues.push(`JSON inválido: ${fileName}`); }
    }

    return {
      status: issues.length ? 'warn' as const : 'pass' as const,
      checks: ['arquivo de entrada', 'estrutura HTML básica', 'paths locais referenciados', 'JSON parseável'],
      issues,
    };
  }

  static securityScan(projectId: string): SecurityResult {
    const files = WorkspaceManager.getAllFilesContent(projectId);
    const issues: string[] = [];
    const assignment = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|key)\b\s*[:=]\s*["'][^"'\r\n]{16,}["']/gi;
    for (const [fileName, source] of Object.entries(files)) {
      if (assignment.test(source)) issues.push(`Possível credencial exposta no arquivo ${fileName}`);
      assignment.lastIndex = 0;
    }
    return { status: issues.length ? 'fail' : 'pass', issues };
  }

  static async validate(input: {
    projectId: string;
    checkpointId?: string;
    runId?: string;
    stepId?: string;
    signal?: AbortSignal;
  }) {
    input.signal?.throwIfAborted();

    const security = this.securityScan(input.projectId);
    const securityNow = new Date().toISOString();
    db.prepare(
      'INSERT INTO verifications(id,project_id,checkpoint_id,gate_type,status,details_json,created_at) VALUES(?,?,?,?,?,?,?)'
    ).run(
      `ver-${crypto.randomUUID()}`,
      input.projectId,
      input.checkpointId || null,
      'security',
      security.status,
      JSON.stringify({ executed: true, issues: security.issues }),
      securityNow
    );

    if (security.status === 'fail') {
      return {
        passed: false,
        status: 'failed' as ValidationStatus,
        results: [] as WorkerResult[],
        security,
        advisory: this.lightweight(input.projectId),
      };
    }

    const dir = WorkspaceManager.getProjectDir(input.projectId);
    const results: WorkerResult[] = [];
    for (const tool of ['typecheck', 'build', 'test'] as const) {
      input.signal?.throwIfAborted();
      const result = await ExecutionWorker.run(dir, tool, input.signal);
      results.push(result);
      const now = new Date().toISOString();
      const persistedStatus = result.status === 'skipped' ? 'warn' : result.status;
      db.prepare(
        'INSERT INTO verifications(id,project_id,checkpoint_id,gate_type,status,details_json,created_at) VALUES(?,?,?,?,?,?,?)'
      ).run(
        `ver-${crypto.randomUUID()}`,
        input.projectId,
        input.checkpointId || null,
        tool,
        persistedStatus,
        JSON.stringify({
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          output: result.output.slice(-4000),
          executed: result.status !== 'skipped',
        }),
        now
      );
      db.prepare(
        'INSERT INTO tool_executions(id,run_id,step_id,tool_key,status,duration_ms,summary_json,created_at) VALUES(?,?,?,?,?,?,?,?)'
      ).run(
        `tool-${crypto.randomUUID()}`,
        input.runId || null,
        input.stepId || null,
        tool,
        result.status,
        result.durationMs,
        JSON.stringify({ exitCode: result.exitCode, output: result.output.slice(-4000) }),
        now
      );
      if (result.status === 'fail') break;
    }

    const executed = results.filter((result) => result.status !== 'skipped');
    const failed = executed.some((result) => result.status === 'fail');
    const status: ValidationStatus = failed ? 'failed' : executed.length === 0 ? 'unverified' : 'passed';

    return {
      passed: status === 'passed',
      status,
      results,
      security,
      advisory: status === 'unverified' ? this.lightweight(input.projectId) : undefined,
    };
  }
}
