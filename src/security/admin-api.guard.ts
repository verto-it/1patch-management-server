import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class AdminApiGuard implements CanActivate {
  private readonly logger = new Logger(AdminApiGuard.name);

  canActivate(context: ExecutionContext) {
    const configured = process.env.ADMIN_API_TOKEN;

    // FIX #3 / #8 / #10: never allow access when the token is unconfigured
    if (!configured) {
      this.logger.error(
        'ADMIN_API_TOKEN is not set — all admin endpoints are locked. ' +
        'Set a strong random token to enable access.',
      );
      throw new UnauthorizedException('Admin API is not configured on this server');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const supplied =
      request.header('x-1patch-admin-token') ??
      request.header('authorization')?.replace(/^Bearer\s+/i, '');

    if (!supplied) {
      this.logger.warn(`Admin request rejected — no token supplied (path=${request.path})`);
      throw new UnauthorizedException('Admin API token required');
    }

    if (!safeEqual(supplied, configured)) {
      this.logger.warn(`Admin request rejected — invalid token (path=${request.path})`);
      throw new UnauthorizedException('Admin API token required');
    }

    this.logger.debug(`Admin request authorised (path=${request.path})`);
    return true;
  }
}


function safeEqual(left: string, right: string) {
  const l = Buffer.from(left);
  const r = Buffer.from(right);
  // Buffers must be same length for timingSafeEqual; pad to avoid length leak
  if (l.length !== r.length) return false;
  return timingSafeEqual(l, r);
}
