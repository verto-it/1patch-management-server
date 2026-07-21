// AGPL-3.0-only
import { BadRequestException, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash } from 'crypto';
import { authenticator } from 'otplib';
import { v4 as uuid } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { SiemEventService } from '../siem/siem-event.service';
import { RbacService } from '../rbac/rbac.service';
import { DragonflyService } from '../storage/dragonfly.service';
import { MemoryStore } from '../storage/memory.store';
import { User } from '../types';

const MFA_FAILURE_TTL_SECONDS = 300;

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private readonly jwt: JwtService;

  /**
   * Creates a AuthService instance with its required collaborators.
   *
   * @param store store supplied to the function.
   * @param audit audit supplied to the function.
   * @param rbac rbac supplied to the function.
   * @param siem siem supplied to the function.
   * @param dragonfly dragonfly supplied to the function.
   */
  constructor(
    private readonly store: MemoryStore,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
    private readonly siem: SiemEventService,
    private readonly dragonfly: DragonflyService,
  ) {
    this.jwt = new JwtService({ secret: process.env.JWT_SECRET ?? '' });
  }

  /**
   * Handles the on module init operation for AuthService.
   */
  onModuleInit() {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) {
      this.logger.error(
        'JWT_SECRET env var is missing or less than 32 characters. ' +
        'Set a strong random secret before starting the management server.',
      );
      process.exit(1);
    }
    this.logger.log('AuthService initialised — JWT_SECRET is configured');
  }

  /**
   * Creates a owner record.
   *
   * @param email email supplied to the function.
   * @param password password supplied to the function.
   * @returns The result produced by the operation.
   */
  async createOwner(email: string, password: string) {
    if (this.store.users.length > 0) throw new BadRequestException('Setup is already complete');
    this.assertPasswordPolicy(password);
    const user: User = {
      id: uuid(),
      email: email.toLowerCase(),
      passwordHash: await bcrypt.hash(password, 12),
      roles: ['owner'],
      mfaEnabled: false,
      recoveryCodeHashes: [],
      failedAttempts: 0,
      oauthLinks: [],
    };
    this.store.users.push(user);
    await this.store.persist();
    this.audit.record(user.id, 'setup.owner_created', user.id);
    this.logger.log(`Owner account created for ${user.email} (id=${user.id})`);
    return this.publicUser(user);
  }

  /**
   * Handles the login operation for AuthService.
   *
   * @param email email supplied to the function.
   * @param password password supplied to the function.
   * @param ip ip supplied to the function.
   * @returns The result produced by the operation.
   */
  async login(email: string, password: string, ip?: string, geoCountry?: string) {
    const user = this.store.users.find((c) => c.email === email.toLowerCase());
    if (!user) {
      this.logger.warn(`Login attempt for unknown email ${email} from IP ${ip}`);
      this.siem.emit({
        tenantId: 'system', type: 'auth.login.failed', severity: 'medium',
        actor: { userId: null, nodeId: null, ip: ip ?? null },
        metadata: { reason: 'unknown_email' },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.disabled) {
      this.logger.warn(`Login blocked — account ${user.id} is disabled`);
      throw new UnauthorizedException('Account is disabled');
    }

    if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
      this.logger.warn(`Login blocked — account ${user.id} is locked until ${user.lockedUntil}`);
      this.siem.emit({
        tenantId: 'system', type: 'auth.login.failed', severity: 'high',
        actor: { userId: user.id, nodeId: null, ip: ip ?? null },
        metadata: { reason: 'account_locked', lockedUntil: user.lockedUntil },
      });
      throw new UnauthorizedException('Account is locked');
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      user.failedAttempts += 1;
      const locked = user.failedAttempts >= 5;
      if (locked) {
        user.lockedUntil = new Date(Date.now() + 15 * 60_000).toISOString();
        this.logger.warn(`Account ${user.id} locked after ${user.failedAttempts} failed attempts`);
      }
      this.audit.record(user.id, 'auth.login_failed', user.id, { ip, failedAttempts: user.failedAttempts, locked });
      this.siem.emit({
        tenantId: 'system', type: 'auth.login.failed', severity: locked ? 'high' : 'medium',
        actor: { userId: user.id, nodeId: null, ip: ip ?? null },
        metadata: { reason: 'bad_password', failedAttempts: user.failedAttempts, locked },
      });
      void this.store.persist();
      throw new UnauthorizedException('Invalid credentials');
    }

    user.failedAttempts = 0;
    user.lockedUntil = undefined;

    const country = normalizeCountry(geoCountry, ip);
    if (user.lastLoginCountry && country && user.lastLoginCountry !== country) {
      this.logger.warn(`Possible impossible travel for user ${user.id}: ${user.lastLoginCountry} -> ${country}`);
      this.audit.record(user.id, 'auth.impossible_travel_review', user.id, {
        previousCountry: user.lastLoginCountry, currentCountry: country,
        note: 'country derived server-side from trusted reverse-proxy geo header', ip,
      });
    }
    if (country) user.lastLoginCountry = country;
    await this.store.persist();

    if (user.mfaEnabled) {
      this.audit.record(user.id, 'auth.mfa_required', user.id, { ip });
      const challengeToken = this.jwt.sign({ sub: user.id, purpose: 'mfa' }, { expiresIn: '5m' });
      this.logger.log(`Login for ${user.email} — MFA challenge issued`);
      return { mfaRequired: true, challengeToken };
    }

    this.logger.log(`Login successful for ${user.email} (id=${user.id}) from IP ${ip}`);
    return this.issueSession(user, ip, 'password');
  }

  /**
   * Validates mfa rules.
   *
   * @param challengeToken Token used to authenticate or authorize the operation.
   * @param code code supplied to the function.
   * @param ip ip supplied to the function.
   * @returns The result produced by the operation.
   */
  async verifyMfa(challengeToken: string, code: string, ip?: string) {
    let decoded: { sub: string; purpose: string };
    try {
      decoded = this.jwt.verify(challengeToken) as { sub: string; purpose: string };
    } catch (err) {
      this.logger.warn(`MFA verify failed — invalid or expired challenge token from IP ${ip}`);
      throw new UnauthorizedException('Invalid or expired MFA challenge');
    }

    if (decoded.purpose !== 'mfa') {
      this.logger.warn(`MFA verify failed — token purpose is '${decoded.purpose}', expected 'mfa'`);
      throw new UnauthorizedException('Invalid MFA challenge');
    }

    const failureKey = this.mfaFailureKey(challengeToken);
    // Atomic increment + first-write TTL so concurrent attempts can't race past the limit.
    const attempts = (await this.dragonfly.increment(failureKey, MFA_FAILURE_TTL_SECONDS)) ?? 1;
    if (attempts > 5) {
      this.logger.warn(`MFA brute-force detected for user ${decoded.sub} — challenge invalidated after ${attempts} attempts`);
      throw new UnauthorizedException('Too many MFA attempts — please log in again');
    }

    const user = this.store.users.find((c) => c.id === decoded.sub);
    if (!user?.mfaSecret || !authenticator.check(code, user.mfaSecret)) {
      this.audit.record(decoded.sub, 'auth.mfa_failed', decoded.sub, { ip, attempts });
      this.siem.emit({
        tenantId: 'system', type: 'auth.mfa.failed', severity: attempts >= 3 ? 'high' : 'medium',
        actor: { userId: decoded.sub, nodeId: null, ip: ip ?? null },
        metadata: { attempts },
      });
      this.logger.warn(`MFA code rejected for user ${decoded.sub} (attempt ${attempts}/5)`);
      throw new UnauthorizedException('Invalid MFA code');
    }

    // Single-use challenge: the first successful verification consumes the token so
    // a captured (code, challengeToken) pair cannot be replayed within its 5m window.
    const consumeKey = this.mfaConsumeKey(challengeToken);
    const firstUse = await this.dragonfly.setIfAbsent(consumeKey, 1, MFA_FAILURE_TTL_SECONDS);
    if (!firstUse) {
      this.logger.warn(`MFA challenge replay blocked for user ${user.id} from IP ${ip}`);
      throw new UnauthorizedException('MFA challenge has already been used — please log in again');
    }

    await this.dragonfly.del(failureKey);
    this.siem.emit({
      tenantId: 'system', type: 'auth.mfa.success', severity: 'low',
      actor: { userId: user.id, nodeId: null, ip: ip ?? null },
      metadata: { email: user.email },
    });
    this.logger.log(`MFA verified for user ${user.email} (id=${user.id}) from IP ${ip}`);
    return this.issueSession(user, ip, 'password+totp');
  }

  /**
   * Handles the enable mfa operation for AuthService.
   *
   * @param userId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  enableMfa(userId: string) {
    const user = this.store.users.find((c) => c.id === userId);
    if (!user) throw new BadRequestException('Unknown user');
    // Defense in depth: never silently rotate an existing secret. Re-enrolling MFA
    // must go through an explicit disable so a stolen session can't reset the factor.
    if (user.mfaEnabled) {
      throw new BadRequestException('MFA is already enabled — disable it before re-enrolling');
    }
    user.mfaSecret = authenticator.generateSecret();
    user.mfaEnabled = true;
    void this.store.persist();
    this.audit.record(user.id, 'auth.mfa_enabled', user.id);
    this.logger.log(`MFA enabled for user ${user.email} (id=${user.id})`);
    return { secret: user.mfaSecret, otpauth: authenticator.keyuri(user.email, '1Patch', user.mfaSecret) };
  }

  /**
   * Stores a JWT token hash in the revocation denylist until the token expires.
   *
   * @param userId Identifier of the user ending the session.
   * @param rawToken Bearer token to revoke.
   * @param ip Optional request IP address for audit and SIEM events.
   */
  async logout(userId: string, rawToken: string, ip?: string) {
    let ttlSeconds = 8 * 3600;
    try {
      const decoded = this.jwt.decode(rawToken) as { exp?: number } | null;
      if (decoded?.exp) {
        ttlSeconds = Math.max(1, decoded.exp - Math.floor(Date.now() / 1000));
      }
    } catch { /* ignore */ }
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await this.dragonfly.setJsonEx(`1patch:revoked-token:${tokenHash}`, 1, ttlSeconds);
    this.audit.record(userId, 'auth.logout', userId, { ip });
    this.siem.emit({
      tenantId: 'system', type: 'auth.logout', severity: 'low',
      actor: { userId, nodeId: null, ip: ip ?? null },
      metadata: {},
    });
    this.logger.log(`Logout for user ${userId} — token revoked for ${ttlSeconds}s`);
  }

  /**
   * Handles the public user operation for AuthService.
   *
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  publicUser(user: User) {
    return {
      id: user.id, email: user.email, roles: user.roles,
      permissions: this.rbac.permissionsFor(user.roles),
      mfaEnabled: user.mfaEnabled,
      disabled: user.disabled === true,
      oauthLinks: user.oauthLinks.map((link) => link.provider),
    };
  }

  /**
   * Handles the issue session operation for AuthService.
   *
   * @param user user supplied to the function.
   * @param ip ip supplied to the function.
   * @returns The result produced by the operation.
   */
  private issueSession(user: User, ip?: string, authMethod = 'password') {
    user.lastLoginAt = new Date().toISOString();
    const token = this.jwt.sign({ sub: user.id, roles: user.roles, authMethod }, { expiresIn: '8h' });
    this.audit.record(user.id, 'auth.login_success', user.id, { ip, authMethod });
    this.siem.emit({
      tenantId: 'system', type: 'auth.login.success', severity: 'low',
      actor: { userId: user.id, nodeId: null, ip: ip ?? null },
      metadata: { email: user.email, roles: user.roles, authMethod },
    });
    return { accessToken: token, user: this.publicUser(user), authMethod };
  }

  /**
   * Validates password policy rules.
   *
   * @param password password supplied to the function.
   */
  private assertPasswordPolicy(password: string) {
    if (
      password.length < 16 ||
      !/[A-Z]/.test(password) ||
      !/[a-z]/.test(password) ||
      !/[0-9]/.test(password) ||
      !/[^A-Za-z0-9]/.test(password)
    ) {
      throw new BadRequestException(
        'Password must be at least 16 characters and include uppercase, lowercase, a number, and a special character',
      );
    }
  }

  /**
   * Handles the mfa failure key operation for AuthService.
   *
   * @param challengeToken Token used to authenticate or authorize the operation.
   * @returns The result produced by the operation.
   */
  private mfaFailureKey(challengeToken: string): string {
    return `1patch:mfa-login-failures:${createHash('sha256').update(challengeToken).digest('hex')}`;
  }

  /**
   * Derives the single-use marker key for an MFA challenge token.
   *
   * @param challengeToken Token used to authenticate or authorize the operation.
   * @returns The result produced by the operation.
   */
  private mfaConsumeKey(challengeToken: string): string {
    return `1patch:mfa-challenge-consumed:${createHash('sha256').update(challengeToken).digest('hex')}`;
  }
}

/**
 * Normalizes the login country used for impossible-travel detection.
 *
 * The country is sourced from a trusted reverse-proxy geo header (see
 * resolveGeoCountry in the controller) — never from client-supplied input.
 * Private/local source IPs return undefined to avoid false travel signals when
 * a request did not traverse the geo-aware proxy.
 *
 * @param geoCountry ISO 3166-1 alpha-2 code from the trusted proxy header, if any.
 * @param ip ip supplied to the function.
 * @returns A normalized two-letter country code, or undefined.
 */
function normalizeCountry(geoCountry?: string, ip?: string): string | undefined {
  if (!geoCountry) return undefined;
  if (ip && /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|::1$|fc|fd)/i.test(ip)) return undefined;
  const code = geoCountry.trim().toUpperCase();
  // Reject proxy placeholders such as Cloudflare's "XX" (unknown) / "T1" (Tor).
  if (!/^[A-Z]{2}$/.test(code) || code === 'XX' || code === 'T1') return undefined;
  return code;
}
