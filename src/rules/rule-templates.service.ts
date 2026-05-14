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
  /**
   * Creates a RuleTemplatesService instance with its required collaborators.
   *
   * @param store store supplied to the function.
   * @param audit audit supplied to the function.
   * @param siem siem supplied to the function.
   * @param policy policy supplied to the function.
   */
  constructor(
    private readonly store: MemoryStore,
    private readonly audit: AuditService,
    private readonly siem: SiemEventService,
    private readonly policy: TenantPolicyService,
  ) {}

  /**
   * Lists list records for the caller.
   *
   * @param tenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  list(tenantId = 'default') {
    return [...DEFAULT_TEMPLATES, ...this.customTemplates(tenantId)].map(redactInternalDraftData);
  }

  /**
   * Gets the get value.
   *
   * @param id Identifier used to locate the target record.
   * @param actor actor supplied to the function.
   * @returns The result produced by the operation.
   */
  get(id: string, actor?: User) {
    const template = this.requireTemplate(id, actor?.id ? 'default' : undefined);
    if (actor) this.emit(actor, 'rule_template.selected', 'low', template, {});
    return redactInternalDraftData(template);
  }

  /**
   * Creates a draft record.
   *
   * @param id Identifier used to locate the target record.
   * @param inputs inputs supplied to the function.
   * @param actor actor supplied to the function.
   * @returns The result produced by the operation.
   */
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
        estimatedAffectedDevices: estimateAffectedDevices(this.store, tenantId, mergedInputs, template),
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

  /**
   * Creates a custom record.
   *
   * @param input input supplied to the function.
   * @param actor actor supplied to the function.
   * @returns The result produced by the operation.
   */
  createCustom(input: Partial<RuleTemplate>, actor: User) {
    const template = normalizeCustomTemplate(input, actor);
    validateTemplate(template);
    const existingIndex = this.store.ruleTemplates.findIndex((candidate) =>
      candidate.id === template.id && (candidate.tenantId ?? 'default') === (template.tenantId ?? 'default'));
    if (existingIndex >= 0) this.store.ruleTemplates[existingIndex] = template;
    else this.store.ruleTemplates.push(template);
    void this.store.persist();
    this.emit(actor, 'rule_template.custom_created', 'low', template, { custom: true, replaced: existingIndex >= 0 });
    return template;
  }

  /**
   * Handles the import custom operation for RuleTemplatesService.
   *
   * @param input input supplied to the function.
   * @param actor actor supplied to the function.
   * @returns The result produced by the operation.
   */
  importCustom(input: unknown, actor: User) {
    return this.createCustom(parseTemplateImport(input), actor);
  }

  /**
   * Handles the export custom operation for RuleTemplatesService.
   *
   * @param tenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  exportCustom(tenantId = 'default') {
    return this.customTemplates(tenantId);
  }

  /**
   * Handles the custom templates operation for RuleTemplatesService.
   *
   * @param tenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  private customTemplates(tenantId: string) {
    return (this.store.ruleTemplates ?? []).filter((template) => template.tenantId === tenantId);
  }

  /**
   * Handles the require template operation for RuleTemplatesService.
   *
   * @param id Identifier used to locate the target record.
   * @param tenantId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  private requireTemplate(id: string, tenantId = 'default') {
    const template = DEFAULT_TEMPLATES.find((candidate) => candidate.id === id)
      ?? this.customTemplates(tenantId).find((candidate) => candidate.id === id);
    if (!template) throw new BadRequestException('Rule template not found');
    validateTemplate(template);
    return template;
  }

  /**
   * Sends emit data to its destination.
   *
   * @param actor actor supplied to the function.
   * @param type type supplied to the function.
   * @param severity severity supplied to the function.
   * @param template template supplied to the function.
   * @param metadata metadata supplied to the function.
   */
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

/**
 * Builds the draft rule payload.
 *
 * @param template template supplied to the function.
 * @param inputs inputs supplied to the function.
 * @param actor actor supplied to the function.
 * @param tenantId Identifier used to locate the target record.
 * @returns The result produced by the operation.
 */
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

/**
 * Handles the apply security mode operation.
 *
 * @param rule rule supplied to the function.
 * @param mode mode supplied to the function.
 * @returns The result produced by the operation.
 */
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

/**
 * Resolves inputs configuration.
 *
 * @param required required supplied to the function.
 * @param inputs inputs supplied to the function.
 * @returns The result produced by the operation.
 */
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

/**
 * Handles the replace condition values operation.
 *
 * @param group group supplied to the function.
 * @param inputs inputs supplied to the function.
 * @returns The result produced by the operation.
 */
function replaceConditionValues(group: RuleConditionGroup, inputs: Record<string, unknown>): RuleConditionGroup {
  return {
    combinator: group.combinator,
    conditions: group.conditions.map((item) => 'combinator' in item
      ? replaceConditionValues(item, inputs)
      : { ...item, value: replaceValue(item.value, inputs) } as RuleCondition),
  };
}

