import { Injectable, OnModuleInit } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { Alarm, AuditEvent, BackendNode, Device, InstalledApp, PackageArtifact, PatchRule, UpdateTask, User } from '../types';
import { DragonflyService } from './dragonfly.service';
import { PostgresService, StoreSnapshot } from './postgres.service';

@Injectable()
export class MemoryStore implements OnModuleInit {
  private readonly snapshotKey = '1patch:management:snapshot:v1';

  constructor(private readonly dragonfly: DragonflyService, private readonly postgres: PostgresService) {}

  users: User[] = [];
  backendNodes: BackendNode[] = [];
  devices: Device[] = [];
  installedApps: InstalledApp[] = [];
  packages: PackageArtifact[] = [];
  rules: PatchRule[] = [];
  tasks: UpdateTask[] = [];
  alarms: Alarm[] = [];
  auditEvents: AuditEvent[] = [];

  async onModuleInit() {
    const snapshot = (await this.postgres.loadSnapshot()) ?? (await this.dragonfly.getJson<StoreSnapshot>(this.snapshotKey));
    if (!snapshot) return;
    this.users = snapshot.users ?? [];
    this.backendNodes = snapshot.backendNodes ?? [];
    this.devices = snapshot.devices ?? [];
    this.installedApps = snapshot.installedApps ?? [];
    this.packages = snapshot.packages ?? [];
    this.rules = snapshot.rules ?? [];
    this.tasks = snapshot.tasks ?? [];
    this.alarms = snapshot.alarms ?? [];
    this.auditEvents = snapshot.auditEvents ?? [];
  }

  createAudit(event: Omit<AuditEvent, 'id' | 'createdAt'>) {
    const audit = { id: uuid(), createdAt: new Date().toISOString(), ...event };
    this.auditEvents.unshift(audit);
    void this.persist();
    return audit;
  }

  async persist() {
    const snapshot: StoreSnapshot = {
      users: this.users,
      backendNodes: this.backendNodes,
      devices: this.devices,
      installedApps: this.installedApps,
      packages: this.packages,
      rules: this.rules,
      tasks: this.tasks,
      alarms: this.alarms,
      auditEvents: this.auditEvents,
    };
    await this.postgres.saveSnapshot(snapshot);
    await this.dragonfly.setJson(this.snapshotKey, snapshot);
  }
}
