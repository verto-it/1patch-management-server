import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class AdminApiGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const configured = process.env.ADMIN_API_TOKEN;
    if (!configured) return true;
    const request = context.switchToHttp().getRequest<Request>();
    const supplied = request.header('x-1patch-admin-token') ?? request.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!supplied || !safeEqual(supplied, configured)) throw new UnauthorizedException('Admin API token required');
    return true;
  }
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
