import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl } from 'class-validator';
import { NodesService } from './nodes.service';
import { AdminApiGuard } from '../security/admin-api.guard';

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
@UseGuards(AdminApiGuard)
@Controller('/nodes')
export class NodesController {
  constructor(private readonly nodes: NodesService) {}

  @Post('/enrollments')
  createEnrollment(@Body() dto: CreateEnrollmentDto) {
    return this.nodes.createEnrollment(dto.name, dto.publicUrl, dto.region, dto.site);
  }

  @Post('/register')
  register(@Body() dto: { nodeId: string; enrollmentToken: string; version: string; capacity?: Record<string, unknown> }) {
    return this.nodes.register(dto.nodeId, dto.enrollmentToken, dto.version, dto.capacity);
  }

  @Post('/heartbeat')
  heartbeat(@Body() dto: { nodeId: string; capacity?: Record<string, unknown> }) {
    return this.nodes.heartbeat(dto.nodeId, dto.capacity);
  }

  @Get()
  list() {
    return this.nodes.onlineNodes();
  }
}
