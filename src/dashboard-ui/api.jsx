// AGPL-3.0-only — 1Patch management UI API client
const SESSION_KEY = '1patch-session';
const DEMO_MODE = /^\/ui\/demo(?:\/|$)/.test(window.location.pathname) || new URLSearchParams(window.location.search).has('demo');

/**
 * Handles the session operation.
 * @returns The result produced by the operation.
 */
function session() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || '{}'); }
  catch { return {}; }
}

/**
 * Handles the store session operation.
 *
 * @param sessionBody session body supplied to the function.
 * @returns The result produced by the operation.
 */
function storeSession(sessionBody) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    accessToken: sessionBody.accessToken,
    user: sessionBody.user,
    authMethod: sessionBody.authMethod ?? 'password',
  }));
  window.dispatchEvent(new CustomEvent('patch-session-change', { detail: sessionBody }));
  return sessionBody;
}

/**
 * Handles the clear session operation.
 */
function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  window.dispatchEvent(new CustomEvent('patch-session-change', { detail: null }));
}

/**
 * Handles the login with credentials operation.
 *
 * @param email email supplied to the function.
 * @param password password supplied to the function.
 * @returns The result produced by the operation.
 */
async function loginWithCredentials(email, password) {
  const r = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || 'Login failed');
  if (body.mfaRequired) return body;
  return storeSession(body);
}

/**
 * Validates mfa with code rules.
 *
 * @param challengeToken Token used to authenticate or authorize the operation.
 * @param code code supplied to the function.
 * @returns The result produced by the operation.
 */
async function verifyMfaWithCode(challengeToken, code) {
  const r = await fetch('/auth/mfa/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeToken, code }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || 'MFA verification failed');
  return storeSession(body);
}

/**
 * Handles the token operation.
 * @returns The result produced by the operation.
 */
async function token() {
  const existing = session().accessToken;
  if (existing) return existing;
  const err = new Error('Authentication required');
  err.code = 'AUTH_REQUIRED';
  throw err;
}

/**
 * Handles the api operation.
 *
 * @param path Filesystem or URL path used by the operation.
 * @param init init supplied to the function.
 * @returns The result produced by the operation.
 */
async function api(path, init) {
  const headers = { 'content-type': 'application/json' };
  const t = await token(); if (t) headers.authorization = `Bearer ${t}`;
  const r = await fetch(path, { ...init, headers: { ...headers, ...(init && init.headers) } });
  if (r.status === 401) {
    clearSession();
    const err = new Error('Session expired');
    err.code = 'AUTH_REQUIRED';
    throw err;
  }
  const ct = r.headers.get('content-type') || '';
  if (!r.ok) {
    const body = ct.includes('application/json') ? await r.json().catch(() => ({})) : await r.text().catch(() => '');
    throw new Error(body?.message || body?.error || body || `${r.status} ${r.statusText} — ${path}`);
  }
  return ct.includes('application/json') ? r.json() : r.text();
}
// SSO helpers
async function ssoProvidersPublic() {
  const r = await fetch('/sso/providers');
  const body = await r.json().catch(() => []);
  if (!r.ok) return [];
  return body;
}

async function ssoInitiate(providerId) {
  const r = await fetch(`/auth/sso/${encodeURIComponent(providerId)}/initiate`);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || 'SSO initiation failed');
  return body; // { authorizationUrl }
}

