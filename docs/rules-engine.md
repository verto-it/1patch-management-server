# Rules Engine

Rules automate policy decisions without changing the 1Patch trust boundary. A rule can decide that work should be created, but it never executes work itself.

Execution flow:

```text
rule trigger -> condition evaluation -> task draft -> security scan -> approval -> signing -> delay window -> signed dispatch -> SIEM/audit
```

Rules cannot create arbitrary commands, invisible tasks, unsigned work, kill-switch changes, or SIEM bypasses. The client remains unaware of rules and only receives signed task bundles with active ledger entries.

## Rule Shape

```json
{
  "tenantId": "default",
  "name": "Auto patch Chrome weekly",
  "enabled": true,
  "priority": 100,
  "trigger": { "type": "schedule" },
  "conditionGroup": {
    "combinator": "AND",
    "conditions": [
      { "field": "device.os", "operator": "eq", "value": "windows" },
      { "field": "package.name", "operator": "contains", "value": "chrome" },
      { "field": "package.outdated", "operator": "eq", "value": true }
    ]
  },
  "actions": [
    { "type": "create_patch_task", "mode": "specific_package", "packageName": "Google Chrome", "targetVersion": "latest" }
  ],
  "schedule": {
    "cron": "0 2 * * 0",
    "maintenanceWindow": { "startHourUtc": 0, "endHourUtc": 6 }
  },
  "safeMode": { "enabled": true, "requireApprovalAtRiskScore": 60 }
}
```

## Conditions

Conditions are grouped with `AND` or `OR`.

Supported fields include:

- `device.os`, `device.hostname`, `device.group`, `device.tag`, `device.deviceTrustScore`
- `package.outdated`, `package.name`, `package.version`
- `lastTask.failed`, `lastTask.retryCount`
- `currentTime.maintenanceWindow`
- `riskScore`

Supported operators are `eq`, `neq`, `contains`, `matches`, `lt`, `lte`, `gt`, `gte`, and `in`.

## Actions

Allowed actions are intentionally narrow:

- `create_patch_task`: `specific_package` or `all_outdated`; `specific_package` requires `packageName`, `packageNames`, or `packageId`
- `create_security_task`: `refresh_inventory`
- `notify`: SIEM only in this release
- `mark_device`: add a safe metadata tag
- `block_task_creation`: stop a candidate task and record the reason

Unsupported actions are rejected until the signed task pipeline supports them.

## Rule Templates

Rule templates are predefined blueprints that help admins create practical rules without skipping review. Selecting a template calls `POST /rule-templates/:id/create-draft` with the required inputs and returns a normal `PatchRule` draft plus a human-readable preview.

Templates are helpers, not a separate execution path:

- generated rules are always returned with `enabled: false`
- every field can be edited before the rule is saved
- saved rules still use `POST /rules` and the normal rule lifecycle
- task-producing rules still create visible task drafts, run security scan, require approval, get signed, honor delay windows, and emit SIEM/audit events
- templates cannot create arbitrary commands, hidden tasks, unsigned work, or client-visible work outside the task ledger
- strict and tinfoil tenants receive stricter generated defaults such as lower approval thresholds and smaller max-device caps

Template API:

- `GET /rule-templates`
- `GET /rule-templates/:id`
- `POST /rule-templates/:id/create-draft`
- `POST /rule-templates/custom`
- `POST /rule-templates/custom/import`
- `GET /rule-templates/custom/export`

Default templates:

- Weekly Browser Updates
- Critical Patch Fast Track
- Patch Test Group First
- Chrome Zero-Day Response
- Microsoft Edge Stable Ring
- Firefox Maintenance Ring
- Developer Tooling Weekly
- Collaboration Apps Weekly
- VPN Client Maintenance
- Refresh Inventory Daily
- Inventory Before Maintenance
- Low-Trust Inventory Refresh
- Retry Failed Package Update
- Repeated Failure Inventory Reset
- Failed Task SIEM Escalation
- Notify on High-Risk Task
- Stale Inventory Notification
- Production Package Window
- Production Hotfix Window
- Block Production Outside Window
- Block Unsafe Automation
- Low-Trust Automation Block

Template audit and SIEM events:

- `rule_template.selected`
- `rule_template.draft_created`
- `rule_template.custom_created`
- `rule.created_from_template`

## Examples

Auto patch Chrome weekly:

```json
{
  "name": "Auto patch Chrome weekly",
  "trigger": { "type": "schedule" },
  "conditionGroup": {
    "combinator": "AND",
    "conditions": [
      { "field": "device.os", "operator": "eq", "value": "windows" },
      { "field": "package.name", "operator": "contains", "value": "chrome" },
      { "field": "package.outdated", "operator": "eq", "value": true }
    ]
  },
  "actions": [{ "type": "create_patch_task", "mode": "specific_package", "packageName": "Google Chrome", "targetVersion": "latest" }]
}
```

Patch only critical production devices:

```json
{
  "name": "Production critical safe patch",
  "conditionGroup": {
    "combinator": "AND",
    "conditions": [
      { "field": "device.group", "operator": "eq", "value": "production" },
      { "field": "riskScore", "operator": "gt", "value": 60 },
      { "field": "package.outdated", "operator": "eq", "value": true }
    ]
  },
  "actions": [{ "type": "create_patch_task", "mode": "all_outdated", "maxDevices": 10 }],
  "safeMode": { "enabled": true, "requireApprovalAtRiskScore": 60 }
}
```

Retry failed updates:

```json
{
  "name": "Retry failed updates",
  "trigger": { "type": "event", "eventType": "task.failed" },
  "conditionGroup": {
    "combinator": "AND",
    "conditions": [
      { "field": "lastTask.failed", "operator": "eq", "value": true },
      { "field": "lastTask.retryCount", "operator": "lt", "value": 3 }
    ]
  },
  "actions": [{ "type": "create_security_task", "task": "refresh_inventory" }]
}
```

## Simulation

Use `POST /rules/:id/test` with an optional `deviceId` to see:

- whether the rule would trigger
- condition-by-condition reasons
- task drafts or notifications it would create
- estimated risk score
- conflicts and rate-limit state

## Audit And SIEM

Each execution records audit entries and emits SIEM events:

- `rule.triggered`
- `rule.executed`
- `rule.failed`
- `rule.conflict_detected`
- `rule.rate_limited`

Execution records are visible from `GET /rules/audit` and `GET /rules/:id/audit`.
