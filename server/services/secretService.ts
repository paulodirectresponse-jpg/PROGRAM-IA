import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/index.js';

export interface SecretSummary {
  id: string;
  service_key: string;
  masked_hint: string;
  status: string;
  is_default: boolean;
  is_active: boolean;
  last_tested_at?: string;
  last_error?: string;
  updated_at: string;
}

export class SecretService {
  private static masterKey: Buffer | null = null;

  /**
   * Get or initialize 32-byte master encryption key
   */
  private static getMasterKey(): Buffer {
    if (this.masterKey) return this.masterKey;

    const envKey = process.env.SECRETS_MASTER_KEY;
    if (envKey && envKey.length >= 32) {
      this.masterKey = crypto.createHash('sha256').update(envKey).digest();
      return this.masterKey;
    }

    if (process.env.SUPABASE_URL || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.FORGE_REQUIRE_CLOUD_SYNC === 'true') {
      throw new Error('SECRETS_MASTER_KEY ausente: a sincronização remota exige uma chave mestra estável entre todos os runtimes.');
    }

    // Persist a machine master key in .data directory if not in env
    const keyPath = path.resolve(process.env.FORGE_DATA_DIR || path.join(process.cwd(), '.data'), '.master_key');
    if (fs.existsSync(keyPath)) {
      const hex = fs.readFileSync(keyPath, 'utf8').trim();
      this.masterKey = Buffer.from(hex, 'hex');
      return this.masterKey;
    }

    const generated = crypto.randomBytes(32);
    try {
      const dataDir = path.resolve(process.env.FORGE_DATA_DIR || path.join(process.cwd(), '.data'));
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(keyPath, generated.toString('hex'), { encoding: 'utf8', mode: 0o600 });
    } catch {
      throw new Error('Não foi possível persistir a chave mestra. Nenhuma credencial foi salva.');
    }

    this.masterKey = generated;
    return this.masterKey;
  }

  /**
   * Mask plain secret string for safe display (e.g. sk-...9b2a or ghp_...4d8e)
   */
  static maskSecret(plain: string): string {
    if (!plain || plain.length <= 8) {
      return '••••••••';
    }
    const prefix = plain.substring(0, Math.min(4, Math.floor(plain.length / 4)));
    const suffix = plain.substring(plain.length - 4);
    return `${prefix}...${suffix}`;
  }

  /**
   * Encrypt plaintext string using AES-256-GCM
   */
  static encrypt(plaintext: string): {
    ciphertext: string;
    iv: string;
    tag: string;
    split: (separator: string | RegExp, limit?: number) => string[];
    toString: () => string;
  } {
    const key = this.getMasterKey();
    const iv = crypto.randomBytes(12); // 96-bit IV recommended for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    const ivHex = iv.toString('hex');

    return {
      ciphertext: encrypted,
      iv: ivHex,
      tag,
      split(separator: string | RegExp, limit?: number) {
        return `${ivHex}:${tag}:${encrypted}`.split(separator, limit);
      },
      toString() {
        return `${ivHex}:${tag}:${encrypted}`;
      },
    };
  }

