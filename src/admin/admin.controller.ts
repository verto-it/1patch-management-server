import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import * as bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { RbacService } from '../rbac/rbac.service';
import { CurrentUser } from '../security/current-user.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { RbacGuard } from '../security/rbac.guard';
import { RequirePermission } from '../security/require-permission.decorator';
import { MemoryStore } from '../storage/memory.store';
import { Permission, Role, User } from '../types';

@ApiTags('admin')
@UseGuards(JwtAuthGuard, RbacGuard)
@Controller('/admin')
export class AdminController {
  constructor(
    private readonly store: MemoryStore,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
  ) {}

  @RequirePermission('users:manage')
  @Get('/users')
  users() {
    return this.store.users.map((user) => this.safeUser(user));
  }

  @RequirePermission('users:manage')
  @Post('/users')
  async createUser(@Body() body: { email: string; password: string; roles: Role[] }, @CurrentUser() actor: User) {
    const email = body.email?.trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BadRequestException('Valid email is required');
    if (this.store.users.some((user) => user.email === email)) throw new BadRequestException('User already exists');
    assertPasswordPolicy(body.password);
    const roles = this.validRoles(body.roles);
    const user: User = {
      id: uuid(),
      email,
      passwordHash: await bcrypt.hash(body.password, 12),
      roles,
      mfaEnabled: false,
      recoveryCodeHashes: [],
      failedAttempts: 0,
      oauthLinks: [],
    };
    this.store.users.push(user);
    await this.store.persist();
    this.audit.record(actor.id, 'admin.user.created', user.id, { email, roles });
    return this.safeUser(user);
  }

  @RequirePermission('users:manage')
  @Patch('/users/:id')
  async updateUser(@Param('id') id: string, @Body() body: { roles?: Role[]; disabled?: boolean; password?: string }, @CurrentUser() actor: User) {
    const user = this.requireUser(id);
    if (body.roles) user.roles = this.validRoles(body.roles);
    if (typeof body.disabled === 'boolean') {
      if (user.id === actor.id && body.disabled) throw new BadRequestException('You cannot disable your own account');
      user.disabled = body.disabled;
    }
    if (body.password) {
      assertPasswordPolicy(body.password);
      user.passwordHash = await bcrypt.hash(body.password, 12);
    }
    await this.store.persist();
    this.audit.record(actor.id, 'admin.user.updated', id, { roles: user.roles, disabled: user.disabled === true, passwordChanged: Boolean(body.password) });
    return this.safeUser(user);
  }

  @RequirePermission('users:manage')
  @Delete('/users/:id')
  async deleteUser(@Param('id') id: string, @CurrentUser() actor: User) {
    if (id === actor.id) throw new BadRequestException('You cannot delete your own account');
    const index = this.store.users.findIndex((user) => user.id === id);
    if (index === -1) throw new BadRequestException('Unknown user');
    const [removed] = this.store.users.splice(index, 1);
    await this.store.persist();
    this.audit.record(actor.id, 'admin.user.deleted', id, { email: removed.email, roles: removed.roles });
    return { deleted: true };
  }

  @RequirePermission('users:manage')
  @Get('/rbac')
  rbacInfo(): { roles: Role[]; permissions: Permission[]; matrix: Record<Role, Permission[]> } {
    return {
      roles: this.rbac.allRoles(),
      permissions: this.rbac.allPermissions(),
      matrix: this.rbac.roleMatrix(),
    };
  }

  private requireUser(id: string) {
    const user = this.store.users.find((candidate) => candidate.id === id);
    if (!user) throw new BadRequestException('Unknown user');
    return user;
  }

  private safeUser(user: User) {
    return {
      id: user.id,
      email: user.email,
      roles: user.roles,
      permissions: this.rbac.permissionsFor(user.roles),
      mfaEnabled: user.mfaEnabled,
      disabled: user.disabled === true,
      lockedUntil: user.lockedUntil,
      lastLoginAt: user.lastLoginAt,
      oauthLinks: user.oauthLinks.map((link) => link.provider),
    };
  }

  private validRoles(roles: Role[]) {
    const allowed = new Set(this.rbac.allRoles());
    const clean = [...new Set((roles ?? []).filter((role): role is Role => allowed.has(role)))];
    if (clean.length === 0) throw new BadRequestException('At least one valid role is required');
    return clean;
  }
}

function assertPasswordPolicy(password: string) {
  if (
    password.length < 12 ||
    !/[A-Z]/.test(password) ||
    !/[a-z]/.test(password) ||
    !/[0-9]/.test(password)
  ) {
    throw new BadRequestException('Password must be at least 12 characters and include uppercase, lowercase, and a number');
  }
}
