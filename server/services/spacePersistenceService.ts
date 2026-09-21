import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { db } from '../db/index.js';

export type SpaceViewport = Record<string, unknown> & { x?: number; y?: number; zoom?: number };
export type SpaceNodeState = Record<string, unknown>;
export type SpaceEdgeState = Record<string, unknown>;

export type SpaceDocument = {
  id: string;
  userId: string;
  projectId: string | null;
  title: string;
  nodes: SpaceNodeState[];
  edges: SpaceEdgeState[];
  viewport: SpaceViewport;
  metadata: Record<string, unknown>;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type SpaceRow = {
  id: string;
  user_id: string;
  project_id: string | null;
  title: string;
  nodes_json: string;
  edges_json: string;
  viewport_json: string;
  metadata_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

export class SpacePersistenceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly current?: SpaceDocument,
  ) {
    super(message);
    this.name = 'SpacePersistenceError';
  }
}

const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function ensureArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new SpacePersistenceError('SPACE_INVALID_STATE', `${label} precisa ser uma lista.`, 400);
  return value as Record<string, unknown>[];
}

function ensureObject(value: unknown, label: string, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (value === undefined) return fallback;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SpacePersistenceError('SPACE_INVALID_STATE', `${label} precisa ser um objeto.`, 400);
  }
  return value as Record<string, unknown>;
}

function json(value: unknown, label: string): string {
  let serialized: string;
  try { serialized = JSON.stringify(value); }
  catch { throw new SpacePersistenceError('SPACE_INVALID_STATE', `${label} contém dados não serializáveis.`, 400); }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new SpacePersistenceError('SPACE_STATE_TOO_LARGE', `${label} excede o limite de persistência.`, 413);
  }
  return serialized;
}

function normalizeTitle(value: unknown): string {
  const title = String(value ?? '').trim();
  return title ? title.slice(0, 160) : 'Space sem título';
}

function normalizeViewport(value: unknown): SpaceViewport {
  const input = ensureObject(value, 'viewport', { x: 0, y: 0, zoom: 1 });
  const next: SpaceViewport = { ...input };
  for (const key of ['x', 'y', 'zoom'] as const) {
    if (input[key] === undefined) continue;
    const number = Number(input[key]);
    if (!Number.isFinite(number)) throw new SpacePersistenceError('SPACE_INVALID_STATE', `viewport.${key} precisa ser numérico.`, 400);
    next[key] = number;
  }
  if (next.x === undefined) next.x = 0;
  if (next.y === undefined) next.y = 0;
  if (next.zoom === undefined) next.zoom = 1;
  return next;
}

