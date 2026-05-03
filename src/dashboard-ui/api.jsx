// AGPL-3.0-only — 1Patch management UI API client
const ADMIN_KEY = '1patch-admin-token';
function token() {
  let t = localStorage.getItem(ADMIN_KEY) || '';
  if (!t) {
    t = window.prompt('Admin API token (leave empty if none configured)') || '';
    localStorage.setItem(ADMIN_KEY, t);
  }
  return t;
}
async function api(path, init) {
  const headers = { 'content-type': 'application/json' };
  const t = token(); if (t) headers['x-1patch-admin-token'] = t;
  const r = await fetch(path, { ...init, headers: { ...headers, ...(init && init.headers) } });
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
