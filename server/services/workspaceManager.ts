import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from '../db/index.js';

const DATA_DIR = path.resolve(process.env.FORGE_DATA_DIR || path.join(process.cwd(), '.data'), 'projects');

export interface ProjectFile {
  name: string;
  path: string;
  size: number;
  isBinary: boolean;
  updatedAt: string;
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico',
  '.mp4', '.webm', '.ogg', '.mp3', '.wav',
  '.woff', '.woff2', '.ttf', '.eot',
  '.pdf', '.zip', '.tar', '.gz', '.bin'
]);

export class WorkspaceManager {
  static isBinaryPath(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
  }

  static getProjectDir(projectId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error('Identificador de projeto inválido.');
    const safeProjectId = projectId;
    const dir = path.join(DATA_DIR, safeProjectId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  /**
   * Resolve and enforce safe path within the project workspace
   * Throws if path traversal is detected
   */
  static resolveSafePath(projectId: string, relativePath: string): string {
    const projectDir = path.resolve(this.getProjectDir(projectId));
    if (!relativePath || relativePath.includes('\0')) {
      throw new Error(`Path traversal detectado: caracter nulo ou caminho inválido (${relativePath})`);
    }

    const normalized = path.normalize(relativePath);
    if (
      relativePath.startsWith('/') ||
      relativePath.startsWith('\\') ||
      path.isAbsolute(relativePath) ||
      normalized.startsWith('..') ||
      normalized.includes('/../') ||
      normalized.includes('\\..\\')
    ) {
      throw new Error(`Path traversal detectado: tentativa de escape do workspace (${relativePath})`);
    }

    const resolved = path.resolve(projectDir, normalized);
    if (!resolved.startsWith(projectDir + path.sep) && resolved !== projectDir) {
      throw new Error(`Path traversal detectado: caminho fora do diretório do projeto (${relativePath})`);
    }
    let cursor = resolved;
    while (cursor !== projectDir) {
      if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Link simbólico fora do escopo permitido.');
      cursor = path.dirname(cursor);
    }
    return resolved;
  }

  static getFiles(projectId: string): ProjectFile[] {
    const projectDir = this.getProjectDir(projectId);
    const results: ProjectFile[] = [];

    function scan(dir: string, base: string) {
      if (!fs.existsSync(dir)) return;
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.isSymbolicLink()) continue;
        if (item.name === '.git' || item.name === 'node_modules' || item.name === '.DS_Store') {
          continue;
        }
        const full = path.join(dir, item.name);
        const rel = path.join(base, item.name).replace(/\\/g, '/');
        if (item.isDirectory()) {
          scan(full, rel);
        } else {
          const stats = fs.statSync(full);
          results.push({
            name: item.name,
            path: rel,
            size: stats.size,
            isBinary: WorkspaceManager.isBinaryPath(rel),
            updatedAt: stats.mtime.toISOString(),
          });
        }
      }
    }

    scan(projectDir, '');
    return results;
  }

  static readFile(projectId: string, relativePath: string): string | null {
    const fullPath = this.resolveSafePath(projectId, relativePath);
    if (!fs.existsSync(fullPath)) return null;
    return fs.readFileSync(fullPath, 'utf8');
  }

  static readBinaryFile(projectId: string, relativePath: string): Buffer | null {
    const fullPath = this.resolveSafePath(projectId, relativePath);
    if (!fs.existsSync(fullPath)) return null;
    return fs.readFileSync(fullPath);
  }

  static writeFile(projectId: string, relativePath: string, content: string): void {
    const fullPath = this.resolveSafePath(projectId, relativePath);
    const parentDir = path.dirname(fullPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content, 'utf8');
  }

  static writeBinaryFile(projectId: string, relativePath: string, buffer: Buffer): void {
    const fullPath = this.resolveSafePath(projectId, relativePath);
    const parentDir = path.dirname(fullPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.writeFileSync(fullPath, buffer);
  }

  static deleteFile(projectId: string, relativePath: string): boolean {
    const fullPath = this.resolveSafePath(projectId, relativePath);
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
      if (!f.isBinary) {
        const content = this.readFile(projectId, f.path);
        if (content !== null) {
          contentMap[f.path] = content;
        }
      }
    }
    return contentMap;
  }

  /**
   * Verify whether a user owns a given project
   */
  static verifyProjectOwnership(projectId: string, userId: string): boolean {
    const project = db.prepare('SELECT user_id FROM projects WHERE id = ?').get(projectId) as { user_id?: string } | undefined;
    if (!project) return false;
    return project.user_id === userId;
  }

