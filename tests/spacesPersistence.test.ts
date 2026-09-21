import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { db, initializeDatabase } from '../server/db/index.js';
import { AuthService } from '../server/services/authService.js';
import { CloudSyncService } from '../server/services/cloudSyncService.js';
import { SpacePersistenceError, SpacePersistenceService } from '../server/services/spacePersistenceService.js';
import { SupabasePersistenceService } from '../server/services/supabasePersistenceService.js';

describe('Spaces V2 Phase 1 persistence', () => {
  before(() => initializeDatabase());

  test('creates, restores and lists the exact canvas document', () => {
    const stamp = Date.now();
    const owner = AuthService.firebaseLogin(`spaces-${stamp}@example.test`, 'Spaces Owner', `fb-spaces-${stamp}`).user;
    const space = SpacePersistenceService.create(owner.id, {
      title: 'Campanha Produto',
      nodes: [{ id: 'node-a', type: 'image', position: { x: 120, y: 80 }, settings: { prompt: 'produto premium' } }],
      edges: [],
      viewport: { x: -30, y: 14, zoom: 0.85 },
      metadata: { selectedModels: ['image-auto'] },
    });

    assert.equal(space.title, 'Campanha Produto');
    assert.equal(space.revision, 0);
    assert.deepEqual(space.viewport, { x: -30, y: 14, zoom: 0.85 });

    const restored = SpacePersistenceService.get(owner.id, space.id);
    assert.deepEqual(restored.nodes, space.nodes);
    assert.deepEqual(restored.metadata, space.metadata);

    const listed = SpacePersistenceService.list(owner.id);
    const summary = listed.find(item => item.id === space.id);
    assert.equal(summary?.nodeCount, 1);
    assert.equal(summary?.edgeCount, 0);
  });

  test('autosave payload increments revision and persists nodes, edges and viewport atomically', () => {
    const stamp = Date.now();
    const owner = AuthService.firebaseLogin(`spaces-save-${stamp}@example.test`, 'Spaces Save', `fb-spaces-save-${stamp}`).user;
    const space = SpacePersistenceService.create(owner.id);

    const saved = SpacePersistenceService.saveState(owner.id, space.id, {
      baseRevision: 0,
      nodes: [
        { id: 'image-1', type: 'image.generate', position: { x: 10, y: 20 } },
        { id: 'video-1', type: 'video.generate', position: { x: 420, y: 20 } },
      ],
      edges: [{ id: 'edge-1', sourceNode: 'image-1', targetNode: 'video-1' }],
      viewport: { x: 90, y: -10, zoom: 1.1 },
      metadata: { activeModel: 'auto' },
    });

    assert.equal(saved.revision, 1);
    assert.equal(saved.nodes.length, 2);
    assert.equal(saved.edges.length, 1);
    assert.deepEqual(saved.viewport, { x: 90, y: -10, zoom: 1.1 });
  });

  test('stale autosave cannot overwrite a newer browser session', () => {
    const stamp = Date.now();
    const owner = AuthService.firebaseLogin(`spaces-conflict-${stamp}@example.test`, 'Spaces Conflict', `fb-spaces-conflict-${stamp}`).user;
    const space = SpacePersistenceService.create(owner.id);
    SpacePersistenceService.saveState(owner.id, space.id, {
      baseRevision: 0,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      metadata: { source: 'tab-a' },
    });

    assert.throws(
      () => SpacePersistenceService.saveState(owner.id, space.id, {
        baseRevision: 0,
        nodes: [],
        edges: [],
        viewport: { x: 5, y: 5, zoom: 1 },
        metadata: { source: 'tab-b' },
      }),
      (error: any) => error instanceof SpacePersistenceError && error.code === 'SPACE_REVISION_CONFLICT' && error.status === 409,
    );
  });

  test('spaces are isolated per authenticated owner and included in cloud snapshots', () => {
    const stamp = Date.now();
    const owner = AuthService.firebaseLogin(`spaces-owner-${stamp}@example.test`, 'Owner', `fb-owner-${stamp}`).user;
    const other = AuthService.firebaseLogin(`spaces-other-${stamp}@example.test`, 'Other', `fb-other-${stamp}`).user;
    const space = SpacePersistenceService.create(owner.id, { metadata: { persisted: true } });

    assert.throws(
      () => SpacePersistenceService.get(other.id, space.id),
      (error: any) => error instanceof SpacePersistenceError && error.code === 'SPACE_NOT_FOUND',
    );

    const snapshot = CloudSyncService.export(owner.id);
    assert.ok(snapshot.tables.spaces.some((row: any) => row.id === space.id));
  });

  test('delete removes only the requested owner space', () => {
    const stamp = Date.now();
    const owner = AuthService.firebaseLogin(`spaces-delete-${stamp}@example.test`, 'Delete Owner', `fb-delete-${stamp}`).user;
    const space = SpacePersistenceService.create(owner.id);
    SpacePersistenceService.remove(owner.id, space.id);
    assert.equal(db.prepare('SELECT id FROM spaces WHERE id=?').get(space.id), undefined);
  });

  test('canonical cloud deletion prevents a removed space from returning after refresh', async t => {
    const oldUrl = process.env.SUPABASE_URL;
    const oldKey = process.env.SUPABASE_SECRET_KEY;
    process.env.SUPABASE_URL = 'https://spaces.example.test';
    process.env.SUPABASE_SECRET_KEY = 'test-service-role';
    const calls: Array<{url:string;method:string}> = [];
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({url:String(input),method:String(init?.method || 'GET').toUpperCase()});
      return new Response(null, {status:204});
    });
    try {
      const result = await SupabasePersistenceService.deleteCanonicalSpace('firebase-owner', 'space-123');
      assert.equal(result.status, 'synced');
      assert.equal(result.deleted, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, 'DELETE');
      assert.match(calls[0].url, /forge_spaces\?firebase_uid=eq\.firebase-owner&id=eq\.space-123/);
    } finally {
      if (oldUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = oldUrl;
      if (oldKey === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = oldKey;
    }
  });
});
