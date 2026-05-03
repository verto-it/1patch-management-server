
// AGPL-3.0-only — replacement for src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AppController } from './app.controller';
import { AuditService } from './audit/audit.service';
import { AppsController } from './apps/apps.controller';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AgentController } from './agent/agent.controller';
import { DashboardController } from './dashboard.controller';
import { DashboardUiController } from './dashboard-ui.controller';
import { DashboardHistoryController } from './dashboard-history.controller';
import { AlarmsController } from './alarms.controller';
import { AuditController } from './audit.controller';
import { DevicesController } from './devices.controller';
import { NodesController } from './nodes/nodes.controller';
import { PackagesController } from './packages.controller';
import { NodesService } from './nodes/nodes.service';
import { RbacService } from './rbac/rbac.service';
import { RulesController } from './rules/rules.controller';
import { SigningService } from './signing.service';
import { VaultPkiService } from './vault/vault-pki.service';
import { AdminApiGuard } from './security/admin-api.guard';
import { JwtAuthGuard } from './security/jwt-auth.guard';
import { DragonflyService } from './storage/dragonfly.service';
import { MemoryStore } from './storage/memory.store';
import { PostgresService } from './storage/postgres.service';
import { TasksController } from './tasks.controller';
import { SetupController } from './setup.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? '',
      signOptions: { expiresIn: '8h' },
    }),
  ],
  controllers: [
    AppController, AuthController, NodesController, AgentController,
    AppsController, RulesController, DevicesController, DashboardController,
    DashboardHistoryController, AlarmsController, AuditController,
    DashboardUiController, TasksController, SetupController, PackagesController,
  ],
  providers: [
    DragonflyService, PostgresService, MemoryStore,
    AuditService, AuthService, RbacService, NodesService, SigningService,
    AdminApiGuard, JwtAuthGuard,
    VaultPkiService,
  ],
})
export class AppModule {}
