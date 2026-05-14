import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../security/current-user.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { MtlsNodeGuard } from '../security/mtls-node.guard';
import { NodeId } from '../security/node-id.decorator';
import { RbacGuard } from '../security/rbac.guard';
import { RequirePermission } from '../security/require-permission.decorator';
import { NodeMaintenanceState, NodeSignedEnvelope, User } from '../types';
import { NodeEnterpriseService } from './node-enterprise.service';
import { NodeTrustService } from './node-trust.service';

@ApiTags('node-trust-center')
@Controller()
export class NodeEnterpriseController {
  constructor(
    private readonly enterprise: NodeEnterpriseService,
    private readonly trust: NodeTrustService,
  ) {}

  @UseGuards(MtlsNodeGuard)
  @Post('/nodes/challenge/:purpose')
  challenge(@NodeId() nodeId: string, @Param('purpose') purpose: NodeSignedEnvelope['payloadType']) {
    return this.enterprise.issueChallenge(nodeId, purpose);
  }

  @UseGuards(MtlsNodeGuard)
  @Post('/nodes/health/signed')
  signedHealth(@NodeId() nodeId: string, @Body() envelope: NodeSignedEnvelope) {
    try {
      return this.enterprise.ingestHealth(nodeId, envelope as never);
    } catch (error) {
      this.penalizeEnvelopeFailure(nodeId, error);
      throw error;
    }
  }

  @UseGuards(MtlsNodeGuard)
  @Post('/nodes/probes/cross-node')
  crossNodeProbe(@NodeId() nodeId: string, @Body() envelope: NodeSignedEnvelope) {
    try {
      return this.enterprise.ingestCrossNodeProbe(nodeId, envelope as never);
    } catch (error) {
      this.penalizeEnvelopeFailure(nodeId, error);
      throw error;
    }
  }

  @UseGuards(MtlsNodeGuard)
  @Post('/nodes/cache/attestations')
  cacheAttestation(@NodeId() nodeId: string, @Body() envelope: NodeSignedEnvelope) {
    try {
      return this.enterprise.ingestCacheAttestation(nodeId, envelope as never);
    } catch (error) {
      this.penalizeEnvelopeFailure(nodeId, error);
      throw error;
    }
  }

  @UseGuards(MtlsNodeGuard)
  @Post('/nodes/update/attestations')
  versionAttestation(@NodeId() nodeId: string, @Body() envelope: NodeSignedEnvelope) {
    try {
      return this.enterprise.ingestVersionAttestation(nodeId, envelope as never);
    } catch (error) {
      this.penalizeEnvelopeFailure(nodeId, error);
      throw error;
    }
  }

  @UseGuards(MtlsNodeGuard)
  @Get('/nodes/update/campaign')
  updateCampaignForNode(@NodeId() nodeId: string) {
    return this.enterprise.signedUpdateForNode(nodeId);
  }

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('nodes:read')
  @Get('/nodes/trust-center')
  trustCenter() {
    return this.enterprise.trustCenter();
  }

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('nodes:read')
  @Get('/nodes/:nodeId/trust-center')
  detail(@Param('nodeId') nodeId: string) {
    return this.enterprise.nodeDetail(nodeId);
  }

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('nodes:manage')
  @Post('/nodes/:nodeId/quarantine/clear')
  clearQuarantine(@Param('nodeId') nodeId: string, @CurrentUser() user: User) {
    return this.enterprise.clearQuarantine(nodeId, user.id);
  }

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('nodes:manage')
  @Patch('/nodes/:nodeId/maintenance')
  maintenance(@Param('nodeId') nodeId: string, @Body() body: { state: NodeMaintenanceState; reason?: string }) {
    return this.enterprise.setMaintenance(nodeId, body.state, body.reason);
  }

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('nodes:manage')
  @Get('/nodes/update-campaigns')
  updateCampaigns() {
    return this.enterprise.listUpdateCampaigns();
  }

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('nodes:manage')
  @Post('/nodes/update-campaigns')
  createUpdateCampaign(@Body() body: {
    version: string;
    minVersion?: string;
    channel?: string;
    artifactUrl: string;
    sha256: string;
    signature: string;
    stagedPercent?: number;
    rollbackVersion?: string;
    status?: 'draft' | 'active' | 'paused';
  }, @CurrentUser() user: User) {
    return this.enterprise.createUpdateCampaign(body, user.id);
  }

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('nodes:manage')
  @Get('/nodes/routing-policy/:tenantId')
  getPolicy(@Param('tenantId') tenantId: string) {
    return this.enterprise.routingPolicy(tenantId);
  }

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('nodes:manage')
  @Patch('/nodes/routing-policy/:tenantId')
  setPolicy(@Param('tenantId') tenantId: string, @Body() body: Record<string, unknown>) {
    return this.enterprise.setRoutingPolicy(tenantId, body as never);
  }

  private penalizeEnvelopeFailure(nodeId: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const trigger = /nonce|replay|already been used/i.test(message) ? 'replay_attempt' : 'invalid_signature';
    this.trust.penalize(nodeId, trigger, message, 40);
  }
}
