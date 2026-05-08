import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { NodesService } from '../nodes/nodes.service';
import { SiemEventService } from '../siem/siem-event.service';
import { MemoryStore } from '../storage/memory.store';
import {
  Device,
  InstalledApp,
  PatchRule,
  RuleAction,
  RuleCondition,
  RuleConditionGroup,
  RuleExecutionRecord,
  RuleTrigger,
  UpdateTask,
  User,
} from '../types';
import { TaskAuthorizationService } from '../tasks/task-authorization.service';

const DEFAULT_MAX_TASKS_PER_RULE_PER_HOUR = 50;
const DEFAULT_MAX_DEVICES_PER_EXECUTION = 25;
const ACTIVE_TASK_STATUSES = new Set(['draft', 'security_scanned', 'mfa_approved', 'signed', 'scheduled', 'executable', 'pending', 'dispatched']);

export interface RuleSimulationResult {
  ruleId: string;
  deviceId?: string;
  wouldTrigger: boolean;
  reasons: string[];
  actions: Array<{ action: RuleAction; taskDrafts: Array<Partial<UpdateTask>>; notification?: string; tag?: string }>;
  riskScore: number;
  conflicts: string[];
  rateLimited: boolean;
  approvalRequired: boolean;
}

@Injectable()
export class RulesService {
  private readonly logger = new Logger(RulesService.name);

  constructor(
    private readonly store: MemoryStore,
    private readonly audit: AuditService,
    private readonly siem: SiemEventService,
    private readonly nodes: NodesService,
    private readonly tasks: TaskAuthorizationService,
  ) {}

