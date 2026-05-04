import { TenantPolicy } from '../types';

export type SecurityPostureSeverity = 'critical' | 'high' | 'medium' | 'info';

export type SecurityPostureCategory =
  | 'task_execution'
  | 'signing_keys'
  | 'backend_nodes'
  | 'admin_auth'
  | 'audit_integrity'
  | 'siem_observability'
  | 'policies'
  | 'kill_switch';

export interface SecurityPostureFinding {
  id: string;
  severity: SecurityPostureSeverity;
  category: SecurityPostureCategory;
  title: string;
  description: string;
  riskExplanation: string;
  fixSuggestion: string;
  autoFixAvailable: boolean;
  fixAction?: SecurityPostureFixAction;
}

export type SecurityPostureFixAction =
  | 'enable_delayed_execution'
  | 'enable_mfa_approval'
  | 'enforce_minimum_delay'
  | 'enable_default_notifications';

export interface SecurityPostureCategoryBreakdown {
  category: SecurityPostureCategory;
  label: string;
  status: 'good' | 'warning' | 'critical';
  scoreImpact: number;
  findingCount: number;
  severityCounts: Record<SecurityPostureSeverity, number>;
}

export interface SecurityPostureReport {
  tenantId: string;
  score: number;
  mode: TenantPolicy['securityMode'];
  findings: SecurityPostureFinding[];
  findingsBySeverity: Record<SecurityPostureSeverity, SecurityPostureFinding[]>;
  categoryBreakdown: SecurityPostureCategoryBreakdown[];
  generatedAt: string;
}

export interface SecurityPostureFixResult {
  tenantId: string;
  applied: Array<{ findingId: string; action: SecurityPostureFixAction; description: string }>;
  skipped: Array<{ findingId: string; reason: string }>;
  report: SecurityPostureReport;
}

