import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl } from 'class-validator';
import { NodesService } from './nodes.service';
import { CurrentUser } from '../security/current-user.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { MtlsNodeGuard } from '../security/mtls-node.guard';
import { NodeId } from '../security/node-id.decorator';
import { RbacGuard } from '../security/rbac.guard';
import { RequirePermission } from '../security/require-permission.decorator';
import { User } from '../types';
import { NodeCapability } from '../types';

class CreateEnrollmentDto {
  @IsString()
  name!: string;

  @IsUrl({ require_tld: false })
  publicUrl!: string;

  @IsOptional()
  @IsString()
  region?: string;

  @IsOptional()
  @IsString()
  site?: string;

  @IsOptional()
  capabilities?: NodeCapability[];
}

@ApiTags('nodes')
@Controller('/nodes')
export class NodesController {
  /**
   * Creates a NodesController instance with its required collaborators.
   *
   * @param nodes nodes supplied to the function.
   */
  constructor(private readonly nodes: NodesService) {}

  /**
   * Creates a enrollment record.
   *
   * @param dto Request payload or data transfer object.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('nodes:enroll')
  @Post('/enrollments')
  createEnrollment(@Body() dto: CreateEnrollmentDto, @CurrentUser() user: User) {
    return this.nodes.createEnrollment(dto.name, dto.publicUrl, dto.region, dto.site, user.id, dto.capabilities);
  }


  /**
   * Re-issues a fresh one-time enrollment token for a node that has already
   * registered but lost its mTLS certificate (e.g. disk wipe, container rebuild).
   * The node must then call /nodes/register again with the new token to receive
   * a fresh Vault mTLS certificate.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('nodes:enroll')
  @Post('/:nodeId/re-enroll')
  reEnroll(@Param('nodeId') nodeId: string, @CurrentUser() user: User) {
    return this.nodes.reEnroll(nodeId, user.id);
  }

  /**
   * First-time registration — the ONLY endpoint that still accepts an enrollment token.
   * No mTLS guard here because the node does not yet have a certificate.
   * The enrollment token is one-time use with a 24 h TTL.
   */
  @Post('/register')
  register(@Body() dto: { nodeId: string; enrollmentToken: string; version: string; capacity?: Record<string, unknown>; capabilities?: NodeCapability[]; signingPublicKeyPem?: string; publicUrl?: string; region?: string; site?: string; updateChannel?: string }) {
    return this.nodes.register(dto.nodeId, dto.enrollmentToken, dto.version, dto.capacity, {
      capabilities: dto.capabilities,
      signingPublicKeyPem: dto.signingPublicKeyPem,
      publicUrl: dto.publicUrl,
      region: dto.region,
      site: dto.site,
      updateChannel: dto.updateChannel,
    });
  }

  /**
   * Heartbeat — requires a valid Vault-issued mTLS client certificate.
   * The nodeId is read from the certificate CN, not the request body.
   * Capacity from the body is still accepted as informational.
   */
  @UseGuards(MtlsNodeGuard)
  @Post('/heartbeat')
  heartbeat(@NodeId() nodeId: string, @Body() dto: { capacity?: Record<string, unknown>; signingPublicKeyPem?: string }) {
    return this.nodes.heartbeat(nodeId, dto.capacity, dto.signingPublicKeyPem);
  }

  /**
   * Certificate renewal — called by a node before its current cert expires.
   * Requires the current (still-valid) mTLS cert — no token needed.
   * Issues a fresh 24 h cert and revokes the old one.
   */
  @UseGuards(MtlsNodeGuard)
  @Post('/renew-cert')
  renewCert(@NodeId() nodeId: string) {
    return this.nodes.renewCert(nodeId);
  }

  /**
   * Lists list records for the caller.
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('nodes:read')
  @Get()
  list() {
    return this.nodes.listNodes();
  }

  /**
   * Removes the remove record or state.
   *
   * @param nodeId Identifier used to locate the target record.
   * @param user user supplied to the function.
   * @returns The result produced by the operation.
   */
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('nodes:manage')
  @Delete('/:nodeId')
  remove(@Param('nodeId') nodeId: string, @CurrentUser() user: User) {
    return this.nodes.removeNode(nodeId, user.id);
  }
}
