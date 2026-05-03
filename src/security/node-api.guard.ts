import { Injectable } from '@nestjs/common';
import { MtlsNodeGuard } from './mtls-node.guard';

/**
 * @deprecated Use MtlsNodeGuard directly.
 * This alias is kept so any remaining imports continue to compile during
 * migration.  All shared-secret logic has been removed — auth is purely
 * mTLS certificate-based via MtlsNodeGuard.
 */
@Injectable()
export class NodeApiGuard extends MtlsNodeGuard {}
