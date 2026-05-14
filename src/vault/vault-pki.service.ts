import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

interface VaultTokenResponse {
  auth: { client_token: string; lease_duration: number };
}

interface VaultIssueResponse {
  data: {
    certificate: string;
    private_key: string;
    ca_chain: string[];
    serial_number: string;
  };
}

export interface IssuedCert {
  certificate: string;   // PEM — node's own cert
  privateKey:  string;   // PEM — node's private key
  caCert:      string;   // PEM — CA cert for the node to pin
  serial:      string;   // used later for revocation
}

@Injectable()
export class VaultPkiService implements OnModuleInit {
  private readonly logger = new Logger(VaultPkiService.name);

  private vaultAddr!: string;
  private roleId!: string;
  private secretId!: string;

  /** Cached Vault client token — refreshed before expiry */
  private clientToken: string | null = null;
  private tokenExpiresAt = 0;

  /**
   * Handles the on module init operation for VaultPkiService.
   */
  onModuleInit() {
    this.vaultAddr = process.env.VAULT_ADDR ?? '';
    this.roleId    = process.env.VAULT_APPROLE_ROLE_ID ?? '';
    this.secretId  = process.env.VAULT_APPROLE_SECRET_ID ?? '';

    if (!this.vaultAddr || !this.roleId || !this.secretId) {
      this.logger.error(
        'VAULT_ADDR, VAULT_APPROLE_ROLE_ID and VAULT_APPROLE_SECRET_ID must all be set. ' +
        'Run vault/init-pki.ps1 and add the printed values to .env.',
      );
      process.exit(1);
    }

    this.logger.log(`VaultPkiService initialised — Vault at ${this.vaultAddr}`);
  }

  /**
   * Issues a 24-hour EC P-256 TLS certificate for a backend node.
   * The common name is scoped to the internal domain so it can never
   * be misused as a public certificate.
   */
  async issueCert(nodeId: string): Promise<IssuedCert> {
    const token = await this.getToken();
    const cn    = `${nodeId}.1patch.internal`;

    this.logger.log(`Issuing certificate for nodeId=${nodeId} (cn=${cn})`);

    const res = await fetch(`${this.vaultAddr}/v1/pki/issue/backend-node`, {
      method:  'POST',
      headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ common_name: cn, ttl: '24h' }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Vault cert issuance failed (HTTP ${res.status}): ${text}`);
    }

    const body = (await res.json()) as VaultIssueResponse;
    this.logger.log(`Certificate issued for nodeId=${nodeId} serial=${body.data.serial_number}`);

    return {
      certificate: body.data.certificate,
      privateKey:  body.data.private_key,
      caCert:      body.data.ca_chain[0] ?? body.data.certificate,
      serial:      body.data.serial_number,
    };
  }

  /**
   * Revokes a node certificate by serial number.
   * Call this when a node is decommissioned — the cert stops working
   * within the next CRL refresh interval (Vault default: 10 minutes).
   */
  async revokeCert(serial: string): Promise<void> {
    const token = await this.getToken();
    this.logger.log(`Revoking certificate serial=${serial}`);

    const res = await fetch(`${this.vaultAddr}/v1/pki/revoke`, {
      method:  'POST',
      headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ serial_number: serial }),
    });

    if (!res.ok) {
      const text = await res.text();
      this.logger.error(`Certificate revocation failed for serial=${serial}: ${text}`);
      // Non-fatal — node cert will expire in ≤24h regardless
    } else {
      this.logger.log(`Certificate revoked: serial=${serial}`);
    }
  }

  // ── private ─────────────────────────────────────────────────────────────

  /** Authenticates via AppRole and caches the client token, refreshing 5 minutes before expiry. */
  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.clientToken && now < this.tokenExpiresAt) return this.clientToken;

    this.logger.debug('Refreshing Vault AppRole token');

    const res = await fetch(`${this.vaultAddr}/v1/auth/approle/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ role_id: this.roleId, secret_id: this.secretId }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Vault AppRole login failed (HTTP ${res.status}): ${text}`);
    }

    const body = (await res.json()) as VaultTokenResponse;
    this.clientToken   = body.auth.client_token;
    // Refresh 5 minutes before the token actually expires
    this.tokenExpiresAt = now + (body.auth.lease_duration - 300) * 1000;
    this.logger.debug('Vault AppRole token refreshed');
    return this.clientToken;
  }
}
