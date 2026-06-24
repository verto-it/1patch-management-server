import { RbacService } from './rbac.service';
import { MemoryStore } from '../storage/memory.store';

function store(overrides: Partial<MemoryStore> = {}) {
  return {
    roleDefinitions: [],
    users: [],
    ssoProviders: [],
    persist: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as MemoryStore;
}

describe('RbacService role management', () => {
  it('creates custom roles and grants their permissions', async () => {
    const backingStore = store();
    const rbac = new RbacService(backingStore);

    await rbac.createRole({
      id: 'regional_operator',
      name: 'Regional Operator',
      permissions: ['nodes:read', 'apps:read'],
    });

    expect(rbac.hasRole('regional_operator')).toBe(true);
    expect(rbac.can({ id: 'u1', email: 'u@example.com', passwordHash: '', roles: ['regional_operator'], mfaEnabled: false, recoveryCodeHashes: [], failedAttempts: 0, oauthLinks: [] }, 'nodes:read')).toBe(true);
    expect(backingStore.persist).toHaveBeenCalled();
  });

  it('allows built-in role edits while protecting owner management permissions', async () => {
    const backingStore = store();
    const rbac = new RbacService(backingStore);

    await rbac.updateRole('viewer', { permissions: ['apps:read', 'audit:read'] });
    expect(rbac.permissionsFor(['viewer'])).toContain('audit:read');

    await expect(rbac.updateRole('owner', { permissions: ['apps:read'] })).rejects.toThrow('owner role must keep');
  });

  it('blocks unsafe role deletes', async () => {
    const backingStore = store({
      users: [{ id: 'u1', email: 'u@example.com', passwordHash: '', roles: ['auditor'], mfaEnabled: false, recoveryCodeHashes: [], failedAttempts: 0, oauthLinks: [] }],
    });
    const rbac = new RbacService(backingStore);

    await expect(rbac.deleteRole('owner')).rejects.toThrow('owner role cannot be deleted');
    await expect(rbac.deleteRole('auditor')).rejects.toThrow('Remove this role from all users');
  });
});
