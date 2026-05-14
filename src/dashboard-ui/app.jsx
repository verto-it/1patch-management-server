// AGPL-3.0-only — Main app shell, routing, tweaks
const { useState: useStateApp, useEffect: useEffectApp, useRef: useRefApp } = React;

const TENANT_NAME = /*EDITMODE-BEGIN*/"1patch"/*EDITMODE-END*/;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "accentHue": 145,
  "density": "comfortable",
  "sidebar": "labelled"
}/*EDITMODE-END*/;

const CATEGORY_IDS = [
  "overview", "devices", "device-groups", "apps", "packages", "rules", "tasks", "nodes", "alarms", "audit",
  "admin-policy", "admin-users", "admin-permissions", "admin-siem", "admin-sso", "admin-posture",
];
const LEGACY_CATEGORY_MAP = {
  admin: "admin-policy",
  siem: "admin-siem",
  settings: "admin-sso",
  "security-posture": "admin-posture",
};
const ADMIN_TAB_TO_CATEGORY = {
  policy: "admin-policy",
  users: "admin-users",
  permissions: "admin-permissions",
  siem: "admin-siem",
  sso: "admin-sso",
  posture: "admin-posture",
};
const SEARCH_TYPES = ["device", "group", "app", "package", "rule", "task", "node", "alarm", "audit"];
const SEARCH_ALIASES = {
  devices: "device",
  groups: "group",
  "device-groups": "group",
  apps: "app",
  packages: "package",
  rules: "rule",
  tasks: "task",
  nodes: "node",
  alarms: "alarm",
  audits: "audit",
  log: "audit",
  logs: "audit",
};
const SEARCH_TYPE_TO_CATEGORY = {
  device: "devices",
  group: "device-groups",
  app: "apps",
  package: "packages",
  rule: "rules",
  task: "tasks",
  node: "nodes",
  alarm: "alarms",
  audit: "audit",
};

/**
 * Parses search query input.
 *
 * @param value Value to read, render, or store.
 * @returns The result produced by the operation.
 */
function parseSearchQuery(value) {
  const raw = (value || "").trim();
  const match = raw.match(/^([a-z]+):\s*(.*)$/i);
  if (!match) return { type: null, term: raw };
  const requested = match[1].toLowerCase();
  const type = SEARCH_TYPES.includes(requested) ? requested : SEARCH_ALIASES[requested];
  return type ? { type, term: match[2].trim() } : { type: null, term: raw };
}

/**
 * Handles the text matches operation.
 *
 * @param query Search query or filter supplied by the caller.
 * @param parts parts supplied to the function.
 * @returns The result produced by the operation.
 */
function textMatches(query, parts) {
  if (!query) return true;
  const haystack = parts.filter(Boolean).join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).every((part) => haystack.includes(part));
}

/**
 * Handles the highlight operation.
 *
 * @param text text supplied to the function.
 * @param term term supplied to the function.
 * @returns The result produced by the operation.
 */
function highlight(text, term) {
  if (!term || !text) return text || "";
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = String(text).split(new RegExp(`(${esc})`, "gi"));
  if (parts.length === 1) return text;
  return parts.map((p, i) => i % 2 === 1 ? React.createElement("mark", { className: "search-mark", key: i }, p) : p);
}

/**
 * Handles the limit results operation.
 *
 * @param items items supplied to the function.
 * @param limit Maximum number of records to return.
 * @returns The result produced by the operation.
 */
function limitResults(items, limit = 8) {
  return items.slice(0, limit);
}

/**
 * Builds the search results payload.
 *
 * @param data data supplied to the function.
 * @param query Search query or filter supplied by the caller.
 * @returns The result produced by the operation.
 */
