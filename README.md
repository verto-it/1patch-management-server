# 1Patch Management Server

AGPLv3 control plane for 1Patch. It owns setup, local/OAuth authentication, RBAC, tenants, app/rule management, backend-node registry, package metadata, update jobs, audit logs, and dashboard APIs.

## Quick Start

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

The current implementation keeps PostgreSQL as the canonical data model and uses DragonflyDB for fast runtime state, queues, sessions, and setup snapshots while database migrations are completed.

## First Setup

Start PostgreSQL and DragonflyDB, then open `/setup` on the management server or run:

```powershell
./scripts/setup-management.ps1 -PostgresServerUrl "postgres://1patch:1patch@localhost:5432" -DatabaseName "1patch_management" -DragonflyUrl "redis://localhost:6379" -OwnerEmail "owner@example.com"
```

PostgreSQL is the canonical database. DragonflyDB is required for fast state, queues, sessions, and setup/runtime snapshots.

## Core Flows

- `POST /setup/owner` creates the first local owner user.
- `POST /auth/login` starts standalone login and may require MFA.
- `POST /auth/mfa/verify` completes MFA login.
- `POST /nodes/register` enrolls a backend node with a node enrollment token.
- `GET /agent/bootstrap/:tenantId` returns a signed backend-node manifest for clients.
- `POST /sync/node-events` receives queued backend-node data.
- `GET /ui` opens the built-in management dashboard backed by real APIs.

## Security Defaults

- AGPL-3.0-only licensing.
- Local owner is required before OAuth can be configured.
- MFA/TOTP and recovery code primitives are present from the first phase.
- RBAC permissions protect management routes.
- Signed node manifests and rule bundles are the default API shape.
- Audit events are emitted for setup, auth, node, rule, and sync actions.