  list() {
    return this.store.rules.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  create(input: Partial<PatchRule>, actor: User): PatchRule {
    const rule = normalizeRule(input, actor);
    this.validateRule(rule);
    this.store.rules.push(rule);
    void this.store.persist();
    this.audit.record(actor.id, 'rule.created', rule.id, rule as unknown as Record<string, unknown>, rule.tenantId);
    this.siem.emit({
      tenantId: rule.tenantId ?? 'default',
      type: 'rule.triggered',
      severity: 'low',
      actor: { userId: actor.id },
      metadata: { ruleId: rule.id, lifecycle: 'created' },
    });
    if (rule.sourceTemplateId) {
      this.audit.record(actor.id, 'rule.created_from_template', rule.id, {
        templateId: rule.sourceTemplateId,
        templateName: rule.sourceTemplateName,
        enabled: rule.enabled,
      }, rule.tenantId);
      this.siem.emit({
        tenantId: rule.tenantId ?? 'default',
        type: 'rule.created_from_template',
        severity: 'low',
        actor: { userId: actor.id },
        metadata: { ruleId: rule.id, templateId: rule.sourceTemplateId, enabled: rule.enabled },
      });
    }
    return rule;
  }

  update(id: string, patch: Partial<PatchRule>, actor: User): PatchRule {
    const rule = this.requireRule(id);
    const next = normalizeRule({ ...rule, ...patch, id: rule.id, createdAt: rule.createdAt, createdBy: rule.createdBy }, actor);
    this.validateRule(next);
    Object.assign(rule, next);
    void this.store.persist();
    this.audit.record(actor.id, 'rule.updated', id, { patch }, rule.tenantId);
    return rule;
  }

  async trigger(id: string, actor: User, deviceId?: string) {
    const rule = this.requireRule(id);
    return this.executeRule(rule, actor, { type: 'manual' }, deviceId);
  }

  async triggerEvent(eventType: NonNullable<RuleTrigger['eventType']>, actor: User, deviceId?: string) {
    const rules = this.list().filter((rule) => rule.enabled && rule.trigger?.type === 'event' && rule.trigger.eventType === eventType);
    const records: RuleExecutionRecord[] = [];
    for (const rule of rules) {
      records.push(...await this.executeRule(rule, actor, { type: 'event', eventType }, deviceId));
    }
    return { eventType, records };
  }

  simulate(ruleId: string, deviceId?: string): RuleSimulationResult {
    const rule = this.requireRule(ruleId);
    const device = this.resolveDevice(rule, deviceId);
    return this.simulateForDevice(rule, device);
  }

  auditLog(ruleId?: string) {
    const rules = ruleId ? [this.requireRule(ruleId)] : this.store.rules;
    return rules.flatMap((rule) => rule.executionStats?.executionLog ?? [])
      .sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt));
  }

  private async executeRule(rule: PatchRule, actor: User, trigger: RuleTrigger, deviceId?: string) {
    if (!rule.enabled) throw new BadRequestException('Rule is disabled');
    this.validateRule(rule);
    const devices = deviceId ? [this.resolveDevice(rule, deviceId)] : this.devicesForRule(rule);
    const maxDevices = ruleMaxDevices(rule);
    const selectedDevices = devices.slice(0, maxDevices);
    const records: RuleExecutionRecord[] = [];
    let affectedDevices = 0;

    this.audit.record(actor.id, 'rule.triggered', rule.id, { trigger, deviceCount: selectedDevices.length }, rule.tenantId);
    this.siem.emit({ tenantId: rule.tenantId ?? 'default', type: 'rule.triggered', severity: 'low', actor: { userId: actor.id }, metadata: { ruleId: rule.id, trigger } });

    if (devices.length > maxDevices) {
      this.logRuleEvent(rule, 'rule.conflict_detected', 'medium', actor, { reason: 'max_devices_exceeded', requested: devices.length, allowed: maxDevices });
    }

    for (const device of selectedDevices) {
      const simulation = this.simulateForDevice(rule, device);
      const taskIds: string[] = [];
      let status: RuleExecutionRecord['status'] = simulation.wouldTrigger ? 'matched' : 'skipped';
      let failure: string | undefined;
      if (simulation.wouldTrigger && !simulation.rateLimited) {
        try {
          for (const action of rule.actions ?? []) {
            const created = await this.applyAction(rule, action, device, actor, simulation);
            taskIds.push(...created.map((task) => task.id));
          }
          affectedDevices += taskIds.length > 0 ? 1 : 0;
        } catch (err) {
          status = 'failed';
          failure = err instanceof Error ? err.message : String(err);
          simulation.reasons.push(failure);
          this.logRuleEvent(rule, 'rule.failed', 'high', actor, { deviceId: device.id, error: failure });
        }
      } else if (simulation.rateLimited) {
        this.logRuleEvent(rule, 'rule.rate_limited', 'medium', actor, { deviceId: device.id, riskScore: simulation.riskScore });
      }

      const record: RuleExecutionRecord = {
        id: uuid(),
        ruleId: rule.id,
        tenantId: rule.tenantId ?? device.tenantId ?? 'default',
        triggeredAt: new Date().toISOString(),
        triggeredBy: actor.id,
        matched: simulation.wouldTrigger,
        deviceId: device.id,
        taskIds,
        riskScore: simulation.riskScore,
        reasons: simulation.reasons,
        conflicts: simulation.conflicts,
        approvalRequired: simulation.approvalRequired,
        rateLimited: simulation.rateLimited,
        status,
      };
      records.push(record);
      appendExecution(rule, record);
    }

    rule.lastRunAt = new Date().toISOString();
    void this.store.persist();
    this.audit.record(actor.id, 'rule.executed', rule.id, { affectedDevices, records: records.length }, rule.tenantId);
    this.siem.emit({ tenantId: rule.tenantId ?? 'default', type: 'rule.executed', severity: 'low', actor: { userId: actor.id }, metadata: { ruleId: rule.id, affectedDevices, records: records.length } });
    return records;
  }

  private async applyAction(rule: PatchRule, action: RuleAction, device: Device, actor: User, simulation: RuleSimulationResult): Promise<UpdateTask[]> {
    if (action.type === 'notify') {
      if (action.channel === 'siem') {
        this.siem.emit({
          tenantId: rule.tenantId ?? device.tenantId ?? 'default',
          type: 'rule.executed',
          severity: simulation.riskScore >= 70 ? 'high' : 'low',
          actor: { userId: actor.id },
          target: { deviceId: device.id },
          metadata: { ruleId: rule.id, message: action.message },
        });
      }
      return [];
    }

    if (action.type === 'mark_device') {
      const tags = new Set(device.tags ?? []);
      tags.add(action.tag);
      device.tags = [...tags].sort();
      this.audit.record(actor.id, 'rule.device_marked', device.id, { ruleId: rule.id, tag: action.tag }, device.tenantId);
      return [];
    }

    const node = this.nodes.availableNode(device.preferredNodeId);
    if (!node) throw new BadRequestException(`No backend node is available for device ${device.id}`);

    const taskDrafts = simulation.actions.find((entry) => entry.action === action)?.taskDrafts ?? [];
    const created: UpdateTask[] = [];
    for (const draft of taskDrafts) {
      if (hasActiveConflict(this.store.tasks, draft)) {
        addUnique(simulation.conflicts, `Active task already exists for ${draft.type} on ${device.hostname}`);
        this.logRuleEvent(rule, 'rule.conflict_detected', 'medium', actor, { deviceId: device.id, draft });
        continue;
      }

      const task = this.tasks.createDraft({
        nodeId: node.id,
        deviceId: device.id,
        tenantId: rule.tenantId ?? device.tenantId ?? 'default',
        type: draft.type as UpdateTask['type'],
        targetVersion: (draft.targetVersion as UpdateTask['targetVersion']) ?? 'latest',
        appName: draft.appName,
        packageArtifactId: draft.packageArtifactId,
        packageId: draft.packageId,
        productCode: draft.productCode,
        sourceUrl: draft.sourceUrl,
        sha256: draft.sha256,
        installArgs: draft.installArgs,
      }, actor);
      (task as any).ruleId = rule.id;
      await this.tasks.runSecurityScan(task.id, actor);
      created.push(task);
      recordRuleTask(rule);
    }
    return created;
  }

  private simulateForDevice(rule: PatchRule, device: Device): RuleSimulationResult {
    const context = buildContext(this.store, rule, device);
    const reasons: string[] = [];
    const matched = evaluateGroup(ruleConditionGroup(rule), context, reasons);
    const actions = matched ? (rule.actions ?? []).map((action) => ({
      action,
      taskDrafts: actionDrafts(action, context),
      notification: action.type === 'notify' ? action.message : undefined,
      tag: action.type === 'mark_device' ? action.tag : undefined,
    })) : [];
    const riskScore = estimateRisk(rule, context, actions.reduce((n, action) => n + action.taskDrafts.length, 0));
    const conflicts = actions.flatMap((action) => action.taskDrafts)
      .filter((draft) => hasActiveConflict(this.store.tasks, draft))
      .map((draft) => `Active task already exists for ${draft.type} on ${device.hostname}`);
    const rateLimited = !withinRateLimit(rule, actions.reduce((n, action) => n + action.taskDrafts.length, 0));
    return {
      ruleId: rule.id,
      deviceId: device.id,
      wouldTrigger: matched,
      reasons,
      actions,
      riskScore,
      conflicts,
      rateLimited,
      approvalRequired: riskScore >= (rule.safeMode?.requireApprovalAtRiskScore ?? 0) || rateLimited || conflicts.length > 0,
    };
  }

  private devicesForRule(rule: PatchRule): Device[] {
    return this.store.devices
      .filter((device) => (rule.tenantId ?? 'default') === (device.tenantId ?? 'default'))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private resolveDevice(rule: PatchRule, deviceId?: string): Device {
    const device = deviceId
      ? this.store.devices.find((candidate) => candidate.id === deviceId)
      : this.devicesForRule(rule)[0];
    if (!device) throw new BadRequestException('Sample device not found');
    return device;
  }

  private requireRule(id: string): PatchRule {
    const rule = this.store.rules.find((candidate) => candidate.id === id);
    if (!rule) throw new BadRequestException('Rule not found');
    return rule;
  }

  private validateRule(rule: PatchRule) {
    for (const action of rule.actions ?? []) {
      if (!['create_patch_task', 'create_security_task', 'notify', 'mark_device', 'block_task_creation'].includes((action as any).type)) {
        throw new BadRequestException(`Unsupported rule action type: ${(action as any).type ?? 'missing'}`);
      }
      if (action.type === 'create_security_task' && action.task === 'rescan_device') {
        throw new BadRequestException('rescan_device is reserved until the signed task pipeline supports it');
      }
      if (action.type === 'notify' && action.channel !== 'siem') {
        throw new BadRequestException(`${action.channel} notifications must be routed through tenant notification policy before use`);
      }
      if (action.type === 'mark_device' && !/^[A-Za-z0-9._:-]{1,48}$/.test(action.tag)) {
        throw new BadRequestException('Device tags must be 1-48 characters and contain only letters, numbers, dot, underscore, colon, or dash');
      }
      if (action.type === 'block_task_creation' && !clean(action.reason)) {
        throw new BadRequestException('Block actions require a reason');
      }
    }
  }

  private logRuleEvent(rule: PatchRule, type: 'rule.conflict_detected' | 'rule.failed' | 'rule.rate_limited', severity: 'medium' | 'high', actor: User, metadata: Record<string, unknown>) {
    this.audit.record(actor.id, type, rule.id, metadata, rule.tenantId);
    this.siem.emit({ tenantId: rule.tenantId ?? 'default', type, severity, actor: { userId: actor.id }, metadata: { ruleId: rule.id, ...metadata } });
  }
}