function buildSearchResults(data, query) {
  const { type, term } = parseSearchQuery(query);
  /**
   * Handles the include operation.
   *
   * @param candidateType candidate type supplied to the function.
   */
  const include = (candidateType) => !type || type === candidateType;
  const groups = [];

  if (include("device")) {
    const rows = limitResults((data.devices || [])
      .filter(d => textMatches(term, [d.hostname, formatOs(d.os), d.os, d.site, d.id, d.preferredNodeId]))
      .map(d => ({
        type: "device",
        title: d.hostname || d.id,
        meta: [formatOs(d.os), d.site, d.online ? "online" : "offline"].filter(Boolean).join(" · "),
        target: "devices",
        deviceId: d.id,
      })));
    if (rows.length) groups.push(["Devices", rows]);
  }

  if (include("group")) {
    const groupMap = new Map();
    for (const device of data.devices || []) {
      const name = device.group || "ungrouped";
      const row = groupMap.get(name) || { name, count: 0, online: 0, samples: [] };
      row.count += 1;
      row.online += device.online ? 1 : 0;
      if (row.samples.length < 3) row.samples.push(device.hostname || device.id);
      groupMap.set(name, row);
    }
    const rows = limitResults([...groupMap.values()]
      .filter(g => textMatches(term, [g.name, ...g.samples]))
      .map(g => ({
        type: "group",
        title: g.name,
        meta: `${g.count} devices · ${g.online} online`,
        target: "device-groups",
      })));
    if (rows.length) groups.push(["Device Groups", rows]);
  }

  if (include("app")) {
    const rows = limitResults((data.apps || [])
      .filter(a => textMatches(term, [a.name, a.publisher, a.latestVersion, a.latest, a.oldestVersion, a.oldest]))
      .map(a => ({
        type: "app",
        title: a.name,
        meta: [a.publisher, a.latestVersion ?? a.latest].filter(Boolean).join(" · "),
        target: "apps",
      })));
    if (rows.length) groups.push(["Apps", rows]);
  }

  if (include("package")) {
    const rows = limitResults((data.packages || [])
      .filter(p => textMatches(term, [p.name, p.publisher, p.version, p.type, p.platform, p.architecture, p.sha256]))
      .map(p => ({
        type: "package",
        title: p.name,
        meta: [p.version, p.type, p.platform].filter(Boolean).join(" · "),
        target: "packages",
      })));
    if (rows.length) groups.push(["Packages", rows]);
  }

  if (include("rule")) {
    const rows = limitResults((data.rules || [])
      .filter(r => textMatches(term, [r.name, r.description, r.trigger?.type, r.trigger?.eventType, JSON.stringify(r.conditionGroup), JSON.stringify(r.actions), r.enabled ? "enabled" : "disabled"]))
      .map(r => ({
        type: "rule",
        title: r.name,
        meta: `${r.trigger?.type || "manual"} · ${conditionSummary(r.conditionGroup || { combinator:"AND", conditions:r.conditions || [] })}`,
        target: "rules",
      })));
    if (rows.length) groups.push(["Rules", rows]);
  }

  if (include("task")) {
    const rows = limitResults(sortTasksNewestFirst(data.tasks || [])
      .filter(t => textMatches(term, [taskLabel(t), t.type, t.appName, t.deviceId, t.nodeId, t.status, t.fromVersion, t.targetVersion, t.output]))
      .map(t => ({
        type: "task",
        title: taskLabel(t),
        meta: [t.deviceId, t.nodeId, t.status].filter(Boolean).join(" · "),
        target: "tasks",
      })));
    if (rows.length) groups.push(["Tasks", rows]);
  }

  if (include("node")) {
    const rows = limitResults((data.nodes || [])
      .filter(n => textMatches(term, [n.name, n.id, n.publicUrl, n.url, n.region, n.site, n.status, n.version]))
      .map(n => ({
        type: "node",
        title: n.name || n.id,
        meta: [n.region, n.status, n.publicUrl || n.url].filter(Boolean).join(" · "),
        target: "nodes",
      })));
    if (rows.length) groups.push(["Nodes", rows]);
  }

  if (include("alarm")) {
    const rows = limitResults((data.alarms || [])
      .filter(a => textMatches(term, [a.message, a.deviceId, a.severity, a.id]))
      .map(a => ({
        type: "alarm",
        title: a.message,
        meta: [a.severity, a.deviceId].filter(Boolean).join(" · "),
        target: "alarms",
      })));
    if (rows.length) groups.push(["Alarms", rows]);
  }

  if (include("audit")) {
    const rows = limitResults((data.audit || [])
      .filter(e => textMatches(term, [e.actor, e.action, e.target, e.id]))
      .map(e => ({
        type: "audit",
        title: e.action || e.id,
        meta: [e.actor, e.target].filter(Boolean).join(" · "),
        target: "audit",
      })));
    if (rows.length) groups.push(["Audit", rows]);
  }

  return groups;
}

/**
 * Handles the category from url operation.
 * @returns The result produced by the operation.
 */
function categoryFromUrl() {
  const parts = window.location.pathname.replace(/^\/ui\/?/, "").split("/").filter(Boolean);
  const pathCategory = parts[0];
  if (pathCategory === "admin") {
    const adminSection = parts[1] || "policy";
    return ADMIN_TAB_TO_CATEGORY[adminSection] || "admin-policy";
  }
  if (LEGACY_CATEGORY_MAP[pathCategory]) return LEGACY_CATEGORY_MAP[pathCategory];
  if (CATEGORY_IDS.includes(pathCategory)) return pathCategory;
  const params = new URLSearchParams(window.location.search);
  const category = params.get("category") || params.get("tab");
  if (LEGACY_CATEGORY_MAP[category]) return LEGACY_CATEGORY_MAP[category];
  return CATEGORY_IDS.includes(category) ? category : "overview";
}

/**
 * Handles the push category url operation.
 *
 * @param category category supplied to the function.
 */
function pushCategoryUrl(category) {
  const adminEntry = Object.entries(ADMIN_TAB_TO_CATEGORY).find(([, value]) => value === category);
  const target = category === "overview"
    ? "/ui"
    : adminEntry
      ? `/ui/admin/${adminEntry[0]}`
      : `/ui/${category}`;
  window.history.pushState({ category }, "", target);
}

