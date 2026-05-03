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
}

@ApiTags('nodes')
@Controller('/nodes')
export class NodesController {
  constructor(private readonly nodes: NodesService) {}

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('nodes:enroll')
  @Post('/enrollments')
  createEnrollment(@Body() dto: CreateEnrollmentDto, @CurrentUser() user: User) {
    return this.nodes.createEnrollment(dto.name, dto.publicUrl, dto.region, dto.site, user.id);
  }

  /**
   * First-time registration — the ONLY endpoint that still accepts an enrollment token.
   * No mTLS guard here because the node does not yet have a certificate.
   * The enrollment token is one-time use with a 24 h TTL.
   */
  @Post('/register')
  register(@Body() dto: { nodeId: string; enrollmentToken: string; version: string; capacity?: Record<string, unknown> }) {
    return this.nodes.register(dto.nodeId, dto.enrollmentToken, dto.version, dto.capacity);
  }

  /**
   * Heartbeat — requires a valid Vault-issued mTLS client certificate.
   * The nodeId is read from the certificate CN, not the request body.
   * Capacity from the body is still accepted as informational.
   */
  @UseGuards(MtlsNodeGuard)
  @Post('/heartbeat')
  heartbeat(@NodeId() nodeId: string, @Body() dto: { capacity?: Record<string, unknown> }) {
    return this.nodes.heartbeat(nodeId, dto.capacity);
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

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('nodes:read')
  @Get()
  list() {
    return this.nodes.listNodes();
  }

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('nodes:manage')
  @Delete('/:nodeId')
  remove(@Param('nodeId') nodeId: string, @CurrentUser() user: User) {
    return this.nodes.removeNode(nodeId, user.id);
  }
}
