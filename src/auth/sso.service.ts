// AGPL-3.0-only
import {
  BadRequestException, Injectable, Logger, NotFoundException, UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  createCipheriv, createDecipheriv, createHash, createPublicKey, createVerify, randomBytes,
} from 'crypto';
import { v4 as uuid } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { RbacService } from '../rbac/rbac.service';
import { SiemEventService } from '../siem/siem-event.service';
import { DragonflyService } from '../storage/dragonfly.service';
import { MemoryStore } from '../storage/memory.store';
import { Role, SsoProvider, SsoProviderType, User } from '../types';

const SSO_STATE_TTL_S     = 600;    // 10 min  — state + PKCE
const SSO_HANDOFF_TTL_S   = 60;     // 60 sec  — SPA handoff bridge
const SSO_DISCOVERY_TTL_S = 3600;   // 1 hour  — OIDC discovery + JWKS cache

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

interface SsoStateData {
  providerId: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
}

interface SsoHandoffData {
  accessToken: string;
  user: object;
  authMethod: string;
}

export interface CreateProviderDto {
  type: SsoProviderType;
  name: string;
  clientId: string;
  clientSecret: string;
  enabled?: boolean;
  tenantId?: string;
  domain?: string;
  discoveryUrl?: string;
  allowedDomains?: string[];
  defaultRole?: string;
  autoProvision?: boolean;
}