function normalizeRule(input: Partial<PatchRule>, actor: User): PatchRule {
  const now = new Date().toISOString();
  const legacyCondition = input.property && input.operator && input.value
    ? legacyConditionGroup(input)
    : undefined;
  const legacyAction = input.property
    ? [{ type: 'create_patch_task', mode: 'specific_package', packageName: String(input.value ?? ''), targetVersion: input.targetVersion ?? 'latest' } as RuleAction]
    : undefined;
  return {
    id: input.id ?? uuid(),
    tenantId: input.tenantId ?? 'default',
    name: clean(input.name) || 'Untitled rule',
    description: clean(input.description),
    enabled: input.enabled ?? true,
    priority: Number.isFinite(input.priority) ? Number(input.priority) : 100,
    createdBy: input.createdBy ?? actor.id,
    createdAt: input.createdAt ?? now,
    trigger: input.trigger ?? { type: 'manual' },
    conditions: input.conditions ?? [],
    conditionGroup: input.conditionGroup ?? legacyCondition ?? { combinator: 'AND', conditions: [] },
    actions: input.actions ?? legacyAction ?? [{ type: 'create_security_task', task: 'refresh_inventory' }],
    schedule: input.schedule ?? {},
    lastRunAt: input.lastRunAt,
    executionStats: input.executionStats ?? { taskCreatedAt: [], executionLog: [] },
    safeMode: input.safeMode ?? { enabled: true, requireApprovalAtRiskScore: 60 },
    property: input.property,
    operator: input.operator,
    value: input.value,
    targetVersion: input.targetVersion,
    maxVersion: input.maxVersion,
    sourceTemplateId: input.sourceTemplateId,
    sourceTemplateName: input.sourceTemplateName,
  };
}

