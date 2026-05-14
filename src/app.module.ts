// AGPL-3.0-only
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AppController } from './app.controller';
import { AuditService } from './audit/audit.service';
import { AppsController } from './apps/apps.controller';
import { AdminController } from './admin/admin.controller';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AgentController } from './agent/agent.controller';
import { AlarmsController } from './alarms.controller';
import { AuditController } from './audit.controller';
import { DashboardController } from './dashboard.controller';
import { DashboardHistoryController } from './dashboard-history.controller';
import { DashboardUiController } from './dashboard-ui.controller';
import { DevicesController } from './devices.controller';
import { NodesController } from './nodes/nodes.controller';
import { NodeEnterpriseController } from './nodes/node-enterprise.controller';
import { NodeCryptoService } from './nodes/node-crypto.service';
import { NodeEnterpriseService } from './nodes/node-enterprise.service';
import { NodeRoutingService } from './nodes/node-routing.service';
import { NodeTrustService } from './nodes/node-trust.service';
import { NodesService } from './nodes/nodes.service';
import { PackagesController } from './packages.controller';
import { RbacService } from './rbac/rbac.service';
import { RulesController } from './rules/rules.controller';
import { RulesService } from './rules/rules.service';
import { RuleTemplatesController } from './rules/rule-templates.controller';
import { RuleTemplatesService } from './rules/rule-templates.service';
import { SetupController } from './setup.controller';
import { SigningService } from './signing.service';
import { VaultPkiService } from './vault/vault-pki.service';
import { JwtAuthGuard } from './security/jwt-auth.guard';
import { MtlsNodeGuard } from './security/mtls-node.guard';
import { NodeOrJwtGuard } from './security/node-or-jwt.guard';
import { RbacGuard } from './security/rbac.guard';
import { DragonflyService } from './storage/dragonfly.service';
import { MemoryStore } from './storage/memory.store';
import { PostgresService } from './storage/postgres.service';
// Legacy top-level tasks controller is replaced by the tasks module
import { KillSwitchService } from './tasks/kill-switch.service';
import { FileReputationService } from './tasks/file-reputation.service';
import { NotificationService } from './tasks/notification.service';
import { SecurityGateService } from './tasks/security-gate.service';
import { TaskAuthorizationService } from './tasks/task-authorization.service';
import { TaskLedgerService } from './tasks/task-ledger.service';
import { TasksController } from './tasks/tasks.controller';
import { TenantPolicyService } from './tasks/tenant-policy.service';
import { VirusTotalService } from './tasks/virustotal.service';
import { SiemConfigService } from './siem/siem-config.service';
import { SiemController } from './siem/siem.controller';
import { SiemEventService } from './siem/siem-event.service';
import { SiemPipelineWorker } from './siem/siem-pipeline.worker';
import { MfaChallengeService } from './auth/mfa-challenge.service';
import { SsoController } from './auth/sso.controller';
import { SsoService } from './auth/sso.service';
import { SecurityPostureController } from './security-posture/security-posture.controller';
import { SecurityPostureService } from './security-posture/security-posture.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? '',
      signOptions: { expiresIn: '8h' },
    }),
  ],
  controllers: [
    AppController, AuthController, AdminController, NodesController, NodeEnterpriseController, AgentController,
    AppsController, RulesController, RuleTemplatesController, DevicesController, DashboardController,
    DashboardHistoryController, AlarmsController, AuditController, SiemController, SecurityPostureController,
    DashboardUiController, TasksController, SetupController, PackagesController,
    SsoController,
  ],
  providers: [
    DragonflyService, PostgresService, MemoryStore,
    AuditService, AuthService, RbacService, NodesService, NodeCryptoService, NodeEnterpriseService, NodeRoutingService, NodeTrustService, SigningService,
    JwtAuthGuard, RbacGuard, MtlsNodeGuard, NodeOrJwtGuard,
    VaultPkiService,
    // Task authorization pipeline
    TenantPolicyService,
    FileReputationService,
    SecurityGateService,
    VirusTotalService,
    TaskLedgerService,
    NotificationService,
    KillSwitchService,
    TaskAuthorizationService,
    SiemConfigService,
    SiemEventService,
    SiemPipelineWorker,
    SecurityPostureService,
    RulesService,
    RuleTemplatesService,
    MfaChallengeService,
    SsoService,
  ],
})
export class AppModule {}
