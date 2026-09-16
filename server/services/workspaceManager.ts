import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { ContextEngineV2 } from '../context-engine/contextEngine.js';

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
  private static mutationListeners = new Set<(projectId: string) => void>();

  static onMutation(listener: (projectId: string) => void): () => void {
    this.mutationListeners.add(listener);
    return () => this.mutationListeners.delete(listener);
  }

  private static notifyMutation(projectId: string): void {
    for (const listener of this.mutationListeners) {
      queueMicrotask(() => {
        try { listener(projectId); } catch {}
      });
    }
  }

  private static syncContextIndex(projectId: string): void {
    try {
      ContextEngineV2.syncProject({ projectId, files: this.getAllFilesContent(projectId) });
    } catch {
      // Context index is operational memory; workspace mutations remain source of truth.
    }
  }

  static normalizeImportedFiles<T>(files: Record<string, T>): Record<string, T> {
    const entries = Object.entries(files).filter(([name]) => name && !name.endsWith('/'));
    if (!entries.length) return {};
    const normalized = entries.map(([name, value]) => [name.replace(/\\/g, '/').replace(/^\.\//, ''), value] as const);
    const roots = new Set(normalized.map(([name]) => name.split('/')[0]));
    const hasRootEntry = normalized.some(([name]) => !name.includes('/') || /^(src|public|dist|build)\//.test(name));
    const stripRoot = roots.size === 1 && !hasRootEntry && normalized.every(([name]) => name.includes('/'));
    return Object.fromEntries(normalized.map(([name, value]) => [stripRoot ? name.slice(name.indexOf('/') + 1) : name, value]));
  }

  static getPreviewInfo(projectId: string): { status: 'running' | 'error'; entryPath?: string; root?: string; message: string } {
    const files = this.getFiles(projectId).map(file => file.path.replace(/\\/g, '/'));
    // A package.json means the project has an executable framework/runtime contract.
    // Do not let a root/public index.html short-circuit RuntimeManager: Vite/React and
    // similar projects must be served by their real dev server, not as raw static HTML.
    if (files.includes('package.json')) {
      return { status: 'error', message: 'Projeto com package.json requer runtime de framework para o preview.' };
    }
    const candidates = ['index.html', 'dist/index.html', 'build/index.html', 'public/index.html'];
    const entryPath = candidates.find(candidate => files.includes(candidate)) || files.find(file => file.endsWith('/index.html'));
    if (entryPath) return { status: 'running', entryPath, root: path.posix.dirname(entryPath) === '.' ? '' : path.posix.dirname(entryPath), message: 'Preview pronto.' };
    return { status: 'error', message: 'Nenhum arquivo index.html foi encontrado neste projeto.' };
  }
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
        if (item.name === '.git' || item.name === 'node_modules' || item.name === '.DS_Store') continue;
        const full = path.join(dir, item.name);
        const rel = path.join(base, item.name).replace(/\\/g, '/');
        if (item.isDirectory()) scan(full, rel);
        else {
          const stats = fs.statSync(full);
          results.push({ name: item.name, path: rel, size: stats.size, isBinary: WorkspaceManager.isBinaryPath(rel), updatedAt: stats.mtime.toISOString() });
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
    if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    this.syncContextIndex(projectId);
    this.notifyMutation(projectId);
  }

  static writeBinaryFile(projectId: string, relativePath: string, buffer: Buffer): void {
    const fullPath = this.resolveSafePath(projectId, relativePath);
    const parentDir = path.dirname(fullPath);
    if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
    fs.writeFileSync(fullPath, buffer);
    this.syncContextIndex(projectId);
    this.notifyMutation(projectId);
  }

  static deleteFile(projectId: string, relativePath: string): boolean {
    const fullPath = this.resolveSafePath(projectId, relativePath);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
      this.syncContextIndex(projectId);
      this.notifyMutation(projectId);
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
        if (content !== null) contentMap[f.path] = content;
      }
    }
    return contentMap;
  }

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
    const currentFiles = this.getFiles(projectId);
    for (const file of currentFiles) if (stored.format === 2 || !file.isBinary) this.deleteFile(projectId, file.path);
    for (const [relPath, content] of Object.entries(files)) this.writeFile(projectId, relPath, content);
    for (const [rel, encoded] of Object.entries(binary)) this.writeBinaryFile(projectId,rel,Buffer.from(encoded,'base64'));
    this.createCheckpoint(projectId,`Restaurado: ${checkpointId}`,'Restauração local concluída. Sincronize para criar um novo commit no GitHub.');
    this.syncContextIndex(projectId);
    return true;
  }

  static deleteProject(projectId: string): void {
    const dir = this.getProjectDir(projectId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    this.notifyMutation(projectId);
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
      this.syncContextIndex(targetProjectId);
      return true;
    } catch { return false; }
  }

  static async importZip(projectId: string, zipBuffer: Buffer): Promise<{ fileCount: number; importedFiles: string[] }> {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(zipBuffer);
    const MAX_FILES = 1000;
    const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
    const ignored = (name: string) => name.includes('.git/') || name.includes('node_modules/') || name.includes('__MACOSX') || name.endsWith('.DS_Store') || name.endsWith('Thumbs.db');
    const candidates: Array<{ sourcePath: string; entry: any }> = [];
    zip.forEach((rawPath, entry) => {
      if (entry.dir) return;
      const originalPath = String((entry as any).unsafeOriginalName || rawPath).replace(/\\/g, '/');
      const originalSegments = originalPath.split('/');
      if (originalPath.startsWith('/') || originalPath.includes('\0') || originalSegments.some((segment) => segment === '..')) throw new Error(`Caminho inseguro detectado no ZIP: ${originalPath}`);
      const relPath = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
      const segments = relPath.split('/');
      if (!relPath || relPath.startsWith('/') || relPath.includes('\0') || segments.some((segment) => segment === '..' || segment === '')) throw new Error(`Caminho inseguro detectado no ZIP: ${rawPath}`);
      const permissions = typeof (entry as any).unixPermissions === 'number' ? (entry as any).unixPermissions : 0;
      if ((permissions & 0o170000) === 0o120000) throw new Error(`Link simbólico não permitido no ZIP: ${rawPath}`);
      if (ignored(relPath)) return;
      candidates.push({ sourcePath: relPath, entry });
      if (candidates.length > MAX_FILES) throw new Error(`Arquivo ZIP contém arquivos em excesso (limite: ${MAX_FILES}).`);
    });
    if (!candidates.length) throw new Error('O ZIP não contém arquivos importáveis.');
    const roots = new Set(candidates.map(({ sourcePath }) => sourcePath.split('/')[0]));
    const protectedRoots = new Set(['src', 'public', 'dist', 'build', 'app', 'pages', 'components', 'assets', 'server', 'client']);
    const onlyRoot = roots.size === 1 ? [...roots][0] : '';
    const stripWrapper = Boolean(onlyRoot && !protectedRoots.has(onlyRoot.toLowerCase()) && candidates.every(({ sourcePath }) => sourcePath.includes('/')));
    let totalBytes = 0;
    const importedFiles: string[] = [];
    for (const { sourcePath, entry } of candidates) {
      const targetPath = stripWrapper ? sourcePath.slice(sourcePath.indexOf('/') + 1) : sourcePath;
      this.resolveSafePath(projectId, targetPath);
      const buffer = await entry.async('nodebuffer');
      totalBytes += buffer.length;
      if (totalBytes > MAX_UNCOMPRESSED_BYTES) throw new Error('Tamanho total descompactado do ZIP excede o limite permitido (100MB).');
      this.writeBinaryFile(projectId, targetPath, buffer);
      importedFiles.push(targetPath);
    }
    this.createCheckpoint(projectId, 'Importação de Arquivo ZIP', `Importados ${importedFiles.length} arquivos com sucesso.`);
    this.syncContextIndex(projectId);
    return { fileCount: importedFiles.length, importedFiles };
  }

  static async generateZip(projectId: string): Promise<Buffer> {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    const files = this.getFiles(projectId);
    for (const f of files) {
      const fullPath = this.resolveSafePath(projectId, f.path);
      if (fs.existsSync(fullPath)) zip.file(f.path, fs.readFileSync(fullPath));
    }
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }
}