@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);
  private readonly jwt: JwtService;

  constructor(
    private readonly store: MemoryStore,
    private readonly dragonfly: DragonflyService,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
    private readonly siem: SiemEventService,
  ) {
    this.jwt = new JwtService({ secret: process.env.JWT_SECRET ?? '' });
  }

  // ── Provider CRUD ──────────────────────────────────────────────────────────

  listProvidersPublic() {
    return this.store.ssoProviders
      .filter((p) => p.enabled)
      .map((p) => ({ id: p.id, type: p.type, name: p.name }));
  }

  listProvidersAdmin() {
    return this.store.ssoProviders.map((p) => this.sanitizeProvider(p));
  }

  async createProvider(dto: CreateProviderDto): Promise<object> {
    const provider: SsoProvider = {
      id: uuid(),
      type: dto.type,
      name: dto.name.trim(),
      clientId: dto.clientId.trim(),
      clientSecretEnc: this.encryptSecret(dto.clientSecret),
      enabled: dto.enabled ?? true,
      tenantId: dto.tenantId?.trim(),
      domain: dto.domain?.trim(),
      discoveryUrl: dto.discoveryUrl?.trim(),
      allowedDomains: (dto.allowedDomains ?? []).map((d) => d.trim().toLowerCase()),
      defaultRole: (dto.defaultRole as Role | undefined) ?? 'viewer',
      autoProvision: dto.autoProvision ?? false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.validateProviderConfig(provider);
    this.store.ssoProviders.push(provider);
    await this.store.persist();
    this.logger.log(`SSO provider created: ${provider.type}/${provider.name} (id=${provider.id})`);
    return this.sanitizeProvider(provider);
  }

  async updateProvider(id: string, dto: Partial<CreateProviderDto>): Promise<object> {
    const provider = this.store.ssoProviders.find((p) => p.id === id);
    if (!provider) throw new NotFoundException('SSO provider not found');

    if (dto.name        !== undefined) provider.name        = dto.name.trim();
    if (dto.clientId    !== undefined) provider.clientId    = dto.clientId.trim();
    if (dto.clientSecret !== undefined) provider.clientSecretEnc = this.encryptSecret(dto.clientSecret);
    if (dto.enabled     !== undefined) provider.enabled     = dto.enabled;
    if (dto.tenantId    !== undefined) provider.tenantId    = dto.tenantId?.trim();
    if (dto.domain      !== undefined) provider.domain      = dto.domain?.trim();
    if (dto.discoveryUrl !== undefined) provider.discoveryUrl = dto.discoveryUrl?.trim();
    if (dto.allowedDomains !== undefined) provider.allowedDomains = dto.allowedDomains.map((d) => d.trim().toLowerCase());
    if (dto.defaultRole !== undefined) provider.defaultRole  = dto.defaultRole as Role;
    if (dto.autoProvision !== undefined) provider.autoProvision = dto.autoProvision;
    provider.updatedAt = new Date().toISOString();

    this.validateProviderConfig(provider);
    await this.store.persist();
    this.logger.log(`SSO provider updated: ${provider.name} (id=${provider.id})`);
    return this.sanitizeProvider(provider);
  }

  async deleteProvider(id: string): Promise<void> {
    const idx = this.store.ssoProviders.findIndex((p) => p.id === id);
    if (idx === -1) throw new NotFoundException('SSO provider not found');
    const [removed] = this.store.ssoProviders.splice(idx, 1);
    await this.store.persist();
    this.logger.log(`SSO provider deleted: ${removed.name} (id=${removed.id})`);
  }

  // ── OAuth2/OIDC Flow ───────────────────────────────────────────────────────

  async initiateFlow(providerId: string, baseUrl: string): Promise<{ authorizationUrl: string }> {
    if (!this.dragonfly.isConfigured()) {
      throw new BadRequestException('SSO requires DRAGONFLY_URL to be configured');
    }

    const provider = this.store.ssoProviders.find((p) => p.id === providerId && p.enabled);
    if (!provider) throw new NotFoundException('SSO provider not found or disabled');

    const redirectUri   = `${baseUrl}/auth/sso/callback`;
    const state         = randomBytes(32).toString('hex');
    const nonce         = randomBytes(16).toString('hex');
    const codeVerifier  = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    const stateData: SsoStateData = { providerId, codeVerifier, nonce, redirectUri };
    await this.dragonfly.setJsonEx(`1patch:sso:state:${state}`, stateData, SSO_STATE_TTL_S);

    const authorizationUrl = await this.buildAuthorizationUrl(
      provider, state, nonce, codeChallenge, redirectUri,
    );

    this.logger.log(`SSO flow initiated: provider=${provider.name} state=${state.slice(0, 8)}…`);
    return { authorizationUrl };
  }

  async handleCallback(code: string, state: string, ip?: string): Promise<string> {
    if (!code || !state) throw new BadRequestException('Missing code or state parameter');

    const stateKey = `1patch:sso:state:${state}`;
    const stateData = await this.dragonfly.getJson<SsoStateData>(stateKey);
    if (!stateData) {
      this.logger.warn(`SSO callback — invalid/expired state from IP ${ip}`);
      throw new UnauthorizedException('Invalid or expired SSO state');
    }
    await this.dragonfly.del(stateKey);   // single-use: consume immediately

    const provider = this.store.ssoProviders.find((p) => p.id === stateData.providerId && p.enabled);
    if (!provider) throw new UnauthorizedException('SSO provider no longer available');

    const { email, sub } = await this.exchangeCodeForIdentity(
      provider, code, stateData.codeVerifier, stateData.nonce, stateData.redirectUri,
    );

    if (!email) throw new UnauthorizedException('SSO provider did not return an email address');

    this.assertDomainAllowed(provider, email, ip);

    const user = await this.resolveUser(provider, email, sub, ip);
    if (!user) throw new UnauthorizedException('No account found. Contact your administrator.');

    if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
      throw new UnauthorizedException('Account is locked');
    }

    const authMethod = `sso:${provider.type}`;
    const token = this.jwt.sign(
      { sub: user.id, roles: user.roles, authMethod },
      { expiresIn: '8h' },
    );

    this.audit.record(user.id, 'auth.sso_login_success', user.id, {
      ip, provider: provider.type, providerId: provider.id,
    });
    this.siem.emit({
      tenantId: 'system', type: 'auth.sso.login.success', severity: 'low',
      actor: { userId: user.id, nodeId: null, ip: ip ?? null },
      metadata: { email: user.email, provider: provider.type, roles: user.roles },
    });
    this.logger.log(`SSO login success: ${user.email} via ${provider.name} from IP ${ip}`);

    const handoffToken = randomBytes(24).toString('hex');
    const handoffData: SsoHandoffData = {
      accessToken: token,
      user: this.publicUser(user),
      authMethod,
    };
    await this.dragonfly.setJsonEx(
      `1patch:sso:handoff:${handoffToken}`, handoffData, SSO_HANDOFF_TTL_S,
    );

    return handoffToken;
  }

  async completeHandoff(handoffToken: string): Promise<object> {
    if (!handoffToken) throw new BadRequestException('Missing handoff token');
    const key = `1patch:sso:handoff:${handoffToken}`;
    const data = await this.dragonfly.getJson<SsoHandoffData>(key);
    if (!data) throw new UnauthorizedException('Invalid or expired SSO handoff token');
    await this.dragonfly.del(key);   // single-use
    return { accessToken: data.accessToken, user: data.user, authMethod: data.authMethod };
  }

  // ── Authorization URL ──────────────────────────────────────────────────────

  private async buildAuthorizationUrl(
    provider: SsoProvider,
    state: string,
    nonce: string,
    codeChallenge: string,
    redirectUri: string,
  ): Promise<string> {
    if (provider.type === 'github') {
      const params = new URLSearchParams({
        client_id: provider.clientId,
        redirect_uri: redirectUri,
        scope: 'read:user user:email',
        state,
      });
      return `https://github.com/login/oauth/authorize?${params}`;
    }

    const discovery = await this.getDiscovery(provider);
    const params = new URLSearchParams({
      client_id: provider.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    if (provider.type === 'microsoft') params.set('prompt', 'select_account');

    return `${discovery.authorization_endpoint}?${params}`;
  }

  // ── Code Exchange ──────────────────────────────────────────────────────────

  private async exchangeCodeForIdentity(
    provider: SsoProvider,
    code: string,
    codeVerifier: string,
    nonce: string,
    redirectUri: string,
  ): Promise<{ email: string; sub: string }> {
    if (provider.type === 'github') {
      return this.exchangeGithub(provider, code, redirectUri);
    }
    return this.exchangeOidc(provider, code, codeVerifier, nonce, redirectUri);
  }

  private async exchangeOidc(
    provider: SsoProvider,
    code: string,
    codeVerifier: string,
    nonce: string,
    redirectUri: string,
  ): Promise<{ email: string; sub: string }> {
    const discovery = await this.getDiscovery(provider);
    const secret = this.decryptSecret(provider.clientSecretEnc);

    const res = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: provider.clientId,
        client_secret: secret,
        code_verifier: codeVerifier,
      }).toString(),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      this.logger.warn(`OIDC token exchange failed for ${provider.name}: ${res.status} ${txt}`);
      throw new UnauthorizedException('SSO token exchange failed');
    }

    const tokens = await res.json() as { id_token?: string; access_token?: string; error?: string };
    if (tokens.error || !tokens.id_token) {
      throw new UnauthorizedException(`SSO provider error: ${tokens.error ?? 'no ID token'}`);
    }

    const claims = await this.validateIdToken(tokens.id_token, provider, nonce, discovery);
    const email = ((claims.email as string | undefined) ?? '').toLowerCase();
    const sub   = String(claims.sub ?? '');
    if (!email || !sub) throw new UnauthorizedException('Missing email or subject in ID token');
    return { email, sub };
  }

  private async exchangeGithub(
    provider: SsoProvider,
    code: string,
    redirectUri: string,
  ): Promise<{ email: string; sub: string }> {
    const secret = this.decryptSecret(provider.clientSecretEnc);

    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: provider.clientId,
        client_secret: secret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) throw new UnauthorizedException('GitHub token exchange failed');
    const tokens = await tokenRes.json() as { access_token?: string; error?: string; error_description?: string };
    if (tokens.error || !tokens.access_token) {
      throw new UnauthorizedException(`GitHub error: ${tokens.error_description ?? tokens.error ?? 'no access token'}`);
    }

    const ghHeaders = {
      authorization: `Bearer ${tokens.access_token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    };

    const [userRes, emailsRes] = await Promise.all([
      fetch('https://api.github.com/user', { headers: ghHeaders }),
      fetch('https://api.github.com/user/emails', { headers: ghHeaders }),
    ]);

    if (!userRes.ok || !emailsRes.ok) throw new UnauthorizedException('GitHub user info fetch failed');

    const userData   = await userRes.json()   as { id?: number };
    const emailsData = await emailsRes.json() as Array<{ email: string; primary: boolean; verified: boolean }>;

    const primary = emailsData.find((e) => e.primary && e.verified);
    if (!primary) throw new UnauthorizedException('No verified primary email on GitHub account');

    return { email: primary.email.toLowerCase(), sub: String(userData.id) };
  }

  // ── OIDC Token Validation ──────────────────────────────────────────────────

  private async validateIdToken(
    idToken: string,
    provider: SsoProvider,
    nonce: string,
    discovery: OidcDiscovery,
  ): Promise<Record<string, unknown>> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new UnauthorizedException('Malformed ID token');

    const [headerB64, payloadB64, sigB64] = parts;

    let header: { kid?: string; alg?: string };
    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    } catch {
      throw new UnauthorizedException('Malformed ID token header');
    }

    const alg = header.alg ?? 'RS256';
    if (!['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'].includes(alg)) {
      throw new UnauthorizedException(`Unsupported ID token algorithm: ${alg}`);
    }

    const jwks = await this.getJwks(discovery.jwks_uri);
    const keys = jwks.keys as Array<{ kid?: string; use?: string; kty?: string }>;
    const jwk  = header.kid
      ? keys.find((k) => k.kid === header.kid)
      : keys.find((k) => k.use === 'sig' || !k.use);

    if (!jwk) throw new UnauthorizedException('No matching JWK found for ID token');

    let publicKeyPem: string;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const keyObj = createPublicKey({ key: jwk as any, format: 'jwk' });
      publicKeyPem = keyObj.export({ type: 'spki', format: 'pem' }) as string;
    } catch (err) {
      this.logger.warn(`JWK import failed: ${(err as Error).message}`);
      throw new UnauthorizedException('Failed to import provider public key');
    }

    // Verify signature
    const nodeAlg = this.algToNodeAlg(alg);
    const verifier = createVerify(nodeAlg);
    verifier.update(`${headerB64}.${payloadB64}`);
    const sig = Buffer.from(sigB64, 'base64url');
    if (!verifier.verify(publicKeyPem, sig)) {
      throw new UnauthorizedException('ID token signature invalid');
    }

    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      throw new UnauthorizedException('Malformed ID token payload');
    }

    // Standard claim validation
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp === 'number' && claims.exp < now) {
      throw new UnauthorizedException('ID token has expired');
    }
    if (typeof claims.nbf === 'number' && claims.nbf > now + 60) {
      throw new UnauthorizedException('ID token not yet valid');
    }
    if (claims.nonce !== nonce) {
      throw new UnauthorizedException('ID token nonce mismatch — possible replay attack');
    }

    const aud = claims.aud;
    const audMatch = aud === provider.clientId
      || (Array.isArray(aud) && aud.includes(provider.clientId));
    if (!audMatch) throw new UnauthorizedException('ID token audience mismatch');

    const expectedIss = this.expectedIssuer(provider);
    if (expectedIss && claims.iss !== expectedIss) {
      this.logger.warn(`ID token issuer mismatch: expected ${expectedIss}, got ${claims.iss}`);
      throw new UnauthorizedException('ID token issuer mismatch');
    }

    return claims;
  }

  private algToNodeAlg(alg: string): string {
    const map: Record<string, string> = {
      RS256: 'RSA-SHA256', RS384: 'RSA-SHA384', RS512: 'RSA-SHA512',
      ES256: 'SHA256',     ES384: 'SHA384',     ES512: 'SHA512',
    };
    return map[alg] ?? 'RSA-SHA256';
  }

  private expectedIssuer(provider: SsoProvider): string | null {
    switch (provider.type) {
      case 'microsoft': return `https://login.microsoftonline.com/${provider.tenantId ?? 'common'}/v2.0`;
      case 'google':    return 'https://accounts.google.com';
      case 'okta':      return `https://${provider.domain}`;
      default:          return null;   // generic OIDC: skip static check, rely on discovery
    }
  }

  // ── OIDC Discovery + JWKS ──────────────────────────────────────────────────

  private async getDiscovery(provider: SsoProvider): Promise<OidcDiscovery> {
    const cacheKey = `1patch:sso:discovery:${provider.id}`;
    const cached = await this.dragonfly.getJson<OidcDiscovery>(cacheKey);
    if (cached) return cached;

    const url = this.discoveryUrl(provider);
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`OIDC discovery failed for ${provider.name}: ${res.status}`);

    const doc = await res.json() as OidcDiscovery;
    await this.dragonfly.setJsonEx(cacheKey, doc, SSO_DISCOVERY_TTL_S);
    return doc;
  }

  private async getJwks(jwksUri: string): Promise<{ keys: unknown[] }> {
    const cacheKey = `1patch:sso:jwks:${createHash('sha256').update(jwksUri).digest('hex').slice(0, 16)}`;
    const cached = await this.dragonfly.getJson<{ keys: unknown[] }>(cacheKey);
    if (cached) return cached;

    const res = await fetch(jwksUri, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);

    const jwks = await res.json() as { keys: unknown[] };
    await this.dragonfly.setJsonEx(cacheKey, jwks, SSO_DISCOVERY_TTL_S);
    return jwks;
  }

  private discoveryUrl(provider: SsoProvider): string {
    switch (provider.type) {
      case 'microsoft':
        return `https://login.microsoftonline.com/${provider.tenantId ?? 'common'}/v2.0/.well-known/openid-configuration`;
      case 'google':
        return 'https://accounts.google.com/.well-known/openid-configuration';
      case 'okta':
        if (!provider.domain) throw new Error('Okta provider requires a domain');
        return `https://${provider.domain}/.well-known/openid-configuration`;
      case 'oidc':
        if (!provider.discoveryUrl) throw new Error('Generic OIDC provider requires discoveryUrl');
        return provider.discoveryUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';
      default:
        throw new Error(`Provider type ${provider.type} does not support OIDC discovery`);
    }
  }

  // ── Domain Enforcement ─────────────────────────────────────────────────────

  private assertDomainAllowed(provider: SsoProvider, email: string, ip?: string): void {
    if (!provider.allowedDomains || provider.allowedDomains.length === 0) return;
    const domain = email.split('@')[1]?.toLowerCase() ?? '';
    if (!provider.allowedDomains.includes(domain)) {
      this.logger.warn(`SSO domain rejected: ${domain} not in allowedDomains (provider=${provider.name}, IP=${ip})`);
      this.siem.emit({
        tenantId: 'system', type: 'auth.sso.login.failed', severity: 'high',
        actor: { userId: null, nodeId: null, ip: ip ?? null },
        metadata: { reason: 'domain_not_allowed', domain, providerId: provider.id },
      });
      throw new UnauthorizedException('Email domain not permitted for this SSO provider');
    }
  }

  // ── User Resolution ────────────────────────────────────────────────────────

  private async resolveUser(
    provider: SsoProvider, email: string, sub: string, ip?: string,
  ): Promise<User | null> {
    let user = this.store.users.find((u) => u.email === email);

    if (!user) {
      if (!provider.autoProvision) {
        this.logger.warn(`SSO: no user for ${email}, autoProvision disabled (provider=${provider.name})`);
        this.siem.emit({
          tenantId: 'system', type: 'auth.sso.login.failed', severity: 'medium',
          actor: { userId: null, nodeId: null, ip: ip ?? null },
          metadata: { reason: 'user_not_found', email, providerId: provider.id },
        });
        return null;
      }
      user = await this.provisionUser(email, provider, ip);
    }

    // Link SSO identity if not already present
    const hasLink = user.oauthLinks.some(
      (l) => l.provider === provider.type && l.subject === sub,
    );
    if (!hasLink) {
      user.oauthLinks.push({ provider: provider.type, subject: sub });
      void this.store.persist();
    }

    return user;
  }

  private async provisionUser(email: string, provider: SsoProvider, ip?: string): Promise<User> {
    const user: User = {
      id: uuid(),
      email,
      passwordHash: randomBytes(32).toString('hex'),   // no-password placeholder
      roles: [provider.defaultRole ?? 'viewer'],
      mfaEnabled: false,
      recoveryCodeHashes: [],
      failedAttempts: 0,
      oauthLinks: [],
    };
    this.store.users.push(user);
    await this.store.persist();
    this.audit.record(user.id, 'auth.sso_user_provisioned', user.id, {
      email, provider: provider.type, providerId: provider.id, ip,
    });
    this.logger.log(`Auto-provisioned SSO user ${email} (id=${user.id}) via ${provider.name}`);
    return user;
  }

  // ── Crypto (AES-256-GCM) ──────────────────────────────────────────────────

  private encryptionKey(): Buffer {
    const secret = process.env.JWT_SECRET ?? '';
    return createHash('sha256').update(`1patch:sso:enc:${secret}`).digest();
  }

  encryptSecret(plaintext: string): string {
    const key = this.encryptionKey();
    const iv  = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
  }

  decryptSecret(enc: string): string {
    const [ivHex, tagHex, ctHex] = enc.split(':');
    if (!ivHex || !tagHex || !ctHex) throw new Error('Malformed encrypted secret');
    const key = this.encryptionKey();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(ctHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private sanitizeProvider(provider: SsoProvider): object {
    const { clientSecretEnc: _, ...rest } = provider;
    return { ...rest, hasSecret: provider.clientSecretEnc?.length > 0 };
  }

  private publicUser(user: User): object {
    return {
      id: user.id,
      email: user.email,
      roles: user.roles,
      permissions: this.rbac.permissionsFor(user.roles),
      mfaEnabled: user.mfaEnabled,
      oauthLinks: user.oauthLinks.map((l) => l.provider),
    };
  }

  private validateProviderConfig(p: SsoProvider): void {
    if (!p.name)     throw new BadRequestException('Provider name is required');
    if (!p.clientId) throw new BadRequestException('Client ID is required');
    if (p.type === 'okta'    && !p.domain)       throw new BadRequestException('Okta provider requires domain');
    if (p.type === 'oidc'    && !p.discoveryUrl) throw new BadRequestException('Generic OIDC requires discoveryUrl');
    if (p.type === 'microsoft' && !p.tenantId)   throw new BadRequestException('Microsoft provider requires tenantId');
  }
}
