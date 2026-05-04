// AGPL-3.0-only
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { v4 as uuid } from 'uuid';
import { CurrentUser } from '../security/current-user.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { RbacGuard } from '../security/rbac.guard';
import { RequirePermission } from '../security/require-permission.decorator';
import { SiemConfig, User } from '../types';
import { SiemConfigService } from './siem-config.service';
import { SiemEventService } from './siem-event.service';
import { SiemPipelineWorker } from './siem-pipeline.worker';
import { AuditService } from '../audit/audit.service';

@ApiTags('siem')
@Controller('/siem')
@UseGuards(JwtAuthGuard, RbacGuard)
export class SiemController {
  constructor(
    private readonly configs: SiemConfigService,
    private readonly eventService: SiemEventService,
    private readonly worker: SiemPipelineWorker,
    private readonly audit: AuditService,
  ) {}

  // ── Config CRUD ────────────────────────────────────────────────────────────

  @RequirePermission('tasks:manage')
  @Get('/config')
  listConfigs() {
    return this.configs.listAll();
  }

  @RequirePermission('tasks:manage')
  @Get('/config/:tenantId')
  async getConfig(@Param('tenantId') tenantId: string) {
    const config = await this.configs.get(tenantId);
    if (!config) throw new BadRequestException(`No SIEM config for tenant ${tenantId}`);
    return { tenantId, config };
  }

  @RequirePermission('tasks:sign')
  @Put('/config/:tenantId')
  async setConfig(
    @Param('tenantId') tenantId: string,
    @Body() body: SiemConfig,
    @CurrentUser() user: User,
  ) {
    const result = await this.configs.set(tenantId, body);
    this.audit.record(user.id, 'siem.config.updated', tenantId, { mode: body.mode }, tenantId);
    return result;
  }

  @RequirePermission('tasks:sign')
  @Delete('/config/:tenantId')
  async deleteConfig(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: User,
  ) {
    await this.configs.delete(tenantId);
    this.audit.record(user.id, 'siem.config.deleted', tenantId, {}, tenantId);
    return { deleted: true, tenantId };
  }

  // ── Health ──────────────────────────────────────────────────────────────────

  @RequirePermission('audit:read')
  @Get('/health')
  listHealth() {
    return this.configs.listAllHealth();
  }

  @RequirePermission('audit:read')
  @Get('/health/:tenantId')
  async getHealth(@Param('tenantId') tenantId: string) {
    return this.configs.getHealth(tenantId);
  }

  // ── Test ────────────────────────────────────────────────────────────────────

  /**
   * Wizard test endpoint — send a test event using config supplied in the request
   * body without requiring the config to be saved first.
   */
  @RequirePermission('tasks:manage')
  @Post('/test')
  async testWithConfig(
    @Body() body: { tenantId: string; config: SiemConfig },
    @CurrentUser() user: User,
  ) {
    const { tenantId, config } = body;
    if (!tenantId || !config) {
      throw new BadRequestException('tenantId and config are required');
    }

    const testEvent = buildTestEvent(tenantId, user.id);
    const exporters = this.worker.buildExporters(config);
    if (exporters.length === 0) {
      return { sent: false, reason: 'No exporters configured in the provided config' };
    }

    const results: Array<{ exporter: string; ok: boolean; error?: string }> = [];
    for (const exporter of exporters) {
      try {
        await exporter.send([testEvent]);
        results.push({ exporter: exporter.name, ok: true });
      } catch (err) {
        results.push({ exporter: exporter.name, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    this.audit.record(user.id, 'siem.test_sent', tenantId, { results, unsaved: true }, tenantId);
    return { sent: true, eventId: testEvent.eventId, results };
  }

  /**
   * Test using already-saved config for a tenant.
   */
  @RequirePermission('tasks:manage')
  @Post('/test/:tenantId')
  async testSaved(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: User,
  ) {
    const config = await this.configs.get(tenantId);
    if (!config) throw new BadRequestException(`No SIEM config for tenant ${tenantId}`);

    const testEvent = buildTestEvent(tenantId, user.id);
    const exporters = this.worker.buildExporters(config);
    if (exporters.length === 0) {
      return { sent: false, reason: 'No exporters configured for this tenant' };
    }

    const results: Array<{ exporter: string; ok: boolean; error?: string }> = [];
    for (const exporter of exporters) {
      try {
        await exporter.send([testEvent]);
        results.push({ exporter: exporter.name, ok: true });
      } catch (err) {
        results.push({ exporter: exporter.name, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    this.audit.record(user.id, 'siem.test_sent', tenantId, { results }, tenantId);
    return { sent: true, eventId: testEvent.eventId, results };
  }

  // ── Verify ──────────────────────────────────────────────────────────────────

  @RequirePermission('tasks:manage')
  @Post('/verify/:tenantId')
  async verify(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: User,
  ) {
    const config = await this.configs.get(tenantId);
    if (!config) throw new BadRequestException(`No SIEM config for tenant ${tenantId}`);

    const exporters = this.worker.buildExporters(config);
    const results: Array<{ exporter: string; ok: boolean; message: string }> = [];

    for (const exporter of exporters) {
      if (exporter.verify) {
        const r = await exporter.verify().catch((err) => ({
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        }));
        results.push({ exporter: exporter.name, ...r });
      } else {
        results.push({ exporter: exporter.name, ok: true, message: 'No verify method — assumed reachable' });
      }
    }

    this.audit.record(user.id, 'siem.verify_run', tenantId, { results }, tenantId);
    return { tenantId, results };
  }

  // ── Queue status ────────────────────────────────────────────────────────────

  @RequirePermission('audit:read')
  @Get('/queue/status')
  async queueStatus() {
    const depth = await this.eventService.queueDepth();
    return { queueDepth: depth };
  }

  @RequirePermission('audit:read')
  @Get('/queue/dlq')
  async deadLetterQueue() {
    const events = await this.eventService.getDeadLetterQueue();
    return { count: events.length, events };
  }

  // ── Manual flush ────────────────────────────────────────────────────────────

  @RequirePermission('tasks:sign')
  @Post('/queue/flush')
  async manualFlush(@CurrentUser() user: User) {
    await this.worker.flush();
    this.audit.record(user.id, 'siem.queue.manual_flush', 'system');
    return { flushed: true };
  }
}

function buildTestEvent(tenantId: string, userId: string) {
  return {
    eventId: uuid(),
    timestamp: new Date().toISOString(),
    tenantId,
    type: 'siem.test' as const,
    severity: 'low' as const,
    actor: { userId, nodeId: null, ip: null },
    target: { taskId: null, deviceId: null, nodeId: null },
    metadata: {
      message: '1Patch SIEM integration working',
      source: '1patch-siem-test',
    },
    correlationId: null,
  };
}
