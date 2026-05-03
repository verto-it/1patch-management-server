import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { RbacService } from '../rbac/rbac.service';
import { MemoryStore } from '../storage/memory.store';
import { User } from '../types';
import { REQUIRED_PERMISSIONS_KEY } from './require-permission.decorator';

@Injectable()
export class RbacGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly store: MemoryStore,
    private readonly rbac: RbacService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? [];
    if (required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: { sub?: string }; currentUser?: User }>();
    const userId = request.user?.sub;
    if (!userId) throw new UnauthorizedException('Authentication required');

    const user = this.store.users.find((candidate) => candidate.id === userId);
    if (!user) throw new UnauthorizedException('Unknown user');
    request.currentUser = user;

    if (!required.some((permission) => this.rbac.can(user, permission as never))) {
      throw new ForbiddenException('Insufficient permission');
    }
    return true;
  }
}
