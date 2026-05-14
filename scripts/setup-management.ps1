param(
  [Parameter(Mandatory = $true)][string]$PostgresServerUrl,
  [Parameter(Mandatory = $true)][string]$DatabaseName,
  [Parameter(Mandatory = $true)][string]$DragonflyUrl,
  [Parameter(Mandatory = $true)][string]$OwnerEmail,
  [Parameter(Mandatory = $false)][string]$OwnerPassword,
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

# Generate secrets up-front so they can be printed together at the end
$jwtSecret      = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$scopeNames     = @("bootstrap_manifest", "rule_bundle", "task_bundle", "task_ledger", "kill_switch", "recovery_task")
$activeKeys     = @{}
$privateKeys    = @{}
$keyMetadata    = @{}
$issuedAt       = [DateTimeOffset]::UtcNow.ToString("o")
foreach ($scope in $scopeNames) {
  $signingKeyId = "key_$($scope)_v1"
  $ecdsa        = [Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve+NamedCurves]::nistP256)
  $privatePem   = $ecdsa.ExportPkcs8PrivateKeyPem()
  $publicPem    = $ecdsa.ExportSubjectPublicKeyInfoPem()
  $activeKeys[$scope] = $signingKeyId
  $privateKeys[$signingKeyId] = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($privatePem))
  $keyMetadata[$signingKeyId] = @{
    keyId = $signingKeyId
    scope = $scope
    status = "active"
    issuedAt = $issuedAt
    isDev = $false
    algorithm = "ES256"
    publicKeyPem = $publicPem
  }
}
$activeKeysJson  = $activeKeys  | ConvertTo-Json -Compress
$privateKeysJson = $privateKeys | ConvertTo-Json -Compress
$metadataJson    = $keyMetadata | ConvertTo-Json -Depth 4 -Compress

$databaseUrl = "$($PostgresServerUrl.TrimEnd('/'))/$DatabaseName"

@"
NODE_ENV=production
PORT=4100
PUBLIC_URL=https://manage.1patch.local
DATABASE_URL=$databaseUrl
DRAGONFLY_URL=$DragonflyUrl
PACKAGE_STORAGE_PATH=./packages
JWT_SECRET=$jwtSecret
MANAGEMENT_SIGNING_ACTIVE_KEYS_JSON=$activeKeysJson
MANAGEMENT_SIGNING_PRIVATE_KEYS_JSON=$privateKeysJson
MANAGEMENT_SIGNING_KEY_METADATA_JSON=$metadataJson
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
Write-Host "--- Authentication ---" -ForegroundColor Yellow
Write-Host "Node authentication: mTLS only (Vault-issued certificates)."
Write-Host "No shared secrets are used for node-to-management communication."
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
    $login = Invoke-RestMethod -Method Post "$ManagementUrl/auth/login" `
      -ContentType "application/json" `
      -Body (@{ email = $OwnerEmail; password = $OwnerPassword } | ConvertTo-Json)
    if ($login.accessToken) {
      Write-Host "Owner login succeeded; use this account for further admin setup actions." -ForegroundColor Green
    }
  } catch {
    Write-Host "Owner was not created via the API (server may not be running yet). Start the server and POST /setup/owner manually." -ForegroundColor Yellow
    Write-Host $_.Exception.Message
  }
}

Write-Host ""
Write-Host "Next: npm install && npm run build && npm start" -ForegroundColor Cyan