/**
 * Handles the replace action values operation.
 *
 * @param actions actions supplied to the function.
 * @param inputs inputs supplied to the function.
 * @returns The result produced by the operation.
 */
function replaceActionValues(actions: RuleAction[], inputs: Record<string, unknown>): RuleAction[] {
  return actions.map((action) => {
    const next = { ...action } as any;
    for (const key of Object.keys(next)) next[key] = replaceValue(next[key], inputs);
    return next as RuleAction;
  });
}

/**
 * Handles the replace value operation.
 *
 * @param value Value to read, render, or store.
 * @param inputs inputs supplied to the function.
 * @returns The result produced by the operation.
 */
function replaceValue(value: unknown, inputs: Record<string, unknown>): any {
  if (typeof value === 'string' && value.startsWith('$input.')) return inputs[value.slice(7)];
  if (Array.isArray(value)) return value.map((item) => replaceValue(item, inputs));
  return value;
}

/**
 * Handles the as maintenance window operation.
 *
 * @param value Value to read, render, or store.
 * @returns The result produced by the operation.
 */
function asMaintenanceWindow(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const window = value as any;
  if (!Number.isFinite(window.startHourUtc) || !Number.isFinite(window.endHourUtc)) return undefined;
  return { daysOfWeek: Array.isArray(window.daysOfWeek) ? window.daysOfWeek : undefined, startHourUtc: window.startHourUtc, endHourUtc: window.endHourUtc };
}

/**
 * Validates template rules.
 *
 * @param template template supplied to the function.
 */
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
    if (type === 'create_patch_task' && (action as any).mode === 'specific_package' && !hasSpecificPackageSelector(action as any)) {
      throw new BadRequestException('Specific package templates require packageName, packageNames, or packageId');
    }
    if (type === 'notify' && (action as any).channel !== 'siem') throw new BadRequestException('Templates can only emit SIEM notifications directly');
    if (type === 'create_security_task' && (action as any).task !== 'refresh_inventory') throw new BadRequestException('Template security tasks must use supported signed task types');
  }
}

/**
 * Handles the has specific package selector operation.
 *
 * @param action action supplied to the function.
 * @returns The result produced by the operation.
 */
function hasSpecificPackageSelector(action: { packageName?: unknown; packageNames?: unknown; packageId?: unknown }) {
  return Boolean(
    cleanString(action.packageName)
    || cleanString(action.packageId)
    || (Array.isArray(action.packageNames) && action.packageNames.some(cleanString)),
  );
}

/**
 * Handles the clean string operation.
 *
 * @param value Value to read, render, or store.
 * @returns The result produced by the operation.
 */
function cleanString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Parses template import input.
 *
 * @param input input supplied to the function.
 * @returns The result produced by the operation.
 */
function parseTemplateImport(input: unknown): Partial<RuleTemplate> {
  if (typeof input === 'string') return parseTemplateConfigString(input);
  if (!input || typeof input !== 'object') throw new BadRequestException('Template import must be a JSON object or config string');

  const body = input as Record<string, unknown>;
  const tenantId = typeof body.tenantId === 'string' && body.tenantId.trim() ? body.tenantId.trim() : undefined;
  if (typeof body.configString === 'string') {
    return unwrapTemplatePayload(parseTemplateConfigString(body.configString), tenantId);
  }
  return unwrapTemplatePayload(body, tenantId);
}

/**
 * Parses template config string input.
 *
 * @param value Value to read, render, or store.
 * @returns The result produced by the operation.
 */
function parseTemplateConfigString(value: string): Partial<RuleTemplate> {
  const text = value.trim();
  if (!text) throw new BadRequestException('Template config string is empty');
  const jsonText = text.startsWith('1patch-rule-template:')
    ? decodeBase64Url(text.slice('1patch-rule-template:'.length))
    : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new BadRequestException('Template config string is not valid JSON');
  }
  return unwrapTemplatePayload(parsed);
}

/**
 * Handles the unwrap template payload operation.
 *
 * @param payload Request payload or data transfer object.
 * @param tenantId Identifier used to locate the target record.
 * @returns The result produced by the operation.
 */
function unwrapTemplatePayload(payload: unknown, tenantId?: string): Partial<RuleTemplate> {
  if (!payload || typeof payload !== 'object') throw new BadRequestException('Template import must contain a JSON object');
  const body = payload as Record<string, unknown>;
  const candidate = body.template && typeof body.template === 'object' ? body.template : body;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new BadRequestException('Template import must contain a template object');
  }
  return tenantId ? { ...(candidate as Partial<RuleTemplate>), tenantId } : candidate as Partial<RuleTemplate>;
}

/**
 * Handles the decode base64 url operation.
 *
 * @param value Value to read, render, or store.
 * @returns The result produced by the operation.
 */
function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

