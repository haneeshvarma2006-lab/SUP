import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { ID_PREFIXES, avatarColorFor, newId, type User, type WorkspaceRole } from '@sup/shared';
import { badRequest, conflict, unauthorized } from '../util/errors.js';
import { publicUser, type Repositories, type StoredUser } from '../db/repos/index.js';
import type { AppConfig } from '../config/index.js';

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;

export interface AuthedSession {
  user: User;
  sessionId: string;
}

export class AuthService {
  constructor(
    private readonly repos: Repositories,
    private readonly config: AppConfig,
  ) {}

  // -- password handling ----------------------------------------------------

  private hashPassword(password: string, salt: string): string {
    return scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS).toString('hex');
  }

  private verifyPassword(password: string, user: StoredUser): boolean {
    const candidate = Buffer.from(this.hashPassword(password, user.passwordSalt), 'hex');
    const expected = Buffer.from(user.passwordHash, 'hex');
    // Length check first: timingSafeEqual throws on mismatched lengths.
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(candidate, expected);
  }

  // -- token handling -------------------------------------------------------

  /**
   * Session tokens are opaque random strings. Only their SHA-256 hash is
   * stored, so a database leak does not hand out live sessions.
   */
  private static newToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: AuthService.hashToken(token) };
  }

  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  // -- public API -----------------------------------------------------------

  register(input: {
    email: string;
    password: string;
    displayName: string;
    userAgent?: string;
  }): { user: User; token: string; expiresAt: number } {
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw badRequest('Enter a valid email address');
    }
    if (input.password.length < 8) {
      throw badRequest('Password must be at least 8 characters');
    }
    const displayName = input.displayName.trim();
    if (displayName.length < 1 || displayName.length > 60) {
      throw badRequest('Display name must be between 1 and 60 characters');
    }
    if (this.repos.users.byEmail(email)) {
      throw conflict('An account with that email already exists');
    }

    const salt = randomBytes(16).toString('hex');
    const user: StoredUser = {
      id: newId(ID_PREFIXES.user),
      email,
      displayName,
      avatarColor: avatarColorFor(email),
      createdAt: Date.now(),
      passwordSalt: salt,
      passwordHash: this.hashPassword(input.password, salt),
    };
    this.repos.users.insert(user);
    const session = this.createSession(user.id, input.userAgent);
    return { user: publicUser(user), ...session };
  }

  login(input: {
    email: string;
    password: string;
    userAgent?: string;
  }): { user: User; token: string; expiresAt: number } {
    const user = this.repos.users.byEmail(input.email.trim().toLowerCase());
    // Same error for unknown email and wrong password — no account enumeration.
    if (!user || !this.verifyPassword(input.password, user)) {
      throw unauthorized('Incorrect email or password');
    }
    const session = this.createSession(user.id, input.userAgent);
    return { user: publicUser(user), ...session };
  }

  createSession(userId: string, userAgent?: string): { token: string; expiresAt: number } {
    const { token, hash } = AuthService.newToken();
    const now = Date.now();
    const expiresAt = now + this.config.sessionTtlMs;
    this.repos.sessions.insert({
      id: newId(ID_PREFIXES.session),
      userId,
      tokenHash: hash,
      createdAt: now,
      expiresAt,
      lastSeenAt: now,
      userAgent: userAgent ?? null,
    });
    return { token, expiresAt };
  }

  /** Resolves a bearer token to a live session, or null. */
  authenticate(token: string | null | undefined): AuthedSession | null {
    if (!token) return null;
    const session = this.repos.sessions.byTokenHash(AuthService.hashToken(token));
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      this.repos.sessions.revoke(session.id);
      return null;
    }
    const user = this.repos.users.byId(session.userId);
    if (!user) return null;
    // Throttle the write: one per minute per session is enough for "last seen".
    if (Date.now() - session.lastSeenAt > 60_000) {
      this.repos.sessions.touch(session.id, Date.now());
    }
    return { user: publicUser(user), sessionId: session.id };
  }

  requireAuth(token: string | null | undefined): AuthedSession {
    const session = this.authenticate(token);
    if (!session) throw unauthorized();
    return session;
  }

  logout(sessionId: string): void {
    this.repos.sessions.revoke(sessionId);
  }

  membershipRole(workspaceId: string, userId: string): WorkspaceRole | null {
    return this.repos.memberships.find(workspaceId, userId)?.role ?? null;
  }

  purgeExpiredSessions(): number {
    return this.repos.sessions.purgeExpired(Date.now());
  }
}
