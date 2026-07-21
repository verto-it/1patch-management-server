import { RulesService } from './rules.service';
import { PatchRule, User } from '../types';

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

/**
 * Handles the make service operation.
 * @returns The result produced by the operation.
 */
function makeService() {
  const store: any = {
    rules: [],
    devices: [
      { id: 'dev-1', tenantId: 'default', hostname: 'prod-win-01', os: 'windows', publicKey: 'pk', preferredNodeId: 'node-1', group: 'production', deviceTrustScore: 65 },
      { id: 'dev-2', tenantId: 'default', hostname: 'lab-linux-01', os: 'linux', publicKey: 'pk', preferredNodeId: 'node-1', group: 'lab', deviceTrustScore: 95 },
      { id: 'dev-3', tenantId: 'default', hostname: 'stage-win-01', os: 'windows', publicKey: 'pk', preferredNodeId: 'node-1', group: 'stage', deviceTrustScore: 90 },
    ],
    installedApps: [
      { deviceId: 'dev-1', name: 'Google Chrome', publisher: 'Google', version: '120.0.0', packageId: 'Google.Chrome', packageManager: 'winget', packageScope: 'system' },
      { deviceId: 'dev-2', name: 'Google Chrome', publisher: 'Google', version: '124.0.0', packageId: 'Google.Chrome', packageManager: 'winget', packageScope: 'system' },
      { deviceId: 'dev-3', name: 'Google Chrome', publisher: 'Google', version: '124.0.0', packageId: 'Google.Chrome' },
    ],
    tasks: [],
    persist: jest.fn(),
  };
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
    autoFinalizeAfterScan: jest.fn((id) => {
      const task = store.tasks.find((candidate: any) => candidate.id === id);
      if (!task || task.status !== 'security_scanned' || task.securityScanResult?.hardBlock) return task;
      task.status = 'signed';
      task.ledgerEntryId = `ledger-${id}`;
      return task;
    }),
  };
  return { service: new RulesService(store, audit as any, siem as any, nodes as any, taskAuth as any), store, taskAuth, siem };
}

