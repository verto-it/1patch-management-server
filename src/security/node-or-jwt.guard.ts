import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { TLSSocket } from 'tls';
import { NODE_ID_KEY, extractNodeId } from './mtls-node.guard';

/**
 * Accepts requests from either:
 *  1. An authenticated backend node presenting a valid Vault-issued mTLS certificate, OR
 *  2. A user with a valid JWT (admin/operator managing nodes via the dashboard).
 *
 * NODE_API_SECRET is intentionally NOT accepted — all node authentication is
 * certificate-based.  The JWT path is for human operators only.
 */
@Injectable()
export class NodeOrJwtGuard implements CanActivate {
  private readonly logger = new Logger(NodeOrJwtGuard.name);

  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (this.tryMtls(request)) {
      this.logger.debug(`mTLS node request authorised (path=${request.path})`);
      return true;
    }

    
    if (this.tryJwt(request)) {
      this.logger.debug(`JWT user request authorised (path=${request.path})`);
      return true;
    }

    this.logger.warn(`Request rejected — valid mTLS certificate or JWT required (path=${request.path})`);
    throw new UnauthorizedException('Valid mTLS client certificate or authenticated user JWT required');
  }

  private tryJwt(request: Request): boolean {
    const supplied = request.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!supplied) return false;
    try {
      this.jwt.verify(supplied);
      return true;
    } catch {
      return false;
    }
  }

  /** Returns true and attaches NODE_ID_KEY to the request when the mTLS cert is valid. */
  private tryMtls(request: Request): boolean {
    const socket = request.socket as TLSSocket;
    if (typeof socket.getPeerCertificate !== 'function') return false;

    const cert = socket.getPeerCertificate(true);
    const subject = cert?.subject as Record<string, string> | undefined;
    if (!subject || Object.keys(subject).length === 0) return false;
    if (!socket.authorized) return false;

    const cn: string = subject.CN ?? '';
    const nodeId = extractNodeId(cn);
    if (!nodeId) return false;

    (request as unknown as Record<string, unknown>)[NODE_ID_KEY] = nodeId;
    return true;
  }
}
