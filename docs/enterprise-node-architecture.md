# Enterprise Backend Node Architecture

1Patch backend nodes are regional execution, cache, and trust nodes. The
management server remains the control plane; nodes never create or modify tasks.

## Routing

Clients receive a signed `bootstrap_manifest` containing policy-eligible nodes
ranked by:

- tenant routing policy
- health state
- trust score
- quarantine and maintenance state
- required capabilities
- preferred and excluded nodes
- regional and local-site constraints
- latency hints

Routing denies nodes that are offline, quarantined, in maintenance, draining,
missing required capabilities, or disallowed by policy.

Routing policy endpoint:

- `GET /nodes/routing-policy/:tenantId`
- `PATCH /nodes/routing-policy/:tenantId`

Example:

```json
{
  "mode": "eu_only",
  "trustedOnly": true,
  "preferredNodeIds": ["node-a"],
  "excludedNodeIds": ["node-b"],
  "requiredCapabilities": ["windows-patching", "winget-cache"]
}
```

## Signed Node Health

Every backend node generates a local ES256 application signing key and publishes
the public key during registration. Health reports are accepted only when:

- the request uses node mTLS
- the envelope is signed by the registered node key
- the nonce was issued by `/nodes/challenge/node_health_report`
- timestamps are inside the allowed skew window
- the payload hash matches
- the nonce has not been consumed before

Health reports include queue lag, cache health, scanner health, package verifier
state, certificate expiry, clock skew, memory pressure, disk state, update source
reachability, capabilities, and component-level status.

## Trust And Quarantine

Nodes start at trust score `80`. Signed healthy reports increase trust slowly.
Unhealthy components, scanner/cache/package verifier failures, clock skew,
invalid signatures, replay attempts, cache integrity failures, and repeated
failures lower trust.

Nodes are automatically quarantined when trust drops below
`NODE_QUARANTINE_TRUST_THRESHOLD` or when severe security events occur.
Quarantined nodes receive no task bundles and are excluded from client routing.
Manual reapproval is done with:

```http
POST /nodes/:nodeId/quarantine/clear
```

## Cache And File Reputation

Backend nodes cache packages atomically, persist verification sidecars, and
re-hash files before serving them. Failed cache verification is attested back to
management and penalizes node trust.

Management file reputation combines:

- SHA256 allow/deny lists
- package signature metadata
- suspicious filename/path checks
- entropy heuristic
- optional VirusTotal hash lookup via tenant policy API key

Environment examples:

```env
NODE_CAPABILITIES=windows-patching,winget-cache,chocolatey-cache,regional-cache
NODE_REGION=eu-central
NODE_SITE=berlin-1
NODE_UPDATE_CHANNEL=stable
NODE_QUARANTINE_TRUST_THRESHOLD=30
FILE_REPUTATION_ALLOWLIST_SHA256=
FILE_REPUTATION_DENYLIST_SHA256=
```

## Dashboard

The Nodes page is now the Node Trust Center. It shows health, region, latency
hints, trust score, scanner/cache/cert state, maintenance state, quarantine
state, capabilities, failover evidence, trust history, and node audit context.
