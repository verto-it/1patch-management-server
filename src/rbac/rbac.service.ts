import { Injectable } from '@nestjs/common';
import { Permission, Role, User } from '../types';

const rolePermissions: Record<Role, Permission[]> = {
  owner: ['setup:manage', 'auth:manage', 'users:manage', 'roles:manage', 'nodes:manage', 'apps:read', 'apps:manage', 'rules:manage', 'tasks:manage', 'audit:read'],
  admin: ['auth:manage', 'users:manage', 'nodes:manage', 'apps:read', 'apps:manage', 'rules:manage', 'tasks:manage', 'audit:read'],
  patch_manager: ['apps:read', 'apps:manage', 'rules:manage', 'tasks:manage'],
  viewer: ['apps:read'],
  auditor: ['apps:read', 'audit:read'],
  node_operator: ['nodes:manage', 'audit:read'],
};

@Injectable()
export class RbacService {
  can(user: User | undefined, permission: Permission) {
    if (!user) return false;
    return user.roles.some((role) => rolePermissions[role].includes(permission));
  }

  permissionsFor(roles: Role[]) {
    return [...new Set(roles.flatMap((role) => rolePermissions[role]))];
  }
}
