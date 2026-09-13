import crypto from 'node:crypto';
import path from 'node:path';
import { db } from '../db/index.js';
import type { ProjectFileRecord, ProjectFileSyncResult } from './types.js';

const SOURCE_EXTENSIONS = new Set([
  '.ts','.tsx','.js','.jsx','.mjs','.cjs','.json','.css','.scss','.sass','.less',
  '.html','.htm','.md','.mdx','.sql','.py','.go','.rs','.java','.kt','.swift',
  '.vue','.svelte','.yml','.yaml','.toml','.sh','.bash','.zsh','.txt',
]);

function normalizePath(input: string) {
  const normalized = input.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`Invalid project file path: ${input}`);
  }
  return normalized;
}

function sha256(input: string) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function languageFor(filePath: string) {
  const ext = path.posix.extname(filePath).toLowerCase();
  const names: Record<string,string> = {
    '.ts':'typescript','.tsx':'typescript-react','.js':'javascript','.jsx':'javascript-react',
    '.mjs':'javascript','.cjs':'javascript','.json':'json','.css':'css','.scss':'scss',
    '.sass':'sass','.less':'less','.html':'html','.htm':'html','.md':'markdown','.mdx':'mdx',
    '.sql':'sql','.py':'python','.go':'go','.rs':'rust','.java':'java','.kt':'kotlin',
    '.swift':'swift','.vue':'vue','.svelte':'svelte','.yml':'yaml','.yaml':'yaml',
    '.toml':'toml','.sh':'shell','.bash':'shell','.zsh':'shell','.txt':'text',
  };
  return names[ext] || (ext ? ext.slice(1) : 'text');
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function extractImports(content: string) {
  const imports: string[] = [];
  const patterns = [
    /\bimport\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of content.matchAll(pattern)) imports.push(match[1]);
  return unique(imports);
}

function extractExports(content: string) {
  const exports: string[] = [];
  for (const match of content.matchAll(/\bexport\s+(?:async\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) exports.push(match[1]);
  for (const match of content.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/i).pop()?.trim();
      if (name) exports.push(name);
    }
  }
  if (/\bexport\s+default\b/.test(content)) exports.push('default');
  return unique(exports);
}

function extractSymbols(content: string) {
  const symbols: string[] = [];
  const pattern = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of content.matchAll(pattern)) symbols.push(match[1]);
  return unique(symbols);
}

function moduleKeyFor(filePath: string) {
  const parts = filePath.split('/');
  if (parts.length <= 1) return 'root';
  if (parts[0] === 'src' && parts.length > 2) return parts.slice(0, 2).join('/');
  return parts.slice(0, Math.min(parts.length - 1, 2)).join('/') || 'root';
}

function summaryFor(filePath: string, language: string, symbols: string[], imports: string[], exports: string[]) {
  return [
    `${language} file ${filePath}`,
    symbols.length ? `symbols: ${symbols.slice(0, 12).join(', ')}` : '',
    exports.length ? `exports: ${exports.slice(0, 12).join(', ')}` : '',
    imports.length ? `imports: ${imports.slice(0, 12).join(', ')}` : '',
  ].filter(Boolean).join('; ');
}

function parseRow(row: any): ProjectFileRecord {
  return {
    projectId: row.project_id,
    path: row.path,
    hash: row.hash,
    sizeBytes: Number(row.size_bytes || 0),
    language: row.language,
    summary: row.summary,
    symbols: JSON.parse(row.symbols_json || '[]'),
    imports: JSON.parse(row.imports_json || '[]'),
    exports: JSON.parse(row.exports_json || '[]'),
    moduleKey: row.module_key,
    updatedAt: row.updated_at,
  };
}

export class ProjectFileIndex {
  static inspect(projectId: string, filePath: string, content: string): ProjectFileRecord {
    const normalizedPath = normalizePath(filePath);
    const language = languageFor(normalizedPath);
    const imports = extractImports(content);
    const exports = extractExports(content);
    const symbols = extractSymbols(content);
    return {
      projectId,
      path: normalizedPath,
      hash: sha256(content),
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      language,
      summary: summaryFor(normalizedPath, language, symbols, imports, exports),
      symbols,
      imports,
      exports,
      moduleKey: moduleKeyFor(normalizedPath),
      updatedAt: new Date().toISOString(),
    };
  }

  static syncProject(projectId: string, files: Record<string,string>): ProjectFileSyncResult {
    const current = new Map(this.list(projectId).map(file => [file.path, file]));
    const incoming = Object.entries(files)
      .map(([filePath, content]) => [normalizePath(filePath), content] as const)
      .filter(([filePath]) => SOURCE_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase()) || !path.posix.extname(filePath));
    const changedPaths: string[] = [];
    const unchangedPaths: string[] = [];
    const incomingPaths = new Set<string>();

    db.exec('BEGIN IMMEDIATE');
    try {
      const upsert = db.prepare(`
        INSERT INTO context_project_files(
          project_id,path,hash,size_bytes,language,summary,symbols_json,imports_json,exports_json,module_key,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(project_id,path) DO UPDATE SET
          hash=excluded.hash,size_bytes=excluded.size_bytes,language=excluded.language,summary=excluded.summary,
          symbols_json=excluded.symbols_json,imports_json=excluded.imports_json,exports_json=excluded.exports_json,
          module_key=excluded.module_key,updated_at=excluded.updated_at
      `);
      for (const [filePath, content] of incoming) {
        incomingPaths.add(filePath);
        const previous = current.get(filePath);
        const nextHash = sha256(content);
        if (previous?.hash === nextHash) {
          unchangedPaths.push(filePath);
          continue;
        }
        const record = this.inspect(projectId, filePath, content);
        upsert.run(
          record.projectId,record.path,record.hash,record.sizeBytes,record.language,record.summary,
          JSON.stringify(record.symbols),JSON.stringify(record.imports),JSON.stringify(record.exports),
          record.moduleKey,record.updatedAt
        );
        changedPaths.push(filePath);
      }
      const removedPaths = [...current.keys()].filter(filePath => !incomingPaths.has(filePath));
      const remove = db.prepare('DELETE FROM context_project_files WHERE project_id=? AND path=?');
      for (const filePath of removedPaths) remove.run(projectId, filePath);
      db.exec('COMMIT');
      const indexed = this.list(projectId);
      return {
        projectId,
        projectHash: this.fingerprint(indexed),
        changedPaths,
        unchangedPaths,
        removedPaths,
        totalFiles: indexed.length,
      };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  static list(projectId: string): ProjectFileRecord[] {
    return (db.prepare('SELECT * FROM context_project_files WHERE project_id=? ORDER BY path').all(projectId) as any[]).map(parseRow);
  }

  static get(projectId: string, filePath: string): ProjectFileRecord | null {
    const row = db.prepare('SELECT * FROM context_project_files WHERE project_id=? AND path=?').get(projectId, normalizePath(filePath)) as any;
    return row ? parseRow(row) : null;
  }

  static fingerprint(files: ProjectFileRecord[]) {
    return sha256(files.slice().sort((a,b)=>a.path.localeCompare(b.path)).map(file => `${file.path}:${file.hash}`).join('\n'));
  }

  static clear(projectId: string) {
    db.prepare('DELETE FROM context_project_files WHERE project_id=?').run(projectId);
  }
}
