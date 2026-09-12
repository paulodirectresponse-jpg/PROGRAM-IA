import crypto from 'node:crypto';
import { db } from '../db/index.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  created_at: string;
}

export interface SessionInfo {
  token: string;
  userId: string;
  expiresAt: string;
}

// In-memory rate limiter for login attempts (sliding window per IP/email)
const loginAttempts = new Map<string, { count: number; firstAttempt: number }>();
const MAX_ATTEMPTS = 6;
const WINDOW_MS = 60 * 1000; // 1 minute window

export class AuthService {
  private static firebaseUserId(uid: string): string {
    return `usr-firebase-${crypto.createHash('sha256').update(uid).digest('hex').slice(0, 32)}`;
  }

  private static migrateFirebaseUserId(user: AuthUser, stableId: string): AuthUser {
    if (user.id === stableId) return user;
    if (db.prepare('SELECT id FROM users WHERE id = ?').get(stableId)) {
      throw new Error('Conflito ao migrar a identidade Firebase.');
    }
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{name:string}>;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const {name} of tables) {
        const columns = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{name:string}>;
        if (columns.some(column => column.name === 'user_id')) {
          db.prepare(`UPDATE ${name} SET user_id = ? WHERE user_id = ?`).run(stableId, user.id);
        }
      }
      db.prepare('UPDATE users SET id = ?, updated_at = ? WHERE id = ?').run(stableId, new Date().toISOString(), user.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return {...user, id: stableId};
  }

