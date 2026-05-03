import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class NodeOrAdminApiGuard implements CanActivate {
  private readonly logger = new Logger(NodeOrAdminApiGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (this.validAdminToken(request)) {
      this.logger.debug(`Admin request authorised (path=${request.path})`);
      return true;
    }
    if (this.validNodeSecret(request)) {
      this.logger.debug(`Node request authorised (path=${request.path})`);
      return true;
    }

    this.logger.warn(`Request rejected — admin token or node secret required (path=${request.path})`);
    throw new UnauthorizedException('Admin API token or node API secret required');
  }

  private validAdminToken(request: Request) {
    const configured = process.env.ADMIN_API_TOKEN;
    if (!configured) return false;
    const supplied =
      request.header('x-1patch-admin-token') ??
      request.header('authorization')?.replace(/^Bearer\s+/i, '');
    return Boolean(supplied && safeEqual(supplied, configured));
  }

  private validNodeSecret(request: Request) {
    const configured = process.env.NODE_API_SECRET;
    if (!configured || configured.length < 32) return false;
    const supplied = request.header('x-node-api-secret');
    return Boolean(supplied && safeEqual(supplied, configured));
  }
}

function safeEqual(left: string, right: string) {
  const l = Buffer.from(left);
  const r = Buffer.from(right);
  if (l.length !== r.length) return false;
  return timingSafeEqual(l, r);
}
