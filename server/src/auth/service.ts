import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import QRCode from 'qrcode';
import type { SessionInfoDTO } from '@datix/shared';
import type { DB } from '../db';
import { getMeta, setMeta, deleteMeta } from '../db';
import type { Config } from '../config';
import type { SecretsService } from '../settings/secrets';
import type { AuditService } from '../audit';
import type { Logger } from '../logger';
import { hashPassword, passwordProblem, verifyPassword } from './password';
import { generateTotpSecret, totpUri, verifyTotp, base32Encode } from './totp';
import { newId, randomToken } from '../util/ids';
import { DAY, MINUTE } from '../util/time';
import { safeJsonParse } from '../util/text';

export const SESSION_COOKIE = 'datix_session';
const SESSION_TTL = 30 * DAY;
const STEP_UP_TTL = 5 * MINUTE;
const CHALLENGE_TTL = 5 * MINUTE;

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status = 401,
  ) {
    super(message);
  }
}

export interface SessionRow {
  id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  step_up_until: number;
  ip: string | null;
  user_agent: string | null;
  auth_method: string;
}

interface AdminRow {
  id: number;
  email: string;
  display_name: string;
  password_hash: string;
  totp_secret_enc: string | null;
  totp_enabled: number;
  recovery_codes: string | null;
}

