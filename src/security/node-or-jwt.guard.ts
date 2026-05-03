import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class NodeOrJwtGuard implements CanActivate {
  private readonly logger = new Logger(NodeOrJwtGuard.name);

  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (this.validNodeSecret(request)) {
      this.logger.debug(`Node request authorised (path=${request.path})`);
      return true;
    }
    if (this.validJwt(request)) {
      this.logger.debug(`JWT request authorised (path=${request.path})`);
      return true;
    }

    this.logger.warn(`Request rejected — node secret or JWT required (path=${request.path})`);
    throw new UnauthorizedException('Node API secret or authenticated user required');
  }

  private validJwt(request: Request) {
    const supplied = request.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!supplied) return false;
    try {
      this.jwt.verify(supplied);
      return true;
    } catch {
      return false;
    }
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
