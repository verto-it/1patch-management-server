import { SetMetadata } from '@nestjs/common';
import { Permission } from '../types';

export const REQUIRED_PERMISSIONS_KEY = 'requiredPermissions';

export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);
