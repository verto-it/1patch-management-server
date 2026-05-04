// AGPL-3.0-only — 1Patch management UI API client
const SESSION_KEY = '1patch-session';

function session() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || '{}'); }
  catch { return {}; }
}

function storeSession(sessionBody) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ accessToken: sessionBody.accessToken, user: sessionBody.user }));
  window.dispatchEvent(new CustomEvent('patch-session-change', { detail: sessionBody }));
  return sessionBody;
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  window.dispatchEvent(new CustomEvent('patch-session-change', { detail: null }));
}

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

async function token() {
  const existing = session().accessToken;
  if (existing) return existing;
  const err = new Error('Authentication required');
  err.code = 'AUTH_REQUIRED';
  throw err;
}

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
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${path}`);
  const ct = r.headers.get('content-type') || '';
  return ct.includes('application/json') ? r.json() : r.text();
}
window.PatchAPI = {
  session,
  login:             (email, password) => loginWithCredentials(email, password),
  verifyMfa:         (challengeToken, code) => verifyMfaWithCode(challengeToken, code),
  logout:            () => clearSession(),
  summary:           ()      => api('/dashboard/summary'),
  coverageHistory:   (d=30)  => api(`/dashboard/coverage-history?days=${d}`),
  devices:           (q)     => api('/devices' + (q ? `?q=${encodeURIComponent(q)}` : '')),
  device:            (id)    => api(`/devices/${id}`),
  createDeviceEnrollment: (b) => api('/devices/enrollments',                    { method:'POST', body: JSON.stringify(b) }),
  apps:              (q)     => api('/apps' + (q ? `?q=${encodeURIComponent(q)}` : '')),
  packages:          ()      => api('/packages'),
  rules:             ()      => api('/rules'),
  tasks:             ()      => api('/tasks'),
  cancelTask:        (id)    => api(`/tasks/${id}`,                                 { method:'DELETE' }),
  nodes:             ()      => api('/nodes'),
  createNodeEnrollment: (b)  => api('/nodes/enrollments',                         { method:'POST', body: JSON.stringify(b) }),
  alarms:            ()      => api('/alarms'),
  audit:             (l=100) => api(`/audit?limit=${l}`),
  siemConfig:        (t='default') => api(`/siem/config/${encodeURIComponent(t)}`),
  saveSiemConfig:    (t,b)   => api(`/siem/config/${encodeURIComponent(t)}`,         { method:'PUT', body: JSON.stringify(b) }),
  testSiem:          (t='default') => api(`/siem/test/${encodeURIComponent(t)}`,      { method:'POST', body: '{}' }),
  verifySiem:        (t='default') => api(`/siem/verify/${encodeURIComponent(t)}`,    { method:'POST', body: '{}' }),
  siemQueueStatus:   ()      => api('/siem/queue/status'),
  securityPosture:   (t='default') => api(`/security/posture?tenantId=${encodeURIComponent(t)}`),
  fixSecurityPosture:(t='default', actions) => api(`/security/posture/fix?tenantId=${encodeURIComponent(t)}`, { method:'POST', body: JSON.stringify(actions ? { actions } : {}) }),
  createPackage:     (b)     => api('/packages',                                 { method:'POST', body: JSON.stringify(b) }),
  deployPackageAll:  (id)    => api(`/packages/${id}/deploy-all`,                { method:'POST', body: '{}' }),
  updateAllForApp:   (n,b)   => api(`/apps/${encodeURIComponent(n)}/update-all`, { method:'POST', body: JSON.stringify(b||{targetVersion:'latest'}) }),
  updateDeviceForApp:(n,b)   => api(`/apps/${encodeURIComponent(n)}/update-device`, { method:'POST', body: JSON.stringify(b) }),
  refreshInventory:  (id)    => api(`/tasks/refresh-inventory/${id}`,            { method:'POST', body: '{}' }),
  updateAllOutdated: (id)    => api(`/devices/${id}/update-all-outdated`,        { method:'POST', body: '{}' }),
  createRule:        (b)     => api('/rules',                                    { method:'POST', body: JSON.stringify(b) }),
  updateRule:        (id,b)  => api(`/rules/${id}`,                              { method:'PATCH', body: JSON.stringify(b) }),
  toggleRule:        (id,e)  => api(`/rules/${id}`,                              { method:'PATCH', body: JSON.stringify({ enabled: e }) }),
  testRule:          (id,b)  => api(`/rules/${id}/test`,                         { method:'POST', body: JSON.stringify(b || {}) }),
  triggerRule:       (id,b)  => api(`/rules/${id}/trigger`,                      { method:'POST', body: JSON.stringify(b || {}) }),
  ruleAudit:         (id)    => api(id ? `/rules/${id}/audit` : '/rules/audit'),
  resolveAlarm:      (id)    => api(`/alarms/${id}/resolve`,                     { method:'POST', body: '{}' }),
};
