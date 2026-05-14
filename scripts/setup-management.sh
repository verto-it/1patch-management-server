#!/usr/bin/env bash
# setup-management.sh — Generate .env for the 1Patch management server on Linux.
# Run inside the 1patch-management-server directory.
#
# Prerequisites:
#   - Node.js 20+ on PATH (used for EC key generation; same runtime the server needs)
#   - psql on PATH if you want automatic database setup (optional)
#   - Run AFTER vault/init-pki.sh — you'll need the Vault AppRole credentials it prints
#
# Usage:
#   ./scripts/setup-management.sh \
#     --postgres  "postgres://1patch:secret@localhost:5432" \
#     --db        "1patch" \
#     --dragonfly "redis://localhost:6379" \
#     --owner     "owner@example.com" \
#     --vault-addr           "http://127.0.0.1:8200" \
#     --vault-role-id        "<from init-pki.sh output>" \
#     --vault-secret-id      "<from init-pki.sh output>" \
#     --tls-cert "/etc/1patch/tls/management.crt" \
#     --tls-key  "/etc/1patch/tls/management.key" \
#     --tls-ca   "/etc/1patch/tls/ca.crt"

set -euo pipefail

POSTGRES_SERVER_URL=""
DATABASE_NAME="1patch"
DRAGONFLY_URL=""
OWNER_EMAIL=""
OWNER_PASSWORD=""
MANAGEMENT_URL="http://127.0.0.1:4100"
CORS_ALLOWED_ORIGINS=""
VAULT_ADDR_VAL="http://127.0.0.1:8200"
VAULT_APPROLE_ROLE_ID=""
VAULT_APPROLE_SECRET_ID=""
TLS_CERT_PATH="/etc/1patch/tls/management.crt"
TLS_KEY_PATH="/etc/1patch/tls/management.key"
TLS_CA_PATH="/etc/1patch/tls/ca.crt"
SKIP_OWNER_CREATE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --postgres)           POSTGRES_SERVER_URL="$2";    shift 2 ;;
    --db)                 DATABASE_NAME="$2";           shift 2 ;;
    --dragonfly)          DRAGONFLY_URL="$2";           shift 2 ;;
    --owner)              OWNER_EMAIL="$2";             shift 2 ;;
    --password)           OWNER_PASSWORD="$2";          shift 2 ;;
    --mgmt-url)           MANAGEMENT_URL="$2";          shift 2 ;;
    --cors)               CORS_ALLOWED_ORIGINS="$2";    shift 2 ;;
    --vault-addr)         VAULT_ADDR_VAL="$2";          shift 2 ;;
    --vault-role-id)      VAULT_APPROLE_ROLE_ID="$2";   shift 2 ;;
    --vault-secret-id)    VAULT_APPROLE_SECRET_ID="$2"; shift 2 ;;
    --tls-cert)           TLS_CERT_PATH="$2";           shift 2 ;;
    --tls-key)            TLS_KEY_PATH="$2";            shift 2 ;;
    --tls-ca)             TLS_CA_PATH="$2";             shift 2 ;;
    --skip-owner-create)  SKIP_OWNER_CREATE=true;       shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${CYAN}$1${NC}"; }
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠  $1${NC}"; }
die()  { echo -e "${RED}✗ $1${NC}" >&2; exit 1; }

[[ -z "$POSTGRES_SERVER_URL" ]] && die "--postgres is required (e.g. postgres://user:pass@localhost:5432)"
[[ -z "$DRAGONFLY_URL"       ]] && die "--dragonfly is required (e.g. redis://localhost:6379)"
[[ -z "$OWNER_EMAIL"         ]] && die "--owner is required"

command -v node >/dev/null 2>&1 || die "node not found on PATH — Node.js 20+ is required"

if [[ -z "$OWNER_PASSWORD" ]]; then
  read -rsp "Owner password: " OWNER_PASSWORD; echo
fi

# ── generate secrets using Node.js (already required by the server) ───────────

