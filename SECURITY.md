# Security Policy

Security is treated as a release blocker for 1Patch.

## Reporting

Report vulnerabilities privately to security@1patch.app. Do not open public issues for exploitable bugs.

## Baseline Requirements

- MFA is required for owner/admin accounts in production.
- OAuth may only be enabled after a local owner exists.
- Backend-node and client traffic must use HTTPS outside local development.
- Installer/package execution must be allowlisted and hash verified.
- Privileged actions must create audit events.
