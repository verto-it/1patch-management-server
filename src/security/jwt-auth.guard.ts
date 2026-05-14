import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'crypto';
import { Request } from 'express';
import { DragonflyService } from '../storage/dragonfly.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  /**
   * Creates a JwtAuthGuard instance with its required collaborators.
   *
   * @param jwt jwt supplied to the function.
   * @param dragonfly dragonfly supplied to the function.
   */
  constructor(
    private readonly jwt: JwtService,
    private readonly dragonfly: DragonflyService,
  ) {}

  /**
   * Validates can activate rules, including checking the token revocation denylist.
   *
   * @param context context supplied to the function.
   * @returns The result produced by the operation.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = request.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) {
      this.logger.warn('Request rejected — missing Authorization header');
      throw new UnauthorizedException('Authentication required');
    }
    try {
      const payload = this.jwt.verify(token) as Record<string, unknown>;
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const revoked = await this.dragonfly.getJson<number>(`1patch:revoked-token:${tokenHash}`);
      if (revoked) {
        this.logger.warn(`Request rejected — token has been revoked (user logged out)`);
        throw new UnauthorizedException('Session has been revoked');
      }
      (request as Request & { user: unknown }).user = payload;
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      this.logger.warn(`Request rejected — invalid/expired JWT: ${err instanceof Error ? err.message : String(err)}`);
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