/**
 * Handles the normalize custom template operation.
 *
 * @param input input supplied to the function.
 * @param actor actor supplied to the function.
 * @returns The result produced by the operation.
 */
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

/**
 * Handles the redact internal draft data operation.
 *
 * @param template template supplied to the function.
 * @returns The result produced by the operation.
 */
function redactInternalDraftData(template: RuleTemplate): RuleTemplate {
  return { ...template, actions: template.actions.map((action) => ({ ...action })) };
}

/**
 * Handles the estimate affected devices operation.
 *
 * @param store store supplied to the function.
 * @param tenantId Identifier used to locate the target record.
 * @param inputs inputs supplied to the function.
 * @param template template supplied to the function.
 * @returns The result produced by the operation.
 */
function estimateAffectedDevices(store: MemoryStore, tenantId: string, inputs: Record<string, unknown>, template: RuleTemplate) {
  const group = String(inputs.targetDeviceGroup ?? conditionValue(template.conditions, 'device.group') ?? '');
  const devices = store.devices.filter((device) => (device.tenantId ?? 'default') === tenantId && (!group || device.group === group));
  return devices.length || null;
}

/**
 * Handles the approvals for operation.
 *
 * @param template template supplied to the function.
 * @param mode mode supplied to the function.
 * @returns The result produced by the operation.
 */
function approvalsFor(template: RuleTemplate, mode: TenantPolicy['securityMode']) {
  const approvals = ['normal task approval policy'];
  if (template.riskLevel === 'high' || template.riskLevel === 'critical') approvals.push('MFA approval for high risk');
  if (mode === 'strict') approvals.push('strict mode lower approval threshold');
  if (mode === 'tinfoil') approvals.push('two-person approval defaults');
  return approvals;
}

/**
 * Handles the preview summary operation.
 *
 * @param template template supplied to the function.
 * @param inputs inputs supplied to the function.
 * @param rule rule supplied to the function.
 * @param mode mode supplied to the function.
 * @returns The result produced by the operation.
 */
function previewSummary(template: RuleTemplate, inputs: Record<string, unknown>, rule: PatchRule, mode: TenantPolicy['securityMode']) {
  const group = String(inputs.targetDeviceGroup ?? conditionValue(template.conditions, 'device.group') ?? '');
  const window = rule.schedule?.maintenanceWindow;
  return [
    `run from ${template.trigger.type === 'schedule' ? rule.schedule?.cron ?? 'the configured schedule' : template.trigger.eventType ?? 'the configured event'}`,
    group ? `target devices in group ${group}` : 'target devices matching the rule conditions',
    ...template.explanation,
    `require security scan through the normal task pipeline`,
    `start disabled for review before saving`,
    `respect tenant ${mode} security mode`,
    ...(window ? [`only run during UTC hours ${window.startHourUtc}:00-${window.endHourUtc}:00`] : []),
  ];
}

/**
 * Handles the condition value operation.
 *
 * @param group group supplied to the function.
 * @param field field supplied to the function.
 * @returns The result produced by the operation.
 */
function conditionValue(group: RuleConditionGroup, field: RuleCondition['field']): RuleCondition['value'] | undefined {
  for (const item of group.conditions) {
    if ('combinator' in item) {
      const nested = conditionValue(item, field);
      if (nested !== undefined) return nested;
    } else if (item.field === field && item.operator === 'eq') {
      return item.value;
    }
  }
  return undefined;
}

/**
 * Handles the severity for operation.
 *
 * @param risk risk supplied to the function.
 * @returns The result produced by the operation.
 */
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

const packageNameInput: RuleTemplateInput = {
  id: 'packageName',
  label: 'Package name',
  type: 'package_name',
  required: true,
  description: 'Exact package/app name this rule is allowed to patch.',
  defaultValue: 'Google Chrome',
};

const maintenanceWindowInput: RuleTemplateInput = {
  id: 'maintenanceWindow',
  label: 'Maintenance window',
  type: 'maintenance_window',
  required: true,
  description: 'UTC window in which scheduled patch tasks may be created.',
  defaultValue: { daysOfWeek: [0], startHourUtc: 3, endHourUtc: 5 },
};

const maxDevicesInput: RuleTemplateInput = {
  id: 'maxDevices',
  label: 'Max devices per run',
  type: 'number',
  required: true,
  description: 'Upper bound for task drafts created by one rule execution.',
  defaultValue: 10,
};

const retryLimitInput: RuleTemplateInput = {
  id: 'retryLimit',
  label: 'Retry limit',
  type: 'number',
  required: true,
  description: 'Maximum retry attempts before escalation.',
  defaultValue: 2,
};

const browserPackageNames = ['Google Chrome', 'Microsoft Edge', 'Mozilla Firefox'];
const developerToolPackageNames = ['Visual Studio Code', 'Git', 'Node.js'];
const collaborationPackageNames = ['Microsoft Teams', 'Zoom', 'Slack'];

