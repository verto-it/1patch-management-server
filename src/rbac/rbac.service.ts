import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { MemoryStore } from '../storage/memory.store';
import { Permission, Role, RoleDefinition, User } from '../types';


const BUILTIN_ROLE_DEFINITIONS: RoleDefinition[] = [
  {
    id: 'owner',
    name: 'Owner',
    description: 'Full management server control, including setup, users, roles, signing, and emergency controls.',
    permissions: ['setup:manage','auth:manage','users:manage','roles:manage','nodes:manage','nodes:read','nodes:enroll','packages:read','packages:write','deployments:write','apps:read','apps:manage','rules:manage','tasks:manage','tasks:approve','tasks:sign','kill_switch:manage','audit:read'],
    builtIn: true,
  },
  {
    id: 'admin',
    name: 'Admin',
    description: 'Day-to-day administration without initial setup or global kill-switch control.',
    permissions: ['auth:manage','users:manage','nodes:manage','nodes:read','nodes:enroll','packages:read','packages:write','deployments:write','apps:read','apps:manage','rules:manage','tasks:manage','tasks:approve','tasks:sign','audit:read'],
    builtIn: true,
  },
  {
    id: 'patch_manager',
    name: 'Patch Manager',
    description: 'Patch catalog, deployment, rule, and task approval operations.',
    permissions: ['apps:read','apps:manage','packages:read','packages:write','deployments:write','rules:manage','tasks:manage','tasks:approve'],
    builtIn: true,
  },
  {
    id: 'viewer',
    name: 'Viewer',
    description: 'Read-only dashboard access.',
    permissions: ['apps:read'],
    builtIn: true,
  },
  {
    id: 'auditor',
    name: 'Auditor',
    description: 'Read-only dashboard and audit trail access.',
    permissions: ['apps:read','audit:read'],
    builtIn: true,
  },
  {
    id: 'node_operator',
    name: 'Node Operator',
    description: 'Backend node enrollment, operations, and audit access.',
    permissions: ['nodes:manage','nodes:read','nodes:enroll','audit:read'],
    builtIn: true,
  },
];

export const ALL_ROLES = BUILTIN_ROLE_DEFINITIONS.map((role) => role.id);
export const ALL_PERMISSIONS = [...new Set(BUILTIN_ROLE_DEFINITIONS.flatMap((role) => role.permissions))].sort() as Permission[];
export const BUILTIN_ROLES = BUILTIN_ROLE_DEFINITIONS.map((role) => cloneRole(role));

@Injectable()
export class RbacService {
  constructor(@Optional() private readonly store?: MemoryStore) {}

  /**
   * Validates can rules.
   *
   * @param user user supplied to the function.
   * @param permission permission supplied to the function.
   * @returns The result produced by the operation.
   */
  can(user: User | undefined, permission: Permission) {
    if (!user) return false;
    const matrix = this.roleMatrix();
    return user.roles.some((role) => matrix[role]?.includes(permission));
  }

  /**
   * Handles the permissions for operation for RbacService.
   *
   * @param roles roles supplied to the function.
   * @returns The result produced by the operation.
   */
  permissionsFor(roles: Role[]) {
    const matrix = this.roleMatrix();
    return [...new Set(roles.flatMap((role) => matrix[role] ?? []))];
  }

  roleMatrix() {
    return Object.fromEntries(this.roleDefinitions().map((role) => [role.id, [...role.permissions]])) as Record<Role, Permission[]>;
  }

  allRoles() {
    return this.roleDefinitions().map((role) => role.id);
  }

  allPermissions() {
    return ALL_PERMISSIONS;
  }

  roleDefinitions() {
    const source = this.store?.roleDefinitions?.length ? this.store.roleDefinitions : BUILTIN_ROLE_DEFINITIONS;
    return source.map((role) => ({
      ...role,
      name: role.name || labelFromRoleId(role.id),
      permissions: this.cleanPermissions(role.permissions),
      builtIn: Boolean(role.builtIn),
    }));
  }

  hasRole(role: Role) {
    return this.roleDefinitions().some((definition) => definition.id === role);
  }

  async createRole(input: { id?: string; name?: string; description?: string; permissions?: Permission[] }) {
    const now = new Date().toISOString();
    const id = normalizeRoleId(input.id || input.name || '');
    if (!id) throw new BadRequestException('Role ID or name is required');
    if (this.hasRole(id)) throw new BadRequestException('Role already exists');
    const role: RoleDefinition = {
      id,
      name: cleanRoleName(input.name) || labelFromRoleId(id),
      description: input.description?.trim() || undefined,
      permissions: this.cleanPermissions(input.permissions ?? []),
      builtIn: false,
      createdAt: now,
      updatedAt: now,
    };
    await this.saveDefinitions([...this.roleDefinitions(), role]);
    return role;
  }

  async updateRole(id: Role, input: { name?: string; description?: string; permissions?: Permission[] }) {
    const roles = this.roleDefinitions();
    const index = roles.findIndex((role) => role.id === id);
    if (index === -1) throw new BadRequestException('Unknown role');

    const next: RoleDefinition = {
      ...roles[index],
      name: input.name !== undefined ? (cleanRoleName(input.name) || labelFromRoleId(id)) : roles[index].name,
      description: input.description !== undefined ? input.description.trim() || undefined : roles[index].description,
      permissions: input.permissions !== undefined ? this.cleanPermissions(input.permissions) : roles[index].permissions,
      updatedAt: new Date().toISOString(),
    };
    this.assertRoleIsSafe(next);
    roles[index] = next;
    await this.saveDefinitions(roles);
    return next;
  }

  async deleteRole(id: Role) {
    if (id === 'owner') throw new BadRequestException('The owner role cannot be deleted');
    const roles = this.roleDefinitions();
    const role = roles.find((candidate) => candidate.id === id);
    if (!role) throw new BadRequestException('Unknown role');
    if (this.store?.users.some((user) => user.roles.includes(id))) {
      throw new BadRequestException('Remove this role from all users before deleting it');
    }
    if (this.store?.ssoProviders.some((provider) => provider.defaultRole === id)) {
      throw new BadRequestException('Change SSO providers using this default role before deleting it');
    }
    await this.saveDefinitions(roles.filter((candidate) => candidate.id !== id));
    return role;
  }

  private async saveDefinitions(roles: RoleDefinition[]) {
    if (!this.store) throw new BadRequestException('Role storage is unavailable');
    this.store.roleDefinitions = roles.map((role) => ({
      ...role,
      permissions: this.cleanPermissions(role.permissions),
    }));
    await this.store.persist();
  }

  private cleanPermissions(permissions: Permission[]) {
    const allowed = new Set(ALL_PERMISSIONS);
    return [...new Set((permissions ?? []).filter((permission): permission is Permission => allowed.has(permission)))].sort();
  }

  private assertRoleIsSafe(role: RoleDefinition) {
    if (role.id !== 'owner') return;
    for (const permission of ['users:manage', 'roles:manage'] as Permission[]) {
      if (!role.permissions.includes(permission)) {
        throw new BadRequestException('The owner role must keep user and role management permissions');
      }
    }
  }
}

function cloneRole(role: RoleDefinition): RoleDefinition {
  return { ...role, permissions: [...role.permissions] };
}

function normalizeRoleId(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_:-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

function cleanRoleName(value?: string) {
  return value?.trim().replace(/\s+/g, ' ').slice(0, 80) ?? '';
}

function labelFromRoleId(id: string) {
  return id.split(/[_:-]+/).filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ') || id;
}
