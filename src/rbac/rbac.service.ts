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
