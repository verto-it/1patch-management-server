param(
  [Parameter(Mandatory = $true)][string]$PostgresServerUrl,
  [Parameter(Mandatory = $true)][string]$DatabaseName,
  [Parameter(Mandatory = $true)][string]$DragonflyUrl,
  [Parameter(Mandatory = $true)][string]$OwnerEmail,
  [Parameter(Mandatory = $false)][string]$OwnerPassword,
  [Parameter(Mandatory = $false)][string]$ManagementUrl = "http://127.0.0.1:4100",
  [switch]$SkipOwnerCreate
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($OwnerPassword)) {
  $secure = Read-Host "Owner password" -AsSecureString
  $OwnerPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

$databaseUrl = "$($PostgresServerUrl.TrimEnd('/'))/$DatabaseName"

@"
NODE_ENV=production
PORT=4100
PUBLIC_URL=https://manage.1patch.local
DATABASE_URL=$databaseUrl
DRAGONFLY_URL=$DragonflyUrl
PACKAGE_STORAGE_PATH=./packages
JWT_SECRET=$([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)))
SIGNING_SECRET=$([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)))
ADMIN_API_TOKEN=$([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)))
FIRST_OWNER_EMAIL=$OwnerEmail
FIRST_OWNER_PASSWORD=$OwnerPassword
"@ | Set-Content -Path ".env" -Encoding utf8

Write-Host "Wrote .env"
Write-Host "Database URL: $databaseUrl"
Write-Host "Dragonfly URL: $DragonflyUrl"

if (Get-Command psql -ErrorAction SilentlyContinue) {
  $adminUrl = $PostgresServerUrl.TrimEnd('/')
  Write-Host "Creating database if it does not exist. This requires createdb permission."
  $exists = psql $adminUrl -tAc "SELECT 1 FROM pg_database WHERE datname = '$DatabaseName'"
  if ($exists.Trim() -ne "1") {
    psql $adminUrl -c "CREATE DATABASE `"$DatabaseName`";"
  }

  Write-Host "Applying Phase 3 schema."
  psql $databaseUrl -f ".\scripts\schema-management.sql"
} else {
  Write-Host "psql was not found. Create database '$DatabaseName' manually or install PostgreSQL client tools."
}

if (-not $SkipOwnerCreate) {
  Write-Host "If the server is running, creating first owner via API."
  try {
    Invoke-RestMethod -Method Post "$ManagementUrl/setup/owner" -ContentType "application/json" -Body (@{
      email = $OwnerEmail
      password = $OwnerPassword
    } | ConvertTo-Json) | Out-Null
    Write-Host "Owner user created."
  } catch {
    Write-Host "Owner was not created through the API. Start the server and POST /setup/owner manually. $($_.Exception.Message)"
  }
}

Write-Host "Run: npm install && npm run build && npm start"
