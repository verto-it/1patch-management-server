import { BadRequestException, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'crypto';
import { SignedEnvelope } from './types';

type SignableEnvelope<T> = Omit<SignedEnvelope<T>, 'signature'>;

@Injectable()
export class SigningService implements OnModuleInit {
  private readonly logger = new Logger(SigningService.name);
  private activeKeyId!: string;
  private privateKey!: ReturnType<typeof createPrivateKey>;
  private trustedPublicKeys = new Map<string, ReturnType<typeof createPublicKey>>();

  onModuleInit() {
    this.activeKeyId = required('MANAGEMENT_SIGNING_ACTIVE_KEY_ID');
    const privatePem = decodePem(required('MANAGEMENT_SIGNING_PRIVATE_KEY'));
    this.privateKey = createPrivateKey(privatePem);
    this.trustedPublicKeys = parsePublicKeys(required('MANAGEMENT_SIGNING_PUBLIC_KEYS_JSON'));

    if (!this.trustedPublicKeys.has(this.activeKeyId)) {
      const publicKey = createPublicKey(this.privateKey);
      this.trustedPublicKeys.set(this.activeKeyId, publicKey);
      this.logger.warn(`Active signing key ${this.activeKeyId} was not in MANAGEMENT_SIGNING_PUBLIC_KEYS_JSON; derived public key was trusted for this process`);
    }

    this.logger.log(`SigningService initialised with active keyId=${this.activeKeyId} trustedKeys=${this.trustedPublicKeys.size}`);
  }

  signPayload<T>(
    payloadType: SignedEnvelope['payloadType'],
    tenantId: string,
    payload: T,
    ttlSeconds = 10 * 60,
  ): SignedEnvelope<T> {
    const issuedAt = new Date();
    const envelope: SignableEnvelope<T> = {
      algorithm: 'ES256',
      keyId: this.activeKeyId,
      payloadType,
      tenantId,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + ttlSeconds * 1000).toISOString(),
      nonce: randomUUID(),
      payload,
    };
    const signature = sign('sha256', Buffer.from(canonicalJson(envelope)), {
      key: this.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    return { ...envelope, signature };
  }

  verifyEnvelope<T>(envelope: SignedEnvelope<T>): T {
    if (envelope.algorithm !== 'ES256') throw new BadRequestException('Unsupported signature algorithm');
    const publicKey = this.trustedPublicKeys.get(envelope.keyId);
    if (!publicKey) throw new UnauthorizedException('Unknown signing key');
    const expiresAt = Date.parse(envelope.expiresAt);
    const issuedAt = Date.parse(envelope.issuedAt);
    if (!Number.isFinite(expiresAt) || !Number.isFinite(issuedAt)) throw new BadRequestException('Invalid signed payload timestamps');
    if (expiresAt <= Date.now()) throw new UnauthorizedException('Signed payload has expired');
    const { signature, ...unsigned } = envelope;
    const ok = verify('sha256', Buffer.from(canonicalJson(unsigned)), {
      key: publicKey,
      dsaEncoding: 'ieee-p1363',
    }, Buffer.from(signature, 'base64url'));
    if (!ok) throw new UnauthorizedException('Invalid signed payload signature');
    return envelope.payload;
  }

  publicKeysForConfig(): Record<string, string> {
    return Object.fromEntries(
      [...this.trustedPublicKeys.entries()].map(([keyId, key]) => [keyId, key.export({ type: 'spki', format: 'pem' }).toString()]),
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
  try {
    parsed = JSON.parse(raw);
  } catch {
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
