import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { Alarm, AuditEvent, BackendNode, ClientEnrollment, Device, InstalledApp, PackageArtifact, PatchRule, UpdateTask, User } from '../types';
import { DragonflyService } from './dragonfly.service';
import { normalizeSnapshot, PostgresService, StoreSnapshot } from './postgres.service';

@Injectable()
export class MemoryStore implements OnModuleInit {
  private readonly logger = new Logger(MemoryStore.name);
  private readonly snapshotKey = '1patch:management:snapshot:v1';

  constructor(private readonly dragonfly: DragonflyService, private readonly postgres: PostgresService) {}

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

  async onModuleInit() {
    const loadedSnapshot = (await this.postgres.loadSnapshot()) ?? (await this.loadDragonflySnapshot());
    if (!loadedSnapshot) return;
    const snapshot = normalizeSnapshot({
      users: loadedSnapshot.users ?? [],
      backendNodes: loadedSnapshot.backendNodes ?? [],
      clientEnrollments: loadedSnapshot.clientEnrollments ?? [],
      devices: loadedSnapshot.devices ?? [],
      installedApps: loadedSnapshot.installedApps ?? [],
      packages: loadedSnapshot.packages ?? [],
      rules: loadedSnapshot.rules ?? [],
      tasks: loadedSnapshot.tasks ?? [],
      alarms: loadedSnapshot.alarms ?? [],
      auditEvents: loadedSnapshot.auditEvents ?? [],
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
  }

  createAudit(event: Omit<AuditEvent, 'id' | 'createdAt'>) {
    const audit = { id: uuid(), createdAt: new Date().toISOString(), ...event };
    this.auditEvents.unshift(audit);
    void this.persist();
    return audit;
  }

  async persist() {
    const snapshot: StoreSnapshot = normalizeSnapshot({
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
    });
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
