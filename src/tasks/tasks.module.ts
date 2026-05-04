import { Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { NodesService } from '../nodes/nodes.service';
import { SigningService } from '../signing.service';
import { DragonflyService } from '../storage/dragonfly.service';
import { MemoryStore } from '../storage/memory.store';
import { PostgresService } from '../storage/postgres.service';
import { KillSwitchService } from './kill-switch.service';
import { NotificationService } from './notification.service';
import { SecurityGateService } from './security-gate.service';
import { MfaChallengeService } from '../auth/mfa-challenge.service';
import { TaskAuthorizationService } from './task-authorization.service';
import { TaskLedgerService } from './task-ledger.service';
import { TasksController } from './tasks.controller';
import { TenantPolicyService } from './tenant-policy.service';
import { VirusTotalService } from './virustotal.service';

@Module({
  controllers: [TasksController],
  providers: [
    DragonflyService,
    PostgresService,
    MemoryStore,
    AuditService,
    SigningService,
    NodesService,
    TenantPolicyService,
    SecurityGateService,
    VirusTotalService,
    TaskLedgerService,
    NotificationService,
    KillSwitchService,
    MfaChallengeService,
    TaskAuthorizationService,
  ],
  exports: [
    MfaChallengeService,
    TaskAuthorizationService,
    TaskLedgerService,
    KillSwitchService,
    TenantPolicyService,
    NotificationService,
  ],
})
export class TasksModule {}
