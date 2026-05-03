import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';

/**
 * FIX #5: Authenticates requests that come from backend nodes (sync + agent endpoints).
 * Nodes must present their NODE_API_SECRET in the x-node-api-secret header.
 * The shared secret is set via the NODE_API_SECRET env var on both the management
 * server and every backend node.
 */
@Injectable()
export class NodeApiGuard implements CanActivate {
  private readonly logger = new Logger(NodeApiGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const configured = process.env.NODE_API_SECRET;

    if (!configured || configured.length < 32) {
      this.logger.error(
        'NODE_API_SECRET is not set or is less than 32 characters — ' +
        'all node-facing endpoints are locked. Set a strong shared secret.',
      );
      throw new UnauthorizedException('Node API is not configured on this server');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const supplied = request.header('x-node-api-secret');

    if (!supplied) {
      this.logger.warn(`Node request rejected — missing x-node-api-secret header (path=${request.path})`);
      throw new UnauthorizedException('Node API secret required');
    }

    const l = Buffer.from(supplied);
    const r = Buffer.from(configured);
    if (l.length !== r.length || !timingSafeEqual(l, r)) {
      this.logger.warn(`Node request rejected — invalid secret (path=${request.path})`);
      throw new UnauthorizedException('Invalid node API secret');
    }

    this.logger.debug(`Node request authorised (path=${request.path})`);
    return true;
  }
}
