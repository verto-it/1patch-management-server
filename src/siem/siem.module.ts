// AGPL-3.0-only
import { Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DragonflyService } from '../storage/dragonfly.service';
import { MemoryStore } from '../storage/memory.store';
import { PostgresService } from '../storage/postgres.service';
import { SiemConfigService } from './siem-config.service';
import { SiemController } from './siem.controller';
import { SiemEventService } from './siem-event.service';
import { SiemPipelineWorker } from './siem-pipeline.worker';

@Module({
  controllers: [SiemController],
  providers: [
    DragonflyService,
    SiemEventService,
    SiemConfigService,
    SiemPipelineWorker,
    AuditService,
    MemoryStore,
    PostgresService,
  ],
  exports: [SiemEventService, SiemConfigService],
})
export class SiemModule {}
