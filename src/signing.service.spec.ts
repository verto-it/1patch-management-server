import { UnauthorizedException } from '@nestjs/common';
import { generateKeyPairSync } from 'crypto';
import { SigningService } from './signing.service';

function configuredSigner() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  process.env.MANAGEMENT_SIGNING_ACTIVE_KEY_ID = 'main';
  process.env.MANAGEMENT_SIGNING_PRIVATE_KEY = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()).toString('base64');
  process.env.MANAGEMENT_SIGNING_PUBLIC_KEYS_JSON = JSON.stringify({
    main: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  });
  const service = new SigningService();
  service.onModuleInit();
  return service;
}

describe('SigningService', () => {
  it('verifies canonical ES256 envelopes and rejects modified payloads', () => {
    const service = configuredSigner();
    const envelope = service.signPayload('bootstrap_manifest', 'tenant-a', { nodes: [{ id: 'n1', publicUrl: 'https://node' }] });
    expect(service.verifyEnvelope(envelope)).toEqual(envelope.payload);

    const tampered = { ...envelope, payload: { nodes: [{ id: 'n1', publicUrl: 'https://evil' }] } };
    expect(() => service.verifyEnvelope(tampered)).toThrow(UnauthorizedException);
  });

  it('rejects unknown keys and expired payloads', () => {
    const service = configuredSigner();
    const envelope = service.signPayload('task_bundle', 'tenant-a', { tasks: [] }, 60);
    expect(() => service.verifyEnvelope({ ...envelope, keyId: 'unknown' })).toThrow(UnauthorizedException);

    const expired = service.signPayload('task_bundle', 'tenant-a', { tasks: [] }, -1);
    expect(() => service.verifyEnvelope(expired)).toThrow(UnauthorizedException);
  });
});
