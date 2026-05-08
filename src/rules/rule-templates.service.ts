import { BadRequestException, Injectable } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { SiemEventService } from '../siem/siem-event.service';
import { MemoryStore } from '../storage/memory.store';
import { PatchRule, RuleAction, RuleCondition, RuleConditionGroup, RuleTemplate, RuleTemplateInput, TenantPolicy, User } from '../types';
import { TenantPolicyService } from '../tasks/tenant-policy.service';

export interface CreateDraftResult {
  template: RuleTemplate;
  draftRule: PatchRule;
  preview: {
    summary: string[];
    estimatedAffectedDevices: number | null;
    riskLevel: RuleTemplate['riskLevel'];
    requiredApprovals: string[];
    securityMode: TenantPolicy['securityMode'];
  };
}

@Injectable()
export class RuleTemplatesService {
  constructor(
    private readonly store: MemoryStore,
    private readonly audit: AuditService,
    private readonly siem: SiemEventService,
    private readonly policy: TenantPolicyService,
  ) {}

  list(tenantId = 'default') {
    return [...DEFAULT_TEMPLATES, ...this.customTemplates(tenantId)].map(redactInternalDraftData);
  }

  get(id: string, actor?: User) {
    const template = this.requireTemplate(id, actor?.id ? 'default' : undefined);
    if (actor) this.emit(actor, 'rule_template.selected', 'low', template, {});
    return redactInternalDraftData(template);
  }

  createDraft(id: string, inputs: Record<string, unknown>, actor: User): CreateDraftResult {
    const template = this.requireTemplate(id, String(inputs.tenantId ?? 'default'));
    const mergedInputs = resolveInputs(template.requiredInputs, inputs);
    const tenantId = String(mergedInputs.tenantId ?? inputs.tenantId ?? template.tenantId ?? 'default');
    const securityMode = this.policy.get(tenantId).securityMode;
    const draftRule = applySecurityMode(buildDraftRule(template, mergedInputs, actor, tenantId), securityMode);
    const result = {
      template: redactInternalDraftData(template),
      draftRule,
      preview: {
        summary: previewSummary(template, mergedInputs, draftRule, securityMode),
        estimatedAffectedDevices: estimateAffectedDevices(this.store, tenantId, mergedInputs),
        riskLevel: template.riskLevel,
        requiredApprovals: approvalsFor(template, securityMode),
        securityMode,
      },
    };
    this.emit(actor, 'rule_template.draft_created', severityFor(template.riskLevel), template, {
      ruleId: draftRule.id,
      securityMode,
      enabled: draftRule.enabled,
    });
    return result;
  }

  createCustom(input: Partial<RuleTemplate>, actor: User) {
    const template = normalizeCustomTemplate(input, actor);
    validateTemplate(template);
    this.store.ruleTemplates.push(template);
    void this.store.persist();
    this.emit(actor, 'rule_template.custom_created', 'low', template, { custom: true });
    return template;
  }

  importCustom(input: unknown, actor: User) {
    if (!input || typeof input !== 'object') throw new BadRequestException('Template import must be a JSON object');
    return this.createCustom(input as Partial<RuleTemplate>, actor);
  }

  exportCustom(tenantId = 'default') {
    return this.customTemplates(tenantId);
  }

  private customTemplates(tenantId: string) {
    return (this.store.ruleTemplates ?? []).filter((template) => template.tenantId === tenantId);
  }

  private requireTemplate(id: string, tenantId = 'default') {
    const template = DEFAULT_TEMPLATES.find((candidate) => candidate.id === id)
      ?? this.customTemplates(tenantId).find((candidate) => candidate.id === id);
    if (!template) throw new BadRequestException('Rule template not found');
    validateTemplate(template);
    return template;
  }

  private emit(actor: User, type: 'rule_template.selected' | 'rule_template.draft_created' | 'rule_template.custom_created', severity: 'low' | 'medium' | 'high' | 'critical', template: RuleTemplate, metadata: Record<string, unknown>) {
    this.audit.record(actor.id, type, template.id, { templateName: template.name, ...metadata }, template.tenantId ?? 'default');
    this.siem.emit({
      tenantId: template.tenantId ?? 'default',
      type,
      severity,
      actor: { userId: actor.id },
      metadata: { templateId: template.id, templateName: template.name, ...metadata },
    });
  }
}

