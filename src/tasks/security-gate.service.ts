import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PackageArtifact, SecurityFinding, SecurityScanResult, TenantPolicy, UpdateTask } from '../types';

/** Provider interface for optional AI advisory analysis */
export interface AiAdvisoryProvider {
  analyze(task: UpdateTask, artifact?: PackageArtifact): Promise<SecurityFinding[]>;
}

const SUSPICIOUS_ARGS = ['/quiet', '/norestart', 'bypass', 'executionpolicy', '-nop', '-w hidden', 'iex(', 'invoke-expression', 'downloadstring', 'webclient', 'base64'];
const ALLOWED_TASK_TYPES = new Set(['update_package', 'refresh_inventory']);

@Injectable()
export class SecurityGateService {
  private readonly logger = new Logger(SecurityGateService.name);
  private aiProvider?: AiAdvisoryProvider;
  private readonly knownSources = new Set<string>(); // populated from package artifacts

  /**
   * Sets the ai provider value.
   *
   * @param provider provider supplied to the function.
   */
  setAiProvider(provider: AiAdvisoryProvider) {
    this.aiProvider = provider;
    this.logger.log('AI advisory provider registered (advisory only — cannot approve or sign tasks)');
  }

  /**
   * Handles the register known source operation for SecurityGateService.
   *
   * @param host host supplied to the function.
   */
  registerKnownSource(host: string) {
    this.knownSources.add(host.toLowerCase());
  }

