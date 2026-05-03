// AGPL-3.0-only — 1Patch management UI API client
const SESSION_KEY = '1patch-session';

function session() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || '{}'); }
  catch { return {}; }
}

async function login() {
  const email = window.prompt('Email') || '';
  const password = window.prompt('Password') || '';
  const r = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || 'Login failed');
  const sessionBody = body.mfaRequired ? await verifyMfa(body.challengeToken) : body;
  localStorage.setItem(SESSION_KEY, JSON.stringify({ accessToken: sessionBody.accessToken, user: sessionBody.user }));
  return sessionBody.accessToken;
}

async function verifyMfa(challengeToken) {
  const code = window.prompt('MFA code') || '';
  const r = await fetch('/auth/mfa/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeToken, code }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || 'MFA verification failed');
  return body;
}

async function token() {
  const existing = session().accessToken;
  return existing || await login();
}

async function api(path, init) {
  const headers = { 'content-type': 'application/json' };
  const t = await token(); if (t) headers.authorization = `Bearer ${t}`;
  const r = await fetch(path, { ...init, headers: { ...headers, ...(init && init.headers) } });
  if (r.status === 401) {
    localStorage.removeItem(SESSION_KEY);
    const retryToken = await login();
    const retry = await fetch(path, { ...init, headers: { ...headers, authorization: `Bearer ${retryToken}`, ...(init && init.headers) } });
    if (!retry.ok) throw new Error(`${retry.status} ${retry.statusText} — ${path}`);
    const retryCt = retry.headers.get('content-type') || '';
    return retryCt.includes('application/json') ? retry.json() : retry.text();
  }
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${path}`);
  const ct = r.headers.get('content-type') || '';
  return ct.includes('application/json') ? r.json() : r.text();
}
window.PatchAPI = {
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
  createPackage:     (b)     => api('/packages',                                 { method:'POST', body: JSON.stringify(b) }),
  deployPackageAll:  (id)    => api(`/packages/${id}/deploy-all`,                { method:'POST', body: '{}' }),
  updateAllForApp:   (n,b)   => api(`/apps/${encodeURIComponent(n)}/update-all`, { method:'POST', body: JSON.stringify(b||{targetVersion:'latest'}) }),
  updateDeviceForApp:(n,b)   => api(`/apps/${encodeURIComponent(n)}/update-device`, { method:'POST', body: JSON.stringify(b) }),
  refreshInventory:  (id)    => api(`/tasks/refresh-inventory/${id}`,            { method:'POST', body: '{}' }),
  updateAllOutdated: (id)    => api(`/devices/${id}/update-all-outdated`,        { method:'POST', body: '{}' }),
  createRule:        (b)     => api('/rules',                                    { method:'POST', body: JSON.stringify(b) }),
  toggleRule:        (id,e)  => api(`/rules/${id}`,                              { method:'PATCH', body: JSON.stringify({ enabled: e }) }),
  resolveAlarm:      (id)    => api(`/alarms/${id}/resolve`,                     { method:'POST', body: '{}' }),
};
