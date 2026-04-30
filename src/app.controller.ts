import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MemoryStore } from './storage/memory.store';

@ApiTags('health')
@Controller()
export class AppController {
  constructor(private readonly store: MemoryStore) {}

  @Get('/health')
  health() {
    return { status: 'ok', service: '1patch-management-server' };
  }

  @Get('/ready')
  ready() {
    return {
      status: 'ready',
      setupComplete: this.store.users.length > 0,
      nodeCount: this.store.backendNodes.length,
    };
  }
}