function buildDraftRule(template: RuleTemplate, inputs: Record<string, unknown>, actor: User, tenantId: string): PatchRule {
  return {
    id: uuid(),
    tenantId,
    name: String(inputs.ruleName ?? template.name),
    description: `${template.description}\n\nCreated from template: ${template.name}`,
    enabled: false,
    priority: Number(inputs.priority ?? 100),
    createdBy: actor.id,
    createdAt: new Date().toISOString(),
    trigger: template.trigger,
    conditionGroup: replaceConditionValues(template.conditions, inputs),
    conditions: [],
    actions: replaceActionValues(template.actions, inputs),
    schedule: {
      ...template.schedule,
      maintenanceWindow: asMaintenanceWindow(inputs.maintenanceWindow) ?? template.schedule.maintenanceWindow,
    },
    executionStats: { taskCreatedAt: [], executionLog: [] },
    safeMode: { enabled: true, requireApprovalAtRiskScore: 60 },
    sourceTemplateId: template.id,
    sourceTemplateName: template.name,
  };
}

function applySecurityMode(rule: PatchRule, mode: TenantPolicy['securityMode']): PatchRule {
  const approvalAt = mode === 'tinfoil' ? 40 : mode === 'strict' ? 50 : 60;
  const maxDevices = mode === 'tinfoil' ? 5 : mode === 'strict' ? 10 : 25;
  return {
    ...rule,
    enabled: false,
    safeMode: { ...rule.safeMode, enabled: true, requireApprovalAtRiskScore: approvalAt },
    actions: (rule.actions ?? []).map((action) => action.type === 'create_patch_task'
      ? { ...action, maxDevices: Math.min(action.maxDevices ?? maxDevices, maxDevices) }
      : action),
  };
}

function resolveInputs(required: RuleTemplateInput[], inputs: Record<string, unknown>) {
  const resolved: Record<string, unknown> = { ...inputs };
  for (const input of required) {
    if (resolved[input.id] === undefined || resolved[input.id] === '') {
      if (input.defaultValue !== undefined) resolved[input.id] = input.defaultValue;
      else if (input.required) throw new BadRequestException(`Missing required template input: ${input.id}`);
    }
  }
  return resolved;
}

function replaceConditionValues(group: RuleConditionGroup, inputs: Record<string, unknown>): RuleConditionGroup {
  return {
    combinator: group.combinator,
    conditions: group.conditions.map((item) => 'combinator' in item
      ? replaceConditionValues(item, inputs)
      : { ...item, value: replaceValue(item.value, inputs) } as RuleCondition),
  };
}

function replaceActionValues(actions: RuleAction[], inputs: Record<string, unknown>): RuleAction[] {
  return actions.map((action) => {
    const next = { ...action } as any;
    for (const key of Object.keys(next)) next[key] = replaceValue(next[key], inputs);
    return next as RuleAction;
  });
}

function replaceValue(value: unknown, inputs: Record<string, unknown>): any {
  if (typeof value === 'string' && value.startsWith('$input.')) return inputs[value.slice(7)];
  if (Array.isArray(value)) return value.map((item) => replaceValue(item, inputs));
  return value;
}

function asMaintenanceWindow(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const window = value as any;
  if (!Number.isFinite(window.startHourUtc) || !Number.isFinite(window.endHourUtc)) return undefined;
  return { daysOfWeek: Array.isArray(window.daysOfWeek) ? window.daysOfWeek : undefined, startHourUtc: window.startHourUtc, endHourUtc: window.endHourUtc };
}

