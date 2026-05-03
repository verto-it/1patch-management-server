import { BadRequestException, Body, Controller, Delete, Get, Logger, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { v4 as uuid } from 'uuid';
import { AuditService } from './audit/audit.service';
import { CurrentUser } from './security/current-user.decorator';
import { JwtAuthGuard } from './security/jwt-auth.guard';
import { MtlsNodeGuard } from './security/mtls-node.guard';
import { NodeId } from './security/node-id.decorator';
import { RbacGuard } from './security/rbac.guard';
import { RequirePermission } from './security/require-permission.decorator';
import { MemoryStore } from './storage/memory.store';
import { Device, UpdateTask, User } from './types';
import { NodesService } from './nodes/nodes.service';
import { SigningService } from './signing.service';


@ApiTags('tasks')
@Controller('/tasks')
export class TasksController {
  private readonly logger = new Logger(TasksController.name);

  constructor(
    private readonly store: MemoryStore,
    private readonly audit: AuditService,
    private readonly nodes: NodesService,
    private readonly signing: SigningService,
  ) {}

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:manage')
  @Get()
  list() {
    this.logger.debug(`Listing ${this.store.tasks.length} task(s)`);
    return this.store.tasks;
  }

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('deployments:write')
  @Post('/refresh-inventory/:deviceId')
  refreshInventory(@Param('deviceId') deviceId: string, @CurrentUser() user: User) {
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
    this.audit.record(user.id, 'task.refresh_inventory_created', task.id, { deviceId, nodeId: node.id });
    this.logger.log(`Refresh-inventory task created: taskId=${task.id} deviceId=${deviceId} nodeId=${node.id}`);
    return task;
  }

  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission('tasks:manage')
  @Delete('/:id')
  cancel(@Param('id') id: string, @CurrentUser() user: User) {
    const task = this.store.tasks.find((t) => t.id === id);
    if (!task) throw new BadRequestException('Unknown task');
    if (task.status !== 'pending') throw new BadRequestException(`Cannot cancel a task with status '${task.status}'`);
    task.status = 'cancelled';
    task.completedAt = new Date().toISOString();
    void this.store.persist();
    this.audit.record(user.id, 'task.cancelled', task.id, {});
    this.logger.log(`Task cancelled: taskId=${id}`);
    return task;
  }

  /**
   * Node polls for its pending tasks.
   * Authentication is via Vault-issued mTLS certificate; nodeId comes from the cert CN.
   */
  @UseGuards(MtlsNodeGuard)
  @Get('/node/:nodeId/pending')
  pendingForNode(@NodeId() certNodeId: string, @Param('nodeId') paramNodeId: string) {
    // Cert identity must match the requested nodeId — prevents one node reading another's tasks
    if (certNodeId !== paramNodeId) {
      this.logger.warn(`Node ${certNodeId} attempted to poll tasks for a different node ${paramNodeId}`);
      throw new BadRequestException('Certificate identity does not match requested nodeId');
    }
    const now = new Date().toISOString();
    const tasks = this.store.tasks.filter((t) => t.nodeId === certNodeId && t.status === 'pending');
    for (const task of tasks) {
      task.status = 'dispatched';
      task.dispatchedAt = now;
    }
    void this.store.persist();
    if (tasks.length > 0) {
      this.audit.record(certNodeId, 'task.dispatched_to_node', certNodeId, { count: tasks.length });
      this.logger.log(`Dispatched ${tasks.length} task(s) to nodeId=${certNodeId}`);
    } else {
      this.logger.debug(`No pending tasks for nodeId=${certNodeId}`);
    }
    return {
      tasks: tasks.map((task) =>
        this.signing.signPayload('task_bundle', tenantIdForTasks([task], this.store.devices), { tasks: [task] }),
      ),
    };
  }

  /** Node reports a task result — identity verified via mTLS cert. */
  @UseGuards(MtlsNodeGuard)
  @Post('/result')
  result(
    @NodeId() nodeId: string,
    @Body() dto: { deviceId: string; taskId: string; status: 'completed' | 'failed' | 'rejected'; output?: string },
  ) {
    const task = this.store.tasks.find((t) => t.id === dto.taskId);
    if (!task) throw new BadRequestException('Unknown task');
    task.status = dto.status;
    task.output = dto.output;
    task.completedAt = new Date().toISOString();
    void this.store.persist();
    this.audit.record(nodeId, `task.${dto.status}`, task.id, { output: dto.output });
    this.logger.log(`Task result recorded: taskId=${dto.taskId} deviceId=${dto.deviceId} status=${dto.status} node=${nodeId}`);
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

function tenantIdForTasks(tasks: UpdateTask[], devices: Device[]) {
  for (const task of tasks) {
    const tenantId = devices.find((device) => device.id === task.deviceId)?.tenantId;
    if (tenantId) return tenantId;
  }
  return 'default';
}
