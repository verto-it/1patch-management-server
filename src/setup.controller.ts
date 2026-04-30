import { Body, Controller, Get, Header, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsEmail, IsString, IsUrl, MinLength } from 'class-validator';
import { PostgresService } from './storage/postgres.service';

class SetupConfigDto {
  @IsUrl({ require_tld: false })
  postgresServerUrl!: string;

  @IsString()
  databaseName!: string;

  @IsUrl({ require_tld: false })
  dragonflyUrl!: string;

  @IsEmail()
  ownerEmail!: string;

  @IsString()
  @MinLength(12)
  ownerPassword!: string;
}

@ApiTags('setup')
@Controller('/setup')
export class SetupController {
  constructor(private readonly postgres: PostgresService) {}

  @Get()
  @Header('content-type', 'text/html')
  page() {
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>1Patch Setup</title>
<style>body{font-family:system-ui;margin:0;background:#f7f8fb;color:#18202f}.wrap{max-width:760px;margin:48px auto;padding:24px}label{display:block;margin:16px 0 6px;font-weight:700}input{width:100%;padding:12px;border:1px solid #ccd3df;border-radius:8px}button{margin-top:20px;padding:12px 16px;border:0;border-radius:8px;background:#1463ff;color:white;font-weight:800}pre{white-space:pre-wrap;background:#111827;color:#e5e7eb;padding:16px;border-radius:8px}</style></head>
<body><main class="wrap"><h1>1Patch Management Setup</h1><p>Enter PostgreSQL and DragonflyDB details. The generated script creates the database if the configured database user is allowed to create databases.</p>
<form id="setup"><label>PostgreSQL server URL without database</label><input name="postgresServerUrl" value="postgres://1patch:1patch@localhost:5432" required>
<label>Database name</label><input name="databaseName" value="1patch_management" required>
<label>DragonflyDB URL</label><input name="dragonflyUrl" value="redis://localhost:6379" required>
<label>Owner email</label><input name="ownerEmail" type="email" required>
<label>Owner password</label><input name="ownerPassword" type="password" minlength="12" required>
<button>Generate setup config</button></form><pre id="out"></pre></main>
<script>setup.onsubmit=async(e)=>{e.preventDefault();const data=Object.fromEntries(new FormData(setup).entries());const r=await fetch('/setup/configuration',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});out.textContent=JSON.stringify(await r.json(),null,2)}</script></body></html>`;
  }

  @Post('/configuration')
  configuration(@Body() dto: SetupConfigDto) {
    const databaseUrl = `${dto.postgresServerUrl.replace(/\/$/, '')}/${dto.databaseName}`;
    return {
      env: {
        DATABASE_URL: databaseUrl,
        DRAGONFLY_URL: dto.dragonflyUrl,
        FIRST_OWNER_EMAIL: dto.ownerEmail,
        FIRST_OWNER_PASSWORD: dto.ownerPassword,
      },
      powershell: `./scripts/setup-management.ps1 -PostgresServerUrl '${dto.postgresServerUrl}' -DatabaseName '${dto.databaseName}' -DragonflyUrl '${dto.dragonflyUrl}' -OwnerEmail '${dto.ownerEmail}'`,
      nextSteps: [
        'Run the generated setup script on the management server host.',
        'The script writes .env, creates the database when psql is available, applies schema, and tries to create the first owner if the server is running.',
        'Start or restart the management server.',
      ],
    };
  }

  @Post('/migrate')
  async migrate() {
    await this.postgres.ensureSchema();
    return { migrated: true };
  }
}