  /**
   * Hash a password securely with salt using scrypt (Argon2-comparable memory-hard hashing)
   */
  static hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    return `scrypt$${salt}$${derivedKey.toString('hex')}`;
  }

  /**
   * Verify password against stored hash using constant-time comparison
   */
  static verifyPassword(password: string, storedHash: string): boolean {
    try {
      const parts = storedHash.split('$');
      if (parts.length !== 3 || parts[0] !== 'scrypt') {
        return false;
      }
      const salt = parts[1];
      const originalKey = Buffer.from(parts[2], 'hex');
      const derivedKey = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
      return crypto.timingSafeEqual(originalKey, derivedKey);
    } catch {
      return false;
    }
  }

  /**
   * Check and record login rate limiting
   */
  static checkRateLimit(key: string): { allowed: boolean; waitSeconds?: number } {
    const now = Date.now();
    const entry = loginAttempts.get(key);

    if (!entry || now - entry.firstAttempt > WINDOW_MS) {
      loginAttempts.set(key, { count: 1, firstAttempt: now });
      return { allowed: true };
    }

    if (entry.count >= MAX_ATTEMPTS) {
      const waitSeconds = Math.ceil((WINDOW_MS - (now - entry.firstAttempt)) / 1000);
      return { allowed: false, waitSeconds };
    }

    entry.count += 1;
    return { allowed: true };
  }

  static resetRateLimit(key: string): void {
    loginAttempts.delete(key);
  }

  /**
   * Create a new user with validation
   */
  static register(email: string, name: string, password: string): AuthUser {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes('@') || !normalizedEmail.includes('.')) {
      throw new Error('Formato de e-mail inválido.');
    }
    if (!password || password.length < 8) {
      throw new Error('A senha deve conter no mínimo 8 caracteres.');
    }
    const cleanName = name.trim() || normalizedEmail.split('@')[0];

    const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(normalizedEmail);
    if (existing) {
      throw new Error('Este endereço de e-mail já está em uso.');
    }

    const userId = 'usr-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    const passwordHash = this.hashPassword(password);
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO users (id, email, name, password_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'developer', ?, ?)
    `).run(userId, normalizedEmail, cleanName, passwordHash, now, now);

    // Create user default workspace
    const wsId = 'ws-' + userId;
    db.prepare(`
      INSERT INTO workspaces (id, user_id, name, root_path, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(wsId, userId, `${cleanName}'s Workspace`, `/workspace/${userId}`, now);

    // Seed user standard skills & default providers
    this.seedUserData(userId);

    return {
      id: userId,
      email: normalizedEmail,
      name: cleanName,
      role: 'developer',
      created_at: now,
    };
  }

  /**
   * Find user by email
   */
  static getUserByEmail(email: string): AuthUser | null {
    const normalizedEmail = email.trim().toLowerCase();
    const user = db.prepare('SELECT id, email, name, role, created_at FROM users WHERE LOWER(email) = ?').get(normalizedEmail) as any;
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role || 'developer',
      created_at: user.created_at,
    };
  }

  /**
   * Firebase OAuth / Federated session login or auto-provision
   */
  static firebaseLogin(
    email: string,
    name: string,
    uid: string,
    userAgent: string = '',
    ipAddress: string = ''
  ): { user: AuthUser; session: SessionInfo; legacyUserIds: string[] } {
    const normalizedEmail = email.trim().toLowerCase();
    const stableUserId = this.firebaseUserId(uid);
    let user = db.prepare('SELECT id, email, name, role, created_at FROM users WHERE firebase_uid = ?').get(uid) as unknown as AuthUser | undefined;
    const emailOwner = this.getUserByEmail(normalizedEmail);
    const legacyUserIds: string[] = [];
    if (!user && emailOwner) {
      const binding = db.prepare('SELECT firebase_uid FROM users WHERE id=?').get(emailOwner.id) as {firebase_uid?:string}|undefined;
      if (binding?.firebase_uid && binding.firebase_uid !== uid) throw new Error('Esta conta Firebase já está vinculada a outra identidade.');
      user = emailOwner;
    }

    if (user && user.id !== stableUserId) {
      legacyUserIds.push(user.id);
      user = this.migrateFirebaseUserId(user, stableUserId);
    }

    if (!user) {
      const cleanName = name.trim() || normalizedEmail.split('@')[0];
      const userId = stableUserId;
      const now = new Date().toISOString();
      const fakePassHash = this.hashPassword(crypto.randomBytes(48).toString('hex'));

      db.prepare(`
        INSERT INTO users (id, email, name, password_hash, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'developer', ?, ?)
      `).run(userId, normalizedEmail, cleanName, fakePassHash, now, now);

      const wsId = 'ws-' + userId;
      db.prepare(`
        INSERT INTO workspaces (id, user_id, name, root_path, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(wsId, userId, `${cleanName}'s Workspace`, `/workspace/${userId}`, now);

      this.seedUserData(userId);

      user = {
        id: userId,
        email: normalizedEmail,
        name: cleanName,
        role: 'developer',
        created_at: now,
      };
    }

    db.prepare('UPDATE users SET firebase_uid = ? WHERE id = ?').run(uid, user.id);
    this.seedUserData(user.id);
    const session = this.createSession(user.id, userAgent, ipAddress);
    return { user, session, legacyUserIds };
  }

  /**
   * Authenticate user and generate persistent session
   */
  static login(
    email: string,
    password: string,
    userAgent: string = '',
    ipAddress: string = ''
  ): { user: AuthUser; session: SessionInfo } {
    const normalizedEmail = email.trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(normalizedEmail) as any;

    // Generic error to not disclose whether user exists
    if (!user || !user.password_hash) {
      throw new Error('Credenciais inválidas. Verifique seu e-mail e senha.');
    }

    const valid = this.verifyPassword(password, user.password_hash);
    if (!valid) {
      throw new Error('Credenciais inválidas. Verifique seu e-mail e senha.');
    }

    const session = this.createSession(user.id, userAgent, ipAddress);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role || 'developer',
        created_at: user.created_at,
      },
      session,
    };
  }

  /**
   * Create a persistent session token
   */
  static createSession(userId: string, userAgent: string = '', ipAddress: string = ''): SessionInfo {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const sessionId = 'sess-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    
    // 30 days expiration
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO sessions (id, user_id, token_hash, expires_at, user_agent, ip_address, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, userId, tokenHash, expiresAt, userAgent, ipAddress, now);

    return {
      token: rawToken,
      userId,
      expiresAt,
    };
  }

  /**
   * Validate session token from cookie
   */
  static validateSession(token: string): AuthUser | null {
    if (!token) return null;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const session = db.prepare(`
      SELECT s.*, u.id as user_id, u.email, u.name, u.role, u.created_at as user_created_at
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token_hash = ?
    `).get(tokenHash) as any;

    if (!session) return null;

    if (new Date(session.expires_at).getTime() < Date.now()) {
      // Session expired, delete it
      db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
      return null;
    }

    return {
      id: session.user_id,
      email: session.email,
      name: session.name,
      role: session.role || 'developer',
      created_at: session.user_created_at,
    };
  }

  /**
   * Find user by ID
   */
  static getUserById(userId: string): AuthUser | null {
    if (!userId) return null;
    const user = db.prepare('SELECT id, email, name, role, created_at FROM users WHERE id = ?').get(userId) as any;
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role || 'developer',
      created_at: user.created_at,
    };
  }

  /**
   * Invalidate specific session token (logout)
   */
  static logout(token: string): void {
    if (!token) return;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  /**
   * Invalidate all sessions for user
   */
  static logoutAllSessions(userId: string): void {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  /**
   * Change user password
   */
  static changePassword(userId: string, currentPass: string, newPass: string): void {
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as any;
    if (!user || !user.password_hash) {
      throw new Error('Usuário não localizado.');
    }
    if (!this.verifyPassword(currentPass, user.password_hash)) {
      throw new Error('Senha atual incorreta.');
    }
    if (!newPass || newPass.length < 8) {
      throw new Error('A nova senha deve ter no mínimo 8 caracteres.');
    }
    const newHash = this.hashPassword(newPass);
    const now = new Date().toISOString();
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(newHash, now, userId);
    // Invalidate other sessions
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  /**
   * Update profile info
   */
  static updateProfile(userId: string, name?: string, email?: string): AuthUser {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
    if (!user) throw new Error('Usuário não localizado.');

    const cleanName = name !== undefined ? name.trim() : user.name;
    let cleanEmail = user.email;

    if (email && email.trim().toLowerCase() !== user.email.toLowerCase()) {
      cleanEmail = email.trim().toLowerCase();
      if (!cleanEmail.includes('@') || !cleanEmail.includes('.')) {
        throw new Error('E-mail inválido.');
      }
      const conflict = db.prepare('SELECT id FROM users WHERE LOWER(email) = ? AND id != ?').get(cleanEmail, userId);
      if (conflict) {
        throw new Error('Este e-mail já está em uso por outra conta.');
      }
    }

    const now = new Date().toISOString();
    db.prepare('UPDATE users SET name = ?, email = ?, updated_at = ? WHERE id = ?').run(cleanName, cleanEmail, now, userId);

    return {
      id: userId,
      email: cleanEmail,
      name: cleanName,
      role: user.role || 'developer',
      created_at: user.created_at,
    };
  }

  /**
   * Delete user account and cascade all owned data
   */
  static deleteAccount(userId: string): void {
    // Collect projects
    const projects = db.prepare('SELECT id FROM projects WHERE user_id = ?').all(userId) as any[];
    for (const p of projects) {
      const convs = db.prepare('SELECT id FROM conversations WHERE project_id = ?').all(p.id) as any[];
      for (const c of convs) {
        db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(c.id);
      }
      db.prepare('DELETE FROM conversations WHERE project_id = ?').run(p.id);
      db.prepare('DELETE FROM plans WHERE project_id = ?').run(p.id);
      db.prepare('DELETE FROM checkpoints WHERE project_id = ?').run(p.id);
      db.prepare('DELETE FROM verifications WHERE project_id = ?').run(p.id);
      db.prepare('DELETE FROM branches WHERE project_id = ?').run(p.id);
      db.prepare('DELETE FROM project_sources WHERE project_id = ?').run(p.id);
      db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
    }

    db.prepare('DELETE FROM user_secrets WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM skills WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM providers WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM integrations WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM workspaces WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }

  /**
   * Seed standard skills and providers for newly registered user
   */
  static seedUserData(userId: string): void {
    const now = new Date().toISOString();

    const standardSkills = [
      { name: 'TypeScript & React', slug: 'typescript-react', desc: 'React 19, componentes funcionais tipados e sem any.' },
      { name: 'UI Premium & Design System', slug: 'ui-premium', desc: 'Layouts sofisticados, contraste WCAG AA, bordas refinadas de 1px.' },
      { name: 'Segurança & Secrets Guard', slug: 'seguranca', desc: 'Proteção de chaves privadas e validação estrita de inputs.' },
      { name: 'Reviewer Loop', slug: 'reviewer-loop', desc: 'Revisão profunda de diffs e checagens automáticas de integridade.' },
      { name: 'GitHub Workflow', slug: 'github-workflow', desc: 'Branches, commits semânticos e pull requests estruturados.' },
      { name: 'Acessibilidade WCAG', slug: 'acessibilidade', desc: 'Contraste, navegação por teclado e semântica acessível.' },
      { name: 'Debugging & Diagnóstico', slug: 'debugging', desc: 'Análise detalhada de causa raiz e mitigação preventiva.' },
      { name: 'Testing & Quality', slug: 'testing', desc: 'Geração de cenários de teste unitários e de integração.' },
      { name: 'Refactoring Limpo', slug: 'refactoring', desc: 'Modularização de código e eliminação de duplicações.' },
      { name: 'Performance & Bundle', slug: 'performance', desc: 'Otimização de renderização, lazy loading e redução de overhead.' },
      { name: 'Browser Verification', slug: 'browser-verification', desc: 'Verificação em preview isolado e sandbox de execução.' },
      { name: 'Security Review', slug: 'security-review', desc: 'Auditoria de vulnerabilidades, injeção e vazamento de dados.' },
    ];

    for (const sk of standardSkills) {
      const skillId = `skill-${userId}-${sk.slug}`;
      db.prepare(`
        INSERT OR IGNORE INTO skills (id, user_id, name, slug, description, system_instructions, scope, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'project', 1, ?)
      `).run(skillId, userId, sk.name, sk.slug, sk.desc, `Atue como especialista em ${sk.name}.`, now);
    }

    // Default Providers for this user
    const defaultProviders = [
      { id: `prov-${userId}-useoneai`, key: 'useoneai', name: 'UseOneAI (OpenAI-Compatible)', url: 'https://api.useoneai.app/v1', model: 'chatgpt-5.5' },
      { id: `prov-${userId}-gemini`, key: 'gemini', name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com', model: 'gemini-3.5-flash-lite' },
      { id: `prov-${userId}-openai`, key: 'openai', name: 'OpenAI Oficial', url: 'https://api.openai.com/v1', model: 'gpt-4o' },
      { id: `prov-${userId}-omniroute`, key: 'omniroute', name: 'OmniRoute (Free Pool)', url: 'http://127.0.0.1:20128/v1', model: 'auto' },
      { id: `prov-${userId}-cheaper-inference`, key: 'cheaper_inference', name: 'Cheaper Inference (Paid Pool)', url: 'https://api.cheaperinference.com/v1', model: 'gpt-5.6-luna' },
    ];

    for (const p of defaultProviders) {
      db.prepare(`
        INSERT OR IGNORE INTO providers (id, user_id, provider_key, name, base_url, model_id, is_configured, connection_status, context_limit, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, 'not_configured', 128000, ?)
      `).run(p.id, userId, p.key, p.name, p.url, p.model, now);
    }
    for (const profile of [{key:'BASE_FREE',level:0,attempts:2,cost:0,enabled:1},{key:'EXPERT_PAID',level:1,attempts:2,cost:.25,enabled:1},{key:'PREMIUM_OVERRIDE',level:2,attempts:1,cost:.25,enabled:0}])
      db.prepare(`INSERT OR IGNORE INTO model_profiles(id,user_id,profile_key,level,max_attempts,max_cost_usd,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(`profile-${userId}-${profile.key}`,userId,profile.key,profile.level,profile.attempts,profile.cost,profile.enabled,now,now);
    const defaults=[
      {profile:'BASE_FREE',provider:'omniroute',model:'auto',priority:0},
      {profile:'EXPERT_PAID',provider:'cheaper_inference',model:'gpt-5.6-luna',priority:0},
      {profile:'PREMIUM_OVERRIDE',provider:'cheaper_inference',model:'gpt-5.6-luna',priority:0},
    ];
    for(const c of defaults){const profileId=`profile-${userId}-${c.profile}`;db.prepare(`INSERT OR IGNORE INTO model_candidates(id,profile_id,provider_key,model_id,priority,enabled,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)`).run(`candidate-${userId}-${c.profile}-default`,profileId,c.provider,c.model,c.priority,now,now);}
  }
}