function validateTemplate(template: RuleTemplate) {
  if (!template.id || !template.name) throw new BadRequestException('Rule templates require id and name');
  if (!template.trigger || !template.conditions || !Array.isArray(template.actions)) throw new BadRequestException('Rule template has an invalid rule blueprint');
  for (const action of template.actions) {
    const type = (action as any).type;
    if (!['create_patch_task', 'create_security_task', 'notify', 'mark_device', 'block_task_creation'].includes(type)) {
      throw new BadRequestException(`Template action is not allowed: ${type ?? 'missing'}`);
    }
    if ((action as any).command || (action as any).script || (action as any).shell) {
      throw new BadRequestException('Templates cannot create arbitrary command actions');
    }
    if (type === 'notify' && (action as any).channel !== 'siem') throw new BadRequestException('Templates can only emit SIEM notifications directly');
    if (type === 'create_security_task' && (action as any).task !== 'refresh_inventory') throw new BadRequestException('Template security tasks must use supported signed task types');
  }
}

function normalizeCustomTemplate(input: Partial<RuleTemplate>, actor: User): RuleTemplate {
  return {
    ...input,
    id: input.id ? `custom-${String(input.id).replace(/^custom-/, '')}` : `custom-${uuid()}`,
    category: input.category ?? 'Recommended',
    recommendedSecurityMode: input.recommendedSecurityMode ?? 'strict',
    riskLevel: input.riskLevel ?? 'medium',
    tags: input.tags ?? ['custom'],
    requiredInputs: input.requiredInputs ?? [],
    explanation: input.explanation ?? ['Custom tenant template. Review every field before saving.'],
    safety: input.safety ?? ['Rules created from custom templates are disabled by default.'],
    custom: true,
    tenantId: input.tenantId ?? 'default',
    createdBy: actor.id,
    createdAt: new Date().toISOString(),
  } as RuleTemplate;
}

function redactInternalDraftData(template: RuleTemplate): RuleTemplate {
  return { ...template, actions: template.actions.map((action) => ({ ...action })) };
}

function estimateAffectedDevices(store: MemoryStore, tenantId: string, inputs: Record<string, unknown>) {
  const group = String(inputs.targetDeviceGroup ?? '');
  const devices = store.devices.filter((device) => (device.tenantId ?? 'default') === tenantId && (!group || device.group === group));
  return devices.length || null;
}

function approvalsFor(template: RuleTemplate, mode: TenantPolicy['securityMode']) {
  const approvals = ['normal task approval policy'];
  if (template.riskLevel === 'high' || template.riskLevel === 'critical') approvals.push('MFA approval for high risk');
  if (mode === 'strict') approvals.push('strict mode lower approval threshold');
  if (mode === 'tinfoil') approvals.push('two-person approval defaults');
  return approvals;
}

function previewSummary(template: RuleTemplate, inputs: Record<string, unknown>, rule: PatchRule, mode: TenantPolicy['securityMode']) {
  const group = String(inputs.targetDeviceGroup ?? 'the selected device group');
  const window = rule.schedule?.maintenanceWindow;
  return [
    `run from ${template.trigger.type === 'schedule' ? rule.schedule?.cron ?? 'the configured schedule' : template.trigger.eventType ?? 'the configured event'}`,
    `target devices in group ${group}`,
    ...template.explanation,
    `require security scan through the normal task pipeline`,
    `start disabled for review before saving`,
    `respect tenant ${mode} security mode`,
    ...(window ? [`only run during UTC hours ${window.startHourUtc}:00-${window.endHourUtc}:00`] : []),
  ];
}

function severityFor(risk: RuleTemplate['riskLevel']) {
  return risk === 'critical' ? 'critical' : risk === 'high' ? 'high' : risk === 'medium' ? 'medium' : 'low';
}

const groupInput: RuleTemplateInput = {
  id: 'targetDeviceGroup',
  label: 'Target device group',
  type: 'device_group',
  required: true,
  description: 'Device group the generated rule should target.',
};

const maintenanceWindowInput: RuleTemplateInput = {
  id: 'maintenanceWindow',
  label: 'Maintenance window',
  type: 'maintenance_window',
  required: true,
  description: 'UTC window in which scheduled patch tasks may be created.',
  defaultValue: { daysOfWeek: [0], startHourUtc: 3, endHourUtc: 5 },
};

