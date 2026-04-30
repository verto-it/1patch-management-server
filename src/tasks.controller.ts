import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { v4 as uuid } from 'uuid';
import { AuditService } from './audit/audit.service';
import { MemoryStore } from './storage/memory.store';
import { UpdateTask } from './types';
import { AdminApiGuard } from './security/admin-api.guard';

@ApiTags('tasks')
@UseGuards(AdminApiGuard)
@Controller('/tasks')
export class TasksController {
  constructor(private readonly store: MemoryStore, private readonly audit: AuditService) {}

  @Get()
  list() {
    return this.store.tasks;
  }

  @Post('/refresh-inventory/:deviceId')
  refreshInventory(@Param('deviceId') deviceId: string) {
    const device = this.store.devices.find((candidate) => candidate.id === deviceId);
    if (!device) throw new BadRequestException('Unknown device');
    const node = device.preferredNodeId
      ? this.store.backendNodes.find((candidate) => candidate.id === device.preferredNodeId)
      : this.store.backendNodes.find((candidate) => candidate.status === 'online');
    if (!node) throw new BadRequestException('No backend node is available for this device');
    const task: UpdateTask = {
      id: uuid(),
      nodeId: node.id,
      deviceId,
      type: 'refresh_inventory',
      targetVersion: 'latest',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.store.tasks.push(task);
    void this.store.persist();
    this.audit.record('system', 'task.refresh_inventory_created', task.id, { ...task });
    return task;
  }

  @Get('/node/:nodeId/pending')
  pendingForNode(@Param('nodeId') nodeId: string) {
    const now = new Date().toISOString();
    const tasks = this.store.tasks.filter((task) => task.nodeId === nodeId && task.status === 'pending');
    for (const task of tasks) {
      task.status = 'dispatched';
      task.dispatchedAt = now;
    }
    void this.store.persist();
    if (tasks.length > 0) this.audit.record(nodeId, 'task.dispatched_to_node', nodeId, { count: tasks.length });
    return { tasks };
  }

  @Post('/result')
  result(@Body() dto: { deviceId: string; taskId: string; status: 'completed' | 'failed' | 'rejected'; output?: string }) {
    const task = this.store.tasks.find((candidate) => candidate.id === dto.taskId);
    if (!task) throw new BadRequestException('Unknown task');
    task.status = dto.status;
    task.output = dto.output;
    task.completedAt = new Date().toISOString();
    void this.store.persist();
    this.audit.record(dto.deviceId, `task.${dto.status}`, task.id, { output: dto.output });
    if (dto.status === 'failed' || dto.status === 'rejected') {
      this.store.alarms.unshift({
        id: uuid(),
        deviceId: dto.deviceId,
        severity: dto.status === 'failed' ? 'critical' : 'warning',
        message: `Task ${dto.status}: ${task.appName ?? task.type}`,
        createdAt: new Date().toISOString(),
        metadata: { taskId: task.id, output: dto.output },
      });
    }
    return task;
  }
}
