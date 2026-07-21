// AGPL-3.0-only — Page components for the 1Patch management UI (live data, no mocks)
const { useState, useEffect, useMemo, useCallback, useRef } = React;

// ---------- Loader hook ----------
/**
 * Handles the data signature operation.
 *
 * @param value Value to read, render, or store.
 * @returns The result produced by the operation.
 */
function dataSignature(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Manages use resource state for the UI.
 *
 * @param loader loader supplied to the function.
 * @param deps deps supplied to the function.
 * @returns The result produced by the operation.
 */
function useResource(loader, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const signatureRef = useRef("");
  const requestRef = useRef(0);
  const mountedRef = useRef(false);
  const load = useCallback((silent = false) => {
    if (!mountedRef.current) return Promise.resolve(null);
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    if (!silent) setLoading(true);
    setError(null);
    return Promise.resolve(loader())
      .then(d => {
        if (!mountedRef.current || requestId !== requestRef.current) return d;
        const nextSignature = dataSignature(d);
        if (nextSignature !== signatureRef.current) {
          signatureRef.current = nextSignature;
          setData(d);
        }
        return d;
      })
      .catch(e => { if (mountedRef.current && requestId === requestRef.current) setError(e); })
      .finally(() => { if (mountedRef.current && requestId === requestRef.current) setLoading(false); });
  }, deps);
  const reload = useCallback((silent = false) => load(silent), [load]);
  useEffect(() => {
    mountedRef.current = true;
    load(false);
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
    // eslint-disable-next-line
  }, [load]);
  return { data, error, loading, reload };
}

/**
 * Manages use live resource state for the UI.
 *
 * @param resource resource supplied to the function.
 * @param intervalMs interval ms supplied to the function.
 */
function useLiveResource(resource, intervalMs = 5_000) {
  useEffect(() => {
    let inFlight = false;
    /**
     * Handles the tick operation.
     */
    const tick = () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      Promise.resolve(resource.reload(true)).finally(() => { inFlight = false; });
    };
    /**
     * Handles the on visible operation.
     */
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    const id = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [resource.reload, intervalMs]);
}

/**
 * Renders the skeleton UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function Skeleton({ w = "100%", h = 16, r = 4, style }) {
  return <span className="skel" style={{ display:"inline-block", width:w, height:h, borderRadius:r, ...style }}/>;
}
/**
 * Renders the error alert UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function ErrorAlert({ error, onRetry }) {
  return (
    <div className="alert">
      <strong>Couldn't load.</strong> <span className="muted">{error?.message || String(error)}</span>
      {onRetry && <button className="btn sm" onClick={onRetry}>Retry</button>}
    </div>
  );
}
/**
 * Renders the skeleton rows UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function SkeletonRows({ n = 6, cols = 6 }) {
  return Array.from({ length: n }).map((_, i) => (
    <tr key={i}>{Array.from({ length: cols }).map((_, j) => <td key={j}><Skeleton w={j === 0 ? 160 : 80}/></td>)}</tr>
  ));
}
/**
 * Handles the fmt ago operation.
 *
 * @param iso iso supplied to the function.
 * @returns The result produced by the operation.
 */
function fmtAgo(iso) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

/**
 * Handles the copy text to clipboard operation.
 *
 * @param text text supplied to the function.
 * @returns The result produced by the operation.
 */
async function copyTextToClipboard(text) {
  const value = typeof text === "string" ? text : String(text ?? "");
  if (!value) return false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {}
  }

  const active = document.activeElement;
  const selection = document.getSelection();
  const selectedRanges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i)) : [];
  const el = document.createElement("textarea");
  el.value = value;
  el.readOnly = true;
  el.setAttribute("aria-hidden", "true");
  Object.assign(el.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "1px",
    height: "1px",
    padding: "0",
    border: "0",
    opacity: "0",
    pointerEvents: "none",
  });
  document.body.appendChild(el);
  el.focus({ preventScroll: true });
  el.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  document.body.removeChild(el);
  if (active?.focus) active.focus({ preventScroll: true });
  if (selection) {
    try {
      selection.removeAllRanges();
      selectedRanges.forEach(range => selection.addRange(range));
    } catch {}
  }
  return copied;
}

// ---------- Overview ----------
/**
 * Renders the overview page UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function OverviewPage({ onNav, onOpenDevice }) {
  const summary  = useResource(() => PatchAPI.summary());
  const apps     = useResource(() => PatchAPI.apps());
  const tasks    = useResource(() => PatchAPI.tasks());
  const alarms   = useResource(() => PatchAPI.alarms());
  const history  = useResource(() => PatchAPI.coverageHistory(30));
  useLiveResource(summary, 5_000);
  useLiveResource(apps, 5_000);
  useLiveResource(tasks, 3_000);
  useLiveResource(alarms, 5_000);
  useLiveResource(history, 30_000);

  const s = summary.data || {};
  const historyRows = history.data || [];
  const coverage = s.coverage ?? historyRows[historyRows.length - 1]?.value ?? 0;
  const trend = [...historyRows.map(p => p.value)];
  if (!trend.length || trend[trend.length - 1] !== coverage) trend.push(coverage);
  const trendStart = trend[0] ?? coverage;
  const trendDelta = coverage - trendStart;
  const topApps = (apps.data || [])
    .filter(a => (a.outdatedDeviceCount ?? a.outdated) > 0)
    .sort((a,b) => (b.outdatedDeviceCount ?? b.outdated ?? 0) - (a.outdatedDeviceCount ?? a.outdated ?? 0))
    .slice(0, 6);
  const recentTasks = sortTasksNewestFirst(tasks.data || []).slice(0, 7);
  const recentAlarms = (alarms.data || []).slice(0, 5);
  const compliantApps = s.compliantApps ?? Math.max(0, (apps.data || []).reduce((n,a) => n + (a.deviceCount - (a.outdatedDeviceCount ?? a.outdated ?? 0)), 0));
  const outdatedApps  = s.outdatedApps  ?? (apps.data || []).reduce((n,a) => n + (a.outdatedDeviceCount ?? a.outdated ?? 0), 0);
  const totalApps = compliantApps + outdatedApps;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Fleet overview</h2>
          <p>Real-time patch coverage{summary.data && ` across ${s.managedDevices} devices`}</p>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button className="btn" onClick={() => { summary.reload(); apps.reload(); tasks.reload(); alarms.reload(); history.reload(); }}>
            <span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.refresh}</span>Refresh
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-body fleet-pulse">
          <div className="donut-wrap">
            {history.loading || summary.loading ? <Skeleton w={140} h={140} r={70}/> : <Donut value={coverage}/>}
          </div>
          <div className="pulse-meta">
            <div>
              <div className="pulse-sub">Patch coverage</div>
              <div className="pulse-headline">
                {apps.loading
                  ? <Skeleton w={280} h={28}/>
                  : <span><span className="accent">{compliantApps}</span> of {totalApps} apps compliant</span>}
              </div>
            </div>
            <div style={{ display:"flex", gap:18, flexWrap:"wrap" }}>
              <Metric label="Outdated" value={apps.loading ? "—" : outdatedApps} tone="warn"/>
              <Metric label="Critical alarms" value={alarms.loading ? "—" : (s.criticalAlarms ?? (alarms.data || []).filter(a => a.severity === "critical").length)} tone="crit"/>
              <Metric label="Failed tasks" value={tasks.loading ? "—" : (tasks.data || []).filter(t => t.status === "failed").length} tone="crit"/>
              <Metric label="Active rules" value={s.activeRules ?? "—"}/>
            </div>
          </div>
          <div className="pulse-spark" style={{ display:"flex", flexDirection:"column", justifyContent:"space-between" }}>
            <div className="pulse-sub" style={{ display:"flex", justifyContent:"space-between" }}>
              <span>30-day trend</span>
              {trend.length > 1 && <span style={{ color: trendDelta < 0 ? "var(--warn)" : "var(--ok)" }}>{trendDelta > 0 ? "+" : ""}{trendDelta}%</span>}
            </div>
            {history.loading
              ? <Skeleton w={260} h={64}/>
              : trend.length > 1
                ? <Sparkline data={trend} height={64} width={260}/>
                : <div className="muted" style={{ fontSize:12 }}>Collecting history…</div>}
          </div>
        </div>
      </div>

      <div className="stats">
        <Stat label="Devices" value={summary.loading ? "—" : s.managedDevices} sub={summary.loading ? "" : `${s.onlineDevices ?? 0} online · ${(s.managedDevices ?? 0) - (s.onlineDevices ?? 0)} offline`}/>
        <Stat label="Pending tasks" value={tasks.loading ? "—" : (tasks.data || []).filter(t => ["pending","dispatched"].includes(t.status)).length}/>
        <Stat label="Active alarms" value={alarms.loading ? "—" : (alarms.data || []).length} sub={alarms.loading ? "" : `${(alarms.data || []).filter(a => a.severity === "critical").length} critical`} tone={(alarms.data || []).some(a => a.severity === "critical") ? "crit" : ""}/>
        <Stat label="Apps tracked" value={apps.loading ? "—" : (apps.data || []).length}/>
      </div>

      <div className="row-2">
        <div className="card">
          <div className="card-head">
            <div><h3>Apps needing attention</h3><div className="sub">Sorted by devices on outdated versions</div></div>
            <button className="btn ghost sm" onClick={() => onNav("apps")}>View all <span style={{ width:12, height:12, display:"inline-flex" }}>{Icon.arrowR}</span></button>
          </div>
          <div className="card-body tight">
            {apps.error && <div style={{ padding:16 }}><ErrorAlert error={apps.error} onRetry={apps.reload}/></div>}
            {apps.loading && Array.from({ length: 4 }).map((_, i) => (
              <div className="app-chip" key={i}><Skeleton w={32} h={32} r={8}/><Skeleton w={180} h={14}/><Skeleton w={50} h={12}/></div>
            ))}
            {!apps.loading && topApps.length === 0 && <div style={{ padding:24, color:"var(--text-3)" }}>Everything is up to date.</div>}
            {!apps.loading && topApps.map(a => {
              const outdated = a.outdatedDeviceCount ?? a.outdated ?? 0;
              const total = a.deviceCount ?? 1;
              return (
                <div className="app-chip" key={a.name} onClick={() => onNav("apps")}>
                  <div style={{ display:"flex", alignItems:"center", gap:12, minWidth:0 }}>
                    <div style={{ width:32, height:32, borderRadius:8, background:"var(--bg-sub)", display:"grid", placeItems:"center", flexShrink:0, fontWeight:600, color:"var(--text-2)" }}>
                      {(a.name || "·").split(" ").map(w => w[0]).slice(0,2).join("")}
                    </div>
                    <div style={{ minWidth:0 }}>
                      <div className="name">{a.name} {a.critical && <span className="pill crit" style={{ marginLeft:6 }}>CVE</span>}</div>
                      <div className="pub">{a.publisher} · latest {a.latestVersion ?? a.latest}</div>
                    </div>
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                    <span className="muted mono" style={{ fontSize:12 }}>{outdated}/{total}</span>
                    <div className="bar"><span style={{ width:(outdated/total*100)+"%" }}/></div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div><h3>Active alarms</h3><div className="sub">{alarms.loading ? "…" : (alarms.data || []).length} unresolved</div></div>
            <button className="btn ghost sm" onClick={() => onNav("alarms")}>All <span style={{ width:12, height:12, display:"inline-flex" }}>{Icon.arrowR}</span></button>
          </div>
          <div className="card-body tight">
            {alarms.error && <div style={{ padding:16 }}><ErrorAlert error={alarms.error} onRetry={alarms.reload}/></div>}
            {alarms.loading && <div style={{ padding:16 }}><Skeleton h={40}/></div>}
            {!alarms.loading && recentAlarms.length === 0 && <div style={{ padding:24, color:"var(--text-3)" }}>No active alarms.</div>}
            {!alarms.loading && recentAlarms.map(a => (
              <div key={a.id} style={{ display:"flex", gap:12, padding:"12px 16px", borderBottom:"1px solid var(--line)" }}>
                <div className={"sev-strip " + a.severity}/>
                <div style={{ flex:1, minWidth:0 }}>
                  <strong style={{ fontWeight:500, fontSize:13 }}>{a.message}</strong>
                  <div className="muted" style={{ fontSize:12 }}>
                    {a.deviceId && <span className="mono">{a.deviceId}</span>} · {fmtAgo(a.createdAt)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div><h3>Recent tasks</h3><div className="sub">Last 7 update jobs across the fleet</div></div>
          <button className="btn ghost sm" onClick={() => onNav("tasks")}>All <span style={{ width:12, height:12, display:"inline-flex" }}>{Icon.arrowR}</span></button>
        </div>
        <div className="card-body tight" style={{ overflowX:"auto" }}>
          <table className="tbl">
            <thead><tr><th>App</th><th>Device</th><th>Version</th><th>Node</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>
              {tasks.loading && <SkeletonRows n={5} cols={6}/>}
              {!tasks.loading && recentTasks.length === 0 && <tr><td colSpan={6} style={{ padding:24, color:"var(--text-3)" }}>No tasks yet.</td></tr>}
              {!tasks.loading && recentTasks.map(t => (
                <tr key={t.id} onClick={() => onOpenDevice(t.deviceId)}>
                  <td><strong style={{ fontWeight:500 }}>{taskLabel(t)}</strong></td>
                  <td className="mono">{t.deviceId}</td>
                  <td className="mono muted">{taskVersionLabel(t)}</td>
                  <td className="mono muted">{t.nodeId}</td>
                  <td><StatusPill status={t.status}/></td>
                  <td className="muted">{fmtAgo(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/**
 * Renders the stat UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function Stat({ label, value, sub, tone }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value" style={tone === "crit" ? { color:"var(--crit)" } : {}}>{value}</div>
      {sub && <div className="delta">{sub}</div>}
    </div>
  );
}
/**
 * Renders the metric UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function Metric({ label, value, tone }) {
  const color = tone === "crit" ? "var(--crit)" : tone === "warn" ? "var(--warn)" : "var(--text)";
  return (
    <div>
      <div style={{ fontSize:12, color:"var(--text-3)" }}>{label}</div>
      <div style={{ fontSize:20, fontWeight:600, color, fontVariantNumeric:"tabular-nums" }}>{value}</div>
    </div>
  );
}

// ---------- Devices ----------
/**
 * Renders the devices page UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function DevicesPage({ onOpenDevice, globalSearch = "" }) {
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const activeQ = globalSearch || q;
  const [enrolling, setEnrolling] = useState(false);
  const [manualDevice, setManualDevice] = useState(false);
  const devices = useResource(() => PatchAPI.devices());
  useLiveResource(devices, 2_500);
  const rows = (devices.data || []).filter(d => {
    const platform = d.platform || (/(windows|win)/i.test(d.os || "") ? "windows" : "linux");
    if (!textMatches(activeQ, [d.hostname, formatOs(d.os), d.os, d.site, d.id, d.preferredNodeId, d.group, ...(d.tags || [])])) return false;
    if (filter === "windows" && platform !== "windows") return false;
    if (filter === "linux"   && platform !== "linux") return false;
    if (filter === "online"  && !d.online) return false;
    if (filter === "offline" &&  d.online) return false;
    return true;
  });
  return (
    <div className="page">
      <div className="page-head">
        <div><h2>Devices</h2><p>{devices.loading ? "Loading…" : `${(devices.data || []).length} managed endpoints`}</p></div>
        <div style={{ display:"flex", gap:8 }}>
          <button className="btn"><span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.download}</span>Export CSV</button>
          <button className="btn" onClick={() => setManualDevice(true)}><span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.plus}</span>Manual device</button>
          <button className="btn primary" onClick={() => setEnrolling(true)}><span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.plus}</span>Add clients</button>
        </div>
      </div>
      <div className="card">
        <div className="filterbar">
          {[["all","All"],["windows","Windows"],["linux","Linux"],["online","Online"],["offline","Offline"]].map(([k,l]) => (
            <button key={k} className={"chip " + (filter === k ? "active" : "")} onClick={() => setFilter(k)}>{l}</button>
          ))}
          <div style={{ flex:1 }}/>
          <div className="searchbox" style={{ width:220 }}>
            <span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.search}</span>
            <input placeholder="Filter hostname, OS, site…" value={globalSearch || q} onChange={e => setQ(e.target.value)}/>
          </div>
        </div>
        {devices.error && <div style={{ padding:16 }}><ErrorAlert error={devices.error} onRetry={devices.reload}/></div>}
        <div style={{ overflowX:"auto", maxHeight:"calc(100vh - 280px)", overflowY:"auto" }}>
          <table className="tbl">
            <thead><tr><th>Hostname</th><th>OS</th><th>Site</th><th>Node</th><th className="num">Apps</th><th className="num">Pending</th><th>Last seen</th><th>Status</th></tr></thead>
            <tbody>
              {devices.loading && <SkeletonRows n={8} cols={8}/>}
              {!devices.loading && rows.length === 0 && <tr><td colSpan={8} style={{ padding:24, color:"var(--text-3)" }}>No devices match.</td></tr>}
              {!devices.loading && rows.map(d => {
                const platform = d.platform || (/(windows|win)/i.test(d.os || "") ? "windows" : "linux");
                return (
                  <tr key={d.id} onClick={() => onOpenDevice(d.id)}>
                    <td><div style={{ display:"flex", alignItems:"center", gap:8 }}><OsIcon platform={platform}/><span className="mono">{d.hostname}</span></div></td>
                    <td className="muted">{formatOs(d.os)}</td>
                    <td className="muted">{d.site || "—"}</td>
                    <td className="muted mono">{d.preferredNodeId || "—"}</td>
                    <td className="num mono">{d.installedAppCount ?? "—"}</td>
                    <td className="num mono">{d.pendingTaskCount ?? 0}</td>
                    <td className="muted">{fmtAgo(d.lastSeenAt)}</td>
                    <td><StatusPill status={d.online ? "online" : "offline"}/></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {enrolling && <ClientEnrollmentWizard onClose={() => setEnrolling(false)} onCreated={devices.reload}/>}
      {manualDevice && <ManualDeviceDialog groups={buildDeviceGroupOptions(devices.data || [])} onClose={() => setManualDevice(false)} onCreated={() => { devices.reload(); setManualDevice(false); }}/>}
    </div>
  );
}

/**
 * Renders the device groups page UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function DeviceGroupsPage({ onOpenDevice, globalSearch = "" }) {
  const [selected, setSelected] = useState("all");
  const [q, setQ] = useState("");
  const [manualDevice, setManualDevice] = useState(false);
  const devices = useResource(() => PatchAPI.devices());
  useLiveResource(devices, 2_500);
  const groups = useMemo(() => buildDeviceGroupOptions(devices.data || []), [devices.data]);
  const activeQ = globalSearch || q;
  const visibleGroups = groups.filter(group => textMatches(activeQ, [group.name, ...group.samples, ...group.tags]));
  const selectedGroup = selected === "all" ? null : groups.find(group => group.name === selected);
  const groupDevices = (devices.data || []).filter(device => selected === "all" || (device.group || "ungrouped") === selected);
  return (
    <div className="page">
      <div className="page-head">
        <div><h2>Device Groups</h2><p>{devices.loading ? "Loading…" : `${groups.length} groups across ${(devices.data || []).length} devices`}</p></div>
        <div style={{ display:"flex", gap:8 }}>
          <button className="btn" onClick={() => setManualDevice(true)}><span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.plus}</span>Manual device</button>
          <button className="btn primary" onClick={() => setSelected("all")}>All groups</button>
        </div>
      </div>
      <div className="card">
        <div className="filterbar">
          <div className="searchbox" style={{ width:280 }}>
            <span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.search}</span>
            <input placeholder="Search groups, hostnames, tags…" value={globalSearch || q} onChange={e => setQ(e.target.value)}/>
          </div>
          <div style={{ flex:1 }}/>
          <span className="muted">{visibleGroups.length} visible</span>
        </div>
        {devices.error && <div style={{ padding:16 }}><ErrorAlert error={devices.error} onRetry={devices.reload}/></div>}
        <div className="device-group-board">
          <button className={"device-group-card large " + (selected === "all" ? "active" : "")} onClick={() => setSelected("all")}>
            <strong>All devices</strong>
            <span>{(devices.data || []).length} endpoints</span>
            <em>Fleet-wide scope for rules and inventory views</em>
          </button>
          {visibleGroups.map(group => (
            <button className={"device-group-card large " + (selected === group.name ? "active" : "")} key={group.name} onClick={() => setSelected(group.name)}>
              <strong>{group.name}</strong>
              <span>{group.count} devices · {group.online} online</span>
              <em>{group.windows} Windows · {group.linux} Linux · {group.samples.join(", ") || "no samples"}</em>
            </button>
          ))}
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <div><h3>{selectedGroup ? selectedGroup.name : "All devices"}</h3><div className="sub">{selectedGroup ? `${selectedGroup.count} devices in this group` : "Devices across every group"}</div></div>
        </div>
        <div className="card-body tight" style={{ overflowX:"auto" }}>
          <table className="tbl">
            <thead><tr><th>Hostname</th><th>Group</th><th>OS</th><th>Tags</th><th>Last seen</th><th>Status</th></tr></thead>
            <tbody>
              {devices.loading && <SkeletonRows n={6} cols={6}/>}
              {!devices.loading && groupDevices.length === 0 && <tr><td colSpan={6} style={{ padding:24, color:"var(--text-3)" }}>No devices in this group.</td></tr>}
              {!devices.loading && groupDevices.map(device => {
                const platform = device.platform || (/(windows|win)/i.test(device.os || "") ? "windows" : "linux");
                return (
                  <tr key={device.id} onClick={() => onOpenDevice(device.id)}>
                    <td><div style={{ display:"flex", alignItems:"center", gap:8 }}><OsIcon platform={platform}/><span className="mono">{device.hostname}</span></div></td>
                    <td className="mono muted">{device.group || "ungrouped"}</td>
                    <td className="muted">{formatOs(device.os)}</td>
                    <td className="muted">{(device.tags || []).join(", ") || "—"}</td>
                    <td className="muted">{fmtAgo(device.lastSeenAt)}</td>
                    <td><StatusPill status={device.online ? "online" : "offline"}/></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {manualDevice && <ManualDeviceDialog groups={groups} onClose={() => setManualDevice(false)} onCreated={() => { devices.reload(); setManualDevice(false); }}/>}
    </div>
  );
}

/**
 * Renders the manual device dialog UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function ManualDeviceDialog({ groups, onClose, onCreated }) {
  const [form, setForm] = useState({ tenantId:"default", hostname:"", os:"windows", group:groups[0]?.name || "ungrouped", tags:"", preferredNodeId:"", deviceTrustScore:80, riskScore:"" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  /**
   * Sets the set value.
   *
   * @param key key supplied to the function.
   * @param value Value to read, render, or store.
   */
  const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
  /**
   * Handles the submit operation.
   *
   * @param e Event object emitted by the runtime or UI.
   */
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await PatchAPI.createDevice({
        tenantId: form.tenantId,
        hostname: form.hostname,
        os: form.os,
        group: form.group,
        tags: form.tags,
        preferredNodeId: form.preferredNodeId || undefined,
        deviceTrustScore: Number(form.deviceTrustScore || 80),
        riskScore: form.riskScore === "" ? undefined : Number(form.riskScore),
      });
      onCreated?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <React.Fragment>
      <div className="drawer-backdrop" onClick={onClose}/>
      <div className="output-dialog"><div className="output-dialog-box">
        <div className="output-dialog-head"><h3>Add Manual Device</h3><button className="icon-btn" onClick={onClose}>{Icon.close}</button></div>
        <form onSubmit={submit} style={{ padding:16, display:"flex", flexDirection:"column", gap:14 }}>
          <div className="form-grid">
            <label className="field"><span>Hostname</span><input required value={form.hostname} onChange={e => set("hostname", e.target.value)} placeholder="prod-win-042"/></label>
            <label className="field"><span>Tenant</span><input value={form.tenantId} onChange={e => set("tenantId", e.target.value || "default")}/></label>
            <label className="field"><span>Operating system</span><select value={form.os} onChange={e => set("os", e.target.value)}><option value="windows">Windows</option><option value="linux">Linux</option><option value="macos">macOS</option></select></label>
            <label className="field"><span>Device group</span><GroupSelect groups={groups} value={form.group} onChange={value => set("group", value)}/></label>
            <label className="field"><span>Preferred node</span><input value={form.preferredNodeId} onChange={e => set("preferredNodeId", e.target.value)} placeholder="optional"/></label>
            <label className="field"><span>Trust score</span><input type="number" min="0" max="100" value={form.deviceTrustScore} onChange={e => set("deviceTrustScore", e.target.value)}/></label>
          </div>
          <label className="field"><span>Tags</span><input value={form.tags} onChange={e => set("tags", e.target.value)} placeholder="production, browser-critical"/></label>
          <div className="success-card"><strong>Manual inventory record</strong><span>This creates a visible device record for planning, grouping, and rules. It will not receive executable tasks until it enrolls through a real client/node path.</span></div>
          {error && <ErrorAlert error={error}/>}
          <div style={{ display:"flex", justifyContent:"space-between", gap:8 }}><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !form.hostname.trim()}>{busy ? "Adding..." : "Add device"}</button></div>
        </form>
      </div></div>
    </React.Fragment>
  );
}

/**
 * Renders the client enrollment wizard UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function ClientEnrollmentWizard({ onClose, onCreated }) {
  const browserManagementUrl = `${window.location.protocol}//${window.location.host}`;
  const [step, setStep] = useState("details");
  const [mode, setMode] = useState("single");
  const [form, setForm] = useState({
    tenantId: "default",
    managementUrl: browserManagementUrl,
    trustedDownloadHosts: browserManagementUrl,
    clientName: "",
    maxUses: 10,
    heartbeatSeconds: 60,
    inventoryMinutes: 30,
    nodeProbeTimeoutMilliseconds: 2000,
  });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef(null);
  /**
   * Sets the set value.
   *
   * @param key key supplied to the function.
   * @param value Value to read, render, or store.
   */
  const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
  const steps = [
    ["details", "Details"],
    ["config", "Config"],
    ["install", "Install"],
  ];
  const configText = !result
    ? ""
    : result.oneLineJson || (result.config ? JSON.stringify(result.config) : "");
  const prettyConfig = !result
    ? ""
    : JSON.stringify(result.config, null, 2);

  /**
   * Handles the submit operation.
   *
   * @param e Event object emitted by the runtime or UI.
   */
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null); setNotice("");
    try {
      const created = await PatchAPI.createDeviceEnrollment({
        mode,
        tenantId: form.tenantId.trim(),
        managementUrl: form.managementUrl.trim(),
        trustedDownloadHosts: form.trustedDownloadHosts.split(/\r?\n|,/).map(v => v.trim()).filter(Boolean),
        heartbeatSeconds: Number(form.heartbeatSeconds),
        inventoryMinutes: Number(form.inventoryMinutes),
        nodeProbeTimeoutMilliseconds: Number(form.nodeProbeTimeoutMilliseconds),
        clientName: mode === "single" ? form.clientName.trim() : undefined,
        maxUses: mode === "batch" ? Number(form.maxUses) : 1,
      });
      setResult(created);
      setStep("config");
      setNotice(mode === "batch" ? "Reusable batch config created." : "Client config created.");
      onCreated?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Handles the copy operation.
   *
   * @param text text supplied to the function.
   * @param message message supplied to the function.
   */
  const copy = async (text, message) => {
    const copied = await copyTextToClipboard(text);
    setNotice(copied ? message : "Copy failed. Select the JSON and copy it manually.");
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 2400);
  };

  return (
    <React.Fragment>
      <div className="drawer-backdrop" onClick={onClose}/>
      <div className="wizard-modal" role="dialog" aria-modal="true">
        <div className="wizard-head">
          <div>
            <h3>Add Clients</h3>
            <p>Generate one-line JSON config for one client or a reusable batch install.</p>
          </div>
          <button className="icon-btn" onClick={onClose}><span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.close}</span></button>
        </div>
        <div className="wizard-body">
          <div className="wizard-steps">
            {steps.map(([id, label]) => {
              const done = (id === "details" && result) || (id === "config" && result && step === "install");
              const active = step === id;
              return (
                <button key={id} className={"wizard-step " + (active ? "active " : "") + (done ? "done" : "")} onClick={() => (id === "details" || result) && setStep(id)}>
                  <span>{done ? "OK" : "--"}</span>{label}
                </button>
              );
            })}
          </div>
          <div className="wizard-panel">
            <div className={"notice-slot " + (notice ? "show" : "")} aria-live="polite" aria-hidden={!notice}>{notice}</div>
            {step === "details" && (
              <form onSubmit={submit} style={{ display:"flex", flexDirection:"column", gap:14 }}>
                <div className="segmented">
                  <button type="button" className={mode === "single" ? "active" : ""} onClick={() => setMode("single")}>Single client</button>
                  <button type="button" className={mode === "batch" ? "active" : ""} onClick={() => setMode("batch")}>Batch</button>
                </div>
                <div className="form-grid">
                  <label className="field">
                    <span>Tenant</span>
                    <input required value={form.tenantId} onChange={e => set("tenantId", e.target.value)}/>
                  </label>
                  <label className="field">
                    <span>Management URL</span>
                    <input required value={form.managementUrl} onChange={e => set("managementUrl", e.target.value)}/>
                  </label>
                  <label className="field">
                    <span>Heartbeat seconds</span>
                    <input type="number" min="1" value={form.heartbeatSeconds} onChange={e => set("heartbeatSeconds", e.target.value)}/>
                  </label>
                  <label className="field">
                    <span>Inventory minutes</span>
                    <input type="number" min="1" value={form.inventoryMinutes} onChange={e => set("inventoryMinutes", e.target.value)}/>
                  </label>
                </div>
                <label className="field">
                  <span>Trusted download hosts</span>
                  <textarea value={form.trustedDownloadHosts} onChange={e => set("trustedDownloadHosts", e.target.value)} placeholder="https://packages.example.com"/>
                </label>
                {mode === "single" && (
                  <label className="field">
                    <span>Optional client name override</span>
                    <input value={form.clientName} onChange={e => set("clientName", e.target.value)} placeholder="Leave blank to use device hostname"/>
                  </label>
                )}
                {mode === "batch" && (
                  <React.Fragment>
                    <label className="field">
                      <span>Allowed devices</span>
                      <input type="number" min="1" max="10000" value={form.maxUses} onChange={e => set("maxUses", e.target.value)}/>
                    </label>
                    <div className="success-card">
                      <strong>One reusable config</strong>
                      <span>Install this same config on up to {Number(form.maxUses) || 1} clients. Each device reports its own hostname and generates its own device identity.</span>
                    </div>
                  </React.Fragment>
                )}
                {error && <ErrorAlert error={error}/>}
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:8 }}>
                  <span className="muted">{mode === "batch" ? `One reusable config, limited to ${Number(form.maxUses) || 1} devices.` : "One client config will be generated."}</span>
                  <button className="btn primary" disabled={busy}>{busy ? "Creating..." : "Create config"}</button>
                </div>
              </form>
            )}
            {step === "config" && result && (
              <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
                <div className="alert" style={{ color:"var(--ok)", background:"var(--ok-soft)", borderColor:"transparent" }}>
                  <strong>{mode === "batch" ? `Reusable batch config created for ${result.count} devices.` : "Config created."}</strong>
                  <span className="muted">Use the one-line JSON for client setup.</span>
                </div>
                <textarea className="codebox one-line" readOnly value={configText}/>
                <details>
                  <summary className="muted" style={{ cursor:"pointer" }}>Pretty appsettings.json preview</summary>
                  <textarea className="codebox" readOnly value={prettyConfig}/>
                </details>
                <div style={{ display:"flex", justifyContent:"flex-end", gap:8, flexWrap:"wrap" }}>
                  <button type="button" className="btn" disabled={!configText} onClick={() => copy(configText, "Copied one-line JSON.")}>Copy JSON</button>
                  <button type="button" className="btn" disabled={!prettyConfig} onClick={() => copy(prettyConfig, "Copied pretty config.")}>Copy pretty JSON</button>
                  <button className="btn primary" onClick={() => setStep("install")}>Next</button>
                </div>
              </div>
            )}
            {step === "install" && result && (
              <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
                <div className="success-card">
                  <strong>Ready to install</strong>
                  <span>Start the client in an interactive console, choose JSON setup, and paste the copied JSON. {mode === "batch" ? `Use the same JSON on up to ${result.count} clients; hostnames come from the devices themselves.` : "If no name override was set, the device hostname is used."}</span>
                </div>
                <div style={{ display:"flex", justifyContent:"flex-end", gap:8 }}>
                  <button className="btn" onClick={() => setStep("config")}>Back</button>
                  <button className="btn primary" onClick={onClose}>Done</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </React.Fragment>
  );
}

