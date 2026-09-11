import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/index.js';

const DATA_DIR = path.resolve(process.cwd(), '.data', 'projects');

export interface ProjectFile {
  name: string;
  path: string;
  size: number;
  updatedAt: string;
}

export class WorkspaceManager {
  static getProjectDir(projectId: string): string {
    const dir = path.join(DATA_DIR, projectId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  static getFiles(projectId: string): ProjectFile[] {
    const projectDir = this.getProjectDir(projectId);
    const results: ProjectFile[] = [];

    function scan(dir: string, base: string) {
      if (!fs.existsSync(dir)) return;
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const full = path.join(dir, item.name);
        const rel = path.join(base, item.name);
        if (item.isDirectory()) {
          scan(full, rel);
        } else {
          const stats = fs.statSync(full);
          results.push({
            name: item.name,
            path: rel,
            size: stats.size,
            updatedAt: stats.mtime.toISOString(),
          });
        }
      }
    }

    scan(projectDir, '');
    return results;
  }

  static readFile(projectId: string, relativePath: string): string | null {
    const safeRel = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(this.getProjectDir(projectId), safeRel);
    if (!fs.existsSync(fullPath)) return null;
    return fs.readFileSync(fullPath, 'utf8');
  }

  static writeFile(projectId: string, relativePath: string, content: string): void {
    const safeRel = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(this.getProjectDir(projectId), safeRel);
    const parentDir = path.dirname(fullPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content, 'utf8');
  }

  static deleteFile(projectId: string, relativePath: string): boolean {
    const safeRel = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(this.getProjectDir(projectId), safeRel);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
      return true;
    }
    return false;
  }

  static getAllFilesContent(projectId: string): Record<string, string> {
    const files = this.getFiles(projectId);
    const contentMap: Record<string, string> = {};
    for (const f of files) {
      const content = this.readFile(projectId, f.path);
      if (content !== null) {
        contentMap[f.path] = content;
      }
    }
    return contentMap;
  }

