# Agent and Backend Node API Contract

## Client Bootstrap

`GET /agent/bootstrap/:tenantId` returns a signed manifest:

```json
{
  "payload": {
    "tenantId": "tenant-id",
    "issuedAt": "2026-04-30T00:00:00.000Z",
    "nodes": [{ "id": "node-id", "publicUrl": "https://node.example.com" }]
  },
  "signature": "hex-hmac",
  "algorithm": "HMAC-SHA256"
}
```

Clients verify signatures before trusting backend-node URLs.

## Backend Node Sync

Backend nodes queue local events and replay them to `POST /sync/node-events`.

Event types for v1:

- `inventory`
- `heartbeat`
- `task_result`
- `alarm`
