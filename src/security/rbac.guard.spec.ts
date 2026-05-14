import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RbacGuard } from './rbac.guard';
import { REQUIRED_PERMISSIONS_KEY } from './require-permission.decorator';
import { RbacService } from '../rbac/rbac.service';
import { MemoryStore } from '../storage/memory.store';
import { User } from '../types';

/**
 * Manages user state for the UI.
 *
 * @param roles roles supplied to the function.
 */
const user = (roles: User['roles']): User => ({
  id: roles.join('-') || 'viewer',
  email: `${roles[0] ?? 'viewer'}@example.com`,
  passwordHash: '',
  roles,
  mfaEnabled: false,
  recoveryCodeHashes: [],
  failedAttempts: 0,
  oauthLinks: [],
});

/**
 * Handles the context operation.
 *
 * @param headers headers supplied to the function.
 * @returns The result produced by the operation.
 */
function context(headers: Record<string, string> = {}) {
  const req = { header: (name: string) => headers[name.toLowerCase()], path: '/nodes/enrollments' };
  return {
    /**
     * Handles the switch to http operation.
     */
    switchToHttp: () => ({ getRequest: () => req }),
    /**
     * Gets the handler value.
     */
    getHandler: () => ({}),
    /**
     * Gets the class value.
     */
    getClass: () => ({}),
  } as ExecutionContext;
}

describe('JWT + RBAC admin auth', () => {
  const jwt = new JwtService({ secret: 'x'.repeat(32) });
  const reflector = { getAllAndOverride: jest.fn() } as unknown as Reflector;
  const dragonfly = { getJson: jest.fn(async () => null) };

  beforeEach(() => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['nodes:enroll']);
    dragonfly.getJson.mockResolvedValue(null);
  });

  it('rejects no JWT', async () => {
    await expect(new JwtAuthGuard(jwt, dragonfly as any).canActivate(context())).rejects.toThrow('Authentication required');
  });

  it('rejects users without permission and accepts users with permission', async () => {
    const viewer = user(['viewer']);
    const owner = user(['owner']);
    const store = { users: [viewer, owner] } as MemoryStore;
    const guard = new RbacGuard(reflector, store, new RbacService());

    const viewerCtx = context({ authorization: `Bearer ${jwt.sign({ sub: viewer.id })}` });
    await new JwtAuthGuard(jwt, dragonfly as any).canActivate(viewerCtx);
    expect(() => guard.canActivate(viewerCtx)).toThrow('Insufficient permission');

    const ownerCtx = context({ authorization: `Bearer ${jwt.sign({ sub: owner.id })}` });
    await new JwtAuthGuard(jwt, dragonfly as any).canActivate(ownerCtx);
    expect(guard.canActivate(ownerCtx)).toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(REQUIRED_PERMISSIONS_KEY, expect.any(Array));
  });
});
