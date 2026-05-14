import { BadRequestException, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'crypto';
import { SignedEnvelope, SigningKeyMetadata, SigningScope } from './types';

type SignableEnvelope<T> = Omit<SignedEnvelope<T>, 'signature'>;

export const SIGNING_SCOPES: readonly SigningScope[] = [
  'bootstrap_manifest',
  'rule_bundle',
  'task_bundle',
  'task_ledger',
  'kill_switch',
  'recovery_task',
  'node_update',
];

const SIGNING_SCOPE_SET = new Set<string>(SIGNING_SCOPES);

export type DetachedSignatureInput<T = unknown> = {
  expectedScope: SigningScope;
  tenantId: string;
  keyId: string;
  payload: T;
  signature: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  payloadHash: string;
  algorithm?: 'ES256';
};

@Injectable()
export class SigningService implements OnModuleInit {
  private readonly logger = new Logger(SigningService.name);
  private activeKeyIdsByScope = new Map<SigningScope, string>();
  private privateKeysByKeyId = new Map<string, ReturnType<typeof createPrivateKey>>();
  private keyMetadata = new Map<string, SigningKeyMetadata | (Omit<SigningKeyMetadata, 'scope'> & { scope: SigningScope | '*' })>();
  private trustedPublicKeys = new Map<string, ReturnType<typeof createPublicKey>>();
  private developmentCompatibilityMode = false;

  /**
   * Handles the on module init operation for SigningService.
   */
  onModuleInit() {
    const isProduction = process.env.NODE_ENV === 'production';
    const hasScopedConfig = Boolean(
      process.env.MANAGEMENT_SIGNING_ACTIVE_KEYS_JSON?.trim() &&
      process.env.MANAGEMENT_SIGNING_PRIVATE_KEYS_JSON?.trim() &&
      process.env.MANAGEMENT_SIGNING_KEY_METADATA_JSON?.trim(),
    );

    if (hasScopedConfig) {
      this.initialiseScopedSigner(isProduction);
      return;
    }

    const hasLegacyConfig = Boolean(
      process.env.MANAGEMENT_SIGNING_ACTIVE_KEY_ID?.trim() &&
      process.env.MANAGEMENT_SIGNING_PRIVATE_KEY?.trim() &&
      process.env.MANAGEMENT_SIGNING_PUBLIC_KEYS_JSON?.trim(),
    );

    if (isProduction) {
      if (hasLegacyConfig) {
        throw new Error(
          'Legacy MANAGEMENT_SIGNING_ACTIVE_KEY_ID/MANAGEMENT_SIGNING_PRIVATE_KEY configuration is forbidden in production. ' +
          'Configure MANAGEMENT_SIGNING_ACTIVE_KEYS_JSON, MANAGEMENT_SIGNING_PRIVATE_KEYS_JSON, and MANAGEMENT_SIGNING_KEY_METADATA_JSON.',
        );
      }
      required('MANAGEMENT_SIGNING_ACTIVE_KEYS_JSON');
      required('MANAGEMENT_SIGNING_PRIVATE_KEYS_JSON');
      required('MANAGEMENT_SIGNING_KEY_METADATA_JSON');
    }

    if (hasLegacyConfig) {
      this.initialiseLegacyDevelopmentSigner();
      return;
    }

    this.initialiseEphemeralDevSigner();
  }

  /**
   * Produces the payload security value.
   *
   * @param scope scope supplied to the function.
   * @param tenantId Identifier used to locate the target record.
   * @param payload Request payload or data transfer object.
   * @param ttlSeconds ttl seconds supplied to the function.
   * @returns The result produced by the operation.
   */
  signPayload<T>(
    scope: SigningScope,
    tenantId: string,
    payload: T,
    ttlSeconds = 10 * 60,
  ): SignedEnvelope<T> {
    assertKnownScope(scope);
    const keyId = this.activeKeyIdsByScope.get(scope);
    if (!keyId) throw new Error(`No active signing key configured for scope '${scope}'`);
    const privateKey = this.privateKeysByKeyId.get(keyId);
    if (!privateKey) throw new Error(`No private key configured for active signing key '${keyId}'`);
    const meta = this.keyMetadata.get(keyId);
    if (!meta) throw new Error(`No metadata configured for active signing key '${keyId}'`);
    if (meta.scope !== scope && !(this.developmentCompatibilityMode && meta.scope === '*')) {
      throw new Error(`Active signing key '${keyId}' scope '${meta.scope}' cannot sign '${scope}' payloads`);
    }

    const issuedAt = new Date();
    const payloadHash = computePayloadHash(payload);
    const envelope: SignableEnvelope<T> = {
      algorithm: 'ES256',
      keyId,
      scope,
      payloadType: scope,
      tenantId,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + ttlSeconds * 1000).toISOString(),
      nonce: randomUUID(),
      payloadHash,
      payload,
    };
    const signature = sign('sha256', Buffer.from(canonicalJson(envelope)), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    return { ...envelope, signature };
  }

  /**
   * Validates envelope rules.
   *
   * @param envelope envelope supplied to the function.
   * @param expectedScope expected scope supplied to the function.
   * @param expectedTenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  verifyEnvelope<T>(envelope: SignedEnvelope<T>, expectedScope?: SigningScope, expectedTenantId?: string): T {
    const scope = this.verifyEnvelopeMetadata(envelope, expectedScope, expectedTenantId);
    const publicKey = this.resolvePublicKey(envelope.keyId, scope, envelope.tenantId);
    const { signature, ...unsigned } = envelope;
    const ok = verify('sha256', Buffer.from(canonicalJson(unsigned)), {
      key: publicKey,
      dsaEncoding: 'ieee-p1363',
    }, Buffer.from(signature, 'base64url'));
    if (!ok) throw new UnauthorizedException('Invalid signed payload signature');
    return envelope.payload;
  }

  /**
   * Validates detached signature rules.
   *
   * @param input input supplied to the function.
   */
  verifyDetachedSignature<T>(input: DetachedSignatureInput<T>): void {
    assertKnownScope(input.expectedScope);
    this.verifySignedTimestamps(input.issuedAt, input.expiresAt);
    const computedHash = computePayloadHash(input.payload);
    if (!input.payloadHash || computedHash !== input.payloadHash) {
      throw new UnauthorizedException('Payload hash mismatch');
    }
    const publicKey = this.resolvePublicKey(input.keyId, input.expectedScope, input.tenantId);
    const unsigned: SignableEnvelope<T> = {
      algorithm: input.algorithm ?? 'ES256',
      keyId: input.keyId,
      scope: input.expectedScope,
      payloadType: input.expectedScope,
      tenantId: input.tenantId,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      nonce: input.nonce,
      payloadHash: input.payloadHash,
      payload: input.payload,
    };
    const ok = verify('sha256', Buffer.from(canonicalJson(unsigned)), {
      key: publicKey,
      dsaEncoding: 'ieee-p1363',
    }, Buffer.from(input.signature, 'base64url'));
    if (!ok) throw new UnauthorizedException(`Invalid detached signature for scope=${input.expectedScope} keyId=${input.keyId}`);
  }

  /** Returns legacy keyId-to-PEM public keys for older development clients. */
  publicKeysForConfig(): Record<string, string> {
    return Object.fromEntries(
      [...this.trustedPublicKeys.entries()].map(([keyId, key]) => [
        keyId,
        key.export({ type: 'spki', format: 'pem' }).toString(),
      ]),
    );
  }

  /**
   * Handles the public signing keys for config operation for SigningService.
   * @returns The result produced by the operation.
   */
  publicSigningKeysForConfig(): Record<string, SigningKeyMetadata> {
    const entries = [...this.keyMetadata.entries()]
      .filter(([, meta]) => meta.scope !== '*')
      .map(([keyId, meta]) => [keyId, meta as SigningKeyMetadata]);
    return Object.fromEntries(entries);
  }

  /**
   * Gets the key metadata value.
   *
   * @param keyId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  getKeyMetadata(keyId: string): SigningKeyMetadata | undefined {
    const meta = this.keyMetadata.get(keyId);
    return meta?.scope === '*' ? undefined : meta as SigningKeyMetadata | undefined;
  }

  /**
   * Gets the all key metadata value.
   * @returns The result produced by the operation.
   */
  getAllKeyMetadata(): Array<SigningKeyMetadata | (Omit<SigningKeyMetadata, 'scope'> & { scope: SigningScope | '*' })> {
    return [...this.keyMetadata.values()];
  }

  /**
   * Gets the active key id value.
   *
   * @param scope scope supplied to the function.
   * @returns The result produced by the operation.
   */
  getActiveKeyId(scope?: SigningScope): string {
    if (scope) return this.activeKeyIdsByScope.get(scope) ?? '';
    return this.activeKeyIdsByScope.values().next().value ?? '';
  }

  /**
   * Gets the active key ids by scope value.
   * @returns The result produced by the operation.
   */
  getActiveKeyIdsByScope(): Record<SigningScope, string> {
    return Object.fromEntries(SIGNING_SCOPES.map((scope) => [scope, this.activeKeyIdsByScope.get(scope) ?? ''])) as Record<SigningScope, string>;
  }

  /**
   * Handles the is dev key operation for SigningService.
   *
   * @param keyId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  isDevKey(keyId: string): boolean {
    return this.keyMetadata.get(keyId)?.isDev === true;
  }

  /**
   * Handles the initialise scoped signer operation for SigningService.
   *
   * @param isProduction is production supplied to the function.
   */
  private initialiseScopedSigner(isProduction: boolean): void {
    const activeKeys = parseJsonObject(required('MANAGEMENT_SIGNING_ACTIVE_KEYS_JSON'), 'MANAGEMENT_SIGNING_ACTIVE_KEYS_JSON');
    const privateKeys = parseJsonObject(required('MANAGEMENT_SIGNING_PRIVATE_KEYS_JSON'), 'MANAGEMENT_SIGNING_PRIVATE_KEYS_JSON');
    const metadata = parseJsonObject(required('MANAGEMENT_SIGNING_KEY_METADATA_JSON'), 'MANAGEMENT_SIGNING_KEY_METADATA_JSON');

    this.activeKeyIdsByScope = new Map();
    this.privateKeysByKeyId = new Map();
    this.keyMetadata = new Map();
    this.trustedPublicKeys = new Map();

    for (const [keyId, rawPrivateKey] of Object.entries(privateKeys)) {
      if (typeof rawPrivateKey !== 'string') throw new Error(`Private key for '${keyId}' must be a PEM or base64 PEM string`);
      this.privateKeysByKeyId.set(keyId, createPrivateKey(decodePem(rawPrivateKey)));
    }

    for (const [keyId, rawMeta] of Object.entries(metadata)) {
      const meta = normalizeMetadata(keyId, rawMeta);
      this.keyMetadata.set(keyId, meta);
      this.trustedPublicKeys.set(keyId, createPublicKey(decodePem(meta.publicKeyPem)));
    }

    for (const [scope, keyId] of Object.entries(activeKeys)) {
      if (!SIGNING_SCOPE_SET.has(scope)) throw new Error(`Unknown signing scope '${scope}' in MANAGEMENT_SIGNING_ACTIVE_KEYS_JSON`);
      if (typeof keyId !== 'string' || !keyId.trim()) throw new Error(`Active signing key for scope '${scope}' must be a non-empty key ID`);
      this.activeKeyIdsByScope.set(scope as SigningScope, keyId);
    }

    this.validateScopedConfiguration(isProduction);
    this.logger.log(`SigningService initialised with scoped keys for ${this.activeKeyIdsByScope.size} scope(s); trustedKeys=${this.trustedPublicKeys.size}`);
  }

  /**
   * Handles the initialise legacy development signer operation for SigningService.
   */
  private initialiseLegacyDevelopmentSigner(): void {
    this.developmentCompatibilityMode = true;
    const activeKeyId = required('MANAGEMENT_SIGNING_ACTIVE_KEY_ID');
    const privateKey = createPrivateKey(decodePem(required('MANAGEMENT_SIGNING_PRIVATE_KEY')));
    const publicKeys = parseLegacyPublicKeys(required('MANAGEMENT_SIGNING_PUBLIC_KEYS_JSON'));
    const publicKey = publicKeys.get(activeKeyId) ?? createPublicKey(privateKey);
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const isDev = process.env.MANAGEMENT_SIGNING_IS_DEV !== 'false';

    this.activeKeyIdsByScope = new Map(SIGNING_SCOPES.map((scope) => [scope, activeKeyId]));
    this.privateKeysByKeyId = new Map([[activeKeyId, privateKey]]);
    this.trustedPublicKeys = new Map([[activeKeyId, publicKey]]);
    this.keyMetadata = new Map([[activeKeyId, {
      keyId: activeKeyId,
      scope: '*',
      status: 'active',
      publicKeyPem,
      issuedAt: new Date().toISOString(),
      isDev,
      algorithm: 'ES256',
    }]]);

    this.logger.warn(
      'Legacy wildcard management signing configuration is active in development compatibility mode. ' +
      'Production will refuse this configuration. Configure MANAGEMENT_SIGNING_ACTIVE_KEYS_JSON, ' +
      'MANAGEMENT_SIGNING_PRIVATE_KEYS_JSON, and MANAGEMENT_SIGNING_KEY_METADATA_JSON with one key per scope.',
    );
  }

  /**
   * Handles the initialise ephemeral dev signer operation for SigningService.
   */
  private initialiseEphemeralDevSigner(): void {
    this.developmentCompatibilityMode = true;
    this.activeKeyIdsByScope = new Map();
    this.privateKeysByKeyId = new Map();
    this.trustedPublicKeys = new Map();
    this.keyMetadata = new Map();

    for (const scope of SIGNING_SCOPES) {
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const keyId = `dev-${scope}`;
      const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
      this.activeKeyIdsByScope.set(scope, keyId);
      this.privateKeysByKeyId.set(keyId, privateKey);
      this.trustedPublicKeys.set(keyId, publicKey);
      this.keyMetadata.set(keyId, {
        keyId,
        scope,
        status: 'active',
        publicKeyPem,
        issuedAt: new Date().toISOString(),
        isDev: true,
        algorithm: 'ES256',
      });
    }

    this.logger.warn(
      'MANAGEMENT_SIGNING_* scoped env vars are not fully configured. Using ephemeral in-memory scoped dev signers. ' +
      'Signed payloads from this process will stop verifying after restart; configure real scoped signing keys for persistent environments.',
    );
  }

  /**
   * Validates scoped configuration rules.
   *
   * @param isProduction is production supplied to the function.
   */
  private validateScopedConfiguration(isProduction: boolean): void {
    const activeKeyIds = [...this.activeKeyIdsByScope.values()];
    const activeKeyIdSet = new Set(activeKeyIds);
    if (isProduction && activeKeyIdSet.size !== activeKeyIds.length) {
      throw new Error('Duplicate active signing keys across scopes are forbidden in production');
    }

    for (const scope of SIGNING_SCOPES) {
      const keyId = this.activeKeyIdsByScope.get(scope);
      if (!keyId) throw new Error(`Required signing scope '${scope}' has no active key`);
      const meta = this.keyMetadata.get(keyId);
      if (!meta) throw new Error(`Active signing key '${keyId}' for scope '${scope}' has no metadata`);
      if (meta.scope === '*') throw new Error(`Wildcard signing key '${keyId}' is forbidden`);
      if (meta.scope !== scope) throw new Error(`Active signing key '${keyId}' scope '${meta.scope}' does not match active scope '${scope}'`);
      if (meta.status !== 'active') throw new Error(`Active signing key '${keyId}' for scope '${scope}' has status '${meta.status}'`);
      if (!this.privateKeysByKeyId.has(keyId)) throw new Error(`Active signing key '${keyId}' has no configured private key`);
      if (isProduction && meta.isDev) throw new Error(`Dev signing key '${keyId}' is active in production`);
    }

    for (const [keyId, meta] of this.keyMetadata) {
      if (meta.scope === '*') {
        if (isProduction) throw new Error(`Wildcard signing key '${keyId}' is forbidden in production`);
        continue;
      }
      assertKnownScope(meta.scope);
      if (meta.algorithm !== 'ES256') throw new Error(`Signing key '${keyId}' uses unsupported algorithm '${meta.algorithm}'`);
    }
  }

  /**
   * Validates envelope metadata rules.
   *
   * @param envelope envelope supplied to the function.
   * @param expectedScope expected scope supplied to the function.
   * @param expectedTenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  private verifyEnvelopeMetadata<T>(envelope: SignedEnvelope<T>, expectedScope?: SigningScope, expectedTenantId?: string): SigningScope {
    if (envelope.algorithm !== 'ES256') throw new BadRequestException('Unsupported signature algorithm');
    const scope = envelope.scope ?? envelope.payloadType;
    assertKnownScope(scope);
    if (envelope.scope && envelope.payloadType && envelope.scope !== envelope.payloadType) {
      throw new BadRequestException(`Signed payload scope '${envelope.scope}' does not match payloadType '${envelope.payloadType}'`);
    }
    if (expectedScope && scope !== expectedScope) {
      throw new BadRequestException(`Expected scope '${expectedScope}' but got '${scope}'`);
    }
    if (expectedTenantId && envelope.tenantId !== expectedTenantId) {
      throw new UnauthorizedException(`TenantId mismatch: envelope=${envelope.tenantId} expected=${expectedTenantId}`);
    }
    this.verifySignedTimestamps(envelope.issuedAt, envelope.expiresAt);
    if (!envelope.payloadHash) throw new UnauthorizedException('Signed payload is missing payloadHash');
    const computed = computePayloadHash(envelope.payload);
    if (computed !== envelope.payloadHash) throw new UnauthorizedException('Payload hash mismatch');
    return scope;
  }

  /**
   * Validates signed timestamps rules.
   *
   * @param issuedAtRaw issued at raw supplied to the function.
   * @param expiresAtRaw expires at raw supplied to the function.
   */
  private verifySignedTimestamps(issuedAtRaw: string, expiresAtRaw: string): void {
    const expiresAt = Date.parse(expiresAtRaw);
    const issuedAt = Date.parse(issuedAtRaw);
    if (!Number.isFinite(expiresAt) || !Number.isFinite(issuedAt)) {
      throw new BadRequestException('Invalid signed payload timestamps');
    }
    if (expiresAt <= Date.now()) throw new UnauthorizedException('Signed payload has expired');
  }

  /**
   * Resolves public key configuration.
   *
   * @param keyId Identifier used to locate the target record.
   * @param expectedScope expected scope supplied to the function.
   * @param tenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  private resolvePublicKey(keyId: string, expectedScope: SigningScope, tenantId: string): ReturnType<typeof createPublicKey> {
    const meta = this.keyMetadata.get(keyId);
    if (!meta) throw new UnauthorizedException(`Unknown signing key '${keyId}'`);
    if (meta.scope === '*') {
      if (process.env.NODE_ENV === 'production') throw new UnauthorizedException(`Wildcard signing key '${keyId}' is not trusted`);
      if (!this.developmentCompatibilityMode) throw new UnauthorizedException(`Wildcard signing key '${keyId}' is not trusted`);
    } else if (meta.scope !== expectedScope) {
      throw new UnauthorizedException(`Signing key '${keyId}' is scoped to '${meta.scope}', not '${expectedScope}'`);
    }
    if (meta.status === 'revoked') throw new UnauthorizedException(`Signing key '${keyId}' has been revoked`);
    if (meta.status === 'retired') {
      const deadline = meta.retirementDeadline ? Date.parse(meta.retirementDeadline) : NaN;
      if (!Number.isFinite(deadline) || Date.now() > deadline) {
        throw new UnauthorizedException(`Signing key '${keyId}' retirement deadline has passed`);
      }
    }
    if (meta.isDev && process.env.NODE_ENV === 'production') {
      throw new UnauthorizedException(`Dev signing key '${keyId}' is not trusted in production`);
    }
    if (meta.allowedTenants?.length && !meta.allowedTenants.includes(tenantId)) {
      throw new UnauthorizedException(`Signing key '${keyId}' is not allowed for tenant '${tenantId}'`);
    }
    const publicKey = this.trustedPublicKeys.get(keyId);
    if (!publicKey) throw new UnauthorizedException(`Unknown signing key '${keyId}'`);
    return publicKey;
  }
}

/**
 * Handles the canonical json operation.
 *
 * @param value Value to read, render, or store.
 * @returns The result produced by the operation.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/**
 * Computes the payload hash value.
 *
 * @param value Value to read, render, or store.
 * @returns The result produced by the operation.
 */
export function computePayloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * Handles the normalize metadata operation.
 *
 * @param keyId Identifier used to locate the target record.
 * @param raw raw supplied to the function.
 * @returns The result produced by the operation.
 */
function normalizeMetadata(keyId: string, raw: unknown): SigningKeyMetadata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Signing metadata for '${keyId}' must be an object`);
  }
  const candidate = raw as Partial<SigningKeyMetadata> & { scope?: string; algorithm?: string };
  if (candidate.keyId && candidate.keyId !== keyId) throw new Error(`Signing metadata keyId mismatch for '${keyId}'`);
  if (!candidate.scope || !SIGNING_SCOPE_SET.has(candidate.scope)) throw new Error(`Signing key '${keyId}' has unknown or missing scope`);
  if (!candidate.status || !['active', 'trusted', 'retired', 'revoked'].includes(candidate.status)) throw new Error(`Signing key '${keyId}' has invalid status`);
  if (!candidate.publicKeyPem) throw new Error(`Signing key '${keyId}' is missing publicKeyPem`);
  if (!candidate.issuedAt || !Number.isFinite(Date.parse(candidate.issuedAt))) throw new Error(`Signing key '${keyId}' has invalid issuedAt`);
  if (candidate.algorithm && candidate.algorithm !== 'ES256') throw new Error(`Signing key '${keyId}' uses unsupported algorithm`);
  return {
    keyId,
    scope: candidate.scope as SigningScope,
    status: candidate.status,
    publicKeyPem: candidate.publicKeyPem,
    issuedAt: candidate.issuedAt,
    retiredAt: candidate.retiredAt,
    retirementDeadline: candidate.retirementDeadline,
    revokedAt: candidate.revokedAt,
    isDev: candidate.isDev === true,
    algorithm: 'ES256',
    allowedTenants: Array.isArray(candidate.allowedTenants) ? candidate.allowedTenants.filter((item): item is string => typeof item === 'string') : undefined,
  };
}

/**
 * Parses json object input.
 *
 * @param raw raw supplied to the function.
 * @param name name supplied to the function.
 * @returns The result produced by the operation.
 */
function parseJsonObject(raw: string, name: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Parses legacy public keys input.
 *
 * @param raw raw supplied to the function.
 * @returns The result produced by the operation.
 */
function parseLegacyPublicKeys(raw: string) {
  const parsed = parseJsonObject(raw, 'MANAGEMENT_SIGNING_PUBLIC_KEYS_JSON');
  const entries = Object.entries(parsed);
  if (entries.length === 0) throw new Error('At least one trusted management signing public key is required');
  return new Map(entries.map(([keyId, value]) => {
    const pem = typeof value === 'string'
      ? value
      : value && typeof value === 'object' && 'publicKeyPem' in value && typeof (value as { publicKeyPem?: unknown }).publicKeyPem === 'string'
        ? (value as { publicKeyPem: string }).publicKeyPem
        : undefined;
    if (!pem) throw new Error(`Public key '${keyId}' must be a PEM string`);
    return [keyId, createPublicKey(decodePem(pem))] as const;
  }));
}

/**
 * Validates known scope rules.
 *
 * @param scope scope supplied to the function.
 */
function assertKnownScope(scope: string): asserts scope is SigningScope {
  if (!SIGNING_SCOPE_SET.has(scope)) throw new BadRequestException(`Unknown signing scope '${scope}'`);
}

/**
 * Handles the required operation.
 *
 * @param name name supplied to the function.
 * @returns The result produced by the operation.
 */
function required(name: string) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

/**
 * Handles the decode pem operation.
 *
 * @param value Value to read, render, or store.
 * @returns The result produced by the operation.
 */
function decodePem(value: string) {
  const trimmed = value.trim();
  if (trimmed.includes('-----BEGIN ')) return trimmed.replace(/\\n/g, '\n');
  return Buffer.from(trimmed, 'base64').toString('utf8');
}