interface PasskeyRow {
  id: string;
  public_key: Buffer;
  counter: number;
  transports: string | null;
  device_type: string | null;
  backed_up: number;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export class AuthService {
  constructor(
    private readonly db: DB,
    private readonly config: Config,
    private readonly secrets: SecretsService,
    private readonly audit: AuditService,
    private readonly log: Logger,
    private readonly agentName: () => string,
  ) {}

  // ================================================================= admin & setup

  private admin(): AdminRow | null {
    return (this.db.prepare('SELECT * FROM admin WHERE id = 1').get() as AdminRow | undefined) ?? null;
  }

  isSetupRequired(): boolean {
    const a = this.admin();
    return !a || a.totp_enabled !== 1;
  }

  /** Tokenul de instalare protejează prima configurare (cine îl are poate crea contul de administrator). */
  ensureSetupToken(): string | null {
    if (!this.isSetupRequired()) {
      deleteMeta(this.db, 'setup_token');
      return null;
    }
    if (this.config.setupToken) return this.config.setupToken;
    let token = getMeta(this.db, 'setup_token');
    if (!token) {
      token = randomToken(18);
      setMeta(this.db, 'setup_token', token);
    }
    return token;
  }

  private checkSetupToken(token: string | undefined): void {
    const expected = this.ensureSetupToken();
    if (!expected) throw new AuthError('Configurarea inițială a fost deja făcută.', 409);
    const a = Buffer.from(token ?? '');
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AuthError('Codul de instalare nu e corect. Îl găsești în mesajul afișat la instalare sau în logurile serverului.', 403);
  }

  async startSetup(input: { token?: string; displayName: string; email: string; password: string }, ip: string | null, ua: string | null) {
    this.checkSetupToken(input.token);
    const problem = passwordProblem(input.password);
    if (problem) throw new AuthError(problem, 400);
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError('Adresa de e-mail nu e validă.', 400);
    const displayName = input.displayName.trim().slice(0, 80) || 'Administrator';
    const passwordHash = await hashPassword(input.password);
    const secret = generateTotpSecret();
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM admin').run();
      this.db.prepare('DELETE FROM sessions').run();
      this.db
        .prepare(
          'INSERT INTO admin (id, email, display_name, password_hash, totp_secret_enc, totp_enabled, recovery_codes, created_at, updated_at) VALUES (1, ?, ?, ?, ?, 0, NULL, ?, ?)',
        )
        .run(email, displayName, passwordHash, this.secrets.encrypt(secret), now, now);
    })();
    const session = this.createSession('setup', ip, ua, true);
    const uri = totpUri(secret, email, this.agentName());
    const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
    this.audit.log({ actor: 'owner', action: 'setup.started', target: email, ip });
    return { sessionToken: session.token, otpauthUri: uri, totpSecret: secret, qrDataUrl };
  }

  confirmSetupTotp(session: SessionRow, code: string, ip: string | null): { recoveryCodes: string[] } {
    const admin = this.admin();
    if (!admin || !admin.totp_secret_enc) throw new AuthError('Configurarea nu a început.', 400);
    if (admin.totp_enabled === 1) throw new AuthError('Autentificarea în doi pași e deja activă.', 409);
    if (session.auth_method !== 'setup') throw new AuthError('Sesiune invalidă pentru configurare.', 403);
    const secret = this.secrets.decrypt(admin.totp_secret_enc);
    const counter = verifyTotp(secret, code);
    if (counter == null) throw new AuthError('Codul din aplicația de autentificare nu e corect. Verifică ora telefonului și încearcă din nou.', 400);
    setMeta(this.db, 'totp_last_counter', String(counter));
    const codes = this.generateRecoveryCodes();
    this.db.prepare('UPDATE admin SET totp_enabled = 1, recovery_codes = ?, updated_at = ? WHERE id = 1').run(JSON.stringify(codes.hashes), Date.now());
    this.db.prepare("UPDATE sessions SET auth_method = 'password+totp' WHERE id = ?").run(session.id);
    deleteMeta(this.db, 'setup_token');
    this.audit.log({ actor: 'owner', action: 'setup.completed', ip });
    return { recoveryCodes: codes.plain };
  }

  private generateRecoveryCodes(): { plain: string[]; hashes: string[] } {
    const plain: string[] = [];
    for (let i = 0; i < 8; i++) {
      const raw = base32Encode(randomBytes(7)).slice(0, 10);
      plain.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
    }
    return { plain, hashes: plain.map((c) => hashToken(c.replace(/-/g, ''))) };
  }

  regenerateRecoveryCodes(ip: string | null): string[] {
    const codes = this.generateRecoveryCodes();
    this.db.prepare('UPDATE admin SET recovery_codes = ?, updated_at = ? WHERE id = 1').run(JSON.stringify(codes.hashes), Date.now());
    this.audit.log({ actor: 'owner', action: 'auth.recovery_codes_regenerated', ip });
    return codes.plain;
  }

  private consumeRecoveryCode(code: string): boolean {
    const admin = this.admin();
    if (!admin) return false;
    const hashes = safeJsonParse<string[]>(admin.recovery_codes, []);
    const h = hashToken(code.replace(/[\s-]/g, '').toUpperCase());
    const idx = hashes.indexOf(h);
    if (idx === -1) return false;
    hashes.splice(idx, 1);
    this.db.prepare('UPDATE admin SET recovery_codes = ?, updated_at = ? WHERE id = 1').run(JSON.stringify(hashes), Date.now());
    return true;
  }

  private checkTotp(code: string): boolean {
    const admin = this.admin();
    if (!admin?.totp_secret_enc) return false;
    const secret = this.secrets.decrypt(admin.totp_secret_enc);
    const counter = verifyTotp(secret, code);
    if (counter == null) return false;
    const last = Number(getMeta(this.db, 'totp_last_counter') ?? '0');
    if (counter <= last) return false; // același cod nu poate fi folosit de două ori
    setMeta(this.db, 'totp_last_counter', String(counter));
    return true;
  }

  // ================================================================= limitare încercări

  private assertNotLocked(ip: string | null): void {
    const since = Date.now() - 15 * MINUTE;
    const perIp = (this.db.prepare('SELECT COUNT(*) n FROM login_attempts WHERE success = 0 AND at > ? AND ip IS ?').get(since, ip) as { n: number }).n;
    if (perIp >= 8) throw new AuthError('Prea multe încercări eșuate. Încearcă din nou peste 15 minute.', 429);
    const global = (this.db.prepare('SELECT COUNT(*) n FROM login_attempts WHERE success = 0 AND at > ?').get(Date.now() - 60 * MINUTE) as { n: number }).n;
    if (global >= 40) throw new AuthError('Autentificarea cu parolă e blocată temporar din cauza multor încercări eșuate. Folosește Face ID sau așteaptă o oră.', 429);
  }

  private recordAttempt(ip: string | null, success: boolean, method: string): void {
    this.db.prepare('INSERT INTO login_attempts (ip, at, success, method) VALUES (?, ?, ?, ?)').run(ip, Date.now(), success ? 1 : 0, method);
  }

  failedAttemptsLastHour(): number {
    return (this.db.prepare('SELECT COUNT(*) n FROM login_attempts WHERE success = 0 AND at > ?').get(Date.now() - 60 * MINUTE) as { n: number }).n;
  }

  // ================================================================= login cu parolă

  async loginWithPassword(input: { email: string; password: string; code: string }, ip: string | null, ua: string | null) {
    this.assertNotLocked(ip);
    const admin = this.admin();
    if (!admin || admin.totp_enabled !== 1) throw new AuthError('Aplicația nu e configurată încă.', 409);
    const emailOk = admin.email === input.email.trim().toLowerCase();
    const passOk = await verifyPassword(input.password, admin.password_hash);
    if (!emailOk || !passOk) {
      this.recordAttempt(ip, false, 'password');
      this.audit.log({ actor: 'system', action: 'auth.login_failed', details: 'e-mail sau parolă greșită', ip });
      throw new AuthError('E-mailul sau parola nu sunt corecte.');
    }
    const code = input.code.trim();
    const secondFactorOk = /^\d{6}$/.test(code) ? this.checkTotp(code) : this.consumeRecoveryCode(code);
    if (!secondFactorOk) {
      this.recordAttempt(ip, false, 'totp');
      this.audit.log({ actor: 'system', action: 'auth.login_failed', details: 'cod 2FA greșit', ip });
      throw new AuthError('Codul de autentificare nu e corect.');
    }
    this.recordAttempt(ip, true, 'password+totp');
    this.audit.log({ actor: 'owner', action: 'auth.login', details: 'parolă + 2FA', ip });
    return this.createSession('password+totp', ip, ua, true);
  }

  // ================================================================= sesiuni

  createSession(method: string, ip: string | null, ua: string | null, stepUp: boolean): { token: string; session: SessionRow } {
    const token = randomToken(32);
    const now = Date.now();
    const session: SessionRow = {
      id: hashToken(token),
      created_at: now,
      expires_at: now + SESSION_TTL,
      last_seen_at: now,
      step_up_until: stepUp ? now + STEP_UP_TTL : 0,
      ip,
      user_agent: ua ? ua.slice(0, 300) : null,
      auth_method: method,
    };
    this.db
      .prepare('INSERT INTO sessions (id, created_at, expires_at, last_seen_at, step_up_until, ip, user_agent, auth_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(session.id, session.created_at, session.expires_at, session.last_seen_at, session.step_up_until, session.ip, session.user_agent, session.auth_method);
    return { token, session };
  }

  getSession(token: string | undefined): SessionRow | null {
    if (!token || token.length > 200) return null;
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(hashToken(token)) as SessionRow | undefined;
    if (!row) return null;
    const now = Date.now();
    if (row.expires_at < now) {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
      return null;
    }
    // expirare glisantă: prelungim sesiunea la folosire (cel mult o dată pe oră)
    if (now - row.last_seen_at > 60 * MINUTE) {
      row.last_seen_at = now;
      row.expires_at = now + SESSION_TTL;
      this.db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(row.last_seen_at, row.expires_at, row.id);
    }
    return row;
  }

  revokeSessionByToken(token: string | undefined): void {
    if (!token) return;
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token));
  }

  listSessions(currentId: string) {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY last_seen_at DESC').all() as SessionRow[];
    return rows.map((r) => ({
      id: r.id.slice(0, 16),
      current: r.id === currentId,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      ip: r.ip,
      userAgent: r.user_agent,
      method: r.auth_method,
    }));
  }

  revokeSessionByPrefix(prefix: string, currentId: string): boolean {
    if (!/^[a-f0-9]{16}$/.test(prefix)) return false;
    const row = this.db.prepare("SELECT id FROM sessions WHERE substr(id, 1, 16) = ?").get(prefix) as { id: string } | undefined;
    if (!row || row.id === currentId) return false;
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    return true;
  }

  revokeOtherSessions(currentId: string): number {
    return this.db.prepare('DELETE FROM sessions WHERE id != ?').run(currentId).changes;
  }

  hasStepUp(session: SessionRow): boolean {
    return session.step_up_until > Date.now();
  }

  markStepUp(sessionId: string): number {
    const until = Date.now() + STEP_UP_TTL;
    this.db.prepare('UPDATE sessions SET step_up_until = ? WHERE id = ?').run(until, sessionId);
    return until;
  }

  stepUpWithTotp(session: SessionRow, code: string, ip: string | null): number {
    this.assertNotLocked(ip);
    const ok = /^\d{6}$/.test(code.trim()) ? this.checkTotp(code.trim()) : this.consumeRecoveryCode(code);
    if (!ok) {
      this.recordAttempt(ip, false, 'stepup-totp');
      throw new AuthError('Codul de autentificare nu e corect.');
    }
    return this.markStepUp(session.id);
  }

  sessionInfo(session: SessionRow | null): SessionInfoDTO {
    const admin = this.admin();
    const setupRequired = this.isSetupRequired();
    return {
      authenticated: !!session && !setupRequired,
      setupRequired,
      setupTokenRequired: setupRequired,
      displayName: session ? (admin?.display_name ?? null) : null,
      email: session ? (admin?.email ?? null) : null,
      hasPasskey: this.passkeyCount() > 0,
      totpEnabled: admin?.totp_enabled === 1,
      stepUpUntil: session?.step_up_until ?? 0,
      demoMode: this.config.demoMode,
      agentName: this.agentName(),
    };
  }

  // ================================================================= parolă

  async changePassword(current: string, next: string, ip: string | null): Promise<void> {
    const admin = this.admin();
    if (!admin) throw new AuthError('Cont inexistent.', 404);
    if (!(await verifyPassword(current, admin.password_hash))) throw new AuthError('Parola actuală nu e corectă.', 400);
    const problem = passwordProblem(next);
    if (problem) throw new AuthError(problem, 400);
    this.db.prepare('UPDATE admin SET password_hash = ?, updated_at = ? WHERE id = 1').run(await hashPassword(next), Date.now());
    this.audit.log({ actor: 'owner', action: 'auth.password_changed', ip });
  }

  // ================================================================= passkeys (Face ID / Touch ID)

  private webauthnUserId(): Uint8Array {
    let id = getMeta(this.db, 'webauthn_user_id');
    if (!id) {
      id = randomBytes(32).toString('base64url');
      setMeta(this.db, 'webauthn_user_id', id);
    }
    return new Uint8Array(Buffer.from(id, 'base64url'));
  }

  passkeyCount(): number {
    return (this.db.prepare('SELECT COUNT(*) n FROM passkeys').get() as { n: number }).n;
  }

  listPasskeys() {
    const rows = this.db.prepare('SELECT * FROM passkeys ORDER BY created_at').all() as PasskeyRow[];
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at, backedUp: r.backed_up === 1 }));
  }

  private storeChallenge(kind: string, challenge: string, sessionId: string | null): string {
    const id = newId('ch_');
    const now = Date.now();
    this.db.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').run(now);
    this.db
      .prepare('INSERT INTO auth_challenges (id, kind, challenge, session_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, kind, challenge, sessionId, now, now + CHALLENGE_TTL);
    return id;
  }

  private takeChallenge(id: string, kind: string, sessionId: string | null): string {
    const row = this.db.prepare('SELECT * FROM auth_challenges WHERE id = ?').get(id) as
      | { kind: string; challenge: string; session_id: string | null; expires_at: number }
      | undefined;
    this.db.prepare('DELETE FROM auth_challenges WHERE id = ?').run(id);
    if (!row || row.kind !== kind || row.expires_at < Date.now()) throw new AuthError('Cererea a expirat. Încearcă din nou.', 400);
    if (row.session_id && row.session_id !== sessionId) throw new AuthError('Cerere invalidă.', 400);
    return row.challenge;
  }

  async passkeyRegistrationOptions(session: SessionRow) {
    const admin = this.admin();
    if (!admin) throw new AuthError('Cont inexistent.', 404);
    const existing = this.db.prepare('SELECT id, transports FROM passkeys').all() as Array<{ id: string; transports: string | null }>;
    const options = await generateRegistrationOptions({
      rpName: this.agentName(),
      rpID: this.config.rpId,
      userName: admin.email,
      userDisplayName: admin.display_name,
      userID: this.webauthnUserId() as Uint8Array<ArrayBuffer>,
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: safeJsonParse<string[]>(c.transports, []) })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const challengeId = this.storeChallenge('register', options.challenge, session.id);
    return { challengeId, options };
  }

  async verifyPasskeyRegistration(session: SessionRow, challengeId: string, response: RegistrationResponseJSON, name: string, ip: string | null) {
    const expectedChallenge = this.takeChallenge(challengeId, 'register', session.id);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.config.appOrigin,
        expectedRPID: this.config.rpId,
        requireUserVerification: true,
      });
    } catch (err) {
      this.log.warn({ err }, 'Înregistrare passkey eșuată');
      throw new AuthError('Nu am putut verifica Face ID / passkey-ul. Încearcă din nou.', 400);
    }
    if (!verification.verified) throw new AuthError('Passkey-ul nu a putut fi verificat.', 400);
    const info = verification.registrationInfo;
    this.db
      .prepare(
        'INSERT INTO passkeys (id, public_key, counter, transports, device_type, backed_up, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        info.credential.id,
        Buffer.from(info.credential.publicKey),
        info.credential.counter,
        JSON.stringify(info.credential.transports ?? response.response.transports ?? []),
        info.credentialDeviceType,
        info.credentialBackedUp ? 1 : 0,
        name.trim().slice(0, 60) || 'Passkey',
        Date.now(),
      );
    this.audit.log({ actor: 'owner', action: 'auth.passkey_added', target: name, ip });
    return { id: info.credential.id };
  }

  async passkeyAuthOptions(purpose: 'login' | 'stepup', session: SessionRow | null) {
    const creds = this.db.prepare('SELECT id, transports FROM passkeys').all() as Array<{ id: string; transports: string | null }>;
    if (!creds.length) throw new AuthError('Nu ai niciun passkey (Face ID) înregistrat.', 400);
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpId,
      userVerification: 'required',
      allowCredentials: creds.map((c) => ({ id: c.id, transports: safeJsonParse<string[]>(c.transports, []) })),
    });
    const challengeId = this.storeChallenge(purpose, options.challenge, purpose === 'stepup' ? (session?.id ?? null) : null);
    return { challengeId, options };
  }

  async verifyPasskeyAuth(
    purpose: 'login' | 'stepup',
    challengeId: string,
    response: AuthenticationResponseJSON,
    session: SessionRow | null,
    ip: string | null,
    ua: string | null,
  ): Promise<{ token?: string; stepUpUntil: number }> {
    if (purpose === 'login') this.assertNotLocked(ip);
    const expectedChallenge = this.takeChallenge(challengeId, purpose, purpose === 'stepup' ? (session?.id ?? null) : null);
    const row = this.db.prepare('SELECT * FROM passkeys WHERE id = ?').get(response.id) as PasskeyRow | undefined;
    if (!row) {
      this.recordAttempt(ip, false, 'passkey');
      throw new AuthError('Passkey necunoscut.');
    }
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.config.appOrigin,
        expectedRPID: this.config.rpId,
        credential: {
          id: row.id,
          publicKey: new Uint8Array(row.public_key) as Uint8Array<ArrayBuffer>,
          counter: row.counter,
          transports: safeJsonParse<string[]>(row.transports, []),
        },
        requireUserVerification: true,
      });
    } catch (err) {
      this.log.warn({ err }, 'Autentificare passkey eșuată');
      this.recordAttempt(ip, false, 'passkey');
      throw new AuthError('Verificarea Face ID a eșuat.');
    }
    if (!verification.verified) {
      this.recordAttempt(ip, false, 'passkey');
      throw new AuthError('Verificarea Face ID a eșuat.');
    }
    this.db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(verification.authenticationInfo.newCounter, Date.now(), row.id);
    this.recordAttempt(ip, true, 'passkey');
    if (purpose === 'login') {
      if (this.isSetupRequired()) throw new AuthError('Finalizează mai întâi configurarea inițială.', 409);
      const created = this.createSession('passkey', ip, ua, true);
      this.audit.log({ actor: 'owner', action: 'auth.login', details: `passkey: ${row.name}`, ip });
      return { token: created.token, stepUpUntil: created.session.step_up_until };
    }
    if (!session) throw new AuthError('Sesiune lipsă.');
    return { stepUpUntil: this.markStepUp(session.id) };
  }

  deletePasskey(id: string, ip: string | null): boolean {
    const res = this.db.prepare('DELETE FROM passkeys WHERE id = ?').run(id);
    if (res.changes) this.audit.log({ actor: 'owner', action: 'auth.passkey_removed', target: id.slice(0, 12), ip });
    return res.changes > 0;
  }

  /** Curățenie periodică: sesiuni expirate, provocări vechi, încercări vechi. */
  cleanup(): void {
    const now = Date.now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    this.db.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').run(now);
    this.db.prepare('DELETE FROM login_attempts WHERE at < ?').run(now - 30 * DAY);
  }
}
