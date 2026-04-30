import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { MemoryStore } from '../storage/memory.store';

@Injectable()
export class NodesService {
  constructor(private readonly store: MemoryStore, private readonly audit: AuditService) {}

  async createEnrollment(name: string, publicUrl: string, region?: string, site?: string) {
    const token = `node_${uuid().replaceAll('-', '')}`;
    const node = {
      id: uuid(),
      name,
      publicUrl,
      region,
      site,
      status: 'pending' as const,
      enrollmentTokenHash: await bcrypt.hash(token, 12),
    };
    this.store.backendNodes.push(node);
    await this.store.persist();
    this.audit.record('system', 'node.enrollment_created', node.id, { name, publicUrl, region, site });
    return { nodeId: node.id, enrollmentToken: token };
  }

  async register(nodeId: string, enrollmentToken: string, version: string, capacity?: Record<string, unknown>) {
    const node = this.store.backendNodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new BadRequestException('Unknown node');
    if (!(await bcrypt.compare(enrollmentToken, node.enrollmentTokenHash))) {
      throw new UnauthorizedException('Invalid enrollment token');
    }
    node.status = 'online';
    node.version = version;
    node.capacity = capacity;
    node.lastSeenAt = new Date().toISOString();
    await this.store.persist();
    this.audit.record(node.id, 'node.registered', node.id, { version, capacity });
    return { nodeId: node.id, accepted: true };
  }

  heartbeat(nodeId: string, capacity?: Record<string, unknown>) {
    const node = this.store.backendNodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new BadRequestException('Unknown node');
    node.status = 'online';
    node.lastSeenAt = new Date().toISOString();
    node.capacity = capacity ?? node.capacity;
    void this.store.persist();
    return { accepted: true, serverTime: new Date().toISOString() };
  }

  onlineNodes() {
    return this.store.backendNodes.filter((node) => node.status === 'online');
  }
}
