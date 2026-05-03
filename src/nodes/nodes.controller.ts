import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl } from 'class-validator';
import { NodesService } from './nodes.service';
import { CurrentUser } from '../security/current-user.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { NodeApiGuard } from '../security/node-api.guard';
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

  @UseGuards(NodeApiGuard)
  @Post('/register')
  register(@Body() dto: { nodeId: string; enrollmentToken: string; version: string; capacity?: Record<string, unknown> }) {
    return this.nodes.register(dto.nodeId, dto.enrollmentToken, dto.version, dto.capacity);
  }

  @UseGuards(NodeApiGuard)
  @Post('/heartbeat')
  heartbeat(@Body() dto: { nodeId: string; capacity?: Record<string, unknown> }) {
    return this.nodes.heartbeat(dto.nodeId, dto.capacity);
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