  /**
   * Decrypt AES-256-GCM encrypted secret
   */
  static decrypt(ciphertextOrCombined: any, ivHex?: string, tagHex?: string): string {
    let ciphertext = typeof ciphertextOrCombined === 'object' && ciphertextOrCombined?.ciphertext
      ? ciphertextOrCombined.ciphertext
      : String(ciphertextOrCombined);
    let iv = typeof ciphertextOrCombined === 'object' && ciphertextOrCombined?.iv
      ? ciphertextOrCombined.iv
      : ivHex;
    let tag = typeof ciphertextOrCombined === 'object' && ciphertextOrCombined?.tag
      ? ciphertextOrCombined.tag
      : tagHex;

    if (!iv && !tag && typeof ciphertext === 'string' && ciphertext.includes(':')) {
      const parts = ciphertext.split(':');
      iv = parts[0];
      tag = parts[1];
      ciphertext = parts[2];
    }

    if (!iv || !tag || !ciphertext) {
      throw new Error('Falha de autenticação: formato criptográfico inválido.');
    }

    const key = this.getMasterKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));

    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  static validateEncryptedRows(rows: any[]): { valid: boolean; count: number; failures: string[] } {
    const active = (rows || []).filter(row => row && row.is_active !== 0);
    const failures: string[] = [];
    for (const row of active) {
      try {
        this.decrypt(row.encrypted_value, row.iv, row.tag);
      } catch {
        failures.push(String(row.service_key || row.id || 'credencial desconhecida'));
      }
    }
    return { valid: failures.length === 0, count: active.length, failures };
  }

  /**
   * Save or replace secret for a user and service
   */
  static saveSecret(
    userId: string,
    serviceKey: string,
    plainSecret: string,
    options: { isDefault?: boolean; isActive?: boolean } = {}
  ): SecretSummary {
    const trimmed = plainSecret.trim();
    if (!trimmed) {
      throw new Error('O valor da credencial não pode ser vazio.');
    }

    const { ciphertext, iv, tag } = this.encrypt(trimmed);
    const masked = this.maskSecret(trimmed);
    const now = new Date().toISOString();
    const secretId = 'sec-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');

    // Check existing
    const existing = db.prepare('SELECT id FROM user_secrets WHERE user_id = ? AND service_key = ?').get(userId, serviceKey) as any;

    if (existing) {
      db.prepare(`
        UPDATE user_secrets
        SET encrypted_value = ?, iv = ?, tag = ?, masked_hint = ?, status = 'configured',
            is_default = COALESCE(?, is_default), is_active = COALESCE(?, is_active),
            last_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(
        ciphertext,
        iv,
        tag,
        masked,
        options.isDefault !== undefined ? (options.isDefault ? 1 : 0) : null,
        options.isActive !== undefined ? (options.isActive ? 1 : 0) : null,
        now,
        existing.id
      );
    } else {
      db.prepare(`
        INSERT INTO user_secrets (
          id, user_id, service_key, encrypted_value, iv, tag, masked_hint, status, is_default, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'configured', ?, ?, ?, ?)
      `).run(
        secretId,
        userId,
        serviceKey,
        ciphertext,
        iv,
        tag,
        masked,
        options.isDefault ? 1 : 0,
        options.isActive !== false ? 1 : 0,
        now,
        now
      );
    }

    // Persisting a credential only proves configuration; connectivity remains untested until a real probe succeeds.
    db.prepare(`
      UPDATE providers
      SET is_configured = 1, connection_status = 'untested', last_error = NULL
      WHERE user_id = ? AND provider_key = ?
    `).run(userId, serviceKey);
    if (serviceKey === 'github') {
      db.prepare(`
        UPDATE integrations
        SET status = 'pending_credentials', last_verified_at = NULL
        WHERE user_id = ? AND service_name = 'github'
      `).run(userId);
    }

    return {
      id: existing ? existing.id : secretId,
      service_key: serviceKey,
      masked_hint: masked,
      status: 'configured',
      is_default: Boolean(options.isDefault),
      is_active: options.isActive !== false,
      updated_at: now,
    };
  }

  /**
   * Retrieve plaintext secret strictly for server-side operations
   * Never returned via any public API!
   */
  static getDecryptedSecret(userId: string, serviceKey: string): string | null {
    const row = db.prepare(`
      SELECT encrypted_value, iv, tag, is_active
      FROM user_secrets
      WHERE user_id = ? AND service_key = ?
    `).get(userId, serviceKey) as any;

    if (!row || row.is_active === 0) {
      return null;
    }

    try {
      return this.decrypt(row.encrypted_value, row.iv, row.tag);
    } catch (err) {
      console.error(`Falha ao descriptografar segredo para ${serviceKey}:`, err);
      return null;
    }
  }

  /**
   * List all secrets for a user (MASKED ONLY, never plaintext!)
   */
  static listUserSecrets(userId: string): SecretSummary[] {
    const rows = db.prepare(`
      SELECT id, service_key, masked_hint, status, is_default, is_active, last_tested_at, last_error, updated_at
      FROM user_secrets
      WHERE user_id = ?
      ORDER BY service_key ASC
    `).all(userId) as any[];

    return rows.map((r) => ({
      id: r.id,
      service_key: r.service_key,
      masked_hint: r.masked_hint,
      status: r.status,
      is_default: Boolean(r.is_default),
      is_active: Boolean(r.is_active),
      last_tested_at: r.last_tested_at,
      last_error: r.last_error,
      updated_at: r.updated_at,
    }));
  }

  /**
   * Remove a secret for a user
   */
  static deleteSecret(userId: string, serviceKey: string): boolean {
    db.prepare('DELETE FROM user_secrets WHERE user_id = ? AND service_key = ?').run(userId, serviceKey);

    // Update matching provider state without relying on a hard-coded provider list.
    db.prepare(`
      UPDATE providers
      SET is_configured = 0, is_active = 0, connection_status = 'not_configured', last_error = NULL
      WHERE user_id = ? AND provider_key = ?
    `).run(userId, serviceKey);
    if (serviceKey === 'github') {
      db.prepare(`
        UPDATE integrations
        SET status = 'pending_credentials'
        WHERE user_id = ? AND service_name = 'github'
      `).run(userId);
    }

    return true;
  }

  /**
   * Set a secret as default for its type
   */
  static setDefaultSecret(userId: string, serviceKey: string): void {
    db.prepare('UPDATE user_secrets SET is_default = 0 WHERE user_id = ?').run(userId);
    db.prepare('UPDATE user_secrets SET is_default = 1 WHERE user_id = ? AND service_key = ?').run(userId, serviceKey);
  }

  /**
   * Toggle active state
   */
  static toggleSecretActive(userId: string, serviceKey: string, isActive: boolean): void {
    db.prepare(`
      UPDATE user_secrets SET is_active = ?, updated_at = ? WHERE user_id = ? AND service_key = ?
    `).run(isActive ? 1 : 0, new Date().toISOString(), userId, serviceKey);
  }


}


