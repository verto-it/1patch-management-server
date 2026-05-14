import { Injectable } from '@nestjs/common';
import { Permission, Role, User } from '../types';


const rolePermissions: Record<Role, Permission[]> = {
  owner:         ['setup:manage','auth:manage','users:manage','roles:manage','nodes:manage','nodes:read','nodes:enroll','packages:read','packages:write','deployments:write','apps:read','apps:manage','rules:manage','tasks:manage','tasks:approve','tasks:sign','kill_switch:manage','audit:read'],
  admin:         ['auth:manage','users:manage','nodes:manage','nodes:read','nodes:enroll','packages:read','packages:write','deployments:write','apps:read','apps:manage','rules:manage','tasks:manage','tasks:approve','tasks:sign','audit:read'],
  patch_manager: ['apps:read','apps:manage','packages:read','packages:write','deployments:write','rules:manage','tasks:manage','tasks:approve'],
  viewer:        ['apps:read'],
  auditor:       ['apps:read','audit:read'],
  node_operator: ['nodes:manage','nodes:read','nodes:enroll','audit:read'],
};

export const ALL_ROLES = Object.keys(rolePermissions) as Role[];
export const ALL_PERMISSIONS = [...new Set(Object.values(rolePermissions).flat())].sort() as Permission[];

@Injectable()
export class RbacService {
  /**
   * Validates can rules.
   *
   * @param user user supplied to the function.
   * @param permission permission supplied to the function.
   * @returns The result produced by the operation.
   */
  can(user: User | undefined, permission: Permission) {
    if (!user) return false;
    return user.roles.some((role) => rolePermissions[role]?.includes(permission));
  }

  /**
   * Handles the permissions for operation for RbacService.
   *
   * @param roles roles supplied to the function.
   * @returns The result produced by the operation.
   */
  permissionsFor(roles: Role[]) {
    return [...new Set(roles.flatMap((role) => rolePermissions[role] ?? []))];
  }

  roleMatrix() {
    return Object.fromEntries(ALL_ROLES.map((role) => [role, rolePermissions[role]])) as Record<Role, Permission[]>;
  }

  allRoles() {
    return ALL_ROLES;
  }

  allPermissions() {
    return ALL_PERMISSIONS;
  }
}
