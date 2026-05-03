param(
  [Parameter(Mandatory = $true)][string]$PostgresServerUrl,
  [Parameter(Mandatory = $true)][string]$DatabaseName,
  [Parameter(Mandatory = $true)][string]$DragonflyUrl,
  [Parameter(Mandatory = $true)][string]$OwnerEmail,
  [Parameter(Mandatory = $false)][string]$OwnerPassword,
  [Parameter(Mandatory = $false)][string]$AdminApiToken,
  [Parameter(Mandatory = $false)][string]$ManagementUrl = "http://127.0.0.1:4100",
  # Comma-separated list of browser origins allowed to call the API, e.g. "https://manage.example.com"
  [Parameter(Mandatory = $false)][string]$CorsAllowedOrigins = "",
  [switch]$SkipOwnerCreate,
  # Vault PKI — output of vault\init-pki.ps1
  [Parameter(Mandatory = $false)][string]$VaultAddr            = "http://127.0.0.1:8200",
  [Parameter(Mandatory = $false)][string]$VaultApproleRoleId   = "",
  [Parameter(Mandatory = $false)][string]$VaultApproleSecretId = "",
  [Parameter(Mandatory = $false)][string]$TlsCertPath          = "C:\ProgramData\1Patch\tls\management.crt",
  [Parameter(Mandatory = $false)][string]$TlsKeyPath           = "C:\ProgramData\1Patch\tls\management.key",
  [Parameter(Mandatory = $false)][string]$TlsCaPath            = "C:\ProgramData\1Patch\tls\ca.crt"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($OwnerPassword)) {
  $secure = Read-Host "Owner password" -AsSecureString
  $OwnerPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

if ([string]::IsNullOrWhiteSpace($AdminApiToken)) {
  $AdminApiToken = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
}

# Generate all secrets up-front so they can be printed together at the end
$jwtSecret      = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$signingSecret  = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
# NODE_API_SECRET is the shared secret that every backend node must present.
# It is embedded in enrollment JSON by the management server so the backend-node
# wizard receives it automatically via copy-paste.
$nodeApiSecret  = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))

$databaseUrl = "$($PostgresServerUrl.TrimEnd('/'))/$DatabaseName"


@"
NODE_ENV=production
PORT=4100
PUBLIC_URL=https://manage.1patch.local
DATABASE_URL=$databaseUrl
DRAGONFLY_URL=$DragonflyUrl
PACKAGE_STORAGE_PATH=./packages
JWT_SECRET=$jwtSecret
SIGNING_SECRET=$signingSecret
ADMIN_API_TOKEN=$AdminApiToken
NODE_API_SECRET=$nodeApiSecret
CORS_ALLOWED_ORIGINS=$CorsAllowedOrigins
FIRST_OWNER_EMAIL=$OwnerEmail
FIRST_OWNER_PASSWORD=$OwnerPassword
VAULT_ADDR=$VaultAddr
VAULT_APPROLE_ROLE_ID=$VaultApproleRoleId
VAULT_APPROLE_SECRET_ID=$VaultApproleSecretId
TLS_CERT_PATH=$TlsCertPath
TLS_KEY_PATH=$TlsKeyPath
TLS_CA_PATH=$TlsCaPath
"@ | Set-Content -Path ".env" -Encoding utf8

Write-Host ""
Write-Host "=== 1Patch Management Server Setup Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Wrote .env" -ForegroundColor Cyan
Write-Host "Database URL:          $databaseUrl"
Write-Host "Dragonfly URL:         $DragonflyUrl"
if ($CorsAllowedOrigins) {
  Write-Host "CORS Allowed Origins:  $CorsAllowedOrigins"
} else {
  Write-Host "CORS Allowed Origins:  (none — browser access disabled until CORS_ALLOWED_ORIGINS is set)" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "--- Secrets (store securely — shown once) ---" -ForegroundColor Yellow
Write-Host "ADMIN_API_TOKEN:  $AdminApiToken"
Write-Host "NODE_API_SECRET:  $nodeApiSecret"
Write-Host ""
Write-Host "Copy NODE_API_SECRET to every backend node's .env (or let the enrollment JSON wizard do it automatically)." -ForegroundColor Yellow
Write-Host ""

if (Get-Command psql -ErrorAction SilentlyContinue) {
  $adminUrl = $PostgresServerUrl.TrimEnd('/')
  Write-Host "Creating database if it does not exist..." -ForegroundColor Cyan
  $exists = psql $adminUrl -tAc "SELECT 1 FROM pg_database WHERE datname = '$DatabaseName'"
  if ($exists.Trim() -ne "1") {
    psql $adminUrl -c "CREATE DATABASE `"$DatabaseName`";"
    Write-Host "Database '$DatabaseName' created."
  } else {
    Write-Host "Database '$DatabaseName' already exists — skipping creation."
  }
  Write-Host "Applying schema..." -ForegroundColor Cyan
  psql $databaseUrl -f ".\scripts\schema-management.sql"
  Write-Host "Schema applied."
} else {
  Write-Host "psql not found. Create database '$DatabaseName' manually and apply .\scripts\schema-management.sql." -ForegroundColor Yellow
}

if (-not $SkipOwnerCreate) {
  Write-Host "Creating first owner account via API (server must already be running)..." -ForegroundColor Cyan
  try {
    Invoke-RestMethod -Method Post "$ManagementUrl/setup/owner" `
      -ContentType "application/json" `
      -Body (@{ email = $OwnerEmail; password = $OwnerPassword } | ConvertTo-Json) | Out-Null
    Write-Host "Owner account created for $OwnerEmail." -ForegroundColor Green
  } catch {
    Write-Host "Owner was not created via the API (server may not be running yet). Start the server and POST /setup/owner manually." -ForegroundColor Yellow
    Write-Host $_.Exception.Message
  }
}

Write-Host ""
Write-Host "Next: npm install && npm run build && npm start" -ForegroundColor Cyan