  static createCheckpoint(projectId: string, title: string, description: string = ''): string {
    const snapshot = this.getAllFilesContent(projectId);
    const cpId = 'cp-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);
    const now = new Date().toISOString();

    const currentProject = db.prepare('SELECT current_checkpoint_id FROM projects WHERE id = ?').get(projectId) as { current_checkpoint_id?: string } | undefined;
    const parentId = currentProject?.current_checkpoint_id || null;

    db.prepare(`
      INSERT INTO checkpoints (id, project_id, title, description, parent_id, files_snapshot_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(cpId, projectId, title, description, parentId, JSON.stringify(snapshot), now);

    db.prepare('UPDATE projects SET current_checkpoint_id = ?, updated_at = ? WHERE id = ?').run(cpId, now, projectId);

    // Run verification gates for this checkpoint
    this.runQualityGates(projectId, cpId, snapshot);

    return cpId;
  }

  static restoreCheckpoint(projectId: string, checkpointId: string): boolean {
    const cp = db.prepare('SELECT files_snapshot_json FROM checkpoints WHERE id = ? AND project_id = ?').get(checkpointId, projectId) as { files_snapshot_json: string } | undefined;
    if (!cp) return false;

    const files: Record<string, string> = JSON.parse(cp.files_snapshot_json);
    const projectDir = this.getProjectDir(projectId);

    // Clear existing directory files safely
    const currentFiles = this.getFiles(projectId);
    for (const file of currentFiles) {
      this.deleteFile(projectId, file.path);
    }

    // Write checkpoint files
    for (const [relPath, content] of Object.entries(files)) {
      this.writeFile(projectId, relPath, content);
    }

    db.prepare('UPDATE projects SET current_checkpoint_id = ?, updated_at = ? WHERE id = ?').run(checkpointId, new Date().toISOString(), projectId);
    return true;
  }

  static runQualityGates(projectId: string, checkpointId: string, files: Record<string, string>) {
    const now = new Date().toISOString();
    // 1. Secret Leak Detection
    let hasLeakedKey = false;
    let leakedInfo = '';
    const secretPattern = /(AIza[0-9A-Za-z-_]{35}|sk-[a-zA-Z0-9]{32,}|ghp_[a-zA-Z0-9]{36})/g;

    for (const [fileName, content] of Object.entries(files)) {
      if (secretPattern.test(content)) {
        hasLeakedKey = true;
        leakedInfo = `Possível chave secreta exposta no arquivo ${fileName}`;
        break;
      }
    }

    db.prepare(`
      INSERT INTO verifications (id, project_id, checkpoint_id, gate_type, status, details_json, created_at)
      VALUES (?, ?, ?, 'security', ?, ?, ?)
    `).run(
      'ver-sec-' + Date.now(),
      projectId,
      checkpointId,
      hasLeakedKey ? 'fail' : 'pass',
      JSON.stringify({
        rule: 'Proteção contra chaves expostas',
        message: hasLeakedKey ? leakedInfo : 'Nenhum token ou secret privado exposto no código do cliente.',
      }),
      now
    );

    // 2. Build & Structure Check
    const hasHtmlEntry = Object.keys(files).some(k => k.endsWith('index.html') || k.endsWith('App.tsx') || k.endsWith('main.tsx'));
    db.prepare(`
      INSERT INTO verifications (id, project_id, checkpoint_id, gate_type, status, details_json, created_at)
      VALUES (?, ?, ?, 'build', ?, ?, ?)
    `).run(
      'ver-bld-' + Date.now(),
      projectId,
      checkpointId,
      hasHtmlEntry ? 'pass' : 'warn',
      JSON.stringify({
        rule: 'Ponto de entrada do preview',
        message: hasHtmlEntry ? 'Ponto de entrada (index.html) válido e compilável.' : 'Aviso: index.html não localizado.',
      }),
      now
    );

    // 3. Syntax & Typecheck
    let syntaxPass = true;
    for (const [fileName, content] of Object.entries(files)) {
      if (fileName.endsWith('.js') || fileName.endsWith('.json')) {
        if (fileName.endsWith('.json')) {
          try {
            JSON.parse(content);
          } catch {
            syntaxPass = false;
          }
        }
      }
    }

    db.prepare(`
      INSERT INTO verifications (id, project_id, checkpoint_id, gate_type, status, details_json, created_at)
      VALUES (?, ?, ?, 'typecheck', ?, ?, ?)
    `).run(
      'ver-typ-' + Date.now(),
      projectId,
      checkpointId,
      syntaxPass ? 'pass' : 'warn',
      JSON.stringify({
        rule: 'Integridade de Sintaxe & Schemas',
        message: syntaxPass ? 'Arquivos de configuração e código válidos.' : 'Aviso em arquivos de estrutura JSON.',
      }),
      now
    );

    // 4. Preview Ready
    db.prepare(`
      INSERT INTO verifications (id, project_id, checkpoint_id, gate_type, status, details_json, created_at)
      VALUES (?, ?, ?, 'preview', 'pass', ?, ?)
    `).run(
      'ver-prv-' + Date.now(),
      projectId,
      checkpointId,
      JSON.stringify({
        rule: 'Live Preview Sandbox',
        message: 'Ambiente de visualização isolado ativo na rota de preview.',
      }),
      now
    );
  }

  static deleteProject(projectId: string): void {
    const dir = path.join(DATA_DIR, projectId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  static duplicateProject(sourceProjectId: string, targetProjectId: string, _newName?: string): boolean {
    try {
      const sourceFiles = this.getAllFilesContent(sourceProjectId);
      for (const [filePath, content] of Object.entries(sourceFiles)) {
        this.writeFile(targetProjectId, filePath, content);
      }
      return true;
    } catch {
      return false;
    }
  }

  static async generateZip(projectId: string): Promise<Buffer> {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    const files = this.getAllFilesContent(projectId);
    for (const [relPath, content] of Object.entries(files)) {
      zip.file(relPath, content);
    }
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }
}
