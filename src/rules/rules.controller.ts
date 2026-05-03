// AGPL-3.0-only — replacement for src/rules/rules.controller.ts
import { Body, Controller, Get, NotFoundException, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { v4 as uuid } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { MemoryStore } from '../storage/memory.store';
import { CurrentUser } from '../security/current-user.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { RbacGuard } from '../security/rbac.guard';
import { RequirePermission } from '../security/require-permission.decorator';
import { User } from '../types';

class RuleDto {
  @IsString() name!: string;
  @IsBoolean() enabled = true;
  @IsIn(['appName', 'manufacturer', 'guid', 'packageId'])
  property!: 'appName' | 'manufacturer' | 'guid' | 'packageId';
  @IsIn(['contains', 'equals']) operator!: 'contains' | 'equals';
  @IsString() value!: string;
  @IsString() targetVersion: 'latest' | string = 'latest';
  @IsOptional() @IsString() maxVersion?: string;
}

class RulePatchDto { @IsOptional() @IsBoolean() enabled?: boolean; }

@ApiTags('rules')
@UseGuards(JwtAuthGuard, RbacGuard)
@RequirePermission('rules:manage')
@Controller('/rules')
export class RulesController {
  constructor(private readonly store: MemoryStore, private readonly audit: AuditService) {}

  @Get()  list() { return this.store.rules; }

  @Post()
  create(@Body() dto: RuleDto, @CurrentUser() user: User) {
    const rule = { id: uuid(), ...dto };
    this.store.rules.push(rule);
    void this.store.persist();
    this.audit.record(user.id, 'rule.created', rule.id, rule);
    return rule;
  }

  @Patch('/:id')
  patch(@Param('id') id: string, @Body() dto: RulePatchDto, @CurrentUser() user: User) {
    const rule = this.store.rules.find((r) => r.id === id);
    if (!rule) throw new NotFoundException();
    if (typeof dto.enabled === 'boolean') rule.enabled = dto.enabled;
    void this.store.persist();
    this.audit.record(user.id, dto.enabled ? 'rule.enabled' : 'rule.disabled', id);
    return rule;
  }
}
