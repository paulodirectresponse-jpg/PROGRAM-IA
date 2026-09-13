export type CanonicalTable =
  | 'forge_profiles' | 'forge_projects' | 'forge_conversations' | 'forge_messages'
  | 'forge_providers' | 'forge_provider_secrets' | 'forge_integrations' | 'forge_skills'
  | 'forge_checkpoints' | 'forge_repositories' | 'forge_branches'
  | 'forge_model_profiles' | 'forge_model_candidates' | 'forge_model_invocations'
  | 'forge_project_files';

export class SupabaseRepository {
  constructor(private readonly baseUrl: string, private readonly headers: (extra?: Record<string,string>) => Record<string,string>) {}
  private url(table: CanonicalTable, query = '') { return `${this.baseUrl}/rest/v1/${table}${query ? `?${query}` : ''}`; }
  private async expect(response: Response, operation: string) {
    if (!response.ok) throw new Error(`${operation} ${response.status}: ${(await response.text()).slice(0,300)}`);
    return response;
  }
  async upsert(table: CanonicalTable, rows: unknown[], conflict: string) {
    if (!rows.length) return;
    for (let index=0; index<rows.length; index+=200) await this.expect(await fetch(this.url(table,`on_conflict=${conflict}`), {
      method:'POST', headers:this.headers({Prefer:'resolution=merge-duplicates,return=minimal'}), body:JSON.stringify(rows.slice(index,index+200)),
    }), `${table} upsert`);
  }
  async owned(table: CanonicalTable, firebaseUid: string) {
    const response=await this.expect(await fetch(this.url(table,`firebase_uid=eq.${encodeURIComponent(firebaseUid)}&select=*`),{headers:this.headers()}),`${table} read`);
    return response.json() as Promise<any[]>;
  }
}
