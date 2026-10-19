import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ServiceError } from './schema.ts';
import type { Device } from './schema.ts';
import type { Store } from './store.ts';

const DAY = 86400000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const username = z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_.@-]+$/).transform(v => v.toLowerCase());
const password = z.string().min(15, 'Use a password of at least 15 characters').max(128);
const platform = z.enum(['mac', 'win', 'phone', 'web']);
const loginSchema = z.object({ username, password: z.string().min(1).max(128), name: z.string().trim().min(1).max(100),
  platform, installationId: z.string().uuid() }).strict();
type User = { username: string; salt: string; password_hash: string; recovery_hash: string; created_at: number };
type Registered = { id: string; name: string; platform: string; installation: string | null; permissions: string;
  legacy_hash: string | null; legacy_enabled: number; revoked: number; created_at: number; last_seen: number };
type Session = { id: string; device: string; token_hash: string; csrf: string; browser: number; created_at: number; expires_at: number; last_seen: number };
export type Principal = { device: Device; session: Session | null; legacy: boolean };

function derive(value: string, salt: string): Promise<Buffer> {
  // OWASP scrypt alternative: N=2^15, r=8, p=3; bounded to one concurrent derivation.
  return new Promise((resolve, reject) => scrypt(value, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
    (error, key) => error ? reject(error) : resolve(key)));
}
function equal(left: string, right: string) {
  const a = Buffer.from(left, 'hex'), b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One personal account per deployment, multiple independent, revocable devices.
 * Legacy pairing remains a migration credential, never an account-admin session.
 */
export class AccountService {
  store: Store;
  private deriving = false;
  constructor(store: Store, legacy: { device: Device; token: string }[]) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS account_user (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), username TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL, password_hash TEXT NOT NULL, recovery_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL,
      installation TEXT, permissions TEXT NOT NULL, legacy_hash TEXT, legacy_enabled INTEGER NOT NULL DEFAULT 0,
      revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_sessions (id TEXT PRIMARY KEY, device TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      csrf TEXT NOT NULL, browser INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_attempts (key TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, device TEXT, action TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_config (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);`);
    for (const { device, token } of legacy) {
      store.db.prepare(`INSERT INTO account_devices
      (id,name,platform,permissions,legacy_hash,legacy_enabled,created_at,last_seen) VALUES(?,?,?,?,?,1,?,0)
      ON CONFLICT(id) DO UPDATE SET legacy_hash=excluded.legacy_hash`)
      .run(device.id, device.id, device.id === 'mac' ? 'mac' : device.id === 'win' ? 'win' : 'phone',
        JSON.stringify(device), hash(token), store.now());
      const fingerprint = hash(JSON.stringify(device));
      const previous = store.db.prepare('SELECT fingerprint FROM account_config WHERE id=?').get(device.id);
      if (previous && previous.fingerprint !== fingerprint) store.db.prepare('UPDATE account_devices SET permissions=? WHERE id=?').run(JSON.stringify(device), device.id);
      store.db.prepare('INSERT INTO account_config VALUES(?,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint').run(device.id, fingerprint);
    }
    this.syncPermissions();
  }
  private user() { return this.store.db.prepare('SELECT * FROM account_user WHERE singleton=1').get() as User | undefined; }
  private row(id: string) { return this.store.db.prepare('SELECT * FROM account_devices WHERE id=?').get(id) as Registered | undefined; }
  private rows() { return this.store.db.prepare('SELECT * FROM account_devices ORDER BY created_at,id').all() as Registered[]; }
  private audit(device: string | null, action: string) { this.store.db.prepare('INSERT INTO account_audit(device,action,at) VALUES(?,?,?)').run(device, action, this.store.now()); }
  private syncPermissions() {
    this.store.config.devices = this.rows().filter(row => !row.revoked).map(row => JSON.parse(row.permissions) as Device);
    for (const row of this.rows()) this.store.config.mailboxes[`/tasks/${row.id}`] = row.id;
  }
  private throttle(key: string) {
    const now = this.store.now();
    this.store.db.prepare('DELETE FROM account_attempts WHERE start < ?').run(now - 15 * 60000);
    const entry = this.store.db.prepare('SELECT count FROM account_attempts WHERE key=?').get(hash(key));
    if (entry && Number(entry.count) >= 8) throw new ServiceError(429, 'Too many sign-in attempts; retry after 15 minutes');
    this.store.db.prepare('INSERT INTO account_attempts VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=count+1').run(hash(key), now);
  }
  private async verify(value: string, user: User | undefined) {
    if (this.deriving) throw new ServiceError(429, 'Another sign-in is in progress; retry shortly');
    this.deriving = true;
    try { const result = await derive(value, user?.salt ?? 'dogo-unknown-account-salt'); return !!user && equal(result.toString('hex'), user.password_hash); }
    finally { this.deriving = false; }
  }
  authenticate(token: string, browser = false): Principal {
    if (!token || token.length > 256) throw new ServiceError(401, 'Sign in required');
    const digest = hash(token), now = this.store.now();
    const session = this.store.db.prepare('SELECT * FROM account_sessions WHERE token_hash=?').get(digest) as Session | undefined;
    let row: Registered | undefined;
    if (session) {
      if (!!session.browser !== browser || session.expires_at <= now || now - session.last_seen > (browser ? DAY : 30 * DAY))
        throw new ServiceError(401, 'Session expired; sign in again');
      row = this.row(session.device);
    } else if (!browser) row = this.rows().find(d => d.legacy_enabled && d.legacy_hash && equal(d.legacy_hash, digest));
    if (!row || row.revoked) throw new ServiceError(401, 'Device is revoked or credentials are invalid');
    if (now - row.last_seen > 60000) this.store.db.prepare('UPDATE account_devices SET last_seen=? WHERE id=?').run(now, row.id);
    if (session && now - session.last_seen > 60000) this.store.db.prepare('UPDATE account_sessions SET last_seen=? WHERE id=?').run(now, session.id);
    const device = this.store.config.devices.find(d => d.id === row!.id);
    if (!device) throw new ServiceError(401, 'Device is no longer authorized');
    return { device, session: session ?? null, legacy: !session };
  }
  checkCsrf(principal: Principal, value: string | undefined) {
    if (!principal.session?.browser || !value || !equal(hash(value), hash(principal.session.csrf))) throw new ServiceError(403, 'CSRF validation failed');
  }
  status(principal?: Principal) {
    const user = this.user();
    return { initialized: !!user, authenticated: !!principal?.session, legacy: !!principal?.legacy,
      username: principal?.session ? user?.username : undefined, device: principal?.device.id,
      csrf: principal?.session?.browser ? principal.session.csrf : undefined, expiresAt: principal?.session?.expires_at };
  }
  private requireAccount(principal: Principal) { if (!principal.session || !this.user()) throw new ServiceError(403, 'Account sign-in required; pairing is not an account login'); }
  private issue(device: string, browser: boolean) {
    const token = secret(), csrf = secret(), now = this.store.now(), id = randomUUID();
    const expiresAt = now + (browser ? 7 : 180) * DAY;
    this.store.db.prepare('DELETE FROM account_sessions WHERE expires_at<=?').run(now);
    this.store.db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?,?,?,?,?)').run(id, device, hash(token), csrf, Number(browser), now, expiresAt, now);
    this.audit(device, 'login');
    return { token, csrf, device, username: this.user()!.username, expiresAt, platform: this.row(device)!.platform };
  }
  private enroll(input: z.infer<typeof loginSchema>, migration?: Principal) {
    let row = migration && this.row(migration.device.id);
    if (row && row.platform !== input.platform) throw new ServiceError(400, 'Device platform mismatch');
    row ??= this.rows().find(r => r.installation === input.installationId && r.platform === input.platform);
    if (row?.revoked) {
      // Fresh password proof can re-register this installation, but never restores revoked grants.
      this.store.db.prepare('UPDATE account_devices SET revoked=0,legacy_enabled=0,permissions=? WHERE id=?')
        .run(JSON.stringify({ id: row.id, tokenEnv: 'DOGO_DYNAMIC', publishTo: [], memory: false }), row.id);
      this.syncPermissions(); this.audit(row.id, 'device.register-again');
    }
    if (row) {
      this.store.db.prepare('UPDATE account_devices SET name=?,installation=? WHERE id=?').run(input.name, input.installationId, row.id);
      return row.id;
    }
    const id = `${input.platform}-${randomUUID()}`;
    const device: Device = { id, tokenEnv: 'DOGO_DYNAMIC', publishTo: [], memory: false };
    this.store.db.prepare(`INSERT INTO account_devices(id,name,platform,installation,permissions,created_at,last_seen) VALUES(?,?,?,?,?,?,0)`)
      .run(id, input.name, input.platform, input.installationId, JSON.stringify(device), this.store.now());
    this.syncPermissions(); this.audit(id, 'device.register');
    return id;
  }
  async setup(value: unknown, migration: Principal, address: string) {
    if (this.user()) throw new ServiceError(409, 'Account already initialized');
    if (!migration.legacy || !['mac', 'win'].includes(this.row(migration.device.id)?.platform ?? ''))
      throw new ServiceError(403, 'Initialize from an already paired desktop');
    const input = loginSchema.parse(value); password.parse(input.password); this.throttle(`setup:${address}`);
    if (this.deriving) throw new ServiceError(429, 'Account initialization in progress');
    this.deriving = true;
    try {
      const salt = secret(), key = await derive(input.password, salt), recovery = secret();
      return this.store.transaction(() => {
        if (this.user()) throw new ServiceError(409, 'Account already initialized');
        this.store.db.prepare('INSERT INTO account_user VALUES(1,?,?,?,?,?)').run(input.username, salt, key.toString('hex'), hash(recovery), this.store.now());
        const device = this.enroll(input, migration);
        return { ...this.issue(device, false), recoveryCode: recovery };
      });
    } finally { this.deriving = false; }
  }
  async login(value: unknown, address: string, browser: boolean, migration?: Principal) {
    const input = loginSchema.parse(value);
    if (browser !== (input.platform === 'web')) throw new ServiceError(400, 'Client platform mismatch');
    this.throttle(`ip:${address}`); this.throttle(`user:${input.username}`);
    const user = this.user();
    if (!await this.verify(input.password, user) || user?.username !== input.username) throw new ServiceError(401, 'Incorrect account or password');
    this.store.db.prepare('DELETE FROM account_attempts WHERE key=?').run(hash(`user:${input.username}`));
    this.store.db.prepare('DELETE FROM account_attempts WHERE key=?').run(hash(`ip:${address}`));
    const device = this.enroll(input, migration);
    return this.issue(device, browser);
  }
  async reset(value: unknown, address: string) {
    const input = z.object({ username, recoveryCode: z.string().min(40).max(128), password }).strict().parse(value);
    this.throttle(`reset:${address}`); const user = this.user();
    if (!user || user.username !== input.username || !equal(hash(input.recoveryCode), user.recovery_hash)) throw new ServiceError(401, 'Invalid recovery information');
    if (this.deriving) throw new ServiceError(429, 'Another account operation is in progress');
    this.deriving = true;
    try {
      const salt = secret(), key = await derive(input.password, salt), recovery = secret();
      this.store.transaction(() => {
        if (this.user()?.recovery_hash !== user.recovery_hash) throw new ServiceError(409, 'Recovery code already used');
        this.store.db.prepare('UPDATE account_user SET salt=?,password_hash=?,recovery_hash=?').run(salt, key.toString('hex'), hash(recovery));
        this.store.db.exec('DELETE FROM account_sessions; UPDATE account_devices SET legacy_enabled=0; DELETE FROM presence');
        this.audit(null, 'password.recovered');
      });
      return { recoveryCode: recovery, signInRequired: true };
    } finally { this.deriving = false; }
  }
  async changePassword(principal: Principal, value: unknown) {
    this.requireAccount(principal);
    const input = z.object({ currentPassword: z.string().max(128), password }).strict().parse(value);
    this.throttle(`password:${principal.device.id}`);
    if (!await this.verify(input.currentPassword, this.user())) throw new ServiceError(401, 'Incorrect current password');
    this.deriving = true;
    try {
      const salt = secret(), key = await derive(input.password, salt), recovery = secret();
      this.store.transaction(() => {
        this.store.db.prepare('UPDATE account_user SET salt=?,password_hash=?,recovery_hash=?').run(salt, key.toString('hex'), hash(recovery));
        this.store.db.exec('DELETE FROM account_sessions; UPDATE account_devices SET legacy_enabled=0; DELETE FROM presence');
        this.audit(principal.device.id, 'password.changed');
      });
      return { recoveryCode: recovery, signInRequired: true };
    } finally { this.deriving = false; }
  }
  devices(principal: Principal) {
    this.requireAccount(principal);
    return { devices: this.rows().map(row => ({ id: row.id, name: row.name, platform: row.platform, revoked: !!row.revoked,
      legacyEnabled: !!row.legacy_enabled, createdAt: row.created_at, lastSeen: row.last_seen,
      online: this.store.online(row.id), permissions: JSON.parse(row.permissions) })) };
  }
  updateDevice(principal: Principal, value: unknown) {
    this.requireAccount(principal);
    const input = z.object({ id: z.string().max(100), name: z.string().trim().min(1).max(100),
      memory: z.boolean(), sendTo: z.array(z.string().max(100)).max(100) }).strict().parse(value);
    const row = this.row(input.id); if (!row || row.revoked) throw new ServiceError(404, 'Active device not found');
    for (const target of input.sendTo) if (!this.row(target) || this.row(target)!.revoked) throw new ServiceError(400, 'Unknown target device');
    const permissions: Device = { id: row.id, tokenEnv: 'DOGO_DYNAMIC', memory: input.memory, publishTo: [...new Set(input.sendTo)].map(id => `/tasks/${id}`) };
    this.store.db.prepare('UPDATE account_devices SET name=?,permissions=? WHERE id=?').run(input.name, JSON.stringify(permissions), row.id);
    this.syncPermissions(); this.audit(principal.device.id, 'device.permissions');
    return this.devices(principal);
  }
  revoke(principal: Principal, value: unknown) {
    this.requireAccount(principal);
    const { id } = z.object({ id: z.string().max(100) }).strict().parse(value);
    if (!this.row(id)) throw new ServiceError(404, 'Device not found');
    this.store.transaction(() => {
      this.store.db.prepare('UPDATE account_devices SET revoked=1,legacy_enabled=0 WHERE id=?').run(id);
      this.store.db.prepare('DELETE FROM account_sessions WHERE device=?').run(id);
      this.store.db.prepare('DELETE FROM presence WHERE device=?').run(id);
      this.audit(principal.device.id, 'device.revoked');
    });
    this.syncPermissions(); return { revoked: id };
  }
  disableLegacy(principal: Principal) {
    this.requireAccount(principal);
    this.store.db.prepare('UPDATE account_devices SET legacy_enabled=0 WHERE id=?').run(principal.device.id);
    this.audit(principal.device.id, 'legacy.disabled'); return { ok: true };
  }
  logout(principal: Principal) {
    this.requireAccount(principal);
    this.store.db.prepare('DELETE FROM account_sessions WHERE id=?').run(principal.session!.id);
    this.store.db.prepare('DELETE FROM presence WHERE device=?').run(principal.device.id);
    this.audit(principal.device.id, 'logout'); return { ok: true };
  }
}
