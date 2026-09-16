import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface StorageSnapshot {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  freePercent: number;
}

export interface StorageCleanupReport {
  removedPaths: string[];
  reclaimedBytes: number;
  before: StorageSnapshot | null;
  after: StorageSnapshot | null;
}

const DATA_ROOT = path.resolve(process.env.FORGE_DATA_DIR || path.join(process.cwd(), '.data'));
const PROJECTS_ROOT = path.join(DATA_ROOT, 'projects');
const PREVIEW_TMP_ROOT = path.join(os.tmpdir(), 'forge-preview-runtimes');
const MIN_FREE_BYTES = Math.max(256 * 1024 * 1024, Number(process.env.FORGE_STORAGE_MIN_FREE_BYTES || 512 * 1024 * 1024));
const MIN_FREE_PERCENT = Math.max(2, Number(process.env.FORGE_STORAGE_MIN_FREE_PERCENT || 8));

function dirSize(target: string): number {
  try {
    if (!fs.existsSync(target)) return 0;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return 0;
    if (stat.isFile()) return stat.size;
    let total = 0;
    for (const entry of fs.readdirSync(target)) total += dirSize(path.join(target, entry));
    return total;
  } catch {
    return 0;
  }
}

function snapshot(target: string): StorageSnapshot | null {
  try {
    const stats = fs.statfsSync(target);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return { path: target, totalBytes, freeBytes, usedBytes, freePercent: totalBytes ? (freeBytes / totalBytes) * 100 : 0 };
  } catch {
    return null;
  }
}

function safeRemove(target: string, allowedRoot: string, report: StorageCleanupReport): void {
  const resolved = path.resolve(target);
  const root = path.resolve(allowedRoot);
  if (resolved === root || !resolved.startsWith(root + path.sep) || !fs.existsSync(resolved)) return;
  const bytes = dirSize(resolved);
  try {
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 2 });
    report.removedPaths.push(resolved);
    report.reclaimedBytes += bytes;
  } catch (error: any) {
    console.warn('Storage cleanup skipped:', resolved, String(error?.message || error));
  }
}

export class StorageGuard {
  static dataRoot(): string { return DATA_ROOT; }

  static evaluateCapacity(
    info: StorageSnapshot,
    thresholds: { minFreeBytes?: number; minFreePercent?: number } = {},
  ): { ok: boolean; minFreeBytes: number; minFreePercent: number; reason?: string } {
    const minFreeBytes = Math.max(0, Number(thresholds.minFreeBytes ?? MIN_FREE_BYTES));
    const minFreePercent = Math.max(0, Number(thresholds.minFreePercent ?? MIN_FREE_PERCENT));
    if (info.freeBytes < minFreeBytes || info.freePercent < minFreePercent) {
      const freeMb = Math.round(info.freeBytes / 1024 / 1024);
      return {
        ok: false,
        minFreeBytes,
        minFreePercent,
        reason: `${freeMb} MB livres (${info.freePercent.toFixed(1)}%), mínimo exigido ${Math.round(minFreeBytes / 1024 / 1024)} MB / ${minFreePercent.toFixed(1)}%`,
      };
    }
    return { ok: true, minFreeBytes, minFreePercent };
  }
  static previewTempRoot(): string { return PREVIEW_TMP_ROOT; }
  static inspect(): { persistent: StorageSnapshot | null; temporary: StorageSnapshot | null } {
    return { persistent: snapshot(DATA_ROOT), temporary: snapshot(os.tmpdir()) };
  }

  static cleanupDerivedArtifacts(): StorageCleanupReport {
    const report: StorageCleanupReport = { removedPaths: [], reclaimedBytes: 0, before: snapshot(DATA_ROOT), after: null };

    // Preview runtimes are disposable copies and must never survive a process restart.
    if (fs.existsSync(PREVIEW_TMP_ROOT)) {
      try {
        const bytes = dirSize(PREVIEW_TMP_ROOT);
        fs.rmSync(PREVIEW_TMP_ROOT, { recursive: true, force: true, maxRetries: 2 });
        report.removedPaths.push(PREVIEW_TMP_ROOT);
        report.reclaimedBytes += bytes;
      } catch (error: any) {
        console.warn('Preview temp cleanup skipped:', String(error?.message || error));
      }
    }

    // node_modules is a reproducible dependency artifact. Old versions of the
    // preview engine installed it inside persistent project workspaces. Remove
    // only that derived directory; source files, uploads and checkpoints stay intact.
    if (fs.existsSync(PROJECTS_ROOT)) {
      for (const project of fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
        if (!project.isDirectory() || project.isSymbolicLink()) continue;
        safeRemove(path.join(PROJECTS_ROOT, project.name, 'node_modules'), path.join(PROJECTS_ROOT, project.name), report);
      }
    }

    report.after = snapshot(DATA_ROOT);
    return report;
  }

  static assertCapacity(target: 'persistent' | 'temporary', operation: string): StorageSnapshot {
    const root = target === 'persistent' ? DATA_ROOT : os.tmpdir();
    const info = snapshot(root);
    if (!info) throw new Error(`Não foi possível verificar o armazenamento ${target} antes de ${operation}.`);
    const evaluated = this.evaluateCapacity(info);
    if (!evaluated.ok) {
      throw new Error(`Armazenamento ${target} insuficiente para ${operation}: ${evaluated.reason}.`);
    }
    return info;
  }

  static startup(): StorageCleanupReport {
    const report = this.cleanupDerivedArtifacts();
    const after = this.inspect();
    console.log('FORGE_STORAGE_STARTUP', JSON.stringify({
      reclaimedBytes: report.reclaimedBytes,
      removedCount: report.removedPaths.length,
      persistent: after.persistent && { freeBytes: after.persistent.freeBytes, freePercent: Number(after.persistent.freePercent.toFixed(2)) },
      temporary: after.temporary && { freeBytes: after.temporary.freeBytes, freePercent: Number(after.temporary.freePercent.toFixed(2)) },
    }));
    return report;
  }
}