const DEFAULT_TEMPLATES: RuleTemplate[] = [
  {
    id: 'weekly-browser-updates',
    name: 'Weekly Browser Updates',
    description: 'Patch common Windows browsers during a maintenance window.',
    category: 'Recommended',
    recommendedSecurityMode: 'strict',
    riskLevel: 'medium',
    tags: ['browser', 'windows', 'weekly'],
    trigger: { type: 'schedule' },
    schedule: { cron: '0 3 * * 0', timezone: 'UTC', maintenanceWindow: { daysOfWeek: [0], startHourUtc: 3, endHourUtc: 5 } },
    conditions: { combinator: 'AND', conditions: [
      { field: 'device.group', operator: 'eq', value: '$input.targetDeviceGroup' },
      { field: 'device.os', operator: 'eq', value: 'windows' },
      { field: 'package.name', operator: 'in', value: ['Google Chrome', 'Microsoft Edge', 'Mozilla Firefox', 'Chrome', 'Edge', 'Firefox'] },
      { field: 'package.outdated', operator: 'eq', value: true },
      { field: 'currentTime.maintenanceWindow', operator: 'eq', value: true },
    ] },
    actions: [{ type: 'create_patch_task', mode: 'all_outdated', targetVersion: 'latest' }],
    requiredInputs: [groupInput, maintenanceWindowInput],
    explanation: ['update Chrome, Edge, and Firefox when they are outdated', 'use delayed execution and security scanning before dispatch'],
    safety: ['delayed execution required', 'security scan required', 'disabled by default'],
  },
  {
    id: 'critical-patch-fast-track',
    name: 'Critical Patch Fast Track',
    description: 'Create urgent patch drafts for critical packages outside production unless approval gates apply.',
    category: 'Recommended',
    recommendedSecurityMode: 'tinfoil',
    riskLevel: 'high',
    tags: ['critical', 'vulnerability', 'approval'],
    trigger: { type: 'event', eventType: 'vulnerability.detected' },
    schedule: {},
    conditions: { combinator: 'AND', conditions: [
      { field: 'device.group', operator: 'neq', value: 'production' },
      { field: 'package.severity', operator: 'eq', value: 'critical' },
      { field: 'package.outdated', operator: 'eq', value: true },
    ] },
    actions: [{ type: 'create_patch_task', mode: 'all_outdated', targetVersion: 'latest' }, { type: 'notify', channel: 'siem', message: 'Critical patch fast-track draft created' }],
    requiredInputs: [],
    explanation: ['create patch task drafts for critical packages', 'send a SIEM notification'],
    safety: ['MFA approval required by tenant policy', 'high-risk approval policy applies', 'production is excluded by default'],
  },
  {
    id: 'retry-failed-updates',
    name: 'Retry Failed Updates',
    description: 'Retry transient failed update tasks with a capped exponential backoff.',
    category: 'Failure Handling',
    recommendedSecurityMode: 'strict',
    riskLevel: 'medium',
    tags: ['retry', 'failed-task'],
    trigger: { type: 'event', eventType: 'task.failed' },
    schedule: {},
    conditions: { combinator: 'AND', conditions: [
      { field: 'lastTask.failed', operator: 'eq', value: true },
      { field: 'lastTask.retryCount', operator: 'lt', value: '$input.retryLimit' },
      { field: 'lastTask.failureRetryable', operator: 'eq', value: true },
    ] },
    actions: [{ type: 'create_patch_task', mode: 'all_outdated', targetVersion: 'latest', retryLimit: '$input.retryLimit' as any, backoff: 'exponential', maxDevices: 1 }],
    requiredInputs: [{ id: 'retryLimit', label: 'Retry limit', type: 'number', required: true, description: 'Maximum retry attempts.', defaultValue: 2 }],
    explanation: ['create one retry task when the previous failure is retryable'],
    safety: ['exponential backoff', 'retry count prevents loops'],
  },
  {
    id: 'refresh-inventory-daily',
    name: 'Refresh Inventory Daily',
    description: 'Refresh stale device inventory once per day.',
    category: 'Security / Inventory',
    recommendedSecurityMode: 'normal',
    riskLevel: 'low',
    tags: ['inventory', 'daily'],
    trigger: { type: 'schedule' },
    schedule: { cron: '0 1 * * *', timezone: 'UTC' },
    conditions: { combinator: 'AND', conditions: [{ field: 'device.group', operator: 'eq', value: '$input.targetDeviceGroup' }, { field: 'device.lastInventoryAgeHours', operator: 'gt', value: 24 }] },
    actions: [{ type: 'create_security_task', task: 'refresh_inventory' }],
    requiredInputs: [groupInput],
    explanation: ['refresh inventory for devices whose data should stay current'],
    safety: ['low risk', 'uses supported signed refresh task'],
  },
  {
    id: 'patch-test-group-first',
    name: 'Patch Test Group First',
    description: 'Patch outdated packages in a test group before broader rollout.',
    category: 'Patch Automation',
    recommendedSecurityMode: 'strict',
    riskLevel: 'low',
    tags: ['test-first', 'patch'],
    trigger: { type: 'schedule' },
    schedule: { cron: '0 2 * * 0', timezone: 'UTC', maintenanceWindow: { daysOfWeek: [0], startHourUtc: 2, endHourUtc: 5 } },
    conditions: { combinator: 'AND', conditions: [{ field: 'device.group', operator: 'eq', value: 'test' }, { field: 'package.outdated', operator: 'eq', value: true }] },
    actions: [{ type: 'create_patch_task', mode: 'all_outdated', targetVersion: 'latest' }],
    requiredInputs: [],
    explanation: ['create patch task drafts only for the test group'],
    safety: ['no production devices affected'],
  },
  {
    id: 'notify-on-high-risk-task',
    name: 'Notify on High-Risk Task',
    description: 'Notify security systems when a task scan returns high risk.',
    category: 'Notifications',
    recommendedSecurityMode: 'normal',
    riskLevel: 'low',
    tags: ['notification', 'siem'],
    trigger: { type: 'event', eventType: 'task.security_scan.completed' },
    schedule: {},
    conditions: { combinator: 'AND', conditions: [{ field: 'riskScore', operator: 'gte', value: 70 }] },
    actions: [{ type: 'notify', channel: 'siem', message: 'High-risk task detected by rule template' }],
    requiredInputs: [],
    explanation: ['send SIEM and configured tenant notifications for high-risk task scans'],
    safety: ['no execution action'],
  },
  {
    id: 'production-maintenance-window-only',
    name: 'Production Maintenance Window Only',
    description: 'Allow production patch drafts only inside an explicit maintenance window.',
    category: 'Compliance',
    recommendedSecurityMode: 'tinfoil',
    riskLevel: 'high',
    tags: ['production', 'maintenance-window', 'approval'],
    trigger: { type: 'schedule' },
    schedule: { cron: '0 3 * * 0', timezone: 'UTC', maintenanceWindow: { daysOfWeek: [0], startHourUtc: 3, endHourUtc: 5 } },
    conditions: { combinator: 'AND', conditions: [{ field: 'device.group', operator: 'eq', value: 'production' }, { field: 'currentTime.maintenanceWindow', operator: 'eq', value: true }, { field: 'package.outdated', operator: 'eq', value: true }] },
    actions: [{ type: 'create_patch_task', mode: 'all_outdated', targetVersion: 'latest' }],
    requiredInputs: [maintenanceWindowInput],
    explanation: ['create production patch task drafts only during the configured window'],
    safety: ['delayed execution required', 'approval required'],
  },
  {
    id: 'block-unsafe-automation',
    name: 'Block Unsafe Automation',
    description: 'Stop automation candidates with critical risk, untrusted source, or missing hashes.',
    category: 'Compliance',
    recommendedSecurityMode: 'tinfoil',
    riskLevel: 'low',
    tags: ['block', 'guardrail'],
    trigger: { type: 'event', eventType: 'rule.task_candidate.created' },
    schedule: {},
    conditions: { combinator: 'OR', conditions: [{ field: 'riskScore', operator: 'gte', value: 90 }, { field: 'task.sourceHostTrusted', operator: 'eq', value: false }, { field: 'task.hashPresent', operator: 'eq', value: false }] },
    actions: [{ type: 'block_task_creation', reason: 'Unsafe automation candidate' }, { type: 'notify', channel: 'siem', message: 'Blocked unsafe automation candidate' }],
    requiredInputs: [],
    explanation: ['do not create an executable task', 'notify admins and SIEM'],
    safety: ['no hidden task', 'no arbitrary command', 'blocks instead of executes'],
  },
];
