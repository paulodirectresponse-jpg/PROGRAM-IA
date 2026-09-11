import crypto from 'node:crypto';
import { SecretService } from './secretService.js';

export const integrationFields = {
  github: ['token'],
  cloudflare: ['token', 'accountId', 'zoneId'],
  supabase: ['token', 'projectRef'],
  firebase: ['serviceAccount'],
} as const;
type Config = Record<string, string>;
export class IntegrationService {
  static read(userId: string, service: string): Config {
    if (!(service in integrationFields)) throw new Error('Integração desconhecida.');
    const stored = SecretService.getDecryptedSecret(userId, `integration:${service}`);
    return stored ? JSON.parse(stored) : {};
  }
  static summary(userId: string, service: string) {
    const config = this.read(userId, service);
    const fields = Object.fromEntries(Object.entries(config).filter(([key]) => !['token', 'serviceAccount'].includes(key)));
    return { service, fields, configured: !!(config.token || config.serviceAccount) };
  }
  static save(userId: string, service: string, values: Config) {
    const old = this.read(userId, service);
    const allowed = integrationFields[service as keyof typeof integrationFields];
    for (const key of allowed) {
      if (typeof values[key] === 'string' && values[key].trim()) old[key] = values[key].trim();
    }
    if (service === 'firebase' && old.serviceAccount) {
      const account = JSON.parse(old.serviceAccount);
      if (!account.project_id || !account.client_email || !account.private_key) throw new Error('JSON de conta de serviço incompleto.');
    }
    for (const key of ['accountId', 'zoneId', 'projectRef']) {
      if (old[key] && !/^[a-zA-Z0-9_-]+$/.test(old[key])) throw new Error(`Identificador inválido: ${key}`);
    }
    SecretService.saveSecret(userId, `integration:${service}`, JSON.stringify(old));
    if (service === 'github' && old.token) SecretService.saveSecret(userId, 'github', old.token);
    return this.summary(userId, service);
  }
  static async test(userId: string, service: string) {
    const c = this.read(userId, service);
    let url: string;
    let token = c.token;
    if (service === 'github') url = 'https://api.github.com/user';
    else if (service === 'cloudflare') {
      if (!c.accountId) throw new Error('Informe o Account ID da Cloudflare.');
      url = `https://api.cloudflare.com/client/v4/accounts/${c.accountId}/pages/projects`;
    } else if (service === 'supabase') {
      if (!c.projectRef) throw new Error('Informe o Project Ref do Supabase e um token de gerenciamento.');
      url = `https://api.supabase.com/v1/projects/${c.projectRef}`;
    } else {
      if (!c.serviceAccount) throw new Error('Informe o JSON de conta de serviço do projeto Firebase.');
      const account = JSON.parse(c.serviceAccount);
      const now = Math.floor(Date.now() / 1000);
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const unsigned = `${encode({alg:'RS256',typ:'JWT'})}.${encode({iss:account.client_email,scope:'https://www.googleapis.com/auth/firebase.readonly',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+300})}`;
      const assertion = `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url')}`;
      const auth = await fetch('https://oauth2.googleapis.com/token', {method:'POST', body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}), signal:AbortSignal.timeout(15000)});
      if (!auth.ok) throw new Error(`Google recusou a conta de serviço (HTTP ${auth.status}).`);
      token = (await auth.json()).access_token;
      url = `https://firebase.googleapis.com/v1beta1/projects/${encodeURIComponent(account.project_id)}`;
    }
    if (!token) throw new Error('Credencial ausente. Configure e salve antes de testar.');
    const response = await fetch(url, {headers:{Authorization:`Bearer ${token}`, Accept:'application/json'}, redirect:'error', signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error(`O serviço recusou a consulta (HTTP ${response.status}). Confira credencial, projeto e permissões.`);
    const data = await response.json();
    if (data.success === false) throw new Error('O serviço não aprovou a consulta.');
    return {success:true, message:'Conexão e acesso de leitura confirmados. Permissões de publicação são verificadas ao publicar.'};
  }
}