function legacyConditionGroup(input: Partial<PatchRule>): RuleConditionGroup {
  const field = input.property === 'packageId' ? 'package.name' : 'package.name';
  return {
    combinator: 'AND',
    conditions: [
      { field, operator: input.operator === 'equals' ? 'eq' : 'contains', value: String(input.value ?? '') },
      ...(input.maxVersion ? [{ field: 'package.version' as const, operator: 'lt' as const, value: input.maxVersion }] : []),
    ],
  };
}

function ruleConditionGroup(rule: PatchRule): RuleConditionGroup {
  if (rule.conditionGroup) return rule.conditionGroup;
  if (rule.conditions?.length) return { combinator: 'AND', conditions: rule.conditions };
  return { combinator: 'AND', conditions: [] };
}

function buildContext(store: MemoryStore, rule: PatchRule, device: Device) {
  const apps = store.installedApps.filter((app) => app.deviceId === device.id);
  const latest = latestVersions(store.installedApps);
  const packages = apps.map((app) => {
    const latestVersion = latest.get(`${app.name}|${app.publisher}`) ?? app.version;
    return { ...app, outdated: compareVersions(app.version, latestVersion) < 0, latestVersion };
  });
  const tasks = store.tasks.filter((task) => task.deviceId === device.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const lastTask = tasks[0];
  return {
    rule,
    device,
    packages,
    lastTask,
    retryCount: tasks.filter((task) => task.status === 'failed').length,
    riskScore: device.riskScore ?? Math.max(0, 100 - (device.deviceTrustScore ?? 100)),
  };
}

function evaluateGroup(group: RuleConditionGroup, context: ReturnType<typeof buildContext>, reasons: string[]): boolean {
  const results = group.conditions.map((item) => {
    const result = 'combinator' in item ? evaluateGroup(item, context, reasons) : evaluateCondition(item, context);
    reasons.push(`${describeCondition(item)} => ${result ? 'matched' : 'missed'}`);
    return result;
  });
  if (results.length === 0) {
    reasons.push('No conditions configured; rule matches tenant devices');
    return true;
  }
  return group.combinator === 'OR' ? results.some(Boolean) : results.every(Boolean);
}

function evaluateCondition(condition: RuleCondition, context: ReturnType<typeof buildContext>): boolean {
  const values = valuesForField(condition.field, context);
  return values.some((actual) => compare(actual, condition.operator, condition.value));
}

function valuesForField(field: RuleCondition['field'], context: ReturnType<typeof buildContext>): unknown[] {
  switch (field) {
    case 'device.os': return [context.device.os];
    case 'device.hostname': return [context.device.hostname];
    case 'device.group': return [context.device.group ?? ''];
    case 'device.tag': return context.device.tags ?? [];
    case 'device.deviceTrustScore': return [context.device.deviceTrustScore ?? 100];
    case 'device.lastInventoryAgeHours': return [hoursSince(context.device.lastSeenAt)];
    case 'package.outdated': return context.packages.map((pkg) => pkg.outdated);
    case 'package.name': return context.packages.flatMap((pkg) => [pkg.name, pkg.packageId ?? '']);
    case 'package.severity': return context.packages.map((pkg) => (pkg as any).severity ?? 'unknown');
    case 'package.version': return context.packages.map((pkg) => pkg.version);
    case 'lastTask.failed': return [context.lastTask?.status === 'failed'];
    case 'lastTask.retryCount': return [context.retryCount];
    case 'lastTask.failureRetryable': return [isRetryableFailure(context.lastTask?.output)];
    case 'currentTime.maintenanceWindow': return [isNowInWindow(context.rule.schedule?.maintenanceWindow)];
    case 'riskScore': return [context.riskScore];
    case 'task.sourceHostTrusted': return [true];
    case 'task.hashPresent': return [true];
  }
}

function compare(actual: unknown, operator: RuleCondition['operator'], expected: RuleCondition['value']) {
  if (operator === 'eq') return String(actual).toLowerCase() === String(expected).toLowerCase();
  if (operator === 'neq') return String(actual).toLowerCase() !== String(expected).toLowerCase();
  if (operator === 'contains') return String(actual).toLowerCase().includes(String(expected).toLowerCase());
  if (operator === 'matches') return safeRegex(String(expected)).test(String(actual));
  if (operator === 'in') return Array.isArray(expected) && expected.map(String).includes(String(actual));
  const cmp = compareVersions(String(actual), String(expected));
  if (operator === 'lt') return cmp < 0;
  if (operator === 'lte') return cmp <= 0;
  if (operator === 'gt') return cmp > 0;
  if (operator === 'gte') return cmp >= 0;
  return false;
}

function actionDrafts(action: RuleAction, context: ReturnType<typeof buildContext>): Array<Partial<UpdateTask>> {
  if (action.type === 'create_security_task') {
    return action.task === 'refresh_inventory' ? [{ type: 'refresh_inventory', targetVersion: 'latest', deviceId: context.device.id }] : [];
  }
  if (action.type === 'block_task_creation') return [];
  if (action.type !== 'create_patch_task') return [];
  const candidates = context.packages.filter((pkg) => {
    if (action.mode === 'all_outdated') return pkg.outdated;
    const wanted = (action.packageName ?? action.packageId ?? '').toLowerCase();
    return !wanted || pkg.name.toLowerCase() === wanted || pkg.packageId?.toLowerCase() === wanted;
  });
  return candidates.slice(0, action.maxDevices ?? 100).map((pkg) => ({
    type: 'update_package',
    targetVersion: action.targetVersion ?? 'latest',
    appName: pkg.name,
    packageId: pkg.packageId,
    productCode: pkg.productCode,
    packageArtifactId: action.packageArtifactId,
    deviceId: context.device.id,
  }));
}

function estimateRisk(rule: PatchRule, context: ReturnType<typeof buildContext>, taskCount: number) {
  let score = context.riskScore;
  if (taskCount > 5) score += 20;
  if (rule.trigger?.type === 'event') score += 5;
  if (context.device.group?.toLowerCase() === 'production') score += 15;
  return Math.min(100, score);
}

function hasActiveConflict(tasks: UpdateTask[], draft: Partial<UpdateTask>) {
  return tasks.some((task) =>
    ACTIVE_TASK_STATUSES.has(task.status) &&
    task.deviceId === draft.deviceId &&
    task.type === draft.type &&
    (task.appName ?? '') === (draft.appName ?? '') &&
    (task.packageId ?? '') === (draft.packageId ?? ''),
  );
}

function latestVersions(apps: InstalledApp[]) {
  const latest = new Map<string, string>();
  for (const app of apps) {
    const key = `${app.name}|${app.publisher}`;
    const current = latest.get(key);
    if (!current || compareVersions(app.version, current) > 0) latest.set(key, app.version);
  }
  return latest;
}

function compareVersions(a: string, b: string) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function isNowInWindow(window?: { daysOfWeek?: number[]; startHourUtc: number; endHourUtc: number }) {
  if (!window) return true;
  const now = new Date();
  if (window.daysOfWeek?.length && !window.daysOfWeek.includes(now.getUTCDay())) return false;
  const hour = now.getUTCHours();
  return hour >= window.startHourUtc && hour < window.endHourUtc;
}

function withinRateLimit(rule: PatchRule, requestedTasks: number) {
  const since = Date.now() - 60 * 60_000;
  const recent = (rule.executionStats?.taskCreatedAt ?? []).filter((iso) => new Date(iso).getTime() >= since);
  return recent.length + requestedTasks <= DEFAULT_MAX_TASKS_PER_RULE_PER_HOUR;
}

function recordRuleTask(rule: PatchRule) {
  rule.executionStats ??= { taskCreatedAt: [], executionLog: [] };
  const since = Date.now() - 60 * 60_000;
  rule.executionStats.taskCreatedAt = [
    ...rule.executionStats.taskCreatedAt.filter((iso) => new Date(iso).getTime() >= since),
    new Date().toISOString(),
  ];
}

function appendExecution(rule: PatchRule, record: RuleExecutionRecord) {
  rule.executionStats ??= { taskCreatedAt: [], executionLog: [] };
  rule.executionStats.executionLog = [record, ...rule.executionStats.executionLog].slice(0, 250);
}

function ruleMaxDevices(rule: PatchRule) {
  const fromActions = (rule.actions ?? [])
    .filter((action): action is Extract<RuleAction, { type: 'create_patch_task' }> => action.type === 'create_patch_task')
    .map((action) => action.maxDevices)
    .filter((value): value is number => Number.isFinite(value));
  return Math.max(1, Math.min(DEFAULT_MAX_DEVICES_PER_EXECUTION, ...fromActions, DEFAULT_MAX_DEVICES_PER_EXECUTION));
}

function isRetryableFailure(output?: string) {
  if (!output) return false;
  return /(timeout|network|locked|reboot|busy|temporar|retry)/i.test(output);
}

function hoursSince(iso?: string) {
  if (!iso) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - new Date(iso).getTime()) / 36e5);
}

function safeRegex(pattern: string) {
  if (pattern.length > 128) return /a^/;
  // Block common catastrophic-backtracking shapes such as (a+)+, (.*)+, and nested
  // quantified groups. This keeps the rule engine expressive without letting an
  // admin-supplied pattern monopolise the Node event loop.
  if (/\([^)]*[*+][^)]*\)[*+{]/.test(pattern)) return /a^/;
  if (/\([^)]*\{[^)]*\}[^)]*\)[*+{]/.test(pattern)) return /a^/;
  try { return new RegExp(pattern, 'i'); } catch { return /a^/; }
}

function describeCondition(item: RuleCondition | RuleConditionGroup) {
  if ('combinator' in item) return `${item.combinator} group`;
  return `${item.field} ${item.operator} ${JSON.stringify(item.value)}`;
}

function clean(value?: string) {
  const text = (value ?? '').trim();
  return text || undefined;
}

function addUnique(values: string[], value: string) {
  if (!values.includes(value)) values.push(value);
}
