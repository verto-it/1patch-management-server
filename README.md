# 1Patch Management Server

NestJS control plane for 1Patch. Owns setup, authentication, RBAC, tenants, app/rule management, backend-node registry, package metadata, update jobs, audit logs, and the built-in dashboard.

**Port:** `4100`
**License:** AGPL-3.0-only

## Docs

- Agent API: [`docs/agent-api.md`](docs/agent-api.md)
- Rules Engine: [`docs/rules-engine.md`](docs/rules-engine.md)

---

## Prerequisites

- Node.js 20 LTS or 22 LTS
- PostgreSQL 15 or 16
- DragonflyDB (Redis-compatible)
- HashiCorp Vault 1.16+ with PKI engine initialised (see [`vault/README.md`](../vault/README.md))
- PowerShell 7.4+

---

## First-Time Setup

### 1. Run the PKI init script (once per management host)

```powershell
cd ../vault
.\init-pki.ps1 -ManagementHostname manage.1patch.local
```

Note the four values it prints:
- `VAULT_ADDR`
- `VAULT_APPROLE_ROLE_ID`
- `VAULT_APPROLE_SECRET_ID`
- `TLS_CERT_PATH` / `TLS_KEY_PATH` / `TLS_CA_PATH`

### 2. Install dependencies and run setup

```powershell
cd 1patch-management-server
npm install


.\scripts\setup-management.ps1 `
  -PostgresServerUrl     "postgres://1patch:secret@localhost:5432" `
  -DatabaseName          "1patch_management" `
  -DragonflyUrl          "redis://localhost:6379" `
  -OwnerEmail            "owner@example.com" `
  -VaultAddr             "http://127.0.0.1:8200" `
  -VaultApproleRoleId    "<role-id>" `
  -VaultApproleSecretId  "<secret-id>"
```

The script:
- Generates `JWT_SECRET` and the management ES256 signing key pair
- Creates the PostgreSQL database and applies the schema
- Writes `.env`
- Creates the first owner when the server is reachable

### 3. Build and start

```powershell
npm run build && npm start
```

### 4. Create the first owner account

The setup script attempts this automatically. If it fails (server not running yet):

```powershell
Invoke-RestMethod -Method Post "https://manage.1patch.local:4100/setup/owner" `
  -ContentType "application/json" `
  -Body '{ "email": "owner@example.com", "password": "<strong-password>" }'
```

---

## Environment Variables

All variables are written to `.env` by `setup-management.ps1`. Reference:

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | HTTP/HTTPS port (default `4100`) |
| `NODE_ENV` | yes | `production` disables Swagger |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `DRAGONFLY_URL` | yes | Redis-compatible URL |
| `JWT_SECRET` | yes | Min 32 chars — signs user JWTs |
| `MANAGEMENT_SIGNING_ACTIVE_KEY_ID` | yes | Active ES256 signing key ID |
| `MANAGEMENT_SIGNING_PRIVATE_KEY` | yes | Base64-encoded PKCS#8 P-256 private key PEM |
| `MANAGEMENT_SIGNING_PUBLIC_KEYS_JSON` | yes | Trusted keyId-to-public-key JSON for rotation |
| `CORS_ALLOWED_ORIGINS` | yes | Comma-separated browser origins |
| `VAULT_ADDR` | yes* | Vault address e.g. `http://127.0.0.1:8200` |
| `VAULT_APPROLE_ROLE_ID` | yes* | AppRole role ID |
| `VAULT_APPROLE_SECRET_ID` | yes* | AppRole secret ID |
| `TLS_CERT_PATH` | yes* | Path to management server PEM cert |
| `TLS_KEY_PATH` | yes* | Path to management server PEM key |
| `TLS_CA_PATH` | yes* | Path to Vault CA PEM cert |
| `PACKAGE_STORAGE_PATH` | no | Directory for uploaded package files (default `./packages`) |
| `REQUEST_BODY_LIMIT` | no | Max request body size (default `10mb`) |
| `PUBLIC_URL` | no | Public URL included in enrollment JSON |

*Required in production. Without the Vault/TLS vars the server starts over plain HTTP with a warning.

