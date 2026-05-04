import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { MtlsNodeGuard, extractNodeId, NODE_ID_KEY } from './mtls-node.guard';

// ── Helper builders ──────────────────────────────────────────────────────────

function makeTlsSocket(opts: {
  hasPeerCert: boolean;
  authorized: boolean;
  authorizationError?: string;
  cn?: string;
}) {
  return {
    getPeerCertificate: opts.hasPeerCert
      ? () => ({
          subject: opts.cn ? { CN: opts.cn } : {},
        })
      : undefined,
    authorized: opts.authorized,
    authorizationError: opts.authorizationError,
  };
}

function makeContext(socket: unknown, body: unknown = {}, path = '/nodes/heartbeat'): ExecutionContext {
  const request: Record<string, unknown> = { socket, body, path };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

// ── extractNodeId unit tests ─────────────────────────────────────────────────

describe('extractNodeId()', () => {
  it('returns nodeId for a valid Vault CN', () => {
    expect(extractNodeId('abc-123.1patch.internal')).toBe('abc-123');
  });

  it('returns a UUID nodeId correctly', () => {
    const uuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    expect(extractNodeId(`${uuid}.1patch.internal`)).toBe(uuid);
  });

  it('returns undefined when suffix is missing', () => {
    expect(extractNodeId('abc-123.example.com')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(extractNodeId('')).toBeUndefined();
  });

  it('returns undefined when only the suffix is present (empty id)', () => {
    expect(extractNodeId('.1patch.internal')).toBeUndefined();
  });

  it('returns undefined for arbitrary strings without the suffix', () => {
    expect(extractNodeId('not-a-valid-cn')).toBeUndefined();
  });
});

// ── MtlsNodeGuard tests ──────────────────────────────────────────────────────

describe('MtlsNodeGuard', () => {
  let guard: MtlsNodeGuard;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    guard = new MtlsNodeGuard();
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  // ── (1) No client certificate ──────────────────────────────────────────────

  it('rejects when no client certificate is presented (empty subject)', () => {
    const socket = {
      getPeerCertificate: () => ({ subject: {} }),
      authorized: false,
    };
    const ctx = makeContext(socket);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctx)).toThrow('Client certificate required');
  });

  it('rejects when getPeerCertificate returns no subject', () => {
    const socket = {
      getPeerCertificate: () => ({ subject: undefined }),
      authorized: false,
    };
    const ctx = makeContext(socket);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  // ── (2) Invalid / untrusted certificate ────────────────────────────────────

  it('rejects when the certificate is not trusted by the Vault CA (authorized=false)', () => {
    const socket = makeTlsSocket({
      hasPeerCert: true,
      authorized: false,
      authorizationError: 'CERT_SIGNATURE_FAILURE',
      cn: 'f47ac10b-58cc-4372-a567-0e02b2c3d479.1patch.internal',
    });
    const ctx = makeContext(socket);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctx)).toThrow('not trusted');
  });

  // ── (3) Revoked / wrong CN ─────────────────────────────────────────────────

  it('rejects when the certificate CN does not match <nodeId>.1patch.internal', () => {
    const socket = makeTlsSocket({
      hasPeerCert: true,
      authorized: true,
      cn: 'untrusted.example.com',
    });
    const ctx = makeContext(socket);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctx)).toThrow('common name is invalid');
  });

  it('rejects when the CN has no nodeId prefix (bare suffix)', () => {
    const socket = makeTlsSocket({
      hasPeerCert: true,
      authorized: true,
      cn: '.1patch.internal',
    });
    const ctx = makeContext(socket);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  // ── (4) Valid certificate ──────────────────────────────────────────────────

  it('accepts a valid Vault-issued certificate and attaches nodeId to the request', () => {
    const nodeId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const socket = makeTlsSocket({
      hasPeerCert: true,
      authorized: true,
      cn: `${nodeId}.1patch.internal`,
    });
    const reqContainer: Record<string, unknown> = { socket, body: {}, path: '/nodes/heartbeat' };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => reqContainer }),
    } as unknown as ExecutionContext;

    const result = guard.canActivate(ctx);

    expect(result).toBe(true);
    expect(reqContainer[NODE_ID_KEY]).toBe(nodeId);
  });

  // ── (5) nodeId extracted correctly from cert ───────────────────────────────

  it('extracts nodeId from a UUID-format CN correctly', () => {
    const nodeId = '11111111-2222-3333-4444-555555555555';
    const socket = makeTlsSocket({
      hasPeerCert: true,
      authorized: true,
      cn: `${nodeId}.1patch.internal`,
    });
    const reqContainer: Record<string, unknown> = { socket, body: {}, path: '/nodes/heartbeat' };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => reqContainer }),
    } as unknown as ExecutionContext;

    guard.canActivate(ctx);
    expect(reqContainer[NODE_ID_KEY]).toBe(nodeId);
  });

  // ── (6) NODE_API_SECRET header is NOT accepted ─────────────────────────────

  it('rejects even when x-node-api-secret header is present and NODE_API_SECRET env is set', () => {
    const originalSecret = process.env.NODE_API_SECRET;
    process.env.NODE_API_SECRET = 'a'.repeat(64);

    // Simulate a socket with no cert (what an old node would send — just the header)
    const socket = {
      getPeerCertificate: () => ({ subject: {} }),
      authorized: false,
    };
    const reqContainer: Record<string, unknown> = {
      socket,
      body: {},
      path: '/nodes/heartbeat',
      headers: { 'x-node-api-secret': 'a'.repeat(64) },
      header: (name: string) => (name === 'x-node-api-secret' ? 'a'.repeat(64) : undefined),
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => reqContainer }),
    } as unknown as ExecutionContext;

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);

    process.env.NODE_API_SECRET = originalSecret;
  });

  // ── (7) Dev mode — plain HTTP allowed only with explicit MTLS_DISABLED ─────

  it('accepts dev-mode plain-HTTP request only when MTLS_DISABLED=true outside production', () => {
    process.env.NODE_ENV = 'development';
    process.env.MTLS_DISABLED = 'true';

    const socket = {}; // no getPeerCertificate — plain HTTP
    const nodeId = 'dev-node-abc';
    const reqContainer: Record<string, unknown> = {
      socket,
      body: { nodeId },
      path: '/nodes/heartbeat',
      header: () => undefined,
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => reqContainer }),
    } as unknown as ExecutionContext;

    const result = guard.canActivate(ctx);

    expect(result).toBe(true);
    expect(reqContainer[NODE_ID_KEY]).toBe(nodeId);
    delete process.env.MTLS_DISABLED;
  });

  it('rejects dev-mode plain-HTTP request in production', () => {
    process.env.NODE_ENV = 'production';

    const socket = {}; // no getPeerCertificate
    const ctx = makeContext(socket);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctx)).toThrow('mTLS client certificate required');
  });
});
