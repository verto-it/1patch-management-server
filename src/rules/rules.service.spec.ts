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

function makeService() {
  const store: any = {
    rules: [],
    devices: [
      { id: 'dev-1', tenantId: 'default', hostname: 'prod-win-01', os: 'windows', publicKey: 'pk', preferredNodeId: 'node-1', group: 'production', deviceTrustScore: 65 },
      { id: 'dev-2', tenantId: 'default', hostname: 'lab-linux-01', os: 'linux', publicKey: 'pk', preferredNodeId: 'node-1', group: 'lab', deviceTrustScore: 95 },
    ],
    installedApps: [
      { deviceId: 'dev-1', name: 'Google Chrome', publisher: 'Google', version: '120.0.0', packageId: 'Google.Chrome' },
      { deviceId: 'dev-2', name: 'Google Chrome', publisher: 'Google', version: '124.0.0', packageId: 'Google.Chrome' },
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

  it('generates scanned drafts through the task authorization pipeline', async () => {
    const { service, taskAuth, store } = makeService();
    const rule = service.create({
      name: 'Patch outdated Chrome',
      conditionGroup: { combinator: 'AND', conditions: [{ field: 'package.outdated', operator: 'eq', value: true }] },
      actions: [{ type: 'create_patch_task', mode: 'all_outdated', targetVersion: 'latest' }],
    }, actor);

    const records = await service.trigger(rule.id, actor, 'dev-1');

    expect(taskAuth.createDraft).toHaveBeenCalledWith(expect.objectContaining({ type: 'update_package', appName: 'Google Chrome' }), actor);
    expect(taskAuth.runSecurityScan).toHaveBeenCalledWith('task-1', actor);
    expect(records[0].taskIds).toEqual(['task-1']);
    expect(store.tasks[0].status).toBe('security_scanned');
    expect(store.tasks[0].ledgerEntryId).toBeUndefined();
  });

  it('reports conflicts deterministically instead of creating duplicate active tasks', async () => {
    const { service, taskAuth, store } = makeService();
    store.tasks.push({ id: 'existing', deviceId: 'dev-1', type: 'update_package', appName: 'Google Chrome', packageId: 'Google.Chrome', status: 'security_scanned', createdAt: new Date().toISOString() });
    const rule = service.create({
      name: 'Patch outdated Chrome',
      conditionGroup: { combinator: 'AND', conditions: [{ field: 'package.outdated', operator: 'eq', value: true }] },
      actions: [{ type: 'create_patch_task', mode: 'all_outdated' }],
    }, actor);

    const records = await service.trigger(rule.id, actor, 'dev-1');

    expect(taskAuth.createDraft).not.toHaveBeenCalled();
    expect(records[0].conflicts).toHaveLength(1);
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
});