> **`NODE_API_SECRET` has been removed.** All node authentication is done exclusively via Vault-issued mTLS client certificates. No shared secret is needed or accepted on any node-facing endpoint.

---

## Key API Routes

### Setup
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/setup/owner` | none | Create the first owner account (one-time) |

### Auth
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/login` | none | Password login — returns JWT or MFA challenge |
| `POST` | `/auth/mfa/verify` | none | Complete MFA login |
| `POST` | `/auth/mfa/enable` | JWT | Enable TOTP for the current user |

### Nodes
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/nodes/enrollments` | JWT + `nodes:enroll` | Create a node enrollment (returns `nodeId` + `enrollmentToken`) |
| `POST` | `/nodes/register` | Enrollment token (one-time, 24 h TTL) | First-time node registration — returns Vault mTLS cert + decommission token |
| `POST` | `/nodes/heartbeat` | mTLS client cert | Node liveness update — returns `certExpiresAt` |
| `POST` | `/nodes/renew-cert` | mTLS client cert | Renew the node's Vault certificate before expiry |
| `GET`  | `/nodes` | JWT + `nodes:read` | List all nodes |
| `DELETE` | `/nodes/:nodeId` | JWT + `nodes:manage` | Decommission node (revokes mTLS cert, clears node config) |

### Agent (client-facing)
| Method | Path | Auth | Description |
|---|---|---|---|
| `GET`  | `/agent/bootstrap/:tenantId` | none | Signed node manifest for clients |
| `GET`  | `/agent/rules/:tenantId` | none | Signed rule bundle |
| `POST` | `/sync/node-events` | mTLS client cert | Batched events from backend nodes |

### Packages
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/packages` | JWT + `packages:write` | Upload or register a package |
| `GET`  | `/packages` | JWT + `packages:read` | List packages |
| `POST` | `/packages/:id/deploy-all` | JWT + `deployments:write` | Deploy to all applicable devices |

### Dashboard
| Method | Path | Auth | Description |
|---|---|---|---|
| `GET`  | `/ui` | JWT | Built-in management dashboard |
| `GET`  | `/dashboard` | JWT | Dashboard summary API |
| `GET`  | `/audit` | JWT (auditor+) | Audit log |
| `GET`  | `/security/posture` | JWT (admin+) | Security posture score, findings, and category breakdown |
| `POST` | `/security/posture/fix` | JWT (admin+) | Apply safe posture auto-fixes |

