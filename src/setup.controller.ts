import { Body, Controller, Get, Header, Post, Req, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { NodesService } from './nodes/nodes.service';
import { MemoryStore } from './storage/memory.store';
import { DragonflyService } from './storage/dragonfly.service';
import { PostgresService } from './storage/postgres.service';
import { RbacService } from './rbac/rbac.service';
import { Permission } from './types';

class StorageConfigDto {
  @IsString()
  @IsNotEmpty()
  postgresServerUrl!: string;

  @IsString()
  databaseName!: string;

  @IsString()
  @IsNotEmpty()
  dragonflyUrl!: string;
}

class SetupConfigDto extends StorageConfigDto {
  @IsEmail()
  ownerEmail!: string;

  @IsString()
  @MinLength(12)
  ownerPassword!: string;

}

class SetupEnrollmentDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  publicUrl!: string;

  @IsString()
  region?: string;

  @IsString()
  site?: string;
}

@ApiTags('setup')
@Controller('/setup')
export class SetupController {
  constructor(
    private readonly postgres: PostgresService,
    private readonly dragonfly: DragonflyService,
    private readonly nodes: NodesService,
    private readonly store: MemoryStore,
    private readonly jwt: JwtService,
    private readonly rbac: RbacService,
  ) {}

  @Get()
  @Header('content-type', 'text/html')
  @Header('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'")
  page() {
    return managementSetupHtml;
  }

  @Get('/status')
  status() {
    const database = this.postgres.getStatus();
    const dragonfly = this.dragonfly.getStatus();
    return {
      databaseConfigured: database.configured,
      databaseAvailable: database.available,
      databaseError: database.lastError,
      dragonflyConfigured: dragonfly.configured,
      dragonflyAvailable: dragonfly.available,
      dragonflyError: dragonfly.lastError,
      ownerCreated: this.store.users.length > 0,
      nodeCount: this.store.backendNodes.length,
      pendingNodeCount: this.store.backendNodes.filter((node) => node.status === 'pending').length,
      onlineNodeCount: this.store.backendNodes.filter((node) => node.status === 'online').length,
      publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4100}`,
    };
  }

  @Post('/configuration')
  configuration(@Body() dto: SetupConfigDto) {
    const databaseUrl = buildDatabaseUrl(dto.postgresServerUrl, dto.databaseName);
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

  @Post('/test-configuration')
  async testConfiguration(@Body() dto: StorageConfigDto) {
    const databaseUrl = buildDatabaseUrl(dto.postgresServerUrl, dto.databaseName);
    const [database, dragonfly] = await Promise.all([testPostgres(databaseUrl), testDragonfly(dto.dragonflyUrl)]);
    return {
      ok: database.ok && dragonfly.ok,
      database,
      dragonfly,
    };
  }

  @Post('/migrate')
  async migrate(@Req() request: Request) {
    this.assertSetupAccess(request, 'setup:manage');
    await this.postgres.ensureSchema({ throwOnError: true });
    return { migrated: true };
  }

  @Post('/node-enrollment')
  async createNodeEnrollment(@Body() dto: SetupEnrollmentDto, @Req() request: Request) {
    const actor = this.assertSetupAccess(request, 'nodes:enroll');
    return this.nodes.createEnrollment(dto.name, dto.publicUrl, dto.region, dto.site, actor);
  }

  private assertSetupAccess(request: Request, permission: Permission) {
    if (this.store.users.length === 0) return 'setup';
    const token = request.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) throw new UnauthorizedException('Owner authentication required');
    let payload: { sub?: string };
    try {
      payload = this.jwt.verify(token) as { sub?: string };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const user = this.store.users.find((candidate) => candidate.id === payload.sub);
    if (!user) throw new UnauthorizedException('Unknown user');
    if (!this.rbac.can(user, permission)) throw new ForbiddenException('Insufficient permission');
    return user.id;
  }
}

function buildDatabaseUrl(postgresServerUrl: string, databaseName: string) {
  return `${postgresServerUrl.replace(/\/$/, '')}/${databaseName}`;
}

async function testPostgres(connectionString: string) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 2000, max: 1 });
  try {
    await pool.query('select 1');
    return { ok: true, url: connectionString };
  } catch (error) {
    return { ok: false, url: connectionString, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function testDragonfly(url: string) {
  const client = new Redis(url, {
    connectTimeout: 2000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.ping();
    return { ok: true, url };
  } catch (error) {
    return { ok: false, url, error: error instanceof Error ? error.message : String(error) };
  } finally {
    client.disconnect();
  }
}

const managementSetupHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>1Patch Management Setup</title>
  <style>
    :root{font-family:Inter,system-ui,sans-serif;color:#18202f;background:#f7f8fb}
    *{box-sizing:border-box}body{margin:0}.shell{max-width:1060px;margin:0 auto;padding:32px 24px 48px}
    header{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;margin-bottom:24px}
    h1{margin:0;font-size:32px;letter-spacing:0}p{line-height:1.55}.muted{color:#64748b}.status{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
    .pill{border:1px solid #cbd5e1;border-radius:999px;padding:6px 10px;background:#fff;font-size:13px}.pill.ok{border-color:#8bd3a5;color:#166534;background:#f0fdf4}.pill.warn{border-color:#f0c36d;color:#92400e;background:#fffbeb}
    .layout{display:grid;grid-template-columns:260px 1fr;gap:18px}.steps{background:#fff;border:1px solid #dfe4ec;border-radius:8px;padding:12px;align-self:start}
    .step-tab{width:100%;display:flex;align-items:center;gap:10px;text-align:left;border:0;background:transparent;color:#334155;padding:12px;border-radius:6px;cursor:pointer;font-weight:800}
    .step-tab.active{background:#eef5ff;color:#1463ff}.step-tab.done:before{content:'OK';font-size:11px;color:#15803d}.step-tab:before{content:'--';font-size:11px;color:#94a3b8}
    section{display:none;background:#fff;border:1px solid #dfe4ec;border-radius:8px;padding:22px}section.active{display:block}
    h2{margin:0 0 8px;font-size:22px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}label{display:block;font-weight:800;margin:14px 0 6px}
    input{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:11px 12px;background:white;font:inherit}input:focus{outline:2px solid #9cc2ff;border-color:#1463ff}
    .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}button{border:0;border-radius:8px;padding:11px 14px;background:#1463ff;color:white;font-weight:900;cursor:pointer}
    button.secondary{background:#e2e8f0;color:#1f2937}button.ghost{background:#fff;color:#1463ff;border:1px solid #b7cdfa}
    pre{white-space:pre-wrap;word-break:break-word;background:#111827;color:#e5e7eb;padding:16px;border-radius:8px;min-height:96px;margin-top:16px}
    .notice{border:1px solid #bae6fd;background:#f0f9ff;color:#075985;border-radius:8px;padding:12px;margin-top:14px}
    .error{border-color:#fecaca;background:#fef2f2;color:#991b1b}.success{border-color:#bbf7d0;background:#f0fdf4;color:#166534}
    @media(max-width:820px){header{display:block}.status{justify-content:flex-start;margin-top:14px}.layout{grid-template-columns:1fr}.grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <h1>1Patch Management Setup</h1>
        <p class="muted">Configure storage, create the first owner, and prepare a backend node enrollment.</p>
      </div>
      <div id="status" class="status"></div>
    </header>
    <div class="layout">
      <nav class="steps">
        <button class="step-tab active" data-step="storage">Storage</button>
        <button class="step-tab" data-step="owner">Owner</button>
        <button class="step-tab" data-step="node">Backend Node</button>
        <button class="step-tab" data-step="finish">Finish</button>
      </nav>
      <div>
        <section id="storage" class="active">
          <h2>Storage</h2>
          <p class="muted">Generate the production environment and run migrations after PostgreSQL and DragonflyDB are reachable.</p>
          <div class="grid">
            <div><label>PostgreSQL server URL</label><input id="postgresServerUrl" value="postgres://1patch:1patch@localhost:5432"></div>
            <div><label>Database name</label><input id="databaseName" value="1patch_management"></div>
            <div><label>DragonflyDB URL</label><input id="dragonflyUrl" value="redis://localhost:6379"></div>
            <div><label>Owner email for generated .env</label><input id="configOwnerEmail" type="email" placeholder="owner@example.com"></div>
            <div><label>Owner password for generated .env</label><input id="configOwnerPassword" type="password" minlength="12"></div>
          </div>
          <div class="actions"><button onclick="testConfig()">Test Config</button><button class="secondary" onclick="generateConfig()">Generate Config</button><button class="secondary" onclick="migrate()">Run Migration</button><button class="ghost" onclick="go('owner')">Next</button></div>
          <pre id="configOut">Generated setup config will appear here.</pre>
        </section>
        <section id="owner">
          <h2>First Owner</h2>
          <p class="muted">Create the local owner account. Passwords must be at least 12 characters and include upper, lower, and number characters.</p>
          <div class="grid">
            <div><label>Email</label><input id="ownerEmail" type="email" placeholder="owner@example.com"></div>
            <div><label>Password</label><input id="ownerPassword" type="password" minlength="12"></div>
          </div>
          <div class="actions"><button onclick="createOwner()">Create Owner</button><button class="ghost" onclick="go('node')">Next</button></div>
          <div id="ownerOut" class="notice">Owner creation status will appear here.</div>
        </section>
        <section id="node">
          <h2>Backend Node Enrollment</h2>
          <p class="muted">Create an enrollment token, then open the backend node setup wizard and paste the returned values.</p>
          <div class="grid">
            <div><label>Node name</label><input id="nodeName" value="node-1"></div>
            <div><label>Node public URL</label><input id="nodePublicUrl" value="https://node-1.1patch.local"></div>
            <div><label>Region</label><input id="nodeRegion" value="local"></div>
            <div><label>Site</label><input id="nodeSite" value="default"></div>
          </div>
          <div class="actions"><button onclick="createEnrollment()">Create Enrollment</button><button class="ghost" onclick="go('finish')">Next</button></div>
          <pre id="nodeOut">Node enrollment values will appear here.</pre>
        </section>
        <section id="finish">
          <h2>Finish</h2>
          <p class="muted">Use the dashboard once storage and owner setup are complete. Backend nodes come online after their own wizard writes the env file and registers the service.</p>
          <div class="actions"><button onclick="location.href='/ui'">Open Dashboard</button><button class="secondary" onclick="refreshStatus()">Refresh Status</button></div>
          <div id="finishOut" class="notice">Setup status will appear here.</div>
        </section>
      </div>
    </div>
  </main>
  <script>
    const ids = ['storage','owner','node','finish'];
    let statusSnapshot = {};
    function go(id){
      ids.forEach((step) => {
        document.getElementById(step).classList.toggle('active', step === id);
        document.querySelector('[data-step="'+step+'"]').classList.toggle('active', step === id);
      });
    }
    function formValue(id){ return document.getElementById(id).value.trim(); }
    async function jsonFetch(url, options){
      const res = await fetch(url, options);
      const text = await res.text();
      const body = text ? JSON.parse(text) : {};
      if(!res.ok) throw new Error(body.message || body.error || res.statusText);
      return body;
    }
    function renderJson(id, value){ document.getElementById(id).textContent = JSON.stringify(value, null, 2); }
    function setNotice(id, text, kind){
      const el = document.getElementById(id);
      el.textContent = text;
      el.className = 'notice ' + (kind || '');
    }
    async function refreshStatus(){
      statusSnapshot = await jsonFetch('/setup/status');
      const pills = [
        ['Database', statusSnapshot.databaseAvailable],
        ['Dragonfly', statusSnapshot.dragonflyAvailable],
        ['Owner', statusSnapshot.ownerCreated],
        ['Nodes ' + statusSnapshot.onlineNodeCount + '/' + statusSnapshot.nodeCount, statusSnapshot.onlineNodeCount > 0]
      ];
      document.getElementById('status').innerHTML = pills.map(([label, ok]) => '<span class="pill '+(ok?'ok':'warn')+'">'+label+'</span>').join('');
      document.querySelector('[data-step="storage"]').classList.toggle('done', statusSnapshot.databaseAvailable && statusSnapshot.dragonflyAvailable);
      document.querySelector('[data-step="owner"]').classList.toggle('done', statusSnapshot.ownerCreated);
      document.querySelector('[data-step="node"]').classList.toggle('done', statusSnapshot.nodeCount > 0);
      setNotice('finishOut', (statusSnapshot.databaseError ? 'Database: ' + statusSnapshot.databaseError + '. ' : '') + (statusSnapshot.dragonflyError ? 'Dragonfly: ' + statusSnapshot.dragonflyError + '. ' : '') + 'Owner: ' + (statusSnapshot.ownerCreated ? 'created' : 'missing') + '. Backend nodes: ' + statusSnapshot.onlineNodeCount + ' online, ' + statusSnapshot.pendingNodeCount + ' pending.', statusSnapshot.ownerCreated ? 'success' : '');
    }
    async function generateConfig(){
      try{
        const data = await jsonFetch('/setup/configuration',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
          postgresServerUrl: formValue('postgresServerUrl'),
          databaseName: formValue('databaseName'),
          dragonflyUrl: formValue('dragonflyUrl'),
          ownerEmail: formValue('configOwnerEmail'),
          ownerPassword: document.getElementById('configOwnerPassword').value
        })});
        renderJson('configOut', data);
      }catch(error){ document.getElementById('configOut').textContent = String(error.message || error); }
    }
    async function testConfig(){
      try{
        document.getElementById('configOut').textContent = 'Testing storage configuration...';
        const data = await jsonFetch('/setup/test-configuration',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
          postgresServerUrl: formValue('postgresServerUrl'),
          databaseName: formValue('databaseName'),
          dragonflyUrl: formValue('dragonflyUrl')
        })});
        renderJson('configOut', data);
      }catch(error){ document.getElementById('configOut').textContent = String(error.message || error); }
    }
    async function migrate(){
      try{
        const data = await jsonFetch('/setup/migrate',{method:'POST'});
        renderJson('configOut', data);
        await refreshStatus();
      }catch(error){ document.getElementById('configOut').textContent = String(error.message || error); }
    }
    async function createOwner(){
      try{
        const data = await jsonFetch('/setup/owner',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
          email: formValue('ownerEmail'),
          password: document.getElementById('ownerPassword').value
        })});
        setNotice('ownerOut', 'Owner created for ' + data.email + '.', 'success');
        await refreshStatus();
      }catch(error){ setNotice('ownerOut', String(error.message || error), 'error'); }
    }
    async function createEnrollment(){
      try{
        const headers = {'content-type':'application/json'};
        const data = await jsonFetch('/setup/node-enrollment',{method:'POST',headers,body:JSON.stringify({
          name: formValue('nodeName'),
          publicUrl: formValue('nodePublicUrl'),
          region: formValue('nodeRegion') || undefined,
          site: formValue('nodeSite') || undefined
        })});
        renderJson('nodeOut', {
          managementUrl: statusSnapshot.publicUrl,
          nodePublicUrl: formValue('nodePublicUrl'),
          nodeId: data.nodeId,
          nodeEnrollmentToken: data.enrollmentToken
        });
        await refreshStatus();
      }catch(error){ document.getElementById('nodeOut').textContent = String(error.message || error); }
    }
    refreshStatus();
  </script>
</body>
</html>`;