async function ssoComplete(handoffToken) {
  const r = await fetch('/auth/sso/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handoffToken }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || 'SSO completion failed');
  return storeSession(body);
}

function demoIso(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function makeDemoData() {
  const sites = ['Berlin HQ', 'Munich DC', 'Frankfurt Edge', 'Hamburg Office', 'Remote EMEA', 'US East'];
  const groups = ['Finance', 'Engineering', 'Operations', 'Executive', 'Retail', 'Build Farm'];
  const nodeIds = ['node-eu-central-1', 'node-eu-west-1', 'node-us-east-1', 'node-lab-1'];
  const appDefs = [
    ['Google Chrome', 'Google', '125.0.6422.142', '124.0.6367.207', true],
    ['Microsoft Edge', 'Microsoft', '125.0.2535.92', '124.0.2478.109', false],
    ['Mozilla Firefox ESR', 'Mozilla', '115.12.0', '115.9.1', true],
    ['7-Zip', 'Igor Pavlov', '24.06', '23.01', false],
    ['Notepad++', 'Notepad++ Team', '8.6.8', '8.5.7', false],
    ['Git', 'Git SCM', '2.45.2', '2.43.0', false],
    ['OpenJDK Runtime', 'Eclipse Adoptium', '21.0.3', '17.0.10', true],
    ['Microsoft Teams', 'Microsoft', '24124.2312.2911', '24060.2623.2790', false],
    ['Zoom Workplace', 'Zoom', '6.0.11', '5.17.11', true],
    ['Docker Desktop', 'Docker', '4.31.0', '4.27.1', false],
    ['Visual Studio Code', 'Microsoft', '1.90.0', '1.88.1', false],
    ['LibreOffice', 'The Document Foundation', '24.2.4', '7.6.7', false],
  ];
  const devices = Array.from({ length: 96 }, (_, i) => {
    const n = i + 1;
    const linux = i % 5 === 0 || i % 13 === 0;
    const online = i % 9 !== 0;
    return {
      id: `dev-${String(n).padStart(4, '0')}`,
      hostname: `${linux ? 'lin' : 'win'}-${sites[i % sites.length].toLowerCase().replace(/[^a-z]+/g, '-')}-${String(n).padStart(3, '0')}`,
      os: linux ? (i % 2 ? 'Ubuntu 22.04.4 LTS' : 'Debian GNU/Linux 12') : (i % 3 ? 'Microsoft Windows 10.0.22631' : 'Microsoft Windows 10.0.26100'),
      platform: linux ? 'linux' : 'windows',
      site: sites[i % sites.length],
      group: groups[i % groups.length],
      tags: [i % 4 === 0 ? 'production' : 'standard', i % 7 === 0 ? 'browser-critical' : 'auto-update'],
      preferredNodeId: nodeIds[i % nodeIds.length],
      installedAppCount: 18 + (i % 31),
      pendingTaskCount: i % 8 === 0 ? 3 : i % 6 === 0 ? 1 : 0,
      lastSeenAt: demoIso(online ? (2 + (i % 30)) : (220 + i * 7)),
      online,
      deviceTrustScore: 96 - (i % 19),
      riskScore: i % 11 === 0 ? 74 : 18 + (i % 32),
    };
  });
  const apps = appDefs.map(([name, publisher, latestVersion, oldestVersion, critical], i) => {
    const deviceCount = 44 + ((i * 17) % 52);
    const outdatedDeviceCount = i % 4 === 0 ? 28 - i : 6 + ((i * 5) % 19);
    return { name, publisher, latestVersion, latest: latestVersion, oldestVersion, oldest: oldestVersion, deviceCount, outdatedDeviceCount, outdated: outdatedDeviceCount, critical };
  });
  const tasks = Array.from({ length: 72 }, (_, i) => {
    const app = apps[i % apps.length];
    const status = ['completed', 'completed', 'completed', 'dispatched', 'pending', 'failed', 'rejected', 'cancelled'][i % 8];
    return {
      id: `task-${String(i + 1).padStart(5, '0')}`,
      type: i % 10 === 0 ? 'refresh_inventory' : 'update_app',
      appName: app.name,
      deviceId: devices[i % devices.length].id,
      nodeId: nodeIds[i % nodeIds.length],
      status,
      fromVersion: app.oldestVersion,
      targetVersion: app.latestVersion,
      createdAt: demoIso(8 + i * 11),
      completedAt: ['completed', 'failed', 'rejected', 'cancelled'].includes(status) ? demoIso(2 + i * 10) : null,
      output: status === 'failed' ? 'Installer exited with code 1603 after signature verification succeeded.' : status === 'completed' ? 'Package installed and inventory refreshed.' : '',
    };
  });
  const alarms = [
    ['critical', 'Chrome CVE exposure remains on 28 production endpoints', devices[3].id, 12],
    ['critical', 'Backend node node-lab-1 entered quarantine after trust drop', null, 35],
    ['warning', 'High package queue lag in Frankfurt Edge', devices[14].id, 48],
    ['warning', 'Linux repo metadata stale on Munich DC cache', devices[20].id, 76],
    ['info', 'New unmanaged device discovered from enrollment token', devices[55].id, 130],
    ['warning', 'Repeated install failures for OpenJDK Runtime', devices[42].id, 155],
    ['critical', 'Unsigned package upload rejected by policy', null, 190],
    ['warning', 'Offline executive laptop missed maintenance window', devices[8].id, 260],
  ].map(([severity, message, deviceId, age], i) => ({ id: `alarm-${i + 1}`, severity, message, deviceId, createdAt: demoIso(age) }));
  const packages = appDefs.flatMap(([name, publisher, latestVersion], i) => ([
    {
      id: `pkg-win-${i + 1}`,
      name,
      publisher,
      version: latestVersion,
      type: i % 3 === 0 ? 'msi' : 'winget',
      platform: 'windows',
      architecture: 'x64',
      signatureStatus: i % 5 === 0 ? 'unknown' : 'valid',
      catalogSource: i % 4 === 0 ? 'custom' : 'central',
      catalogCategory: i % 2 ? 'Productivity' : 'Security',
      sha256: `demo-sha256-${i + 1}`,
      createdAt: demoIso(400 + i * 55),
    },
    i % 3 === 0 ? {
      id: `pkg-linux-${i + 1}`,
      name,
      publisher,
      version: latestVersion,
      type: 'apt',
      platform: 'linux',
      architecture: 'amd64',
      signatureStatus: 'valid',
      catalogSource: 'central',
      catalogCategory: 'Linux',
      sha256: `demo-linux-sha256-${i + 1}`,
      createdAt: demoIso(480 + i * 65),
    } : null,
  ])).filter(Boolean);
  const nodes = nodeIds.map((id, i) => ({
    id,
    name: id.replace(/-/g, ' '),
    publicUrl: `https://${id}.demo.1patch.local`,
    region: ['eu-central', 'eu-west', 'us-east', 'lab'][i],
    site: sites[i],
    status: i === 3 ? 'online' : 'online',
    version: `0.1.${12 - i}`,
    capabilities: ['inventory', 'package-cache', 'signed-execution', i % 2 ? 'linux' : 'windows'],
    healthState: i === 3 ? 'degraded' : 'healthy',
    maintenanceState: i === 2 ? 'draining' : 'active',
    quarantineState: i === 3 ? 'quarantined' : 'clear',
    quarantineReason: i === 3 ? 'trust score below tenant threshold' : '',
    lastSeenAt: demoIso(3 + i * 8),
    health: {
      memoryPressurePercent: [44, 62, 78, 91][i],
      diskFreeBytes: [420e9, 220e9, 84e9, 900e6][i],
      clockSkewMs: i === 3 ? 9200 : 600,
      queueLag: ['low', 'low', 'medium', 'high'][i],
      components: [
        { name: 'agent', status: i === 3 ? 'degraded' : 'healthy' },
        { name: 'cache', status: i === 2 ? 'degraded' : 'healthy' },
        { name: 'verifier', status: i === 3 ? 'unhealthy' : 'healthy' },
      ],
    },
    trust: {
      id: `trust-${id}`,
      trustScore: [96, 89, 74, 42][i],
      previousTrustScore: [95, 91, 80, 68][i],
      scoreDelta: [1, -2, -6, -26][i],
      healthState: i === 3 ? 'degraded' : 'healthy',
      certValid: i !== 3,
      latencyMs: [38, 64, 142, 680][i],
      queueLag: ['low', 'low', 'medium', 'high'][i],
      reasons: i === 3 ? ['package verifier unhealthy', 'high queue lag', 'clock skew detected'] : ['signed health report accepted'],
      securityFindings: i === 3 ? [{ severity: 'high', category: 'health', message: 'Package verifier component unhealthy' }] : [],
    },
  }));
  const audit = Array.from({ length: 48 }, (_, i) => ({
    id: `audit-${i + 1}`,
    createdAt: demoIso(5 + i * 17),
    actor: ['admin@1patch.demo', 'sre@1patch.demo', 'node-eu-central-1', 'policy-engine'][i % 4],
    action: ['task.queued', 'package.signed', 'rule.evaluated', 'device.enrolled', 'alarm.created', 'auth.mfa.verified'][i % 6],
    target: [devices[i % devices.length].id, apps[i % apps.length].name, nodeIds[i % nodeIds.length]][i % 3],
  }));
  const rules = [
    ['Critical browser CVE rollout', true, 'inventory_changed'],
    ['Quarantine low-trust node', true, 'node_trust_changed'],
    ['Refresh stale Linux inventory', true, 'schedule'],
    ['Notify SIEM on failed update burst', true, 'task_failed'],
    ['Executive laptop maintenance window', false, 'schedule'],
  ].map(([name, enabled, eventType], i) => ({
    id: `rule-${i + 1}`,
    name,
    enabled,
    description: `Demo automation rule ${i + 1}`,
    trigger: { type: 'event', eventType },
    conditionGroup: { combinator: 'AND', conditions: [{ field: 'severity', operator: 'gte', value: i === 0 ? 'critical' : 'warning' }] },
    actions: [{ type: i % 2 ? 'notify' : 'create_task', target: i % 2 ? 'siem' : 'outdated_devices' }],
  }));
  const compliantApps = apps.reduce((sum, app) => sum + app.deviceCount - app.outdatedDeviceCount, 0);
  const outdatedApps = apps.reduce((sum, app) => sum + app.outdatedDeviceCount, 0);
  return { devices, apps, tasks, alarms, packages, nodes, audit, rules, summary: {
    managedDevices: devices.length,
    onlineDevices: devices.filter(d => d.online).length,
    coverage: 87,
    compliantApps,
    outdatedApps,
    criticalAlarms: alarms.filter(a => a.severity === 'critical').length,
    activeRules: rules.filter(r => r.enabled).length,
  }};
}

const DEMO_DATA = DEMO_MODE ? makeDemoData() : null;
const demoResolve = (value) => Promise.resolve(JSON.parse(JSON.stringify(value)));
const demoSession = {
  accessToken: 'demo-token',
  user: {
    email: 'admin@1patch.demo',
    permissions: ['auth:manage', 'users:manage', 'roles:manage', 'tasks:manage', 'packages:manage'],
  },
  authMethod: 'demo',
};
const DEMO_API = DEMO_MODE ? {
  session: () => demoSession,
  login: () => demoResolve(demoSession),
  verifyMfa: () => demoResolve(demoSession),
  ssoProviders: () => demoResolve([]),
  ssoInitiate: () => demoResolve({ authorizationUrl: '/ui/demo' }),
  ssoComplete: () => demoResolve(demoSession),
  logout: () => {},
  summary: () => demoResolve(DEMO_DATA.summary),
  coverageHistory: (days = 30) => demoResolve(Array.from({ length: days }, (_, i) => ({ date: demoIso((days - i) * 1440), value: 74 + Math.round(i * 0.46) + (i % 5 === 0 ? -2 : i % 7 === 0 ? 1 : 0) }))),
  devices: () => demoResolve(DEMO_DATA.devices),
  device: (id) => {
    const device = DEMO_DATA.devices.find(d => d.id === id) || DEMO_DATA.devices[0];
    const installedApps = DEMO_DATA.apps.slice(0, 10).map((app, i) => ({ ...app, version: i % 3 === 0 ? app.oldestVersion : app.latestVersion, latestVersion: app.latestVersion, packageId: `pkg-win-${i + 1}` }));
    const tasks = DEMO_DATA.tasks.filter(t => t.deviceId === device.id).slice(0, 8);
    return demoResolve({ device, installedApps, tasks });
  },
  deviceGroups: () => demoResolve([]),
  createDevice: (body) => demoResolve({ id: 'demo-created-device', ...body }),
  createDeviceEnrollment: (body) => demoResolve({ id: 'demo-enrollment', count: body?.maxUses || 1, oneLineJson: JSON.stringify({ Demo: true, TenantId: body?.tenantId || 'default' }), config: { Demo: true, TenantId: body?.tenantId || 'default' } }),
  apps: () => demoResolve(DEMO_DATA.apps),
  packages: () => demoResolve(DEMO_DATA.packages),
  packageCatalog: () => demoResolve(DEMO_DATA.packages.slice(0, 12)),
  createPackage: (body) => demoResolve({ id: 'demo-created-package', createdAt: new Date().toISOString(), signatureStatus: 'valid', ...body }),
  deployPackageAll: (id) => demoResolve({ tasks: DEMO_DATA.tasks.slice(0, 7).map(t => ({ ...t, packageArtifactId: id, status: 'pending' })) }),
  rules: () => demoResolve(DEMO_DATA.rules),
  createRule: (body) => demoResolve({ id: 'demo-created-rule', ...body }),
  updateRule: (id, body) => demoResolve({ id, ...body }),
  toggleRule: (id, enabled) => demoResolve({ id, enabled }),
  testRule: () => demoResolve({ matched: 18, actions: ['create_task', 'notify'] }),
  triggerRule: () => demoResolve([{ id: 'demo-triggered-task', status: 'pending' }]),
  ruleTemplates: () => demoResolve([]),
  createRuleDraftFromTemplate: (_id, body) => demoResolve({ name: 'Demo rule draft', ...body }),
  importRuleTemplateConfig: (body) => demoResolve({ name: 'Imported demo rule', ...body }),
  ruleAudit: () => demoResolve(DEMO_DATA.audit.slice(0, 10)),
  tasks: () => demoResolve(DEMO_DATA.tasks),
  cancelTask: (id) => demoResolve({ id, status: 'cancelled' }),
  scanTask: (id) => demoResolve({ id, status: 'security_scanned' }),
  approveTask: (id) => demoResolve({ id, status: 'mfa_approved' }),
  signTask: (id) => demoResolve({ id, status: 'signed' }),
  issueMfaChallenge: () => demoResolve({ challengeId: 'demo-challenge-id' }),
  verifyMfaChallenge: () => demoResolve({ verified: true }),
  nodes: () => demoResolve(DEMO_DATA.nodes),
  nodeTrustCenter: () => demoResolve(DEMO_DATA.nodes),
  nodeTrustDetail: (id) => demoResolve(DEMO_DATA.nodes.find(n => n.id === id) || DEMO_DATA.nodes[0]),
  clearNodeQuarantine: (id) => demoResolve({ id, quarantineState: 'clear' }),
  createNodeEnrollment: (body) => demoResolve({ id: 'demo-node-enrollment', token: 'demo-node-token', ...body }),
  deleteNode: (id) => demoResolve({ id, deleted: true }),
  alarms: () => demoResolve(DEMO_DATA.alarms),
  resolveAlarm: (id) => demoResolve({ id, resolved: true }),
  resolveAllAlarms: () => demoResolve({ resolved: DEMO_DATA.alarms.length }),
  audit: (limit = 100) => demoResolve(DEMO_DATA.audit.slice(0, limit)),
  siemConfig: (tenantId = 'default') => demoResolve({ tenantId, config: { enabled: true, webhook: { enabled: true, url: 'https://siem.demo/ingest' }, syslog: { enabled: true, host: 'syslog.demo', port: 514 }, sentinel: { enabled: false } } }),
  saveSiemConfig: (_tenantId, body) => demoResolve({ saved: true, config: body }),
  testSiem: () => demoResolve({ ok: true, message: 'Demo SIEM event accepted' }),
  verifySiem: () => demoResolve({ ok: true, findings: [] }),
  siemQueueStatus: () => demoResolve({ pending: 42, failed: 1, deliveredLastHour: 1284 }),
  securityPosture: () => demoResolve({ score: 91, findings: [], checks: [] }),
  fixSecurityPosture: () => demoResolve({ fixed: 0 }),
  tenantPolicy: () => demoResolve({ requireApproval: true, maxConcurrentTasks: 250, allowedPackageSources: ['central', 'custom'] }),
  saveTenantPolicy: (_tenantId, body) => demoResolve(body),
  adminUsers: () => demoResolve([{ id: 'usr-1', email: 'admin@1patch.demo', roleId: 'role-admin', mfaEnabled: true, disabled: false }, { id: 'usr-2', email: 'sre@1patch.demo', roleId: 'role-operator', mfaEnabled: true, disabled: false }]),
  adminRbac: () => demoResolve({ roles: [{ id: 'role-admin', name: 'Administrator', permissions: demoSession.user.permissions }, { id: 'role-operator', name: 'Operator', permissions: ['tasks:manage', 'packages:read'] }], permissions: demoSession.user.permissions }),
  adminCreateUser: (body) => demoResolve({ id: 'demo-user', ...body }),
  adminUpdateUser: (id, body) => demoResolve({ id, ...body }),
  adminDeleteUser: (id) => demoResolve({ id, deleted: true }),
  adminCreateRole: (body) => demoResolve({ id: 'demo-role', ...body }),
  adminUpdateRole: (id, body) => demoResolve({ id, ...body }),
  adminDeleteRole: (id) => demoResolve({ id, deleted: true }),
  ssoProvidersAdmin: () => demoResolve([]),
  ssoCreateProvider: (body) => demoResolve({ id: 'demo-sso', ...body }),
  ssoUpdateProvider: (id, body) => demoResolve({ id, ...body }),
  ssoDeleteProvider: (id) => demoResolve({ id, deleted: true }),
  retirementPolicies: () => demoResolve([{ id: 'retire-1', name: 'Retire inactive endpoints', description: 'Flag devices inactive for 90 days.', enabled: true, priority: 20, conditionCombinator: 'AND', conditions: [{ type: 'inactive_days', days: 90 }], actions: [{ type: 'tag_device', tag: 'retired' }], lastEvaluatedAt: demoIso(300), matchCount: 7 }]),
  createRetirementPolicy: (body) => demoResolve({ id: 'demo-retirement', ...body }),
  updateRetirementPolicy: (id, body) => demoResolve({ id, ...body }),
  deleteRetirementPolicy: (id) => demoResolve({ id, deleted: true }),
  evaluateRetirementPolicy: () => demoResolve({ matchCount: 7, totalDevices: DEMO_DATA.devices.length, matchedDevices: DEMO_DATA.devices.slice(0, 7) }),
  refreshInventory: (id) => demoResolve({ id, queued: true }),
  updateAllOutdated: (id) => demoResolve({ tasks: DEMO_DATA.tasks.slice(0, 5).map(t => ({ ...t, deviceId: id, status: 'pending' })) }),
  updateAllForApp: (name) => demoResolve(DEMO_DATA.tasks.slice(0, 12).map(t => ({ ...t, appName: name, status: 'pending' }))),
  updateDeviceForApp: (name, body) => demoResolve({ id: 'demo-device-task', appName: name, ...body, status: 'pending' }),
} : null;

const LIVE_API = {
  session,
  /**
   * Handles the login operation.
   *
   * @param email email supplied to the function.
   * @param password password supplied to the function.
   */
  login:             (email, password) => loginWithCredentials(email, password),
  /**
   * Validates mfa rules.
   *
   * @param challengeToken Token used to authenticate or authorize the operation.
   * @param code code supplied to the function.
   */
  verifyMfa:         (challengeToken, code) => verifyMfaWithCode(challengeToken, code),
  ssoProviders:      () => ssoProvidersPublic(),
  ssoInitiate:       (id) => ssoInitiate(id),
  ssoComplete:       (token) => ssoComplete(token),
  ssoProvidersAdmin: () => api('/sso/providers/all'),
  ssoCreateProvider: (b) => api('/sso/providers', { method: 'POST', body: JSON.stringify(b) }),
  ssoUpdateProvider: (id, b) => api(`/sso/providers/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(b) }),
  ssoDeleteProvider: (id) => api(`/sso/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /**
   * Handles the logout operation — revokes the token server-side, then clears local session.
   */
  logout:            () => {
    const tok = session().accessToken;
    if (tok) {
      // Best-effort server-side revocation — always clear locally regardless of outcome
      fetch('/auth/logout', {
        method: 'POST',
        headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      }).catch(() => {});
    }
    clearSession();
  },
  /**
   * Handles the summary operation.
   */
  summary:           ()      => api('/dashboard/summary'),
  /**
   * Handles the coverage history operation.
   *
   * @param d d supplied to the function.
   */
  coverageHistory:   (d=30)  => api(`/dashboard/coverage-history?days=${d}`),
  /**
   * Handles the devices operation.
   *
   * @param q Search query or filter supplied by the caller.
   */
  devices:           (q)     => api('/devices' + (q ? `?q=${encodeURIComponent(q)}` : '')),
  /**
   * Handles the device operation.
   *
   * @param id Identifier used to locate the target record.
   */
  device:            (id)    => api(`/devices/${id}`),
  /**
   * Handles the device groups operation.
   *
   * @param t t supplied to the function.
   */
  deviceGroups:      (t='default') => api(`/devices/groups?tenantId=${encodeURIComponent(t)}`),
  /**
   * Creates a device record.
   *
   * @param b b supplied to the function.
   */
  createDevice:      (b)     => api('/devices',                                  { method:'POST', body: JSON.stringify(b) }),
  /**
   * Updates the device record or state.
   *
   * @param id Identifier used to locate the target record.
   * @param b b supplied to the function.
   */
  updateDevice:      (id,b)  => api(`/devices/${id}`,                            { method:'PATCH', body: JSON.stringify(b) }),
  /**
   * Creates a device enrollment record.
   *
   * @param b b supplied to the function.
   */
  createDeviceEnrollment: (b) => api('/devices/enrollments',                    { method:'POST', body: JSON.stringify(b) }),
  /**
   * Handles the apps operation.
   *
   * @param q Search query or filter supplied by the caller.
   */
  apps:              (q)     => api('/apps' + (q ? `?q=${encodeURIComponent(q)}` : '')),
  /**
   * Handles the packages operation.
   */
  packages:          ()      => api('/packages'),
  /**
   * Handles the rules operation.
   */
  rules:             ()      => api('/rules'),
  /**
   * Handles the tasks operation.
   */
  tasks:             ()      => api('/tasks'),
  tenantPolicy:      (t='default') => api(`/tasks/policy/${encodeURIComponent(t)}`),
  saveTenantPolicy:  (t='default', b) => api(`/tasks/policy/${encodeURIComponent(t)}`, { method:'PUT', body: JSON.stringify(b) }),
  /**
   * Handles the cancel task operation.
   *
   * @param id Identifier used to locate the target record.
   */
  cancelTask:        (id)    => api(`/tasks/${id}`,                                 { method:'DELETE' }),
  scanTask:          (id)    => api(`/tasks/${id}/scan`,                            { method:'POST', body:'{}' }),
  approveTask:       (id, mfaChallengeId) => api(`/tasks/${id}/approve`,            { method:'POST', body: JSON.stringify({ mfaChallengeId: mfaChallengeId || '' }) }),
  signTask:          (id)    => api(`/tasks/${id}/sign`,                            { method:'POST', body:'{}' }),
  issueMfaChallenge: ()      => api('/tasks/mfa-challenge/issue',                   { method:'POST', body:'{}' }),
  verifyMfaChallenge:(challengeId, totpCode) => api('/tasks/mfa-challenge/verify',  { method:'POST', body: JSON.stringify({ challengeId, totpCode }) }),
  /**
   * Handles the nodes operation.
   */
  nodes:             ()      => api('/nodes'),
  nodeTrustCenter:   ()      => api('/nodes/trust-center'),
  nodeTrustDetail:   (id)    => api(`/nodes/${encodeURIComponent(id)}/trust-center`),
  clearNodeQuarantine: (id)  => api(`/nodes/${encodeURIComponent(id)}/quarantine/clear`, { method:'POST', body: '{}' }),
  /**
   * Creates a node enrollment record.
   *
   * @param b b supplied to the function.
   */
  createNodeEnrollment: (b)  => api('/nodes/enrollments',                         { method:'POST', body: JSON.stringify(b) }),
  deleteNode:           (id) => api('/nodes/' + encodeURIComponent(id), { method:'DELETE' }),
  /**
   * Handles the alarms operation.
   */
  alarms:            ()      => api('/alarms'),
  /**
   * Handles the audit operation.
   *
   * @param l l supplied to the function.
   */
  audit:             (l=100) => api(`/audit?limit=${l}`),
  adminUsers:        ()      => api('/admin/users'),
  adminCreateUser:   (b)     => api('/admin/users', { method:'POST', body: JSON.stringify(b) }),
  adminUpdateUser:   (id,b)  => api(`/admin/users/${encodeURIComponent(id)}`, { method:'PATCH', body: JSON.stringify(b) }),
  adminDeleteUser:   (id)    => api(`/admin/users/${encodeURIComponent(id)}`, { method:'DELETE' }),
  adminRbac:         ()      => api('/admin/rbac'),
  adminCreateRole:   (b)     => api('/admin/roles', { method:'POST', body: JSON.stringify(b) }),
  adminUpdateRole:   (id,b)  => api(`/admin/roles/${encodeURIComponent(id)}`, { method:'PATCH', body: JSON.stringify(b) }),
  adminDeleteRole:   (id)    => api(`/admin/roles/${encodeURIComponent(id)}`, { method:'DELETE' }),
  /**
   * Handles the siem config operation.
   *
   * @param t t supplied to the function.
   */
  siemConfig:        (t='default') => api(`/siem/config/${encodeURIComponent(t)}`),
  /**
   * Saves siem config data.
   *
   * @param t t supplied to the function.
   * @param b b supplied to the function.
   */
  saveSiemConfig:    (t,b)   => api(`/siem/config/${encodeURIComponent(t)}`,         { method:'PUT', body: JSON.stringify(b) }),
  /**
   * Handles the test siem operation.
   *
   * @param t t supplied to the function.
   */
  testSiem:          (t='default') => api(`/siem/test/${encodeURIComponent(t)}`,      { method:'POST', body: '{}' }),
  /**
   * Validates siem rules.
   *
   * @param t t supplied to the function.
   */
  verifySiem:        (t='default') => api(`/siem/verify/${encodeURIComponent(t)}`,    { method:'POST', body: '{}' }),
  /**
   * Handles the siem queue status operation.
   */
  siemQueueStatus:   ()      => api('/siem/queue/status'),
  /**
   * Handles the security posture operation.
   *
   * @param t t supplied to the function.
   */
  securityPosture:   (t='default') => api(`/security/posture?tenantId=${encodeURIComponent(t)}`),
  /**
   * Handles the fix security posture operation.
   *
   * @param t t supplied to the function.
   * @param actions actions supplied to the function.
   */
  fixSecurityPosture:(t='default', actions) => api(`/security/posture/fix?tenantId=${encodeURIComponent(t)}`, { method:'POST', body: JSON.stringify(actions ? { actions } : {}) }),
  /**
   * Creates a package record.
   *
   * @param b b supplied to the function.
   */
  packageCatalog:    ()      => api('/packages/catalog'),
  createPackage:     (b)     => api('/packages',                                 { method:'POST', body: JSON.stringify(b) }),
  /**
   * Handles the deploy package all operation.
   *
   * @param id Identifier used to locate the target record.
   */
  deployPackageAll:  (id)    => api(`/packages/${id}/deploy-all`,                { method:'POST', body: '{}' }),
  /**
   * Updates the all for app record or state.
   *
   * @param n n supplied to the function.
   * @param b b supplied to the function.
   */
  updateAllForApp:   (n,b)   => api(`/apps/${encodeURIComponent(n)}/update-all`, { method:'POST', body: JSON.stringify(b||{targetVersion:'latest'}) }),
  /**
   * Updates the device for app record or state.
   *
   * @param n n supplied to the function.
   * @param b b supplied to the function.
   */
  updateDeviceForApp:(n,b)   => api(`/apps/${encodeURIComponent(n)}/update-device`, { method:'POST', body: JSON.stringify(b) }),
  /**
   * Handles the refresh inventory operation.
   *
   * @param id Identifier used to locate the target record.
   */
  refreshInventory:  (id)    => api(`/tasks/refresh-inventory/${id}`,            { method:'POST', body: '{}' }),
  /**
   * Updates the all outdated record or state.
   *
   * @param id Identifier used to locate the target record.
   */
  updateAllOutdated: (id)    => api(`/devices/${id}/update-all-outdated`,        { method:'POST', body: '{}' }),
  /**
   * Creates a rule record.
   *
   * @param b b supplied to the function.
   */
  createRule:        (b)     => api('/rules',                                    { method:'POST', body: JSON.stringify(b) }),
  /**
   * Updates the rule record or state.
   *
   * @param id Identifier used to locate the target record.
   * @param b b supplied to the function.
   */
  updateRule:        (id,b)  => api(`/rules/${id}`,                              { method:'PATCH', body: JSON.stringify(b) }),
  /**
   * Changes the rule state.
   *
   * @param id Identifier used to locate the target record.
   * @param e Event object emitted by the runtime or UI.
   */
  toggleRule:        (id,e)  => api(`/rules/${id}`,                              { method:'PATCH', body: JSON.stringify({ enabled: e }) }),
  /**
   * Handles the test rule operation.
   *
   * @param id Identifier used to locate the target record.
   * @param b b supplied to the function.
   */
  testRule:          (id,b)  => api(`/rules/${id}/test`,                         { method:'POST', body: JSON.stringify(b || {}) }),
  /**
   * Handles the trigger rule operation.
   *
   * @param id Identifier used to locate the target record.
   * @param b b supplied to the function.
   */
  triggerRule:       (id,b)  => api(`/rules/${id}/trigger`,                      { method:'POST', body: JSON.stringify(b || {}) }),
  /**
   * Handles the rule templates operation.
   *
   * @param t t supplied to the function.
   */
  ruleTemplates:     (t='default') => api(`/rule-templates?tenantId=${encodeURIComponent(t)}`),
  /**
   * Creates a rule draft from template record.
   *
   * @param id Identifier used to locate the target record.
   * @param b b supplied to the function.
   */
  createRuleDraftFromTemplate: (id,b) => api(`/rule-templates/${encodeURIComponent(id)}/create-draft`, { method:'POST', body: JSON.stringify(b || {}) }),
  /**
   * Handles the import rule template config operation.
   *
   * @param b b supplied to the function.
   */
  importRuleTemplateConfig: (b) => api('/rule-templates/custom/import', { method:'POST', body: JSON.stringify(b || {}) }),
  /**
   * Handles the rule audit operation.
   *
   * @param id Identifier used to locate the target record.
   */
  ruleAudit:         (id)    => api(id ? `/rules/${id}/audit` : '/rules/audit'),
  /**
   * Resolves alarm configuration.
   *
   * @param id Identifier used to locate the target record.
   */
  resolveAlarm:      (id)    => api(`/alarms/${id}/resolve`,                     { method:'POST', body: '{}' }),
  resolveAllAlarms:   ()      => api('/alarms/resolve-all',                        { method:'POST', body: '{}' }),
  retirementPolicies:       (t='default') => api(`/devices/retirement-policies?tenantId=${encodeURIComponent(t)}`),
  createRetirementPolicy:   (b)     => api('/devices/retirement-policies',         { method:'POST', body: JSON.stringify(b) }),
  updateRetirementPolicy:   (id, b) => api(`/devices/retirement-policies/${encodeURIComponent(id)}`, { method:'PATCH', body: JSON.stringify(b) }),
  deleteRetirementPolicy:   (id)    => api(`/devices/retirement-policies/${encodeURIComponent(id)}`, { method:'DELETE' }),
  evaluateRetirementPolicy: (id)    => api(`/devices/retirement-policies/${encodeURIComponent(id)}/evaluate`, { method:'POST', body: '{}' }),
};

window.PatchAPI = DEMO_MODE ? DEMO_API : LIVE_API;