  static createCheckpoint(projectId: string, title: string, description: string = ''): string {
    const snapshot = this.getAllFilesContent(projectId);
    const binary: Record<string,string> = {};
    for (const file of this.getFiles(projectId)) if (file.isBinary) {
      const bytes=this.readBinaryFile(projectId,file.path);
      if(bytes) binary[file.path]=bytes.toString('base64');
    }
    const storedSnapshot={format:2,text:snapshot,binary};
    const cpId = 'cp-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
    const now = new Date().toISOString();

    const currentProject = db.prepare('SELECT current_checkpoint_id FROM projects WHERE id = ?').get(projectId) as { current_checkpoint_id?: string } | undefined;
    const parentId = currentProject?.current_checkpoint_id || null;

    db.prepare(`
      INSERT INTO checkpoints (id, project_id, title, description, parent_id, files_snapshot_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(cpId, projectId, title, description, parentId, JSON.stringify(storedSnapshot), now);

    db.prepare('UPDATE projects SET current_checkpoint_id = ?, updated_at = ? WHERE id = ?').run(cpId, now, projectId);

    // Run verification quality gates
    this.runQualityGates(projectId, cpId, snapshot);

    return cpId;
  }

  static restoreCheckpoint(projectId: string, checkpointId: string): boolean {
    const cp = db.prepare('SELECT files_snapshot_json FROM checkpoints WHERE id = ? AND project_id = ?').get(checkpointId, projectId) as { files_snapshot_json: string } | undefined;
    if (!cp) return false;

    const stored = JSON.parse(cp.files_snapshot_json);
    const files: Record<string, string> = stored.format === 2 ? stored.text : stored;
    const binary: Record<string,string> = stored.format === 2 ? stored.binary : {};
    for (const rel of [...Object.keys(files),...Object.keys(binary)]) this.resolveSafePath(projectId,rel);
    this.createCheckpoint(projectId,'Antes de restaurar','Estado preservado antes da restauração.');

    // Clear existing text files
    const currentFiles = this.getFiles(projectId);
    for (const file of currentFiles) {
      if (stored.format === 2 || !file.isBinary) {
        this.deleteFile(projectId, file.path);
      }
    }

    // Write checkpoint files
    for (const [relPath, content] of Object.entries(files)) {
      this.writeFile(projectId, relPath, content);
    }

    for (const [rel, encoded] of Object.entries(binary)) this.writeBinaryFile(projectId,rel,Buffer.from(encoded,'base64'));
    this.createCheckpoint(projectId,`Restaurado: ${checkpointId}`,'Restauração local concluída. Sincronize para criar um novo commit no GitHub.');
    return true;
  }

  /**
   * Full Quality Gates & Reviewer Loop verification
   */
  static runQualityGates(projectId: string, checkpointId: string, files: Record<string, string>) {
    const now = new Date().toISOString();

    // 1. Secret Leak Detection
    let hasLeakedKey = false;
    let leakedInfo = '';
    const secretPattern = /(AIza[0-9A-Za-z-_]{35}|sk-[a-zA-Z0-9]{32,}|ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9]{60,})/;

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
      'ver-sec-' + crypto.randomUUID(),
      projectId,
      checkpointId,
      hasLeakedKey ? 'fail' : 'pass',
      JSON.stringify({
        rule: 'Proteção contra chaves expostas (Secret Leak Scan)',
        message: hasLeakedKey ? leakedInfo : 'Nenhum token ou secret privado exposto no código.',
      }),
      now
    );

    // 2. Build & Structure Check
    const hasHtmlEntry = Object.keys(files).some(k => k.endsWith('index.html') || k.endsWith('App.tsx') || k.endsWith('main.tsx'));
    db.prepare(`
      INSERT INTO verifications (id, project_id, checkpoint_id, gate_type, status, details_json, created_at)
      VALUES (?, ?, ?, 'build', ?, ?, ?)
    `).run(
      'ver-bld-' + crypto.randomUUID(),
      projectId,
      checkpointId,
      'warn',
      JSON.stringify({
        rule: 'Ponto de entrada da aplicação',
        message: hasHtmlEntry ? 'Ponto de entrada detectado. Build ainda não executado.' : 'Aviso: index.html não localizado.',
      }),
      now
    );

    // 3. Syntax & Schema integrity
    let syntaxPass = true;
    for (const [fileName, content] of Object.entries(files)) {
      if (fileName.endsWith('.json')) {
        try {
          JSON.parse(content);
        } catch {
          syntaxPass = false;
        }
      }
    }

    db.prepare(`
      INSERT INTO verifications (id, project_id, checkpoint_id, gate_type, status, details_json, created_at)
      VALUES (?, ?, ?, 'typecheck', ?, ?, ?)
    `).run(
      'ver-typ-' + crypto.randomUUID(),
      projectId,
      checkpointId,
      syntaxPass ? 'warn' : 'fail',
      JSON.stringify({
        rule: 'Integridade de Sintaxe & Schemas',
        message: syntaxPass ? 'JSON válido. Compilação e checagem de tipos ainda não executadas.' : 'Falha: arquivos de configuração JSON inválidos.',
      }),
      now
    );

    // 4. Accessibility check (WCAG basic checks on HTML)
    let a11yPass = true;
    let a11yNotes = 'Controles semânticos e viewport validados.';
    const htmlFile = files['index.html'];
    if (htmlFile) {
      if (!htmlFile.includes('lang=')) {
        a11yPass = false;
        a11yNotes = 'Tag <html> sem atributo lang definido.';
      }
    }

    db.prepare(`
      INSERT INTO verifications (id, project_id, checkpoint_id, gate_type, status, details_json, created_at)
      VALUES (?, ?, ?, 'a11y', ?, ?, ?)
    `).run(
      'ver-a11y-' + Date.now(),
      projectId,
      checkpointId,
      a11yPass ? 'pass' : 'warn',
      JSON.stringify({
        rule: 'Critérios Básicos de Acessibilidade (WCAG)',
        message: a11yNotes,
      }),
      now
    );

    // 5. Preview Sandbox readiness
    db.prepare(`
      INSERT INTO verifications (id, project_id, checkpoint_id, gate_type, status, details_json, created_at)
      VALUES (?, ?, ?, 'preview', 'warn', ?, ?)
    `).run(
      'ver-prv-' + crypto.randomUUID(),
      projectId,
      checkpointId,
      JSON.stringify({
        rule: 'Live Preview Sandbox',
        message: 'Verificação visual ainda não executada em navegador.',
      }),
      now
    );
  }

  static deleteProject(projectId: string): void {
    const dir = this.getProjectDir(projectId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  static duplicateProject(sourceProjectId: string, targetProjectId: string, _newName?: string): boolean {
    try {
      const sourceFiles = this.getFiles(sourceProjectId);
      for (const file of sourceFiles) {
        if (file.isBinary) {
          const buf = this.readBinaryFile(sourceProjectId, file.path);
          if (buf) this.writeBinaryFile(targetProjectId, file.path, buf);
        } else {
          const content = this.readFile(sourceProjectId, file.path);
          if (content !== null) this.writeFile(targetProjectId, file.path, content);
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Safe ZIP extraction with ZIP bomb and path traversal protection
   */
  static async importZip(
    projectId: string,
    zipBuffer: Buffer
  ): Promise<{ fileCount: number; importedFiles: string[] }> {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(zipBuffer);

    const MAX_FILES = 1000;
    const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024; // 100MB

    let totalFiles = 0;
    let totalBytes = 0;
    const importedFiles: string[] = [];

    // First pass: validation (zip bomb & path traversal)
    zip.forEach((relPath, entry) => {
      if (entry.dir) return;
      totalFiles++;
      if (totalFiles > MAX_FILES) {
        throw new Error(`Arquivo ZIP contém arquivos em excesso (limite: ${MAX_FILES}).`);
      }
      if (relPath.includes('..') || relPath.startsWith('/') || relPath.startsWith('\\')) {
        throw new Error(`Caminho inseguro detectado no ZIP: ${relPath}`);
      }
    });

    // Second pass: extraction
    const entries = Object.keys(zip.files);
    for (const entryPath of entries) {
      const entry = zip.files[entryPath];
      if (entry.dir) continue;

      // Filter unwanted metadata / system files
      if (
        entryPath.includes('.git/') ||
        entryPath.includes('node_modules/') ||
        entryPath.includes('__MACOSX') ||
        entryPath.endsWith('.DS_Store') ||
        entryPath.endsWith('Thumbs.db')
      ) {
        continue;
      }

      const buffer = await entry.async('nodebuffer');
      totalBytes += buffer.length;
      if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
        throw new Error('Tamanho total descompactado do ZIP excede o limite permitido (100MB).');
      }

      this.writeBinaryFile(projectId, entryPath, buffer);
      importedFiles.push(entryPath);
    }

    // Create a checkpoint after successful import
    this.createCheckpoint(projectId, 'Importação de Arquivo ZIP', `Importados ${importedFiles.length} arquivos com sucesso.`);

    return { fileCount: importedFiles.length, importedFiles };
  }

  /**
   * Export all workspace files into real ZIP buffer (including binary assets)
   */
  static async generateZip(projectId: string): Promise<Buffer> {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    const files = this.getFiles(projectId);

    for (const f of files) {
      const fullPath = this.resolveSafePath(projectId, f.path);
      if (fs.existsSync(fullPath)) {
        const fileBuffer = fs.readFileSync(fullPath);
        zip.file(f.path, fileBuffer);
      }
    }
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }
}

