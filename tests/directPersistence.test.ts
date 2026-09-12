import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SupabasePersistenceService } from '../server/services/supabasePersistenceService.js';

function restore(name: 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY', value: string | undefined) {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}

test('restores normalized entities and hash-verified Storage files', async (t) => {
  const oldUrl = process.env.SUPABASE_URL, oldKey = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL = 'https://direct.example.test'; process.env.SUPABASE_SECRET_KEY = 'test-service-role';
  const bytes = Buffer.from([0, 1, 2, 250]);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('forge_accounts?')) return new Response(JSON.stringify([{ user_id: 'u1', firebase_uid: 'fb1', updated_at: '2026-09-12T00:00:00.000Z' }]), { status: 200 });
    if (url.includes('forge_entities?')) return new Response(JSON.stringify([{ entity_type: 'projects', payload: { id: 'p1', user_id: 'u1', name: 'Direct' } }]), { status: 200 });
    if (url.includes('forge_project_files?')) return new Response(JSON.stringify([{ project_id: 'p1', path: 'logo.bin', storage_path: 'fb1/p1/logo.bin', sha256: hash }]), { status: 200 });
    return new Response(bytes, { status: 200 });
  });
  try {
    const result = await SupabasePersistenceService.pull('u1');
    assert.equal(result.status, 'synced');
    assert.equal(result.snapshot?.tables.projects[0].name, 'Direct');
    assert.equal(result.snapshot?.files.p1['logo.bin'], bytes.toString('base64'));
  } finally { restore('SUPABASE_URL', oldUrl); restore('SUPABASE_SECRET_KEY', oldKey); }
});

test('migration upserts account, entities and binary files without putting server key in payloads', async (t) => {
  const oldUrl = process.env.SUPABASE_URL, oldKey = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL = 'https://direct.example.test'; process.env.SUPABASE_SECRET_KEY = 'server-secret-value';
  const calls: { url: string; body: unknown }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(input), body: init?.body }); return new Response('{}', { status: 201 }); });
  try {
    const result = await SupabasePersistenceService.push('u1', 'firebase-uid', {
      schemaVersion: 1, userId: 'u1', deviceId: 'test', createdAt: new Date().toISOString(),
      tables: { projects: [{ id: 'p1', user_id: 'u1', name: 'Project' }] },
      files: { p1: { 'assets/a.bin': Buffer.from([4, 5, 6]).toString('base64') } },
    });
    assert.deepEqual({ status: result.status, records: result.records, files: result.files }, { status: 'synced', records: 1, files: 1 });
    assert.ok(calls.some((call) => call.url.includes('/forge_accounts')));
    assert.ok(calls.some((call) => call.url.includes('/forge_entities')));
    assert.ok(calls.some((call) => call.url.includes('/storage/v1/object/forge-project-files/firebase-uid/p1/assets/a.bin')));
    assert.equal(JSON.stringify(calls.map((call) => call.body)).includes('server-secret-value'), false);
  } finally { restore('SUPABASE_URL', oldUrl); restore('SUPABASE_SECRET_KEY', oldKey); }
});

test('finds a legacy direct account through the stable Firebase UID', async (t) => {
  const oldUrl = process.env.SUPABASE_URL, oldKey = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL = 'https://direct.example.test'; process.env.SUPABASE_SECRET_KEY = 'test-service-role';
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input); urls.push(url);
    if (url.includes('forge_accounts?')) return new Response(JSON.stringify([{ user_id: 'legacy-user', firebase_uid: 'stable-firebase-uid', updated_at: '2026-09-12T00:00:00.000Z' }]), { status: 200 });
    return new Response('[]', { status: 200 });
  });
  try {
    const result = await SupabasePersistenceService.pull('stable-user', 'stable-firebase-uid');
    assert.equal(result.status, 'synced');
    assert.equal(result.migratedFrom, 'legacy-user');
    assert.equal(result.snapshot?.userId, 'legacy-user');
    assert.ok(urls[0].includes('firebase_uid.eq.stable-firebase-uid'));
    assert.ok(urls.some((url) => url.includes('user_id=eq.legacy-user')));
  } finally { restore('SUPABASE_URL', oldUrl); restore('SUPABASE_SECRET_KEY', oldKey); }
});