### SIEM
| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/siem/config/:tenantId` | JWT + `tasks:manage` | Read tenant SIEM configuration |
| `PUT` | `/siem/config/:tenantId` | JWT + `tasks:sign` | Save Webhook, Syslog, and Sentinel settings |
| `POST` | `/siem/test/:tenantId` | JWT + `tasks:manage` | Send a synthetic event to configured exporters |
| `POST` | `/siem/verify/:tenantId` | JWT + `tasks:manage` | Check configured exporter connectivity |
| `GET` | `/siem/queue/status` | JWT + `audit:read` | Read queued event depth |
| `GET` | `/siem/queue/dlq` | JWT + `audit:read` | Inspect dead-lettered events |

---

## SIEM Integrations

1Patch emits structured security events through a centralized, non-blocking pipeline. Events are queued in Dragonfly, appended to the operational SIEM log, persisted in PostgreSQL (`siem_events`), hash-chained, filtered by tenant mode, and exported by pluggable exporters. Exporter failures are retried and then moved to the SIEM dead-letter queue without blocking authentication, task execution, or node operations.

Supported exporters:
- Webhook: HTTPS `POST` of a JSON event array, optional `x-1patch-signature` HMAC.
- Syslog: RFC5424 over UDP or TCP. Severity maps `low=info`, `medium=warning`, `high=error`, `critical=critical`.
- Microsoft Sentinel: Azure Log Analytics HTTP Data Collector API with `Workspace ID`, `Shared Key`, and `Log-Type` such as `OnePatchEvents`.

Tenant configuration shape:

```json
{
  "mode": "standard",
  "webhook": { "url": "https://siem.example/events", "secret": "optional-hmac-secret" },
  "syslog": { "host": "syslog.example", "port": 514, "protocol": "udp", "appName": "1patch" },
  "sentinel": { "workspaceId": "...", "sharedKey": "...", "logType": "OnePatchEvents" },
  "exportOverrides": { "auth.login.success": false }
}
```

Modes:
- `minimal`: critical security events only.
- `standard`: authentication, task, node, and security events.
- `full`: all emitted events.

Microsoft Sentinel setup:
1. Create or choose a Log Analytics workspace in Azure.
2. Copy the Workspace ID and a Primary or Secondary shared key from the workspace agents/settings page.
3. In `/ui/siem`, set `Log type` to `OnePatchEvents`, save, then run Verify and Test.
4. Query the custom table in Sentinel/Log Analytics. Depending on Azure table suffixing, it may appear as `OnePatchEvents_CL`.

Example KQL:

```kusto
OnePatchEvents_CL
| where severity_s == "critical"
| order by timestamp_t desc
```

If your workspace exposes the table without the custom-log suffix:

```kusto
OnePatchEvents
| where severity == "critical"
| order by timestamp desc
```

Debug operations:
- Dashboard: open `/ui/siem`, then use Verify or Test.
- API/CLI wrappers can call `POST /siem/verify/:tenantId` and `POST /siem/test/:tenantId`, matching `1patch siem verify` and `1patch siem test` behavior.

---

## Security Controls

- JWT secret and management signing key config are enforced at startup.
- Vault AppRole token is refreshed automatically 5 minutes before expiry.
- Every backend node receives a Vault-issued EC P-256 mTLS certificate with a 24-hour TTL. The node renews automatically 2 hours before expiry. Certs are revoked immediately when a node is decommissioned.
- Node authentication is **mTLS-only** — the `MtlsNodeGuard` reads the TLS peer certificate, verifies Vault CA trust via `socket.authorized`, and extracts the `nodeId` from the certificate CN (`<nodeId>.1patch.internal`). No header-based shared secrets exist.
- Enrollment tokens are one-time use with a 24-hour TTL. Replay and reuse are both rejected.
- Admin endpoints require normal login JWTs plus RBAC permissions; no static admin token is accepted.
- Decommission calls to backend nodes are authenticated with a per-node token (unique per node, hash stored server-side) rather than a shared secret.
- MFA failure counters are tracked per challenge token with a maximum of 5 attempts.
- Account lockout activates after 5 consecutive failed password attempts (15-minute cooldown).

---

## Security Posture Dashboard

Open `/ui/security-posture` to review whether a tenant is secure enough for enterprise use. The posture report starts at 100 and deducts:

- Critical: 30 points per issue
- High: 15 points per issue
- Medium: 5 points per issue
- Info: no score impact

The score is clamped between 0 and 100. Findings are grouped by Task Security, Signing & Keys, Nodes, Admin & MFA, Audit, SIEM, Policies, and Kill Switch. Each finding explains the condition, the enterprise risk, and the concrete fix.

The dashboard can re-run checks on demand, export JSON or PDF, and apply safe fixes such as enabling delayed execution, requiring MFA approval for task signing, and enforcing the minimum execution delay. Critical remediations remain manual by design and must be confirmed outside the safe-fix flow.

Use the category breakdown to prioritize work:

- Critical categories block enterprise readiness until fixed.
- Warning categories indicate hardening or operational-control gaps.
- Good categories have no active findings from the current checks.

Improving the score usually means enabling strict or tinfoil policies, keeping admin MFA mandatory, maintaining signed task ledger coverage, rotating scoped signing keys, ensuring every backend node reports with a valid mTLS certificate, verifying audit-chain integrity, configuring SIEM export, and testing the kill switch.

---

## Development

```powershell
npm install
npm run dev        # ts-node watch mode on port 4100
```

Vault and mTLS are not required in development. The server starts over plain HTTP and logs a warning. In dev mode `MtlsNodeGuard` falls back to reading `nodeId` from the request body — this fallback is hard-rejected in `NODE_ENV=production`.

```powershell
npm run typecheck  # tsc --noEmit
npm test           # jest
```

---

## Ports

| Port | Protocol | Purpose |
|---|---|---|
| `4100` | HTTPS (prod) / HTTP (dev) | All API and dashboard traffic |
| `8200` | HTTP (localhost only) | Vault — not exposed externally |
