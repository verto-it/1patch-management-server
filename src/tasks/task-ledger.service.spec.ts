import { TaskLedgerService } from './task-ledger.service';
import { UpdateTask } from '../types';

describe('TaskLedgerService task hashing', () => {
  const baseTask: UpdateTask = {
    id: 'task-1',
    nodeId: 'node-1',
    deviceId: 'device-1',
    type: 'update_package',
    appName: 'Git',
    packageId: 'git',
    targetVersion: 'latest',
    status: 'draft',
    createdAt: '2026-05-10T00:00:00.000Z',
  };

  it('keeps legacy hashes unchanged when package manager metadata is absent', () => {
    expect(TaskLedgerService.computeTaskHash(baseTask)).toBe(TaskLedgerService.computeLegacyTaskHash(baseTask));
  });

  it('includes package manager metadata for new signed tasks', () => {
    const managerTask: UpdateTask = {
      ...baseTask,
      packageManager: 'chocolatey',
      packageScope: 'system',
    };

    expect(TaskLedgerService.computeTaskHash(managerTask)).not.toBe(TaskLedgerService.computeLegacyTaskHash(managerTask));
  });
});