function toDocument(row: SpaceRow): SpaceDocument {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id || null,
    title: row.title,
    nodes: parseJson<SpaceNodeState[]>(row.nodes_json, []),
    edges: parseJson<SpaceEdgeState[]>(row.edges_json, []),
    viewport: parseJson<SpaceViewport>(row.viewport_json, { x: 0, y: 0, zoom: 1 }),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    revision: Number(row.revision || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SpacePersistenceService {
  private static row(userId: string, spaceId: string): SpaceRow {
    const row = db.prepare('SELECT * FROM spaces WHERE id=? AND user_id=?').get(spaceId, userId) as SpaceRow | undefined;
    if (!row) throw new SpacePersistenceError('SPACE_NOT_FOUND', 'Space não encontrado.', 404);
    return row;
  }

  private static project(userId: string, projectId: unknown): string | null {
    if (projectId === undefined || projectId === null || projectId === '') return null;
    const id = String(projectId);
    const owned = db.prepare('SELECT id FROM projects WHERE id=? AND user_id=?').get(id, userId) as { id: string } | undefined;
    if (!owned) throw new SpacePersistenceError('SPACE_PROJECT_NOT_FOUND', 'Projeto vinculado não encontrado.', 404);
    return id;
  }

  static create(userId: string, input: any = {}): SpaceDocument {
    const id = `space-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const nodes = input.nodes === undefined ? [] : ensureArray(input.nodes, 'nodes');
    const edges = input.edges === undefined ? [] : ensureArray(input.edges, 'edges');
    const viewport = normalizeViewport(input.viewport);
    const metadata = ensureObject(input.metadata, 'metadata');
    const projectId = this.project(userId, input.projectId);
    const title = normalizeTitle(input.title);

    db.prepare(`INSERT INTO spaces(
      id,user_id,project_id,title,nodes_json,edges_json,viewport_json,metadata_json,revision,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,0,?,?)`).run(
      id,userId,projectId,title,json(nodes,'nodes'),json(edges,'edges'),json(viewport,'viewport'),json(metadata,'metadata'),now,now
    );
    return this.get(userId, id);
  }

  static list(userId: string) {
    const rows = db.prepare(`SELECT * FROM spaces WHERE user_id=? ORDER BY updated_at DESC,created_at DESC`).all(userId) as SpaceRow[];
    return rows.map(row => {
      const document = toDocument(row);
      return {
        id: document.id,
        projectId: document.projectId,
        title: document.title,
        revision: document.revision,
        nodeCount: document.nodes.length,
        edgeCount: document.edges.length,
        metadata: document.metadata,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
      };
    });
  }

  static get(userId: string, spaceId: string): SpaceDocument {
    return toDocument(this.row(userId, spaceId));
  }

  static saveState(userId: string, spaceId: string, input: any = {}): SpaceDocument {
    const current = this.get(userId, spaceId);
    const baseRevision = input.baseRevision === undefined ? current.revision : Number(input.baseRevision);
    if (!Number.isInteger(baseRevision) || baseRevision < 0) {
      throw new SpacePersistenceError('SPACE_INVALID_REVISION', 'A revisão informada é inválida.', 400, current);
    }
    if (baseRevision !== current.revision) {
      throw new SpacePersistenceError('SPACE_REVISION_CONFLICT', 'Este Space foi alterado em outra sessão.', 409, current);
    }

    const nodes = ensureArray(input.nodes, 'nodes');
    const edges = ensureArray(input.edges, 'edges');
    const viewport = normalizeViewport(input.viewport);
    const metadata = ensureObject(input.metadata, 'metadata');
    const updatedAt = new Date().toISOString();
    const nextRevision = current.revision + 1;
    const result = db.prepare(`UPDATE spaces
      SET nodes_json=?,edges_json=?,viewport_json=?,metadata_json=?,revision=?,updated_at=?
      WHERE id=? AND user_id=? AND revision=?`).run(
      json(nodes,'nodes'),json(edges,'edges'),json(viewport,'viewport'),json(metadata,'metadata'),
      nextRevision,updatedAt,spaceId,userId,current.revision
    ) as any;
    if (Number(result?.changes || 0) !== 1) {
      throw new SpacePersistenceError('SPACE_REVISION_CONFLICT', 'Este Space foi alterado durante o salvamento.', 409, this.get(userId, spaceId));
    }
    return this.get(userId, spaceId);
  }

  static updateDetails(userId: string, spaceId: string, input: any = {}): SpaceDocument {
    const current = this.get(userId, spaceId);
    const title = input.title === undefined ? current.title : normalizeTitle(input.title);
    const projectId = input.projectId === undefined ? current.projectId : this.project(userId, input.projectId);
    const metadata = input.metadata === undefined ? current.metadata : ensureObject(input.metadata, 'metadata');
    const updatedAt = new Date().toISOString();
    const nextRevision = current.revision + 1;
    const result = db.prepare(`UPDATE spaces
      SET title=?,project_id=?,metadata_json=?,revision=?,updated_at=?
      WHERE id=? AND user_id=? AND revision=?`).run(
      title,projectId,json(metadata,'metadata'),nextRevision,updatedAt,spaceId,userId,current.revision
    ) as any;
    if (Number(result?.changes || 0) !== 1) {
      throw new SpacePersistenceError('SPACE_REVISION_CONFLICT', 'Este Space foi alterado durante a atualização.', 409, this.get(userId, spaceId));
    }
    return this.get(userId, spaceId);
  }

  static remove(userId: string, spaceId: string): void {
    this.row(userId, spaceId);
    db.prepare('DELETE FROM spaces WHERE id=? AND user_id=?').run(spaceId, userId);
  }
}
