import { BadRequestException, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'crypto';
import { SignedEnvelope, SigningKeyMetadata, SigningScope } from './types';

type SignableEnvelope<T> = Omit<SignedEnvelope<T>, 'signature'>;

@Injectable()
export class SigningService implements OnModuleInit {
  private readonly logger = new Logger(SigningService.name);
  private activeKeyId!: string;
  private privateKey!: ReturnType<typeof createPrivateKey>;
  private keyMetadata = new Map<string, SigningKeyMetadata>();
  private trustedPublicKeys = new Map<string, ReturnType<typeof createPublicKey>>();

  onModuleInit() {
    const isProduction = process.env.NODE_ENV === 'production';
    const hasConfiguredSigner = Boolean(
      process.env.MANAGEMENT_SIGNING_ACTIVE_KEY_ID?.trim() &&
      process.env.MANAGEMENT_SIGNING_PRIVATE_KEY?.trim() &&
      process.env.MANAGEMENT_SIGNING_PUBLIC_KEYS_JSON?.trim(),
    );

    if (!hasConfiguredSigner) {
      if (isProduction) {
        required('MANAGEMENT_SIGNING_ACTIVE_KEY_ID');
        required('MANAGEMENT_SIGNING_PRIVATE_KEY');
        required('MANAGEMENT_SIGNING_PUBLIC_KEYS_JSON');
      }
      this.initialiseEphemeralDevSigner();
      return;
    }

    this.activeKeyId = required('MANAGEMENT_SIGNING_ACTIVE_KEY_ID');
    const privatePem = decodePem(required('MANAGEMENT_SIGNING_PRIVATE_KEY'));
    this.privateKey = createPrivateKey(privatePem);

    // Fail fast in production if a dev signer is configured
    const isDev = process.env.MANAGEMENT_SIGNING_IS_DEV === 'true';
    if (isProduction && isDev) {
      this.logger.error('FATAL: Dev signing key is configured in production. Set MANAGEMENT_SIGNING_IS_DEV=false or use a production key.');
      process.exit(1);
    }

    this.trustedPublicKeys = parsePublicKeys(required('MANAGEMENT_SIGNING_PUBLIC_KEYS_JSON'));

    if (!this.trustedPublicKeys.has(this.activeKeyId)) {
      const publicKey = createPublicKey(this.privateKey);
      this.trustedPublicKeys.set(this.activeKeyId, publicKey);
      this.logger.warn(`Active signing key ${this.activeKeyId} was not in MANAGEMENT_SIGNING_PUBLIC_KEYS_JSON; derived public key was trusted for this process`);
    }

    // Register metadata for the active key
    const activeMeta: SigningKeyMetadata = {
      keyId: this.activeKeyId,
      scope: '*',
      status: 'active',
      publicKeyPem: createPublicKey(this.privateKey).export({ type: 'spki', format: 'pem' }).toString(),
      issuedAt: new Date().toISOString(),
      isDev,
    };
    
    this.keyMetadata.set(this.activeKeyId, activeMeta);

    this.logger.log(`SigningService initialised: activeKeyId=${this.activeKeyId} isDev=${isDev} trustedKeys=${this.trustedPublicKeys.size}`);
  }

  signPayload<T>(
    payloadType: SigningScope,
    tenantId: string,
    payload: T,
    ttlSeconds = 10 * 60,
  ): SignedEnvelope<T> {
    const issuedAt = new Date();
    const payloadHash = createHash('sha256').update(canonicalJson(payload)).digest('hex');
    const envelope: SignableEnvelope<T> = {
      algorithm: 'ES256',
      keyId: this.activeKeyId,
      payloadType,
      tenantId,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + ttlSeconds * 1000).toISOString(),
      nonce: randomUUID(),
      payloadHash,
      payload,
    };
    const signature = sign('sha256', Buffer.from(canonicalJson(envelope)), {
      key: this.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    return { ...envelope, signature };
  }

  verifyEnvelope<T>(envelope: SignedEnvelope<T>, expectedScope?: SigningScope): T {
    this.verifyEnvelopeMetadata(envelope, expectedScope);
    const publicKey = this.resolvePublicKey(envelope.keyId);
    const { signature, ...unsigned } = envelope;
    const ok = verify('sha256', Buffer.from(canonicalJson(unsigned)), {
      key: publicKey,
      dsaEncoding: 'ieee-p1363',
    }, Buffer.from(signature, 'base64url'));
    if (!ok) throw new UnauthorizedException('Invalid signed payload signature');

    // Verify payloadHash if present
    if (envelope.payloadHash) {
      const computed = createHash('sha256').update(canonicalJson(envelope.payload)).digest('hex');
      if (computed !== envelope.payloadHash) throw new UnauthorizedException('Payload hash mismatch');
    }

    return envelope.payload;
  }

  /** Verify a raw (detached) ECDSA signature over a canonical JSON string */
  verifyEnvelopeRaw(
    scope: SigningScope,
    tenantId: string,
    keyId: string,
    canonicalData: string,
    signature: string,
  ): void {
    const publicKey = this.resolvePublicKey(keyId);
    const ok = verify('sha256', Buffer.from(canonicalData), {
      key: publicKey,
      dsaEncoding: 'ieee-p1363',
    }, Buffer.from(signature, 'base64url'));
    if (!ok) throw new UnauthorizedException(`Invalid signature for scope=${scope} keyId=${keyId}`);
  }

  /** Returns key metadata for all trusted keys (for client config export) */
  publicKeysForConfig(): Record<string, string> {
    return Object.fromEntries(
      [...this.trustedPublicKeys.entries()].map(([keyId, key]) => [
        keyId,
        key.export({ type: 'spki', format: 'pem' }).toString(),
      ]),
    );
  }

  getKeyMetadata(keyId: string): SigningKeyMetadata | undefined {
    return this.keyMetadata.get(keyId);
  }

  getActiveKeyId(): string {
    return this.activeKeyId;
  }

  isDevKey(keyId: string): boolean {
    return this.keyMetadata.get(keyId)?.isDev === true;
  }

  private verifyEnvelopeMetadata<T>(envelope: SignedEnvelope<T>, expectedScope?: SigningScope): void {
    if (envelope.algorithm !== 'ES256') throw new BadRequestException('Unsupported signature algorithm');
    if (expectedScope && envelope.payloadType !== expectedScope) {
      throw new BadRequestException(`Expected scope '${expectedScope}' but got '${envelope.payloadType}'`);
    }
    const expiresAt = Date.parse(envelope.expiresAt);
    const issuedAt  = Date.parse(envelope.issuedAt);
    if (!Number.isFinite(expiresAt) || !Number.isFinite(issuedAt)) {
      throw new BadRequestException('Invalid signed payload timestamps');
    }
    if (expiresAt <= Date.now()) throw new UnauthorizedException('Signed payload has expired');
  }

  private resolvePublicKey(keyId: string): ReturnType<typeof createPublicKey> {
    const meta = this.keyMetadata.get(keyId);
    // Reject revoked keys immediately
    if (meta?.status === 'revoked') throw new UnauthorizedException(`Signing key '${keyId}' has been revoked`);
    // Reject keys past their retirement deadline
    if (meta?.status === 'retired' && meta.retirementDeadline && Date.now() > new Date(meta.retirementDeadline).getTime()) {
      throw new UnauthorizedException(`Signing key '${keyId}' retirement deadline has passed`);
    }
    // Reject dev keys in production
    if (meta?.isDev && process.env.NODE_ENV === 'production') {
      throw new UnauthorizedException(`Dev signing key '${keyId}' is not trusted in production`);
    }
    const publicKey = this.trustedPublicKeys.get(keyId);
    if (!publicKey) throw new UnauthorizedException(`Unknown signing key '${keyId}'`);
    return publicKey;
  }

  private initialiseEphemeralDevSigner(): void {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.activeKeyId = 'dev-ephemeral';
    this.privateKey = privateKey;
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    this.trustedPublicKeys = new Map([[this.activeKeyId, publicKey]]);
    this.keyMetadata = new Map([[
      this.activeKeyId,
      {
        keyId: this.activeKeyId,
        scope: '*',
        status: 'active',
        publicKeyPem,
        issuedAt: new Date().toISOString(),
        isDev: true,
      },
    ]]);
    this.logger.warn(
      'MANAGEMENT_SIGNING_* env vars are not fully configured. Using an ephemeral in-memory dev signer. ' +
      'Signed payloads from this process will stop verifying after restart; configure real signing keys for persistent environments.',
    );
  }
}

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

function parsePublicKeys(raw: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw new Error('MANAGEMENT_SIGNING_PUBLIC_KEYS_JSON must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MANAGEMENT_SIGNING_PUBLIC_KEYS_JSON must be a keyId-to-PEM object');
  }
  const entries = Object.entries(parsed as Record<string, string>);
  if (entries.length === 0) throw new Error('At least one trusted management signing public key is required');
  return new Map(entries.map(([keyId, pem]) => [keyId, createPublicKey(decodePem(pem))]));
}

function required(name: string) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

function decodePem(value: string) {
  const trimmed = value.trim();
  if (trimmed.includes('-----BEGIN ')) return trimmed.replace(/\\n/g, '\n');
  return Buffer.from(trimmed, 'base64').toString('utf8');
}
