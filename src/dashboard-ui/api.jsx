// AGPL-3.0-only — 1Patch management UI API client
const SESSION_KEY = '1patch-session';

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
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${path}`);
  const ct = r.headers.get('content-type') || '';
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

window.PatchAPI = {
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
};
