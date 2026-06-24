// AGPL-3.0-only
import {
  BadRequestException, Body, Controller, Delete, Get, NotFoundException,
  Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { v4 as uuid } from 'uuid';
import { AuditService } from './audit/audit.service';
import { CurrentUser } from './security/current-user.decorator';
import { JwtAuthGuard } from './security/jwt-auth.guard';
import { RbacGuard } from './security/rbac.guard';
import { RequirePermission } from './security/require-permission.decorator';
import { MemoryStore } from './storage/memory.store';
import { Device, DeviceRetirementPolicy, RetirementPolicyCriterion, RetirementPolicyAction, User } from './types';

@ApiTags('device-retirement')
@UseGuards(JwtAuthGuard, RbacGuard)
@Controller('/devices/retirement-policies')
export class DeviceRetirementController {
  constructor(
    private readonly store: MemoryStore,
    private readonly audit: AuditService,
  ) {}

  @RequirePermission('rules:manage')
  @Get()
  list(@Query('tenantId') tenantId = 'default') {
    return this.store.deviceRetirementPolicies
      .filter(p => p.tenantId === tenantId)
      .sort((a, b) => a.priority - b.priority);
  }

  @RequirePermission('rules:manage')
  @Post()
  async create(@Body() body: CreateRetirementPolicyDto, @CurrentUser() actor: User) {
    validatePolicyBody(body);
    const policy: DeviceRetirementPolicy = {
      id: uuid(),
      tenantId: body.tenantId ?? 'default',
      name: body.name.trim(),
      description: body.description?.trim(),
      enabled: body.enabled ?? true,
      conditionCombinator: body.conditionCombinator ?? 'AND',
      conditions: body.conditions,
      actions: body.actions,
      priority: body.priority ?? this.nextPriority(body.tenantId ?? 'default'),
      createdBy: actor.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.store.deviceRetirementPolicies.push(policy);
    await this.store.persist();
    this.audit.record(actor.id, 'device_retirement_policy.created', policy.id, { name: policy.name, tenantId: policy.tenantId });
    return policy;
  }

  @RequirePermission('rules:manage')
  @Patch('/:id')
  async update(@Param('id') id: string, @Body() body: UpdateRetirementPolicyDto, @CurrentUser() actor: User) {
    const policy = this.requirePolicy(id);
    if (body.name !== undefined) policy.name = body.name.trim();
    if (body.description !== undefined) policy.description = body.description?.trim();
    if (typeof body.enabled === 'boolean') policy.enabled = body.enabled;
    if (body.conditionCombinator) policy.conditionCombinator = body.conditionCombinator;
    if (body.conditions) { validateConditions(body.conditions); policy.conditions = body.conditions; }
    if (body.actions) { validateActions(body.actions); policy.actions = body.actions; }
    if (typeof body.priority === 'number') policy.priority = body.priority;
    policy.updatedAt = new Date().toISOString();
    await this.store.persist();
    this.audit.record(actor.id, 'device_retirement_policy.updated', id, { name: policy.name });
    return policy;
  }

  @RequirePermission('rules:manage')
  @Delete('/:id')
  async remove(@Param('id') id: string, @CurrentUser() actor: User) {
    const index = this.store.deviceRetirementPolicies.findIndex(p => p.id === id);
    if (index === -1) throw new NotFoundException('Retirement policy not found');
    const [removed] = this.store.deviceRetirementPolicies.splice(index, 1);
    await this.store.persist();
    this.audit.record(actor.id, 'device_retirement_policy.deleted', id, { name: removed.name });
    return { deleted: true };
  }

  /** Dry-run: returns devices that match this policy right now */
  @RequirePermission('rules:manage')
  @Post('/:id/evaluate')
  async evaluate(@Param('id') id: string, @CurrentUser() actor: User) {
    const policy = this.requirePolicy(id);
    const devices = this.store.devices.filter(d => d.tenantId === policy.tenantId);
    const matched = devices.filter(d => matchesPolicy(d, policy));

    policy.matchCount = matched.length;
    policy.lastEvaluatedAt = new Date().toISOString();
    await this.store.persist();
    this.audit.record(actor.id, 'device_retirement_policy.evaluated', id, { matchCount: matched.length });

    return {
      policyId: id,
      evaluatedAt: policy.lastEvaluatedAt,
      totalDevices: devices.length,
      matchCount: matched.length,
      matchedDevices: matched.map(d => ({
        id: d.id,
        hostname: d.hostname,
        os: d.os,
        group: d.group,
        tags: d.tags,
        lastSeenAt: d.lastSeenAt,
        deviceTrustScore: d.deviceTrustScore,
        riskScore: d.riskScore,
      })),
    };
  }

  private requirePolicy(id: string): DeviceRetirementPolicy {
    const policy = this.store.deviceRetirementPolicies.find(p => p.id === id);
    if (!policy) throw new NotFoundException('Retirement policy not found');
    return policy;
  }

  private nextPriority(tenantId: string): number {
    const existing = this.store.deviceRetirementPolicies.filter(p => p.tenantId === tenantId);
    return existing.length === 0 ? 10 : Math.max(...existing.map(p => p.priority)) + 10;
  }
}

// ── Matching logic ─────────────────────────────────────────────────────────────

function matchesPolicy(device: Device, policy: DeviceRetirementPolicy): boolean {
  if (!policy.conditions.length) return false;
  const results = policy.conditions.map(c => matchesCriterion(device, c));
  return policy.conditionCombinator === 'AND' ? results.every(Boolean) : results.some(Boolean);
}

function matchesCriterion(device: Device, criterion: RetirementPolicyCriterion): boolean {
  switch (criterion.type) {
    case 'inactive_days': {
      if (!device.lastSeenAt) return true;
      const ageMs = Date.now() - new Date(device.lastSeenAt).getTime();
      return ageMs > criterion.days * 86_400_000;
    }
    case 'os_pattern':
      return device.os?.toLowerCase().includes(criterion.pattern.toLowerCase()) ?? false;
    case 'trust_score_below':
      return (device.deviceTrustScore ?? 100) < criterion.score;
    case 'risk_score_above':
      return (device.riskScore ?? 0) > criterion.score;
    case 'has_tag':
      return (device.tags ?? []).includes(criterion.tag);
    case 'missing_tag':
      return !(device.tags ?? []).includes(criterion.tag);
    case 'in_group':
      return device.group === criterion.group;
    case 'os_family':
      return criterion.os === 'windows'
        ? device.os?.toLowerCase().includes('windows') ?? false
        : !device.os?.toLowerCase().includes('windows');
    default:
      return false;
  }
}

// ── Validation ─────────────────────────────────────────────────────────────────

const VALID_CONDITION_TYPES = new Set([
  'inactive_days', 'os_pattern', 'trust_score_below', 'risk_score_above',
  'has_tag', 'missing_tag', 'in_group', 'os_family',
]);
const VALID_ACTION_TYPES = new Set(['tag_device', 'create_alarm', 'notify']);
const VALID_ALARM_SEVERITIES = new Set(['info', 'warning', 'critical']);

function validateConditions(conditions: RetirementPolicyCriterion[]) {
  if (!Array.isArray(conditions) || conditions.length === 0) {
    throw new BadRequestException('At least one condition is required');
  }
  for (const c of conditions) {
    if (!VALID_CONDITION_TYPES.has(c.type)) {
      throw new BadRequestException(`Unknown condition type: ${c.type}`);
    }
    if (c.type === 'inactive_days' && (typeof (c as any).days !== 'number' || (c as any).days < 1)) {
      throw new BadRequestException('inactive_days requires days >= 1');
    }
    if (c.type === 'trust_score_below' || c.type === 'risk_score_above') {
      const score = (c as any).score;
      if (typeof score !== 'number' || score < 0 || score > 100) {
        throw new BadRequestException(`${c.type} requires score between 0 and 100`);
      }
    }
  }
}

function validateActions(actions: RetirementPolicyAction[]) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new BadRequestException('At least one action is required');
  }
  for (const a of actions) {
    if (!VALID_ACTION_TYPES.has(a.type)) {
      throw new BadRequestException(`Unknown action type: ${a.type}`);
    }
    if (a.type === 'create_alarm' && !VALID_ALARM_SEVERITIES.has((a as any).severity)) {
      throw new BadRequestException('create_alarm requires severity: info | warning | critical');
    }
  }
}

function validatePolicyBody(body: CreateRetirementPolicyDto) {
  if (!body.name?.trim()) throw new BadRequestException('Policy name is required');
  validateConditions(body.conditions);
  validateActions(body.actions);
  if (body.conditionCombinator && !['AND', 'OR'].includes(body.conditionCombinator)) {
    throw new BadRequestException('conditionCombinator must be AND or OR');
  }
}

// ── DTOs ───────────────────────────────────────────────────────────────────────

interface CreateRetirementPolicyDto {
  tenantId?: string;
  name: string;
  description?: string;
  enabled?: boolean;
  conditionCombinator?: 'AND' | 'OR';
  conditions: RetirementPolicyCriterion[];
  actions: RetirementPolicyAction[];
  priority?: number;
}

interface UpdateRetirementPolicyDto {
  name?: string;
  description?: string;
  enabled?: boolean;
  conditionCombinator?: 'AND' | 'OR';
  conditions?: RetirementPolicyCriterion[];
  actions?: RetirementPolicyAction[];
  priority?: number;
}
