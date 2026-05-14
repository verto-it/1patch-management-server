import { Controller, Get, Redirect } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MemoryStore } from './storage/memory.store';

@ApiTags('health')
@Controller()
export class AppController {
  /**
   * Creates a AppController instance with its required collaborators.
   *
   * @param store store supplied to the function.
   */
  constructor(private readonly store: MemoryStore) {}

  @Get('/')
  @Redirect('/ui', 302)
  root() {
    return;
  }

  /**
   * Handles the health operation for AppController.
   * @returns The result produced by the operation.
   */
  @Get('/health')
  health() {
    return { status: 'ok', service: '1patch-management-server' };
  }

  /**
   * Handles the ready operation for AppController.
   * @returns The result produced by the operation.
   */
  @Get('/ready')
  ready() {
    return {
      status: 'ready',
      setupComplete: this.store.users.length > 0,
      nodeCount: this.store.backendNodes.length,
    };
  }
}
