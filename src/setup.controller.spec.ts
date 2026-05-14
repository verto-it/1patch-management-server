import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { RbacService } from './rbac/rbac.service';
import { SetupController } from './setup.controller';
import { User } from './types';

const owner: User = {
  id: 'owner-1',
  email: 'owner@example.com',
  passwordHash: '',
  roles: ['owner'],
  mfaEnabled: false,
  recoveryCodeHashes: [],
  failedAttempts: 0,
  oauthLinks: [],
};

/**
 * Handles the request operation.
 *
 * @param token Token used to authenticate or authorize the operation.
 * @returns The result produced by the operation.
 */
function request(token?: string) {
  return {
    /**
     * Handles the header operation.
     *
     * @param name name supplied to the function.
     */
    header: (name: string) => (name.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : undefined),
  } as Request;
}

/**
 * Handles the make controller operation.
 *
 * @param users users supplied to the function.
 * @returns The result produced by the operation.
 */
function makeController(users: User[] = []) {
  const postgres = {
    getStatus: jest.fn(() => ({ configured: true, available: true, lastError: undefined })),
  };
  const dragonfly = {
    getStatus: jest.fn(() => ({ configured: true, available: true, lastError: undefined })),
  };
  const nodes = { createEnrollment: jest.fn() };
  const store = { users, backendNodes: [] };
  const jwt = new JwtService({ secret: 'x'.repeat(32) });
  const controller = new SetupController(
    postgres as any,
    dragonfly as any,
    nodes as any,
    store as any,
    jwt,
    new RbacService(),
  );
  return { controller, jwt, postgres, dragonfly };
}

describe('SetupController bootstrap exposure', () => {
  it('serves anonymous setup only before the first owner exists', () => {
    expect(makeController().controller.page()).toContain('1Patch Management Setup');

    expect(() => makeController([owner]).controller.page()).toThrow(
      'Setup is not available after initial configuration',
    );
  });

  it('requires owner authorization for setup status after configuration', () => {
    const { controller, jwt } = makeController([owner]);
    expect(() => controller.status(request())).toThrow('Owner authentication required');

    const token = jwt.sign({ sub: owner.id, roles: owner.roles });
    expect(controller.status(request(token))).toMatchObject({
      databaseConfigured: true,
      databaseAvailable: true,
      dragonflyConfigured: true,
      dragonflyAvailable: true,
      ownerCreated: true,
    });
  });

  it('keeps setup status anonymous during first-run bootstrap', () => {
    const { controller } = makeController();

    expect(controller.status(request())).toMatchObject({
      ownerCreated: false,
      databaseConfigured: true,
      dragonflyConfigured: true,
    });
  });
});
