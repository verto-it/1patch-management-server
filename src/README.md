# Management Server Source

This folder contains the 1Patch control plane. It owns operator authentication, node identity, package metadata, patch rules, task authorization, signing, audit, SIEM export, and the built-in dashboard.

## Runtime Flow

1. `main.ts` builds the Nest app, configures body limits, CORS, Swagger in development, and HTTP or HTTPS depending on TLS environment variables.
2. `app.module.ts` wires controllers and providers. Security-sensitive providers are singletons so guards, storage, signing, and audit state are shared consistently.
3. Operators authenticate through `auth/`, then every protected route combines `JwtAuthGuard`, `RbacGuard`, and `RequirePermission`.
4. Backend nodes register once with an enrollment token, then use Vault-issued mTLS client certificates for heartbeat, task pull, sync, and renewal.
5. Clients never call management task endpoints directly. They receive signed bootstrap and rule bundles, then work through backend nodes.

## Directory Guide

| Path | Notes |
|---|---|
| `agent/` | Public client bootstrap and signed rule bundle endpoints. |
| `apps/` | Fleet app aggregation and app-level update task creation. |
| `audit/` | Append-only audit events and hash-chain verification. |
| `auth/` | Owner creation, login, MFA challenge flow, session issuing, password policy. |
| `nodes/` | Backend node enrollment, registration, mTLS renewal, heartbeat, decommission. |
| `rules/` | Rule CRUD, rule templates, dry-run checks, and manual task generation. |
| `security/` | Guards, permission decorators, current-user helpers, mTLS node identity extraction. |
| `security-posture/` | Enterprise readiness scoring and safe auto-fixes. |
| `siem/` | Event pipeline, tenant config, exporters, queue health, dead-letter inspection. |
| `storage/` | PostgreSQL canonical snapshots and Dragonfly runtime/cache helpers. |
| `tasks/` | Draft, scan, approve, sign, ledger, kill switch, tenant policy, node dispatch. |
| `vault/` | Vault AppRole login and node certificate issue/revoke integration. |
| `dashboard-ui/` | Browser dashboard source served by `dashboard-ui.controller.ts`. |

## Data Stores

- PostgreSQL is the canonical store for users, nodes, devices, packages, rules, tasks, alarms, audit, SIEM events, ledgers, and policy state.
- Dragonfly is used for runtime/cache data such as dashboard history, queue depth, and fast JSON snapshots.
- `MemoryStore` keeps the in-process snapshot used by controllers and services. Persistence flows through PostgreSQL and Dragonfly helpers.

## Security Boundaries

- Operator routes require JWT plus RBAC permission checks.
- Node routes require mTLS through `MtlsNodeGuard`; header shared secrets are intentionally not accepted.
- Task execution is gated by security scan, MFA approval, scoped ES256 signatures, task ledger records, tenant policy, and kill switch state.
- Signing scopes are isolated. A key for one payload class must not sign another payload class.

## Documentation Notes

Source functions in TypeScript and JSX files have JSDoc. Keep comments focused on why a function exists, what its inputs mean, and what boundary it protects. CSS is documented through variables, selectors, and cascade structure.
