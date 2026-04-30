import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { v4 as uuid } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { RbacService } from '../rbac/rbac.service';
import { MemoryStore } from '../storage/memory.store';
import { Role, User } from '../types';

@Injectable()
export class AuthService {
  private readonly jwt = new JwtService({ secret: process.env.JWT_SECRET ?? 'development-jwt-secret' });

  constructor(
    private readonly store: MemoryStore,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
  ) {}

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
    return this.publicUser(user);
  }

  async login(email: string, password: string, ip?: string, country?: string) {
    const user = this.store.users.find((candidate) => candidate.email === email.toLowerCase());
    if (!user) throw new UnauthorizedException('Invalid credentials');
    if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
      throw new UnauthorizedException('Account is locked');
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      user.failedAttempts += 1;
      if (user.failedAttempts >= 5) user.lockedUntil = new Date(Date.now() + 15 * 60_000).toISOString();
      this.audit.record(user.id, 'auth.login_failed', user.id, { ip });
      throw new UnauthorizedException('Invalid credentials');
    }

    user.failedAttempts = 0;
    if (user.lastLoginCountry && country && user.lastLoginCountry !== country) {
      this.audit.record(user.id, 'auth.impossible_travel_review', user.id, {
        previousCountry: user.lastLoginCountry,
        currentCountry: country,
      });
    }
    user.lastLoginCountry = country;
    await this.store.persist();

    if (user.mfaEnabled) {
      this.audit.record(user.id, 'auth.mfa_required', user.id, { ip });
      return { mfaRequired: true, challengeToken: this.jwt.sign({ sub: user.id, purpose: 'mfa' }, { expiresIn: '5m' }) };
    }
    return this.issueSession(user, ip);
  }

  verifyMfa(challengeToken: string, code: string, ip?: string) {
    const decoded = this.jwt.verify(challengeToken) as { sub: string; purpose: string };
    if (decoded.purpose !== 'mfa') throw new UnauthorizedException('Invalid MFA challenge');
    const user = this.store.users.find((candidate) => candidate.id === decoded.sub);
    if (!user?.mfaSecret || !authenticator.check(code, user.mfaSecret)) {
      throw new UnauthorizedException('Invalid MFA code');
    }
    return this.issueSession(user, ip);
  }

  enableMfa(userId: string) {
    const user = this.store.users.find((candidate) => candidate.id === userId);
    if (!user) throw new BadRequestException('Unknown user');
    user.mfaSecret = authenticator.generateSecret();
    user.mfaEnabled = true;
    void this.store.persist();
    this.audit.record(user.id, 'auth.mfa_enabled', user.id);
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
    if (password.length < 12 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      throw new BadRequestException('Password must be at least 12 chars and include upper, lower, and number characters');
    }
  }
}
