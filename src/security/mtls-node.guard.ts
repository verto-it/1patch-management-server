import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { Request } from "express";
import { TLSSocket } from "tls";

/**
 * Key under which the verified nodeId is stored on the request object after this guard runs.
 * Use the @NodeId() decorator to read it in a controller handler.
 */
export const NODE_ID_KEY = "mtlsNodeId";

/**
 * Guard for all node-facing management endpoints.
 *
 * Production (mTLS enabled):
 *   Verifies that the HTTP client presented a TLS client certificate signed by the
 *   internal Vault CA.  Extracts the nodeId from the certificate CN
 *   (<nodeId>.1patch.internal) and attaches it to the request as req[NODE_ID_KEY].
 *   Rejects with 401 if:
 *     - no client certificate was presented
 *     - the certificate was not signed by the trusted CA (socket.authorized === false)
 *     - the CN does not match the expected pattern
 *
 * Development (MTLS_DISABLED=true AND NODE_ENV != production):
 *   Falls back to reading nodeId from the request body (body.nodeId) or the
 *   x-node-id header, and logs a warning.
 *   BOTH conditions must be true. NODE_ENV alone is insufficient — a staging or
 *   demo deployment reachable from the internet must not silently accept
 *   header-based node identity.
 *
 * NODE_API_SECRET is intentionally NOT read by this guard.
 */
@Injectable()
export class MtlsNodeGuard implements CanActivate {
  private readonly logger = new Logger(MtlsNodeGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const socket = request.socket as TLSSocket;

    
    // Plain HTTP (no TLS socket)
    if (typeof socket.getPeerCertificate !== "function") {
      // Require BOTH non-production NODE_ENV AND explicit MTLS_DISABLED=true.
      // NODE_ENV alone is not sufficient — a staging or demo deployment that is
      // reachable from the internet must not silently accept header-based identity.
      const devBypassAllowed =
        process.env.NODE_ENV !== "production" && process.env.MTLS_DISABLED === "true";

      if (!devBypassAllowed) {
        this.logger.error(
          `Node endpoint called over plain HTTP — rejecting. ` +
          `Configure TLS_CERT_PATH / TLS_KEY_PATH / TLS_CA_PATH for mTLS, ` +
          `or set MTLS_DISABLED=true for local dev only. path=${request.path}`,
        );
        throw new UnauthorizedException("mTLS client certificate required");
      }
      const devNodeId = this.devNodeId(request);
      this.logger.warn(
        `[DEV] mTLS bypassed (MTLS_DISABLED=true) — synthetic nodeId="${devNodeId}" path=${request.path}. ` +
        `Never set MTLS_DISABLED=true in production or any internet-reachable environment.`,
      );
      (request as unknown as Record<string, unknown>)[NODE_ID_KEY] = devNodeId;
      return true;
    }

    // Certificate present?
    const cert = socket.getPeerCertificate(true);
    const subject = cert?.subject as Record<string, string> | undefined;

    if (!subject || Object.keys(subject).length === 0) {
      this.logger.warn(`Node request rejected — no client certificate presented (path=${request.path})`);
      throw new UnauthorizedException("Client certificate required");
    }

    // Certificate trusted?
    if (!socket.authorized) {
      const reason = (socket as TLSSocket & { authorizationError?: string }).authorizationError ?? "unknown";
      this.logger.warn(
        `Node request rejected — certificate not trusted by Vault CA: ${reason} (path=${request.path})`,
      );
      throw new UnauthorizedException("Client certificate not trusted — must be signed by the Vault CA");
    }

    // Extract nodeId from CN
    const cn: string = subject.CN ?? "";
    const nodeId = extractNodeId(cn);

    if (!nodeId) {
      this.logger.warn(
        `Node request rejected — CN "${cn}" does not match "<nodeId>.1patch.internal" (path=${request.path})`,
      );
      throw new UnauthorizedException("Certificate common name is invalid");
    }

    (request as unknown as Record<string, unknown>)[NODE_ID_KEY] = nodeId;
    this.logger.debug(`mTLS node authorised nodeId=${nodeId} path=${request.path}`);
    return true;
  }

  /** Dev-mode only: synthesises a nodeId from the request body or header. */
  private devNodeId(request: Request): string {
    const body = request.body as Record<string, unknown> | undefined;
    const fromBody = typeof body?.nodeId === "string" ? body.nodeId : undefined;
    return fromBody ?? request.header("x-node-id") ?? "dev-node";
  }
}

/** Vault-issued certificate CNs have the form <nodeId>.1patch.internal. */
const CN_SUFFIX = ".1patch.internal";

/**
 * Extracts the nodeId from a Vault-issued CN.
 * Returns undefined if the CN does not match the expected pattern.
 */
export function extractNodeId(cn: string): string | undefined {
  if (!cn.endsWith(CN_SUFFIX)) return undefined;
  const id = cn.slice(0, cn.length - CN_SUFFIX.length);
  return id.length > 0 ? id : undefined;
}
