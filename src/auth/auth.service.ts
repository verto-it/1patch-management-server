import { BadRequestException, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { v4 as uuid } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { RbacService } from '../rbac/rbac.service';
import { MemoryStore } from '../storage/memory.store';
import { User } from '../types';

// Per-challenge MFA failure tracking (in-memory, cleared on success or expiry)
const mfaFailures = new Map<string, number>();

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private readonly jwt: JwtService;

  constructor(
    private readonly store: MemoryStore,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
  ) {
    // FIX #3: JWT secret initialised here but validated in onModuleInit
    this.jwt = new JwtService({ secret: process.env.JWT_SECRET ?? '' });
  }

  onModuleInit() {
    const secret = process.env.JWT_SECRET;
    // FIX #3: refuse to start with a missing or weak JWT secret
    if (!secret || secret.length < 32) {
      this.logger.error(
        'JWT_SECRET env var is missing or less than 32 characters. ' +
        'Set a strong random secret before starting the management server.',
      );
      process.exit(1);
    }
    this.logger.log('AuthService initialised — JWT_SECRET is configured');
  }

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

  async login(email: string, password: string, ip?: string, country?: string) {
    const user = this.store.users.find((c) => c.email === email.toLowerCase());
    if (!user) {
      this.logger.warn(`Login attempt for unknown email ${email} from IP ${ip}`);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
      this.logger.warn(`Login blocked — account ${user.id} is locked until ${user.lockedUntil}`);
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
      void this.store.persist();
      throw new UnauthorizedException('Invalid credentials');
    }

    user.failedAttempts = 0;

    // FIX #22: use server-side IP geolocation note — country comes from client but flag it clearly in audit
    if (user.lastLoginCountry && country && user.lastLoginCountry !== country) {
      this.logger.warn(`Possible impossible travel for user ${user.id}: ${user.lastLoginCountry} -> ${country} (client-reported)`);
      this.audit.record(user.id, 'auth.impossible_travel_review', user.id, {
        previousCountry: user.lastLoginCountry,
        currentCountry: country,
        note: 'country is client-reported — verify with server-side IP geolocation',
        ip,
      });
    }
    user.lastLoginCountry = country;
    await this.store.persist();

    if (user.mfaEnabled) {
      this.audit.record(user.id, 'auth.mfa_required', user.id, { ip });
      const challengeToken = this.jwt.sign({ sub: user.id, purpose: 'mfa' }, { expiresIn: '5m' });
      this.logger.log(`Login for ${user.email} — MFA challenge issued`);
      return { mfaRequired: true, challengeToken };
    }

    this.logger.log(`Login successful for ${user.email} (id=${user.id}) from IP ${ip}`);
    return this.issueSession(user, ip);
  }

  verifyMfa(challengeToken: string, code: string, ip?: string) {
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

    // FIX #14: rate-limit TOTP attempts per challenge token
    const attempts = (mfaFailures.get(challengeToken) ?? 0) + 1;
    if (attempts > 5) {
      this.logger.warn(`MFA brute-force detected for user ${decoded.sub} — challenge invalidated after ${attempts} attempts`);
      throw new UnauthorizedException('Too many MFA attempts — please log in again');
    }

    const user = this.store.users.find((c) => c.id === decoded.sub);
    if (!user?.mfaSecret || !authenticator.check(code, user.mfaSecret)) {
      mfaFailures.set(challengeToken, attempts);
      this.audit.record(decoded.sub, 'auth.mfa_failed', decoded.sub, { ip, attempts });
      this.logger.warn(`MFA code rejected for user ${decoded.sub} (attempt ${attempts}/5)`);
      throw new UnauthorizedException('Invalid MFA code');
    }

    mfaFailures.delete(challengeToken);
    this.logger.log(`MFA verified for user ${user.email} (id=${user.id}) from IP ${ip}`);
    return this.issueSession(user, ip);
  }

  // FIX #9: userId is now derived from a verified JWT, not from the request body
  enableMfa(userId: string) {
    const user = this.store.users.find((c) => c.id === userId);
    if (!user) throw new BadRequestException('Unknown user');
    user.mfaSecret = authenticator.generateSecret();
    user.mfaEnabled = true;
    void this.store.persist();
    this.audit.record(user.id, 'auth.mfa_enabled', user.id);
    this.logger.log(`MFA enabled for user ${user.email} (id=${user.id})`);
    return { secret: user.mfaSecret, otpauth: authenticator.keyuri(user.email, '1Patch', user.mfaSecret) };
  }

  publicUser(user: User) {
    return {
      id: user.id,
      email: user.email,
      roles: user.roles,
      permissions: this.rbac.permissionsFor(user.roles),
      mfaEnabled: user.mfaEnabled,
      oauthLinks: user.oauthLinks.map((link) => link.provider),
    };
  }

  private issueSession(user: User, ip?: string) {
    user.lastLoginAt = new Date().toISOString();
    const token = this.jwt.sign({ sub: user.id, roles: user.roles }, { expiresIn: '8h' });
    this.audit.record(user.id, 'auth.login_success', user.id, { ip });
    return { accessToken: token, user: this.publicUser(user) };
  }

  private assertPasswordPolicy(password: string) {
    if (
      password.length < 12 ||
      !/[A-Z]/.test(password) ||
      !/[a-z]/.test(password) ||
      !/[0-9]/.test(password)
    ) {
      throw new BadRequestException(
        'Password must be at least 12 characters and include uppercase, lowercase, and a number',
      );
    }
  }
}
