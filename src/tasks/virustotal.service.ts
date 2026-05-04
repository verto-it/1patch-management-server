import { Injectable, Logger } from '@nestjs/common';

export interface VtHashResult {
  checkedAt: string;
  positives?: number;
  total?: number;
  permalink?: string;
  available: boolean;
}

@Injectable()
export class VirusTotalService {
  private readonly logger = new Logger(VirusTotalService.name);

  async checkHash(sha256: string, apiKey: string): Promise<VtHashResult> {
    const checkedAt = new Date().toISOString();
    try {
      const res = await fetch(`https://www.virustotal.com/api/v3/files/${sha256}`, {
        headers: { 'x-apikey': apiKey },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 404) {
        this.logger.debug(`VirusTotal: hash ${sha256.slice(0, 16)}... not found`);
        return { checkedAt, available: true };
      }
      if (!res.ok) {
        this.logger.warn(`VirusTotal API returned HTTP ${res.status}`);
        return { checkedAt, available: false };
      }
      const body = await res.json() as Record<string, any>;
      const stats = body?.data?.attributes?.last_analysis_stats as Record<string, number> | undefined;
      const positives = stats?.malicious ?? 0;
      const total = stats ? Object.values(stats).reduce((a, b) => a + b, 0) : undefined;
      const permalink = `https://www.virustotal.com/gui/file/${sha256}`;
      this.logger.log(`VirusTotal result for ${sha256.slice(0, 16)}...: ${positives}/${total ?? '?'} positive(s)`);
      return { checkedAt, positives, total, permalink, available: true };
    } catch (err) {
      this.logger.warn(`VirusTotal check failed: ${err instanceof Error ? err.message : String(err)}`);
      return { checkedAt, available: false };
    }
  }
}
