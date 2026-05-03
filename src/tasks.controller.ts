import { BadRequestException, Body, Controller, Delete, Get, Logger, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { v4 as uuid } from 'uuid';
import { AuditService } from './audit/audit.service';
import { AdminApiGuard } from './security/admin-api.guard';
import { NodeApiGuard } from './security/node-api.guard';
import { MemoryStore } from './storage/memory.store';
import { UpdateTask } from './types';
import { NodesService } from './nodes/nodes.service';

@ApiTags('tasks')
@Controller('/tasks')
export class TasksController {
  private readonly logger = new Logger(TasksController.name);

  constructor(private readonly store: MemoryStore, private readonly audit: AuditService, private readonly nodes: NodesService) {}

  @UseGuards(AdminApiGuard)
  @Get()
  list() {
    this.logger.debug(`Listing ${this.store.tasks.length} task(s)`);
    return this.store.tasks;
  }

  @UseGuards(AdminApiGuard)
  @Post('/refresh-inventory/:deviceId')
  refreshInventory(@Param('deviceId') deviceId: string) {
    const device = this.store.devices.find((d) => d.id === deviceId);
    if (!device) throw new BadRequestException('Unknown device');
    const node = this.nodes.availableNode(device.preferredNodeId);
    if (!node) throw new BadRequestException('No backend node is available for this device');
    const task: UpdateTask = {
      id: uuid(), nodeId: node.id, deviceId,
      type: 'refresh_inventory', targetVersion: 'latest',
      status: 'pending', createdAt: new Date().toISOString(),
    };
    this.store.tasks.push(task);
    void this.store.persist();
    this.audit.record('system', 'task.refresh_inventory_created', task.id, { deviceId, nodeId: node.id });
    this.logger.log(`Refresh-inventory task created: taskId=${task.id} deviceId=${deviceId} nodeId=${node.id}`);
    return task;
  }

  @UseGuards(AdminApiGuard)
  @Delete('/:id')
  cancel(@Param('id') id: string) {
    const task = this.store.tasks.find((t) => t.id === id);
    if (!task) throw new BadRequestException('Unknown task');
    if (task.status !== 'pending') throw new BadRequestException(`Cannot cancel a task with status '${task.status}'`);
    task.status = 'cancelled';
    task.completedAt = new Date().toISOString();
    void this.store.persist();
    this.audit.record('system', 'task.cancelled', task.id, {});
    this.logger.log(`Task cancelled: taskId=${id}`);
    return task;
  }

  @UseGuards(NodeApiGuard)
  @Get('/node/:nodeId/pending')
  pendingForNode(@Param('nodeId') nodeId: string) {
    const now = new Date().toISOString();
    const tasks = this.store.tasks.filter((t) => t.nodeId === nodeId && t.status === 'pending');
    for (const task of tasks) {
      task.status = 'dispatched';
      task.dispatchedAt = now;
    }
    void this.store.persist();
    if (tasks.length > 0) {
      this.audit.record(nodeId, 'task.dispatched_to_node', nodeId, { count: tasks.length });
      this.logger.log(`Dispatched ${tasks.length} task(s) to nodeId=${nodeId}`);
    } else {
      this.logger.debug(`No pending tasks for nodeId=${nodeId}`);
    }
    return { tasks };
  }

  @UseGuards(AdminApiGuard)
  @Post('/result')
  result(@Body() dto: { deviceId: string; taskId: string; status: 'completed' | 'failed' | 'rejected'; output?: string }) {
    const task = this.store.tasks.find((t) => t.id === dto.taskId);
    if (!task) throw new BadRequestException('Unknown task');
    task.status = dto.status;
    task.output = dto.output;
    task.completedAt = new Date().toISOString();
    void this.store.persist();
    this.audit.record(dto.deviceId, `task.${dto.status}`, task.id, { output: dto.output });
    this.logger.log(`Task result recorded: taskId=${dto.taskId} deviceId=${dto.deviceId} status=${dto.status}`);
    if (dto.output) this.logger.debug(`Task ${dto.taskId} output: ${dto.output}`);
    if (dto.status === 'failed' || dto.status === 'rejected') {
      this.logger.warn(`Task ${dto.status} alarm: taskId=${dto.taskId} deviceId=${dto.deviceId}`);
      this.store.alarms.unshift({
        id: uuid(), deviceId: dto.deviceId,
        severity: dto.status === 'failed' ? 'critical' : 'warning',
        message: `Task ${dto.status}: ${task.appName ?? task.type}`,
        createdAt: new Date().toISOString(),
        metadata: { taskId: task.id, output: dto.output },
      });
    }
    return task;
  }
}
