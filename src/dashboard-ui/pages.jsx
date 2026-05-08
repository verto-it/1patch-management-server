// AGPL-3.0-only — Page components for the 1Patch management UI (live data, no mocks)
const { useState, useEffect, useMemo, useCallback, useRef } = React;

// ---------- Loader hook ----------
function dataSignature(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

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

function useLiveResource(resource, intervalMs = 5_000) {
  useEffect(() => {
    let inFlight = false;
    const tick = () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      Promise.resolve(resource.reload(true)).finally(() => { inFlight = false; });
    };
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

function Skeleton({ w = "100%", h = 16, r = 4, style }) {
  return <span className="skel" style={{ display:"inline-block", width:w, height:h, borderRadius:r, ...style }}/>;
}
function ErrorAlert({ error, onRetry }) {
  return (
    <div className="alert">
      <strong>Couldn't load.</strong> <span className="muted">{error?.message || String(error)}</span>
      {onRetry && <button className="btn sm" onClick={onRetry}>Retry</button>}
    </div>
  );
}
function SkeletonRows({ n = 6, cols = 6 }) {
  return Array.from({ length: n }).map((_, i) => (
    <tr key={i}>{Array.from({ length: cols }).map((_, j) => <td key={j}><Skeleton w={j === 0 ? 160 : 80}/></td>)}</tr>
  ));
}
function fmtAgo(iso) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

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
  const trend = (history.data || []).map(p => p.value);
  const coverage = trend.length ? trend[trend.length - 1] : (s.coverage ?? 0);
  const trendStart = trend[0] ?? coverage;
  const topApps = (apps.data || []).filter(a => (a.outdatedDeviceCount ?? a.outdated) > 0).slice(0, 6);
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
              <Metric label="Critical CVEs" value={s.criticalCves ?? "—"} tone="crit"/>
              <Metric label="Failed tasks" value={tasks.loading ? "—" : (tasks.data || []).filter(t => t.status === "failed").length} tone="crit"/>
              <Metric label="Active rules" value={s.activeRules ?? "—"}/>
            </div>
          </div>
          <div className="pulse-spark" style={{ display:"flex", flexDirection:"column", justifyContent:"space-between" }}>
            <div className="pulse-sub" style={{ display:"flex", justifyContent:"space-between" }}>
              <span>30-day trend</span>
              {trend.length > 1 && <span style={{ color:"var(--ok)" }}>+{coverage - trendStart}%</span>}
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

function Stat({ label, value, sub, tone }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value" style={tone === "crit" ? { color:"var(--crit)" } : {}}>{value}</div>
      {sub && <div className="delta">{sub}</div>}
    </div>
  );
}
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

function ManualDeviceDialog({ groups, onClose, onCreated }) {
  const [form, setForm] = useState({ tenantId:"default", hostname:"", os:"windows", group:groups[0]?.name || "ungrouped", tags:"", preferredNodeId:"", deviceTrustScore:80, riskScore:"" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
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
function AppsPage({ globalSearch = "" }) {
  const [q, setQ] = useState("");
  const activeQ = globalSearch || q;
  const apps = useResource(() => PatchAPI.apps());
  useLiveResource(apps, 5_000);
  const [queuing, setQueuing] = useState(new Set());
  const [recentlyQueued, setRecentlyQueued] = useState(new Set());
  const [notice, setNotice] = useState(null);

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
  useLiveResource(pkgs, 10_000);
  const deploy = async (id) => { try { await PatchAPI.deployPackageAll(id); } finally { pkgs.reload(); } };
  const rows = (pkgs.data || []).filter(p => textMatches(globalSearch, [p.name, p.publisher, p.version, p.type, p.platform, p.architecture, p.sha256]));
  return (
    <div className="page">
      <div className="page-head">
        <div><h2>Package library</h2><p>Signed artifacts deployed to backend nodes · MSI / winget / apt</p></div>
        <button className="btn primary"><span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.plus}</span>Add package</button>
      </div>
      <div className="card">
        {pkgs.error && <div style={{ padding:16 }}><ErrorAlert error={pkgs.error} onRetry={pkgs.reload}/></div>}
        <table className="tbl">
          <thead><tr><th>Name</th><th>Version</th><th>Type</th><th>Platform</th><th>SHA-256</th><th>Signature</th><th>Created</th><th></th></tr></thead>
          <tbody>
            {pkgs.loading && <SkeletonRows n={5} cols={8}/>}
            {!pkgs.loading && rows.length === 0 && <tr><td colSpan={8} style={{ padding:24, color:"var(--text-3)" }}>No packages uploaded.</td></tr>}
            {!pkgs.loading && rows.map(p => (
              <tr key={p.id || p.sha256}>
                <td><div><strong style={{ fontWeight:500 }}>{p.name}</strong><div className="muted" style={{ fontSize:12 }}>{p.publisher}</div></div></td>
                <td className="mono">{p.version}</td>
                <td><span className="pill">{p.type}</span></td>
                <td className="muted">{p.platform}{p.architecture ? " · " + p.architecture : ""}</td>
                <td className="mono muted" title={p.sha256}>{p.sha256 ? `${p.sha256.slice(0,12)}…` : "—"}</td>
                <td><StatusPill status={p.signatureStatus}/></td>
                <td className="muted">{fmtAgo(p.createdAt)}</td>
                <td><button className="btn sm" onClick={() => deploy(p.id)}>Deploy</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Rules ----------
function RulesPage({ globalSearch = "" }) {
  const [editing, setEditing] = useState(null);
  const [testing, setTesting] = useState(null);
  const rules = useResource(() => PatchAPI.rules());
  const audit = useResource(() => PatchAPI.ruleAudit());
  useLiveResource(rules, 10_000);
  useLiveResource(audit, 10_000);
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

function RuleWizard({ rule, onClose, onCreated }) {
  const [step, setStep] = useState(() => rule?.id ? "trigger" : "templates");
  const [form, setForm] = useState(() => normalizeRuleForm(rule));
  const templates = useResource(() => PatchAPI.ruleTemplates(form.tenantId || "default").catch(() => DASHBOARD_RULE_TEMPLATES), [form.tenantId]);
  const [templateCategory, setTemplateCategory] = useState("Recommended");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateInputs, setTemplateInputs] = useState({});
  const [templatePreview, setTemplatePreview] = useState(null);
  const devices = useResource(() => PatchAPI.devices(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
  const templateRows = templates.data || [];
  const deviceGroups = useMemo(() => buildDeviceGroupOptions(devices.data || []), [devices.data]);
  const templateCategories = ["Recommended","Patch Automation","Security / Inventory","Failure Handling","Compliance","Notifications"];
  const selectedTemplate = templateRows.find(t => t.id === selectedTemplateId) || templateRows.find(t => t.category === templateCategory) || templateRows[0];
  useEffect(() => {
    if (!selectedTemplateId && selectedTemplate?.id) setSelectedTemplateId(selectedTemplate.id);
  }, [selectedTemplateId, selectedTemplate?.id]);
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
                  <button type="button" className="btn" onClick={() => setStep("trigger")}>Blank rule</button>
                </div>
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
                  {form.actionType === "create_patch_task" && form.patchMode === "specific_package" && <label className="field"><span>Package</span><input value={form.packageName} onChange={e => set("packageName", e.target.value)} placeholder="Google Chrome"/></label>}
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

function RuleTester({ rule, onClose, onExecuted }) {
  const devices = useResource(() => PatchAPI.devices());
  const [deviceId, setDeviceId] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState("");
  const sampleId = deviceId || devices.data?.[0]?.id || "";
  const test = async () => { setBusy("test"); try { setResult(await PatchAPI.testRule(rule.id, { deviceId: sampleId })); } finally { setBusy(""); } };
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

function withTemplateDefaults(template, values, tenantId) {
  const out = { ...values, tenantId };
  (template.requiredInputs || []).forEach(input => {
    if (out[input.id] === undefined || out[input.id] === "") out[input.id] = input.defaultValue;
  });
  return out;
}
function templateInputDisplay(value) {
  if (value && typeof value === "object") {
    if (Number.isFinite(value.startHourUtc) && Number.isFinite(value.endHourUtc)) return `${value.startHourUtc}-${value.endHourUtc}`;
    return JSON.stringify(value);
  }
  return value ?? "";
}
function parseTemplateInput(input, value) {
  if (input.type === "number") return Number(value || 0);
  if (input.type === "maintenance_window") {
    const match = String(value).match(/(\d{1,2})\D+(\d{1,2})/);
    return { daysOfWeek:[0], startHourUtc: match ? Number(match[1]) : 3, endHourUtc: match ? Number(match[2]) : 5 };
  }
  return value;
}
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
function DeviceGroupPicker({ input, groups, loading, value, onChange }) {
  return (
    <div className="field">
      <span>{input.label}</span>
      {loading ? <div className="skel" style={{ height:42, borderRadius:6 }}/> : <GroupSelect groups={groups} value={value} onChange={onChange}/>}
      <small className="field-hint">{groups.length ? "Search and select an existing device group, or type a new one." : "No groups found yet. Add or enroll devices to build group options."}</small>
    </div>
  );
}
function MaintenanceWindowPicker({ input, value, onChange }) {
  const current = value && typeof value === "object" ? value : { daysOfWeek:[0], startHourUtc:3, endHourUtc:5 };
  const selectedDays = new Set(current.daysOfWeek?.length ? current.daysOfWeek : [0]);
  const setDay = (day) => {
    const next = new Set(selectedDays);
    next.has(day) ? next.delete(day) : next.add(day);
    onChange({ ...current, daysOfWeek:[...next].sort((a, b) => a - b) });
  };
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
function hourOptions(min, max) {
  const items = [];
  for (let hour = min; hour <= max; hour++) items.push(<option key={hour} value={hour}>{formatHour(hour)}</option>);
  return items;
}
function formatHour(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}
function daysLabel(days) {
  if (days.length === 7) return "Daily";
  return days.map(day => ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][day]).join(", ");
}
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
function replaceTemplateValues(value, inputs) {
  if (typeof value === "string" && value.startsWith("$input.")) return inputs[value.slice(7)];
  if (Array.isArray(value)) return value.map(item => replaceTemplateValues(item, inputs));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, replaceTemplateValues(nested, inputs)]));
  return value;
}
const DASHBOARD_RULE_TEMPLATES = [
  { id:"weekly-browser-updates", name:"Weekly Browser Updates", description:"Patch Chrome, Edge, and Firefox on Windows during a maintenance window.", category:"Recommended", recommendedSecurityMode:"strict", riskLevel:"medium", tags:["browser","windows"], trigger:{ type:"schedule" }, schedule:{ cron:"0 3 * * 0", maintenanceWindow:{ daysOfWeek:[0], startHourUtc:3, endHourUtc:5 } }, conditions:{ combinator:"AND", conditions:[{ field:"device.group", operator:"eq", value:"$input.targetDeviceGroup" },{ field:"device.os", operator:"eq", value:"windows" },{ field:"package.name", operator:"in", value:["Google Chrome","Microsoft Edge","Mozilla Firefox","Chrome","Edge","Firefox"] },{ field:"package.outdated", operator:"eq", value:true },{ field:"currentTime.maintenanceWindow", operator:"eq", value:true }] }, actions:[{ type:"create_patch_task", mode:"all_outdated", targetVersion:"latest" }], requiredInputs:[{ id:"targetDeviceGroup", label:"Target device group", type:"device_group", required:true, description:"Select the group to target." },{ id:"maintenanceWindow", label:"Maintenance window", type:"maintenance_window", required:true, description:"UTC hours", defaultValue:{ daysOfWeek:[0], startHourUtc:3, endHourUtc:5 } }], explanation:["update Chrome, Edge, and Firefox when they are outdated","use delayed execution and security scanning before dispatch"], safety:["delayed execution required","security scan required","disabled by default"] },
  { id:"critical-patch-fast-track", name:"Critical Patch Fast Track", description:"Fast-track critical package drafts while keeping production behind approval gates.", category:"Recommended", recommendedSecurityMode:"tinfoil", riskLevel:"high", trigger:{ type:"event", eventType:"vulnerability.detected" }, schedule:{}, conditions:{ combinator:"AND", conditions:[{ field:"device.group", operator:"neq", value:"production" },{ field:"package.severity", operator:"eq", value:"critical" },{ field:"package.outdated", operator:"eq", value:true }] }, actions:[{ type:"create_patch_task", mode:"all_outdated", targetVersion:"latest" },{ type:"notify", channel:"siem", message:"Critical patch fast-track draft created" }], requiredInputs:[], explanation:["create patch task drafts for critical packages","send a SIEM notification"], safety:["MFA approval required","high-risk approval policy applies"] },
  { id:"refresh-inventory-daily", name:"Refresh Inventory Daily", description:"Refresh stale inventory on a daily schedule.", category:"Security / Inventory", recommendedSecurityMode:"normal", riskLevel:"low", trigger:{ type:"schedule" }, schedule:{ cron:"0 1 * * *" }, conditions:{ combinator:"AND", conditions:[{ field:"device.group", operator:"eq", value:"$input.targetDeviceGroup" },{ field:"device.lastInventoryAgeHours", operator:"gt", value:24 }] }, actions:[{ type:"create_security_task", task:"refresh_inventory" }], requiredInputs:[{ id:"targetDeviceGroup", label:"Target device group", type:"device_group", required:true, description:"Select the group to refresh." }], explanation:["refresh inventory for devices older than 24 hours"], safety:["low risk","uses supported signed refresh task"] },
  { id:"retry-failed-updates", name:"Retry Failed Updates", description:"Retry transient failures with capped exponential backoff.", category:"Failure Handling", recommendedSecurityMode:"strict", riskLevel:"medium", trigger:{ type:"event", eventType:"task.failed" }, schedule:{}, conditions:{ combinator:"AND", conditions:[{ field:"lastTask.failed", operator:"eq", value:true },{ field:"lastTask.retryCount", operator:"lt", value:"$input.retryLimit" },{ field:"lastTask.failureRetryable", operator:"eq", value:true }] }, actions:[{ type:"create_patch_task", mode:"all_outdated", targetVersion:"latest", retryLimit:"$input.retryLimit", backoff:"exponential", maxDevices:1 }], requiredInputs:[{ id:"retryLimit", label:"Retry limit", type:"number", required:true, description:"Maximum attempts", defaultValue:2 }], explanation:["create one retry task when the failure is retryable"], safety:["exponential backoff","retry count prevents loops"] },
  { id:"patch-test-group-first", name:"Patch Test Group First", description:"Patch test devices before any production rollout.", category:"Patch Automation", recommendedSecurityMode:"strict", riskLevel:"low", trigger:{ type:"schedule" }, schedule:{ cron:"0 2 * * 0" }, conditions:{ combinator:"AND", conditions:[{ field:"device.group", operator:"eq", value:"test" },{ field:"package.outdated", operator:"eq", value:true }] }, actions:[{ type:"create_patch_task", mode:"all_outdated", targetVersion:"latest" }], requiredInputs:[], explanation:["create patch task drafts only for the test group"], safety:["no production devices affected"] },
  { id:"notify-on-high-risk-task", name:"Notify on High-Risk Task", description:"Notify security systems when a task scan returns high risk.", category:"Notifications", recommendedSecurityMode:"normal", riskLevel:"low", trigger:{ type:"event", eventType:"task.security_scan.completed" }, schedule:{}, conditions:{ combinator:"AND", conditions:[{ field:"riskScore", operator:"gte", value:70 }] }, actions:[{ type:"notify", channel:"siem", message:"High-risk task detected by rule template" }], requiredInputs:[], explanation:["send SIEM and configured notifications for high-risk task scans"], safety:["no execution action"] },
  { id:"production-maintenance-window-only", name:"Production Maintenance Window Only", description:"Permit production patch drafts only inside a configured maintenance window.", category:"Compliance", recommendedSecurityMode:"tinfoil", riskLevel:"high", trigger:{ type:"schedule" }, schedule:{ cron:"0 3 * * 0", maintenanceWindow:{ daysOfWeek:[0], startHourUtc:3, endHourUtc:5 } }, conditions:{ combinator:"AND", conditions:[{ field:"device.group", operator:"eq", value:"production" },{ field:"currentTime.maintenanceWindow", operator:"eq", value:true },{ field:"package.outdated", operator:"eq", value:true }] }, actions:[{ type:"create_patch_task", mode:"all_outdated", targetVersion:"latest" }], requiredInputs:[{ id:"maintenanceWindow", label:"Maintenance window", type:"maintenance_window", required:true, description:"UTC hours", defaultValue:{ daysOfWeek:[0], startHourUtc:3, endHourUtc:5 } }], explanation:["create production patch task drafts only during the configured window"], safety:["delayed execution required","approval required"] },
  { id:"block-unsafe-automation", name:"Block Unsafe Automation", description:"Block unsafe automation candidates and notify admins.", category:"Compliance", recommendedSecurityMode:"tinfoil", riskLevel:"low", trigger:{ type:"event", eventType:"rule.task_candidate.created" }, schedule:{}, conditions:{ combinator:"OR", conditions:[{ field:"riskScore", operator:"gte", value:90 },{ field:"task.sourceHostTrusted", operator:"eq", value:false },{ field:"task.hashPresent", operator:"eq", value:false }] }, actions:[{ type:"block_task_creation", reason:"Unsafe automation candidate" },{ type:"notify", channel:"siem", message:"Blocked unsafe automation candidate" }], requiredInputs:[], explanation:["do not create an executable task","notify admins and SIEM"], safety:["no hidden task","no arbitrary command"] },
];
function defaultRule() {
  return { enabled:true, tenantId:"default", name:"", description:"", priority:100, trigger:{ type:"manual" }, conditionGroup:{ combinator:"AND", conditions:[{ field:"package.outdated", operator:"eq", value:true }] }, actions:[{ type:"create_patch_task", mode:"all_outdated", targetVersion:"latest" }], schedule:{ maintenanceWindow:{ startHourUtc:0, endHourUtc:6 } }, safeMode:{ enabled:true, requireApprovalAtRiskScore:60 } };
}
function normalizeRuleForm(rule) {
  const r = rule || defaultRule();
  const action = (r.actions || defaultRule().actions)[0];
  return { id:r.id, tenantId:r.tenantId || "default", name:r.name || "", description:r.description || "", enabled:r.enabled !== false, priority:r.priority ?? 100, triggerType:r.trigger?.type || "manual", eventType:r.trigger?.eventType || "device.inventory.updated", cron:r.schedule?.cron || "0 2 * * 0", combinator:r.conditionGroup?.combinator || "AND", conditions:r.conditionGroup?.conditions?.filter(c => !c.combinator) || [], actionType:action.type, patchMode:action.mode || "all_outdated", packageName:action.packageName || "", targetVersion:action.targetVersion || "latest", securityTask:action.task || "refresh_inventory", notifyMessage:action.message || "Rule matched", tag:action.tag || "rule-matched", blockReason:action.reason || "Unsafe automation candidate", startHourUtc:r.schedule?.maintenanceWindow?.startHourUtc ?? 0, endHourUtc:r.schedule?.maintenanceWindow?.endHourUtc ?? 6, requireApprovalAtRiskScore:r.safeMode?.requireApprovalAtRiskScore ?? 60, sourceTemplateId:r.sourceTemplateId, sourceTemplateName:r.sourceTemplateName };
}
function rulePayload(form) {
  const action = form.actionType === "create_patch_task" ? { type:"create_patch_task", mode:form.patchMode, packageName:form.packageName || undefined, targetVersion:form.targetVersion || "latest" } : form.actionType === "create_security_task" ? { type:"create_security_task", task:form.securityTask } : form.actionType === "notify" ? { type:"notify", channel:"siem", message:form.notifyMessage || "Rule matched" } : form.actionType === "block_task_creation" ? { type:"block_task_creation", reason:form.blockReason || "Unsafe automation candidate" } : { type:"mark_device", tag:form.tag || "rule-matched" };
  return { tenantId:form.tenantId || "default", name:form.name.trim(), description:form.description.trim(), enabled:form.enabled, priority:Number(form.priority || 100), trigger:{ type:form.triggerType, ...(form.triggerType === "event" ? { eventType:form.eventType } : {}) }, conditionGroup:{ combinator:form.combinator, conditions:form.conditions }, actions:[action], schedule:{ cron:form.triggerType === "schedule" ? form.cron : undefined, maintenanceWindow:{ startHourUtc:Number(form.startHourUtc), endHourUtc:Number(form.endHourUtc) } }, safeMode:{ enabled:true, requireApprovalAtRiskScore:Number(form.requireApprovalAtRiskScore || 60) }, sourceTemplateId:form.sourceTemplateId, sourceTemplateName:form.sourceTemplateName };
}
function updateCondition(setForm, index, patch) { setForm(prev => ({ ...prev, conditions: prev.conditions.map((c,i) => i === index ? { ...c, ...patch } : c) })); }
function removeCondition(setForm, index) { setForm(prev => ({ ...prev, conditions: prev.conditions.filter((_, i) => i !== index) })); }
function parseConditionValue(value) { if (value === "true") return true; if (value === "false") return false; const n = Number(value); return value.trim() !== "" && Number.isFinite(n) ? n : value; }
function conditionSummary(group) { const count = group?.conditions?.length || 0; return `${group?.combinator || "AND"} · ${count} condition${count === 1 ? "" : "s"}`; }
function actionSummary(action) { if (!action) return "none"; if (action.type === "create_patch_task") return action.mode === "all_outdated" ? "patch all outdated" : `patch ${action.packageName || action.packageId || "package"}`; if (action.type === "create_security_task") return action.task; if (action.type === "notify") return `notify ${action.channel}`; if (action.type === "mark_device") return `tag ${action.tag}`; return action.type; }

// ---------- Tasks ----------
function TasksPage({ globalSearch = "" }) {
  const [filter, setFilter] = useState("all");
  const tasks = useResource(() => PatchAPI.tasks());
  useLiveResource(tasks, 2_500);
  const [cancelling, setCancelling] = useState(new Set());
  const [outputTask, setOutputTask] = useState(null);
  const [copied, setCopied] = useState(false);

  const cancel = async (id) => {
    setCancelling(prev => new Set([...prev, id]));
    try { await PatchAPI.cancelTask(id); tasks.reload(true); }
    catch (e) { /* task may have already moved past pending */ }
    finally { setCancelling(prev => { const s = new Set(prev); s.delete(id); return s; }); }
  };

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
      </div>
      <div className="card">
        <div className="filterbar">
          {[["all","All"],["pending","Pending"],["dispatched","Dispatched"],["completed","Completed"],["failed","Failed"],["cancelled","Cancelled"]].map(([k,l]) => (
            <button key={k} className={"chip " + (filter === k ? "active" : "")} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
        {tasks.error && <div style={{ padding:16 }}><ErrorAlert error={tasks.error} onRetry={tasks.reload}/></div>}
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
                      onClick={() => t.output && setOutputTask(t)}>{t.output || "—"}</td>
                  <td className="muted">{fmtAgo(t.createdAt)}</td>
                  <td>{t.status === "pending" && (
                    <button className="btn sm" disabled={cancelling.has(t.id)} onClick={() => cancel(t.id)}>
                      {cancelling.has(t.id) ? "…" : "Cancel"}
                    </button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {outputTask && (
        <React.Fragment>
          <div className="drawer-backdrop" onClick={() => setOutputTask(null)}/>
          <div className="output-dialog">
            <div className="output-dialog-box">
              <div className="output-dialog-head">
                <h4>{taskLabel(outputTask)}</h4>
                <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                  <button className="btn sm" onClick={copyOutput}>{copied ? "Copied!" : "Copy"}</button>
                  <button className="icon-btn" onClick={() => setOutputTask(null)}>
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
    </div>
  );
}

// ---------- Nodes ----------
function NodesPage({ globalSearch = "" }) {
  const nodes = useResource(() => PatchAPI.nodes());
  useLiveResource(nodes, 5_000);
  const rows = (nodes.data || []).filter(n => textMatches(globalSearch, [n.name, n.id, n.publicUrl, n.url, n.region, n.site, n.status, n.version]));
  const [enrolling, setEnrolling] = useState(false);
  const [enrollment, setEnrollment] = useState(null);
  return (
    <div className="page">
      <div className="page-head">
        <div><h2>Backend nodes</h2><p>Regional workers that fan out tasks to enrolled clients</p></div>
        <button className="btn primary" onClick={() => { setEnrollment(null); setEnrolling(true); }}>
          <span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.plus}</span>Enroll node
        </button>
      </div>
      {nodes.error && <ErrorAlert error={nodes.error} onRetry={nodes.reload}/>}
      <div className="row-3">
        {nodes.loading && Array.from({ length:3 }).map((_,i) => <div className="card" key={i}><div className="card-body"><Skeleton h={80}/></div></div>)}
        {!nodes.loading && rows.length === 0 && <div className="card"><div className="card-body" style={{ color:"var(--text-3)" }}>No nodes enrolled.</div></div>}
        {!nodes.loading && rows.map(n => (
          <div className="card" key={n.id}>
            <div className="card-body" style={{ display:"flex", flexDirection:"column", gap:14 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
                <div>
                  <div style={{ fontWeight:600, fontSize:15 }}>{n.name}</div>
                  <div className="muted mono" style={{ fontSize:12 }}>{n.publicUrl || n.url}</div>
                </div>
                <StatusPill status={n.status}/>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, paddingTop:12, borderTop:"1px solid var(--line)" }}>
                <div><div className="muted" style={{ fontSize:11 }}>REGION</div><div className="mono" style={{ fontSize:13 }}>{n.region || "—"}</div></div>
                <div><div className="muted" style={{ fontSize:11 }}>VERSION</div><div className="mono" style={{ fontSize:13 }}>{n.version || "—"}</div></div>
                <div><div className="muted" style={{ fontSize:11 }}>CAPACITY</div><div className="mono" style={{ fontSize:13 }}>{n.capacity ? JSON.stringify(n.capacity) : "—"}</div></div>
                <div><div className="muted" style={{ fontSize:11 }}>LAST SEEN</div><div className="mono" style={{ fontSize:13 }}>{fmtAgo(n.lastSeenAt)}</div></div>
              </div>
            </div>
          </div>
        ))}
      </div>
      {enrolling && (
        <EnrollNodeDrawer
          result={enrollment}
          onClose={() => setEnrolling(false)}
          onCreated={(created) => { setEnrollment(created); nodes.reload(); }}
        />
      )}
    </div>
  );
}

function EnrollNodeDrawer({ result, onClose, onCreated }) {
  const [form, setForm] = useState({ name:"", publicUrl:"http://localhost:4200", region:"", site:"" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const enrollmentJson = result ? JSON.stringify(result, null, 2) : "";
  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));
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
      onCreated(created);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    await copyTextToClipboard(enrollmentJson);
  };

  return (
    <React.Fragment>
      <div className="drawer-backdrop" onClick={onClose}/>
      <div className="drawer">
        <div className="drawer-head">
          <h3>Enroll backend node</h3>
          <button className="icon-btn" onClick={onClose}><span style={{ width:14, height:14, display:"inline-flex" }}>{Icon.close}</span></button>
        </div>
        <div className="drawer-body">
          {!result && (
            <form onSubmit={submit} style={{ display:"flex", flexDirection:"column", gap:14 }}>
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
              {error && <ErrorAlert error={error}/>}
              <div style={{ display:"flex", justifyContent:"flex-end", gap:8 }}>
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button className="btn primary" disabled={busy}>{busy ? "Creating…" : "Create enrollment"}</button>
              </div>
            </form>
          )}
          {result && (
            <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
              <div className="alert" style={{ color:"var(--ok)", background:"var(--ok-soft)", borderColor:"transparent" }}>
                <strong>Enrollment created.</strong><span className="muted">Use this JSON in the backend node setup.</span>
              </div>
              <textarea className="codebox" readOnly value={enrollmentJson}/>
              <div style={{ display:"flex", justifyContent:"flex-end", gap:8 }}>
                <button className="btn" onClick={copy}>Copy JSON</button>
                <button className="btn primary" onClick={onClose}>Done</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </React.Fragment>
  );
}

// ---------- Alarms ----------
function AlarmsPage({ globalSearch = "" }) {
  const alarms = useResource(() => PatchAPI.alarms());
  useLiveResource(alarms, 5_000);
  const resolve = async (id) => { try { await PatchAPI.resolveAlarm(id); } finally { alarms.reload(); } };
  const rows = (alarms.data || []).filter(a => textMatches(globalSearch, [a.message, a.deviceId, a.severity, a.id]));
  return (
    <div className="page">
      <div className="page-head">
        <div><h2>Alarms</h2><p>{alarms.loading ? "…" : `${rows.length} active across the fleet`}</p></div>
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

  const payload = () => {
    const next = mergeSiemConfig(form);
    if (!next.webhook.url) delete next.webhook;
    if (!next.syslog.host) delete next.syslog;
    if (!next.sentinel.workspaceId) delete next.sentinel;
    return next;
  };

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

function defaultSiemConfig() {
  return {
    mode: "standard",
    webhook: { url: "", secret: "" },
    syslog: { host: "", port: 514, protocol: "udp", appName: "1patch" },
    sentinel: { workspaceId: "", sharedKey: "", logType: "OnePatchEvents" },
    exportOverrides: {},
  };
}

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
function SecurityPosturePage() {
  const [tenantId, setTenantId] = useState("default");
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState("");
  const posture = useResource(() => PatchAPI.securityPosture(tenantId), [tenantId]);
  const report = posture.data;
  const critical = report?.findingsBySeverity?.critical || [];
  const findings = report?.findings || [];
  const safeFixCount = findings.filter(f => f.autoFixAvailable && f.severity !== "critical").length;

  const rerun = () => {
    setNotice(null);
    posture.reload(false);
  };
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

function severityTone(severity) {
  return severity === "critical" ? "crit" : severity === "high" || severity === "medium" ? "warn" : "accent";
}
function modeTone(mode) {
  return mode === "tinfoil" ? "crit" : mode === "strict" ? "ok" : "warn";
}
function enterpriseVerdict(score, criticalCount) {
  if (criticalCount > 0) return "Not enterprise-ready yet";
  if (score >= 85) return "Enterprise-ready posture";
  if (score >= 70) return "Close, with remediation needed";
  return "Needs security hardening";
}

// ---------- Device drawer ----------
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

  const refresh = async () => { try { await PatchAPI.refreshInventory(deviceId); } finally { detail.reload(); } };
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

Object.assign(window, {
  OverviewPage, DevicesPage, AppsPage, PackagesPage, RulesPage, TasksPage, NodesPage, AlarmsPage, AuditPage, SiemPage, SecurityPosturePage, DeviceDrawer
});