// ---------- Apps ----------
/**
 * Renders the apps page UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function AppsPage({ globalSearch = "" }) {
  const [q, setQ] = useState("");
  const activeQ = globalSearch || q;
  const apps = useResource(() => PatchAPI.apps());
  useLiveResource(apps, 5_000);
  const [queuing, setQueuing] = useState(new Set());
  const [recentlyQueued, setRecentlyQueued] = useState(new Set());
  const [notice, setNotice] = useState(null);

  /**
   * Updates the all record or state.
   *
   * @param name name supplied to the function.
   */
  const updateAll = async (name) => {
    if (recentlyQueued.has(name)) return;
    setQueuing(prev => new Set([...prev, name]));
    setRecentlyQueued(prev => new Set([...prev, name]));
    setTimeout(() => setRecentlyQueued(prev => { const s = new Set(prev); s.delete(name); return s; }), 30_000);
    try {
      const result = await PatchAPI.updateAllForApp(name);
      const count = Array.isArray(result) ? result.length : (result?.tasks?.length ?? 0);
      const msg = count > 0
        ? `Queued ${count} update task${count !== 1 ? "s" : ""} for ${name}.`
        : `No outdated installs of ${name}.`;
      setNotice({ ok: count > 0, msg });
    } catch (e) {
      setNotice({ ok: false, msg: `Failed to queue updates for ${name}: ${e?.message ?? "unknown error"}` });
    } finally {
      setQueuing(prev => { const s = new Set(prev); s.delete(name); return s; });
      setTimeout(() => setNotice(null), 5000);
    }
  };

  const rows = (apps.data || []).filter(a => !activeQ || `${a.name} ${a.publisher}`.toLowerCase().includes(activeQ.toLowerCase()));
  return (
    <div className="page">
      <div className="page-head">
        <div><h2>Apps</h2><p>Discovered across the fleet · grouped by name</p></div>
        <button className="btn accent">Update all outdated</button>
      </div>
      <div className="card">
        <div className="filterbar">
          <div className="searchbox" style={{ flex:1, maxWidth:320 }}>
            <span style={{ width:14, height:14, display:"inline-flex", alignItems:"center", justifyContent:"center" }}>
              {apps.loading ? <span className="search-spinner"/> : Icon.search}
            </span>
            <input placeholder="Filter apps…" value={globalSearch || q} onChange={e => setQ(e.target.value)}/>
          </div>
        </div>
        {notice && (
          <div className={`toast-inline${notice.ok ? "" : " error"}`} style={{ margin:"12px 16px 0" }}>
            {notice.msg}
          </div>
        )}
        {apps.error && <div style={{ padding:16 }}><ErrorAlert error={apps.error} onRetry={apps.reload}/></div>}
        <div style={{ overflowX:"auto" }}>
          <table className="tbl">
            <thead><tr><th>App</th><th>Publisher</th><th>Latest</th><th>Oldest in fleet</th><th className="num">Devices</th><th className="num">Outdated</th><th>Coverage</th><th></th></tr></thead>
            <tbody>
              {apps.loading && <SkeletonRows n={6} cols={8}/>}
              {!apps.loading && rows.length === 0 && <tr><td colSpan={8} style={{ padding:24, color:"var(--text-3)" }}>No apps tracked yet.</td></tr>}
              {!apps.loading && rows.map(a => {
                const outdated = a.outdatedDeviceCount ?? a.outdated ?? 0;
                const total = a.deviceCount ?? 1;
                const pct = Math.round(((total - outdated) / total) * 100);
                const isQueuing = queuing.has(a.name);
                const isLocked = isQueuing || recentlyQueued.has(a.name);
                return (
                  <tr key={a.name + (a.publisher || "")}>
                    <td>
                      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                        <div style={{ width:28, height:28, borderRadius:6, background:"var(--bg-sub)", display:"grid", placeItems:"center", fontWeight:600, fontSize:11, color:"var(--text-2)" }}>
                          {(a.name || "·").split(" ").map(w => w[0]).slice(0,2).join("")}
                        </div>
                        <strong style={{ fontWeight:500 }}>{a.name}</strong>
                        {a.critical && <span className="pill crit">CVE</span>}
                      </div>
                    </td>
                    <td className="muted">{a.publisher}</td>
                    <td className="mono">{a.latestVersion ?? a.latest}</td>
                    <td className="mono muted">{a.oldestVersion ?? a.oldest ?? "—"}</td>
                    <td className="num mono">{total}</td>
                    <td className="num"><span style={{ color: outdated ? "var(--warn)" : "var(--text-3)", fontFamily:"var(--font-mono)" }}>{outdated}</span></td>
                    <td><div style={{ display:"flex", alignItems:"center", gap:8 }}><div style={{ width:80, height:4, background:"var(--bg-sub)", borderRadius:2, overflow:"hidden" }}><div style={{ width: pct+"%", height:"100%", background: pct >= 90 ? "var(--ok)" : pct >= 70 ? "var(--accent)" : "var(--warn)" }}/></div><span className="mono muted" style={{ fontSize:12 }}>{pct}%</span></div></td>
                    <td>{outdated > 0 && <button className="btn sm" disabled={isLocked} onClick={() => updateAll(a.name)}>{isQueuing ? "Queuing…" : isLocked ? "Queued" : `Update ${outdated}`}</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---------- Packages ----------
function PackagesPage({ globalSearch = "" }) {
  const pkgs = useResource(() => PatchAPI.packages());
  const [storeOpen, setStoreOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const [notice, setNotice] = useState(null);
  useLiveResource(pkgs, 10_000);

  const allRows = pkgs.data || [];
  const centralCount = allRows.filter(p => p.catalogSource === "central").length;
  const customCount = allRows.filter(p => p.catalogSource !== "central").length;

  const rows = allRows.filter(p =>
    textMatches(globalSearch, [p.name, p.publisher, p.version, p.type, p.platform, p.architecture, p.sha256, p.packageId, p.catalogCategory])
  );

  const handleDeployed = (msg) => {
    setNotice(msg);
    setSelected(null);
    pkgs.reload();
    setTimeout(() => setNotice(null), 5000);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div><h2>Package library</h2><p>{customCount} custom packages · {centralCount} available in catalog</p></div>
        <div style={{ display:"flex", gap:8 }}>
          <button className="btn" onClick={() => setWizardOpen(true)}>
            <span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.plus}</span>Add custom
          </button>
          <button className="btn primary" onClick={() => setStoreOpen(true)}>
            <span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.packages}</span>Browse catalog
          </button>
        </div>
      </div>
      <div className="stats">
        <Stat label="Packages" value={pkgs.loading ? "—" : allRows.length} sub="In your library"/>
        <Stat label="Windows" value={pkgs.loading ? "—" : allRows.filter(p => p.platform === "windows").length}/>
        <Stat label="Linux" value={pkgs.loading ? "—" : allRows.filter(p => p.platform === "linux").length}/>
        <Stat label="Custom" value={pkgs.loading ? "—" : customCount} sub="Uploads &amp; vendor URLs"/>
      </div>
      {notice && <div className="toast-inline" style={{ marginBottom:12 }}>{notice}</div>}
      <div className="card">
        {pkgs.error && <div style={{ padding:16 }}><ErrorAlert error={pkgs.error} onRetry={pkgs.reload}/></div>}
        <table className="tbl">
          <thead><tr><th>Name</th><th>Version</th><th>Type</th><th>Platform</th><th>Signature</th><th>Added</th></tr></thead>
          <tbody>
            {pkgs.loading && <SkeletonRows n={5} cols={6}/>}
            {!pkgs.loading && rows.length === 0 && (
              <tr><td colSpan={6} style={{ padding:32, color:"var(--text-3)", textAlign:"center" }}>
                No packages in your library yet — use <strong>Add custom</strong> for MSI/EXE/APT or <strong>Browse catalog</strong> to add winget packages.
              </td></tr>
            )}
            {!pkgs.loading && rows.map(p => (
              <tr key={p.id || p.sha256} onClick={() => setSelected(p)} style={{ cursor:"pointer" }}>
                <td>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <div className="pkg-avatar">{(p.name || "?")[0].toUpperCase()}</div>
                    <div>
                      <strong style={{ fontWeight:500 }}>{p.name}</strong>
                      <div className="muted" style={{ fontSize:12 }}>{p.publisher}{p.catalogCategory ? ` · ${p.catalogCategory}` : ""}</div>
                    </div>
                  </div>
                </td>
                <td className="mono">{p.version}</td>
                <td><span className="pill">{p.type}</span></td>
                <td className="muted">{p.platform}{p.architecture && p.architecture !== "any" ? " · " + p.architecture : ""}</td>
                <td><StatusPill status={p.signatureStatus}/></td>
                <td className="muted">{fmtAgo(p.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected && <PackageDetailPanel pkg={selected} onClose={() => setSelected(null)} onDeployed={handleDeployed}/>}
      {wizardOpen && <PackageWizard onClose={() => setWizardOpen(false)} onCreated={(pkg) => { setWizardOpen(false); setNotice(`Package ${pkg.name} added.`); pkgs.reload(); setTimeout(() => setNotice(null), 5000); }}/>}
      {storeOpen && <PackageStore onClose={() => setStoreOpen(false)} onDeployed={(msg) => { setStoreOpen(false); setNotice(msg); pkgs.reload(); setTimeout(() => setNotice(null), 5000); }}/>}
    </div>
  );
}

function PackageWizard({ onClose, onCreated }) {
  const [step, setStep] = useState(0);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    type: "winget",
    platform: "windows",
    architecture: "any",
    name: "",
    publisher: "",
    version: "latest",
    packageId: "",
    packageScope: "system",
    sourceUrl: "",
    sha256: "",
    installArgs: "",
    signatureStatus: "unknown",
    catalogCategory: "Custom",
  });
  const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
  const chooseType = (type) => {
    const platform = ["apt","snap","flatpak"].includes(type) ? "linux" : "windows";
    setForm(prev => ({
      ...prev,
      type,
      platform,
      packageScope: type === "scoop" ? "global" : "system",
      installArgs: type === "msi" ? "/qn /norestart" : type === "exe" ? "/quiet /norestart" : "",
      version: prev.version || "latest",
    }));
    setStep(1);
  };
  const managerType = ["winget","chocolatey","scoop","apt","snap","flatpak"].includes(form.type);
  const downloadableType = ["msi","exe"].includes(form.type);
  const canContinue = step === 0 || (form.name.trim() && form.publisher.trim() && form.version.trim() && (!managerType || form.packageId.trim()) && (!downloadableType || file || (form.sourceUrl.trim() && form.sha256.trim())));
  const save = async () => {
    setBusy(true); setError("");
    try {
      const payload = {
        ...form,
        packageManager: form.type,
        applicability: { appName: form.name, manufacturer: form.publisher },
      };
      if (file) {
        payload.fileName = file.name;
        payload.fileBase64 = await readFileBase64(file);
      }
      if (!payload.installArgs && form.type === "msi") payload.installArgs = "/qn /norestart";
      if (!payload.installArgs && form.type === "exe") payload.installArgs = "/quiet /norestart";
      const created = await PatchAPI.createPackage(payload);
      onCreated?.(created);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };
  const steps = ["Type", "Details", "Review"];
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box package-wizard" onClick={e => e.stopPropagation()}>
        <div className="wizard-top">
          <div><h3>Add package</h3><p>Custom artifacts are stored by management, cached by backend nodes, and executed only through signed tasks.</p></div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">{Icon.close}</button>
        </div>
        <div className="sso-wizard-steps package-wizard-steps">
          {steps.map((label, i) => (
            <React.Fragment key={label}>
              <div className={"sso-wizard-step-dot " + (step === i ? "active" : step > i ? "done" : "")}>
                <span className="sso-wizard-dot-num">{step > i ? Icon.check : i + 1}</span>
                <span className="sso-wizard-dot-label">{label}</span>
              </div>
              {i < steps.length - 1 && <div className={"sso-wizard-connector " + (step > i ? "filled" : "")}/>}
            </React.Fragment>
          ))}
        </div>
        {step === 0 && (
          <div className="package-type-grid">
            {[
              ["winget","winget",Icon.windows,"Windows package manager"],
              ["msi","MSI",Icon.packages,"Uploaded or vendor-hosted installer"],
              ["exe","EXE",Icon.play,"Installer with safe silent parameters"],
              ["apt","APT",Icon.linux,"Ubuntu/Debian repo package"],
              ["snap","Snap",Icon.linux,"Linux Snap package"],
              ["flatpak","Flatpak",Icon.linux,"Linux desktop package"],
              ["chocolatey","Chocolatey",Icon.packages,"Chocolatey managed package"],
              ["scoop","Scoop",Icon.download,"Scoop managed package"],
            ].map(([id, label, icon, desc]) => (
              <button key={id} className={"package-type-card " + (form.type === id ? "selected" : "")} onClick={() => chooseType(id)}>
                <span>{icon}</span><strong>{label}</strong><em>{desc}</em>
              </button>
            ))}
          </div>
        )}
        {step === 1 && (
          <div className="package-wizard-body">
            <div className="form-grid">
              <label className="field"><span>Name</span><input value={form.name} onChange={e => set("name", e.target.value)} placeholder="Google Chrome"/></label>
              <label className="field"><span>Publisher</span><input value={form.publisher} onChange={e => set("publisher", e.target.value)} placeholder="Google"/></label>
              <label className="field"><span>Version</span><input value={form.version} onChange={e => set("version", e.target.value)} placeholder="latest"/></label>
              <label className="field"><span>Architecture</span><select value={form.architecture} onChange={e => set("architecture", e.target.value)}><option value="any">Any</option><option value="x64">x64</option><option value="x86">x86</option><option value="arm64">arm64</option></select></label>
            </div>
            {managerType && (
              <div className="form-grid" style={{ marginTop:14 }}>
                <label className="field"><span>Package ID</span><input value={form.packageId} onChange={e => set("packageId", e.target.value)} placeholder={form.type === "flatpak" ? "org.example.App" : ["apt","snap"].includes(form.type) ? "nginx" : "Google.Chrome"}/></label>
                <label className="field"><span>Scope</span><select value={form.packageScope} onChange={e => set("packageScope", e.target.value)}><option value="system">System</option><option value="global">Global</option><option value="user">User</option></select></label>
              </div>
            )}
            {downloadableType && (
              <div className="package-source-box">
                <label className="field"><span>Upload installer</span><input type="file" accept={form.type === "msi" ? ".msi" : ".exe"} onChange={e => setFile(e.target.files?.[0] || null)}/></label>
                <div className="sub">or use a vendor URL with a pinned SHA-256</div>
                <div className="form-grid">
                  <label className="field"><span>Source URL</span><input value={form.sourceUrl} onChange={e => set("sourceUrl", e.target.value)} placeholder="https://vendor.example/app.msi"/></label>
                  <label className="field"><span>SHA-256</span><input value={form.sha256} onChange={e => set("sha256", e.target.value)} placeholder="64 hex characters"/></label>
                </div>
                <label className="field" style={{ marginTop:14 }}><span>Install parameters</span><input value={form.installArgs} onChange={e => set("installArgs", e.target.value)} placeholder={form.type === "exe" ? "/quiet /norestart" : "/qn /norestart"}/></label>
              </div>
            )}
          </div>
        )}
        {step === 2 && (
          <div className="package-review">
            <div><span>Name</span><strong>{form.name}</strong></div>
            <div><span>Type</span><strong>{form.type} · {form.platform}</strong></div>
            <div><span>Source</span><strong>{managerType ? form.packageId : file ? file.name : form.sourceUrl}</strong></div>
            <div><span>Execution</span><strong>{downloadableType ? "Backend-node cache proxy" : "Native package manager"}</strong></div>
          </div>
        )}
        {error && <div className="banner error">{error}</div>}
        <div className="modal-actions">
          <button className="btn ghost" onClick={step === 0 ? onClose : () => setStep(step - 1)} disabled={busy}>{step === 0 ? "Cancel" : "Back"}</button>
          {step < 2
            ? <button className="btn primary" disabled={!canContinue} onClick={() => setStep(step + 1)}>Next</button>
            : <button className="btn primary" disabled={busy || !canContinue} onClick={save}>{busy ? "Saving..." : "Create package"}</button>}
        </div>
      </div>
    </div>
  );
}

function PackageDetailPanel({ pkg, onClose, onDeployed }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const deploy = async () => {
    setBusy(true); setError("");
    try {
      const result = await PatchAPI.deployPackageAll(pkg.id);
      const count = result?.tasks?.length ?? (Array.isArray(result) ? result.length : 0);
      const skipped = result?.skippedDeviceCount ?? 0;
      onDeployed(`${count} deployment task${count === 1 ? "" : "s"} queued${skipped ? `; ${skipped} skipped` : ""}.`);
    } catch (err) {
      setError(err?.message || String(err));
      setBusy(false);
    }
  };

  const rows = [
    ["Version", pkg.version],
    ["Type", pkg.type],
    ["Platform", pkg.platform + (pkg.architecture && pkg.architecture !== "any" ? " · " + pkg.architecture : "")],
    ["Category", pkg.catalogCategory || "—"],
    ["Source", pkg.catalogSource === "central" ? "Central catalog" : "Custom"],
    ["Signature", pkg.signatureStatus],
    pkg.packageId ? ["Package ID", pkg.packageId] : null,
    pkg.sha256 ? ["SHA-256", pkg.sha256.slice(0, 16) + "…"] : null,
    pkg.sourceUrl ? ["Source URL", pkg.sourceUrl] : null,
    ["Added", fmtAgo(pkg.createdAt)],
  ].filter(Boolean);

  return (
    <div className="detail-panel-overlay" onClick={onClose}>
      <div className="detail-panel" onClick={e => e.stopPropagation()}>
        <div className="detail-panel-head">
          <div style={{ display:"flex", alignItems:"center", gap:12, minWidth:0 }}>
            <div className="pkg-avatar lg">{(pkg.name || "?")[0].toUpperCase()}</div>
            <div style={{ minWidth:0 }}>
              <h3 style={{ margin:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{pkg.name}</h3>
              <div className="muted" style={{ fontSize:13 }}>{pkg.publisher}</div>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">{Icon.close}</button>
        </div>
        <div className="detail-panel-body">
          <div className="pkg-detail-grid">
            {rows.map(([label, value]) => (
              <div key={label} className="pkg-detail-row">
                <span className="pkg-detail-label">{label}</span>
                <span className="pkg-detail-value">{value}</span>
              </div>
            ))}
          </div>
          {pkg.installArgs && (
            <div style={{ marginTop:16 }}>
              <div className="pkg-detail-label" style={{ marginBottom:6 }}>Install args</div>
              <code style={{ display:"block", background:"var(--bg-sub)", border:"1px solid var(--line)", borderRadius:"var(--r-sm)", padding:"8px 10px", fontSize:12, overflowX:"auto" }}>{pkg.installArgs}</code>
            </div>
          )}
          {error && <div className="banner error" style={{ marginTop:16 }}>{error}</div>}
        </div>
        <div className="detail-panel-foot">
          <button className="btn primary" style={{ flex:1 }} onClick={deploy} disabled={busy}>
            {busy ? "Deploying…" : "Deploy to all matching devices"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PackageStore({ onClose, onDeployed }) {
  const catalogRes = useResource(() => PatchAPI.packageCatalog());
  const [platform, setPlatform] = useState("all");
  const [manager, setManager] = useState("all");
  const [category, setCategory] = useState("All");
  const [search, setSearch] = useState("");
  const [deploying, setDeploying] = useState(null);
  const [notice, setNotice] = useState(null);

  const catalog = catalogRes.data || [];
  const platforms = ["all", ...Array.from(new Set(catalog.map(p => p.platform).filter(Boolean))).sort()];
  const managers = ["all", ...Array.from(new Set(catalog.filter(p => platform === "all" || p.platform === platform).map(p => p.packageManager).filter(Boolean))).sort()];
  const scopedCatalog = catalog.filter(p =>
    (platform === "all" || p.platform === platform) &&
    (manager === "all" || p.packageManager === manager)
  );
  const categories = ["All", ...Array.from(new Set(scopedCatalog.map(p => p.category).filter(Boolean))).sort()];
  const catCount = (cat) => cat === "All" ? scopedCatalog.length : scopedCatalog.filter(p => p.category === cat).length;

  const filtered = scopedCatalog.filter(p => {
    if (category !== "All" && p.category !== category) return false;
    if (search) return textMatches(search, [p.name, p.publisher, p.packageId, p.category, p.platform, p.packageManager]);
    return true;
  });

  const deploy = async (entry) => {
    setDeploying(`${entry.platform}:${entry.packageManager}:${entry.packageId}`);
    try {
      const artifact = await PatchAPI.createPackage({
        name: entry.name,
        publisher: entry.publisher,
        version: "latest",
        type: entry.packageManager,
        platform: entry.platform,
        architecture: "any",
        packageId: entry.packageId,
        packageScope: "system",
        catalogCategory: entry.category,
        installArgs: "",
        signatureStatus: "unknown",
      });
      const result = await PatchAPI.deployPackageAll(artifact.id);
      const count = result?.tasks?.length ?? (Array.isArray(result) ? result.length : 0);
      onDeployed?.(`${entry.name} added to library and ${count} deployment task${count === 1 ? "" : "s"} queued.`);
    } catch (err) {
      setNotice(`Error: ${err?.message || String(err)}`);
    } finally {
      setDeploying(null);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="pkg-store-modal" onClick={e => e.stopPropagation()}>
        <div className="pkg-store-header">
          <div>
            <h3 style={{ margin:"0 0 2px" }}>Package Catalog</h3>
            <p style={{ margin:0, fontSize:13, color:"var(--text-3)" }}>{catalog.length} packages · {categories.length - 1} categories · Windows and Linux</p>
          </div>
          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            <input
              className="pkg-store-search"
              placeholder="Search packages…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              autoFocus
            />
            <button className="icon-btn" onClick={onClose} aria-label="Close">{Icon.close}</button>
          </div>
        </div>
        {notice && <div className="toast-inline" style={{ margin:"8px 20px 0" }}>{notice}</div>}
        <div className="pkg-store-layout">
          <nav className="pkg-store-sidebar">
            <div className="pkg-store-filter-block">
              <span>Platform</span>
              {platforms.map(value => (
                <button
                  key={value}
                  className={"pkg-store-filter-btn " + (platform === value ? "active" : "")}
                  onClick={() => { setPlatform(value); setManager("all"); setCategory("All"); }}
                >
                  {value === "all" ? "All platforms" : value}
                </button>
              ))}
            </div>
            <div className="pkg-store-filter-block">
              <span>Manager</span>
              {managers.map(value => (
                <button
                  key={value}
                  className={"pkg-store-filter-btn " + (manager === value ? "active" : "")}
                  onClick={() => { setManager(value); setCategory("All"); }}
                >
                  {value === "all" ? "All managers" : value}
                </button>
              ))}
            </div>
            {categories.map(cat => (
              <button
                key={cat}
                className={"pkg-store-cat-btn " + (category === cat ? "active" : "")}
                onClick={() => setCategory(cat)}
              >
                <span>{cat}</span>
                <span className="pkg-store-cat-count">{catCount(cat)}</span>
              </button>
            ))}
          </nav>
          <div className="pkg-store-content">
            {catalogRes.loading && <div style={{ padding:"48px 0", color:"var(--text-3)", textAlign:"center" }}>Loading catalog…</div>}
            {!catalogRes.loading && filtered.length === 0 && (
              <div style={{ padding:"48px 0", color:"var(--text-3)", textAlign:"center" }}>No packages match your search.</div>
            )}
            <div className="pkg-catalog-grid">
              {filtered.map(p => (
                <div key={`${p.platform}:${p.packageManager}:${p.packageId}`} className="pkg-catalog-card">
                  <div className="pkg-catalog-card-top">
                    <div className="pkg-avatar">{(p.name || "?")[0].toUpperCase()}</div>
                    <span className="pill ok">{p.packageManager}</span>
                  </div>
                  <div className="pkg-catalog-card-name">{p.name}</div>
                  <div className="pkg-catalog-card-pub">{p.publisher}</div>
                  <div className="pkg-catalog-card-meta">{p.platform} · {p.category}</div>
                  <div className="pkg-catalog-card-foot">
                    <button
                      className="btn sm primary"
                      onClick={() => deploy(p)}
                      disabled={deploying === `${p.platform}:${p.packageManager}:${p.packageId}`}
                    >
                      {deploying === `${p.platform}:${p.packageManager}:${p.packageId}` ? "…" : "Deploy"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",", 2)[1] || "");
    reader.onerror = () => reject(reader.error || new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

// ---------- Rules ----------
/**
 * Renders the rules page UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function RulesPage({ globalSearch = "" }) {
  const [editing, setEditing] = useState(null);
  const [testing, setTesting] = useState(null);
  const rules = useResource(() => PatchAPI.rules());
  const audit = useResource(() => PatchAPI.ruleAudit());
  useLiveResource(rules, 10_000);
  useLiveResource(audit, 10_000);
  /**
   * Changes the toggle state.
   *
   * @param r r supplied to the function.
   */
  const toggle = async (r) => { try { await PatchAPI.toggleRule(r.id, !r.enabled); } finally { rules.reload(); audit.reload(true); } };
  const rows = (rules.data || []).filter(r => textMatches(globalSearch, [r.name, r.description, r.trigger?.type, r.trigger?.eventType, JSON.stringify(r.conditionGroup), JSON.stringify(r.actions), r.enabled ? "enabled" : "disabled"]));
  return (
    <div className="page">
      <div className="page-head">
        <div><h2>Rules Engine</h2><p>Policy automation that creates visible, scanned task drafts through the signed pipeline</p></div>
        <button className="btn primary" onClick={() => setEditing(defaultRule())}><span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.plus}</span>New rule</button>
      </div>
      <div className="card">
        {rules.error && <div style={{ padding:16 }}><ErrorAlert error={rules.error} onRetry={rules.reload}/></div>}
        <table className="tbl">
          <thead><tr><th>Name</th><th>Trigger</th><th>Conditions</th><th>Actions</th><th>Last run</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {rules.loading && <SkeletonRows n={4} cols={7}/>}
            {!rules.loading && rows.length === 0 && <tr><td colSpan={7} style={{ padding:24, color:"var(--text-3)" }}>No rules configured.</td></tr>}
            {!rules.loading && rows.map(r => (
              <tr key={r.id}>
                <td><strong style={{ fontWeight:500 }}>{r.name}</strong><div className="muted" style={{ fontSize:12 }}>{r.description || `Priority ${r.priority ?? 100}`}</div></td>
                <td className="mono muted">{r.trigger?.type || "manual"}{r.trigger?.eventType ? ` · ${r.trigger.eventType}` : ""}</td>
                <td className="mono muted">{conditionSummary(r.conditionGroup || { combinator:"AND", conditions:r.conditions || [] })}</td>
                <td className="mono muted">{(r.actions || []).map(actionSummary).join(", ")}</td>
                <td className="muted">{fmtAgo(r.lastRunAt)}</td>
                <td>
                  <button onClick={(e) => { e.stopPropagation(); toggle(r); }} style={{ border:0, padding:0, background:"transparent", cursor:"pointer" }}>
                    <span className={"pill " + (r.enabled ? "ok" : "")}><span className="dot"/>{r.enabled ? "Enabled" : "Disabled"}</span>
                  </button>
                </td>
                <td style={{ whiteSpace:"nowrap" }}>
                  <button className="btn sm ghost" onClick={() => setTesting(r)}>Test</button>
                  <button className="btn sm" onClick={() => setEditing(r)}>Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <div className="card-head"><div><h3>Rule audit</h3><div className="sub">Recent triggered, executed, failed, rate-limited, and conflict records</div></div></div>
        <div className="card-body tight" style={{ overflowX:"auto" }}>
          <table className="tbl">
            <thead><tr><th>Rule</th><th>Device</th><th>Result</th><th>Risk</th><th>Tasks</th><th>Why</th><th>Time</th></tr></thead>
            <tbody>
              {audit.loading && <SkeletonRows n={4} cols={7}/>}
              {!audit.loading && (audit.data || []).slice(0, 8).map(e => (
                <tr key={e.id}>
                  <td className="mono">{e.ruleId}</td>
                  <td className="mono muted">{e.deviceId || "—"}</td>
                  <td><span className={"pill " + (e.status === "failed" ? "crit" : e.matched ? "ok" : "")}>{e.status}</span></td>
                  <td className="mono">{e.riskScore}</td>
                  <td className="mono muted">{(e.taskIds || []).length}</td>
                  <td className="muted" style={{ maxWidth:420, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{(e.conflicts || []).concat(e.reasons || []).join(" · ")}</td>
                  <td className="muted">{fmtAgo(e.triggeredAt)}</td>
                </tr>
              ))}
              {!audit.loading && (audit.data || []).length === 0 && <tr><td colSpan={7} style={{ padding:24, color:"var(--text-3)" }}>No rule executions yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {editing && <RuleWizard rule={editing} onClose={() => setEditing(null)} onCreated={() => { rules.reload(); audit.reload(true); }}/>}
      {testing && <RuleTester rule={testing} onClose={() => setTesting(null)} onExecuted={() => { rules.reload(); audit.reload(true); }}/>}
    </div>
  );
}

/**
 * Renders the rule wizard UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function RuleWizard({ rule, onClose, onCreated }) {
  const [step, setStep] = useState(() => rule?.id ? "trigger" : "templates");
  const [form, setForm] = useState(() => normalizeRuleForm(rule));
  const templates = useResource(() => PatchAPI.ruleTemplates(form.tenantId || "default").catch(() => DASHBOARD_RULE_TEMPLATES), [form.tenantId]);
  const [templateCategory, setTemplateCategory] = useState("Recommended");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateInputs, setTemplateInputs] = useState({});
  const [templatePreview, setTemplatePreview] = useState(null);
  const [templateImportOpen, setTemplateImportOpen] = useState(false);
  const [templateImportText, setTemplateImportText] = useState("");
  const [templateImportNotice, setTemplateImportNotice] = useState(null);
  const devices = useResource(() => PatchAPI.devices(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  /**
   * Sets the set value.
   *
   * @param key key supplied to the function.
   * @param value Value to read, render, or store.
   */
  const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
  const templateRows = templates.data || [];
  const deviceGroups = useMemo(() => buildDeviceGroupOptions(devices.data || []), [devices.data]);
  const templateCategories = ["Recommended","Patch Automation","Security / Inventory","Failure Handling","Compliance","Notifications"];
  const selectedTemplate = templateRows.find(t => t.id === selectedTemplateId) || templateRows.find(t => t.category === templateCategory) || templateRows[0];
  useEffect(() => {
    if (!selectedTemplateId && selectedTemplate?.id) setSelectedTemplateId(selectedTemplate.id);
  }, [selectedTemplateId, selectedTemplate?.id]);
  /**
   * Manages use template state for the UI.
   */
  const useTemplate = async () => {
    if (!selectedTemplate) return;
    setBusy(true); setError(null);
    try {
      const inputs = withTemplateDefaults(selectedTemplate, templateInputs, form.tenantId);
      const result = await PatchAPI.createRuleDraftFromTemplate(selectedTemplate.id, inputs).catch(() => clientRuleDraftFromTemplate(selectedTemplate, inputs, form.tenantId || "default"));
      setForm(normalizeRuleForm(result.draftRule));
      setTemplatePreview(result.preview);
      setStep("preview");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  /**
   * Handles the import template config operation.
   */
  const importTemplateConfig = async () => {
    const configString = templateImportText.trim();
    if (!configString) {
      setTemplateImportNotice({ ok:false, text:"Paste a template config string first." });
      return;
    }
    setBusy(true); setError(null); setTemplateImportNotice(null);
    try {
      const imported = await PatchAPI.importRuleTemplateConfig({ configString, tenantId: form.tenantId || "default" });
      setTemplateImportText("");
      setTemplateImportNotice({ ok:true, text:`Imported ${imported.name}.` });
      setTemplateCategory(imported.category || "Recommended");
      setSelectedTemplateId(imported.id);
      await templates.reload(false);
    } catch (err) {
      setTemplateImportNotice({ ok:false, text:err?.message || String(err) });
    } finally {
      setBusy(false);
    }
  };
  /**
   * Saves save data.
   *
   * @param e Event object emitted by the runtime or UI.
   */
  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const payload = rulePayload(form);
      if (form.id) await PatchAPI.updateRule(form.id, payload);
      else await PatchAPI.createRule(payload);
      onCreated?.();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const tabs = [...(form.id ? [] : [["templates","Templates"]]), ["trigger","Trigger"],["conditions","Conditions"],["actions","Actions"],["schedule","Schedule"],["preview","Preview"]];
  return (
    <React.Fragment>
      <div className="drawer-backdrop" onClick={onClose}/>
      <div className="wizard-modal" role="dialog" aria-modal="true">
        <div className="wizard-head">
          <div><h3>{form.id ? "Edit Rule" : "New Rule"}</h3><p>Rules create auditable task drafts; clients still only receive signed tasks.</p></div>
          <button className="icon-btn" onClick={onClose}><span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.close}</span></button>
        </div>
        <form className="wizard-body" onSubmit={save}>
          <div className="wizard-steps">
            {tabs.map(([id,label]) => <button type="button" key={id} className={"wizard-step " + (step === id ? "active" : "")} onClick={() => setStep(id)}><span>{id === step ? ">>" : "--"}</span>{label}</button>)}
          </div>
          <div className="wizard-panel" style={{ display:"flex", flexDirection:"column", gap:14 }}>
            {step === "templates" && (
              <React.Fragment>
                <div className="template-market-head">
                  <div>
                    <h4>Start from template</h4>
                    <p>Pick a safe blueprint, fill the missing inputs, then review the disabled draft before saving.</p>
                  </div>
                  <div className="template-head-actions">
                    <button type="button" className="btn" onClick={() => setTemplateImportOpen(open => !open)}>Import config</button>
                    <button type="button" className="btn" onClick={() => setStep("trigger")}>Blank rule</button>
                  </div>
                </div>
                {templateImportOpen && (
                  <div className="template-import-panel">
                    <label className="field">
                      <span>Template config</span>
                      <textarea
                        className="mono"
                        value={templateImportText}
                        onChange={e => setTemplateImportText(e.target.value)}
                        placeholder="Paste copied 1Patch template JSON"
                      />
                    </label>
                    <div className="template-import-actions">
                      <button type="button" className="btn primary" disabled={busy} onClick={importTemplateConfig}>{busy ? "Importing..." : "Import template"}</button>
                      <button type="button" className="btn" onClick={() => { setTemplateImportText(""); setTemplateImportNotice(null); }}>Clear</button>
                    </div>
                    {templateImportNotice && <div className={`template-import-notice ${templateImportNotice.ok ? "ok" : "error"}`}>{templateImportNotice.text}</div>}
                  </div>
                )}
                {templates.error && <ErrorAlert error={templates.error} onRetry={templates.reload}/>}
                <div className="template-category-row">
                  {templateCategories.map(category => (
                    <button type="button" key={category} className={category === templateCategory ? "active" : ""} onClick={() => { setTemplateCategory(category); const first = templateRows.find(t => t.category === category); if (first) setSelectedTemplateId(first.id); }}>
                      {category}
                    </button>
                  ))}
                </div>
                <div className="template-market-grid">
                  {templates.loading && Array.from({ length:4 }).map((_, i) => <div className="template-market-card" key={i}><div className="skel" style={{ height:16, width:"70%" }}/><div className="skel" style={{ height:42 }}/></div>)}
                  {!templates.loading && templateRows.filter(t => t.category === templateCategory).map(template => (
                    <button type="button" key={template.id} className={"template-market-card " + (selectedTemplate?.id === template.id ? "selected" : "")} onClick={() => setSelectedTemplateId(template.id)}>
                      <div className="template-market-card-top">
                        <strong>{template.name}</strong>
                        <span className={"risk-badge " + template.riskLevel}>{template.riskLevel}</span>
                      </div>
                      <p>{template.description}</p>
                      <div className="template-badges">
                        <span>{template.recommendedSecurityMode}</span>
                        <span>{template.trigger?.type || "manual"}</span>
                        <span>{(template.requiredInputs || []).length || "no"} inputs</span>
                      </div>
                      <div className="template-does">
                        {(template.explanation || []).slice(0, 3).map(item => <em key={item}>{item}</em>)}
                      </div>
                    </button>
                  ))}
                </div>
                {selectedTemplate && (
                  <div className="template-detail-panel">
                    <div className="template-detail-main">
                      <div className="template-section-title">What this template does</div>
                      <ul className="template-check-list">{(selectedTemplate.explanation || []).map(item => <li key={item}>{item}</li>)}</ul>
                      <div className="template-section-title">Safety defaults</div>
                      <ul className="template-check-list">{(selectedTemplate.safety || []).map(item => <li key={item}>{item}</li>)}</ul>
                    </div>
                    <div className="template-input-panel">
                      <div className="template-section-title">Required inputs</div>
                      {(selectedTemplate.requiredInputs || []).length === 0 && <div className="muted">No missing inputs. You can generate the draft now.</div>}
                      {(selectedTemplate.requiredInputs || []).map(input => (
                        input.type === "device_group" ? (
                          <DeviceGroupPicker
                            key={input.id}
                            input={input}
                            groups={deviceGroups}
                            loading={devices.loading}
                            value={templateInputs[input.id] ?? input.defaultValue ?? ""}
                            onChange={value => setTemplateInputs(prev => ({ ...prev, [input.id]: value }))}
                          />
                        ) : input.type === "maintenance_window" ? (
                          <MaintenanceWindowPicker
                            key={input.id}
                            input={input}
                            value={templateInputs[input.id] ?? input.defaultValue}
                            onChange={value => setTemplateInputs(prev => ({ ...prev, [input.id]: value }))}
                          />
                        ) : (
                          <label className="field" key={input.id}>
                            <span>{input.label}</span>
                            <input
                              type={input.type === "number" ? "number" : "text"}
                              value={templateInputDisplay(templateInputs[input.id] ?? input.defaultValue ?? "")}
                              onChange={e => setTemplateInputs(prev => ({ ...prev, [input.id]: parseTemplateInput(input, e.target.value) }))}
                              placeholder={input.description}
                            />
                          </label>
                        )
                      ))}
                      <button type="button" className="btn primary" disabled={busy} onClick={useTemplate}>{busy ? "Generating..." : "Use template"}</button>
                    </div>
                  </div>
                )}
                {error && <ErrorAlert error={error}/>}
              </React.Fragment>
            )}
            {step === "trigger" && (
              <React.Fragment>
                <div className="form-grid">
                  <label className="field"><span>Name</span><input required value={form.name} onChange={e => set("name", e.target.value)} placeholder="Auto patch Chrome weekly"/></label>
                  <label className="field"><span>Tenant</span><input value={form.tenantId} onChange={e => set("tenantId", e.target.value || "default")}/></label>
                  <label className="field"><span>Priority</span><input type="number" value={form.priority} onChange={e => set("priority", Number(e.target.value || 100))}/></label>
                  <label className="field"><span>Status</span><select value={form.enabled ? "enabled" : "disabled"} onChange={e => set("enabled", e.target.value === "enabled")}><option value="disabled">Disabled</option><option value="enabled">Enabled</option></select></label>
                </div>
                <label className="field"><span>Description</span><input value={form.description} onChange={e => set("description", e.target.value)} placeholder="Weekly low-risk browser patch policy"/></label>
                <div className="form-grid">
                  <label className="field"><span>Trigger</span><select value={form.triggerType} onChange={e => set("triggerType", e.target.value)}><option value="manual">Manual</option><option value="schedule">Schedule</option><option value="event">Event</option></select></label>
                  {form.triggerType === "event" && <label className="field"><span>Event</span><select value={form.eventType} onChange={e => set("eventType", e.target.value)}><option value="device.inventory.updated">device.inventory.updated</option><option value="task.failed">task.failed</option><option value="vulnerability.detected">vulnerability.detected</option><option value="package.high_priority.detected">package.high_priority.detected</option><option value="task.security_scan.completed">task.security_scan.completed</option><option value="rule.task_candidate.created">rule.task_candidate.created</option></select></label>}
                  {form.triggerType === "schedule" && <label className="field"><span>Cron</span><input value={form.cron} onChange={e => set("cron", e.target.value)} placeholder="0 2 * * 0"/></label>}
                </div>
              </React.Fragment>
            )}
            {step === "conditions" && (
              <React.Fragment>
                <div className="segmented">
                  <button type="button" className={form.combinator === "AND" ? "active" : ""} onClick={() => set("combinator", "AND")}>AND</button>
                  <button type="button" className={form.combinator === "OR" ? "active" : ""} onClick={() => set("combinator", "OR")}>OR</button>
                </div>
                {form.conditions.map((condition, index) => (
                  <div className="form-grid" key={index}>
                    <label className="field"><span>Field</span><select value={condition.field} onChange={e => updateCondition(setForm, index, { field:e.target.value })}>{conditionFields.map(f => <option key={f} value={f}>{f}</option>)}</select></label>
                    <label className="field"><span>Operator</span><select value={condition.operator} onChange={e => updateCondition(setForm, index, { operator:e.target.value })}>{conditionOperators.map(o => <option key={o} value={o}>{o}</option>)}</select></label>
                    <label className="field"><span>Value</span><input value={String(condition.value)} onChange={e => updateCondition(setForm, index, { value: parseConditionValue(e.target.value) })}/></label>
                    <button type="button" className="btn sm" onClick={() => removeCondition(setForm, index)}>Remove</button>
                  </div>
                ))}
                <button type="button" className="btn" onClick={() => set("conditions", [...form.conditions, { field:"device.os", operator:"eq", value:"windows" }])}><span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.plus}</span>Add condition</button>
              </React.Fragment>
            )}
            {step === "actions" && (
              <React.Fragment>
                <div className="form-grid">
                  <label className="field"><span>Action</span><select value={form.actionType} onChange={e => set("actionType", e.target.value)}><option value="create_patch_task">Create patch task</option><option value="create_security_task">Create security task</option><option value="notify">Notify SIEM</option><option value="mark_device">Mark device</option><option value="block_task_creation">Block task creation</option></select></label>
                  {form.actionType === "create_patch_task" && <label className="field"><span>Patch mode</span><select value={form.patchMode} onChange={e => set("patchMode", e.target.value)}><option value="all_outdated">All outdated packages</option><option value="specific_package">Specific package</option></select></label>}
                  {form.actionType === "create_patch_task" && form.patchMode === "specific_package" && <label className="field"><span>Package</span><input value={form.packageName} onChange={e => set("packageName", e.target.value)} placeholder="Google Chrome, Microsoft Edge"/></label>}
                  {form.actionType === "create_patch_task" && <label className="field"><span>Target version</span><input value={form.targetVersion} onChange={e => set("targetVersion", e.target.value || "latest")}/></label>}
                  {form.actionType === "create_security_task" && <label className="field"><span>Security task</span><select value={form.securityTask} onChange={e => set("securityTask", e.target.value)}><option value="refresh_inventory">Refresh inventory</option></select></label>}
                  {form.actionType === "notify" && <label className="field"><span>Message</span><input value={form.notifyMessage} onChange={e => set("notifyMessage", e.target.value)}/></label>}
                  {form.actionType === "mark_device" && <label className="field"><span>Tag</span><input value={form.tag} onChange={e => set("tag", e.target.value)} placeholder="needs-review"/></label>}
                  {form.actionType === "block_task_creation" && <label className="field"><span>Reason</span><input value={form.blockReason} onChange={e => set("blockReason", e.target.value)} placeholder="Unsafe automation candidate"/></label>}
                </div>
                <div className="success-card"><strong>Safety boundary</strong><span>No action can run commands, hide tasks, disable the kill switch, skip SIEM, or bypass scan, approval, signing, ledger, and delay gates.</span></div>
              </React.Fragment>
            )}
            {step === "schedule" && (
              <div className="form-grid">
                <label className="field"><span>Maintenance start UTC</span><input type="number" min="0" max="23" value={form.startHourUtc} onChange={e => set("startHourUtc", Number(e.target.value || 0))}/></label>
                <label className="field"><span>Maintenance end UTC</span><input type="number" min="1" max="24" value={form.endHourUtc} onChange={e => set("endHourUtc", Number(e.target.value || 24))}/></label>
                <label className="field"><span>Safe mode approval risk</span><input type="number" min="0" max="100" value={form.requireApprovalAtRiskScore} onChange={e => set("requireApprovalAtRiskScore", Number(e.target.value || 60))}/></label>
              </div>
            )}
            {step === "preview" && (
              <React.Fragment>
                {templatePreview && <div className="template-preview-box"><strong>Review before saving</strong><ul>{(templatePreview.summary || []).map(item => <li key={item}>{item}</li>)}</ul><span>Estimated affected devices: {templatePreview.estimatedAffectedDevices ?? "unknown"} · Risk: {templatePreview.riskLevel} · Mode: {templatePreview.securityMode}</span></div>}
                <div className="success-card"><strong>{form.name || "Untitled rule"}</strong><span>{form.triggerType} trigger · {form.combinator} conditions · {actionSummary(rulePayload(form).actions[0])}</span></div>
                <pre className="mono" style={{ whiteSpace:"pre-wrap", maxHeight:260, overflow:"auto", background:"var(--bg-sub)", border:"1px solid var(--line)", padding:12, borderRadius:6 }}>{JSON.stringify(rulePayload(form), null, 2)}</pre>
              </React.Fragment>
            )}
            {error && <ErrorAlert error={error}/>}
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:8 }}>
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button className="btn primary" disabled={busy || !form.name.trim()}>{busy ? "Saving..." : "Save rule"}</button>
            </div>
          </div>
        </form>
      </div>
    </React.Fragment>
  );
}

/**
 * Renders the rule tester UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function RuleTester({ rule, onClose, onExecuted }) {
  const devices = useResource(() => PatchAPI.devices());
  const [deviceId, setDeviceId] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState("");
  const sampleId = deviceId || devices.data?.[0]?.id || "";
  /**
   * Handles the test operation.
   */
  const test = async () => { setBusy("test"); try { setResult(await PatchAPI.testRule(rule.id, { deviceId: sampleId })); } finally { setBusy(""); } };
  /**
   * Handles the run operation.
   */
  const run = async () => { setBusy("run"); try { setResult({ executed: await PatchAPI.triggerRule(rule.id, { deviceId: sampleId }) }); onExecuted?.(); } finally { setBusy(""); } };
  return (
    <React.Fragment>
      <div className="drawer-backdrop" onClick={onClose}/>
      <div className="output-dialog"><div className="output-dialog-box">
        <div className="output-dialog-head"><h3>Test Rule</h3><button className="icon-btn" onClick={onClose}>{Icon.close}</button></div>
        <div style={{ padding:16, display:"flex", flexDirection:"column", gap:14 }}>
          <label className="field"><span>Sample device</span><select value={sampleId} onChange={e => setDeviceId(e.target.value)}>{(devices.data || []).map(d => <option key={d.id} value={d.id}>{d.hostname || d.id}</option>)}</select></label>
          <div style={{ display:"flex", gap:8 }}><button className="btn primary" onClick={test} disabled={!sampleId || busy}>{busy === "test" ? "Testing..." : "Test rule"}</button><button className="btn" onClick={run} disabled={!sampleId || busy}>Manual trigger</button></div>
          {result && !result.executed && <div className="success-card"><strong>{result.wouldTrigger ? "Would trigger" : "Would not trigger"}</strong><span>Risk {result.riskScore}/100 · {(result.actions || []).reduce((n,a) => n + (a.taskDrafts || []).length, 0)} task draft(s) · {result.approvalRequired ? "approval required" : "standard pipeline"}</span></div>}
          {result?.executed && <div className="success-card"><strong>Manual trigger submitted</strong><span>{result.executed.length} execution record(s) created.</span></div>}
          {result && <pre className="mono" style={{ whiteSpace:"pre-wrap", maxHeight:300, overflow:"auto", background:"var(--bg-sub)", border:"1px solid var(--line)", padding:12, borderRadius:6 }}>{JSON.stringify(result, null, 2)}</pre>}
        </div>
      </div></div>
    </React.Fragment>
  );
}

const conditionFields = ["device.os","device.hostname","device.group","device.tag","device.deviceTrustScore","device.lastInventoryAgeHours","package.outdated","package.name","package.severity","package.version","lastTask.failed","lastTask.retryCount","lastTask.failureRetryable","currentTime.maintenanceWindow","riskScore","task.sourceHostTrusted","task.hashPresent"];
const conditionOperators = ["eq","neq","contains","matches","lt","lte","gt","gte","in"];

/**
 * Handles the with template defaults operation.
 *
 * @param template template supplied to the function.
 * @param values values supplied to the function.
 * @param tenantId Identifier used to locate the target record.
 * @returns The result produced by the operation.
 */
function withTemplateDefaults(template, values, tenantId) {
  const out = { ...values, tenantId };
  (template.requiredInputs || []).forEach(input => {
    if (out[input.id] === undefined || out[input.id] === "") out[input.id] = input.defaultValue;
  });
  return out;
}
/**
 * Handles the template input display operation.
 *
 * @param value Value to read, render, or store.
 * @returns The result produced by the operation.
 */
function templateInputDisplay(value) {
  if (value && typeof value === "object") {
    if (Number.isFinite(value.startHourUtc) && Number.isFinite(value.endHourUtc)) return `${value.startHourUtc}-${value.endHourUtc}`;
    return JSON.stringify(value);
  }
  return value ?? "";
}
/**
 * Parses template input input.
 *
 * @param input input supplied to the function.
 * @param value Value to read, render, or store.
 * @returns The result produced by the operation.
 */
function parseTemplateInput(input, value) {
  if (input.type === "number") return Number(value || 0);
  if (input.type === "maintenance_window") {
    const match = String(value).match(/(\d{1,2})\D+(\d{1,2})/);
    return { daysOfWeek:[0], startHourUtc: match ? Number(match[1]) : 3, endHourUtc: match ? Number(match[2]) : 5 };
  }
  return value;
}
/**
 * Builds the device group options payload.
 *
 * @param devices devices supplied to the function.
 * @returns The result produced by the operation.
 */
function buildDeviceGroupOptions(devices) {
  const groups = new Map();
  for (const device of devices || []) {
    const name = device.group || "ungrouped";
    const current = groups.get(name) || { name, count:0, online:0, windows:0, linux:0, tags:new Set(), samples:[] };
    const platform = device.platform || (/(windows|win)/i.test(device.os || "") ? "windows" : /(linux|ubuntu|debian|rhel|fedora|suse)/i.test(device.os || "") ? "linux" : "other");
    current.count += 1;
    current.online += device.online ? 1 : 0;
    current.windows += platform === "windows" ? 1 : 0;
    current.linux += platform === "linux" ? 1 : 0;
    (device.tags || []).forEach(tag => current.tags.add(tag));
    if (current.samples.length < 3) current.samples.push(device.hostname || device.id);
    groups.set(name, current);
  }
  return [...groups.values()].map(group => ({ ...group, tags:[...group.tags].sort() })).sort((a, b) => a.name.localeCompare(b.name));
}
/**
 * Renders the group select UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function GroupSelect({ groups, value, onChange }) {
  const [query, setQuery] = useState(value || "");
  const matches = groups.filter(group => textMatches(query, [group.name, ...group.samples, ...group.tags])).slice(0, 8);
  useEffect(() => setQuery(value || ""), [value]);
  return (
    <div className="group-select">
      <div className="group-select-search">
        <span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.search}</span>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search groups..." />
      </div>
      <div className="group-option-list">
        {matches.map(group => (
          <button type="button" key={group.name} className={"group-option " + (value === group.name ? "selected" : "")} onClick={() => { onChange(group.name); setQuery(group.name); }}>
            <strong>{group.name}</strong>
            <span>{group.count} devices · {group.online} online</span>
            <em>{group.samples.join(", ") || "No sample devices"}</em>
          </button>
        ))}
        {matches.length === 0 && query.trim() && (
          <button type="button" className="group-option create" onClick={() => onChange(query.trim())}>
            <strong>Create "{query.trim()}"</strong><span>Use this new group name</span>
          </button>
        )}
      </div>
    </div>
  );
}
/**
 * Renders the device group picker UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function DeviceGroupPicker({ input, groups, loading, value, onChange }) {
  return (
    <div className="field">
      <span>{input.label}</span>
      {loading ? <div className="skel" style={{ height:42, borderRadius:6 }}/> : <GroupSelect groups={groups} value={value} onChange={onChange}/>}
      <small className="field-hint">{groups.length ? "Search and select an existing device group, or type a new one." : "No groups found yet. Add or enroll devices to build group options."}</small>
    </div>
  );
}
/**
 * Renders the maintenance window picker UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function MaintenanceWindowPicker({ input, value, onChange }) {
  const current = value && typeof value === "object" ? value : { daysOfWeek:[0], startHourUtc:3, endHourUtc:5 };
  const selectedDays = new Set(current.daysOfWeek?.length ? current.daysOfWeek : [0]);
  /**
   * Sets the day value.
   *
   * @param day day supplied to the function.
   */
  const setDay = (day) => {
    const next = new Set(selectedDays);
    next.has(day) ? next.delete(day) : next.add(day);
    onChange({ ...current, daysOfWeek:[...next].sort((a, b) => a - b) });
  };
  /**
   * Sets the hour value.
   *
   * @param key key supplied to the function.
   * @param raw raw supplied to the function.
   */
  const setHour = (key, raw) => {
    const hour = Math.max(0, Math.min(key === "endHourUtc" ? 24 : 23, Number(raw)));
    const next = { ...current, [key]: hour };
    if (next.endHourUtc <= next.startHourUtc) {
      if (key === "startHourUtc") next.endHourUtc = Math.min(24, next.startHourUtc + 1);
      else next.startHourUtc = Math.max(0, next.endHourUtc - 1);
    }
    onChange(next);
  };
  const presets = [
    ["sun-3-5", "Sun 03-05", { daysOfWeek:[0], startHourUtc:3, endHourUtc:5 }],
    ["sat-sun-2-6", "Weekend 02-06", { daysOfWeek:[0,6], startHourUtc:2, endHourUtc:6 }],
    ["daily-1-3", "Daily 01-03", { daysOfWeek:[0,1,2,3,4,5,6], startHourUtc:1, endHourUtc:3 }],
  ];
  return (
    <div className="field maintenance-picker">
      <span>{input.label}</span>
      <div className="maintenance-presets">
        {presets.map(([id, label, preset]) => <button type="button" key={id} onClick={() => onChange(preset)}>{label}</button>)}
      </div>
      <div className="dow-picker">
        {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((label, day) => (
          <button type="button" key={label} className={selectedDays.has(day) ? "active" : ""} onClick={() => setDay(day)}>{label}</button>
        ))}
      </div>
      <div className="time-range">
        <label><span>Start</span><select value={current.startHourUtc} onChange={e => setHour("startHourUtc", e.target.value)}>{hourOptions(0, 23)}</select></label>
        <label><span>End</span><select value={current.endHourUtc} onChange={e => setHour("endHourUtc", e.target.value)}>{hourOptions(1, 24)}</select></label>
      </div>
      <div className="window-summary">UTC window · {daysLabel([...selectedDays])} · {formatHour(current.startHourUtc)}-{formatHour(current.endHourUtc)}</div>
      <small className="field-hint">Tasks are still delayed, scanned, approved, and signed by policy before dispatch.</small>
    </div>
  );
}
/**
 * Handles the hour options operation.
 *
 * @param min min supplied to the function.
 * @param max max supplied to the function.
 * @returns The result produced by the operation.
 */
function hourOptions(min, max) {
  const items = [];
  for (let hour = min; hour <= max; hour++) items.push(<option key={hour} value={hour}>{formatHour(hour)}</option>);
  return items;
}
/**
 * Formats the hour value.
 *
 * @param hour hour supplied to the function.
 * @returns The result produced by the operation.
 */
function formatHour(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}
/**
 * Handles the days label operation.
 *
 * @param days Number of days to include in the range.
 * @returns The result produced by the operation.
 */
function daysLabel(days) {
  if (days.length === 7) return "Daily";
  return days.map(day => ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][day]).join(", ");
}
/**
 * Handles the client rule draft from template operation.
 *
 * @param template template supplied to the function.
 * @param inputs inputs supplied to the function.
 * @param tenantId Identifier used to locate the target record.
 * @returns The result produced by the operation.
 */
function clientRuleDraftFromTemplate(template, inputs, tenantId) {
  const rule = {
    id: undefined,
    tenantId,
    name: template.name,
    description: `${template.description}\n\nCreated from template: ${template.name}`,
    enabled: false,
    priority:100,
    trigger: template.trigger || { type:"manual" },
    conditionGroup: replaceTemplateValues(template.conditions || { combinator:"AND", conditions:[] }, inputs),
    actions: (template.actions || []).map(action => replaceTemplateValues(action, inputs)),
    schedule: { ...(template.schedule || {}), maintenanceWindow: inputs.maintenanceWindow || template.schedule?.maintenanceWindow },
    safeMode:{ enabled:true, requireApprovalAtRiskScore: template.recommendedSecurityMode === "tinfoil" ? 40 : template.recommendedSecurityMode === "strict" ? 50 : 60 },
    sourceTemplateId: template.id,
    sourceTemplateName: template.name,
  };
  return {
    draftRule: rule,
    preview: {
      summary: [`target devices in group ${inputs.targetDeviceGroup || "selected group"}`, ...(template.explanation || []), "start disabled for review before saving", "use the normal task security pipeline"],
      estimatedAffectedDevices: null,
      riskLevel: template.riskLevel || "medium",
      requiredApprovals: ["tenant policy"],
      securityMode: template.recommendedSecurityMode || "normal",
    },
  };
}
/**
 * Handles the replace template values operation.
 *
 * @param value Value to read, render, or store.
 * @param inputs inputs supplied to the function.
 * @returns The result produced by the operation.
 */
function replaceTemplateValues(value, inputs) {
  if (typeof value === "string" && value.startsWith("$input.")) return inputs[value.slice(7)];
  if (Array.isArray(value)) return value.map(item => replaceTemplateValues(item, inputs));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, replaceTemplateValues(nested, inputs)]));
  return value;
}
const DASHBOARD_BROWSER_PACKAGES = ["Google Chrome","Microsoft Edge","Mozilla Firefox"];
const DASHBOARD_DEV_PACKAGES = ["Visual Studio Code","Git","Node.js"];
const DASHBOARD_COLLAB_PACKAGES = ["Microsoft Teams","Zoom","Slack"];
const DASHBOARD_GROUP_INPUT = { id:"targetDeviceGroup", label:"Target device group", type:"device_group", required:true, description:"Device group the generated rule should target." };
const DASHBOARD_PACKAGE_INPUT = { id:"packageName", label:"Package name", type:"package_name", required:true, description:"Exact package/app name this rule is allowed to patch.", defaultValue:"Google Chrome" };
const DASHBOARD_WINDOW_INPUT = { id:"maintenanceWindow", label:"Maintenance window", type:"maintenance_window", required:true, description:"UTC window in which scheduled patch tasks may be created.", defaultValue:{ daysOfWeek:[0], startHourUtc:3, endHourUtc:5 } };
const DASHBOARD_MAX_DEVICES_INPUT = { id:"maxDevices", label:"Max devices per run", type:"number", required:true, description:"Upper bound for task drafts created by one rule execution.", defaultValue:10 };
const DASHBOARD_RETRY_LIMIT_INPUT = { id:"retryLimit", label:"Retry limit", type:"number", required:true, description:"Maximum retry attempts before escalation.", defaultValue:2 };
const DASHBOARD_RULE_TEMPLATES = [
  { id:"weekly-browser-updates", name:"Weekly Browser Updates", description:"Patch only Chrome, Edge, and Firefox on Windows during a maintenance window.", category:"Recommended", recommendedSecurityMode:"strict", riskLevel:"medium", tags:["browser","windows","weekly"], trigger:{ type:"schedule" }, schedule:{ cron:"0 3 * * 0", timezone:"UTC", maintenanceWindow:{ daysOfWeek:[0], startHourUtc:3, endHourUtc:5 } }, conditions:{ combinator:"AND", conditions:[{ field:"device.group", operator:"eq", value:"$input.targetDeviceGroup" },{ field:"device.os", operator:"eq", value:"windows" },{ field:"package.name", operator:"in", value:DASHBOARD_BROWSER_PACKAGES },{ field:"package.outdated", operator:"eq", value:true },{ field:"currentTime.maintenanceWindow", operator:"eq", value:true }] }, actions:[{ type:"create_patch_task", mode:"specific_package", packageNames:DASHBOARD_BROWSER_PACKAGES, targetVersion:"latest", maxDevices:"$input.maxDevices" }], requiredInputs:[DASHBOARD_GROUP_INPUT,DASHBOARD_WINDOW_INPUT,{ ...DASHBOARD_MAX_DEVICES_INPUT, defaultValue:25 }], explanation:["patch only Chrome, Edge, and Firefox packages","skip browsers that are already current","use delayed execution and security scanning before dispatch"], safety:["specific package allow-list","maintenance window required","disabled by default"] },
  { id:"critical-patch-fast-track", name:"Critical Patch Fast Track", description:"Fast-track one named critical package outside production while preserving approval gates.", category:"Recommended", recommendedSecurityMode:"tinfoil", riskLevel:"high", tags:["critical","vulnerability","approval"], trigger:{ type:"event", eventType:"vulnerability.detected" }, schedule:{}, conditions:{ combinator:"AND", conditions:[{ field:"device.group", operator:"neq", value:"production" },{ field:"package.name", operator:"eq", value:"$input.packageName" },{ field:"package.severity", operator:"eq", value:"critical" },{ field:"package.outdated", operator:"eq", value:true }] }, actions:[{ type:"create_patch_task", mode:"specific_package", packageName:"$input.packageName", targetVersion:"latest", maxDevices:"$input.maxDevices" },{ type:"notify", channel:"siem", message:"Critical package fast-track draft created" }], requiredInputs:[DASHBOARD_PACKAGE_INPUT,DASHBOARD_MAX_DEVICES_INPUT], explanation:["patch only the named critical package","exclude production by default","send a SIEM notification"], safety:["specific package required","MFA approval applies through tenant policy","small max-device cap"] },
  { id:"patch-test-group-first", name:"Patch Test Group First", description:"Patch all outdated packages only in the test group before any wider rollout.", category:"Recommended", recommendedSecurityMode:"strict", riskLevel:"low", tags:["test-first","patch","pilot"], trigger:{ type:"schedule" }, schedule:{ cron:"0 2 * * 0", timezone:"UTC", maintenanceWindow:{ daysOfWeek:[0], startHourUtc:2, endHourUtc:5 } }, conditions:{ combinator:"AND", conditions:[{ field:"device.group", operator:"eq", value:"test" },{ field:"package.outdated", operator:"eq", value:true },{ field:"currentTime.maintenanceWindow", operator:"eq", value:true }] }, actions:[{ type:"create_patch_task", mode:"all_outdated", targetVersion:"latest", maxDevices:10 }], requiredInputs:[], explanation:["patch only the hard-coded test ring","allow broader all-outdated coverage only in that pilot ring"], safety:["no production devices affected","max 10 devices per run","disabled by default"] },
  { id:"chrome-zero-day-response", name:"Chrome Zero-Day Response", description:"Create capped Chrome patch drafts when a high-priority browser issue is detected.", category:"Patch Automation", recommendedSecurityMode:"tinfoil", riskLevel:"high", tags:["browser","zero-day","chrome"], trigger:{ type:"event", eventType:"package.high_priority.detected" }, schedule:{}, conditions:{ combinator:"AND", conditions:[{ field:"device.os", operator:"eq", value:"windows" },{ field:"package.name", operator:"eq", value:"Google Chrome" },{ field:"package.outdated", operator:"eq", value:true }] }, actions:[{ type:"create_patch_task", mode:"specific_package", packageName:"Google Chrome", targetVersion:"latest", maxDevices:10 },{ type:"notify", channel:"siem", message:"Chrome high-priority patch draft created" }], requiredInputs:[], explanation:["patch only Google Chrome","react to high-priority package events","notify SIEM"], safety:["specific package only","max 10 devices per execution","high-risk approvals apply"] },
  { id:"microsoft-edge-stable-ring", name:"Microsoft Edge Stable Ring", description:"Patch Edge on a named Windows device group during a weekly window.", category:"Patch Automation", recommendedSecurityMode:"strict", riskLevel:"medium", tags:["browser","edge","windows"], trigger:{ type:"schedule" }, schedule:{ cron:"30 3 * * 0", timezone:"UTC", maintenanceWindow:{ daysOfWeek:[0], startHourUtc:3, endHourUtc:5 } }, conditions:{ combinator:"AND", conditions:[{ field:"device.group", operator:"eq", value:"$input.targetDeviceGroup" },{ field:"device.os", operator:"eq", value:"windows" },{ field:"package.name", operator:"eq", value:"Microsoft Edge" },{ field:"package.outdated", operator:"eq", value:true },{ field:"currentTime.maintenanceWindow", operator:"eq", value:true }] }, actions:[{ type:"create_patch_task", mode:"specific_package", packageName:"Microsoft Edge", targetVersion:"latest", maxDevices:"$input.maxDevices" }], requiredInputs:[DASHBOARD_GROUP_INPUT,DASHBOARD_WINDOW_INPUT,{ ...DASHBOARD_MAX_DEVICES_INPUT, defaultValue:20 }], explanation:["patch only Microsoft Edge","limit rollout to the selected group"], safety:["specific package only","maintenance window required","device cap required"] },
  { id:"firefox-maintenance-ring", name:"Firefox Maintenance Ring", description:"Patch Firefox on a selected endpoint ring without touching other apps.", category:"Patch Automation", recommendedSecurityMode:"strict", riskLevel:"medium", tags:["browser","firefox"], trigger:{ type:"schedule" }, schedule:{ cron:"0 4 * * 0", timezone:"UTC", maintenanceWindow:{ daysOfWeek:[0], startHourUtc:4, endHourUtc:6 } }, conditions:{ combinator:"AND", conditions:[{ field:"device.group", operator:"eq", value:"$input.targetDeviceGroup" },{ field:"package.name", operator:"eq", value:"Mozilla Firefox" },{ field:"package.outdated", operator:"eq", value:true },{ field:"currentTime.maintenanceWindow", operator:"eq", value:true }] }, actions:[{ type:"create_patch_task", mode:"specific_package", packageName:"Mozilla Firefox", targetVersion:"latest", maxDevices:"$input.maxDevices" }], requiredInputs:[DASHBOARD_GROUP_INPUT,DASHBOARD_WINDOW_INPUT,{ ...DASHBOARD_MAX_DEVICES_INPUT, defaultValue:20 }], explanation:["patch only Mozilla Firefox","skip unrelated outdated software"], safety:["specific package only","disabled by default"] },
  { id:"developer-tooling-weekly", name:"Developer Tooling Weekly", description:"Patch VS Code, Git, and Node.js on developer workstations.", category:"Patch Automation", recommendedSecurityMode:"strict", riskLevel:"medium", tags:["developer","tooling","weekly"], trigger:{ type:"schedule" }, schedule:{ cron:"0 5 * * 6", timezone:"UTC", maintenanceWindow:{ daysOfWeek:[6], startHourUtc:5, endHourUtc:8 } }, conditions:{ combinator:"AND", conditions:[{ field:"device.group", operator:"eq", value:"$input.targetDeviceGroup" },{ field:"package.name", operator:"in", value:DASHBOARD_DEV_PACKAGES },{ field:"package.outdated", operator:"eq", value:true },{ field:"currentTime.maintenanceWindow", operator:"eq", value:true }] }, actions:[{ type:"create_patch_task", mode:"specific_package", packageNames:DASHBOARD_DEV_PACKAGES, targetVersion:"latest", maxDevices:"$input.maxDevices" }], requiredInputs:[DASHBOARD_GROUP_INPUT,{ ...DASHBOARD_WINDOW_INPUT, defaultValue:{ daysOfWeek:[6], startHourUtc:5, endHourUtc:8 } },{ ...DASHBOARD_MAX_DEVICES_INPUT, defaultValue:15 }], explanation:["patch only common developer tools","avoid broad workstation updates"], safety:["specific package allow-list","weekend maintenance default"] },
  { id:"collaboration-app-weekly", name:"Collaboration Apps Weekly", description:"Patch Teams, Zoom, and Slack on office endpoints.", category:"Patch Automation", recommendedSecurityMode:"strict", riskLevel:"medium", tags:["collaboration","teams","zoom","slack"], trigger:{ type:"schedule" }, schedule:{ cron:"0 4 * * 6", timezone:"UTC", maintenanceWindow:{ daysOfWeek:[6], startHourUtc:4, endHourUtc:7 } }, conditions:{ combinator:"AND", conditions:[{ field:"device.group", operator:"eq", value:"$input.targetDeviceGroup" },{ field:"package.name", operator:"in", value:DASHBOARD_COLLAB_PACKAGES },{ field:"package.outdated", operator:"eq", value:true },{ field:"currentTime.maintenanceWindow", operator:"eq", value:true }] }, actions:[{ type:"create_patch_task", mode:"specific_package", packageNames:DASHBOARD_COLLAB_PACKAGES, targetVersion:"latest", maxDevices:"$input.maxDevices" }], requiredInputs:[DASHBOARD_GROUP_INPUT,{ ...DASHBOARD_WINDOW_INPUT, defaultValue:{ daysOfWeek:[6], startHourUtc:4, endHourUtc:7 } },{ ...DASHBOARD_MAX_DEVICES_INPUT, defaultValue:20 }], explanation:["patch only Teams, Zoom, and Slack","keep unrelated apps out of scope"], safety:["specific package allow-list","maintenance window required"] },
  { id:"vpn-client-maintenance", name:"VPN Client Maintenance", description:"Patch one VPN client package on remote-user devices.", category:"Patch Automation", recommendedSecurityMode:"tinfoil", riskLevel:"high", tags:["vpn","remote-access"], trigger:{ type:"schedule" }, schedule:{ cron:"0 2 * * 6", timezone:"UTC", maintenanceWindow:{ daysOfWeek:[6], startHourUtc:2, endHourUtc:4 } }, conditions:{ combinator:"AND", conditions:[{ field:"device.group", operator:"eq", value:"$input.targetDeviceGroup" },{ field:"package.name", operator:"eq", value:"$input.packageName" },{ field:"package.outdated", operator:"eq", value:true },{ field:"currentTime.maintenanceWindow", operator:"eq", value:true }] }, actions:[{ type:"create_patch_task", mode:"specific_package", packageName:"$input.packageName", targetVersion:"latest", maxDevices:"$input.maxDevices" },{ type:"notify", channel:"siem", message:"VPN client patch draft created" }], requiredInputs:[DASHBOARD_GROUP_INPUT,{ ...DASHBOARD_PACKAGE_INPUT, defaultValue:"FortiClient VPN" },{ ...DASHBOARD_WINDOW_INPUT, defaultValue:{ daysOfWeek:[6], startHourUtc:2, endHourUtc:4 } },{ ...DASHBOARD_MAX_DEVICES_INPUT, defaultValue:10 }], explanation:["patch only the named VPN client","notify security monitoring"], safety:["specific package required","high-risk approvals apply"] },
  { id:"refresh-inventory-daily", name:"Refresh Inventory Daily", description:"Refresh stale device inventory once per day.", category:"Security / Inventory", recommendedSecurityMode:"normal", riskLevel:"low", tags:["inventory","daily"], trigger:{ type:"schedule" }, schedule:{ cron:"0 1 * * *", timezone:"UTC" }, conditions:{ combinator:"AND", conditions:[{ field:"device.group", operator:"eq", value:"$input.targetDeviceGroup" },{ field:"device.lastInventoryAgeHours", operator:"gt", value:24 }] }, actions:[{ type:"create_security_task", task:"refresh_inventory" }], requiredInputs:[DASHBOARD_GROUP_INPUT], explanation:["refresh inventory for devices whose data should stay current"], safety:["low risk","uses supported signed refresh task"] },
  { id:"inventory-before-maintenance", name:"Inventory Before Maintenance", description:"Refresh stale inventory shortly before a patch window.", category:"Security / Inventory", recommendedSecurityMode:"normal", riskLevel:"low", tags:["inventory","preflight"], trigger:{ type:"schedule" }, schedule:{ cron:"0 0 * * 0", timezone:"UTC" }, conditions:{ combinator:"AND", conditions:[{ field:"device.group", operator:"eq", value:"$input.targetDeviceGroup" },{ field:"device.lastInventoryAgeHours", operator:"gt", value:12 }] }, actions:[{ type:"create_security_task", task:"refresh_inventory" }], requiredInputs:[DASHBOARD_GROUP_INPUT], explanation:["refresh stale inventory before patch decisions are made"], safety:["no package update action","uses signed inventory task"] },
  { id:"low-trust-inventory-refresh", name:"Low-Trust Inventory Refresh", description:"Refresh and tag devices whose trust score drops below a review threshold.", category:"Security / Inventory", recommendedSecurityMode:"strict", riskLevel:"low", tags:["trust","inventory","review"], trigger:{ type:"event", eventType:"device.inventory.updated" }, schedule:{}, conditions:{ combinator:"AND", conditions:[{ field:"device.deviceTrustScore", operator:"lt", value:60 }] }, actions:[{ type:"create_security_task", task:"refresh_inventory" },{ type:"mark_device", tag:"trust-review" },{ type:"notify", channel:"siem", message:"Low-trust device inventory refresh requested" }], requiredInputs:[], explanation:["refresh questionable inventory","tag the device for review","notify SIEM"], safety:["no package execution action","metadata tag only"] },
  { id:"retry-failed-updates", name:"Retry Failed Package Update", description:"Retry one named package after a transient failure with capped exponential backoff.", category:"Failure Handling", recommendedSecurityMode:"strict", riskLevel:"medium", tags:["retry","failed-task","specific-package"], trigger:{ type:"event", eventType:"task.failed" }, schedule:{}, conditions:{ combinator:"AND", conditions:[{ field:"lastTask.failed", operator:"eq", value:true },{ field:"lastTask.retryCount", operator:"lt", value:"$input.retryLimit" },{ field:"lastTask.failureRetryable", operator:"eq", value:true },{ field:"package.name", operator:"eq", value:"$input.packageName" },{ field:"package.outdated", operator:"eq", value:true }] }, actions:[{ type:"create_patch_task", mode:"specific_package", packageName:"$input.packageName", targetVersion:"latest", retryLimit:"$input.retryLimit", backoff:"exponential", maxDevices:1 }], requiredInputs:[DASHBOARD_PACKAGE_INPUT,DASHBOARD_RETRY_LIMIT_INPUT], explanation:["retry only the named package","create at most one retry draft"], safety:["exponential backoff","retry count prevents loops","no all-outdated retry"] },
  { id:"repeated-failure-inventory-reset", name:"Repeated Failure Inventory Reset", description:"Refresh inventory and notify SIEM after repeated update failures.", category:"Failure Handling", recommendedSecurityMode:"strict", riskLevel:"low", tags:["failure","inventory","siem"], trigger:{ type:"event", eventType:"task.failed" }, schedule:{}, conditions:{ combinator:"AND", conditions:[{ field:"lastTask.failed", operator:"eq", value:true },{ field:"lastTask.retryCount", operator:"gte", value:2 }] }, actions:[{ type:"create_security_task", task:"refresh_inventory" },{ type:"notify", channel:"siem", message:"Inventory refresh created after repeated patch failures" }], requiredInputs:[], explanation:["refresh inventory instead of blindly retrying patches","notify SIEM after repeated failures"], safety:["no package execution action","breaks retry loops"] },
  { id:"failed-task-siem-escalation", name:"Failed Task SIEM Escalation", description:"Escalate repeated failed tasks without creating new patch work.", category:"Failure Handling", recommendedSecurityMode:"normal", riskLevel:"low", tags:["failure","siem","tag"], trigger:{ type:"event", eventType:"task.failed" }, schedule:{}, conditions:{ combinator:"AND", conditions:[{ field:"lastTask.failed", operator:"eq", value:true },{ field:"lastTask.retryCount", operator:"gte", value:2 }] }, actions:[{ type:"mark_device", tag:"patch-failure-review" },{ type:"notify", channel:"siem", message:"Device marked for patch failure review" }], requiredInputs:[], explanation:["tag devices after repeated failures","notify SIEM for manual follow-up"], safety:["no retry task created","metadata-only device mark"] },
  { id:"production-maintenance-window-only", name:"Production Package Window", description:"Patch one named production package only inside an explicit maintenance window.", category:"Compliance", recommendedSecurityMode:"tinfoil", riskLevel:"high", tags:["production","maintenance-window","specific-package"], trigger:{ type:"schedule" }, schedule:{ cron:"0 3 * * 0", timezone:"UTC", maintenanceWindow:{ daysOfWeek:[0], startHourUtc:3, endHourUtc:5 } }, conditions:{ combinator:"AND", conditions:[{ field:"device.group", operator:"eq", value:"production" },{ field:"package.name", operator:"eq", value:"$input.packageName" },{ field:"package.outdated", operator:"eq", value:true },{ field:"currentTime.maintenanceWindow", operator:"eq", value:true }] }, actions:[{ type:"create_patch_task", mode:"specific_package", packageName:"$input.packageName", targetVersion:"latest", maxDevices:"$input.maxDevices" }], requiredInputs:[{ ...DASHBOARD_PACKAGE_INPUT, defaultValue:"Microsoft Edge" },DASHBOARD_WINDOW_INPUT,{ ...DASHBOARD_MAX_DEVICES_INPUT, defaultValue:5 }], explanation:["patch only one named production package","create drafts only during the configured window"], safety:["specific package required","max 5 devices by default","tinfoil approval defaults"] },
  { id:"production-hotfix-window", name:"Production Hotfix Window", description:"Create tightly capped production hotfix drafts for one critical package.", category:"Compliance", recommendedSecurityMode:"tinfoil", riskLevel:"critical", tags:["production","hotfix","critical"], trigger:{ type:"event", eventType:"vulnerability.detected" }, schedule:{ maintenanceWindow:{ daysOfWeek:[0], startHourUtc:3, endHourUtc:5 } }, conditions:{ combinator:"AND", conditions:[{ field:"device.group", operator:"eq", value:"production" },{ field:"package.name", operator:"eq", value:"$input.packageName" },{ field:"package.severity", operator:"eq", value:"critical" },{ field:"package.outdated", operator:"eq", value:true },{ field:"currentTime.maintenanceWindow", operator:"eq", value:true }] }, actions:[{ type:"create_patch_task", mode:"specific_package", packageName:"$input.packageName", targetVersion:"latest", maxDevices:"$input.maxDevices" },{ type:"notify", channel:"siem", message:"Production critical hotfix draft created" }], requiredInputs:[DASHBOARD_PACKAGE_INPUT,DASHBOARD_WINDOW_INPUT,{ ...DASHBOARD_MAX_DEVICES_INPUT, defaultValue:3 }], explanation:["patch only the named critical production package","notify SIEM immediately"], safety:["critical risk approval path","max 3 devices by default","maintenance window required"] },
  { id:"block-production-outside-window", name:"Block Production Outside Window", description:"Block production task candidates outside the configured maintenance window.", category:"Compliance", recommendedSecurityMode:"tinfoil", riskLevel:"low", tags:["production","guardrail","maintenance-window"], trigger:{ type:"event", eventType:"rule.task_candidate.created" }, schedule:{ maintenanceWindow:{ daysOfWeek:[0], startHourUtc:3, endHourUtc:5 } }, conditions:{ combinator:"AND", conditions:[{ field:"device.group", operator:"eq", value:"production" },{ field:"currentTime.maintenanceWindow", operator:"eq", value:false }] }, actions:[{ type:"block_task_creation", reason:"Production task candidate outside maintenance window" },{ type:"notify", channel:"siem", message:"Blocked production task outside maintenance window" }], requiredInputs:[DASHBOARD_WINDOW_INPUT], explanation:["block instead of creating endpoint work","notify SIEM on policy violation"], safety:["no executable task created","guardrail action only"] },
  { id:"block-unsafe-automation", name:"Block Unsafe Automation", description:"Stop automation candidates with critical risk, untrusted source, or missing hashes.", category:"Compliance", recommendedSecurityMode:"tinfoil", riskLevel:"low", tags:["block","guardrail"], trigger:{ type:"event", eventType:"rule.task_candidate.created" }, schedule:{}, conditions:{ combinator:"OR", conditions:[{ field:"riskScore", operator:"gte", value:90 },{ field:"task.sourceHostTrusted", operator:"eq", value:false },{ field:"task.hashPresent", operator:"eq", value:false }] }, actions:[{ type:"block_task_creation", reason:"Unsafe automation candidate" },{ type:"notify", channel:"siem", message:"Blocked unsafe automation candidate" }], requiredInputs:[], explanation:["do not create an executable task","notify admins and SIEM"], safety:["no hidden task","no arbitrary command","blocks instead of executes"] },
  { id:"low-trust-automation-block", name:"Low-Trust Automation Block", description:"Block task candidates for low-trust devices or high-risk automation.", category:"Compliance", recommendedSecurityMode:"tinfoil", riskLevel:"low", tags:["trust","block","guardrail"], trigger:{ type:"event", eventType:"rule.task_candidate.created" }, schedule:{}, conditions:{ combinator:"OR", conditions:[{ field:"device.deviceTrustScore", operator:"lt", value:40 },{ field:"riskScore", operator:"gte", value:80 },{ field:"task.sourceHostTrusted", operator:"eq", value:false },{ field:"task.hashPresent", operator:"eq", value:false }] }, actions:[{ type:"block_task_creation", reason:"Low-trust or high-risk automation candidate" },{ type:"notify", channel:"siem", message:"Blocked low-trust automation candidate" }], requiredInputs:[], explanation:["block risky automation candidates","notify SIEM with audit context"], safety:["no hidden task","no arbitrary command","blocks instead of executes"] },
  { id:"notify-on-high-risk-task", name:"Notify on High-Risk Task", description:"Notify security systems when a task scan returns high risk.", category:"Notifications", recommendedSecurityMode:"normal", riskLevel:"low", tags:["notification","siem"], trigger:{ type:"event", eventType:"task.security_scan.completed" }, schedule:{}, conditions:{ combinator:"AND", conditions:[{ field:"riskScore", operator:"gte", value:70 }] }, actions:[{ type:"notify", channel:"siem", message:"High-risk task detected by rule template" }], requiredInputs:[], explanation:["send SIEM and configured tenant notifications for high-risk task scans"], safety:["no execution action"] },
  { id:"stale-inventory-notification", name:"Stale Inventory Notification", description:"Notify SIEM when devices in a group have stale inventory.", category:"Notifications", recommendedSecurityMode:"normal", riskLevel:"low", tags:["inventory","notification"], trigger:{ type:"schedule" }, schedule:{ cron:"0 8 * * *", timezone:"UTC" }, conditions:{ combinator:"AND", conditions:[{ field:"device.group", operator:"eq", value:"$input.targetDeviceGroup" },{ field:"device.lastInventoryAgeHours", operator:"gt", value:72 }] }, actions:[{ type:"notify", channel:"siem", message:"Stale device inventory detected" }], requiredInputs:[DASHBOARD_GROUP_INPUT], explanation:["notify without creating tasks","surface stale inventory for operations review"], safety:["notification only","no endpoint execution"] },
];
/**
 * Handles the default rule operation.
 * @returns The result produced by the operation.
 */
function defaultRule() {
  return { enabled:true, tenantId:"default", name:"", description:"", priority:100, trigger:{ type:"manual" }, conditionGroup:{ combinator:"AND", conditions:[{ field:"package.outdated", operator:"eq", value:true }] }, actions:[{ type:"create_patch_task", mode:"all_outdated", targetVersion:"latest" }], schedule:{ maintenanceWindow:{ startHourUtc:0, endHourUtc:6 } }, safeMode:{ enabled:true, requireApprovalAtRiskScore:60 } };
}
/**
 * Handles the normalize rule form operation.
 *
 * @param rule rule supplied to the function.
 * @returns The result produced by the operation.
 */
function normalizeRuleForm(rule) {
  const r = rule || defaultRule();
  const action = (r.actions || defaultRule().actions)[0];
  return { id:r.id, tenantId:r.tenantId || "default", name:r.name || "", description:r.description || "", enabled:r.enabled !== false, priority:r.priority ?? 100, triggerType:r.trigger?.type || "manual", eventType:r.trigger?.eventType || "device.inventory.updated", cron:r.schedule?.cron || "0 2 * * 0", combinator:r.conditionGroup?.combinator || "AND", conditions:r.conditionGroup?.conditions?.filter(c => !c.combinator) || [], actions:r.actions || [], actionType:action.type, patchMode:action.mode || "all_outdated", packageName:action.packageName || (action.packageNames || []).join(", "), targetVersion:action.targetVersion || "latest", securityTask:action.task || "refresh_inventory", notifyMessage:action.message || "Rule matched", tag:action.tag || "rule-matched", blockReason:action.reason || "Unsafe automation candidate", startHourUtc:r.schedule?.maintenanceWindow?.startHourUtc ?? 0, endHourUtc:r.schedule?.maintenanceWindow?.endHourUtc ?? 6, requireApprovalAtRiskScore:r.safeMode?.requireApprovalAtRiskScore ?? 60, sourceTemplateId:r.sourceTemplateId, sourceTemplateName:r.sourceTemplateName };
}
/**
 * Handles the rule payload operation.
 *
 * @param form form supplied to the function.
 * @returns The result produced by the operation.
 */
function rulePayload(form) {
  const packageNames = String(form.packageName || "").split(",").map(name => name.trim()).filter(Boolean);
  const originalActions = Array.isArray(form.actions) ? form.actions : [];
  const originalAction = originalActions[0] || {};
  const originalPatchAction = originalAction.type === "create_patch_task" ? { ...originalAction } : {};
  delete originalPatchAction.packageName;
  delete originalPatchAction.packageNames;
  delete originalPatchAction.packageId;
  const action = form.actionType === "create_patch_task" ? cleanPatchAction({ ...originalPatchAction, type:"create_patch_task", mode:form.patchMode, ...(form.patchMode === "specific_package" ? (packageNames.length > 1 ? { packageNames } : { packageName:packageNames[0] || undefined }) : {}), targetVersion:form.targetVersion || "latest" }) : form.actionType === "create_security_task" ? { type:"create_security_task", task:form.securityTask } : form.actionType === "notify" ? { type:"notify", channel:"siem", message:form.notifyMessage || "Rule matched" } : form.actionType === "block_task_creation" ? { type:"block_task_creation", reason:form.blockReason || "Unsafe automation candidate" } : { type:"mark_device", tag:form.tag || "rule-matched" };
  const actions = originalActions.length > 1 && originalAction.type === action.type ? [action, ...originalActions.slice(1)] : [action];
  return { tenantId:form.tenantId || "default", name:form.name.trim(), description:form.description.trim(), enabled:form.enabled, priority:Number(form.priority || 100), trigger:{ type:form.triggerType, ...(form.triggerType === "event" ? { eventType:form.eventType } : {}) }, conditionGroup:{ combinator:form.combinator, conditions:form.conditions }, actions, schedule:{ cron:form.triggerType === "schedule" ? form.cron : undefined, maintenanceWindow:{ startHourUtc:Number(form.startHourUtc), endHourUtc:Number(form.endHourUtc) } }, safeMode:{ enabled:true, requireApprovalAtRiskScore:Number(form.requireApprovalAtRiskScore || 60) }, sourceTemplateId:form.sourceTemplateId, sourceTemplateName:form.sourceTemplateName };
}
/**
 * Handles the clean patch action operation.
 *
 * @param action action supplied to the function.
 * @returns The result produced by the operation.
 */
function cleanPatchAction(action) {
  if (action.mode !== "specific_package") {
    delete action.packageName;
    delete action.packageNames;
    delete action.packageId;
  }
  return action;
}
/**
 * Updates the condition record or state.
 *
 * @param setForm set form supplied to the function.
 * @param index index supplied to the function.
 * @param patch patch supplied to the function.
 */
function updateCondition(setForm, index, patch) { setForm(prev => ({ ...prev, conditions: prev.conditions.map((c,i) => i === index ? { ...c, ...patch } : c) })); }
/**
 * Removes the condition record or state.
 *
 * @param setForm set form supplied to the function.
 * @param index index supplied to the function.
 */
function removeCondition(setForm, index) { setForm(prev => ({ ...prev, conditions: prev.conditions.filter((_, i) => i !== index) })); }
/**
 * Parses condition value input.
 *
 * @param value Value to read, render, or store.
 * @returns The result produced by the operation.
 */
function parseConditionValue(value) { if (value === "true") return true; if (value === "false") return false; const n = Number(value); return value.trim() !== "" && Number.isFinite(n) ? n : value; }
/**
 * Handles the condition summary operation.
 *
 * @param group group supplied to the function.
 * @returns The result produced by the operation.
 */
function conditionSummary(group) { const count = group?.conditions?.length || 0; return `${group?.combinator || "AND"} · ${count} condition${count === 1 ? "" : "s"}`; }
/**
 * Handles the action summary operation.
 *
 * @param action action supplied to the function.
 * @returns The result produced by the operation.
 */
function actionSummary(action) { if (!action) return "none"; if (action.type === "create_patch_task") return action.mode === "all_outdated" ? "patch all outdated" : `patch ${action.packageName || (action.packageNames || []).join(", ") || action.packageId || "package"}`; if (action.type === "create_security_task") return action.task; if (action.type === "notify") return `notify ${action.channel}`; if (action.type === "mark_device") return `tag ${action.tag}`; return action.type; }

// ---------- Tasks ----------
/**
 * Renders the tasks page UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function TasksPage({ globalSearch = "" }) {
  const [filter, setFilter] = useState("all");
  const tasks = useResource(() => PatchAPI.tasks());
  useLiveResource(tasks, 2_500);
  const [cancelling, setCancelling] = useState(new Set());
  const [actionLoading, setActionLoading] = useState(new Set());
  const [actionError, setActionError] = useState(null);
  const [mfaDialog, setMfaDialog] = useState(null); // { taskId, challengeId }
  const [mfaCode, setMfaCode] = useState("");
  const [mfaError, setMfaError] = useState("");
  const [outputTaskId, setOutputTaskId] = useState(null);
  const outputTask = outputTaskId ? (tasks.data || []).find(t => t.id === outputTaskId) ?? null : null;
  const [copied, setCopied] = useState(false);
  // Ticker so fmtAgo values stay fresh when no task data changes
  const [, setTimeTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTimeTick(n => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  /**
   * Handles the cancel operation.
   *
   * @param id Identifier used to locate the target record.
   */
  const cancel = async (id) => {
    setCancelling(prev => new Set([...prev, id]));
    try { await PatchAPI.cancelTask(id); tasks.reload(true); }
    catch (e) { /* task may have already moved past pending */ }
    finally { setCancelling(prev => { const s = new Set(prev); s.delete(id); return s; }); }
  };

  const markLoading = (key) => setActionLoading(prev => new Set([...prev, key]));
  const clearLoading = (key) => setActionLoading(prev => { const s = new Set(prev); s.delete(key); return s; });

  const scanTask = async (id) => {
    markLoading(`scan-${id}`); setActionError(null);
    try { await PatchAPI.scanTask(id); tasks.reload(true); }
    catch (e) { setActionError(e?.message || "Scan failed"); }
    finally { clearLoading(`scan-${id}`); }
  };

  const approveTask = async (id) => {
    markLoading(`approve-${id}`); setActionError(null);
    try {
      await PatchAPI.approveTask(id, '');
      tasks.reload(true);
    } catch (e) {
      if (e?.message?.toLowerCase().includes('mfa') || e?.message?.toLowerCase().includes('challenge')) {
        try {
          const { challengeId } = await PatchAPI.issueMfaChallenge();
          setMfaDialog({ taskId: id, challengeId });
          setMfaCode(""); setMfaError("");
        } catch (mfaErr) { setActionError(mfaErr?.message || "Could not issue MFA challenge"); }
      } else {
        setActionError(e?.message || "Approval failed");
      }
    } finally { clearLoading(`approve-${id}`); }
  };

  const submitMfaApproval = async () => {
    if (!mfaDialog) return;
    setMfaError("");
    try {
      await PatchAPI.verifyMfaChallenge(mfaDialog.challengeId, mfaCode);
      await PatchAPI.approveTask(mfaDialog.taskId, mfaDialog.challengeId);
      setMfaDialog(null); setMfaCode("");
      tasks.reload(true);
    } catch (e) { setMfaError(e?.message || "MFA approval failed"); }
  };

  const signTask = async (id) => {
    markLoading(`sign-${id}`); setActionError(null);
    try { await PatchAPI.signTask(id); tasks.reload(true); }
    catch (e) { setActionError(e?.message || "Signing failed"); }
    finally { clearLoading(`sign-${id}`); }
  };

  /**
   * Handles the copy output operation.
   */
  const copyOutput = () => {
    navigator.clipboard.writeText(outputTask?.output || "").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const rows = sortTasksNewestFirst(tasks.data || []).filter(t =>
    (filter === "all" || t.status === filter) &&
    textMatches(globalSearch, [taskLabel(t), t.type, t.appName, t.deviceId, t.nodeId, t.status, t.fromVersion, t.targetVersion, t.output])
  );
  return (
    <div className="page">
      <div className="page-head">
        <div><h2>Tasks</h2><p>{tasks.loading ? "…" : `${(tasks.data || []).length} update jobs`}</p></div>
        <button className="btn" onClick={() => tasks.reload()}>Refresh</button>
      </div>
      <div className="card">
        <div className="filterbar">
          {[["all","All"],["security_scanned","Needs Approval"],["mfa_approved","Needs Signing"],["pending","Pending"],["dispatched","Dispatched"],["completed","Completed"],["failed","Failed"],["cancelled","Cancelled"]].map(([k,l]) => (
            <button key={k} className={"chip " + (filter === k ? "active" : "")} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
        {tasks.error && <div style={{ padding:16 }}><ErrorAlert error={tasks.error} onRetry={tasks.reload}/></div>}
        {actionError && <div style={{ padding:"8px 16px", color:"var(--crit)", fontSize:13 }}>{actionError}</div>}
        <div style={{ overflowX:"auto" }}>
          <table className="tbl">
            <thead><tr><th>App</th><th>Device</th><th>Version</th><th>Node</th><th>Status</th><th>Output</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {tasks.loading && <SkeletonRows n={6} cols={8}/>}
              {!tasks.loading && rows.length === 0 && <tr><td colSpan={8} style={{ padding:24, color:"var(--text-3)" }}>No tasks match.</td></tr>}
              {!tasks.loading && rows.map(t => (
                <tr key={t.id}>
                  <td><strong style={{ fontWeight:500 }}>{taskLabel(t)}</strong></td>
                  <td className="mono">{t.deviceId}</td>
                  <td className="mono muted">{taskVersionLabel(t)}</td>
                  <td className="mono muted">{t.nodeId}</td>
                  <td><StatusPill status={t.status}/></td>
                  <td className="mono muted" style={{ maxWidth:280, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", cursor: t.output ? "pointer" : "default" }}
                      title={t.output ? "Click to view full output" : undefined}
                      onClick={() => t.output && setOutputTaskId(t.id)}>{t.output || "—"}</td>
                  <td className="muted">{fmtAgo(t.createdAt)}</td>
                  <td>
                    {t.status === "pending" && (
                      <button className="btn sm" disabled={cancelling.has(t.id)} onClick={() => cancel(t.id)}>
                        {cancelling.has(t.id) ? "…" : "Cancel"}
                      </button>
                    )}
                    {t.status === "draft" && (
                      <button className="btn sm" disabled={actionLoading.has(`scan-${t.id}`)} onClick={() => scanTask(t.id)}>
                        {actionLoading.has(`scan-${t.id}`) ? "…" : "Scan"}
                      </button>
                    )}
                    {t.status === "security_scanned" && (
                      <button className="btn sm" disabled={actionLoading.has(`approve-${t.id}`)} onClick={() => approveTask(t.id)}>
                        {actionLoading.has(`approve-${t.id}`) ? "…" : "Approve"}
                      </button>
                    )}
                    {t.status === "mfa_approved" && (
                      <button className="btn sm" disabled={actionLoading.has(`sign-${t.id}`)} onClick={() => signTask(t.id)}>
                        {actionLoading.has(`sign-${t.id}`) ? "…" : "Sign"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {outputTask && (
        <React.Fragment>
          <div className="drawer-backdrop" onClick={() => setOutputTaskId(null)}/>
          <div className="output-dialog">
            <div className="output-dialog-box">
              <div className="output-dialog-head">
                <h4>{taskLabel(outputTask)}</h4>
                <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                  <button className="btn sm" onClick={copyOutput}>{copied ? "Copied!" : "Copy"}</button>
                  <button className="icon-btn" onClick={() => setOutputTaskId(null)}>
                    <span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.close}</span>
                  </button>
                </div>
              </div>
              <div className="output-dialog-body">
                <pre>{outputTask.output}</pre>
              </div>
            </div>
          </div>
        </React.Fragment>
      )}

      {mfaDialog && (
        <React.Fragment>
          <div className="drawer-backdrop" onClick={() => setMfaDialog(null)}/>
          <div className="output-dialog">
            <div className="output-dialog-box">
              <div className="output-dialog-head">
                <h4>MFA Approval Required</h4>
                <button className="icon-btn" onClick={() => setMfaDialog(null)}>
                  <span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.close}</span>
                </button>
              </div>
              <div className="output-dialog-body" style={{ padding:24, display:"flex", flexDirection:"column", gap:16 }}>
                <p style={{ margin:0, fontSize:14 }}>Enter your authenticator code to approve this task.</p>
                <input
                  className="input"
                  value={mfaCode}
                  onChange={e => { setMfaCode(e.target.value); setMfaError(""); }}
                  onKeyDown={e => e.key === "Enter" && submitMfaApproval()}
                  placeholder="6-digit code"
                  maxLength={6}
                  autoFocus
                  style={{ letterSpacing:"0.2em", width:140, textAlign:"center" }}
                />
                {mfaError && <div style={{ color:"var(--crit)", fontSize:13 }}>{mfaError}</div>}
                <div style={{ display:"flex", gap:8 }}>
                  <button className="btn" onClick={submitMfaApproval} disabled={mfaCode.length < 6}>Approve</button>
                  <button className="btn ghost" onClick={() => setMfaDialog(null)}>Cancel</button>
                </div>
              </div>
            </div>
          </div>
        </React.Fragment>
      )}
    </div>
  );
}

// ---------- Nodes ----------
const FINDING_SEVERITY_COLOR = {
  critical: "var(--crit)",
  high: "var(--warn)",
  medium: "var(--accent)",
  low: "var(--text-3)",
  info: "var(--text-3)",
};

const FINDING_CATEGORY_LABEL = {
  os_security: "OS security",
  ip_reputation: "Public URL / IP",
  node_age: "Node age",
  configuration: "Configuration",
  health: "Health",
};

function trustReasonImpact(reason) {
  const text = String(reason || "").toLowerCase();
  if (text.includes("unhealthy component")) return "-25 each";
  if (text.includes("degraded component")) return "-8 each";
  if (text.includes("scanner unhealthy")) return "-12";
  if (text.includes("cache unhealthy")) return "-8";
  if (text.includes("package verifier")) return "-20";
  if (text.includes("update source")) return "-6";
  if (text.includes("clock skew")) return "-15";
  if (text.includes("high queue")) return "-8";
  if (text.includes("high latency")) return "-6";
  if (text.includes("less than 1 hour")) return "-20 and cap 60";
  if (text.includes("less than 24 hours")) return "-10 and cap 75";
  if (text.includes("less than 7 days")) return "-5 and cap 90";
  if (text.includes("denylisted")) return "-35";
  if (text.includes("warnlisted")) return "-18";
  if (text.includes("local-only")) return "-15";
  if (text.includes("private or reserved")) return "-8";
  if (text.includes("raw public ip")) return "-8";
  if (text.includes("plain http")) return "-12";
  if (text.includes("unusual public")) return "-3";
  if (text.includes("invalid public url")) return "-7";
  return "factor";
}

function NodeTrustBreakdown({ trust, node }) {
  const findings = trust?.securityFindings || [];
  const reasons = (trust?.reasons || []).filter(r => r !== "signed health report accepted");
  const quarantines = node?.activeQuarantineEvents || node?.quarantineEvents || [];
  const history = node?.trustHistory || [];
  const trustScore = trust?.trustScore ?? node?.trustScore ?? 0;
  const shouldDefaultOpen = trustScore < 70 || node?.quarantineState === "quarantined" || findings.length > 0 || reasons.length > 0;
  const [open, setOpen] = useState(shouldDefaultOpen);
  useEffect(() => { if (shouldDefaultOpen) setOpen(true); }, [shouldDefaultOpen, trust?.id]);
  if (findings.length === 0 && reasons.length === 0 && quarantines.length === 0 && history.length === 0) return null;

  const grouped = findings.reduce((acc, finding) => {
    const key = finding.category || "health";
    if (!acc[key]) acc[key] = [];
    acc[key].push(finding);
    return acc;
  }, {});
  const categories = Object.keys(grouped);
  const highRisk = findings.some(f => f.severity === "critical" || f.severity === "high") || trustScore < 30 || node?.quarantineState === "quarantined";
  const previous = trust?.previousTrustScore;
  const delta = trust?.scoreDelta;

  return (
    <div style={{ paddingTop:10, borderTop:"1px solid var(--line)" }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        style={{ all:"unset", cursor:"pointer", display:"flex", alignItems:"center", gap:6, width:"100%" }}>
        <span className="muted" style={{ fontSize:10, flex:1 }}>WHY THIS TRUST SCORE</span>
        {delta != null && (
          <span style={{ fontSize:10, color: delta < 0 ? "var(--crit)" : "var(--ok)" }}>
            {previous ?? "?"} -> {trust?.trustScore ?? "?"} ({delta > 0 ? "+" : ""}{delta})
          </span>
        )}
        {findings.length > 0 && (
          <span style={{ fontSize:10, color: highRisk ? "var(--crit)" : "var(--warn)" }}>
            {findings.length} finding{findings.length === 1 ? "" : "s"}
          </span>
        )}
        <span style={{ fontSize:10, color:"var(--text-3)" }}>{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div style={{ marginTop:8, display:"flex", flexDirection:"column", gap:10 }}>
          {node?.quarantineState === "quarantined" && (
            <div style={{ padding:10, border:"1px solid color-mix(in oklch, var(--crit), white 70%)", background:"var(--crit-soft)", borderRadius:8 }}>
              <div style={{ fontSize:11, fontWeight:700, color:"var(--crit)", marginBottom:4 }}>Node is quarantined</div>
              <div style={{ fontSize:11 }}>
                {node.quarantineReason || quarantines[0]?.reason || "Trust fell below the quarantine threshold."}
              </div>
              {quarantines[0]?.trigger && (
                <div className="mono muted" style={{ fontSize:10, marginTop:4 }}>
                  trigger: {quarantines[0].trigger} · {fmtAgo(quarantines[0].createdAt)}
                </div>
              )}
            </div>
          )}

          {(reasons.length > 0 || delta != null || trust?.maxTrustScore != null) && (
            <div>
              <div className="muted" style={{ fontSize:9, fontWeight:700, marginBottom:4 }}>SCORING FACTORS</div>
              {delta != null && (
                <div style={{ display:"flex", justifyContent:"space-between", gap:8, fontSize:11, padding:"6px 0", borderBottom:"1px solid var(--line)" }}>
                  <span>Latest signed health report changed trust from <strong>{previous}</strong> to <strong>{trust.trustScore}</strong>.</span>
                  <span className="mono" style={{ color: delta < 0 ? "var(--crit)" : "var(--ok)", whiteSpace:"nowrap" }}>{delta > 0 ? "+" : ""}{delta}</span>
                </div>
              )}
              {trust?.maxTrustScore != null && trust.maxTrustScore < 100 && (
                <div style={{ display:"flex", justifyContent:"space-between", gap:8, fontSize:11, padding:"6px 0", borderBottom:"1px solid var(--line)" }}>
                  <span>Trust is capped while this node builds an operational baseline.</span>
                  <span className="mono" style={{ color:"var(--warn)", whiteSpace:"nowrap" }}>cap {trust.maxTrustScore}</span>
                </div>
              )}
              {reasons.map(reason => (
                <div key={reason} style={{ display:"flex", justifyContent:"space-between", gap:8, fontSize:11, padding:"6px 0", borderBottom:"1px solid var(--line)" }}>
                  <span style={{ color:"var(--text)" }}>{reason}</span>
                  <span className="mono" style={{ color:"var(--warn)", whiteSpace:"nowrap" }}>{trustReasonImpact(reason)}</span>
                </div>
              ))}
            </div>
          )}

          {categories.map(category => (
            <div key={category}>
              <div className="muted" style={{ fontSize:9, fontWeight:700, marginBottom:4 }}>
                {FINDING_CATEGORY_LABEL[category] || category} findings
              </div>
              {grouped[category].map(finding => (
                <div
                  key={finding.code}
                  style={{
                    marginBottom:6,
                    paddingLeft:8,
                    borderLeft:"2px solid " + (FINDING_SEVERITY_COLOR[finding.severity] || "var(--line)"),
                  }}>
                  <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom:2, flexWrap:"wrap" }}>
                    <span style={{ fontSize:10, fontWeight:700, color:FINDING_SEVERITY_COLOR[finding.severity] || "var(--text-3)", textTransform:"uppercase" }}>
                      {finding.severity}
                    </span>
                    <span className="mono" style={{ fontSize:10, color:"var(--text-3)" }}>{finding.code}</span>
                  </div>
                  <div style={{ fontSize:11, color:"var(--text)" }}>{finding.message}</div>
                  {finding.remediationHint && (
                    <div style={{ fontSize:10, color:"var(--text-3)", marginTop:2 }}>
                      Fix: {finding.remediationHint}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}

          {history.length > 1 && (
            <div>
              <div className="muted" style={{ fontSize:9, fontWeight:700, marginBottom:4 }}>RECENT TRUST HISTORY</div>
              {history.slice(0, 5).map(item => (
                <div key={item.id} style={{ display:"flex", justifyContent:"space-between", gap:8, fontSize:11, marginBottom:4 }}>
                  <span>{fmtAgo(item.createdAt)} · {(item.reasons || []).filter(r => r !== "signed health report accepted")[0] || item.healthState}</span>
                  <span className="mono" style={{ color:(item.scoreDelta ?? 0) < 0 ? "var(--crit)" : "var(--ok)" }}>
                    {item.previousTrustScore ?? "?"} -> {item.trustScore}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NodeTrustInvestigationDrawer({ node, onClose, onResetSafe }) {
  if (!node) return null;
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState('');
  const trust = node.trust || {};
  const trustScore = trust.trustScore ?? node.trustScore ?? 0;
  const healthState = node.quarantineState === "quarantined" ? "quarantined" : (node.healthState ?? trust.healthState ?? node.status);
  const findings = trust.securityFindings || [];
  const reasons = (trust.reasons || []).filter(r => r !== "signed health report accepted");
  const latestReason = node.quarantineReason || reasons[0] || findings[0]?.message || "No trust findings recorded.";
  const components = node.health?.components || [];
  const quarantines = node.activeQuarantineEvents || node.quarantineEvents || [];
  const canReset = node.quarantineState === "quarantined" || trustScore < 70;
  const resetSafe = () => {
    setResetBusy(true);
    setResetError('');
    PatchAPI.clearNodeQuarantine(node.id)
      .then((updated) => {
        setConfirmReset(false);
        onResetSafe?.(updated);
      })
      .catch(err => setResetError(err.message || "Trust reset failed"))
      .finally(() => setResetBusy(false));
  };

  return (
    <React.Fragment>
      <div className="drawer-backdrop" onClick={onClose}/>
      <div className="trust-detail-drawer" role="dialog" aria-modal="true" aria-label={`Trust investigation for ${node.name || node.id}`}>
        <div className="wizard-head">
          <div>
            <h3>Trust investigation</h3>
            <p>{node.name || node.id}</p>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            {canReset && (
              <button className="btn sm primary" onClick={() => setConfirmReset(true)}>
                Mark safe & reset trust
              </button>
            )}
            <button className="icon-btn" onClick={onClose} aria-label="Close trust investigation">
              <span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.close}</span>
            </button>
          </div>
        </div>
        <div className="trust-detail-body">
          {resetError && <div className="banner error">{resetError}</div>}
          <div className="trust-detail-summary">
            <div>
              <span className="muted">Current trust</span>
              <strong>{trustScore}</strong>
            </div>
            <div>
              <span className="muted">State</span>
              <StatusPill status={healthState}/>
            </div>
            <div>
              <span className="muted">Findings</span>
              <strong>{findings.length}</strong>
            </div>
            <div>
              <span className="muted">Quarantine events</span>
              <strong>{quarantines.length}</strong>
            </div>
          </div>

          <div className={"trust-detail-callout " + (node.quarantineState === "quarantined" ? "crit" : trustScore < 70 ? "warn" : "ok")}>
            <strong>{node.quarantineState === "quarantined" ? "Node is quarantined" : trustScore < 70 ? "Node trust is degraded" : "Node trust is acceptable"}</strong>
            <span>{latestReason}</span>
            {canReset && (
              <button className="btn sm" style={{ justifySelf:"start", marginTop:6 }} onClick={() => setConfirmReset(true)}>
                I verified this node is safe
              </button>
            )}
          </div>

          <div className="card">
            <div className="card-head"><h3>Health Components</h3><div className="sub">{components.length ? `${components.length} reported` : "No report"}</div></div>
            <div className="card-body">
              <NodeComponentsRow components={components}/>
              {components.length === 0 && <div className="empty">No health component report has been received.</div>}
              {components.length > 0 && (
                <div className="trust-component-list">
                  {components.map(component => (
                    <div key={component.name}>
                      <NodeHealthDot status={component.status}/>
                      <span>{component.name}</span>
                      <strong>{component.status}</strong>
                      {component.message && <em>{component.message}</em>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h3>Score Explanation</h3><div className="sub">Audit-grade scoring reasons</div></div>
            <div className="card-body">
              <NodeTrustBreakdown trust={trust} node={node}/>
            </div>
          </div>
        </div>
      </div>
      {confirmReset && (
        <div className="modal-overlay" onClick={() => !resetBusy && setConfirmReset(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <h3>Reset node trust?</h3>
            <p>This clears quarantine and restores this node to the manual reapproval baseline. Only do this after verifying certificate identity, node host integrity, package cache integrity, and network exposure.</p>
            {resetError && <div className="banner error">{resetError}</div>}
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setConfirmReset(false)} disabled={resetBusy}>Cancel</button>
              <button className="btn danger" onClick={resetSafe} disabled={resetBusy}>
                {resetBusy ? <span className="search-spinner"/> : null}
                Mark safe & reset
              </button>
            </div>
          </div>
        </div>
      )}
    </React.Fragment>
  );
}

function NodeHealthDot({ status }) {
  const color = status === "ok" ? "var(--ok)" : status === "degraded" ? "var(--warn)" : status === "unhealthy" ? "var(--crit)" : "var(--text-3)";
  return <span style={{ display:"inline-block", width:7, height:7, borderRadius:"50%", background:color, flexShrink:0 }}/>;
}

function NodeComponentsRow({ components }) {
  if (!components || components.length === 0) return null;
  const show = components.filter(c => c.status !== "ok");
  if (show.length === 0) return (
    <div style={{ fontSize:11, color:"var(--ok)", display:"flex", alignItems:"center", gap:5 }}>
      <NodeHealthDot status="ok"/> All components healthy
    </div>
  );
  return (
    <div style={{ display:"flex", flexWrap:"wrap", gap:"4px 10px" }}>
      {show.map(c => (
        <span key={c.name} style={{ display:"flex", alignItems:"center", gap:4, fontSize:11 }}>
          <NodeHealthDot status={c.status}/>
          <span style={{ color:"var(--text-2)" }}>{c.name}</span>
          <span style={{ color: c.status === "degraded" ? "var(--warn)" : "var(--crit)" }}>{c.status}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Renders the nodes page UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function NodesPage({ globalSearch = "" }) {
  const nodes = useResource(() => PatchAPI.nodeTrustCenter ? PatchAPI.nodeTrustCenter() : PatchAPI.nodes());
  useLiveResource(nodes, 5_000);
  const [filter, setFilter] = useState("all");
  const all = nodes.data || [];

  const counts = {
    all: all.length,
    healthy: all.filter(n => (n.healthState ?? n.trust?.healthState) === "healthy").length,
    "low-trust": all.filter(n => (n.trust?.trustScore ?? n.trustScore ?? 0) < 70).length,
    maintenance: all.filter(n => ["maintenance","draining"].includes(n.maintenanceState)).length,
    quarantined: all.filter(n => n.quarantineState === "quarantined").length,
  };

  const rows = all.filter(n => {
    const trust = n.trust?.trustScore ?? n.trustScore ?? 0;
    if (filter === "quarantined" && n.quarantineState !== "quarantined") return false;
    if (filter === "low-trust" && trust >= 70) return false;
    if (filter === "maintenance" && !["maintenance","draining"].includes(n.maintenanceState)) return false;
    if (filter === "healthy" && (n.healthState ?? n.trust?.healthState) !== "healthy") return false;
    return textMatches(globalSearch, [n.name, n.id, n.publicUrl, n.url, n.region, n.site, n.status, n.version, n.healthState, n.quarantineState, ...(n.capabilities || [])]);
  });

  const onlineCount = all.filter(n => n.status === "online" || n.healthState === "healthy" || n.healthState === "degraded").length;
  const avgTrust = all.length > 0 ? Math.round(all.reduce((s, n) => s + (n.trust?.trustScore ?? n.trustScore ?? 0), 0) / all.length) : null;

  const [enrolling, setEnrolling] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [investigatingNode, setInvestigatingNode] = useState(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const handleRemove = () => {
    setRemoveBusy(true); setRemoveError('');
    PatchAPI.deleteNode(removing.id)
      .then(() => { setRemoving(null); nodes.reload(); })
      .catch(err => setRemoveError(err.message || 'Remove failed'))
      .finally(() => setRemoveBusy(false));
  };

  return (
    <div className="page">
      <div className="page-head">
        <div><h2>Node Trust Center</h2><p>Regional execution, cache health, trust scoring, quarantine, and failover state</p></div>
        <button className="btn primary" onClick={() => setEnrolling(true)}>
          <span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.plus}</span>Enroll node
        </button>
      </div>

      {!nodes.loading && all.length > 0 && (
        <div style={{ display:"flex", gap:24, padding:"10px 0 4px", flexWrap:"wrap" }}>
          {[
            ["Nodes", all.length, null],
            ["Online", onlineCount, "var(--ok)"],
            ["Avg trust", avgTrust != null ? avgTrust : "—", avgTrust >= 90 ? "var(--ok)" : avgTrust >= 70 ? "var(--accent)" : "var(--warn)"],
            ["Low trust", counts["low-trust"], counts["low-trust"] > 0 ? "var(--warn)" : null],
            ["Quarantined", counts.quarantined, counts.quarantined > 0 ? "var(--crit)" : null],
          ].map(([label, val, color]) => (
            <div key={label} style={{ display:"flex", flexDirection:"column", gap:2 }}>
              <span className="muted" style={{ fontSize:11 }}>{label}</span>
              <span style={{ fontSize:20, fontWeight:700, color: color || "var(--text)", letterSpacing:"-0.02em" }}>{val}</span>
            </div>
          ))}
        </div>
      )}

      <div className="filterbar">
        {[["all","All"],["healthy","Healthy"],["low-trust","Low trust"],["maintenance","Maintenance"],["quarantined","Quarantined"]].map(([k,l]) => (
          <button key={k} className={"chip " + (filter === k ? "active" : "")} onClick={() => setFilter(k)}>
            {l}{counts[k] > 0 && k !== "all" ? <span style={{ marginLeft:5, opacity:0.6, fontSize:11 }}>{counts[k]}</span> : null}
          </button>
        ))}
      </div>

      {nodes.error && <ErrorAlert error={nodes.error} onRetry={nodes.reload}/>}
      <div className="row-3">
        {nodes.loading && Array.from({ length:3 }).map((_,i) => <div className="card" key={i}><div className="card-body"><Skeleton h={140}/></div></div>)}
        {!nodes.loading && rows.length === 0 && (
          <div className="card"><div className="card-body" style={{ color:"var(--text-3)" }}>
            {filter === "all" ? "No nodes enrolled." : "No nodes match this filter."}
          </div></div>
        )}
        {!nodes.loading && rows.map(n => {
          const trustScore = n.trust?.trustScore ?? n.trustScore ?? 0;
          const healthState = n.quarantineState === "quarantined" ? "quarantined" : (n.healthState ?? n.trust?.healthState ?? n.status);
          const reasons = (n.trust?.reasons || []).filter(r => r !== "signed health report accepted");
          const components = n.health?.components || [];
          const mem = n.health?.memoryPressurePercent;
          const disk = n.health?.diskFreeBytes;
          const skew = n.health?.clockSkewMs;
          const latency = n.trust?.latencyMs;
          const queueLag = n.health?.queueLag ?? n.trust?.queueLag;
          const certValid = n.trust?.certValid;
          const quarantined = n.quarantineState === "quarantined";
          const inMaintenance = ["maintenance","draining"].includes(n.maintenanceState);

          return (
            <div className="card" key={n.id} style={{ overflow:"hidden" }}>
              {quarantined && (
                <div style={{ background:"var(--crit)", color:"#fff", fontSize:11, fontWeight:600, padding:"5px 14px", letterSpacing:"0.03em" }}>
                  QUARANTINED{n.quarantineReason ? ` — ${n.quarantineReason}` : ""}
                </div>
              )}
              {!quarantined && inMaintenance && (
                <div style={{ background:"var(--accent)", color:"#fff", fontSize:11, fontWeight:600, padding:"5px 14px", letterSpacing:"0.03em" }}>
                  MAINTENANCE{n.maintenanceState === "draining" ? " (draining)" : ""}
                </div>
              )}
              <div className="card-body" style={{ display:"flex", flexDirection:"column", gap:14 }}>

                {/* Header: name + status + trust donut */}
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:12 }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontWeight:700, fontSize:15, marginBottom:3 }}>{n.name}</div>
                    <a href={n.publicUrl || n.url || "#"} target="_blank" rel="noreferrer"
                       style={{ display:"flex", alignItems:"center", gap:4, textDecoration:"none" }}>
                      <span className="muted mono" style={{ fontSize:11, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{n.publicUrl || n.url || "—"}</span>
                      <span style={{ width:10, height:10, display:"inline-flex", color:"var(--text-3)", flexShrink:0 }}>{Icon.externalLink}</span>
                    </a>
                    {(n.region || n.site) && (
                      <div style={{ display:"flex", gap:6, marginTop:5, flexWrap:"wrap" }}>
                        {n.region && <span className="pill">{n.region}</span>}
                        {n.site && <span className="pill">{n.site}</span>}
                      </div>
                    )}
                  </div>
                  <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:4, flexShrink:0 }}>
                    <Donut value={trustScore} size={62} stroke={8}/>
                    <StatusPill status={healthState}/>
                  </div>
                </div>

                {/* Health components */}
                <div style={{ paddingTop:10, borderTop:"1px solid var(--line)" }}>
                  <NodeComponentsRow components={components}/>
                  {components.length === 0 && (
                    <div style={{ fontSize:11, color:"var(--text-3)" }}>No health data yet</div>
                  )}
                </div>

                {/* Metrics grid */}
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"8px 16px" }}>
                  {[
                    ["LAST SEEN", fmtAgo(n.lastSeenAt)],
                    ["VERSION", n.version || "—"],
                    mem != null ? ["MEMORY", mem + "%", mem > 90 ? "var(--crit)" : mem > 75 ? "var(--warn)" : null] : null,
                    disk != null ? ["DISK FREE", fmtBytes(disk), disk < 1e9 ? "var(--warn)" : null] : null,
                    latency != null ? ["LATENCY", latency + " ms", latency > 500 ? "var(--warn)" : null] : null,
                    skew != null && skew > 5000 ? ["CLOCK SKEW", Math.round(skew / 1000) + "s", "var(--warn)"] : null,
                    queueLag ? ["QUEUE LAG", queueLag, queueLag === "high" ? "var(--crit)" : queueLag === "medium" ? "var(--warn)" : null] : null,
                    certValid != null ? ["CERT", certValid ? "valid" : "expired/none", certValid ? null : "var(--warn)"] : null,
                  ].filter(Boolean).map(([label, val, color]) => (
                    <div key={label}>
                      <div className="muted" style={{ fontSize:10 }}>{label}</div>
                      <div className="mono" style={{ fontSize:12, color: color || "var(--text)" }}>{val}</div>
                    </div>
                  ))}
                </div>

                <div style={{ paddingTop:10, borderTop:"1px solid var(--line)", display:"grid", gap:8 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:10 }}>
                    <div style={{ minWidth:0 }}>
                      <div className="muted" style={{ fontSize:10 }}>TRUST INVESTIGATION</div>
                      <div style={{ fontSize:12, color: quarantined ? "var(--crit)" : trustScore < 70 ? "var(--warn)" : "var(--text-2)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                        {n.quarantineReason || reasons[0] || n.trust?.securityFindings?.[0]?.message || "No active trust findings"}
                      </div>
                    </div>
                    <button className="btn sm" onClick={() => setInvestigatingNode(n)}>
                      Investigate trust
                    </button>
                  </div>
                </div>

                {/* Capabilities */}
                {(n.capabilities || []).length > 0 && (
                  <div style={{ display:"flex", flexWrap:"wrap", gap:5, paddingTop:8, borderTop:"1px solid var(--line)" }}>
                    {n.capabilities.map(c => <span className="pill" key={c} style={{ fontSize:11 }}>{c}</span>)}
                  </div>
                )}

                {/* Footer */}
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", paddingTop:8, borderTop:"1px solid var(--line)" }}>
                  <span className="muted" style={{ fontSize:11 }}>
                    {n.firstSeenAt ? `Since ${fmtAgo(n.firstSeenAt)}` : n.id}
                  </span>
                  <button className="btn sm ghost danger" onClick={() => { setRemoveError(''); setRemoving(n); }}>Remove</button>
                </div>

              </div>
            </div>
          );
        })}
      </div>

      {investigatingNode && (
        <NodeTrustInvestigationDrawer
          node={(nodes.data || []).find(item => item.id === investigatingNode.id) || investigatingNode}
          onClose={() => setInvestigatingNode(null)}
          onResetSafe={() => {
            nodes.reload();
            setInvestigatingNode(null);
          }}
        />
      )}

      {enrolling && <EnrollNodeWizard onClose={() => setEnrolling(false)} onCreated={nodes.reload}/>}
      {removing && (
        <div className="modal-overlay" onClick={() => !removeBusy && setRemoving(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <h3>Remove node?</h3>
            <p>This will permanently decommission <strong>{removing.name}</strong>, revoke its mTLS certificate, and remove it from all node lists. This cannot be undone.</p>
            {removeError && <div className="banner error">{removeError}</div>}
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setRemoving(null)} disabled={removeBusy}>Cancel</button>
              <button className="btn danger" onClick={handleRemove} disabled={removeBusy}>
                {removeBusy ? <span className="search-spinner"/> : null}
                Remove node
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Renders the enroll node drawer UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function EnrollNodeWizard({ onClose, onCreated }) {
  const [step, setStep] = useState("details");
  const [form, setForm] = useState({ name:"", publicUrl:"http://localhost:4200", region:"", site:"" });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const noticeTimer = useRef(null);

  const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }));

  const oneLinerJson = result ? JSON.stringify(result) : "";
  const prettyJson = result ? JSON.stringify(result, null, 2) : "";

  const steps = [
    ["details", "Details"],
    ["enrollment", "Enrollment"],
    ["install", "Install"],
  ];

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const created = await PatchAPI.createNodeEnrollment({
        name: form.name.trim(),
        publicUrl: form.publicUrl.trim(),
        region: form.region.trim() || undefined,
        site: form.site.trim() || undefined,
      });
      setResult(created);
      setStep("enrollment");
      onCreated?.(created);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text) => {
    const copied = await copyTextToClipboard(text);
    setNotice({ msg: copied ? "Copied to clipboard." : "Copy failed — select and copy manually.", ok: copied });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2400);
  };

  return (
    <React.Fragment>
      <div className="drawer-backdrop" onClick={onClose}/>
      <div className="wizard-modal" role="dialog" aria-modal="true">
        <div className="wizard-head">
          <div>
            <h3>Enroll backend node</h3>
            <p>Generate an enrollment token for a new backend node.</p>
          </div>
          <button className="icon-btn" onClick={onClose}><span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.close}</span></button>
        </div>
        <div className="wizard-body">
          <div className="wizard-steps">
            {steps.map(([id, label]) => {
              const done = (id === "details" && result) || (id === "enrollment" && result && step === "install");
              const active = step === id;
              return (
                <button key={id} className={"wizard-step " + (active ? "active " : "") + (done ? "done" : "")}
                  onClick={() => (id === "details" || result) && setStep(id)}>
                  <span>{done ? "OK" : "--"}</span>{label}
                </button>
              );
            })}
          </div>
          <div className="wizard-panel">
            {step === "details" && (
              <form onSubmit={submit} style={{ display:"flex", flexDirection:"column", gap:14 }}>
                <div className="form-grid">
                  <label className="field">
                    <span>Name</span>
                    <input required value={form.name} placeholder="node-1" onChange={e => set("name", e.target.value)}/>
                  </label>
                  <label className="field">
                    <span>Public URL</span>
                    <input required value={form.publicUrl} placeholder="http://host:4200" onChange={e => set("publicUrl", e.target.value)}/>
                  </label>
                  <label className="field">
                    <span>Region</span>
                    <input value={form.region} placeholder="eu-central" onChange={e => set("region", e.target.value)}/>
                  </label>
                  <label className="field">
                    <span>Site</span>
                    <input value={form.site} placeholder="office-1" onChange={e => set("site", e.target.value)}/>
                  </label>
                </div>
                {error && <ErrorAlert error={error}/>}
                <div style={{ display:"flex", justifyContent:"flex-end", gap:8 }}>
                  <button type="button" className="btn" onClick={onClose}>Cancel</button>
                  <button className="btn primary" disabled={busy}>{busy ? "Creating…" : "Create enrollment"}</button>
                </div>
              </form>
            )}
            {step === "enrollment" && result && (
              <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
                <div className="success-card">
                  <strong>Enrollment created</strong>
                  <span>Copy the JSON and paste it when the backend node asks for the enrollment.</span>
                </div>
                <textarea className="codebox one-line" readOnly value={oneLinerJson}/>
                <details>
                  <summary className="muted" style={{ cursor:"pointer" }}>Pretty JSON</summary>
                  <textarea className="codebox" readOnly value={prettyJson}/>
                </details>
                <div style={{ display:"flex", justifyContent:"flex-end", gap:8 }}>
                  <button type="button" className="btn" disabled={!oneLinerJson} onClick={() => copy(oneLinerJson)}>Copy JSON</button>
                  <button className="btn primary" onClick={() => setStep("install")}>Next</button>
                </div>
                <div className={"notice-slot " + (notice ? "show " + (notice.ok ? "ok" : "err") : "")} aria-live="polite">{notice?.msg}</div>
              </div>
            )}
            {step === "install" && result && (
              <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
                <div className="success-card">
                  <strong>Start the backend node</strong>
                  <span>Run the node in an interactive console. When prompted for the enrollment JSON, paste what you copied.</span>
                </div>
                <div style={{ display:"flex", justifyContent:"flex-end", gap:8 }}>
                  <button className="btn" onClick={() => setStep("enrollment")}>Back</button>
                  <button className="btn primary" onClick={onClose}>Done</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </React.Fragment>
  );
}

// ---------- Alarms ----------
/**
 * Renders the alarms page UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function AlarmsPage({ globalSearch = "" }) {
  const alarms = useResource(() => PatchAPI.alarms());
  useLiveResource(alarms, 5_000);
  /**
   * Resolves resolve configuration.
   *
   * @param id Identifier used to locate the target record.
   */
  const resolve = async (id) => { try { await PatchAPI.resolveAlarm(id); } finally { alarms.reload(); } };
  const [resolvingAll, setResolvingAll] = React.useState(false);
  const resolveAll = async () => { setResolvingAll(true); try { await PatchAPI.resolveAllAlarms(); } finally { setResolvingAll(false); alarms.reload(); } };
  const rows = (alarms.data || []).filter(a => textMatches(globalSearch, [a.message, a.deviceId, a.severity, a.id]));
  return (
    <div className="page">
      <div className="page-head">
        <div><h2>Alarms</h2><p>{alarms.loading ? "…" : `${rows.length} active across the fleet`}</p></div>
        {rows.length > 0 && <button className="btn" disabled={resolvingAll} onClick={resolveAll}>{resolvingAll ? "Resolving…" : "Resolve all"}</button>}
      </div>
      <div className="card">
        {alarms.error && <div style={{ padding:16 }}><ErrorAlert error={alarms.error} onRetry={alarms.reload}/></div>}
        <div className="card-body tight">
          {alarms.loading && <div style={{ padding:16 }}><Skeleton h={60}/></div>}
          {!alarms.loading && rows.length === 0 && <div style={{ padding:24, color:"var(--text-3)" }}>No active alarms.</div>}
          {!alarms.loading && rows.map(a => (
            <div key={a.id} style={{ display:"flex", gap:14, padding:"14px 18px", borderBottom:"1px solid var(--line)", alignItems:"center" }}>
              <div className={"sev-strip " + a.severity}/>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontWeight:500 }}>{a.message}</div>
                <div className="muted" style={{ fontSize:12, marginTop:2 }}>{a.deviceId && <span className="mono">{a.deviceId}</span>} · {fmtAgo(a.createdAt)}</div>
              </div>
              <span className={"pill " + (a.severity === "critical" ? "crit" : a.severity === "warning" ? "warn" : "accent")}>{a.severity}</span>
              <button className="btn sm ghost" onClick={() => resolve(a.id)}>Resolve</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- Audit ----------
/**
 * Renders the audit page UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function AuditPage({ globalSearch = "" }) {
  const audit = useResource(() => PatchAPI.audit(100));
  useLiveResource(audit, 10_000);
  const rows = (audit.data || []).filter(e => textMatches(globalSearch, [e.actor, e.action, e.target, e.id]));
  return (
    <div className="page">
      <div className="page-head">
        <div><h2>Audit log</h2><p>Signed event stream for compliance review</p></div>
        <button className="btn"><span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.download}</span>Export</button>
      </div>
      <div className="card">
        {audit.error && <div style={{ padding:16 }}><ErrorAlert error={audit.error} onRetry={audit.reload}/></div>}
        <table className="tbl">
          <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead>
          <tbody>
            {audit.loading && <SkeletonRows n={6} cols={4}/>}
            {!audit.loading && rows.length === 0 && <tr><td colSpan={4} style={{ padding:24, color:"var(--text-3)" }}>No audit events.</td></tr>}
            {!audit.loading && rows.map((e,i) => (
              <tr key={e.id || i}>
                <td className="muted">{fmtAgo(e.createdAt)}</td>
                <td className="mono">{e.actor}</td>
                <td><span className="pill">{e.action}</span></td>
                <td>{e.target || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- SIEM ----------
/**
 * Renders the siem page UI.
 * @returns The result produced by the operation.
 */
function SiemPage() {
  const [tenantId, setTenantId] = useState("default");
  const [form, setForm] = useState(defaultSiemConfig());
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState("");
  const config = useResource(() => PatchAPI.siemConfig(tenantId).catch(() => ({ tenantId, config: defaultSiemConfig() })), [tenantId]);
  const queue = useResource(() => PatchAPI.siemQueueStatus());
  useLiveResource(queue, 10_000);

  useEffect(() => {
    if (config.data?.config) setForm(mergeSiemConfig(config.data.config));
  }, [config.data]);

  /**
   * Sets the set value.
   *
   * @param path Filesystem or URL path used by the operation.
   * @param value Value to read, render, or store.
   */
  const set = (path, value) => {
    setForm(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      const parts = path.split(".");
      let cur = next;
      for (const part of parts.slice(0, -1)) cur = cur[part] = cur[part] || {};
      cur[parts[parts.length - 1]] = value;
      return next;
    });
  };

  /**
   * Handles the payload operation.
   * @returns The result produced by the operation.
   */
  const payload = () => {
    const next = mergeSiemConfig(form);
    if (!next.webhook.url) delete next.webhook;
    if (!next.syslog.host) delete next.syslog;
    if (!next.sentinel.workspaceId) delete next.sentinel;
    return next;
  };

  /**
   * Handles the run operation.
   *
   * @param kind kind supplied to the function.
   */
  const run = async (kind) => {
    setBusy(kind); setNotice(null);
    try {
      const result = kind === "save"
        ? await PatchAPI.saveSiemConfig(tenantId, payload())
        : kind === "test"
          ? await PatchAPI.testSiem(tenantId)
          : await PatchAPI.verifySiem(tenantId);
      setNotice({ ok: true, text: kind === "save" ? "SIEM configuration saved." : JSON.stringify(result.results || result, null, 2) });
      config.reload(true);
      queue.reload(true);
    } catch (err) {
      setNotice({ ok: false, text: err?.message || String(err) });
    } finally {
      setBusy("");
    }
  };

  const webhookConfigured = !!form.webhook.url;
  const syslogConfigured  = !!form.syslog.host;
  const sentinelConfigured = !!form.sentinel.workspaceId;
  const queueDepth = queue.loading ? null : (queue.data?.queueDepth ?? 0);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>SIEM integrations</h2>
          <p>Export security events to Webhook, Syslog, and Microsoft Sentinel</p>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button className="btn" disabled={busy} onClick={() => run("verify")}>{busy === "verify" ? "Checking…" : "Verify"}</button>
          <button className="btn" disabled={busy} onClick={() => run("test")}>{busy === "test" ? "Sending…" : "Test"}</button>
          <button className="btn primary" disabled={busy} onClick={() => run("save")}>{busy === "save" ? "Saving…" : "Save"}</button>
        </div>
      </div>

      {config.error && <ErrorAlert error={config.error} onRetry={config.reload}/>}

      {notice && (
        <div className={`siem-notice ${notice.ok ? "ok" : "err"}`}>
          <span className="siem-notice-icon">
            {notice.ok
              ? <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 4L6.5 11 3 7.5"/></svg>
              : <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 5v4M8 11v1"/><circle cx="8" cy="8" r="6.5"/></svg>}
          </span>
          <pre style={{ margin:0, whiteSpace:"pre-wrap", flex:1, fontFamily:"inherit", fontSize:13 }}>{notice.text}</pre>
          <button className="btn ghost sm" style={{ flexShrink:0 }} onClick={() => setNotice(null)}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M1 1l10 10M11 1 1 11"/></svg>
          </button>
        </div>
      )}

      {/* Config strip */}
      <div className="siem-config-strip">
        <div className="siem-config-group">
          <span className="siem-config-label">Tenant</span>
          <input
            className="siem-config-input"
            value={tenantId}
            onChange={e => setTenantId(e.target.value || "default")}
          />
        </div>
        <div className="siem-config-sep"/>
        <div className="siem-config-group">
          <span className="siem-config-label">Export mode</span>
          <div className="segmented">
            {["minimal","standard","full"].map(m => (
              <button key={m} className={form.mode === m ? "active" : ""} onClick={() => set("mode", m)}>{m}</button>
            ))}
          </div>
        </div>
        <div className="siem-config-sep"/>
        <div className="siem-config-group" style={{ marginLeft:"auto" }}>
          <span className="siem-config-label">Queue depth</span>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span className={`siem-queue-dot ${queueDepth > 0 ? "active" : ""}`}/>
            <span className="siem-queue-num">{queueDepth === null ? "…" : queueDepth}</span>
          </div>
        </div>
      </div>

      {/* Integration cards */}
      <div className="row-3">

        {/* Webhook */}
        <div className="card siem-card">
          <div className="siem-card-accent" style={{ background:"var(--accent)" }}/>
          <div className="card-head" style={{ gap:12 }}>
            <div className="siem-card-icon" style={{ background:"var(--accent-soft)", color:"var(--accent)" }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 8c0-3.3 2.7-6 6-6"/>
                <path d="M14 8c0 3.3-2.7 6-6 6"/>
                <path d="M9 5l3 3-3 3"/>
                <path d="M7 11l-3-3 3-3"/>
              </svg>
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <h3 style={{ margin:0, fontSize:14, fontWeight:600 }}>Webhook</h3>
              <div className="sub">HTTPS JSON array export</div>
            </div>
            <span className={`pill ${webhookConfigured ? "ok" : ""}`}>{webhookConfigured ? "active" : "not set"}</span>
          </div>
          <div className="card-body" style={{ display:"flex", flexDirection:"column", gap:14 }}>
            <label className="field"><span>URL</span><input value={form.webhook.url} onChange={e => set("webhook.url", e.target.value)} placeholder="https://siem.example/events"/></label>
            <label className="field"><span>HMAC secret</span><input type="password" value={form.webhook.secret} onChange={e => set("webhook.secret", e.target.value)} placeholder="optional"/></label>
          </div>
        </div>

        {/* Syslog */}
        <div className="card siem-card">
          <div className="siem-card-accent" style={{ background:"var(--warn)" }}/>
          <div className="card-head" style={{ gap:12 }}>
            <div className="siem-card-icon" style={{ background:"var(--warn-soft)", color:"var(--warn)" }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/>
                <path d="M4.5 6l2.5 2.5L4.5 11"/>
                <path d="M9 11h2.5"/>
              </svg>
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <h3 style={{ margin:0, fontSize:14, fontWeight:600 }}>Syslog</h3>
              <div className="sub">RFC5424 UDP or TCP</div>
            </div>
            <span className={`pill ${syslogConfigured ? "ok" : ""}`}>{syslogConfigured ? "active" : "not set"}</span>
          </div>
          <div className="card-body" style={{ display:"flex", flexDirection:"column", gap:14 }}>
            <label className="field"><span>Host</span><input value={form.syslog.host} onChange={e => set("syslog.host", e.target.value)} placeholder="syslog.example"/></label>
            <label className="field"><span>Port</span><input type="number" value={form.syslog.port} onChange={e => set("syslog.port", Number(e.target.value || 514))}/></label>
            <label className="field"><span>Protocol</span><select className="siem-select" value={form.syslog.protocol} onChange={e => set("syslog.protocol", e.target.value)}><option value="udp">udp</option><option value="tcp">tcp</option></select></label>
          </div>
        </div>

        {/* Microsoft Sentinel */}
        <div className="card siem-card">
          <div className="siem-card-accent" style={{ background:"oklch(0.55 0.18 290)" }}/>
          <div className="card-head" style={{ gap:12 }}>
            <div className="siem-card-icon" style={{ background:"oklch(0.95 0.04 290)", color:"oklch(0.45 0.18 290)" }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 1.5L2 4v4c0 3.3 2.5 5.7 6 6.5 3.5-.8 6-3.2 6-6.5V4L8 1.5z"/>
                <path d="M5.5 8.5l2 2 3.5-3.5"/>
              </svg>
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <h3 style={{ margin:0, fontSize:14, fontWeight:600 }}>Microsoft Sentinel</h3>
              <div className="sub">Log Analytics Data Collector API</div>
            </div>
            <span className={`pill ${sentinelConfigured ? "ok" : ""}`}>{sentinelConfigured ? "active" : "not set"}</span>
          </div>
          <div className="card-body" style={{ display:"flex", flexDirection:"column", gap:14 }}>
            <label className="field"><span>Workspace ID</span><input value={form.sentinel.workspaceId} onChange={e => set("sentinel.workspaceId", e.target.value)} placeholder="workspace-guid"/></label>
            <label className="field"><span>Shared key</span><input type="password" value={form.sentinel.sharedKey} onChange={e => set("sentinel.sharedKey", e.target.value)} placeholder="base64 key"/></label>
            <label className="field"><span>Log type</span><input value={form.sentinel.logType} onChange={e => set("sentinel.logType", e.target.value || "OnePatchEvents")}/></label>
          </div>
        </div>

      </div>
    </div>
  );
}

/**
 * Handles the default siem config operation.
 * @returns The result produced by the operation.
 */
function defaultSiemConfig() {
  return {
    mode: "standard",
    webhook: { url: "", secret: "" },
    syslog: { host: "", port: 514, protocol: "udp", appName: "1patch" },
    sentinel: { workspaceId: "", sharedKey: "", logType: "OnePatchEvents" },
    exportOverrides: {},
  };
}

/**
 * Handles the merge siem config operation.
 *
 * @param config Configuration object used by the operation.
 * @returns The result produced by the operation.
 */
function mergeSiemConfig(config) {
  const base = defaultSiemConfig();
  return {
    ...base,
    ...config,
    webhook: { ...base.webhook, ...(config.webhook || {}) },
    syslog: { ...base.syslog, ...(config.syslog || {}) },
    sentinel: { ...base.sentinel, ...(config.sentinel || {}) },
    exportOverrides: config.exportOverrides || {},
  };
}

// ---------- Security Posture ----------
/**
 * Renders the security posture page UI.
 * @returns The result produced by the operation.
 */
function SecurityPosturePage() {
  const [tenantId, setTenantId] = useState("default");
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState("");
  const posture = useResource(() => PatchAPI.securityPosture(tenantId), [tenantId]);
  const report = posture.data;
  const critical = report?.findingsBySeverity?.critical || [];
  const findings = report?.findings || [];
  const safeFixCount = findings.filter(f => f.autoFixAvailable && f.severity !== "critical").length;

  /**
   * Handles the rerun operation.
   */
  const rerun = () => {
    setNotice(null);
    posture.reload(false);
  };
  /**
   * Handles the apply safe operation.
   */
  const applySafe = async () => {
    setBusy("fix");
    setNotice(null);
    try {
      const result = await PatchAPI.fixSecurityPosture(tenantId);
      setNotice({ ok: true, text: `Applied ${result.applied.length} safe fix${result.applied.length === 1 ? "" : "es"}.` });
      posture.reload(true);
    } catch (err) {
      setNotice({ ok: false, text: err?.message || String(err) });
    } finally {
      setBusy("");
    }
  };
  /**
   * Handles the export json operation.
   */
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `1patch-security-posture-${tenantId}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const scoreTone = report?.score >= 85 ? "ok" : report?.score >= 70 ? "warn" : "crit";

  return (
    <div className="page posture-page">
      <div className="page-head">
        <div>
          <h2>Security Posture</h2>
          <p>Auditable setup health for enterprise readiness</p>
        </div>
        <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
          <label className="posture-tenant">
            <span>Tenant</span>
            <input value={tenantId} onChange={e => setTenantId(e.target.value || "default")}/>
          </label>
          <button className="btn" onClick={rerun} disabled={posture.loading}>
            <span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.refresh}</span>Re-run check
          </button>
          <button className="btn" onClick={exportJson} disabled={!report}>
            <span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.download}</span>Export JSON
          </button>
          <button className="btn" onClick={() => window.print()} disabled={!report}>Export PDF</button>
          <button className="btn primary" onClick={applySafe} disabled={!safeFixCount || busy === "fix"}>
            {busy === "fix" ? "Applying..." : `Apply safe fixes${safeFixCount ? ` (${safeFixCount})` : ""}`}
          </button>
        </div>
      </div>

      {posture.error && <ErrorAlert error={posture.error} onRetry={posture.reload}/>}
      {notice && <div className="alert" style={{ borderColor: notice.ok ? "var(--ok)" : "var(--crit)", background: notice.ok ? "var(--ok-soft)" : "var(--crit-soft)", color: notice.ok ? "var(--ok)" : "var(--crit)" }}>{notice.text}</div>}

      <div className="posture-hero card">
        <div className="posture-score">
          {posture.loading ? <Skeleton w={132} h={132} r={66}/> : <Donut value={report?.score ?? 0}/>}
        </div>
        <div className="posture-summary">
          <div className="pulse-sub">Overall security score</div>
          <div className={`posture-score-text ${scoreTone}`}>{posture.loading ? "..." : `${report.score}/100`}</div>
          <div className="posture-meta">
            <span className={`pill ${modeTone(report?.mode)}`}>{report?.mode || "..."}</span>
            <span>Last checked {report ? fmtAgo(report.generatedAt) : "..."}</span>
          </div>
        </div>
        <div className="posture-verdict">
          {posture.loading ? <Skeleton h={80}/> : (
            <React.Fragment>
              <strong>{enterpriseVerdict(report.score, critical.length)}</strong>
              <span>{critical.length ? `${critical.length} critical issue${critical.length === 1 ? "" : "s"} must be fixed first.` : "No critical issues detected in the current posture checks."}</span>
            </React.Fragment>
          )}
        </div>
      </div>

      {critical.length > 0 && (
        <div className="card posture-critical">
          <div className="card-head"><div><h3>Critical issues</h3><div className="sub">Fix these before treating the tenant as enterprise-ready</div></div></div>
          <div className="card-body posture-finding-list">
            {critical.map(f => <SecurityFindingCard key={f.id} finding={f} onFix={applySafe} busy={busy}/>)}
          </div>
        </div>
      )}

      <div className="posture-categories">
        {(report?.categoryBreakdown || []).map(category => (
          <div className={`posture-category ${category.status}`} key={category.category}>
            <div>
              <strong>{category.label}</strong>
              <span>{category.findingCount ? `${category.findingCount} issue${category.findingCount === 1 ? "" : "s"}` : "No findings"}</span>
            </div>
            <span className={`pill ${category.status === "critical" ? "crit" : category.status === "warning" ? "warn" : "ok"}`}>{category.status}</span>
          </div>
        ))}
        {posture.loading && Array.from({ length: 8 }).map((_, i) => <div className="posture-category" key={i}><Skeleton w={130}/><Skeleton w={62}/></div>)}
      </div>

      <div className="card">
        <div className="card-head">
          <div><h3>Findings</h3><div className="sub">{posture.loading ? "Loading" : `${findings.length} total`}</div></div>
        </div>
        <div className="card-body posture-finding-list">
          {posture.loading && Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} h={92}/>)}
          {!posture.loading && findings.length === 0 && <div className="empty">No posture findings detected.</div>}
          {!posture.loading && findings.map(f => <SecurityFindingCard key={f.id} finding={f} onFix={applySafe} busy={busy}/>)}
        </div>
      </div>
    </div>
  );
}

/**
 * Renders the security finding card UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function SecurityFindingCard({ finding, onFix, busy }) {
  return (
    <div className={`posture-finding ${finding.severity}`}>
      <div className="posture-finding-main">
        <div className="posture-finding-title">
          <strong>{finding.title}</strong>
          <span className={`pill ${severityTone(finding.severity)}`}>{finding.severity}</span>
        </div>
        <p>{finding.description}</p>
        <dl>
          <dt>Risk</dt><dd>{finding.riskExplanation}</dd>
          <dt>Fix</dt><dd>{finding.fixSuggestion}</dd>
        </dl>
      </div>
      <div className="posture-finding-actions">
        {finding.autoFixAvailable
          ? <button className="btn sm" onClick={onFix} disabled={busy === "fix" || finding.severity === "critical"}>{finding.severity === "critical" ? "Confirm manually" : "Fix"}</button>
          : <span className="muted">Manual</span>}
      </div>
    </div>
  );
}

/**
 * Handles the severity tone operation.
 *
 * @param severity severity supplied to the function.
 * @returns The result produced by the operation.
 */
function severityTone(severity) {
  return severity === "critical" ? "crit" : severity === "high" || severity === "medium" ? "warn" : "accent";
}
/**
 * Handles the mode tone operation.
 *
 * @param mode mode supplied to the function.
 * @returns The result produced by the operation.
 */
function modeTone(mode) {
  return mode === "tinfoil" ? "crit" : mode === "strict" ? "ok" : "warn";
}
/**
 * Handles the enterprise verdict operation.
 *
 * @param score score supplied to the function.
 * @param criticalCount critical count supplied to the function.
 * @returns The result produced by the operation.
 */
function enterpriseVerdict(score, criticalCount) {
  if (criticalCount > 0) return "Not enterprise-ready yet";
  if (score >= 85) return "Enterprise-ready posture";
  if (score >= 70) return "Close, with remediation needed";
  return "Needs security hardening";
}

// ---------- Device drawer ----------
/**
 * Renders the device drawer UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function DeviceDrawer({ deviceId, onClose }) {
  const detail = useResource(() => PatchAPI.device(deviceId), [deviceId]);
  useLiveResource(detail, 2_500);
  const [deviceNotice, setDeviceNotice] = useState(null);
  const [queuingApp, setQueuingApp] = useState(null);
  if (!deviceId) return null;
  const d = detail.data?.device;
  const apps = detail.data?.installedApps || [];
  const tasks = sortTasksNewestFirst(detail.data?.tasks || []);

  // compute "outdated" client-side from latest version per app/publisher across the response
  const latest = new Map();
  for (const a of apps) {
    const k = `${a.name}|${a.publisher || ""}`;
    const version = a.latestVersion || a.version;
    if (!latest.has(k) || version.localeCompare(latest.get(k), undefined, { numeric:true }) > 0) latest.set(k, version);
  }
  const outdated = apps.filter(a => a.version !== latest.get(`${a.name}|${a.publisher || ""}`)).length;
  const platform = d?.platform || (/(windows|win)/i.test(d?.os || "") ? "windows" : "linux");
  const online = d?.lastSeenAt ? Date.now() - new Date(d.lastSeenAt).getTime() < 2 * 60_000 : false;

  /**
   * Handles the refresh operation.
   */
  const refresh = async () => { try { await PatchAPI.refreshInventory(deviceId); } finally { detail.reload(); } };
  /**
   * Updates the all record or state.
   */
  const updateAll = async () => {
    try {
      const result = await PatchAPI.updateAllOutdated(deviceId);
      const count = result?.tasks?.length ?? 0;
      const msg = count > 0
        ? `Queued ${count} update task${count !== 1 ? "s" : ""}.`
        : "All apps are already up to date.";
      setDeviceNotice({ ok: count > 0, msg });
      setTimeout(() => setDeviceNotice(null), 5000);
    } finally {
      detail.reload();
    }
  };
  /**
   * Updates the app record or state.
   *
   * @param app app supplied to the function.
   */
  const updateApp = async (app) => {
    const key = `${app.name}|${app.publisher || ""}`;
    if (queuingApp === key) return;
    setQueuingApp(key);
    try {
      await PatchAPI.updateDeviceForApp(app.name, {
        deviceId,
        packageId: app.packageId,
        productCode: app.productCode,
        targetVersion: 'latest',
      });
      setDeviceNotice({ ok: true, msg: `Queued update for ${app.name}.` });
      detail.reload();
    } catch (e) {
      setDeviceNotice({ ok: false, msg: `Failed to queue update for ${app.name}: ${e?.message ?? "unknown error"}` });
    } finally {
      setQueuingApp(null);
      setTimeout(() => setDeviceNotice(null), 5000);
    }
  };

  return (
    <React.Fragment>
      <div className="drawer-backdrop" onClick={onClose}/>
      <div className="drawer">
        <div className="drawer-head">
          <h3>
            {d ? <OsIcon platform={platform}/> : null}
            <span className="mono">{d?.hostname || deviceId}</span>
            {d && <StatusPill status={online ? "online" : "offline"}/>}
          </h3>
          <button className="icon-btn" onClick={onClose}><span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.close}</span></button>
        </div>
        <div className="drawer-body">
          {detail.error && <ErrorAlert error={detail.error} onRetry={detail.reload}/>}
          {detail.loading && <Skeleton h={240}/>}
          {!detail.loading && d && (
            <React.Fragment>
              <div className="drawer-actions">
                <button className="btn primary" onClick={refresh}>Refresh inventory</button>
                <button className="btn accent" onClick={updateAll}>Update all ({outdated})</button>
              </div>
              {deviceNotice && (
                <div className={`toast-inline${deviceNotice.ok ? "" : " error"}`} style={{ margin:"0 0 12px" }}>
                  {deviceNotice.msg}
                </div>
              )}
              <div className="card">
                <div className="card-body">
                  <dl className="kv">
                    <dt>Device ID</dt><dd className="mono">{d.id}</dd>
                    <dt>OS</dt><dd>{formatOs(d.os)}</dd>
                    <dt>Site</dt><dd>{d.site || "—"}</dd>
                    <dt>Backend node</dt><dd className="mono">{d.preferredNodeId || "—"}</dd>
                    <dt>Last seen</dt><dd>{fmtAgo(d.lastSeenAt)}</dd>
                    <dt>Apps</dt><dd>{apps.length} installed · <span style={{ color: outdated ? "var(--warn)" : "var(--text-3)" }}>{outdated} outdated</span></dd>
                  </dl>
                </div>
              </div>

              <div className="card">
                <div className="card-head"><h3>Installed apps</h3><div className="sub">{apps.length}</div></div>
                <div style={{ maxHeight:280, overflowY:"auto" }}>
                  <table className="tbl">
                    <thead><tr><th>App</th><th>Installed</th><th>Latest</th><th></th></tr></thead>
                    <tbody>
                      {apps.map((a,i) => {
                        const want = a.latestVersion || latest.get(`${a.name}|${a.publisher || ""}`);
                        const isOutdated = a.version !== want;
                        const key = `${a.name}|${a.publisher || ""}`;
                        return (
                          <tr key={i}>
                            <td>{a.name}</td>
                            <td className="mono" style={{ color: isOutdated ? "var(--warn)" : "var(--text)" }}>{a.version}</td>
                            <td className="mono muted">{want}</td>
                            <td>{isOutdated && <button className="btn sm" disabled={queuingApp === key} onClick={() => updateApp(a)}>{queuingApp === key ? "Queuing…" : "Update"}</button>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {tasks.length > 0 && (
                <div className="card">
                  <div className="card-head"><h3>Tasks</h3><div className="sub">{tasks.length}</div></div>
                  <div className="drawer-table-scroll">
                    <table className="tbl">
                      <thead><tr><th>App</th><th>Version</th><th>Status</th></tr></thead>
                      <tbody>
                        {tasks.map(t => (
                          <tr key={t.id}>
                            <td>{taskLabel(t)}</td>
                            <td className="mono muted">{taskVersionLabel(t)}</td>
                            <td><StatusPill status={t.status}/></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </React.Fragment>
          )}
        </div>
      </div>
    </React.Fragment>
  );
}

// ── SSO Settings Page ──────────────────────────────────────────────────────

const SSO_PROVIDER_LABELS = {
  microsoft: 'Microsoft Entra ID',
  google:    'Google Workspace',
  github:    'GitHub',
  okta:      'Okta',
  oidc:      'Generic OIDC',
};

const SSO_PROVIDER_META = [
  { type: 'microsoft', label: 'Microsoft Entra ID', desc: 'Azure AD · Office 365', badge: 'Popular' },
  { type: 'google',    label: 'Google Workspace',   desc: 'Google accounts' },
  { type: 'github',    label: 'GitHub',             desc: 'GitHub.com or GHES' },
  { type: 'okta',      label: 'Okta',               desc: 'Okta Universal Directory' },
  { type: 'oidc',      label: 'Generic OIDC',       desc: 'Any OIDC-compliant IdP' },
];

const SSO_ROLE_OPTIONS = [
  { value: 'viewer',        label: 'Viewer' },
  { value: 'auditor',       label: 'Auditor' },
  { value: 'node_operator', label: 'Node Operator' },
  { value: 'patch_manager', label: 'Patch Manager' },
  { value: 'admin',         label: 'Admin' },
];

function roleLabel(role, rbac) {
  return (rbac?.roleDefinitions || []).find(r => r.id === role)?.name || role;
}

function roleOptionsFromRbac(rbac) {
  const definitions = rbac?.roleDefinitions || [];
  return definitions.length
    ? definitions.map(role => ({ value: role.id, label: role.name || role.id }))
    : SSO_ROLE_OPTIONS;
}

const SSO_SETUP_GUIDE = {
  microsoft: {
    portalUrl:   'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    portalLabel: 'Open Azure Portal',
    steps: [
      { text: 'Go to Azure Portal → App registrations' },
      { text: 'Click New registration and give the app a name (e.g. "1Patch")' },
      { text: 'Choose Supported account types — Single tenant for your org only, or Multitenant / organizations for any work account' },
      { text: 'Under Redirect URI, select Web and paste this callback URL:', uri: true },
      { text: 'Click Register — note the Application (client) ID and Directory (tenant) ID from the Overview page' },
      { text: 'Go to Certificates & secrets → New client secret → copy the Value (not the Secret ID)' },
    ],
    tip: {
      title: 'Security recommendations',
      items: [
        {
          heading: 'Restrict sign-in to specific groups',
          text: 'By default, any user in your tenant can authenticate. Set the app to require explicit assignment.',
          steps: [
            'Open Enterprise applications and find the app you just registered',
            'Under Properties, set "Assignment required?" to Yes',
            'Under Users and groups, add the groups or users allowed to sign in to 1Patch',
          ],
          linkUrl:   'https://portal.azure.com/#view/Microsoft_AAD_IAM/StartboardApplicationsMenuBlade/~/AppAppsPreview',
          linkLabel: 'Enterprise applications',
        },
        {
          heading: 'Configure Conditional Access',
          text: 'Enforce MFA, require compliant devices, or restrict by location for all 1Patch sign-ins.',
          steps: [
            'Go to Azure AD → Security → Conditional Access → New policy',
            'Under Cloud apps, select the 1Patch app registration',
            'Add conditions (device compliance, named location, sign-in risk) and require MFA as a grant control',
          ],
          linkUrl:   'https://portal.azure.com/#view/Microsoft_AAD_ConditionalAccess/CaTemplates.ReactView',
          linkLabel: 'Conditional Access',
        },
        {
          heading: 'Rotate client secrets before expiry',
          text: 'Client secrets have a fixed expiry. Letting one expire will break SSO until rotated.',
          steps: [
            'In App registrations → Certificates & secrets, note the expiry date of your secret',
            'Create a new secret before it expires, update it in 1Patch (Settings → Edit), then delete the old one',
          ],
          linkUrl:   null,
          linkLabel: null,
        },
        {
          heading: 'Monitor sign-in activity',
          text: 'Review Entra sign-in logs regularly to detect anomalous or unexpected access.',
          steps: [
            'Azure AD → Monitoring → Sign-in logs — filter by your app to see all authentications',
            'Consider exporting logs to a Log Analytics workspace or SIEM via Diagnostic settings',
          ],
          linkUrl:   'https://portal.azure.com/#view/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/~/SignIns',
          linkLabel: 'Sign-in logs',
        },
      ],
    },
  },
  google: {
    portalUrl:   'https://console.cloud.google.com/apis/credentials',
    portalLabel: 'Open Google Cloud Console',
    steps: [
      { text: 'Go to APIs & Services → Credentials' },
      { text: 'Click Create credentials → OAuth client ID' },
      { text: 'Application type: Web application' },
      { text: 'Under Authorized redirect URIs, paste this URL:', uri: true },
      { text: 'Copy the Client ID and Client secret from the confirmation dialog' },
    ],
    tip: {
      title: 'Security recommendations',
      items: [
        {
          heading: 'Restrict to your Google Workspace org',
          text: 'By default, any Google account can authenticate — including personal accounts.',
          steps: [
            'Go to APIs & Services → OAuth consent screen',
            'Set User type to Internal to limit sign-in to your Workspace org only',
            'For partner domains, use the "Allowed email domains" field in the next step instead',
          ],
          linkUrl:   'https://console.cloud.google.com/apis/credentials/consent',
          linkLabel: 'OAuth consent screen',
        },
        {
          heading: 'Configure Context-Aware Access',
          text: 'Google Workspace\'s equivalent of Conditional Access — restrict by device trust level, location, or IP range.',
          steps: [
            'In Google Admin → Security → Access and data control → Context-Aware Access',
            'Create an access level (e.g. require corp device or specific IP range)',
            'Assign the access level to the OAuth app under "App access control"',
          ],
          linkUrl:   'https://admin.google.com/ac/contextawareaccess/accesslevel',
          linkLabel: 'Context-Aware Access',
        },
        {
          heading: 'Enforce 2-Step Verification',
          text: 'Require 2SV for all users in your org before they can authenticate to any app including 1Patch.',
          steps: [
            'Google Admin → Security → 2-Step Verification → turn on enforcement for your org',
          ],
          linkUrl:   'https://admin.google.com/ac/security/2sv',
          linkLabel: 'Google Admin 2SV',
        },
        {
          heading: 'Review OAuth app access',
          text: 'Audit which apps have access to your users\' data in the Google security dashboard.',
          steps: [
            'Google Admin → Security → API controls → App access control — review and revoke as needed',
          ],
          linkUrl:   null,
          linkLabel: null,
        },
      ],
    },
  },
  github: {
    portalUrl:   'https://github.com/settings/developers',
    portalLabel: 'Open GitHub Developer Settings',
    steps: [
      { text: 'Go to Settings → Developer settings → OAuth Apps → New OAuth App' },
      { text: 'Fill in Application name and Homepage URL' },
      { text: 'Under Authorization callback URL, paste this URL:', uri: true },
      { text: 'Click Register application, then generate a new client secret' },
    ],
    tip: {
      title: 'Security recommendations',
      items: [
        {
          heading: 'GitHub OAuth cannot restrict by org membership',
          text: 'Unlike Entra or Okta, GitHub OAuth Apps have no native group restriction. Use these controls instead.',
          steps: [
            'Set "Allowed email domains" in the next step to your company domain — this blocks personal GitHub accounts',
            'Keep auto-provision off and manually approve each user after their first sign-in',
          ],
          linkUrl:   null,
          linkLabel: null,
        },
        {
          heading: 'Require 2FA for all organization members',
          text: 'Enforce two-factor authentication for your GitHub org — accounts without 2FA will be blocked.',
          steps: [
            'GitHub → Your organization → Settings → Authentication security → Require two-factor authentication',
          ],
          linkUrl:   'https://github.com/organizations',
          linkLabel: 'GitHub Organization settings',
        },
        {
          heading: 'Rotate the client secret periodically',
          text: 'GitHub client secrets don\'t expire automatically, but rotating them limits exposure if leaked.',
          steps: [
            'In your OAuth App settings, click "Generate a new client secret"',
            'Update the secret in 1Patch (Settings → Edit), then delete the old one from GitHub',
          ],
          linkUrl:   'https://github.com/settings/developers',
          linkLabel: 'GitHub Developer settings',
        },
      ],
    },
  },
  okta: {
    portalUrl:   null,
    portalLabel: 'Open Okta Admin Console',
    steps: [
      { text: 'Go to Applications → Create App Integration' },
      { text: 'Choose OIDC – OpenID Connect → Web Application' },
      { text: 'Under Sign-in redirect URIs, paste this URL:', uri: true },
      { text: 'Copy the Client ID and Client secret, and note your Okta domain' },
    ],
    tip: {
      title: 'Security recommendations',
      items: [
        {
          heading: 'Restrict sign-in to specific groups',
          text: 'By default the app is accessible to everyone in your org. Limit it to specific groups.',
          steps: [
            'Open the application in Okta Admin Console',
            'Go to the Assignments tab → change from "Everyone" to specific groups',
            'Add only the groups that should have access to 1Patch',
          ],
          linkUrl:   null,
          linkLabel: null,
        },
        {
          heading: 'Configure an MFA sign-on policy',
          text: 'Require MFA specifically for 1Patch sign-ins, independently of your global Okta policy.',
          steps: [
            'In the application, go to the Sign On tab → Sign On Policy',
            'Add a rule that requires MFA for all users (or a subset based on group or network zone)',
          ],
          linkUrl:   null,
          linkLabel: null,
        },
        {
          heading: 'Set session and token lifetime',
          text: 'Limit how long an Okta session is valid to reduce the window of a stolen token.',
          steps: [
            'In Sign On Policy, configure "Max Okta session" and set a reasonable idle/max duration',
            'Consider setting a short access token lifetime for API-facing apps',
          ],
          linkUrl:   null,
          linkLabel: null,
        },
        {
          heading: 'Monitor with the Okta System Log',
          text: 'Review authentication events and failed logins for 1Patch in the Okta System Log.',
          steps: [
            'Okta Admin Console → Reports → System Log — filter by your app client ID',
            'Set up a log streaming integration to send events to your SIEM',
          ],
          linkUrl:   null,
          linkLabel: null,
        },
      ],
    },
  },
  oidc: {
    portalUrl:   null,
    portalLabel: null,
    steps: [
      { text: 'Register 1Patch as an OAuth 2.0 client in your identity provider' },
      { text: 'Set the redirect / callback URI to this URL:', uri: true },
      { text: 'Ensure the provider exposes /.well-known/openid-configuration (OIDC discovery)' },
      { text: 'Note the Client ID, Client secret, and the discovery base URL' },
    ],
    tip: {
      title: 'Security recommendations',
      items: [
        {
          heading: 'Restrict access at the identity provider level',
          text: 'Most OIDC providers support app assignment or group-based access — check your provider\'s documentation.',
          steps: [
            'Use the "Allowed email domains" field in the next step as a baseline domain filter',
            'Disable auto-provision and manually approve users for tighter control',
          ],
          linkUrl:   null,
          linkLabel: null,
        },
        {
          heading: 'Use short-lived tokens where possible',
          text: 'Configure your IdP to issue short access token lifetimes to reduce the impact of a leaked token.',
          steps: [
            'Check your provider\'s token lifetime settings and set access tokens to 15–60 minutes',
            '1Patch uses server-side sessions so users will re-authenticate via SSO when the token expires',
          ],
          linkUrl:   null,
          linkLabel: null,
        },
        {
          heading: 'Rotate the client secret regularly',
          text: 'Rotate credentials at least annually, or immediately if you suspect exposure.',
          steps: [
            'Generate a new client secret in your IdP',
            'Update it in 1Patch (Settings → Edit provider) before deleting the old one',
          ],
          linkUrl:   null,
          linkLabel: null,
        },
      ],
    },
  },
};

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };
  return (
    <button type="button" className={`sso-copy-btn ${copied ? 'copied' : ''}`} onClick={copy}>
      {copied ? <>{Icon.check} Copied</> : <>{Icon.copy} Copy</>}
    </button>
  );
}

function ToggleSwitch({ checked, onChange, label }) {
  return (
    <label className="toggle-switch" aria-label={label}>
      <input type="checkbox" checked={checked} onChange={onChange}/>
      <span className="toggle-track"/>
    </label>
  );
}

// ── Wizard step indicator ──────────────────────────────────────────────────

function SsoWizardSteps({ current }) {
  const steps = ['Provider', 'Setup', 'Credentials', 'Access'];
  return (
    <div className="sso-wizard-steps">
      {steps.map((label, i) => {
        const n = i + 1;
        const state = n < current ? 'done' : n === current ? 'active' : 'idle';
        return (
          <React.Fragment key={n}>
            {i > 0 && <div className={`sso-wizard-connector ${n <= current ? 'filled' : ''}`}/>}
            <div className={`sso-wizard-step-dot ${state}`}>
              <div className="sso-wizard-dot-num">
                {state === 'done' ? Icon.check : n}
              </div>
              <span className="sso-wizard-dot-label">{label}</span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ── Step 1: Choose provider type ──────────────────────────────────────────

function SsoTypeStep({ type, setType, onNext, onCancel }) {
  return (
    <div className="sso-wizard-body">
      <div className="sso-wizard-header">
        <h3>Choose an identity provider</h3>
        <p>Select the SSO provider your organization uses.</p>
      </div>
      <div className="sso-type-grid">
        {SSO_PROVIDER_META.map(p => (
          <button key={p.type} type="button"
            className={`sso-type-card ${type === p.type ? 'selected' : ''}`}
            onClick={() => setType(p.type)}
          >
            {p.badge && <span className="sso-type-badge">{p.badge}</span>}
            <div className="sso-type-card-icon">
              <SsoProviderIcon type={p.type} size={26}/>
            </div>
            <span className="sso-type-card-label">{p.label}</span>
            <span className="sso-type-card-desc">{p.desc}</span>
          </button>
        ))}
      </div>
      <div className="sso-wizard-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn primary" onClick={onNext}>
          Continue <span className="btn-icon">{Icon.arrowR}</span>
        </button>
      </div>
    </div>
  );
}

// ── Setup tip callout ─────────────────────────────────────────────────────

function SsoSetupTip({ tip }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sso-setup-tip">
      <button type="button" className="sso-setup-tip-toggle" onClick={() => setOpen(o => !o)}>
        <span className="sso-setup-tip-icon">{Icon.lightbulb}</span>
        <strong>{tip.title}</strong>
        <span className={`sso-setup-tip-chevron ${open ? 'open' : ''}`}>{Icon.arrowR}</span>
      </button>
      {open && (
        <div className="sso-setup-tip-body">
          {tip.items.map((item, i) => (
            <div key={i} className="sso-setup-tip-item">
              <div className="sso-setup-tip-item-head">
                <span className="sso-setup-tip-item-title">{item.heading}</span>
                {item.linkUrl && (
                  <a href={item.linkUrl} target="_blank" rel="noopener noreferrer" className="sso-setup-tip-link">
                    {item.linkLabel} <span className="btn-icon">{Icon.externalLink}</span>
                  </a>
                )}
              </div>
              <p className="sso-setup-tip-item-text">{item.text}</p>
              {item.steps && (
                <ol className="sso-setup-tip-steps">
                  {item.steps.map((s, j) => <li key={j}>{s}</li>)}
                </ol>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Step 2: Setup guide ───────────────────────────────────────────────────

function SsoSetupStep({ type, callbackUrl, onNext, onBack }) {
  const guide = SSO_SETUP_GUIDE[type] || SSO_SETUP_GUIDE.oidc;
  const meta  = SSO_PROVIDER_META.find(p => p.type === type);
  return (
    <div className="sso-wizard-body">
      <div className="sso-wizard-header">
        <div className="sso-wizard-header-row">
          <span className="sso-wizard-provider-icon"><SsoProviderIcon type={type} size={20}/></span>
          <h3>Set up {meta?.label}</h3>
        </div>
        <p>Register 1Patch in your identity provider before entering credentials.</p>
      </div>

      <div className="sso-setup-guide">
        <div className="sso-setup-guide-head">
          <span className="sso-setup-guide-title">Setup instructions</span>
          {guide.portalUrl && (
            <a href={guide.portalUrl} target="_blank" rel="noopener noreferrer" className="sso-setup-guide-link">
              {guide.portalLabel} <span className="btn-icon">{Icon.externalLink}</span>
            </a>
          )}
        </div>
        <ol className="sso-setup-guide-steps">
          {guide.steps.map((step, i) => (
            <li key={i} className="sso-setup-guide-step">
              <div className="sso-setup-guide-step-num">{i + 1}</div>
              <div className="sso-setup-guide-step-body">
                <span>{step.text}</span>
                {step.uri && (
                  <div className="sso-callback-uri">
                    <span className="sso-callback-uri-url">{callbackUrl}</span>
                    <CopyButton text={callbackUrl}/>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
        {guide.tip && <SsoSetupTip tip={guide.tip}/>}
      </div>

      <div className="sso-wizard-actions">
        <button type="button" className="btn ghost" onClick={onBack}>
          <span className="btn-icon">{Icon.arrowL}</span> Back
        </button>
        <button type="button" className="btn primary" onClick={onNext}>
          Continue <span className="btn-icon">{Icon.arrowR}</span>
        </button>
      </div>
    </div>
  );
}

// ── Step 3: Credentials ───────────────────────────────────────────────────

function SsoCredsStep({ type, name, setName, clientId, setClientId, clientSecret, setClientSecret,
  tenantId, setTenantId, domain, setDomain, discoveryUrl, setDiscoveryUrl, onNext, onBack }) {

  const meta = SSO_PROVIDER_META.find(p => p.type === type);
  const canContinue = name.trim() && clientId.trim() && clientSecret.trim()
    && (type !== 'microsoft' || tenantId.trim())
    && (type !== 'okta'      || domain.trim())
    && (type !== 'oidc'      || discoveryUrl.trim());

  return (
    <div className="sso-wizard-body">
      <div className="sso-wizard-header">
        <div className="sso-wizard-header-row">
          <span className="sso-wizard-provider-icon"><SsoProviderIcon type={type} size={20}/></span>
          <h3>{meta?.label} credentials</h3>
        </div>
        <p>Enter the app registration details from your identity provider.</p>
      </div>

      <div className="sso-wizard-fields">
        <label className="field">
          <span>Display name</span>
          <input type="text" value={name} onChange={e => setName(e.target.value)}
            placeholder="e.g. Contoso AD" autoFocus required/>
        </label>

        {type === 'microsoft' && (
          <label className="field">
            <span>Directory (Tenant) ID</span>
            <input type="text" value={tenantId} onChange={e => setTenantId(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" required/>
            <span className="field-sub">Use <code>common</code> for multi-tenant, <code>organizations</code> for any work account, or your specific tenant UUID</span>
          </label>
        )}

        <label className="field">
          <span>Application (Client) ID</span>
          <input type="text" value={clientId} onChange={e => setClientId(e.target.value)}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" required/>
        </label>

        <label className="field">
          <span>Client secret</span>
          <input type="password" autoComplete="new-password" value={clientSecret}
            onChange={e => setClientSecret(e.target.value)}
            placeholder="Paste the client secret value" required/>
          {type === 'microsoft' && (
            <span className="field-sub">Copy the <strong>Value</strong> from Certificates &amp; secrets — not the Secret ID</span>
          )}
        </label>

        {type === 'okta' && (
          <label className="field">
            <span>Okta domain</span>
            <input type="text" value={domain} onChange={e => setDomain(e.target.value)}
              placeholder="dev-12345.okta.com" required/>
          </label>
        )}

        {type === 'oidc' && (
          <label className="field">
            <span>Discovery base URL</span>
            <input type="url" value={discoveryUrl} onChange={e => setDiscoveryUrl(e.target.value)}
              placeholder="https://idp.example.com" required/>
            <span className="field-sub">/<code>.well-known/openid-configuration</code> is appended automatically</span>
          </label>
        )}
      </div>

      <div className="sso-wizard-actions">
        <button type="button" className="btn ghost" onClick={onBack}>
          <span className="btn-icon">{Icon.arrowL}</span> Back
        </button>
        <button type="button" className="btn primary" onClick={onNext} disabled={!canContinue}>
          Continue <span className="btn-icon">{Icon.arrowR}</span>
        </button>
      </div>
    </div>
  );
}

// ── Step 4: Access control ────────────────────────────────────────────────

function SsoAccessStep({ allowedDomains, setAllowedDomains, defaultRole, setDefaultRole, roleOptions = SSO_ROLE_OPTIONS,
  autoProvision, setAutoProvision, enabled, setEnabled, onSubmit, onBack, saving, saveError }) {
  return (
    <div className="sso-wizard-body">
      <div className="sso-wizard-header">
        <h3>Access control</h3>
        <p>Configure who can sign in and what permissions they receive.</p>
      </div>

      <div className="sso-wizard-fields">
        <label className="field">
          <span>Allowed email domains</span>
          <input type="text" value={allowedDomains} onChange={e => setAllowedDomains(e.target.value)}
            placeholder="company.com, partner.com"/>
          <span className="field-sub">Comma-separated. Leave blank to allow any verified account from this provider.</span>
        </label>

        <div className="sso-toggle-card">
          <div>
            <strong>Auto-provision new users</strong>
            <p>Automatically create accounts for first-time SSO users.</p>
          </div>
          <ToggleSwitch checked={autoProvision} onChange={e => setAutoProvision(e.target.checked)} label="Auto-provision"/>
        </div>

        {autoProvision && (
          <label className="field">
            <span>Default role for auto-provisioned users</span>
            <select value={defaultRole} onChange={e => setDefaultRole(e.target.value)}>
              {roleOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        )}

        <div className="sso-toggle-card">
          <div>
            <strong>Enable provider</strong>
            <p>Show this provider on the login screen and accept sign-ins.</p>
          </div>
          <ToggleSwitch checked={enabled} onChange={e => setEnabled(e.target.checked)} label="Enable provider"/>
        </div>
      </div>

      {saveError && <div className="banner error" style={{ marginBottom: 12 }}>{saveError}</div>}

      <div className="sso-wizard-actions">
        <button type="button" className="btn ghost" onClick={onBack} disabled={saving}>
          <span className="btn-icon">{Icon.arrowL}</span> Back
        </button>
        <button type="button" className="btn primary" onClick={onSubmit} disabled={saving}>
          {saving ? <span className="search-spinner"/> : null}
          Add provider
        </button>
      </div>
    </div>
  );
}

// ── Full add-provider wizard ──────────────────────────────────────────────

function SsoWizard({ onSave, onCancel, saving, saveError, roleOptions = SSO_ROLE_OPTIONS }) {
  const [step,          setStep]          = useState(1);
  const [type,          setType]          = useState('microsoft');
  const [name,          setName]          = useState('');
  const [clientId,      setClientId]      = useState('');
  const [clientSecret,  setClientSecret]  = useState('');
  const [tenantId,      setTenantId]      = useState('');
  const [domain,        setDomain]        = useState('');
  const [discoveryUrl,  setDiscoveryUrl]  = useState('');
  const [allowedDomains, setAllowedDomains] = useState('');
  const [defaultRole,   setDefaultRole]   = useState('viewer');
  const [autoProvision, setAutoProvision] = useState(false);
  const [enabled,       setEnabled]       = useState(true);

  const callbackUrl = `${window.location.origin}/auth/sso/callback`;

  const submit = () => {
    const dto = {
      type, name, clientId, clientSecret, enabled, autoProvision, defaultRole,
      allowedDomains: allowedDomains.split(',').map(s => s.trim()).filter(Boolean),
    };
    if (type === 'microsoft') dto.tenantId = tenantId;
    if (type === 'okta')      dto.domain = domain;
    if (type === 'oidc')      dto.discoveryUrl = discoveryUrl;
    onSave(dto);
  };

  return (
    <div className="sso-wizard">
      <SsoWizardSteps current={step}/>
      {step === 1 && (
        <SsoTypeStep type={type} setType={setType}
          onNext={() => setStep(2)} onCancel={onCancel}/>
      )}
      {step === 2 && (
        <SsoSetupStep type={type} callbackUrl={callbackUrl}
          onNext={() => setStep(3)} onBack={() => setStep(1)}/>
      )}
      {step === 3 && (
        <SsoCredsStep
          type={type}
          name={name} setName={setName}
          clientId={clientId} setClientId={setClientId}
          clientSecret={clientSecret} setClientSecret={setClientSecret}
          tenantId={tenantId} setTenantId={setTenantId}
          domain={domain} setDomain={setDomain}
          discoveryUrl={discoveryUrl} setDiscoveryUrl={setDiscoveryUrl}
          onNext={() => setStep(4)} onBack={() => setStep(2)}/>
      )}
      {step === 4 && (
        <SsoAccessStep
          allowedDomains={allowedDomains} setAllowedDomains={setAllowedDomains}
          defaultRole={defaultRole} setDefaultRole={setDefaultRole}
          roleOptions={roleOptions}
          autoProvision={autoProvision} setAutoProvision={setAutoProvision}
          enabled={enabled} setEnabled={setEnabled}
          onSubmit={submit} onBack={() => setStep(3)}
          saving={saving} saveError={saveError}/>
      )}
    </div>
  );
}

// ── Edit form (compact, for existing providers) ───────────────────────────

function SsoEditForm({ initial, onSave, onCancel, saving, saveError, roleOptions = SSO_ROLE_OPTIONS }) {
  const [name,          setName]          = useState(initial?.name          ?? '');
  const [clientId,      setClientId]      = useState(initial?.clientId      ?? '');
  const [clientSecret,  setClientSecret]  = useState('');
  const [tenantId,      setTenantId]      = useState(initial?.tenantId      ?? '');
  const [domain,        setDomain]        = useState(initial?.domain        ?? '');
  const [discoveryUrl,  setDiscoveryUrl]  = useState(initial?.discoveryUrl  ?? '');
  const [allowedDomains, setAllowedDomains] = useState((initial?.allowedDomains ?? []).join(', '));
  const [defaultRole,   setDefaultRole]   = useState(initial?.defaultRole   ?? 'viewer');
  const [autoProvision, setAutoProvision] = useState(initial?.autoProvision ?? false);
  const [enabled,       setEnabled]       = useState(initial?.enabled       ?? true);

  const submit = (e) => {
    e.preventDefault();
    const dto = { name, clientId, enabled, autoProvision, defaultRole,
      allowedDomains: allowedDomains.split(',').map(s => s.trim()).filter(Boolean) };
    if (clientSecret) dto.clientSecret = clientSecret;
    if (initial?.type === 'microsoft') dto.tenantId = tenantId;
    if (initial?.type === 'okta')      dto.domain = domain;
    if (initial?.type === 'oidc')      dto.discoveryUrl = discoveryUrl;
    onSave(dto);
  };

  return (
    <form className="sso-edit-form" onSubmit={submit}>
      <div className="sso-wizard-header" style={{ paddingBottom: 16, marginBottom: 16, borderBottom: '1px solid var(--line)' }}>
        <div className="sso-wizard-header-row">
          <span className="sso-wizard-provider-icon"><SsoProviderIcon type={initial?.type} size={18}/></span>
          <h3 style={{ margin: 0 }}>Edit {SSO_PROVIDER_LABELS[initial?.type] || 'provider'}</h3>
        </div>
      </div>

      <div className="sso-wizard-fields">
        <div className="form-grid-2">
          <label className="field">
            <span>Display name</span>
            <input type="text" value={name} onChange={e => setName(e.target.value)} required/>
          </label>
          <label className="field">
            <span>Client ID</span>
            <input type="text" value={clientId} onChange={e => setClientId(e.target.value)} required/>
          </label>
        </div>

        <label className="field">
          <span>Client secret <span className="field-sub" style={{ marginLeft: 0 }}>(leave blank to keep current)</span></span>
          <input type="password" autoComplete="new-password" value={clientSecret}
            onChange={e => setClientSecret(e.target.value)} placeholder="••••••••"/>
        </label>

        {initial?.type === 'microsoft' && (
          <label className="field">
            <span>Tenant ID</span>
            <input type="text" value={tenantId} onChange={e => setTenantId(e.target.value)} required/>
          </label>
        )}
        {initial?.type === 'okta' && (
          <label className="field">
            <span>Okta domain</span>
            <input type="text" value={domain} onChange={e => setDomain(e.target.value)} required/>
          </label>
        )}
        {initial?.type === 'oidc' && (
          <label className="field">
            <span>Discovery base URL</span>
            <input type="url" value={discoveryUrl} onChange={e => setDiscoveryUrl(e.target.value)} required/>
          </label>
        )}

        <label className="field">
          <span>Allowed email domains</span>
          <input type="text" value={allowedDomains} onChange={e => setAllowedDomains(e.target.value)}
            placeholder="company.com, partner.com"/>
          <span className="field-sub">Comma-separated. Leave blank to allow any verified account.</span>
        </label>

        <div className="sso-toggle-card">
          <div>
            <strong>Auto-provision new users</strong>
            <p>Automatically create accounts for first-time SSO users.</p>
          </div>
          <ToggleSwitch checked={autoProvision} onChange={e => setAutoProvision(e.target.checked)} label="Auto-provision"/>
        </div>

        {autoProvision && (
          <label className="field">
            <span>Default role for auto-provisioned users</span>
            <select value={defaultRole} onChange={e => setDefaultRole(e.target.value)}>
              {roleOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        )}

        <div className="sso-toggle-card">
          <div>
            <strong>Enable provider</strong>
            <p>Show this provider on the login screen and accept sign-ins.</p>
          </div>
          <ToggleSwitch checked={enabled} onChange={e => setEnabled(e.target.checked)} label="Enable provider"/>
        </div>
      </div>

      {saveError && <div className="banner error" style={{ marginTop: 8, marginBottom: 4 }}>{saveError}</div>}

      <div className="sso-form-actions">
        <button type="button" className="btn ghost" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="submit" className="btn primary" disabled={saving}>
          {saving ? <span className="search-spinner"/> : null}
          Save changes
        </button>
      </div>
    </form>
  );
}

// ── Provider card (replaces table row) ────────────────────────────────────

function SsoProviderCard({ provider, onEdit, onDelete, onToggle }) {
  return (
    <div className={`sso-provider-card ${provider.enabled ? '' : 'sso-provider-card--off'}`}>
      <div className="sso-provider-card-header">
        <div className="sso-provider-card-identity">
          <div className="sso-provider-card-icon">
            <SsoProviderIcon type={provider.type} size={20}/>
          </div>
          <div>
            <strong>{provider.name}</strong>
            <span>{SSO_PROVIDER_LABELS[provider.type] || provider.type}</span>
          </div>
        </div>
        <ToggleSwitch checked={provider.enabled} onChange={() => onToggle(provider)}
          label={provider.enabled ? 'Disable provider' : 'Enable provider'}/>
      </div>

      <div className="sso-provider-card-meta">
        <div className="sso-provider-card-meta-item">
          <span className="sso-meta-label">Client ID</span>
          <span className="sso-meta-value mono">{provider.clientId.slice(0, 8)}…</span>
        </div>
        <div className="sso-provider-card-meta-item">
          <span className="sso-meta-label">Domains</span>
          <span className="sso-meta-value">
            {provider.allowedDomains?.length > 0 ? provider.allowedDomains.join(', ') : <span className="muted">Any</span>}
          </span>
        </div>
        {provider.autoProvision && (
          <div className="sso-provider-card-meta-item">
            <span className="sso-meta-label">Auto-provision</span>
            <span className="sso-meta-value">{provider.defaultRole || 'viewer'}</span>
          </div>
        )}
      </div>

      <div className="sso-provider-card-footer">
        <span className={`status-pill ${provider.enabled ? 'ok' : 'off'}`}>
          {provider.enabled ? 'Active' : 'Disabled'}
        </span>
        <div style={{ flex: 1 }}/>
        <button className="btn sm ghost" onClick={() => onEdit(provider)}>Edit</button>
        <button className="btn sm ghost danger" onClick={() => onDelete(provider)}>Delete</button>
      </div>
    </div>
  );
}

// ── Settings page ──────────────────────────────────────────────────────────

function SsoSettingsPage() {
  const { data: providers, loading, error, reload } = useResource(() => PatchAPI.ssoProvidersAdmin());
  const rbac = useResource(() => PatchAPI.adminRbac());
  const [mode,     setMode]     = useState('list');  // 'list' | 'add' | 'edit'
  const [editing,  setEditing]  = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [saving,   setSaving]   = useState(false);
  const [saveError, setSaveError] = useState('');

  const openAdd  = () => { setSaveError(''); setMode('add'); };
  const openEdit = (p) => { setSaveError(''); setEditing(p); setMode('edit'); };
  const closeForm = () => { setMode('list'); setEditing(null); setSaveError(''); };

  const handleSave = (dto) => {
    setSaving(true);
    setSaveError('');
    const action = mode === 'edit'
      ? PatchAPI.ssoUpdateProvider(editing.id, dto)
      : PatchAPI.ssoCreateProvider(dto);
    action
      .then(() => { closeForm(); reload(); })
      .catch(err => setSaveError(err.message || 'Save failed'))
      .finally(() => setSaving(false));
  };

  const handleDelete = () => {
    setSaving(true);
    PatchAPI.ssoDeleteProvider(deleting.id)
      .then(() => { setDeleting(null); reload(); })
      .catch(err => setSaveError(err.message || 'Delete failed'))
      .finally(() => setSaving(false));
  };

  const handleToggle = (provider) => {
    PatchAPI.ssoUpdateProvider(provider.id, { enabled: !provider.enabled })
      .then(() => reload())
      .catch(() => {});
  };

  const roleOptions = roleOptionsFromRbac(rbac.data);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Settings</h2>
          <p className="sub">Identity provider configuration for single sign-on</p>
        </div>
        {mode === 'list' && (
          <button className="btn primary" onClick={openAdd}>
            {Icon.plus} Add provider
          </button>
        )}
      </div>

      {mode === 'add' && (
        <div className="card sso-wizard-card">
          <SsoWizard onSave={handleSave} onCancel={closeForm} saving={saving} saveError={saveError} roleOptions={roleOptions}/>
        </div>
      )}

      {mode === 'edit' && (
        <div className="card" style={{ marginBottom: 16 }}>
          <SsoEditForm
            initial={editing}
            onSave={handleSave}
            onCancel={closeForm}
            saving={saving}
            saveError={saveError}
            roleOptions={roleOptions}
          />
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>Identity Providers</h3>
          <div className="sub">{Array.isArray(providers) ? providers.length : 0} configured</div>
        </div>
        <div className="sso-security-note">
          {Icon.shield}
          <span>All SSO logins use PKCE (S256), nonce replay protection, ID token signature verification, and server-side state validation. Client secrets are stored AES-256-GCM encrypted.</span>
        </div>
        {loading && <div className="empty-state"><span className="search-spinner"/> Loading providers…</div>}
        {error  && <div className="banner error" style={{ margin: 12 }}>Failed to load providers.</div>}
        {!loading && !error && Array.isArray(providers) && providers.length === 0 && (
          <div className="empty-state">
            <div style={{ color: 'var(--text-3)', marginBottom: 6 }}>{Icon.shield}</div>
            <p>No SSO providers configured.</p>
            <p className="sub">Add a provider to enable single sign-on for your team.</p>
            {mode === 'list' && (
              <button className="btn primary" style={{ marginTop: 12 }} onClick={openAdd}>
                {Icon.plus} Add your first provider
              </button>
            )}
          </div>
        )}
        {!loading && !error && Array.isArray(providers) && providers.length > 0 && (
          <div className="sso-providers-list">
            {providers.map(p => (
              <SsoProviderCard
                key={p.id}
                provider={p}
                onEdit={openEdit}
                onDelete={p => setDeleting(p)}
                onToggle={handleToggle}
              />
            ))}
          </div>
        )}
      </div>

      {deleting && (
        <div className="modal-overlay" onClick={() => setDeleting(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <h3>Delete SSO provider?</h3>
            <p>This will permanently remove <strong>{deleting.name}</strong>. Users who sign in via this provider will need to use a password or another provider.</p>
            {saveError && <div className="banner error">{saveError}</div>}
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setDeleting(null)} disabled={saving}>Cancel</button>
              <button className="btn danger" onClick={handleDelete} disabled={saving}>
                {saving ? <span className="search-spinner"/> : null}
                Delete provider
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TenantPolicySettings() {
  const [tenantId, setTenantId] = useState('default');
  const policy = useResource(() => PatchAPI.tenantPolicy(tenantId), [tenantId]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!policy.data) return;
    setForm({
      securityMode: policy.data.securityMode || 'normal',
      requireVirusTotalForStrict: Boolean(policy.data.requireVirusTotalForStrict),
      requireVirusTotalForTinfoil: Boolean(policy.data.requireVirusTotalForTinfoil),
      virusTotalApiKey: policy.data.virusTotalConfigured ? '********' : '',
      trustedSourceHosts: (policy.data.trustedSourceHosts || []).join('\n'),
    });
  }, [policy.data]);
  const set = (key, value) => setForm(prev => ({ ...(prev || {}), [key]: value }));
  const save = (e) => {
    e.preventDefault();
    setSaving(true);
    setNotice('');
    PatchAPI.saveTenantPolicy(tenantId, {
      securityMode: form.securityMode,
      requireVirusTotalForStrict: form.requireVirusTotalForStrict,
      requireVirusTotalForTinfoil: form.requireVirusTotalForTinfoil,
      virusTotalApiKey: form.virusTotalApiKey,
      trustedSourceHosts: form.trustedSourceHosts.split(/\r?\n|,/).map(v => v.trim()).filter(Boolean),
    }).then(() => {
      setNotice('Policy saved.');
      policy.reload();
    }).catch(err => {
      setNotice(err.message || 'Save failed');
    }).finally(() => setSaving(false));
  };
  return (
    <div>
      <div className="page-head">
        <div><h2>Security policy</h2><p>Tenant guardrails, trusted sources, and BYO VirusTotal reputation</p></div>
      </div>
      <div className="card">
        <form className="card-body" onSubmit={save} style={{ display:'flex', flexDirection:'column', gap:14 }}>
          <div className="form-grid">
            <label className="field"><span>Tenant</span><input value={tenantId} onChange={e => setTenantId(e.target.value || 'default')}/></label>
            <label className="field"><span>Security mode</span><select value={form?.securityMode || 'normal'} onChange={e => set('securityMode', e.target.value)}><option value="normal">Normal</option><option value="strict">Strict</option><option value="tinfoil">Tinfoil</option></select></label>
          </div>
          {policy.error && <ErrorAlert error={policy.error} onRetry={policy.reload}/>}
          {policy.loading || !form ? <Skeleton h={160}/> : (
            <React.Fragment>
              <label className="field">
                <span>VirusTotal API key <em className="field-hint">BYO key, stored server-side only; never sent to nodes or clients</em></span>
                <input type="password" autoComplete="new-password" value={form.virusTotalApiKey} onChange={e => set('virusTotalApiKey', e.target.value)} placeholder={policy.data?.virusTotalConfigured ? 'Configured' : 'Paste API key'}/>
              </label>
              <div className="checkbox-group">
                <label className="checkbox-label"><input type="checkbox" checked={form.requireVirusTotalForStrict} onChange={e => set('requireVirusTotalForStrict', e.target.checked)}/> Require VirusTotal in strict mode</label>
                <label className="checkbox-label"><input type="checkbox" checked={form.requireVirusTotalForTinfoil} onChange={e => set('requireVirusTotalForTinfoil', e.target.checked)}/> Require VirusTotal in tinfoil mode</label>
              </div>
              <label className="field"><span>Trusted source hosts</span><textarea value={form.trustedSourceHosts} onChange={e => set('trustedSourceHosts', e.target.value)} placeholder="packages.example.com, vendor.example.com"/></label>
              {notice && <div className="banner">{notice}</div>}
              <div style={{ display:'flex', justifyContent:'flex-end' }}><button className="btn primary" disabled={saving}>{saving ? 'Saving...' : 'Save policy'}</button></div>
            </React.Fragment>
          )}
        </form>
      </div>
    </div>
  );
}

function AccessSettings() {
  const users = useResource(() => PatchAPI.adminUsers());
  const rbac = useResource(() => PatchAPI.adminRbac());
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ email:'', password:'', roles:['viewer'] });
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [resetUser, setResetUser] = useState(null);
  const [resetPassword, setResetPassword] = useState('');
  const [deletingUser, setDeletingUser] = useState(null);
  const roles = rbac.data?.roles || ['viewer'];
  useEffect(() => {
    if (!roles.length || form.roles.some(role => roles.includes(role))) return;
    setForm(prev => ({ ...prev, roles: [roles.includes('viewer') ? 'viewer' : roles[0]] }));
  }, [roles.join('|')]);
  const toggleRole = (role) => setForm(prev => ({ ...prev, roles: prev.roles.includes(role) ? prev.roles.filter(r => r !== role) : [...prev.roles, role] }));
  const create = (e) => {
    e.preventDefault();
    setError('');
    PatchAPI.adminCreateUser(form)
      .then(() => { setCreating(false); setForm({ email:'', password:'', roles:['viewer'] }); users.reload(); })
      .catch(err => setError(err.message || 'Create failed'));
  };
  const updateUser = (user, patch) => {
    setActionError('');
    return PatchAPI.adminUpdateUser(user.id, patch).then(() => users.reload()).catch(err => {
      setActionError(err.message || 'User update failed');
      throw err;
    });
  };
  const confirmResetPassword = (e) => {
    e.preventDefault();
    if (!resetUser) return;
    updateUser(resetUser, { password: resetPassword }).then(() => {
      setResetUser(null);
      setResetPassword('');
    });
  };
  const confirmDeleteUser = () => {
    if (!deletingUser) return;
    setActionError('');
    PatchAPI.adminDeleteUser(deletingUser.id)
      .then(() => { setDeletingUser(null); users.reload(); })
      .catch(err => setActionError(err.message || 'Delete failed'));
  };
  return (
    <div>
      <div className="page-head">
        <div><h2>Users</h2><p>Accounts, roles, status, password resets, and access lifecycle</p></div>
        <button className="btn primary" onClick={() => setCreating(true)}>{Icon.plus} Add user</button>
      </div>
      {(users.error || rbac.error) && <ErrorAlert error={users.error || rbac.error} onRetry={() => { users.reload(); rbac.reload(); }}/>}
      {actionError && <div className="banner error">{actionError}</div>}
      {creating && (
        <div className="card">
          <form className="card-body" onSubmit={create} style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div className="form-grid">
              <label className="field"><span>Email</span><input type="email" required value={form.email} onChange={e => setForm(prev => ({ ...prev, email:e.target.value }))}/></label>
              <label className="field"><span>Temporary password</span><input type="password" required minLength="12" value={form.password} onChange={e => setForm(prev => ({ ...prev, password:e.target.value }))}/></label>
            </div>
            <div className="checkbox-group">{roles.map(role => <label className="checkbox-label" key={role}><input type="checkbox" checked={form.roles.includes(role)} onChange={() => toggleRole(role)}/>{roleLabel(role, rbac.data)}</label>)}</div>
            {error && <div className="banner error">{error}</div>}
            <div style={{ display:'flex', justifyContent:'space-between' }}><button type="button" className="btn ghost" onClick={() => setCreating(false)}>Cancel</button><button className="btn primary">Create user</button></div>
          </form>
        </div>
      )}
      <div className="card">
        <div className="card-head"><h3>Users</h3><div className="sub">{(users.data || []).length} accounts</div></div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Email</th><th>Roles</th><th>Permissions</th><th>MFA</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {(users.loading || rbac.loading) && <SkeletonRows n={4} cols={6}/>}
              {!users.loading && (users.data || []).map(user => (
                <tr key={user.id}>
                  <td><strong>{user.email}</strong><div className="mono muted">{user.id}</div></td>
                  <td>{roles.map(role => <label className="checkbox-label" key={role} style={{ marginRight:8 }}><input type="checkbox" checked={(user.roles || []).includes(role)} onChange={e => {
                    const next = e.target.checked ? [...user.roles, role] : user.roles.filter(r => r !== role);
                    updateUser(user, { roles: next });
                  }}/>{roleLabel(role, rbac.data)}</label>)}</td>
                  <td className="mono muted">{(user.permissions || []).join(', ')}</td>
                  <td>{user.mfaEnabled ? <span className="pill ok">Enabled</span> : <span className="pill">Off</span>}</td>
                  <td>{user.disabled ? <span className="pill crit">Disabled</span> : <span className="pill ok">Active</span>}</td>
                  <td>
                    <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                      <button className="btn sm ghost" onClick={() => updateUser(user, { disabled: !user.disabled })}>{user.disabled ? 'Enable' : 'Disable'}</button>
                      <button className="btn sm ghost" onClick={() => { setResetUser(user); setResetPassword(''); }}>Reset password</button>
                      <button className="btn sm ghost danger" onClick={() => setDeletingUser(user)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {resetUser && (
        <div className="modal-overlay" onClick={() => setResetUser(null)}>
          <form className="modal-box" onSubmit={confirmResetPassword} onClick={e => e.stopPropagation()}>
            <h3>Reset password</h3>
            <p>Set a new temporary password for <strong>{resetUser.email}</strong>.</p>
            <label className="field"><span>New temporary password</span><input type="password" minLength="12" required value={resetPassword} onChange={e => setResetPassword(e.target.value)}/></label>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setResetUser(null)}>Cancel</button>
              <button className="btn primary">Reset password</button>
            </div>
          </form>
        </div>
      )}

      {deletingUser && (
        <div className="modal-overlay" onClick={() => setDeletingUser(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <h3>Delete user?</h3>
            <p>This permanently removes <strong>{deletingUser.email}</strong> from the management server.</p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setDeletingUser(null)}>Cancel</button>
              <button className="btn danger" onClick={confirmDeleteUser}>Delete user</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PermissionSettings() {
  const rbac = useResource(() => PatchAPI.adminRbac());
  const [mode, setMode] = useState('list');
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [form, setForm] = useState({ id:'', name:'', description:'', permissions:[] });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const roleDefinitions = rbac.data?.roleDefinitions || [];
  const permissions = rbac.data?.permissions || [];

  const openCreate = () => {
    setNotice('');
    setEditing(null);
    setForm({ id:'', name:'', description:'', permissions:['apps:read'] });
    setMode('form');
  };
  const openEdit = (role) => {
    setNotice('');
    setEditing(role);
    setForm({
      id: role.id,
      name: role.name || role.id,
      description: role.description || '',
      permissions: [...(role.permissions || [])],
    });
    setMode('form');
  };
  const closeForm = () => {
    setMode('list');
    setEditing(null);
    setNotice('');
  };
  const togglePermission = (permission) => setForm(prev => ({
    ...prev,
    permissions: prev.permissions.includes(permission)
      ? prev.permissions.filter(p => p !== permission)
      : [...prev.permissions, permission].sort(),
  }));
  const submitRole = (e) => {
    e.preventDefault();
    setSaving(true);
    setNotice('');
    const dto = {
      id: form.id,
      name: form.name,
      description: form.description,
      permissions: form.permissions,
    };
    const action = editing
      ? PatchAPI.adminUpdateRole(editing.id, dto)
      : PatchAPI.adminCreateRole(dto);
    action
      .then(() => { closeForm(); rbac.reload(); })
      .catch(err => setNotice(err.message || 'Role save failed'))
      .finally(() => setSaving(false));
  };
  const confirmDeleteRole = () => {
    if (!deleting) return;
    setSaving(true);
    setNotice('');
    PatchAPI.adminDeleteRole(deleting.id)
      .then(() => { setDeleting(null); rbac.reload(); })
      .catch(err => setNotice(err.message || 'Delete failed'))
      .finally(() => setSaving(false));
  };

  return (
    <div>
      <div className="page-head">
        <div><h2>Permissions</h2><p>Create roles and assign access across the management server</p></div>
        {mode === 'list' && <button className="btn primary" onClick={openCreate}>{Icon.plus} New role</button>}
      </div>
      {rbac.error && <ErrorAlert error={rbac.error} onRetry={rbac.reload}/>}
      {notice && <div className="banner error">{notice}</div>}

      {mode === 'form' && (
        <div className="card" style={{ marginBottom:16 }}>
          <div className="card-head">
            <div>
              <h3>{editing ? `Edit ${editing.name || editing.id}` : 'Create role'}</h3>
              <div className="sub">{editing?.builtIn ? 'Built-in role' : 'Custom role'}</div>
            </div>
          </div>
          <form className="card-body" onSubmit={submitRole} style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div className="form-grid">
              <label className="field">
                <span>Role ID</span>
                <input required disabled={Boolean(editing)} value={form.id} onChange={e => setForm(prev => ({ ...prev, id:e.target.value }))} placeholder="regional_operator"/>
                <span className="field-sub">Lowercase letters, numbers, underscores, colons, or hyphens.</span>
              </label>
              <label className="field">
                <span>Display name</span>
                <input required value={form.name} onChange={e => setForm(prev => ({ ...prev, name:e.target.value }))} placeholder="Regional Operator"/>
              </label>
            </div>
            <label className="field">
              <span>Description</span>
              <input value={form.description} onChange={e => setForm(prev => ({ ...prev, description:e.target.value }))} placeholder="What this role is used for"/>
            </label>
            <div>
              <strong>Permissions</strong>
              <div className="checkbox-group" style={{ marginTop:8 }}>
                {permissions.map(permission => (
                  <label className="checkbox-label" key={permission}>
                    <input type="checkbox" checked={form.permissions.includes(permission)} onChange={() => togglePermission(permission)}/>
                    <span className="mono">{permission}</span>
                  </label>
                ))}
              </div>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between' }}>
              <button type="button" className="btn ghost" onClick={closeForm} disabled={saving}>Cancel</button>
              <button className="btn primary" disabled={saving}>{saving ? 'Saving...' : 'Save role'}</button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        <div className="card-head"><h3>Roles</h3><div className="sub">{roleDefinitions.length || (rbac.data?.roles || []).length} roles · {permissions.length} permissions</div></div>
        <div className="card-body">
          {rbac.loading && <Skeleton h={140}/>}
          {!rbac.loading && roleDefinitions.length === 0 && <div className="empty-state">No roles configured.</div>}
          {!rbac.loading && roleDefinitions.map(role => (
            <div key={role.id} style={{ border:'1px solid var(--line)', borderRadius:8, padding:14, marginBottom:12 }}>
              <div style={{ display:'flex', justifyContent:'space-between', gap:12, flexWrap:'wrap' }}>
                <div>
                  <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                    <strong>{role.name || role.id}</strong>
                    <span className="pill">{role.id}</span>
                    {role.builtIn && <span className="pill accent">Built-in</span>}
                  </div>
                  {role.description && <div className="muted" style={{ fontSize:12, marginTop:4 }}>{role.description}</div>}
                </div>
                <div style={{ display:'flex', gap:6 }}>
                  <button className="btn sm ghost" onClick={() => openEdit(role)}>Edit</button>
                  <button className="btn sm ghost danger" onClick={() => setDeleting(role)} disabled={role.id === 'owner'}>Delete</button>
                </div>
              </div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginTop:10 }}>
                {(role.permissions || []).map(p => <span className="pill" key={p}>{p}</span>)}
                {(role.permissions || []).length === 0 && <span className="muted">No permissions assigned</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {deleting && (
        <div className="modal-overlay" onClick={() => setDeleting(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <h3>Delete role?</h3>
            <p>This removes <strong>{deleting.name || deleting.id}</strong>. Users and SSO providers must be moved off this role first.</p>
            {notice && <div className="banner error">{notice}</div>}
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setDeleting(null)} disabled={saving}>Cancel</button>
              <button className="btn danger" onClick={confirmDeleteRole} disabled={saving}>
                {saving ? <span className="search-spinner"/> : null} Delete role
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Device Retirement Policies ──────────────────────────────────────────────

const CRITERION_LABELS = {
  inactive_days:      'Inactive for N days',
  os_pattern:         'OS name contains',
  trust_score_below:  'Trust score below',
  risk_score_above:   'Risk score above',
  has_tag:            'Has tag',
  missing_tag:        'Missing tag',
  in_group:           'In group',
  os_family:          'OS family',
};

const ACTION_LABELS = {
  tag_device:    'Apply tag to device',
  create_alarm:  'Create alarm',
  notify:        'Send notification',
};

function RetirementCriterionRow({ criterion, onChange, onRemove }) {
  const set = (key, value) => onChange({ ...criterion, [key]: value });
  return (
    <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap', background:'var(--bg-2)', borderRadius:6, padding:'8px 10px' }}>
      <select value={criterion.type} onChange={e => onChange({ type: e.target.value })} style={{ flexShrink:0 }}>
        {Object.entries(CRITERION_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {criterion.type === 'inactive_days' && (
        <input type="number" min="1" placeholder="days" value={criterion.days ?? ''} onChange={e => set('days', Number(e.target.value))} style={{ width:80 }}/>
      )}
      {criterion.type === 'os_pattern' && (
        <input placeholder="e.g. Windows 7" value={criterion.pattern ?? ''} onChange={e => set('pattern', e.target.value)} style={{ flex:1 }}/>
      )}
      {(criterion.type === 'trust_score_below' || criterion.type === 'risk_score_above') && (
        <input type="number" min="0" max="100" placeholder="0–100" value={criterion.score ?? ''} onChange={e => set('score', Number(e.target.value))} style={{ width:80 }}/>
      )}
      {(criterion.type === 'has_tag' || criterion.type === 'missing_tag') && (
        <input placeholder="tag name" value={criterion.tag ?? ''} onChange={e => set('tag', e.target.value)} style={{ flex:1 }}/>
      )}
      {criterion.type === 'in_group' && (
        <input placeholder="group name" value={criterion.group ?? ''} onChange={e => set('group', e.target.value)} style={{ flex:1 }}/>
      )}
      {criterion.type === 'os_family' && (
        <select value={criterion.os ?? 'windows'} onChange={e => set('os', e.target.value)}>
          <option value="windows">Windows</option>
          <option value="linux">Linux</option>
        </select>
      )}
      <button className="btn sm ghost danger" onClick={onRemove} style={{ marginLeft:'auto' }}>Remove</button>
    </div>
  );
}

function RetirementActionRow({ action, onChange, onRemove }) {
  const set = (key, value) => onChange({ ...action, [key]: value });
  return (
    <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap', background:'var(--bg-2)', borderRadius:6, padding:'8px 10px' }}>
      <select value={action.type} onChange={e => onChange({ type: e.target.value })} style={{ flexShrink:0 }}>
        {Object.entries(ACTION_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {action.type === 'tag_device' && (
        <input placeholder="tag to apply" value={action.tag ?? ''} onChange={e => set('tag', e.target.value)} style={{ flex:1 }}/>
      )}
      {action.type === 'create_alarm' && (
        <>
          <select value={action.severity ?? 'warning'} onChange={e => set('severity', e.target.value)}>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
          <input placeholder="alarm message" value={action.message ?? ''} onChange={e => set('message', e.target.value)} style={{ flex:1 }}/>
        </>
      )}
      {action.type === 'notify' && (
        <>
          <select value={action.channel ?? 'siem'} onChange={e => set('channel', e.target.value)}>
            <option value="siem">SIEM</option>
            <option value="webhook">Webhook</option>
            <option value="email">Email</option>
          </select>
          <input placeholder="optional message" value={action.message ?? ''} onChange={e => set('message', e.target.value)} style={{ flex:1 }}/>
        </>
      )}
      <button className="btn sm ghost danger" onClick={onRemove} style={{ marginLeft:'auto' }}>Remove</button>
    </div>
  );
}

const BLANK_POLICY = {
  name: '', description: '', enabled: true,
  conditionCombinator: 'AND', priority: 10,
  conditions: [{ type: 'inactive_days', days: 90 }],
  actions: [{ type: 'tag_device', tag: 'retired' }],
};

function RetirementPolicyForm({ initial, onSave, onCancel, saving, saveError }) {
  const [form, setForm] = useState(initial ? { ...initial } : { ...BLANK_POLICY });
  const setField = (key, value) => setForm(prev => ({ ...prev, [key]: value }));

  const addCondition = () => setForm(prev => ({ ...prev, conditions: [...prev.conditions, { type: 'inactive_days', days: 90 }] }));
  const updateCondition = (i, val) => setForm(prev => ({ ...prev, conditions: prev.conditions.map((c, idx) => idx === i ? val : c) }));
  const removeCondition = (i) => setForm(prev => ({ ...prev, conditions: prev.conditions.filter((_, idx) => idx !== i) }));

  const addAction = () => setForm(prev => ({ ...prev, actions: [...prev.actions, { type: 'tag_device', tag: 'retired' }] }));
  const updateAction = (i, val) => setForm(prev => ({ ...prev, actions: prev.actions.map((a, idx) => idx === i ? val : a) }));
  const removeAction = (i) => setForm(prev => ({ ...prev, actions: prev.actions.filter((_, idx) => idx !== i) }));

  const submit = (e) => { e.preventDefault(); onSave(form); };

  return (
    <form className="card-body" onSubmit={submit} style={{ display:'flex', flexDirection:'column', gap:16 }}>
      <div className="form-grid">
        <label className="field"><span>Policy name</span>
          <input required value={form.name} onChange={e => setField('name', e.target.value)} placeholder="e.g. Retire inactive Windows 7 devices"/>
        </label>
        <label className="field"><span>Priority</span>
          <input type="number" min="1" value={form.priority} onChange={e => setField('priority', Number(e.target.value))}/>
        </label>
      </div>
      <label className="field"><span>Description <em className="field-hint">optional</em></span>
        <input value={form.description} onChange={e => setField('description', e.target.value)} placeholder="What does this policy retire and why?"/>
      </label>
      <div className="checkbox-group">
        <label className="checkbox-label">
          <input type="checkbox" checked={form.enabled} onChange={e => setField('enabled', e.target.checked)}/> Enabled
        </label>
      </div>

      <div>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
          <strong>Conditions</strong>
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <span className="muted" style={{ fontSize:12 }}>Match</span>
            <select value={form.conditionCombinator} onChange={e => setField('conditionCombinator', e.target.value)} style={{ width:'auto' }}>
              <option value="AND">ALL (AND)</option>
              <option value="OR">ANY (OR)</option>
            </select>
          </div>
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
          {form.conditions.map((c, i) => (
            <RetirementCriterionRow key={i} criterion={c} onChange={val => updateCondition(i, val)} onRemove={() => removeCondition(i)}/>
          ))}
        </div>
        <button type="button" className="btn sm ghost" style={{ marginTop:8 }} onClick={addCondition}>+ Add condition</button>
      </div>

      <div>
        <div style={{ marginBottom:8 }}><strong>Actions</strong> <span className="muted" style={{ fontSize:12 }}>executed when a device matches</span></div>
        <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
          {form.actions.map((a, i) => (
            <RetirementActionRow key={i} action={a} onChange={val => updateAction(i, val)} onRemove={() => removeAction(i)}/>
          ))}
        </div>
        <button type="button" className="btn sm ghost" style={{ marginTop:8 }} onClick={addAction}>+ Add action</button>
      </div>

      {saveError && <div className="banner error">{saveError}</div>}
      <div style={{ display:'flex', justifyContent:'space-between' }}>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={saving}>{saving ? 'Saving…' : (initial ? 'Update policy' : 'Create policy')}</button>
      </div>
    </form>
  );
}

function RetirementPolicyCard({ policy, onEdit, onDelete, onEvaluate, evaluating }) {
  const conditionSummary = policy.conditions.map(c => {
    switch (c.type) {
      case 'inactive_days':     return `Inactive > ${c.days}d`;
      case 'os_pattern':        return `OS contains "${c.pattern}"`;
      case 'trust_score_below': return `Trust < ${c.score}`;
      case 'risk_score_above':  return `Risk > ${c.score}`;
      case 'has_tag':           return `Tag: ${c.tag}`;
      case 'missing_tag':       return `No tag: ${c.tag}`;
      case 'in_group':          return `Group: ${c.group}`;
      case 'os_family':         return `OS: ${c.os}`;
      default:                  return c.type;
    }
  }).join(` ${policy.conditionCombinator} `);

  return (
    <div style={{ border:'1px solid var(--border)', borderRadius:8, padding:14, display:'flex', flexDirection:'column', gap:10 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:8 }}>
        <div>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <strong>{policy.name}</strong>
            <span className={'pill ' + (policy.enabled ? 'ok' : '')}>{policy.enabled ? 'Enabled' : 'Disabled'}</span>
            <span className="pill">Priority {policy.priority}</span>
          </div>
          {policy.description && <div className="muted" style={{ fontSize:12, marginTop:2 }}>{policy.description}</div>}
        </div>
        <div style={{ display:'flex', gap:6 }}>
          <button className="btn sm ghost" onClick={() => onEvaluate(policy)} disabled={evaluating}>
            {evaluating ? <span className="search-spinner"/> : null} Evaluate
          </button>
          <button className="btn sm ghost" onClick={() => onEdit(policy)}>Edit</button>
          <button className="btn sm ghost danger" onClick={() => onDelete(policy)}>Delete</button>
        </div>
      </div>
      <div style={{ fontSize:12 }}>
        <span className="muted">Conditions: </span><span className="mono">{conditionSummary}</span>
      </div>
      <div style={{ fontSize:12 }}>
        <span className="muted">Actions: </span>
        {policy.actions.map((a, i) => (
          <span key={i} className="pill" style={{ marginRight:4 }}>
            {a.type === 'tag_device' ? `tag: ${a.tag}` : a.type === 'create_alarm' ? `alarm(${a.severity})` : `notify:${a.channel}`}
          </span>
        ))}
      </div>
      {policy.lastEvaluatedAt != null && (
        <div className="muted" style={{ fontSize:11 }}>
          Last evaluated {fmtAgo(policy.lastEvaluatedAt)} — matched {policy.matchCount ?? 0} device{policy.matchCount !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
}

function RetirementEvalModal({ result, onClose }) {
  if (!result) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth:560, width:'95%' }} onClick={e => e.stopPropagation()}>
        <h3>Evaluation results</h3>
        <p className="muted">{result.matchCount} of {result.totalDevices} devices match this policy.</p>
        {result.matchedDevices.length > 0 ? (
          <div style={{ maxHeight:280, overflowY:'auto', marginTop:10 }}>
            <table className="tbl">
              <thead><tr><th>Hostname</th><th>OS</th><th>Group</th><th>Last seen</th></tr></thead>
              <tbody>
                {result.matchedDevices.map(d => (
                  <tr key={d.id}>
                    <td><strong>{d.hostname}</strong></td>
                    <td className="muted">{d.os}</td>
                    <td>{d.group || '—'}</td>
                    <td className="muted">{fmtAgo(d.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state" style={{ padding:20 }}>No devices currently match this policy.</div>
        )}
        <div className="modal-actions" style={{ marginTop:12 }}>
          <button className="btn primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function RetirementPoliciesPage() {
  const [tenantId] = useState('default');
  const { data: policies, loading, error, reload } = useResource(() => PatchAPI.retirementPolicies(tenantId), [tenantId]);
  const [mode, setMode] = useState('list'); // 'list' | 'add' | 'edit'
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [evaluating, setEvaluating] = useState(null);
  const [evalResult, setEvalResult] = useState(null);

  const openAdd  = () => { setSaveError(''); setMode('add'); };
  const openEdit = (p) => { setSaveError(''); setEditing(p); setMode('edit'); };
  const closeForm = () => { setMode('list'); setEditing(null); setSaveError(''); };

  const handleSave = (dto) => {
    setSaving(true); setSaveError('');
    const action = mode === 'edit'
      ? PatchAPI.updateRetirementPolicy(editing.id, dto)
      : PatchAPI.createRetirementPolicy({ ...dto, tenantId });
    action
      .then(() => { closeForm(); reload(); })
      .catch(err => setSaveError(err.message || 'Save failed'))
      .finally(() => setSaving(false));
  };

  const handleDelete = () => {
    setSaving(true);
    PatchAPI.deleteRetirementPolicy(deleting.id)
      .then(() => { setDeleting(null); reload(); })
      .catch(err => setSaveError(err.message || 'Delete failed'))
      .finally(() => setSaving(false));
  };

  const handleEvaluate = (policy) => {
    setEvaluating(policy.id);
    PatchAPI.evaluateRetirementPolicy(policy.id)
      .then(result => { setEvalResult(result); reload(); })
      .catch(err => alert(err.message || 'Evaluation failed'))
      .finally(() => setEvaluating(null));
  };

  const list = Array.isArray(policies) ? policies : [];

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Device retirement policies</h2>
          <p>Define rules to identify and flag devices for retirement based on inactivity, OS, trust score, and other parameters.</p>
        </div>
        {mode === 'list' && <button className="btn primary" onClick={openAdd}>{Icon.plus} New policy</button>}
      </div>

      {(mode === 'add' || mode === 'edit') && (
        <div className="card" style={{ marginBottom:16 }}>
          <div className="card-head"><h3>{mode === 'edit' ? 'Edit policy' : 'New policy'}</h3></div>
          <RetirementPolicyForm
            initial={mode === 'edit' ? editing : null}
            onSave={handleSave}
            onCancel={closeForm}
            saving={saving}
            saveError={saveError}
          />
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>Policies</h3>
          <div className="sub">{list.length} configured</div>
        </div>
        {loading && <div className="empty-state"><span className="search-spinner"/> Loading…</div>}
        {error   && <div style={{ padding:12 }}><ErrorAlert error={error} onRetry={reload}/></div>}
        {!loading && !error && list.length === 0 && (
          <div className="empty-state">
            <div style={{ color:'var(--text-3)', marginBottom:6 }}>{Icon.shield}</div>
            <p>No retirement policies configured.</p>
            <p className="sub">Create a policy to automatically identify devices that should be retired.</p>
            {mode === 'list' && <button className="btn primary" style={{ marginTop:12 }} onClick={openAdd}>{Icon.plus} Create first policy</button>}
          </div>
        )}
        {!loading && !error && list.length > 0 && (
          <div style={{ display:'flex', flexDirection:'column', gap:10, padding:'12px 16px' }}>
            {list.map(p => (
              <RetirementPolicyCard
                key={p.id}
                policy={p}
                onEdit={openEdit}
                onDelete={p => setDeleting(p)}
                onEvaluate={handleEvaluate}
                evaluating={evaluating === p.id}
              />
            ))}
          </div>
        )}
      </div>

      {deleting && (
        <div className="modal-overlay" onClick={() => setDeleting(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <h3>Delete retirement policy?</h3>
            <p>This permanently removes <strong>{deleting.name}</strong>. Devices already tagged by this policy will retain their tags.</p>
            {saveError && <div className="banner error">{saveError}</div>}
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setDeleting(null)} disabled={saving}>Cancel</button>
              <button className="btn danger" onClick={handleDelete} disabled={saving}>
                {saving ? <span className="search-spinner"/> : null} Delete policy
              </button>
            </div>
          </div>
        </div>
      )}

      <RetirementEvalModal result={evalResult} onClose={() => setEvalResult(null)}/>
    </div>
  );
}

function AdminSettingsPage({ initialTab = 'policy' }) {
  return (
    <div className="page">
      {initialTab === 'policy'      && <TenantPolicySettings/>}
      {initialTab === 'users'       && <AccessSettings/>}
      {initialTab === 'permissions' && <PermissionSettings/>}
      {initialTab === 'siem'        && <SiemPage/>}
      {initialTab === 'sso'         && <SsoSettingsPage/>}
      {initialTab === 'posture'     && <SecurityPosturePage/>}
      {initialTab === 'retirement'  && <RetirementPoliciesPage/>}
    </div>
  );
}

// ---------- Quick Actions ----------

/**
 * Triggers a client-side file download from a string payload.
 *
 * @param data File contents.
 * @param filename Suggested download filename.
 * @param mimeType MIME type for the blob.
 */
function downloadBlob(data, filename, mimeType) {
  const blob = new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Serialises an array of objects to RFC-4180 CSV.
 *
 * @param rows Array of plain objects.
 * @param keys Column names (used as header row and property accessors).
 */
function toCSV(rows, keys) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  };
  return [keys.join(','), ...rows.map(r => keys.map(k => esc(r[k])).join(','))].join('\n');
}

/** ISO timestamp slug safe for filenames. */
const exportStamp = () => new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');

/**
 * A single quick-action card with run / confirm / result / error states.
 *
 * @param props.icon SVG icon element.
 * @param props.title Card heading.
 * @param props.description One-line subtitle.
 * @param props.onRun Async function that performs the action and returns a result string or object.
 * @param props.confirmText When set a confirmation step is shown before the action fires.
 */
function ActionCard({ icon, title, description, onRun, confirmText }) {
  const [status, setStatus] = useState('idle');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);

  const execute = async () => {
    setConfirming(false);
    setStatus('running');
    setResult(null);
    setError(null);
    try {
      setResult(await onRun());
      setStatus('done');
    } catch (err) {
      setError(err?.message || String(err));
      setStatus('error');
    }
  };

  const handleRun = () => {
    if (confirmText && !confirming) { setConfirming(true); return; }
    execute();
  };

  return (
    <div className={'qa-card' + (status === 'error' ? ' qa-card--err' : status === 'done' ? ' qa-card--done' : '')}>
      <div className="qa-card-icon">{icon}</div>
      <div className="qa-card-body">
        <div className="qa-card-head">
          <strong className="qa-card-title">{title}</strong>
          <span className="qa-card-desc">{description}</span>
        </div>

        {status === 'done' && result !== null && (
          <div className="qa-card-result">
            {typeof result === 'string' && (
              <span className="qa-ok">{Icon.check} {result}</span>
            )}
            {result?.type === 'nodes' && (
              <div className="qa-node-grid">
                {result.nodes.map(n => (
                  <div key={n.id} className="qa-node-row">
                    <span className={`qa-dot ${n.healthState === 'healthy' ? 'ok' : n.healthState === 'degraded' ? 'warn' : 'err'}`}/>
                    <span className="qa-node-name">{n.name || n.id}</span>
                    <span className="qa-node-score">Trust {n.trust?.trustScore ?? '--'}</span>
                    <span className="qa-node-state muted">{n.healthState} · {n.status}</span>
                  </div>
                ))}
              </div>
            )}
            {result?.type === 'stale' && (
              <div className="qa-stale">
                <span className="qa-ok">
                  {Icon.check} {result.count} device{result.count !== 1 ? 's' : ''} with inventory older than 7 days
                </span>
                {result.devices.length > 0 && (
                  <div className="qa-stale-list">
                    {result.devices.slice(0, 10).map(d => (
                      <span key={d.id} className="tag">{d.hostname || d.id}</span>
                    ))}
                    {result.devices.length > 10 && (
                      <span className="muted">+{result.devices.length - 10} more</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {status === 'error' && (
          <div className="qa-card-result">
            <span className="qa-err">{error}</span>
          </div>
        )}

        {confirming && (
          <div className="qa-confirm">
            <span className="qa-confirm-text">{confirmText}</span>
            <div className="qa-confirm-btns">
              <button className="btn sm danger" onClick={execute}>Confirm</button>
              <button className="btn sm ghost" onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div className="qa-card-actions">
        {status === 'running' ? (
          <span className="search-spinner"/>
        ) : !confirming && (
          <button className="btn sm accent" onClick={handleRun}>
            {status === 'done' ? 'Run again' : 'Run'}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * A labelled group of action cards.
 *
 * @param props.label Section heading.
 * @param props.children ActionCard elements.
 */
function ActionGroup({ label, children }) {
  return (
    <div className="qa-group">
      <div className="qa-group-label">{label}</div>
      <div className="qa-group-cards">{children}</div>
    </div>
  );
}

/**
 * Renders the quick actions page UI.
 * @returns The result produced by the operation.
 */
function QuickActionsPage() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Quick Actions</h2>
          <p>Batch fleet operations — results appear inline after each run.</p>
        </div>
      </div>

      <ActionGroup label="Inventory">
        <ActionCard
          icon={Icon.refresh}
          title="Pull Inventory — All Devices"
          description="Queue an inventory refresh for every enrolled device in the fleet."
          onRun={async () => {
            const devices = await PatchAPI.devices();
            let queued = 0, failed = 0;
            await Promise.allSettled(devices.map(d =>
              PatchAPI.refreshInventory(d.id).then(() => queued++, () => failed++)
            ));
            return `Queued ${queued} refresh task${queued !== 1 ? 's' : ''}${failed ? ` · ${failed} skipped` : ''}`;
          }}
        />
        <ActionCard
          icon={Icon.refresh}
          title="Pull Inventory — Offline & Stale"
          description="Refresh only devices that are offline or haven't checked in for over 24 hours."
          onRun={async () => {
            const devices = await PatchAPI.devices();
            const cutoff = Date.now() - 24 * 60 * 60_000;
            const stale = devices.filter(d => !d.online || new Date(d.lastSeenAt).getTime() < cutoff);
            if (stale.length === 0) return 'No offline or stale devices found.';
            let queued = 0, failed = 0;
            await Promise.allSettled(stale.map(d =>
              PatchAPI.refreshInventory(d.id).then(() => queued++, () => failed++)
            ));
            return `${stale.length} stale device${stale.length !== 1 ? 's' : ''} — queued ${queued}${failed ? ` · ${failed} skipped` : ''}`;
          }}
        />
      </ActionGroup>

      <ActionGroup label="Task Queue">
        <ActionCard
          icon={Icon.tasks}
          title="Cancel Pending Tasks"
          description="Cancel all tasks waiting in the queue that have not yet been dispatched to a node."
          confirmText="Cancel all pending tasks?"
          onRun={async () => {
            const tasks = await PatchAPI.tasks();
            const pending = tasks.filter(t => t.status === 'pending');
            if (pending.length === 0) return 'No pending tasks found.';
            let cancelled = 0, failed = 0;
            await Promise.allSettled(pending.map(t =>
              PatchAPI.cancelTask(t.id).then(() => cancelled++, () => failed++)
            ));
            return `Cancelled ${cancelled} task${cancelled !== 1 ? 's' : ''}${failed ? ` · ${failed} skipped` : ''}`;
          }}
        />
        <ActionCard
          icon={Icon.tasks}
          title="Clear Failed Tasks"
          description="Remove all failed tasks from the queue to declutter the task list."
          confirmText="Clear all failed tasks?"
          onRun={async () => {
            const tasks = await PatchAPI.tasks();
            const failed = tasks.filter(t => t.status === 'failed');
            if (failed.length === 0) return 'No failed tasks found.';
            let cleared = 0, errs = 0;
            await Promise.allSettled(failed.map(t =>
              PatchAPI.cancelTask(t.id).then(() => cleared++, () => errs++)
            ));
            return `Cleared ${cleared} failed task${cleared !== 1 ? 's' : ''}${errs ? ` · ${errs} skipped` : ''}`;
          }}
        />
      </ActionGroup>

      <ActionGroup label="Alarms">
        <ActionCard
          icon={Icon.alarms}
          title="Dismiss All Alarms"
          description="Resolve every active alarm at once — use after investigating open alerts."
          confirmText="Dismiss all active alarms?"
          onRun={async () => {
            const res = await PatchAPI.resolveAllAlarms();
            const n = res?.resolved ?? 0;
            return `Dismissed ${n} alarm${n !== 1 ? 's' : ''}`;
          }}
        />
      </ActionGroup>

      <ActionGroup label="Fleet Insights">
        <ActionCard
          icon={Icon.nodes}
          title="Node Health Snapshot"
          description="Fetch live health and trust scores for every backend node."
          onRun={async () => {
            const nodes = await PatchAPI.nodeTrustCenter();
            return { type: 'nodes', nodes };
          }}
        />
        <ActionCard
          icon={Icon.search}
          title="Stale-Inventory Report"
          description="List devices whose last recorded inventory is more than 7 days old."
          onRun={async () => {
            const devices = await PatchAPI.devices();
            const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
            const stale = devices.filter(d => !d.lastSeenAt || new Date(d.lastSeenAt).getTime() < cutoff);
            return { type: 'stale', count: stale.length, devices: stale };
          }}
        />
      </ActionGroup>

      <ActionGroup label="Exports">
        <ActionCard
          icon={Icon.download}
          title="Device Roster (CSV)"
          description="Download all enrolled devices as a spreadsheet-ready CSV."
          onRun={async () => {
            const devices = await PatchAPI.devices();
            const keys = ['id', 'hostname', 'os', 'platform', 'site', 'group', 'online', 'lastSeenAt', 'installedAppCount', 'pendingTaskCount'];
            downloadBlob(toCSV(devices, keys), `1patch-devices-${exportStamp()}.csv`, 'text/csv');
            return `Exported ${devices.length} device${devices.length !== 1 ? 's' : ''}`;
          }}
        />
        <ActionCard
          icon={Icon.download}
          title="Audit Log (JSON)"
          description="Download the last 500 audit entries as a JSON file."
          onRun={async () => {
            const entries = await PatchAPI.audit(500);
            downloadBlob(JSON.stringify(entries, null, 2), `1patch-audit-${exportStamp()}.json`, 'application/json');
            return `Exported ${entries.length} audit entr${entries.length !== 1 ? 'ies' : 'y'}`;
          }}
        />
        <ActionCard
          icon={Icon.download}
          title="Task History (JSON)"
          description="Download the full task list across all statuses as a JSON file."
          onRun={async () => {
            const tasks = await PatchAPI.tasks();
            downloadBlob(JSON.stringify(tasks, null, 2), `1patch-tasks-${exportStamp()}.json`, 'application/json');
            return `Exported ${tasks.length} task${tasks.length !== 1 ? 's' : ''}`;
          }}
        />
      </ActionGroup>
    </div>
  );
}

Object.assign(window, {
  OverviewPage, DevicesPage, AppsPage, PackagesPage, RulesPage, TasksPage, NodesPage, AlarmsPage, AuditPage, SiemPage, SecurityPosturePage, DeviceDrawer, SsoSettingsPage, AdminSettingsPage, QuickActionsPage
});