describe('RulesService', () => {
  it('evaluates composable AND/OR condition groups', () => {
    const { service } = makeService();
    const rule = service.create({
      name: 'Production Windows Chrome',
      conditionGroup: {
        combinator: 'AND',
        conditions: [
          { field: 'device.os', operator: 'eq', value: 'windows' },
          {
            combinator: 'OR',
            conditions: [
              { field: 'device.group', operator: 'eq', value: 'production' },
              { field: 'device.hostname', operator: 'matches', value: '^prod-' },
            ],
          },
          { field: 'package.outdated', operator: 'eq', value: true },
        ],
      },
      actions: [{ type: 'create_patch_task', mode: 'all_outdated', targetVersion: 'latest' }],
    }, actor);

    expect(service.simulate(rule.id, 'dev-1').wouldTrigger).toBe(true);
    expect(service.simulate(rule.id, 'dev-2').wouldTrigger).toBe(false);
  });

  it('generates scanned drafts and auto-finalizes them when MFA approval is not required', async () => {
    const { service, taskAuth, store } = makeService();
    const rule = service.create({
      name: 'Patch outdated Chrome',
      conditionGroup: { combinator: 'AND', conditions: [{ field: 'package.outdated', operator: 'eq', value: true }] },
      actions: [{ type: 'create_patch_task', mode: 'all_outdated', targetVersion: 'latest' }],
    }, actor);

    const records = await service.trigger(rule.id, actor, 'dev-1');

    expect(taskAuth.createDraft).toHaveBeenCalledWith(expect.objectContaining({ type: 'update_package', appName: 'Google Chrome', packageManager: 'winget', packageScope: 'system' }), actor);
    expect(taskAuth.runSecurityScan).toHaveBeenCalledWith('task-1', actor);
    expect(taskAuth.autoFinalizeAfterScan).toHaveBeenCalledWith('task-1', actor);
    expect(records[0].taskIds).toEqual(['task-1']);
    // Rule-created tasks must not sit stuck at `security_scanned`; they advance
    // to a signed/executable state so an authorized rule run actually deploys.
    expect(store.tasks[0].status).toBe('signed');
    expect(store.tasks[0].ledgerEntryId).toBe('ledger-task-1');
  });

  it('does not mark Windows packages outdated from Linux-only newer versions', () => {
    const { service, store } = makeService();
    store.devices = store.devices.filter((device: any) => device.id !== 'dev-3');
    store.installedApps = [
      { deviceId: 'dev-1', name: 'Google Chrome', publisher: 'Google', version: '120.0.0', packageId: 'Google.Chrome' },
      { deviceId: 'dev-2', name: 'Google Chrome', publisher: 'Google', version: '124.0.0', packageId: 'google-chrome-stable' },
    ];
    const rule = service.create({
      name: 'Outdated only',
      conditionGroup: { combinator: 'AND', conditions: [{ field: 'package.outdated', operator: 'eq', value: true }] },
      actions: [{ type: 'create_patch_task', mode: 'all_outdated', targetVersion: 'latest' }],
    }, actor);

    expect(service.simulate(rule.id, 'dev-1').wouldTrigger).toBe(false);
  });

  it('keeps specific-package actions scoped to the selected package names', async () => {
    const { service, taskAuth, store } = makeService();
    store.installedApps.push(
      { deviceId: 'dev-1', name: 'Microsoft Edge', publisher: 'Microsoft', version: '118.0.0', packageId: 'Microsoft.Edge' },
      { deviceId: 'dev-2', name: 'Microsoft Edge', publisher: 'Microsoft', version: '124.0.0', packageId: 'Microsoft.Edge' },
      { deviceId: 'dev-3', name: 'Microsoft Edge', publisher: 'Microsoft', version: '124.0.0', packageId: 'Microsoft.Edge' },
    );
    const rule = service.create({
      name: 'Browser ring',
      conditionGroup: { combinator: 'AND', conditions: [{ field: 'package.outdated', operator: 'eq', value: true }] },
      actions: [{ type: 'create_patch_task', mode: 'specific_package', packageNames: ['Google Chrome'], targetVersion: 'latest' }],
    }, actor);

    await service.trigger(rule.id, actor, 'dev-1');

    expect(taskAuth.createDraft).toHaveBeenCalledTimes(1);
    expect(taskAuth.createDraft).toHaveBeenCalledWith(expect.objectContaining({ appName: 'Google Chrome' }), actor);
    expect(store.tasks).toHaveLength(1);
  });

  it('does not create a specific-package draft when only another package is outdated', async () => {
    const { service, taskAuth, store } = makeService();
    store.installedApps = [
      { deviceId: 'dev-1', name: 'Google Chrome', publisher: 'Google', version: '124.0.0', packageId: 'Google.Chrome' },
      { deviceId: 'dev-2', name: 'Google Chrome', publisher: 'Google', version: '124.0.0', packageId: 'Google.Chrome' },
      { deviceId: 'dev-3', name: 'Google Chrome', publisher: 'Google', version: '124.0.0', packageId: 'Google.Chrome' },
      { deviceId: 'dev-1', name: 'Microsoft Edge', publisher: 'Microsoft', version: '118.0.0', packageId: 'Microsoft.Edge' },
      { deviceId: 'dev-2', name: 'Microsoft Edge', publisher: 'Microsoft', version: '124.0.0', packageId: 'Microsoft.Edge' },
      { deviceId: 'dev-3', name: 'Microsoft Edge', publisher: 'Microsoft', version: '124.0.0', packageId: 'Microsoft.Edge' },
    ];
    const rule = service.create({
      name: 'Chrome only',
      conditionGroup: { combinator: 'AND', conditions: [{ field: 'package.outdated', operator: 'eq', value: true }] },
      actions: [{ type: 'create_patch_task', mode: 'specific_package', packageName: 'Google Chrome', targetVersion: 'latest' }],
    }, actor);

    const records = await service.trigger(rule.id, actor, 'dev-1');

    expect(records[0].matched).toBe(true);
    expect(records[0].taskIds).toEqual([]);
    expect(taskAuth.createDraft).not.toHaveBeenCalled();
  });

  it('reports conflicts deterministically instead of creating duplicate active tasks', async () => {
    const { service, taskAuth, store } = makeService();
    store.tasks.push({ id: 'existing', deviceId: 'dev-1', type: 'update_package', appName: 'Google Chrome', packageId: 'Google.Chrome', packageManager: 'winget', packageScope: 'system', status: 'security_scanned', createdAt: new Date().toISOString() });
    const rule = service.create({
      name: 'Patch outdated Chrome',
      conditionGroup: { combinator: 'AND', conditions: [{ field: 'package.outdated', operator: 'eq', value: true }] },
      actions: [{ type: 'create_patch_task', mode: 'all_outdated' }],
    }, actor);

    const records = await service.trigger(rule.id, actor, 'dev-1');

    expect(taskAuth.createDraft).not.toHaveBeenCalled();
    expect(records[0].conflicts).toHaveLength(1);
  });

  it('skips per-user Scoop packages when creating rule drafts', async () => {
    const { service, taskAuth, store } = makeService();
    store.installedApps = [
      { deviceId: 'dev-1', name: 'Git', publisher: 'Scoop', version: '2.44.0', packageId: 'git', packageManager: 'scoop', packageScope: 'user' },
      { deviceId: 'dev-2', name: 'Git', publisher: 'Scoop', version: '2.45.0', packageId: 'git', packageManager: 'scoop', packageScope: 'user' },
      { deviceId: 'dev-3', name: 'Git', publisher: 'Scoop', version: '2.45.0', packageId: 'git', packageManager: 'scoop', packageScope: 'user' },
    ];
    const rule = service.create({
      name: 'Patch outdated user Scoop',
      conditionGroup: { combinator: 'AND', conditions: [{ field: 'package.outdated', operator: 'eq', value: true }] },
      actions: [{ type: 'create_patch_task', mode: 'all_outdated' }],
    }, actor);

    const records = await service.trigger(rule.id, actor, 'dev-1');

    expect(records[0].matched).toBe(true);
    expect(records[0].taskIds).toEqual([]);
    expect(taskAuth.createDraft).not.toHaveBeenCalled();
  });

  it('does not treat different package managers as duplicate active conflicts', async () => {
    const { service, taskAuth, store } = makeService();
    store.installedApps = [
      { deviceId: 'dev-1', name: 'Git', publisher: 'Chocolatey', version: '2.44.0', packageId: 'git', packageManager: 'chocolatey', packageScope: 'system' },
      { deviceId: 'dev-2', name: 'Git', publisher: 'Chocolatey', version: '2.45.0', packageId: 'git', packageManager: 'chocolatey', packageScope: 'system' },
      { deviceId: 'dev-3', name: 'Git', publisher: 'Chocolatey', version: '2.45.0', packageId: 'git', packageManager: 'chocolatey', packageScope: 'system' },
    ];
    store.tasks.push({ id: 'existing', deviceId: 'dev-1', type: 'update_package', appName: 'Git', packageId: 'git', packageManager: 'winget', packageScope: 'system', status: 'security_scanned', createdAt: new Date().toISOString() });
    const rule = service.create({
      name: 'Patch outdated Chocolatey Git',
      conditionGroup: { combinator: 'AND', conditions: [{ field: 'package.outdated', operator: 'eq', value: true }] },
      actions: [{ type: 'create_patch_task', mode: 'all_outdated' }],
    }, actor);

    await service.trigger(rule.id, actor, 'dev-1');

    expect(taskAuth.createDraft).toHaveBeenCalledWith(expect.objectContaining({ appName: 'Git', packageManager: 'chocolatey' }), actor);
  });

  it('marks simulations as rate limited after hourly quota is consumed', () => {
    const { service } = makeService();
    const now = new Date().toISOString();
    const rule = service.create({
      name: 'Limited rule',
      conditionGroup: { combinator: 'AND', conditions: [] },
      actions: [{ type: 'create_security_task', task: 'refresh_inventory' }],
      executionStats: { taskCreatedAt: Array.from({ length: 50 }, () => now), executionLog: [] },
    } as Partial<PatchRule>, actor);

    const simulation = service.simulate(rule.id, 'dev-1');

    expect(simulation.wouldTrigger).toBe(true);
    expect(simulation.rateLimited).toBe(true);
    expect(simulation.approvalRequired).toBe(true);
  });

  it('rejects actions that are not backed by the signed task pipeline', () => {
    const { service } = makeService();

    expect(() => service.create({
      name: 'Unsafe rescan',
      actions: [{ type: 'create_security_task', task: 'rescan_device' }],
    }, actor)).toThrow('rescan_device is reserved');
  });

  it('rejects specific-package actions without an explicit package selector', () => {
    const { service } = makeService();

    expect(() => service.create({
      name: 'Too broad',
      actions: [{ type: 'create_patch_task', mode: 'specific_package', targetVersion: 'latest' }],
    }, actor)).toThrow('Specific package actions require');
  });
});
