import crypto from 'node:crypto';
import path from 'node:path';
import { db } from '../db/index.js';
import { ProjectFileIndex } from './projectFileIndex.js';
import type { ArchitectureDependency, ArchitectureEntity, ArchitectureGraph, ProjectFileRecord } from './types.js';

function hashJson(value: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function entityName(filePath: string) {
  return path.posix.basename(filePath).replace(/\.[^.]+$/, '');
}

function classify(file: ProjectFileRecord) {
  const lower = file.path.toLowerCase();
  const base = entityName(file.path);
  const kinds: ArchitectureEntity['kind'][] = [];
  if (/(^|\/)(routes?|pages?|app\/api)(\/|$)|(?:route|router)\.[^.]+$/.test(lower)) kinds.push('route');
  if (/(^|\/)(services?|usecases?|application)(\/|$)|service\.[^.]+$/.test(lower)) kinds.push('service');
  if (/(^|\/)(models?|domain|entities|schemas?)(\/|$)|(?:model|entity|schema)\.[^.]+$/.test(lower)) kinds.push('model');
  if (/\.(tsx|jsx|vue|svelte)$/.test(lower) || /(^|\/)(components?|features)(\/|$)/.test(lower)) kinds.push('component');
  if (/(^|\/)(integrations?|providers?|adapters?|clients?)(\/|$)|github|firebase|supabase|cloudflare|stripe|openai|gemini/.test(lower)) kinds.push('integration');
  return { base, kinds: [...new Set(kinds)] };
}

function packageName(specifier: string) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0,2).join('/');
  return specifier.split('/')[0];
}

function resolveLocalImport(fromFile: string, specifier: string, known: Set<string>) {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  const candidates = [
    base,
    `${base}.ts`,`${base}.tsx`,`${base}.js`,`${base}.jsx`,`${base}.mjs`,`${base}.cjs`,
    `${base}/index.ts`,`${base}/index.tsx`,`${base}/index.js`,`${base}/index.jsx`,
  ];
  return candidates.find(candidate => known.has(candidate)) || null;
}

function groupEntities(files: ProjectFileRecord[], kind: ArchitectureEntity['kind']) {
  return files.flatMap(file => {
    const classification = classify(file);
    return classification.kinds.includes(kind) ? [{
      key: `${kind}:${file.path}`,
      name: classification.base,
      files: [file.path],
      kind,
    } satisfies ArchitectureEntity] : [];
  });
}

export class ArchitectureGraphService {
  static build(projectId: string, files = ProjectFileIndex.list(projectId)): ArchitectureGraph {
    const known = new Set(files.map(file => file.path));
    const modulesByKey = new Map<string,string[]>();
    for (const file of files) {
      const list = modulesByKey.get(file.moduleKey) || [];
      list.push(file.path);
      modulesByKey.set(file.moduleKey, list);
    }
    const modules: ArchitectureEntity[] = [...modulesByKey.entries()].map(([key, moduleFiles]) => ({
      key: `module:${key}`, name:key, files:moduleFiles.sort(), kind:'module',
    }));

    const dependencies: ArchitectureDependency[] = [];
    for (const file of files) {
      for (const specifier of file.imports) {
        const local = resolveLocalImport(file.path, specifier, known);
        if (local) dependencies.push({ from:file.path, to:local, type:'local_import', source:specifier });
        else if (!specifier.startsWith('.')) dependencies.push({ from:file.path, to:`pkg:${packageName(specifier)}`, type:'package_import', source:specifier });
      }
    }

    const core = {
      projectId,
      modules,
      services: groupEntities(files, 'service'),
      routes: groupEntities(files, 'route'),
      models: groupEntities(files, 'model'),
      components: groupEntities(files, 'component'),
      integrations: groupEntities(files, 'integration'),
      dependencies: dependencies.sort((a,b)=>`${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`)),
    };
    return { ...core, hash:hashJson(core), generatedAt:new Date().toISOString() };
  }

  static persist(graph: ArchitectureGraph) {
    const id = `ctx-graph-${crypto.randomUUID()}`;
    db.prepare('INSERT OR IGNORE INTO context_architecture_graphs(id,project_id,graph_hash,graph_json,created_at) VALUES(?,?,?,?,?)')
      .run(id,graph.projectId,graph.hash,JSON.stringify(graph),graph.generatedAt);
    return this.latest(graph.projectId) || graph;
  }

  static buildAndPersist(projectId: string, files = ProjectFileIndex.list(projectId)) {
    return this.persist(this.build(projectId, files));
  }

  static latest(projectId: string): ArchitectureGraph | null {
    const row = db.prepare('SELECT graph_json FROM context_architecture_graphs WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(projectId) as any;
    return row ? JSON.parse(row.graph_json) as ArchitectureGraph : null;
  }

  static clear(projectId: string) {
    db.prepare('DELETE FROM context_architecture_graphs WHERE project_id=?').run(projectId);
  }
}
