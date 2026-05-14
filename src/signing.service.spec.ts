import { UnauthorizedException } from '@nestjs/common';
import { createHash, generateKeyPairSync } from 'crypto';
import { computePayloadHash, SIGNING_SCOPES, SigningService } from './signing.service';
import { SigningKeyMetadata, SigningScope } from './types';

type KeyMaterial = {
  privatePem: string;
  publicPem: string;
};

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/**
 * Handles the key pair operation.
 * @returns The result produced by the operation.
 */
function keyPair(): KeyMaterial {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/**
 * Handles the configure scoped signer operation.
 *
 * @param options Optional settings that tune the operation.
 * @returns The result produced by the operation.
 */
function configureScopedSigner(options: {
  nodeEnv?: string;
  omitScope?: SigningScope;
  duplicateTaskBundleKey?: boolean;
  rotateTaskBundleActive?: boolean;
  metadataPatch?: (metadata: Record<string, SigningKeyMetadata>) => void;
} = {}) {
  process.env = { ...ORIGINAL_ENV };
  process.env.NODE_ENV = options.nodeEnv ?? 'test';
  const activeKeys: Partial<Record<SigningScope, string>> = {};
  const privateKeys: Record<string, string> = {};
  const metadata: Record<string, SigningKeyMetadata> = {};

  for (const scope of SIGNING_SCOPES) {
    if (scope === options.omitScope) continue;
    const keyId = options.duplicateTaskBundleKey && scope === 'task_ledger' ? 'key_task_bundle_v1' : `key_${scope}_v1`;
    const pair = privateKeys[keyId] ? undefined : keyPair();
    activeKeys[scope] = keyId;
    if (pair) {
      privateKeys[keyId] = Buffer.from(pair.privatePem).toString('base64');
      metadata[keyId] = {
        keyId,
        scope,
        status: 'active',
        publicKeyPem: pair.publicPem,
        issuedAt: new Date().toISOString(),
        isDev: false,
        algorithm: 'ES256',
      };
    }
  }

  if (options.rotateTaskBundleActive) {
    const pair = keyPair();
    activeKeys.task_bundle = 'key_task_bundle_v2';
    privateKeys.key_task_bundle_v2 = Buffer.from(pair.privatePem).toString('base64');
    metadata.key_task_bundle_v2 = {
      keyId: 'key_task_bundle_v2',
      scope: 'task_bundle',
      status: 'active',
      publicKeyPem: pair.publicPem,
      issuedAt: new Date().toISOString(),
      isDev: false,
      algorithm: 'ES256',
    };
  }

  options.metadataPatch?.(metadata);
  process.env.MANAGEMENT_SIGNING_ACTIVE_KEYS_JSON = JSON.stringify(activeKeys);
  process.env.MANAGEMENT_SIGNING_PRIVATE_KEYS_JSON = JSON.stringify(privateKeys);
  process.env.MANAGEMENT_SIGNING_KEY_METADATA_JSON = JSON.stringify(metadata);
  delete process.env.MANAGEMENT_SIGNING_ACTIVE_KEY_ID;
  delete process.env.MANAGEMENT_SIGNING_PRIVATE_KEY;
  delete process.env.MANAGEMENT_SIGNING_PUBLIC_KEYS_JSON;

  const service = new SigningService();
  service.onModuleInit();
  return service;
}

describe('SigningService scoped keys', () => {
  it('signs each real scope with its own key and verifies canonical envelopes', () => {
    const service = configureScopedSigner();
    for (const scope of SIGNING_SCOPES) {
      const envelope = service.signPayload(scope, 'tenant-a', { scope });
      expect(envelope.scope).toBe(scope);
      expect(envelope.payloadType).toBe(scope);
      expect(envelope.keyId).toBe(`key_${scope}_v1`);
      expect(service.verifyEnvelope(envelope, scope, 'tenant-a')).toEqual({ scope });
    }
  });

  it('rejects wrong scope verification and cross-scope replay attempts', () => {
    const service = configureScopedSigner();
    const envelope = service.signPayload('task_bundle', 'tenant-a', { tasks: [] });
    expect(() => service.verifyEnvelope({ ...envelope, scope: 'task_ledger', payloadType: 'task_ledger' }, 'task_ledger')).toThrow(UnauthorizedException);
    expect(() => service.verifyEnvelope(envelope, 'task_ledger')).toThrow();
  });

  it('rejects revoked keys', () => {
    const signer = configureScopedSigner();
    const envelope = signer.signPayload('task_bundle', 'tenant-a', { tasks: [] });
    const verifier = configureScopedSigner({
      rotateTaskBundleActive: true,
      /**
       * Handles the metadata patch operation.
       *
       * @param metadata metadata supplied to the function.
       */
      metadataPatch: (metadata) => {
        metadata.key_task_bundle_v1.publicKeyPem = signer.getKeyMetadata(envelope.keyId)!.publicKeyPem;
        metadata.key_task_bundle_v1.status = 'revoked';
      },
    });
    expect(() => verifier.verifyEnvelope(envelope, 'task_bundle')).toThrow(UnauthorizedException);
  });

  it('accepts retired keys before retirementDeadline and rejects them afterward', () => {
    const signer = configureScopedSigner();
    const envelope = signer.signPayload('task_bundle', 'tenant-a', { tasks: [] });
    const publicKeyPem = signer.getKeyMetadata(envelope.keyId)!.publicKeyPem;

    const verifier = configureScopedSigner({
      rotateTaskBundleActive: true,
      /**
       * Handles the metadata patch operation.
       *
       * @param metadata metadata supplied to the function.
       */
      metadataPatch: (metadata) => {
        metadata.key_task_bundle_v1.publicKeyPem = publicKeyPem;
        metadata.key_task_bundle_v1.status = 'retired';
        metadata.key_task_bundle_v1.retirementDeadline = new Date(Date.now() + 60_000).toISOString();
      },
    });
    expect(verifier.verifyEnvelope(envelope, 'task_bundle')).toEqual({ tasks: [] });

    const expiredVerifier = configureScopedSigner({
      rotateTaskBundleActive: true,
      /**
       * Handles the metadata patch operation.
       *
       * @param metadata metadata supplied to the function.
       */
      metadataPatch: (metadata) => {
        metadata.key_task_bundle_v1.publicKeyPem = publicKeyPem;
        metadata.key_task_bundle_v1.status = 'retired';
        metadata.key_task_bundle_v1.retirementDeadline = new Date(Date.now() - 60_000).toISOString();
      },
    });
    expect(() => expiredVerifier.verifyEnvelope(envelope, 'task_bundle')).toThrow(UnauthorizedException);
  });

  it('rejects tenant mismatch, expired envelopes, and payload tampering', () => {
    const service = configureScopedSigner();
    const envelope = service.signPayload('task_bundle', 'tenant-a', { tasks: [] }, 60);
    expect(() => service.verifyEnvelope(envelope, 'task_bundle', 'tenant-b')).toThrow(UnauthorizedException);

    const expired = service.signPayload('task_bundle', 'tenant-a', { tasks: [] }, -1);
    expect(() => service.verifyEnvelope(expired, 'task_bundle')).toThrow(UnauthorizedException);

    const tampered = { ...envelope, payload: { tasks: [{ id: 'evil' }] } };
    expect(() => service.verifyEnvelope(tampered, 'task_bundle')).toThrow(UnauthorizedException);

    const badHash = { ...envelope, payloadHash: createHash('sha256').update('bad').digest('hex') };
    expect(() => service.verifyEnvelope(badHash, 'task_bundle')).toThrow(UnauthorizedException);
  });

  it('enforces tenant allowlists', () => {
    const service = configureScopedSigner({
      /**
       * Handles the metadata patch operation.
       *
       * @param metadata metadata supplied to the function.
       */
      metadataPatch: (metadata) => {
        metadata.key_task_bundle_v1.allowedTenants = ['tenant-a'];
      },
    });
    const envelope = service.signPayload('task_bundle', 'tenant-b', { tasks: [] });
    expect(() => service.verifyEnvelope(envelope, 'task_bundle')).toThrow(UnauthorizedException);
  });

  it('verifies detached signatures with scoped metadata', () => {
    const service = configureScopedSigner();
    const payload = { ledgerId: 'ledger-1', tenantId: 'tenant-a' };
    const envelope = service.signPayload('task_ledger', 'tenant-a', payload);
    service.verifyDetachedSignature({
      expectedScope: 'task_ledger',
      tenantId: 'tenant-a',
      keyId: envelope.keyId,
      payload,
      signature: envelope.signature,
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
      nonce: envelope.nonce,
      payloadHash: envelope.payloadHash,
      algorithm: envelope.algorithm,
    });
    expect(() => service.verifyDetachedSignature({
      expectedScope: 'task_bundle',
      tenantId: 'tenant-a',
      keyId: envelope.keyId,
      payload,
      signature: envelope.signature,
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
      nonce: envelope.nonce,
      payloadHash: computePayloadHash(payload),
      algorithm: envelope.algorithm,
    })).toThrow(UnauthorizedException);
  });

  it('hard-fails wildcard/dev/missing/duplicate scoped production configuration', () => {
    expect(() => configureScopedSigner({ nodeEnv: 'production', omitScope: 'kill_switch' })).toThrow(/kill_switch/);
    expect(() => configureScopedSigner({ nodeEnv: 'production', duplicateTaskBundleKey: true })).toThrow(/Duplicate/);
    expect(() => configureScopedSigner({
      nodeEnv: 'production',
      /**
       * Handles the metadata patch operation.
       *
       * @param metadata metadata supplied to the function.
       */
      metadataPatch: (metadata) => {
        metadata.key_task_bundle_v1.isDev = true;
      },
    })).toThrow(/Dev signing key/);

    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'production' };
    process.env.MANAGEMENT_SIGNING_ACTIVE_KEY_ID = 'legacy';
    process.env.MANAGEMENT_SIGNING_PRIVATE_KEY = Buffer.from(keyPair().privatePem).toString('base64');
    process.env.MANAGEMENT_SIGNING_PUBLIC_KEYS_JSON = JSON.stringify({ legacy: keyPair().publicPem });
    expect(() => new SigningService().onModuleInit()).toThrow(/Legacy/);
  });
});
