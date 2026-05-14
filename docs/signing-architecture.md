# Signing Architecture

1Patch management signatures are compartmentalized by signing scope. A key that signs one payload class must never verify another payload class.

## Trust Boundaries

- The management server is the only component with management signing private keys.
- Backend nodes relay signed task and kill-switch envelopes, but they do not create management signatures.
- Clients pin scoped management public keys and verify signatures before trusting bootstrap manifests, kill-switch state, or executable task bundles.

## Scope Isolation

Production requires one active ES256 keypair per scope:

- `bootstrap_manifest`
- `rule_bundle`
- `task_bundle`
- `task_ledger`
- `kill_switch`
- `recovery_task`

Each `SigningKeyMetadata` entry binds a `keyId` to exactly one `scope`, `algorithm`, `status`, `issuedAt`, `isDev`, optional tenant allowlist, and `publicKeyPem`. Wildcard scope (`*`) is development-only compatibility and is rejected in production.

## Signed Envelope Requirements

Every new signed envelope includes:

- `scope`
- `payloadType`
- `tenantId`
- `issuedAt`
- `expiresAt`
- `keyId`
- `payloadHash`
- `nonce`
- `signature`

Verifiers require `scope === payloadType`, recompute `payloadHash` over canonical JSON, enforce tenant restrictions, reject unknown or mismatched key scopes, and reject revoked or expired retired keys.

## Replay Resistance

The signature covers `scope`, `tenantId`, timestamps, `nonce`, `keyId`, `payloadHash`, and payload bytes. A valid `task_bundle` signature cannot be replayed as `task_ledger` or `kill_switch`, because the expected scope and key metadata scope are verified before the signature is trusted.

## Rotation Lifecycle

1. Publish a new key metadata entry for the target scope.
2. Add the private key to `MANAGEMENT_SIGNING_PRIVATE_KEYS_JSON`.
3. Switch `MANAGEMENT_SIGNING_ACTIVE_KEYS_JSON[scope]` to the new key ID.
4. Keep the old key as `retired` with a future `retirementDeadline` so old signatures continue validating.
5. Remove or revoke the old key after the deadline. Revoked keys fail immediately.

Production startup hard-fails if any required scope has no active key, an active key is shared across scopes, active metadata is missing or mismatched, a dev key is active, or wildcard metadata is configured.
