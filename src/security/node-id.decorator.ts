import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { NODE_ID_KEY } from './mtls-node.guard';

/**
 * Extracts the verified nodeId placed on the request by MtlsNodeGuard.
 *
 * @example
 * @UseGuards(MtlsNodeGuard)
 * @Post('/heartbeat')
 * heartbeat(@NodeId() nodeId: string) { ... }
 */
export const NodeId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<Request & Record<string, unknown>>();
  return (request[NODE_ID_KEY] as string) ?? '';
});
