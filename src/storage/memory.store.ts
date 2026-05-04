import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { computeEventHash } from '../audit/audit.hash';
import {
  Alarm, AuditEvent, BackendNode, ClientEnrollment, Device,
  InstalledApp, KillSwitchState, PackageArtifact, PatchRule,
  TaskLedgerEntry, UpdateTask, User,
} from '../types';
import { DragonflyService } from './dragonfly.service';
import { normalizeSnapshot, PostgresService, StoreSnapshot } from './postgres.service';

@Injectable()
export class MemoryStore implements OnModuleInit {
  private readonly logger = new Logger(MemoryStore.name);
  private readonly snapshotKey = '1patch:management:snapshot:v1';

  constructor(
    private readonly dragonfly: DragonflyService,
    private readonly postgres: PostgresService,
  ) {}

  users: User[] = [];
  backendNodes: BackendNode[] = [];
  clientEnrollments: ClientEnrollment[] = [];
  devices: Device[] = [];
  installedApps: InstalledApp[] = [];
  packages: PackageArtifact[] = [];
  rules: PatchRule[] = [];
  tasks: UpdateTask[] = [];
  alarms: Alarm[] = [];
  auditEvents: AuditEvent[] = [];
  taskLedger: TaskLedgerEntry[] = [];
  killSwitchStates: KillSwitchState[] = [];

  async onModuleInit() {
    const loaded = (await this.postgres.loadSnapshot()) ?? (await this.loadDragonflySnapshot());
    if (!loaded) return;
    const snapshot = normalizeSnapshot({
      users: loaded.users ?? [],
      backendNodes: loaded.backendNodes ?? [],
      clientEnrollments: loaded.clientEnrollments ?? [],
      devices: loaded.devices ?? [],
      installedApps: loaded.installedApps ?? [],
      packages: loaded.packages ?? [],
      rules: loaded.rules ?? [],
      tasks: loaded.tasks ?? [],
      alarms: loaded.alarms ?? [],
      auditEvents: loaded.auditEvents ?? [],
      taskLedger: (loaded as any).taskLedger ?? [],
      killSwitchStates: (loaded as any).killSwitchStates ?? [],
    });
    this.users = snapshot.users;
    this.backendNodes = snapshot.backendNodes;
    this.clientEnrollments = snapshot.clientEnrollments;
    this.devices = snapshot.devices;
    this.installedApps = snapshot.installedApps;
    this.packages = snapshot.packages;
    this.rules = snapshot.rules;
    this.tasks = snapshot.tasks;
    this.alarms = snapshot.alarms;
    this.auditEvents = snapshot.auditEvents;
    this.taskLedger = (snapshot as any).taskLedger ?? [];
    this.killSwitchStates = (snapshot as any).killSwitchStates ?? [];
  }

  createAudit(event: Omit<AuditEvent, 'id' | 'createdAt' | 'previousEventHash' | 'eventHash'>) {
    // Hash chain: newest event is at index 0 (prepended), so chain runs reversed
    const previousEvent = this.auditEvents[0];
    const previousEventHash = previousEvent?.eventHash;

    const partial: Omit<AuditEvent, 'eventHash'> = {
      id: uuid(),
      createdAt: new Date().toISOString(),
      previousEventHash,
      ...event,
    };
    const eventHash = computeEventHash(partial, previousEventHash);
    const audit: AuditEvent = { ...partial, eventHash };

    this.auditEvents.unshift(audit);
    void this.persist();
    return audit;
  }

  async persist() {
    const snapshot = normalizeSnapshot({
      users: this.users,
      backendNodes: this.backendNodes,
      clientEnrollments: this.clientEnrollments,
      devices: this.devices,
      installedApps: this.installedApps,
      packages: this.packages,
      rules: this.rules,
      tasks: this.tasks,
      alarms: this.alarms,
      auditEvents: this.auditEvents,
      taskLedger: this.taskLedger,
      killSwitchStates: this.killSwitchStates,
    } as any);
    await this.postgres.saveSnapshot(snapshot);
    try {
      await this.dragonfly.setJson(this.snapshotKey, snapshot);
    } catch (error) {
      this.logger.warn(`Could not persist Dragonfly snapshot: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async loadDragonflySnapshot() {
    try {
      return await this.dragonfly.getJson<StoreSnapshot>(this.snapshotKey);
    } catch (error) {
      this.logger.warn(`Could not load Dragonfly snapshot: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
}
