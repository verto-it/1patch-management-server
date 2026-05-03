import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RbacGuard } from './rbac.guard';
import { REQUIRED_PERMISSIONS_KEY } from './require-permission.decorator';
import { RbacService } from '../rbac/rbac.service';
import { MemoryStore } from '../storage/memory.store';
import { User } from '../types';

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

function context(headers: Record<string, string> = {}) {
  const req = { header: (name: string) => headers[name.toLowerCase()], path: '/nodes/enrollments' };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as ExecutionContext;
}

describe('JWT + RBAC admin auth', () => {
  const jwt = new JwtService({ secret: 'x'.repeat(32) });
  const reflector = { getAllAndOverride: jest.fn() } as unknown as Reflector;

  beforeEach(() => jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['nodes:enroll']));

  it('rejects no JWT', () => {
    expect(() => new JwtAuthGuard(jwt).canActivate(context())).toThrow('Authentication required');
  });

  it('rejects users without permission and accepts users with permission', () => {
    const viewer = user(['viewer']);
    const owner = user(['owner']);
    const store = { users: [viewer, owner] } as MemoryStore;
    const guard = new RbacGuard(reflector, store, new RbacService());

    const viewerCtx = context({ authorization: `Bearer ${jwt.sign({ sub: viewer.id })}` });
    new JwtAuthGuard(jwt).canActivate(viewerCtx);
    expect(() => guard.canActivate(viewerCtx)).toThrow('Insufficient permission');

    const ownerCtx = context({ authorization: `Bearer ${jwt.sign({ sub: owner.id })}` });
    new JwtAuthGuard(jwt).canActivate(ownerCtx);
    expect(guard.canActivate(ownerCtx)).toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(REQUIRED_PERMISSIONS_KEY, expect.any(Array));
  });
});
