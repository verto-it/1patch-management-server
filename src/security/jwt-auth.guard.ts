import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const token = request.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) {
      this.logger.warn('Request rejected — missing Authorization header');
      throw new UnauthorizedException('Authentication required');
    }
    try {
      const payload = this.jwt.verify(token) as Record<string, unknown>;
      (request as Request & { user: unknown }).user = payload;
      return true;
    } catch (err) {
      this.logger.warn(`Request rejected — invalid/expired JWT: ${err instanceof Error ? err.message : String(err)}`);
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