const DEFAULT_TEMPLATES: RuleTemplate[] = [
  {
    id: 'weekly-browser-updates',
    name: 'Weekly Browser Updates',
    description: 'Patch only Chrome, Edge, and Firefox on Windows during a maintenance window.',
    category: 'Recommended',
    recommendedSecurityMode: 'strict',
    riskLevel: 'medium',
    tags: ['browser', 'windows', 'weekly'],
    trigger: { type: 'schedule' },
    schedule: { cron: '0 3 * * 0', timezone: 'UTC', maintenanceWindow: { daysOfWeek: [0], startHourUtc: 3, endHourUtc: 5 } },
    conditions: { combinator: 'AND', conditions: [
      { field: 'device.group', operator: 'eq', value: '$input.targetDeviceGroup' },
      { field: 'device.os', operator: 'eq', value: 'windows' },
      { field: 'package.name', operator: 'in', value: browserPackageNames },
      { field: 'package.outdated', operator: 'eq', value: true },
      { field: 'currentTime.maintenanceWindow', operator: 'eq', value: true },
    ] },
    actions: [{ type: 'create_patch_task', mode: 'specific_package', packageNames: browserPackageNames, targetVersion: 'latest', maxDevices: '$input.maxDevices' as any }],
    requiredInputs: [groupInput, maintenanceWindowInput, { ...maxDevicesInput, defaultValue: 25 }],
    explanation: ['patch only Chrome, Edge, and Firefox packages', 'skip browsers that are already current', 'use delayed execution and security scanning before dispatch'],
    safety: ['specific package allow-list', 'maintenance window required', 'disabled by default'],
  },
  {
    id: 'critical-patch-fast-track',
    name: 'Critical Patch Fast Track',
    description: 'Fast-track one named critical package outside production while preserving approval gates.',
    category: 'Recommended',
    recommendedSecurityMode: 'tinfoil',
    riskLevel: 'high',
    tags: ['critical', 'vulnerability', 'approval'],
    trigger: { type: 'event', eventType: 'vulnerability.detected' },
    schedule: {},
    conditions: { combinator: 'AND', conditions: [
      { field: 'device.group', operator: 'neq', value: 'production' },
      { field: 'package.name', operator: 'eq', value: '$input.packageName' },
      { field: 'package.severity', operator: 'eq', value: 'critical' },
      { field: 'package.outdated', operator: 'eq', value: true },
    ] },
    actions: [
      { type: 'create_patch_task', mode: 'specific_package', packageName: '$input.packageName', targetVersion: 'latest', maxDevices: '$input.maxDevices' as any },
      { type: 'notify', channel: 'siem', message: 'Critical package fast-track draft created' },
    ],
    requiredInputs: [packageNameInput, maxDevicesInput],
    explanation: ['patch only the named critical package', 'exclude production by default', 'send a SIEM notification'],
    safety: ['specific package required', 'MFA approval applies through tenant policy', 'small max-device cap'],
  },
  {
    id: 'patch-test-group-first',
    name: 'Patch Test Group First',
    description: 'Patch all outdated packages only in the test group before any wider rollout.',
    category: 'Recommended',
    recommendedSecurityMode: 'strict',
    riskLevel: 'low',
    tags: ['test-first', 'patch', 'pilot'],
    trigger: { type: 'schedule' },
    schedule: { cron: '0 2 * * 0', timezone: 'UTC', maintenanceWindow: { daysOfWeek: [0], startHourUtc: 2, endHourUtc: 5 } },
    conditions: { combinator: 'AND', conditions: [
      { field: 'device.group', operator: 'eq', value: 'test' },
      { field: 'package.outdated', operator: 'eq', value: true },
      { field: 'currentTime.maintenanceWindow', operator: 'eq', value: true },
    ] },
    actions: [{ type: 'create_patch_task', mode: 'all_outdated', targetVersion: 'latest', maxDevices: 10 }],
    requiredInputs: [],
    explanation: ['patch only the hard-coded test ring', 'allow broader all-outdated coverage only in that pilot ring'],
    safety: ['no production devices affected', 'max 10 devices per run', 'disabled by default'],
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
    id: 'chrome-zero-day-response',
    name: 'Chrome Zero-Day Response',
    description: 'Create capped Chrome patch drafts when a high-priority browser issue is detected.',
    category: 'Patch Automation',
    recommendedSecurityMode: 'tinfoil',
    riskLevel: 'high',
    tags: ['browser', 'zero-day', 'chrome'],
    trigger: { type: 'event', eventType: 'package.high_priority.detected' },
    schedule: {},
    conditions: { combinator: 'AND', conditions: [
      { field: 'device.os', operator: 'eq', value: 'windows' },
      { field: 'package.name', operator: 'eq', value: 'Google Chrome' },
      { field: 'package.outdated', operator: 'eq', value: true },
    ] },
    actions: [
      { type: 'create_patch_task', mode: 'specific_package', packageName: 'Google Chrome', targetVersion: 'latest', maxDevices: 10 },
      { type: 'notify', channel: 'siem', message: 'Chrome high-priority patch draft created' },
    ],
    requiredInputs: [],
    explanation: ['patch only Google Chrome', 'react to high-priority package events', 'notify SIEM'],
    safety: ['specific package only', 'max 10 devices per execution', 'high-risk approvals apply'],
  },
  {
    id: 'microsoft-edge-stable-ring',
    name: 'Microsoft Edge Stable Ring',
    description: 'Patch Edge on a named Windows device group during a weekly window.',
    category: 'Patch Automation',
    recommendedSecurityMode: 'strict',
    riskLevel: 'medium',
    tags: ['browser', 'edge', 'windows'],
    trigger: { type: 'schedule' },
    schedule: { cron: '30 3 * * 0', timezone: 'UTC', maintenanceWindow: { daysOfWeek: [0], startHourUtc: 3, endHourUtc: 5 } },
    conditions: { combinator: 'AND', conditions: [
      { field: 'device.group', operator: 'eq', value: '$input.targetDeviceGroup' },
      { field: 'device.os', operator: 'eq', value: 'windows' },
      { field: 'package.name', operator: 'eq', value: 'Microsoft Edge' },
      { field: 'package.outdated', operator: 'eq', value: true },
      { field: 'currentTime.maintenanceWindow', operator: 'eq', value: true },
    ] },
    actions: [{ type: 'create_patch_task', mode: 'specific_package', packageName: 'Microsoft Edge', targetVersion: 'latest', maxDevices: '$input.maxDevices' as any }],
    requiredInputs: [groupInput, maintenanceWindowInput, { ...maxDevicesInput, defaultValue: 20 }],
    explanation: ['patch only Microsoft Edge', 'limit rollout to the selected group'],
    safety: ['specific package only', 'maintenance window required', 'device cap required'],
  },
  {
    id: 'firefox-maintenance-ring',
    name: 'Firefox Maintenance Ring',
    description: 'Patch Firefox on a selected endpoint ring without touching other apps.',
    category: 'Patch Automation',
    recommendedSecurityMode: 'strict',
    riskLevel: 'medium',
    tags: ['browser', 'firefox'],
    trigger: { type: 'schedule' },
    schedule: { cron: '0 4 * * 0', timezone: 'UTC', maintenanceWindow: { daysOfWeek: [0], startHourUtc: 4, endHourUtc: 6 } },
    conditions: { combinator: 'AND', conditions: [
      { field: 'device.group', operator: 'eq', value: '$input.targetDeviceGroup' },
      { field: 'package.name', operator: 'eq', value: 'Mozilla Firefox' },
      { field: 'package.outdated', operator: 'eq', value: true },
      { field: 'currentTime.maintenanceWindow', operator: 'eq', value: true },
    ] },
    actions: [{ type: 'create_patch_task', mode: 'specific_package', packageName: 'Mozilla Firefox', targetVersion: 'latest', maxDevices: '$input.maxDevices' as any }],
    requiredInputs: [groupInput, maintenanceWindowInput, { ...maxDevicesInput, defaultValue: 20 }],
    explanation: ['patch only Mozilla Firefox', 'skip unrelated outdated software'],
    safety: ['specific package only', 'disabled by default'],
  },
  {
    id: 'developer-tooling-weekly',
    name: 'Developer Tooling Weekly',
    description: 'Patch VS Code, Git, and Node.js on developer workstations.',
    category: 'Patch Automation',
    recommendedSecurityMode: 'strict',
    riskLevel: 'medium',
    tags: ['developer', 'tooling', 'weekly'],
    trigger: { type: 'schedule' },
    schedule: { cron: '0 5 * * 6', timezone: 'UTC', maintenanceWindow: { daysOfWeek: [6], startHourUtc: 5, endHourUtc: 8 } },
    conditions: { combinator: 'AND', conditions: [
      { field: 'device.group', operator: 'eq', value: '$input.targetDeviceGroup' },
      { field: 'package.name', operator: 'in', value: developerToolPackageNames },
      { field: 'package.outdated', operator: 'eq', value: true },
      { field: 'currentTime.maintenanceWindow', operator: 'eq', value: true },
    ] },
    actions: [{ type: 'create_patch_task', mode: 'specific_package', packageNames: developerToolPackageNames, targetVersion: 'latest', maxDevices: '$input.maxDevices' as any }],
    requiredInputs: [groupInput, { ...maintenanceWindowInput, defaultValue: { daysOfWeek: [6], startHourUtc: 5, endHourUtc: 8 } }, { ...maxDevicesInput, defaultValue: 15 }],
    explanation: ['patch only common developer tools', 'avoid broad workstation updates'],
    safety: ['specific package allow-list', 'weekend maintenance default'],
  },
  {
    id: 'collaboration-app-weekly',
    name: 'Collaboration Apps Weekly',
    description: 'Patch Teams, Zoom, and Slack on office endpoints.',
    category: 'Patch Automation',
    recommendedSecurityMode: 'strict',
    riskLevel: 'medium',
    tags: ['collaboration', 'teams', 'zoom', 'slack'],
    trigger: { type: 'schedule' },
    schedule: { cron: '0 4 * * 6', timezone: 'UTC', maintenanceWindow: { daysOfWeek: [6], startHourUtc: 4, endHourUtc: 7 } },
    conditions: { combinator: 'AND', conditions: [
      { field: 'device.group', operator: 'eq', value: '$input.targetDeviceGroup' },
      { field: 'package.name', operator: 'in', value: collaborationPackageNames },
      { field: 'package.outdated', operator: 'eq', value: true },
      { field: 'currentTime.maintenanceWindow', operator: 'eq', value: true },
    ] },
    actions: [{ type: 'create_patch_task', mode: 'specific_package', packageNames: collaborationPackageNames, targetVersion: 'latest', maxDevices: '$input.maxDevices' as any }],
    requiredInputs: [groupInput, { ...maintenanceWindowInput, defaultValue: { daysOfWeek: [6], startHourUtc: 4, endHourUtc: 7 } }, { ...maxDevicesInput, defaultValue: 20 }],
    explanation: ['patch only Teams, Zoom, and Slack', 'keep unrelated apps out of scope'],
    safety: ['specific package allow-list', 'maintenance window required'],
  },
  {
    id: 'vpn-client-maintenance',
    name: 'VPN Client Maintenance',
    description: 'Patch one VPN client package on remote-user devices.',
    category: 'Patch Automation',
    recommendedSecurityMode: 'tinfoil',
    riskLevel: 'high',
    tags: ['vpn', 'remote-access'],
    trigger: { type: 'schedule' },
    schedule: { cron: '0 2 * * 6', timezone: 'UTC', maintenanceWindow: { daysOfWeek: [6], startHourUtc: 2, endHourUtc: 4 } },
    conditions: { combinator: 'AND', conditions: [
      { field: 'device.group', operator: 'eq', value: '$input.targetDeviceGroup' },
      { field: 'package.name', operator: 'eq', value: '$input.packageName' },
      { field: 'package.outdated', operator: 'eq', value: true },
      { field: 'currentTime.maintenanceWindow', operator: 'eq', value: true },
    ] },
    actions: [
      { type: 'create_patch_task', mode: 'specific_package', packageName: '$input.packageName', targetVersion: 'latest', maxDevices: '$input.maxDevices' as any },
      { type: 'notify', channel: 'siem', message: 'VPN client patch draft created' },
    ],
    requiredInputs: [groupInput, { ...packageNameInput, defaultValue: 'FortiClient VPN' }, { ...maintenanceWindowInput, defaultValue: { daysOfWeek: [6], startHourUtc: 2, endHourUtc: 4 } }, { ...maxDevicesInput, defaultValue: 10 }],
    explanation: ['patch only the named VPN client', 'notify security monitoring'],
    safety: ['specific package required', 'high-risk approvals apply'],
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
    name: 'Production Package Window',
    description: 'Patch one named production package only inside an explicit maintenance window.',
    category: 'Compliance',
    recommendedSecurityMode: 'tinfoil',
    riskLevel: 'high',
    tags: ['production', 'maintenance-window', 'specific-package'],
    trigger: { type: 'schedule' },
    schedule: { cron: '0 3 * * 0', timezone: 'UTC', maintenanceWindow: { daysOfWeek: [0], startHourUtc: 3, endHourUtc: 5 } },
    conditions: { combinator: 'AND', conditions: [
      { field: 'device.group', operator: 'eq', value: 'production' },
      { field: 'package.name', operator: 'eq', value: '$input.packageName' },
      { field: 'package.outdated', operator: 'eq', value: true },
      { field: 'currentTime.maintenanceWindow', operator: 'eq', value: true },
    ] },
    actions: [{ type: 'create_patch_task', mode: 'specific_package', packageName: '$input.packageName', targetVersion: 'latest', maxDevices: '$input.maxDevices' as any }],
    requiredInputs: [{ ...packageNameInput, defaultValue: 'Microsoft Edge' }, maintenanceWindowInput, { ...maxDevicesInput, defaultValue: 5 }],
    explanation: ['patch only one named production package', 'create drafts only during the configured window'],
    safety: ['specific package required', 'max 5 devices by default', 'tinfoil approval defaults'],
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
  {
    id: 'retry-failed-updates',
    name: 'Retry Failed Package Update',
    description: 'Retry one named package after a transient failure with capped exponential backoff.',
    category: 'Failure Handling',
    recommendedSecurityMode: 'strict',
    riskLevel: 'medium',
    tags: ['retry', 'failed-task', 'specific-package'],
    trigger: { type: 'event', eventType: 'task.failed' },
    schedule: {},
    conditions: { combinator: 'AND', conditions: [
      { field: 'lastTask.failed', operator: 'eq', value: true },
      { field: 'lastTask.retryCount', operator: 'lt', value: '$input.retryLimit' },
      { field: 'lastTask.failureRetryable', operator: 'eq', value: true },
      { field: 'package.name', operator: 'eq', value: '$input.packageName' },
      { field: 'package.outdated', operator: 'eq', value: true },
    ] },
    actions: [{ type: 'create_patch_task', mode: 'specific_package', packageName: '$input.packageName', targetVersion: 'latest', retryLimit: '$input.retryLimit' as any, backoff: 'exponential', maxDevices: 1 }],
    requiredInputs: [packageNameInput, retryLimitInput],
    explanation: ['retry only the named package', 'create at most one retry draft'],
    safety: ['exponential backoff', 'retry count prevents loops', 'no all-outdated retry'],
  },
  {
    id: 'repeated-failure-inventory-reset',
    name: 'Repeated Failure Inventory Reset',
    description: 'Refresh inventory and notify SIEM after repeated update failures.',
    category: 'Failure Handling',
    recommendedSecurityMode: 'strict',
    riskLevel: 'low',
    tags: ['failure', 'inventory', 'siem'],
    trigger: { type: 'event', eventType: 'task.failed' },
    schedule: {},
    conditions: { combinator: 'AND', conditions: [
      { field: 'lastTask.failed', operator: 'eq', value: true },
      { field: 'lastTask.retryCount', operator: 'gte', value: 2 },
    ] },
    actions: [
      { type: 'create_security_task', task: 'refresh_inventory' },
      { type: 'notify', channel: 'siem', message: 'Inventory refresh created after repeated patch failures' },
    ],
    requiredInputs: [],
    explanation: ['refresh inventory instead of blindly retrying patches', 'notify SIEM after repeated failures'],
    safety: ['no package execution action', 'breaks retry loops'],
  },
  {
    id: 'failed-task-siem-escalation',
    name: 'Failed Task SIEM Escalation',
    description: 'Escalate repeated failed tasks without creating new patch work.',
    category: 'Failure Handling',
    recommendedSecurityMode: 'normal',
    riskLevel: 'low',
    tags: ['failure', 'siem', 'tag'],
    trigger: { type: 'event', eventType: 'task.failed' },
    schedule: {},
    conditions: { combinator: 'AND', conditions: [
      { field: 'lastTask.failed', operator: 'eq', value: true },
      { field: 'lastTask.retryCount', operator: 'gte', value: 2 },
    ] },
    actions: [
      { type: 'mark_device', tag: 'patch-failure-review' },
      { type: 'notify', channel: 'siem', message: 'Device marked for patch failure review' },
    ],
    requiredInputs: [],
    explanation: ['tag devices after repeated failures', 'notify SIEM for manual follow-up'],
    safety: ['no retry task created', 'metadata-only device mark'],
  },
  {
    id: 'inventory-before-maintenance',
    name: 'Inventory Before Maintenance',
    description: 'Refresh stale inventory shortly before a patch window.',
    category: 'Security / Inventory',
    recommendedSecurityMode: 'normal',
    riskLevel: 'low',
    tags: ['inventory', 'preflight'],
    trigger: { type: 'schedule' },
    schedule: { cron: '0 0 * * 0', timezone: 'UTC' },
    conditions: { combinator: 'AND', conditions: [
      { field: 'device.group', operator: 'eq', value: '$input.targetDeviceGroup' },
      { field: 'device.lastInventoryAgeHours', operator: 'gt', value: 12 },
    ] },
    actions: [{ type: 'create_security_task', task: 'refresh_inventory' }],
    requiredInputs: [groupInput],
    explanation: ['refresh stale inventory before patch decisions are made'],
    safety: ['no package update action', 'uses signed inventory task'],
  },
  {
    id: 'low-trust-inventory-refresh',
    name: 'Low-Trust Inventory Refresh',
    description: 'Refresh and tag devices whose trust score drops below a review threshold.',
    category: 'Security / Inventory',
    recommendedSecurityMode: 'strict',
    riskLevel: 'low',
    tags: ['trust', 'inventory', 'review'],
    trigger: { type: 'event', eventType: 'device.inventory.updated' },
    schedule: {},
    conditions: { combinator: 'AND', conditions: [
      { field: 'device.deviceTrustScore', operator: 'lt', value: 60 },
    ] },
    actions: [
      { type: 'create_security_task', task: 'refresh_inventory' },
      { type: 'mark_device', tag: 'trust-review' },
      { type: 'notify', channel: 'siem', message: 'Low-trust device inventory refresh requested' },
    ],
    requiredInputs: [],
    explanation: ['refresh questionable inventory', 'tag the device for review', 'notify SIEM'],
    safety: ['no package execution action', 'metadata tag only'],
  },
  {
    id: 'stale-inventory-notification',
    name: 'Stale Inventory Notification',
    description: 'Notify SIEM when devices in a group have stale inventory.',
    category: 'Notifications',
    recommendedSecurityMode: 'normal',
    riskLevel: 'low',
    tags: ['inventory', 'notification'],
    trigger: { type: 'schedule' },
    schedule: { cron: '0 8 * * *', timezone: 'UTC' },
    conditions: { combinator: 'AND', conditions: [
      { field: 'device.group', operator: 'eq', value: '$input.targetDeviceGroup' },
      { field: 'device.lastInventoryAgeHours', operator: 'gt', value: 72 },
    ] },
    actions: [{ type: 'notify', channel: 'siem', message: 'Stale device inventory detected' }],
    requiredInputs: [groupInput],
    explanation: ['notify without creating tasks', 'surface stale inventory for operations review'],
    safety: ['notification only', 'no endpoint execution'],
  },
  {
    id: 'production-hotfix-window',
    name: 'Production Hotfix Window',
    description: 'Create tightly capped production hotfix drafts for one critical package.',
    category: 'Compliance',
    recommendedSecurityMode: 'tinfoil',
    riskLevel: 'critical',
    tags: ['production', 'hotfix', 'critical'],
    trigger: { type: 'event', eventType: 'vulnerability.detected' },
    schedule: { maintenanceWindow: { daysOfWeek: [0], startHourUtc: 3, endHourUtc: 5 } },
    conditions: { combinator: 'AND', conditions: [
      { field: 'device.group', operator: 'eq', value: 'production' },
      { field: 'package.name', operator: 'eq', value: '$input.packageName' },
      { field: 'package.severity', operator: 'eq', value: 'critical' },
      { field: 'package.outdated', operator: 'eq', value: true },
      { field: 'currentTime.maintenanceWindow', operator: 'eq', value: true },
    ] },
    actions: [
      { type: 'create_patch_task', mode: 'specific_package', packageName: '$input.packageName', targetVersion: 'latest', maxDevices: '$input.maxDevices' as any },
      { type: 'notify', channel: 'siem', message: 'Production critical hotfix draft created' },
    ],
    requiredInputs: [packageNameInput, maintenanceWindowInput, { ...maxDevicesInput, defaultValue: 3 }],
    explanation: ['patch only the named critical production package', 'notify SIEM immediately'],
    safety: ['critical risk approval path', 'max 3 devices by default', 'maintenance window required'],
  },
  {
    id: 'block-production-outside-window',
    name: 'Block Production Outside Window',
    description: 'Block production task candidates outside the configured maintenance window.',
    category: 'Compliance',
    recommendedSecurityMode: 'tinfoil',
    riskLevel: 'low',
    tags: ['production', 'guardrail', 'maintenance-window'],
    trigger: { type: 'event', eventType: 'rule.task_candidate.created' },
    schedule: { maintenanceWindow: { daysOfWeek: [0], startHourUtc: 3, endHourUtc: 5 } },
    conditions: { combinator: 'AND', conditions: [
      { field: 'device.group', operator: 'eq', value: 'production' },
      { field: 'currentTime.maintenanceWindow', operator: 'eq', value: false },
    ] },
    actions: [
      { type: 'block_task_creation', reason: 'Production task candidate outside maintenance window' },
      { type: 'notify', channel: 'siem', message: 'Blocked production task outside maintenance window' },
    ],
    requiredInputs: [maintenanceWindowInput],
    explanation: ['block instead of creating endpoint work', 'notify SIEM on policy violation'],
    safety: ['no executable task created', 'guardrail action only'],
  },
  {
    id: 'low-trust-automation-block',
    name: 'Low-Trust Automation Block',
    description: 'Block task candidates for low-trust devices or high-risk automation.',
    category: 'Compliance',
    recommendedSecurityMode: 'tinfoil',
    riskLevel: 'low',
    tags: ['trust', 'block', 'guardrail'],
    trigger: { type: 'event', eventType: 'rule.task_candidate.created' },
    schedule: {},
    conditions: { combinator: 'OR', conditions: [
      { field: 'device.deviceTrustScore', operator: 'lt', value: 40 },
      { field: 'riskScore', operator: 'gte', value: 80 },
      { field: 'task.sourceHostTrusted', operator: 'eq', value: false },
      { field: 'task.hashPresent', operator: 'eq', value: false },
    ] },
    actions: [
      { type: 'block_task_creation', reason: 'Low-trust or high-risk automation candidate' },
      { type: 'notify', channel: 'siem', message: 'Blocked low-trust automation candidate' },
    ],
    requiredInputs: [],
    explanation: ['block risky automation candidates', 'notify SIEM with audit context'],
    safety: ['no hidden task', 'no arbitrary command', 'blocks instead of executes'],
  },
];