log "Generating signing keys and JWT secret..."
SECRETS_JSON=$(node -e "
const crypto = require('crypto');
const jwtSecret = crypto.randomBytes(32).toString('hex');
const scopes    = ['bootstrap_manifest','rule_bundle','task_bundle','task_ledger','kill_switch','recovery_task'];
const issuedAt  = new Date().toISOString();
const activeKeys = {}, privateKeys = {}, keyMetadata = {};
for (const scope of scopes) {
  const keyId = 'key_' + scope + '_v1';
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicPem  = publicKey.export({ type: 'spki',  format: 'pem' });
  activeKeys[scope]  = keyId;
  privateKeys[keyId] = Buffer.from(privatePem).toString('base64');
  keyMetadata[keyId] = { keyId, scope, status: 'active', issuedAt, isDev: false, algorithm: 'ES256', publicKeyPem: publicPem };
}
process.stdout.write(JSON.stringify({ jwtSecret, activeKeys, privateKeys, keyMetadata }));
")

JWT_SECRET=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).jwtSecret)"         -- "$SECRETS_JSON")
ACTIVE_KEYS=$(node -e "process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).activeKeys))"  -- "$SECRETS_JSON")
PRIV_KEYS=$(node -e  "process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).privateKeys))"  -- "$SECRETS_JSON")
KEY_META=$(node -e   "process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).keyMetadata))"  -- "$SECRETS_JSON")

DATABASE_URL="${POSTGRES_SERVER_URL%/}/${DATABASE_NAME}"

# ── write .env ────────────────────────────────────────────────────────────────

cat > .env <<EOF
NODE_ENV=production
PORT=4100
PUBLIC_URL=https://manage.1patch.local
DATABASE_URL=${DATABASE_URL}
DRAGONFLY_URL=${DRAGONFLY_URL}
PACKAGE_STORAGE_PATH=./packages
JWT_SECRET=${JWT_SECRET}
MANAGEMENT_SIGNING_ACTIVE_KEYS_JSON=${ACTIVE_KEYS}
MANAGEMENT_SIGNING_PRIVATE_KEYS_JSON=${PRIV_KEYS}
MANAGEMENT_SIGNING_KEY_METADATA_JSON=${KEY_META}
CORS_ALLOWED_ORIGINS=${CORS_ALLOWED_ORIGINS}
FIRST_OWNER_EMAIL=${OWNER_EMAIL}
FIRST_OWNER_PASSWORD=${OWNER_PASSWORD}
VAULT_ADDR=${VAULT_ADDR_VAL}
VAULT_APPROLE_ROLE_ID=${VAULT_APPROLE_ROLE_ID}
VAULT_APPROLE_SECRET_ID=${VAULT_APPROLE_SECRET_ID}
TLS_CERT_PATH=${TLS_CERT_PATH}
TLS_KEY_PATH=${TLS_KEY_PATH}
TLS_CA_PATH=${TLS_CA_PATH}
EOF

ok ".env written"

# ── set up database ───────────────────────────────────────────────────────────

if command -v psql >/dev/null 2>&1; then
  log "Creating database '${DATABASE_NAME}' if it does not exist..."
  EXISTS=$(psql "${POSTGRES_SERVER_URL}" -tAc "SELECT 1 FROM pg_database WHERE datname = '${DATABASE_NAME}'" 2>/dev/null || true)
  if [[ "$EXISTS" != "1" ]]; then
    psql "${POSTGRES_SERVER_URL}" -c "CREATE DATABASE \"${DATABASE_NAME}\";"
    ok "Database '${DATABASE_NAME}' created"
  else
    ok "Database '${DATABASE_NAME}' already exists"
  fi
  log "Applying schema..."
  psql "${DATABASE_URL}" -f "./scripts/schema-management.sql"
  ok "Schema applied"
else
  warn "psql not found — create database '${DATABASE_NAME}' manually and apply ./scripts/schema-management.sql"
fi

# ── print summary ─────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}=== Management server setup complete ===${NC}"
echo ""
echo "  Database:  ${DATABASE_URL}"
echo "  Cache:     ${DRAGONFLY_URL}"
[[ -n "$CORS_ALLOWED_ORIGINS" ]] && echo "  CORS:      ${CORS_ALLOWED_ORIGINS}" \
  || warn "CORS_ALLOWED_ORIGINS is empty — browser access is disabled until it is set"
echo ""
echo -e "${CYAN}Next: npm install && npm run build && npm start${NC}"
echo ""

if [[ "$SKIP_OWNER_CREATE" == "false" ]]; then
  log "Attempting to create owner account via API (server must already be running)..."
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${MANAGEMENT_URL}/setup/owner" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${OWNER_EMAIL}\",\"password\":\"${OWNER_PASSWORD}\"}" || true)
  if [[ "$HTTP_STATUS" == "201" || "$HTTP_STATUS" == "200" ]]; then
    ok "Owner account created for ${OWNER_EMAIL}"
  else
    warn "Owner account not created yet (HTTP $HTTP_STATUS) — start the server first, then POST /setup/owner"
  fi
fi
