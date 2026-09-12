import crypto from 'node:crypto';

export type DirectSnapshot = {
  schemaVersion: 1;
  userId: string;
  deviceId: string;
  createdAt: string;
  tables: Record<string, any[]>;
  files: Record<string, Record<string, string>>;
};

type DirectStatus = 'synced' | 'local_only' | 'not_configured';

export class SupabasePersistenceService {
  private static key() {
    return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  }

  static configured() {
    return Boolean(process.env.SUPABASE_URL && this.key());
  }

  private static headers(extra: Record<string, string> = {}) {
    const key = this.key();
    const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json', ...extra };
    if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
    return headers;
  }

  private static rest(path: string) {
    return `${process.env.SUPABASE_URL}/rest/v1/${path}`;
  }

  private static storagePath(firebaseUid: string, projectId: string, filePath: string) {
    const safe = filePath.replace(/\\/g, '/').split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return `${encodeURIComponent(firebaseUid)}/${encodeURIComponent(projectId)}/${safe}`;
  }

  private static async expect(response: Response, operation: string) {
    if (!response.ok) throw new Error(`${operation} ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return response;
  }

  static async push(userId: string, firebaseUid: string, snapshot: DirectSnapshot): Promise<{status: DirectStatus; records?: number; files?: number}> {
    if (!this.configured()) return { status: 'not_configured' };
    if (!firebaseUid) throw new Error('Firebase UID ausente; persistência direta recusada.');

    const user = snapshot.tables.users?.find((row: any) => row.id === userId) || {};
    await this.expect(await fetch(this.rest('forge_accounts?on_conflict=user_id'), {
      method: 'POST',
      headers: this.headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify({ user_id: userId, firebase_uid: firebaseUid, email: user.email || null, display_name: user.name || null, schema_version: snapshot.schemaVersion, updated_at: snapshot.createdAt }),
    }), 'Supabase account upsert');

    const entities: any[] = [];
    for (const [entityType, rows] of Object.entries(snapshot.tables)) {
      for (const row of rows) {
        const entityId = String(row.id || `${entityType}:${crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex')}`);
        entities.push({ user_id: userId, firebase_uid: firebaseUid, entity_type: entityType, entity_id: entityId, project_id: row.project_id || (entityType === 'projects' ? row.id : null), payload: row, updated_at: row.updated_at || row.created_at || snapshot.createdAt });
      }
    }
    for (let index = 0; index < entities.length; index += 250) {
      await this.expect(await fetch(this.rest('forge_entities?on_conflict=user_id,entity_type,entity_id'), {
        method: 'POST', headers: this.headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(entities.slice(index, index + 250)),
      }), 'Supabase entity upsert');
    }

    const metadata: any[] = [];
    for (const [projectId, files] of Object.entries(snapshot.files)) {
      for (const [filePath, base64] of Object.entries(files)) {
        const content = Buffer.from(base64, 'base64');
        const storagePath = this.storagePath(firebaseUid, projectId, filePath);
        await this.expect(await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/forge-project-files/${storagePath}`, {
          method: 'POST', headers: this.headers({ 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' }), body: content,
        }), 'Supabase Storage upload');
        metadata.push({ user_id: userId, firebase_uid: firebaseUid, project_id: projectId, path: filePath, storage_path: storagePath, sha256: crypto.createHash('sha256').update(content).digest('hex'), size_bytes: content.length, updated_at: snapshot.createdAt });
      }
    }
    for (let index = 0; index < metadata.length; index += 250) {
      await this.expect(await fetch(this.rest('forge_project_files?on_conflict=user_id,project_id,path'), {
        method: 'POST', headers: this.headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(metadata.slice(index, index + 250)),
      }), 'Supabase file metadata upsert');
    }
    return { status: 'synced', records: entities.length, files: metadata.length };
  }

  static async pull(userId: string, firebaseUid = ''): Promise<{status: DirectStatus; snapshot?: DirectSnapshot; migratedFrom?: string}> {
    if (!this.configured()) return { status: 'not_configured' };
    const accountFilter = firebaseUid
      ? `or=(user_id.eq.${encodeURIComponent(userId)},firebase_uid.eq.${encodeURIComponent(firebaseUid)})`
      : `user_id=eq.${encodeURIComponent(userId)}`;
    const accountResponse = await this.expect(await fetch(this.rest(`forge_accounts?${accountFilter}&select=*&order=updated_at.desc&limit=1`), { headers: this.headers() }), 'Supabase account read');
    const accounts = await accountResponse.json() as any[];
    if (!accounts.length || !accounts[0]?.firebase_uid) return { status: 'local_only' };
    const remoteUserId = String(accounts[0].user_id);
    const entityResponse = await this.expect(await fetch(this.rest(`forge_entities?user_id=eq.${encodeURIComponent(remoteUserId)}&select=entity_type,payload`), { headers: this.headers() }), 'Supabase entity read');
    const fileResponse = await this.expect(await fetch(this.rest(`forge_project_files?user_id=eq.${encodeURIComponent(remoteUserId)}&select=project_id,path,storage_path,sha256`), { headers: this.headers() }), 'Supabase file metadata read');
    const tables: Record<string, any[]> = {};
    for (const row of await entityResponse.json() as any[]) (tables[row.entity_type] ||= []).push(row.payload);
    const files: Record<string, Record<string, string>> = {};
    for (const row of await fileResponse.json() as any[]) {
      const response = await this.expect(await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/forge-project-files/${row.storage_path}`, { headers: this.headers() }), 'Supabase Storage download');
      const content = Buffer.from(await response.arrayBuffer());
      if (crypto.createHash('sha256').update(content).digest('hex') !== row.sha256) throw new Error(`Arquivo remoto corrompido: ${row.path}`);
      (files[row.project_id] ||= {})[row.path] = content.toString('base64');
    }
    return { status: 'synced', migratedFrom: remoteUserId === userId ? undefined : remoteUserId, snapshot: { schemaVersion: 1, userId: remoteUserId, deviceId: 'supabase-direct', createdAt: accounts[0].updated_at, tables, files } };
  }
}
