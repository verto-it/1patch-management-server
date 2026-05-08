import { BadRequestException } from '@nestjs/common';
import { RuleTemplatesService } from './rule-templates.service';
import { RulesService } from './rules.service';
import { User } from '../types';

const actor: User = {
  id: 'admin-1',
  email: 'admin@example.com',
  passwordHash: '',
  roles: ['admin'],
  mfaEnabled: true,
  recoveryCodeHashes: [],
  failedAttempts: 0,
  oauthLinks: [],
};

function makeStore(): any {
  return {
    rules: [],
    ruleTemplates: [],
    devices: [
      { id: 'dev-1', tenantId: 'default', hostname: 'test-win-01', os: 'windows', publicKey: 'pk', preferredNodeId: 'node-1', group: 'test', deviceTrustScore: 80 },
      { id: 'dev-2', tenantId: 'default', hostname: 'prod-win-01', os: 'windows', publicKey: 'pk', preferredNodeId: 'node-1', group: 'production', deviceTrustScore: 60 },
    ],
    installedApps: [
      { deviceId: 'dev-1', name: 'Google Chrome', publisher: 'Google', version: '120.0.0', packageId: 'Google.Chrome', severity: 'critical' },
      { deviceId: 'dev-2', name: 'Google Chrome', publisher: 'Google', version: '120.0.0', packageId: 'Google.Chrome', severity: 'critical' },
      { deviceId: 'dev-1', name: 'Google Chrome', publisher: 'Google', version: '125.0.0', packageId: 'Google.Chrome', severity: 'critical' },
    ],
    tasks: [],
    persist: jest.fn(),
  };
}

function makeTemplateService(mode: 'normal' | 'strict' | 'tinfoil' = 'normal') {
  const store = makeStore();
  const audit = { record: jest.fn() };
  const siem = { emit: jest.fn() };
  const policy = { get: jest.fn(() => ({ tenantId: 'default', securityMode: mode })) };
  return { service: new RuleTemplatesService(store as any, audit as any, siem as any, policy as any), store, audit, siem };
}

function makeRulesService(store: any) {
  const audit = { record: jest.fn() };
  const siem = { emit: jest.fn() };
  const nodes = { availableNode: jest.fn(() => ({ id: 'node-1' })) };
  const taskAuth = {
    createDraft: jest.fn((params) => {
      const task = { ...params, id: `task-${store.tasks.length + 1}`, status: 'draft', createdAt: new Date().toISOString() };
      store.tasks.push(task);
      return task;
    }),
    runSecurityScan: jest.fn(async (id) => {
      const task = store.tasks.find((candidate: any) => candidate.id === id);
      task.status = 'security_scanned';
      task.securityScanResult = { riskScore: 10, severity: 'low', hardBlock: false, findings: [], humanReadableSummary: 'ok', scannedAt: new Date().toISOString(), taskId: id };
      return task;
    }),
  };
  return { service: new RulesService(store, audit as any, siem as any, nodes as any, taskAuth as any), taskAuth };
}

describe('RuleTemplatesService', () => {
  it('generates a valid disabled rule draft from a template', () => {
    const { service } = makeTemplateService();

    const result = service.createDraft('weekly-browser-updates', {
      targetDeviceGroup: 'test',
      maintenanceWindow: { daysOfWeek: [0], startHourUtc: 3, endHourUtc: 5 },
    }, actor);

    expect(result.draftRule.enabled).toBe(false);
    expect(result.draftRule.sourceTemplateId).toBe('weekly-browser-updates');
    expect(result.preview.summary.join(' ')).toContain('security scan');
    expect(result.draftRule.conditionGroup?.conditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'device.group', value: 'test' }),
    ]));
  });

  it('fails validation when required template input is missing', () => {
    const { service } = makeTemplateService();

    expect(() => service.createDraft('weekly-browser-updates', {}, actor))
      .toThrow('Missing required template input: targetDeviceGroup');
  });

  it('keeps generated rules on the normal task signing and security pipeline', async () => {
    const { service: templates, store } = makeTemplateService();
    const { service: rules, taskAuth } = makeRulesService(store);
    const draft = templates.createDraft('patch-test-group-first', {
    }, actor).draftRule;
    const saved = rules.create({ ...draft, enabled: true }, actor);

    await rules.trigger(saved.id, actor, 'dev-1');

    expect(taskAuth.createDraft).toHaveBeenCalled();
    expect(taskAuth.runSecurityScan).toHaveBeenCalledWith('task-1', actor);
    expect(store.tasks[0].status).toBe('security_scanned');
  });

  it('tightens defaults in strict and tinfoil mode', () => {
    const strict = makeTemplateService('strict').service.createDraft('weekly-browser-updates', {
      targetDeviceGroup: 'test',
    }, actor).draftRule;
    const tinfoil = makeTemplateService('tinfoil').service.createDraft('weekly-browser-updates', {
      targetDeviceGroup: 'test',
    }, actor).draftRule;

    expect(strict.safeMode?.requireApprovalAtRiskScore).toBe(50);
    expect((strict.actions?.[0] as any).maxDevices).toBe(10);
    expect(tinfoil.safeMode?.requireApprovalAtRiskScore).toBe(40);
    expect((tinfoil.actions?.[0] as any).maxDevices).toBe(5);
  });

  it('rejects custom templates that try to produce arbitrary command actions', () => {
    const { service } = makeTemplateService();

    expect(() => service.importCustom({
      id: 'unsafe',
      name: 'Unsafe',
      description: 'bad',
      trigger: { type: 'manual' },
      conditions: { combinator: 'AND', conditions: [] },
      actions: [{ type: 'command', command: 'calc.exe' }],
      schedule: {},
    }, actor)).toThrow(BadRequestException);
  });

  it('imports a valid custom template after schema validation', () => {
    const { service, store } = makeTemplateService();

    const template = service.importCustom({
      id: 'notify-admin',
      name: 'Notify Admin',
      description: 'Notify via SIEM',
      category: 'Notifications',
      trigger: { type: 'manual' },
      conditions: { combinator: 'AND', conditions: [] },
      actions: [{ type: 'notify', channel: 'siem', message: 'hello' }],
      schedule: {},
    }, actor);

    expect(template.id).toBe('custom-notify-admin');
    expect(store.ruleTemplates).toHaveLength(1);
  });
});
