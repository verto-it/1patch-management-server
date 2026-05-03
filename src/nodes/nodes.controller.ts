import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl } from 'class-validator';
import { NodesService } from './nodes.service';
import { AdminApiGuard } from '../security/admin-api.guard';
import { NodeApiGuard } from '../security/node-api.guard';

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

  @UseGuards(AdminApiGuard)
  @Post('/enrollments')
  createEnrollment(@Body() dto: CreateEnrollmentDto) {
    return this.nodes.createEnrollment(dto.name, dto.publicUrl, dto.region, dto.site);
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

  @UseGuards(AdminApiGuard)
  @Get()
  list() {
    return this.nodes.listNodes();
  }

  @UseGuards(AdminApiGuard)
  @Delete('/:nodeId')
  remove(@Param('nodeId') nodeId: string) {
    return this.nodes.removeNode(nodeId);
  }
}