/**
 * Renders the app UI.
 * @returns The result produced by the operation.
 */
function App() {
  const [authSession, setAuthSession] = useStateApp(() => PatchAPI.session());

  useEffectApp(() => {
    /**
     * Handles the on session change operation.
     */
    const onSessionChange = () => setAuthSession(PatchAPI.session());
    window.addEventListener("patch-session-change", onSessionChange);
    return () => window.removeEventListener("patch-session-change", onSessionChange);
  }, []);

  if (!authSession.accessToken) {
    return <LoginScreen onAuthenticated={(nextSession) => setAuthSession(nextSession)}/>;
  }

  return <DashboardApp sessionInfo={authSession} onLogout={() => { PatchAPI.logout(); setAuthSession({}); }}/>;
}

/**
 * Renders the dashboard app UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function DashboardApp({ sessionInfo, onLogout }) {
  const [tab, setTabState] = useStateApp(categoryFromUrl);
  const [openDevice, setOpenDevice] = useStateApp(null);
  const [globalSearch, setGlobalSearch] = useStateApp("");
  const [confirmLogout, setConfirmLogout] = useStateApp(false);
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);

  /**
   * Sets the tab value.
   *
   * @param category category supplied to the function.
   */
  const setTab = (category) => {
    if (!CATEGORY_IDS.includes(category)) category = "overview";
    setTabState(category);
    pushCategoryUrl(category);
  };

  useEffectApp(() => {
    /**
     * Handles the on pop state operation.
     */
    const onPopState = () => setTabState(categoryFromUrl());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // live counts for sidebar badges
  const [counts, setCounts] = useStateApp({ devices: null, pending: null, criticalAlarms: null });
  useEffectApp(() => {
    let alive = true;
    let inFlight = false;
    /**
     * Handles the tick operation.
     */
    const tick = () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      Promise.allSettled([
        PatchAPI.summary(),
        PatchAPI.tasks(),
        PatchAPI.alarms(),
      ]).then(([summaryResult, tasksResult, alarmsResult]) => {
        if (!alive) return;
        setCounts(prev => {
          const s = summaryResult.status === "fulfilled" ? summaryResult.value : null;
          const tasks = tasksResult.status === "fulfilled" ? tasksResult.value : null;
          const alarms = alarmsResult.status === "fulfilled" ? alarmsResult.value : null;
          return {
            devices: s?.managedDevices ?? prev.devices,
            pending: Array.isArray(tasks) ? tasks.filter(t => ["pending","dispatched"].includes(t.status)).length : prev.pending,
            criticalAlarms: Array.isArray(alarms) ? alarms.filter(a => a.severity === "critical").length : prev.criticalAlarms,
          };
        });
      }).finally(() => {
        inFlight = false;
      });
    };
    /**
     * Handles the on visible operation.
     */
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    tick();
    document.addEventListener("visibilitychange", onVisible);
    const id = setInterval(tick, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffectApp(() => {
    document.documentElement.style.setProperty("--accent",      `oklch(0.55 0.14 ${tweaks.accentHue})`);
    document.documentElement.style.setProperty("--accent-h",    `oklch(0.50 0.15 ${tweaks.accentHue})`);
    document.documentElement.style.setProperty("--accent-soft", `oklch(0.96 0.03 ${tweaks.accentHue})`);
    document.documentElement.style.setProperty("--accent-text", `oklch(0.40 0.13 ${tweaks.accentHue})`);
  }, [tweaks.accentHue, tweaks.theme]);

  const permissions = sessionInfo.user?.permissions || [];
  const canAdmin = permissions.some((permission) => ['auth:manage', 'users:manage', 'roles:manage'].includes(permission));
  const OPERATE_NAV = [
    { id:"overview", label:"Overview",  icon: Icon.dashboard },
    { id:"devices",  label:"Devices",   icon: Icon.devices,  count: counts.devices },
  ];
  const CATALOG_NAV = [
    { id:"device-groups", label:"Groups", icon: Icon.groups },
    { id:"apps",     label:"Apps",      icon: Icon.apps },
    { id:"packages", label:"Packages",  icon: Icon.packages },
  ];
  const ACTIVITY_NAV = [
    { id:"rules",    label:"Rules",     icon: Icon.rules },
    { id:"tasks",    label:"Tasks",     icon: Icon.tasks,    count: counts.pending },
    { id:"nodes",    label:"Nodes",     icon: Icon.nodes },
    { id:"alarms",   label:"Alarms",    icon: Icon.alarms,   count: counts.criticalAlarms, countTone: "crit" },
    { id:"audit",    label:"Audit",     icon: Icon.audit },
  ];
  const ADMIN_NAV = [
    { id:"admin-policy",      label:"Policy",      icon: Icon.shield },
    { id:"admin-users",       label:"Users",       icon: Icon.devices },
    { id:"admin-permissions", label:"Permissions", icon: Icon.rules },
    { id:"admin-siem",        label:"SIEM",        icon: Icon.audit },
    { id:"admin-sso",         label:"SSO",         icon: Icon.settings },
    { id:"admin-posture",     label:"Posture",     icon: Icon.shield },
  ];
  const NAV = [...OPERATE_NAV, ...CATALOG_NAV, ...ACTIVITY_NAV, ...(canAdmin ? ADMIN_NAV : [])];

  /**
   * Handles the page search term operation.
   *
   * @param category category supplied to the function.
   * @returns The result produced by the operation.
   */
  const pageSearchTerm = (category) => {
    const parsed = parseSearchQuery(globalSearch);
    if (!parsed.type) return "";
    return SEARCH_TYPE_TO_CATEGORY[parsed.type] === category ? parsed.term : "";
  };

  const adminPage = (initialTab) => canAdmin
    ? <AdminSettingsPage initialTab={initialTab} onAdminTabChange={(adminTab) => setTab(ADMIN_TAB_TO_CATEGORY[adminTab] || "admin-policy")}/>
    : (
      <div className="page">
        <div className="card">
          <div className="card-body">
            <h2>Admin permissions required</h2>
            <p className="sub">You need an admin role with auth, user, or role management permission to open this area.</p>
          </div>
        </div>
      </div>
    );

  const Page = {
    overview: <OverviewPage onNav={setTab} onOpenDevice={setOpenDevice}/>,
    devices:  <DevicesPage onOpenDevice={setOpenDevice} globalSearch={pageSearchTerm("devices")}/>,
    "device-groups": <DeviceGroupsPage onOpenDevice={setOpenDevice} globalSearch={pageSearchTerm("device-groups")}/>,
    apps:     <AppsPage globalSearch={pageSearchTerm("apps")}/>,
    packages: <PackagesPage globalSearch={pageSearchTerm("packages")}/>,
    rules:    <RulesPage globalSearch={pageSearchTerm("rules")}/>,
    tasks:    <TasksPage globalSearch={pageSearchTerm("tasks")}/>,
    nodes:    <NodesPage globalSearch={pageSearchTerm("nodes")}/>,
    alarms:   <AlarmsPage globalSearch={pageSearchTerm("alarms")}/>,
    audit:    <AuditPage globalSearch={pageSearchTerm("audit")}/>,
    "admin-policy": adminPage('policy'),
    "admin-users": adminPage('users'),
    "admin-permissions": adminPage('permissions'),
    "admin-siem": adminPage('siem'),
    "admin-sso": adminPage('sso'),
    "admin-posture": adminPage('posture'),
  }[tab];

  const current = NAV.find(n => n.id === tab) || {
    label: tab.startsWith('admin-') ? 'Admin' : 'Overview',
  };
  /**
   * Handles the handle search select operation.
   *
   * @param result result supplied to the function.
   */
  const handleSearchSelect = (result) => {
    setTab(result.target);
    if (result.deviceId) setOpenDevice(result.deviceId);
  };

  return (
    <div className="shell" data-theme={tweaks.theme} data-density={tweaks.density} data-sidebar={tweaks.sidebar} data-screen-label={`01 ${current.label}`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <img src="/ui/logo.png" alt="1Patch" className="brand-logo" />
          <div className="brand-name">1Patch <em>Management</em></div>
        </div>
        <div className="nav-section">Operate</div>
        {OPERATE_NAV.map(n => <NavItem key={n.id} item={n} active={tab===n.id} onClick={() => setTab(n.id)}/>)}
        <div className="nav-section">Catalog</div>
        {CATALOG_NAV.map(n => <NavItem key={n.id} item={n} active={tab===n.id} onClick={() => setTab(n.id)}/>)}
        <div className="nav-section">Activity</div>
        {ACTIVITY_NAV.map(n => <NavItem key={n.id} item={n} active={tab===n.id} onClick={() => setTab(n.id)}/>)}
        {canAdmin && (
          <>
            <div className="nav-section">Admin</div>
            {ADMIN_NAV.map(n => <NavItem key={n.id} item={n} active={tab===n.id} onClick={() => setTab(n.id)}/>)}
          </>
        )}
        <div className="sidebar-footer">
          {confirmLogout ? (
            <div className="logout-confirm">
              <span className="logout-confirm-label">Sign out?</span>
              <div className="logout-confirm-actions">
                <button type="button" className="btn sm ghost" onClick={() => setConfirmLogout(false)}>Cancel</button>
                <button type="button" className="btn sm logout-confirm-yes" onClick={() => { onLogout(); setConfirmLogout(false); }}>Sign out</button>
              </div>
            </div>
          ) : (
            <div className="user-card">
              <div className="avatar">{initials(sessionInfo.user?.email)}</div>
              <div className="user-meta"><strong>{sessionInfo.user?.email || "Admin session"}</strong><span>{TENANT_NAME}</span></div>
              <button type="button" className="icon-btn logout-btn" aria-label="Sign out" title="Sign out" onClick={() => setConfirmLogout(true)}>{Icon.logout}</button>
            </div>
          )}
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <div className="crumbs">
            <span className="crumb">Tenant</span>
            <span className="sep">/</span>
            <span className="crumb">{TENANT_NAME}</span>
            <span className="sep">/</span>
            <h1>{current.label}</h1>
          </div>
          <GlobalSearch
            onSelect={handleSearchSelect}
            onQueryChange={(value) => {
              setGlobalSearch(value);
              const parsed = parseSearchQuery(value);
              const category = parsed.type ? SEARCH_TYPE_TO_CATEGORY[parsed.type] : null;
              if (category && category !== tab) setTab(category);
            }}
          />
          <NotificationBell counts={counts} onNav={setTab}/>
        </div>
        {Page}
      </div>

      {openDevice && <DeviceDrawer deviceId={openDevice} onClose={() => setOpenDevice(null)}/>}

      <TweaksPanel title="Tweaks">
        <TweakSection title="Appearance">
          <TweakRadio label="Theme" value={tweaks.theme} options={[["light","Light"],["dark","Dark"]]} onChange={v => setTweak("theme", v)}/>
          <TweakSlider label="Accent hue" min={0} max={360} step={1} value={tweaks.accentHue} onChange={v => setTweak("accentHue", v)}/>
          <TweakRadio label="Density" value={tweaks.density} options={[["compact","Compact"],["comfortable","Comfy"],["spacious","Spacious"]]} onChange={v => setTweak("density", v)}/>
          <TweakRadio label="Sidebar" value={tweaks.sidebar} options={[["labelled","Labelled"],["icon","Icon-only"]]} onChange={v => setTweak("sidebar", v)}/>
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

/**
 * Returns a human-readable label for the auth method stored in the session.
 *
 * @param method The authMethod string from the session.
 * @returns The result produced by the operation.
 */
function authMethodLabel(method) {
  if (!method || method === 'password') return 'Password auth';
  if (method === 'password+totp') return 'Password + TOTP';
  if (method.startsWith('sso:')) {
    const type = method.split(':')[1];
    const labels = {
      microsoft: 'Microsoft SSO',
      google: 'Google SSO',
      github: 'GitHub SSO',
      okta: 'Okta SSO',
      oidc: 'SSO',
    };
    return labels[type] || 'SSO';
  }
  return 'Signed in';
}

/**
 * Handles the initials operation.
 *
 * @param email email supplied to the function.
 * @returns The result produced by the operation.
 */
function initials(email) {
  const name = String(email || "1P").trim();
  if (!name || name === "1P") return "1P";
  return name.slice(0, 2).toUpperCase();
}

/**
 * Returns the SVG icon element for a given SSO provider type.
 *
 * @param type The provider type string.
 * @returns The result produced by the operation.
 */
function SsoProviderIcon({ type, size = 18 }) {
  if (type === 'microsoft') return (
    <svg viewBox="0 0 21 21" width={size} height={size} fill="none">
      <rect x="1" y="1" width="9" height="9" fill="#F25022"/>
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00"/>
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF"/>
      <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
    </svg>
  );
  if (type === 'google') return (
    <svg viewBox="0 0 24 24" width={size} height={size}>
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
  if (type === 'github') return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z"/>
    </svg>
  );
  if (type === 'okta') return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none">
      <circle cx="12" cy="12" r="10" fill="#007DC1"/>
      <circle cx="12" cy="12" r="5" fill="white"/>
    </svg>
  );
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 2 13 4v3.5c0 3-2 5.4-5 6.5-3-1.1-5-3.5-5-6.5V4z"/>
    </svg>
  );
}

/**
 * Renders the login screen UI with SSO provider support.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function LoginScreen({ onAuthenticated }) {
  const [email, setEmail] = useStateApp("");
  const [password, setPassword] = useStateApp("");
  const [mfaCode, setMfaCode] = useStateApp("");
  const [challengeToken, setChallengeToken] = useStateApp("");
  const [loading, setLoading] = useStateApp(false);
  const [error, setError] = useStateApp("");
  const [ssoProviders, setSsoProviders] = useStateApp([]);
  const [ssoLoading, setSsoLoading] = useStateApp(null);
  const mfaRequired = Boolean(challengeToken);

  // Load SSO providers and handle SSO callback on mount
  useEffectApp(() => {
    PatchAPI.ssoProviders().then(setSsoProviders).catch(() => {});

    const params = new URLSearchParams(window.location.search);
    const handoffToken = params.get('sso_handoff');
    const ssoError = params.get('sso_error');

    // Clean URL regardless of outcome
    if (handoffToken || ssoError) {
      const clean = window.location.pathname;
      window.history.replaceState({}, '', clean);
    }

    if (ssoError) {
      setError(decodeURIComponent(ssoError));
      return;
    }

    if (handoffToken) {
      setLoading(true);
      PatchAPI.ssoComplete(handoffToken)
        .then((body) => onAuthenticated(body))
        .catch((err) => setError(err.message || 'SSO login failed'))
        .finally(() => setLoading(false));
    }
  }, []);

  /**
   * Handles SSO provider button click.
   *
   * @param provider The SSO provider object.
   */
  const handleSsoClick = (provider) => {
    if (ssoLoading) return;
    setSsoLoading(provider.id);
    setError("");
    PatchAPI.ssoInitiate(provider.id)
      .then(({ authorizationUrl }) => {
        window.location.href = authorizationUrl;
      })
      .catch((err) => {
        setError(err.message || 'SSO initiation failed');
        setSsoLoading(null);
      });
  };

  /**
   * Handles the submit operation.
   *
   * @param event Event object emitted by the runtime or UI.
   */
  const submit = (event) => {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError("");
    const action = mfaRequired
      ? PatchAPI.verifyMfa(challengeToken, mfaCode.trim())
      : PatchAPI.login(email.trim(), password);
    action.then((body) => {
      if (body.mfaRequired) {
        setChallengeToken(body.challengeToken);
        setMfaCode("");
        setError("");
        return;
      }
      onAuthenticated(body);
    }).catch((err) => {
      setError(err.message || (mfaRequired ? "MFA verification failed" : "Login failed"));
    }).finally(() => {
      setLoading(false);
    });
  };

  return (
    <main className="login-screen">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-brand">
          <img src="/ui/logo.png" alt="1Patch" className="brand-logo brand-logo--lg" />
          <div>
            <strong>1Patch Management</strong>
            <span>Control plane access</span>
          </div>
        </div>
        <div className="login-copy">
          <h1 id="login-title">{mfaRequired ? "Enter MFA code" : "Sign in"}</h1>
          <p>{mfaRequired ? "Use the current code from your authenticator app." : "Use your account credentials or an identity provider below."}</p>
        </div>

        {!mfaRequired && ssoProviders.length > 0 && (
          <div className="sso-providers">
            {ssoProviders.map((provider) => (
              <button
                key={provider.id}
                type="button"
                className="btn sso-btn"
                disabled={Boolean(ssoLoading) || loading}
                onClick={() => handleSsoClick(provider)}
              >
                {ssoLoading === provider.id
                  ? <span className="search-spinner"/>
                  : <SsoProviderIcon type={provider.type}/>
                }
                Continue with {provider.name}
              </button>
            ))}
            <div className="sso-divider"><span>or sign in with password</span></div>
          </div>
        )}

        <form className="login-form" onSubmit={submit}>
          {!mfaRequired && (
            <>
              <label className="field">
                <span>Email address</span>
                <input
                  type="email"
                  autoComplete="email"
                  placeholder="admin@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus={ssoProviders.length === 0}
                />
              </label>
              <label className="field">
                <span>Password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••••••"
                  minLength="12"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
            </>
          )}
          {mfaRequired && (
            <label className="field">
              <span>Authentication code</span>
              <input
                className="mfa-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                required
                autoFocus
              />
            </label>
          )}
          {error && <div className="login-error" role="alert">{error}</div>}
          <button type="submit" className="btn login-submit" disabled={loading || (mfaRequired ? mfaCode.length < 6 : !email || !password)}>
            {loading ? <span className="search-spinner"/> : <span className="login-submit-icon">{Icon.shield}</span>}
            {mfaRequired ? "Verify code" : "Sign in securely"}
          </button>
          {mfaRequired && (
            <button type="button" className="btn login-back" onClick={() => { setChallengeToken(""); setError(""); }}>
              Back to password
            </button>
          )}
        </form>
      </section>
    </main>
  );
}

/**
 * Renders the notification bell UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function NotificationBell({ counts, onNav }) {
  const [open, setOpen] = useStateApp(false);
  const [loading, setLoading] = useStateApp(false);
  const [error, setError] = useStateApp(null);
  const [alarms, setAlarms] = useStateApp([]);
  const [tasks, setTasks] = useStateApp([]);
  const rootRef = useRefApp(null);
  const alarmCount = alarms.length || counts.criticalAlarms || 0;
  const activeTasks = tasks.filter(t => ["pending", "dispatched"].includes(t.status));
  const failedTasks = tasks.filter(t => t.status === "failed");
  const unreadCount = Math.min(99, alarmCount + activeTasks.length + failedTasks.length);
  const recentItems = [
    ...alarms.slice(0, 4).map(a => ({
      key: `alarm-${a.id}`,
      type: "alarm",
      title: a.message || "Active alarm",
      meta: [a.deviceId, fmtAgo(a.createdAt)].filter(Boolean).join(" · "),
      tone: a.severity === "critical" ? "crit" : a.severity === "warning" ? "warn" : "accent",
      target: "alarms",
    })),
    ...activeTasks.slice(0, 3).map(t => ({
      key: `task-${t.id}`,
      type: "task",
      title: taskLabel(t),
      meta: [t.status, t.deviceId, fmtAgo(t.createdAt)].filter(Boolean).join(" · "),
      tone: "accent",
      target: "tasks",
    })),
    ...failedTasks.slice(0, 3).map(t => ({
      key: `failed-${t.id}`,
      type: "failed",
      title: taskLabel(t),
      meta: [t.deviceId, fmtAgo(t.completedAt || t.createdAt)].filter(Boolean).join(" · "),
      tone: "crit",
      target: "tasks",
    })),
  ].slice(0, 6);

  /**
   * Loads load data.
   *
   * @param silent silent supplied to the function.
   */
  const load = (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    Promise.all([
      PatchAPI.alarms(),
      PatchAPI.tasks(),
    ]).then(([nextAlarms, nextTasks]) => {
      setAlarms(Array.isArray(nextAlarms) ? nextAlarms : []);
      setTasks(Array.isArray(nextTasks) ? nextTasks : []);
    }).catch((err) => {
      setError(err);
    }).finally(() => {
      if (!silent) setLoading(false);
    });
  };

  useEffectApp(() => {
    load(true);
  }, []);

  useEffectApp(() => {
    if (!open) return;
    load(false);
    const id = setInterval(() => load(true), 10_000);
    return () => clearInterval(id);
  }, [open]);

  useEffectApp(() => {
    if (!open) return;
    /**
     * Handles the on pointer down operation.
     *
     * @param e Event object emitted by the runtime or UI.
     */
    const onPointerDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    /**
     * Handles the on key down operation.
     *
     * @param e Event object emitted by the runtime or UI.
     */
    const onKeyDown = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  /**
   * Handles the go operation.
   *
   * @param target target supplied to the function.
   */
  const go = (target) => {
    onNav(target);
    setOpen(false);
  };

  return (
    <div className="notification-bell" ref={rootRef}>
      <button
        type="button"
        className={"icon-btn notification-trigger " + (open ? "active" : "")}
        aria-label={`Notifications${unreadCount ? `, ${unreadCount} active` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open ? "true" : "false"}
        onClick={() => setOpen(v => !v)}
      >
        <span className="notification-icon">{Icon.bell}</span>
        {unreadCount > 0 && (
          <span className="notification-badge" aria-hidden="true">{unreadCount > 9 ? "9+" : unreadCount}</span>
        )}
      </button>
      {open && (
        <div className="notification-popover" role="dialog" aria-label="Notifications">
          <div className="notification-head">
            <div>
              <h2>Notifications</h2>
              <span>{loading ? "Checking fleet activity" : `${unreadCount} item${unreadCount === 1 ? "" : "s"} need attention`}</span>
            </div>
            <button type="button" className="btn sm ghost" onClick={() => load(false)}>Refresh</button>
          </div>
          <div className="notification-summary">
            <button type="button" onClick={() => go("alarms")}>
              <strong>{alarmCount}</strong><span>Alarms</span>
            </button>
            <button type="button" onClick={() => go("tasks")}>
              <strong>{activeTasks.length}</strong><span>Running</span>
            </button>
            <button type="button" onClick={() => go("tasks")}>
              <strong>{failedTasks.length}</strong><span>Failed</span>
            </button>
          </div>
          {error && <div className="notification-empty">Notifications failed to load.</div>}
          {!error && loading && recentItems.length === 0 && <div className="notification-empty"><span className="search-spinner"/>Loading notifications...</div>}
          {!error && !loading && recentItems.length === 0 && <div className="notification-empty">No active notifications.</div>}
          {!error && recentItems.length > 0 && (
            <div className="notification-list">
              {recentItems.map(item => (
                <button type="button" key={item.key} className="notification-item" onClick={() => go(item.target)}>
                  <span className={"notification-dot " + item.tone}/>
                  <span className="notification-copy">
                    <strong>{item.title}</strong>
                    <span>{item.meta || item.type}</span>
                  </span>
                  <span className="notification-type">{item.type}</span>
                </button>
              ))}
            </div>
          )}
          <div className="notification-actions">
            <button type="button" className="btn ghost sm" onClick={() => go("tasks")}>View tasks</button>
            <button type="button" className="btn primary sm" onClick={() => go("alarms")}>Open alarms</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Renders the global search UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function GlobalSearch({ onSelect, onQueryChange }) {
  const [query, setQuery] = useStateApp("");
  const [focused, setFocused] = useStateApp(false);
  const [activeIndex, setActiveIndex] = useStateApp(0);
  const [loading, setLoading] = useStateApp(false);
  const [error, setError] = useStateApp(null);
  const [data, setData] = useStateApp({
    devices: [], apps: [], packages: [], rules: [], tasks: [], nodes: [], alarms: [], audit: [],
  });
  const trimmed = query.trim();
  const parsed = parseSearchQuery(trimmed);
  const results = trimmed ? buildSearchResults(data, trimmed) : [];
  const flatResults = results.flatMap(([label, rows]) => rows.map((result) => ({ ...result, group: label })));
  const resultCount = results.reduce((total, [, rows]) => total + rows.length, 0);
  const showPanel = focused && trimmed.length > 0;
  const showHint = focused && !trimmed;
  const isOpen = showPanel || showHint;
  const shortcutLabel = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || "") ? "⌘K" : "Ctrl K";

  useEffectApp(() => {
    onQueryChange?.(query);
    setActiveIndex(0);
  }, [query]);

  useEffectApp(() => {
    if (!trimmed) {
      setError(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    Promise.all([
      PatchAPI.devices().catch(() => []),
      PatchAPI.apps().catch(() => []),
      PatchAPI.packages().catch(() => []),
      PatchAPI.rules().catch(() => []),
      PatchAPI.tasks().catch(() => []),
      PatchAPI.nodes().catch(() => []),
      PatchAPI.alarms().catch(() => []),
      PatchAPI.audit(200).catch(() => []),
    ]).then(([devices, apps, packages, rules, tasks, nodes, alarms, audit]) => {
      if (!alive) return;
      setData({ devices, apps, packages, rules, tasks, nodes, alarms, audit });
    }).catch((err) => {
      if (alive) setError(err);
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; };
  }, [trimmed]);

  useEffectApp(() => {
    if (activeIndex >= flatResults.length) setActiveIndex(Math.max(0, flatResults.length - 1));
  }, [flatResults.length, activeIndex]);

  /**
   * Handles the choose operation.
   *
   * @param result result supplied to the function.
   */
  const choose = (result) => {
    if (!result) return;
    onSelect(result);
    setQuery("");
    setFocused(false);
  };

  return (
    <div className={"global-search " + (focused ? "focused " : "") + (isOpen ? "open" : "")}>
      <div className="searchbox">
        <span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.search}</span>
        <input
          id="topbar-search"
          placeholder="Search everything..."
          value={query}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Escape") {
              setQuery("");
              e.currentTarget.blur();
            }
            if (e.key === "ArrowDown" && flatResults.length) {
              e.preventDefault();
              setActiveIndex(i => (i + 1) % flatResults.length);
            }
            if (e.key === "ArrowUp" && flatResults.length) {
              e.preventDefault();
              setActiveIndex(i => (i - 1 + flatResults.length) % flatResults.length);
            }
            if (e.key === "Enter") {
              e.preventDefault();
              choose(flatResults[activeIndex]);
            }
          }}
        />
        <span className="kbd">{shortcutLabel}</span>
      </div>
      {showHint && (
        <div className="search-panel">
          <div className="search-hint">
            <div className="search-hint-title">Search everything, or scope with a prefix:</div>
            <div className="search-hint-chips">
              {[["device:","devices"],["app:","apps"],["rule:","rules"],["node:","nodes"],["alarm:","alarms"],["audit:","audit"]].map(([pfx]) => (
                <button key={pfx} className="search-hint-chip" onMouseDown={e => { e.preventDefault(); setQuery(pfx); }}>
                  <code>{pfx}</code>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {showPanel && (
        <div className="search-panel">
          <div className="search-head">
            <span className="search-scope">{parsed.type || "all"}</span>
            <span>{loading ? "Searching" : `${resultCount} result${resultCount === 1 ? "" : "s"}`}</span>
          </div>
          {loading && <div className="search-empty"><span className="search-pulse"/>Searching…</div>}
          {error && <div className="search-empty">Search failed.</div>}
          {!loading && !error && resultCount === 0 && <div className="search-empty">No results for <strong>{trimmed}</strong></div>}
          {!loading && !error && results.map(([label, rows]) => (
            <div className="search-group" key={label}>
              <div className="search-group-label">{label}<span className="search-group-count">{rows.length}</span></div>
              {rows.map((result) => {
                const index = flatResults.findIndex(item => item.group === label && item.type === result.type && item.title === result.title && item.meta === result.meta);
                return (
                <button className={"search-result " + (index === activeIndex ? "active" : "")} key={`${label}-${index}`} onMouseEnter={() => setActiveIndex(index)} onMouseDown={(e) => { e.preventDefault(); choose(result); }}>
                  <span className="search-type" data-type={result.type}>{result.type}</span>
                  <span className="search-main">
                    <strong>{highlight(result.title || "Untitled", parsed.term)}</strong>
                    {result.meta && <span>{highlight(result.meta, parsed.term)}</span>}
                  </span>
                  <span className="search-open">{Icon.arrowR}</span>
                </button>
                );
              })}
            </div>
          ))}
          {!loading && !error && resultCount > 0 && (
            <div className="search-footer">
              <span><span className="kbd">&#x2191;&#x2193;</span> navigate</span>
              <span><span className="kbd">&#x23CE;</span> open</span>
              <span><span className="kbd">esc</span> clear</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Renders the nav item UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function NavItem({ item, active, onClick }) {
  return (
    <button className={"nav-item " + (active ? "active" : "")} onClick={onClick}>
      {item.icon}
      <span className="nav-label">{item.label}</span>
      {item.count != null && item.count > 0 && (
        <span className={"nav-count " + (item.countTone || "")}>{item.count}</span>
      )}
    </button>
  );
}

// ⌘K focuses the search input
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    const input = document.getElementById("topbar-search");
    input?.focus();
    input?.select();
  }
});

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