  /**
   * Handles the scan operation for SecurityGateService.
   *
   * @param task task supplied to the function.
   * @param policy policy supplied to the function.
   * @param artifact artifact supplied to the function.
   * @param options Optional settings that tune the operation.
   * @returns The result produced by the operation.
   */
  async scan(
    task: UpdateTask,
    policy: TenantPolicy,
    artifact: PackageArtifact | undefined,
    options: { deviceCount: number; totalDevices: number; adminCreatedAt?: string; recentFailedLogins?: number },
  ): Promise<SecurityScanResult> {
    const findings: SecurityFinding[] = [];
    let riskScore = 0;
    let hardBlock = false;
    let hardBlockReason: string | undefined;

    // ── Hard blocks ──────────────────────────────────────────────────────────

    
    if (task.type === 'update_package') {
      const isRepoPackageTask = !task.sourceUrl && safeRepoPackageId(task.packageId);
      if (!task.sourceUrl && !isRepoPackageTask) {
        hardBlock = true;
        hardBlockReason = 'Repo package task is missing a safe packageId';
        findings.push({ code: 'MISSING_PACKAGE_ID', severity: 'critical', message: hardBlockReason, field: 'packageId' });
      }

      if (task.sourceUrl) {
        // 1. Downloaded package source URL must be HTTPS
        if (!task.sourceUrl.startsWith('https://')) {
          hardBlock = true;
          hardBlockReason = 'Package source URL is not HTTPS';
          findings.push({ code: 'NON_HTTPS_SOURCE', severity: 'critical', message: hardBlockReason, field: 'sourceUrl' });
        }

        // 2. Trusted source host
        const sourceHost = safeHost(task.sourceUrl);
        if (sourceHost && policy.trustedSourceHosts.length > 0 && !policy.trustedSourceHosts.includes(sourceHost)) {
          hardBlock = true;
          hardBlockReason = hardBlockReason ?? `Source host '${sourceHost}' is not on the trusted list`;
          findings.push({ code: 'UNTRUSTED_SOURCE_HOST', severity: 'critical', message: `Source host '${sourceHost}' is not trusted`, field: 'sourceUrl' });
        }

        // 3. SHA-256 must be present for downloaded artifacts
        if (!task.sha256) {
          hardBlock = true;
          hardBlockReason = hardBlockReason ?? 'SHA-256 hash is missing';
          findings.push({ code: 'MISSING_SHA256', severity: 'critical', message: 'SHA-256 hash is required', field: 'sha256' });
        }

        // 4. Package hash must match artifact metadata
        if (artifact?.sha256 && task.sha256 && artifact.sha256 !== task.sha256) {
          hardBlock = true;
          hardBlockReason = hardBlockReason ?? 'Package SHA-256 does not match stored artifact';
          findings.push({ code: 'HASH_MISMATCH', severity: 'critical', message: 'Package hash does not match stored artifact metadata', field: 'sha256' });
        }
      }
    }

    // 5. Task type must be allowlisted
    if (!policy.allowedTaskTypes.includes(task.type)) {
      hardBlock = true;
      hardBlockReason = hardBlockReason ?? `Task type '${task.type}' is not in the allowed list`;
      findings.push({ code: 'UNKNOWN_TASK_TYPE', severity: 'critical', message: `Task type '${task.type}' is not allowlisted`, field: 'type' });
    }

    // ── Risk scoring ─────────────────────────────────────────────────────────

    // 6. Newly introduced source (not seen before)
    if (task.sourceUrl && sourceHost(task.sourceUrl) && !this.knownSources.has(sourceHost(task.sourceUrl)!)) {
      riskScore += 15;
      findings.push({ code: 'NEW_SOURCE_HOST', severity: 'medium', message: 'Package source host has not been seen before', field: 'sourceUrl' });
    }

    // 7. Suspicious install args
    const args = (task.installArgs ?? '').toLowerCase();
    for (const pattern of SUSPICIOUS_ARGS) {
      if (args.includes(pattern)) {
        riskScore += 20;
        findings.push({ code: 'SUSPICIOUS_INSTALL_ARGS', severity: 'high', message: `Suspicious install argument pattern detected: '${pattern}'`, field: 'installArgs' });
        break;
      }
    }

    // 8. Unsigned executable metadata
    if (artifact?.signatureStatus === 'invalid') {
      riskScore += 30;
      findings.push({ code: 'INVALID_PACKAGE_SIGNATURE', severity: 'high', message: 'Package executable has an invalid digital signature' });
    } else if (artifact?.signatureStatus === 'unsigned') {
      riskScore += 15;
      findings.push({ code: 'UNSIGNED_PACKAGE', severity: 'medium', message: 'Package executable is unsigned' });
    }

    // 9. Broad targeting
    if (options.totalDevices > 0) {
      const pct = (options.deviceCount / options.totalDevices) * 100;
      if (pct >= policy.broadTargetingThresholdPercent) {
        riskScore += 20;
        findings.push({ code: 'BROAD_TARGETING', severity: 'high', message: `Task targets ${pct.toFixed(0)}% of devices (threshold: ${policy.broadTargetingThresholdPercent}%)` });
      }
    }

    // 10. Outside maintenance window
    if (policy.maintenanceWindows.length > 0 && !isInMaintenanceWindow(policy)) {
      riskScore += 10;
      findings.push({ code: 'OUTSIDE_MAINTENANCE_WINDOW', severity: 'medium', message: 'Task was created outside the configured maintenance window' });
    }

    // 11. New admin (account < 7 days old)
    if (options.adminCreatedAt) {
      const ageMs = Date.now() - new Date(options.adminCreatedAt).getTime();
      if (ageMs < 7 * 24 * 3600_000) {
        riskScore += 15;
        findings.push({ code: 'NEW_ADMIN_CREATOR', severity: 'medium', message: 'Task was created by an admin account less than 7 days old' });
      }
    }

    // 12. Recent failed logins
    if ((options.recentFailedLogins ?? 0) > 3) {
      riskScore += 20;
      findings.push({ code: 'RECENT_FAILED_LOGINS', severity: 'high', message: `${options.recentFailedLogins} failed login attempts were recorded recently before task creation` });
    }

    riskScore = Math.min(100, riskScore);
    const severity = riskScore >= 80 ? 'critical' : riskScore >= 60 ? 'high' : riskScore >= 30 ? 'medium' : 'low';

    // Hard block if critical risk and no break-glass policy
    if (severity === 'critical' && !hardBlock && !policy.breakGlassKeyId) {
      hardBlock = true;
      hardBlockReason = 'Risk score is critical and no break-glass policy is configured';
    }

    // ── Optional AI advisory (never blocks) ──────────────────────────────────
    let advisoryFindings: SecurityFinding[] | undefined;
    if (this.aiProvider) {
      try {
        advisoryFindings = await this.aiProvider.analyze(task, artifact);
        this.logger.debug(`AI advisory returned ${advisoryFindings.length} finding(s) for taskId=${task.id}`);
      } catch (err) {
        this.logger.warn(`AI advisory provider failed for taskId=${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const result: SecurityScanResult = {
      taskId: task.id,
      scannedAt: new Date().toISOString(),
      riskScore,
      severity,
      findings,
      humanReadableSummary: buildSummary(riskScore, severity, findings, hardBlock),
      hardBlock,
      hardBlockReason,
      advisoryFindings,
    };

    this.logger.log(`Security scan complete: taskId=${task.id} riskScore=${riskScore} severity=${severity} hardBlock=${hardBlock} findings=${findings.length}`);
    return result;
  }
}

/**
 * Handles the safe host operation.
 *
 * @param url URL used by the operation.
 * @returns The result produced by the operation.
 */
function safeHost(url?: string): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).hostname.toLowerCase(); } catch { return undefined; }
}

/**
 * Handles the source host operation.
 *
 * @param url URL used by the operation.
 * @returns The result produced by the operation.
 */
function sourceHost(url: string): string | undefined { return safeHost(url); }

function safeRepoPackageId(value?: string): boolean {
  return /^[A-Za-z0-9._+-]+$/.test((value ?? '').trim());
}

/**
 * Handles the is in maintenance window operation.
 *
 * @param policy policy supplied to the function.
 * @returns The result produced by the operation.
 */
function isInMaintenanceWindow(policy: TenantPolicy): boolean {
  const now = new Date();
  const hour = now.getUTCHours();
  const dow = now.getUTCDay();
  return policy.maintenanceWindows.some((w) => {
    const dayMatch = w.dayOfWeek === undefined || w.dayOfWeek === dow;
    const hourMatch = hour >= w.startHourUtc && hour < w.endHourUtc;
    return dayMatch && hourMatch;
  });
}

/**
 * Builds the summary payload.
 *
 * @param score score supplied to the function.
 * @param severity severity supplied to the function.
 * @param findings findings supplied to the function.
 * @param hardBlock hard block supplied to the function.
 * @returns The result produced by the operation.
 */
function buildSummary(score: number, severity: string, findings: SecurityFinding[], hardBlock: boolean): string {
  const lines = [`Risk score: ${score}/100 (${severity})`];
  if (hardBlock) lines.push('⛔ HARD BLOCK — task cannot proceed to signing');
  for (const f of findings.filter((x) => x.severity === 'critical' || x.severity === 'high')) {
    lines.push(`• [${f.severity.toUpperCase()}] ${f.message}`);
  }
  if (findings.length === 0) lines.push('No significant findings.');
  return lines.join('\n');
}
