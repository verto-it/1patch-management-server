import { SetMetadata } from '@nestjs/common';
import { Permission } from '../types';

export const REQUIRED_PERMISSIONS_KEY = 'requiredPermissions';

/**
 * Renders the require permission UI.
 *
 * @param permissions permissions supplied to the function.
 */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);
