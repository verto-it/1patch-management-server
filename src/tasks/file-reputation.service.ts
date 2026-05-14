import { Injectable } from '@nestjs/common';
import { basename } from 'path';
import { v4 as uuid } from 'uuid';
import { PackageArtifact, FileReputationReport, UpdateTask } from '../types';
import { NodeEnterpriseService } from '../nodes/node-enterprise.service';
import { VirusTotalService } from './virustotal.service';

const SUSPICIOUS_NAME_PATTERNS = [/crack/i, /keygen/i, /payload/i, /dropper/i, /update\.exe$/i, /setup_tmp/i];
const SUSPICIOUS_PATH_PATTERNS = [/\/tmp\//i, /\\temp\\/i, /appdata\\local\\temp/i, /\/var\/tmp\//i];

@Injectable()
export class FileReputationService {
  constructor(
    private readonly enterprise: NodeEnterpriseService,
    private readonly virusTotal: VirusTotalService,
  ) {}

  async scan(task: UpdateTask, artifact: PackageArtifact | undefined, virusTotalApiKey?: string): Promise<FileReputationReport | undefined> {
    const sha256 = task.sha256 ?? artifact?.sha256;
    if (!sha256) return undefined;

    const name = artifact?.fileName ?? artifact?.name ?? task.sourceUrl ?? task.packageId ?? task.id;
    const path = artifact?.storagePath ?? artifact?.sourceUrl ?? task.sourceUrl ?? '';
    const allowlist = configuredList('FILE_REPUTATION_ALLOWLIST_SHA256');
    const denylist = configuredList('FILE_REPUTATION_DENYLIST_SHA256');
    const suspiciousFilename = SUSPICIOUS_NAME_PATTERNS.some((pattern) => pattern.test(basename(name)));
    const suspiciousPath = SUSPICIOUS_PATH_PATTERNS.some((pattern) => pattern.test(path));
    const entropyScore = entropyScoreForString(`${name}|${path}|${task.installArgs ?? ''}`);

    let riskScore = 0;
    const reasons: string[] = [];
    if (denylist.has(sha256.toLowerCase())) { riskScore += 100; reasons.push('sha256 denylisted'); }
    if (allowlist.has(sha256.toLowerCase())) { riskScore -= 40; reasons.push('sha256 allowlisted'); }
    if (artifact?.signatureStatus === 'invalid') { riskScore += 45; reasons.push('invalid Authenticode/package signature metadata'); }
    if (artifact?.signatureStatus === 'unsigned') { riskScore += 15; reasons.push('unsigned package metadata'); }
    if (suspiciousFilename) { riskScore += 20; reasons.push('suspicious filename'); }
    if (suspiciousPath) { riskScore += 15; reasons.push('suspicious path'); }
    if (entropyScore > 80) { riskScore += 10; reasons.push('high entropy metadata'); }

    const report: FileReputationReport = {
      id: uuid(),
      packageArtifactId: artifact?.id ?? task.packageArtifactId,
      sha256,
      scannedAt: new Date().toISOString(),
      source: 'management',
      authenticodeStatus: artifact?.signatureStatus ?? 'unknown',
      vendorVerified: artifact?.signatureStatus === 'valid',
      allowlisted: allowlist.has(sha256.toLowerCase()),
      denylisted: denylist.has(sha256.toLowerCase()),
      suspiciousFilename,
      suspiciousPath,
      entropyScore,
      packedBinarySuspected: entropyScore > 90,
      yaraMatches: [],
      riskScore: clamp(riskScore, 0, 100),
      verdict: 'unknown',
      reasons,
    };

    if (virusTotalApiKey) {
      const vt = await this.virusTotal.checkHash(sha256, virusTotalApiKey);
      report.virusTotal = vt.available
        ? { available: true, positives: vt.positives, total: vt.total, permalink: vt.permalink, checkedAt: vt.checkedAt }
        : { available: false, checkedAt: vt.checkedAt };
      if ((vt.positives ?? 0) > 0) {
        report.riskScore = clamp(report.riskScore + Math.min(70, (vt.positives ?? 0) * 10), 0, 100);
        report.reasons.push(`VirusTotal positives=${vt.positives}`);
      }
    }

    report.verdict = report.denylisted || report.riskScore >= 80
      ? 'malicious'
      : report.riskScore >= 40
        ? 'suspicious'
        : report.allowlisted || report.riskScore <= 10
          ? 'trusted'
          : 'unknown';

    return this.enterprise.recordFileReputation(report);
  }
}

function configuredList(name: string) {
  return new Set((process.env[name] ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function entropyScoreForString(value: string) {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  const entropy = [...counts.values()].reduce((sum, count) => {
    const p = count / value.length;
    return sum - p * Math.log2(p);
  }, 0);
  return Math.round((entropy / 8) * 100);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
