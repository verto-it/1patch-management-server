// Shared SVG icons + small primitives
const Icon = {
  dashboard: (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>),
  devices:  (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3" width="12" height="8" rx="1"/><path d="M5 14h6M8 11v3"/></svg>),
  groups:   (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2.5" width="5" height="4" rx="1"/><rect x="9" y="2.5" width="5" height="4" rx="1"/><rect x="5.5" y="9.5" width="5" height="4" rx="1"/><path d="M4.5 6.5v1.2c0 .7.4 1.3 1.1 1.6M11.5 6.5v1.2c0 .7-.4 1.3-1.1 1.6"/></svg>),
  apps:     (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="4" cy="4" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="4" cy="12" r="2"/><circle cx="12" cy="12" r="2"/></svg>),
  packages: (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2 2 5v6l6 3 6-3V5L8 2zM2 5l6 3 6-3M8 8v6"/></svg>),
  rules:    (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 4h7M3 8h10M3 12h6"/><circle cx="12" cy="4" r="1.5"/><circle cx="11" cy="12" r="1.5"/></svg>),
  tasks:    (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 4h2l1 1h9v8H2zM6 8l1.5 1.5L11 6"/></svg>),
  nodes:    (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="3" r="1.5"/><circle cx="3" cy="13" r="1.5"/><circle cx="13" cy="13" r="1.5"/><path d="M8 4.5v3M7 8.5l-3 3M9 8.5l3 3"/></svg>),
  alarms:   (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2a4 4 0 0 0-4 4v3l-1 2h10l-1-2V6a4 4 0 0 0-4-4zM6.5 13a1.5 1.5 0 0 0 3 0"/></svg>),
  audit:    (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 2h7l3 3v9H3z"/><path d="M10 2v3h3M5 8h6M5 11h4"/></svg>),
  shield:   (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2 13 4v3.5c0 3-2 5.4-5 6.5-3-1.1-5-3.5-5-6.5V4z"/><path d="m5.8 8 1.4 1.4L10.5 6"/></svg>),
  search:   (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>),
  bell:     (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2a4 4 0 0 0-4 4v3l-1 2h10l-1-2V6a4 4 0 0 0-4-4zM6.5 13a1.5 1.5 0 0 0 3 0"/></svg>),
  refresh:  (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 8a5 5 0 0 1 8.5-3.5L13 6M13 8a5 5 0 0 1-8.5 3.5L3 10"/><path d="M13 3v3h-3M3 13v-3h3"/></svg>),
  plus:     (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 3v10M3 8h10"/></svg>),
  arrowR:   (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 4l4 4-4 4"/></svg>),
  arrowL:   (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M10 4l-4 4 4 4"/></svg>),
  copy:     (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="5" y="5" width="8" height="9" rx="1"/><path d="M3 11V3h8"/></svg>),
  check:    (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 8l3.5 3.5L13 5"/></svg>),
  externalLink: (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M7 3H3v10h10V9M13 3H9m4 0v4"/></svg>),
  lightbulb:    (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2a4 4 0 0 1 2.1 7.4L10 11H6l-.1-1.6A4 4 0 0 1 8 2z"/><path d="M6.5 11h3v1.5h-3zM7.2 13.5h1.6"/></svg>),
  windows:  (<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 3.2 7.3 2.5v5H2zM7.9 2.4 14 1.5v6H7.9zM2 8.5h5.3v5L2 12.8zM7.9 8.5H14v6l-6.1-.9z"/></svg>),
  linux:    (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><ellipse cx="8" cy="10" rx="4.5" ry="4"/><circle cx="6.5" cy="6.5" r=".7" fill="currentColor"/><circle cx="9.5" cy="6.5" r=".7" fill="currentColor"/><path d="M7 8.5l1 .8 1-.8"/></svg>),
  close:    (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m4 4 8 8M12 4l-8 8"/></svg>),
  filter:   (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 4h12l-4.5 5v4l-3 1V9z"/></svg>),
  download: (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 3v8m0 0L5 8m3 3 3-3M3 13h10"/></svg>),
  play:     (<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.5v9l8-4.5z"/></svg>),
  logout:   (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 3H3v10h3M10.5 5.5 13 8l-2.5 2.5M13 8H6"/></svg>),
  settings: (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="2"/><path d="M8 2v1M8 13v1M2 8h1M13 8h1M3.5 3.5l.7.7M11.8 11.8l.7.7M3.5 12.5l.7-.7M11.8 4.2l.7-.7"/></svg>),
};

/**
 * Renders the sparkline UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function Sparkline({ data, color = "var(--accent)", height = 56, width = 240 }) {
  const max = Math.max(...data), min = Math.min(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const pts = data.map((v, i) => [i * stepX, height - ((v - min) / range) * (height - 8) - 4]);
  const line = pts.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const area = line + ` L${width},${height} L0,${height} Z`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none">
      <defs>
        <linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.18"/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <path d={area} fill="url(#sparkfill)"/>
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
      <circle cx={pts[pts.length-1][0]} cy={pts[pts.length-1][1]} r="3" fill={color}/>
    </svg>
  );
}

/**
 * Renders the donut UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function Donut({ value, size = 140, stroke = 14 }) {
  // value 0..100
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (value / 100) * c;
  const color = value >= 90 ? "var(--ok)" : value >= 75 ? "var(--accent)" : value >= 60 ? "var(--warn)" : "var(--crit)";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke}/>
      <circle
        cx={size/2} cy={size/2} r={r}
        fill="none" stroke={color} strokeWidth={stroke}
        strokeDasharray={c} strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size/2} ${size/2})`}
        style={{ transition: "stroke-dashoffset .6s ease" }}
      />
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central"
        fontSize="22" fontWeight="600" fill="var(--text)" style={{ letterSpacing: "-0.02em" }}>
        {value}%
      </text>
    </svg>
  );
}

/**
 * Renders the status pill UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function StatusPill({ status }) {
  const map = {
    online:      { cls: "ok",     label: "Online" },
    offline:     { cls: "",       label: "Offline" },
    pending:     { cls: "",       label: "Pending" },
    dispatched:  { cls: "accent", label: "Dispatched" },
    completed:   { cls: "ok",     label: "Completed" },
    failed:      { cls: "crit",   label: "Failed" },
    rejected:    { cls: "warn",   label: "Rejected" },
    cancelled:   { cls: "",       label: "Cancelled" },
    valid:       { cls: "ok",     label: "Signed" },
    unsigned:    { cls: "warn",   label: "Unsigned" },
    unknown:     { cls: "",       label: "Unknown" },
    healthy:     { cls: "ok",     label: "Healthy" },
    degraded:    { cls: "warn",   label: "Degraded" },
    unhealthy:   { cls: "crit",   label: "Unhealthy" },
    quarantined: { cls: "crit",   label: "Quarantined" },
    stale:       { cls: "",       label: "Stale" },
  };
  const it = map[status] || { cls: "", label: status };
  return <span className={"pill " + it.cls}><span className="dot"/>{it.label}</span>;
}

function fmtBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  return (bytes / 1e3).toFixed(0) + " KB";
}

/**
 * Renders the os icon UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function OsIcon({ platform }) {
  return <span style={{ display:"inline-flex", width:14, height:14, color:"var(--text-3)" }}>{platform === "linux" ? Icon.linux : Icon.windows}</span>;
}

/**
 * Formats the os value.
 *
 * @param os os supplied to the function.
 * @returns The result produced by the operation.
 */
function formatOs(os) {
  const raw = String(os || "").trim();
  if (!raw) return "—";
  const win = raw.match(/(?:Microsoft\s+)?Windows\s+(\d+)\.(\d+)\.(\d+)/i);
  if (!win) return raw.replace(/^Microsoft\s+/i, "");

  const build = Number(win[3]);
  if (!Number.isFinite(build)) return raw.replace(/^Microsoft\s+/i, "");

  const release =
    build >= 26100 ? "24H2" :
    build >= 22631 ? "23H2" :
    build >= 22621 ? "22H2" :
    build >= 22000 ? "21H2" :
    "";
  const name = build >= 22000 ? "Windows 11" : "Windows 10";
  return `${name}${release ? ` ${release}` : ""} (${win[1]}.${win[2]}.${win[3]})`;
}

/**
 * Handles the task label operation.
 *
 * @param task task supplied to the function.
 * @returns The result produced by the operation.
 */
function taskLabel(task) {
  if (!task) return "Task";
  if (task.type === "refresh_inventory") return "Refresh inventory";
  return task.appName || task.packageId || task.packageArtifactId || task.type || task.id;
}

/**
 * Handles the task version label operation.
 *
 * @param task task supplied to the function.
 * @returns The result produced by the operation.
 */
function taskVersionLabel(task) {
  if (!task) return "—";
  if (task.type === "refresh_inventory") return "Inventory scan";
  return (task.fromVersion || "—") + " → " + (task.targetVersion ?? task.toVersion ?? "latest");
}

/**
 * Handles the sort tasks newest first operation.
 *
 * @param tasks tasks supplied to the function.
 * @returns The result produced by the operation.
 */
function sortTasksNewestFirst(tasks) {
  return (tasks || []).slice().sort((a, b) => {
    const aTime = a.createdAt || a.dispatchedAt || a.completedAt || "";
    const bTime = b.createdAt || b.dispatchedAt || b.completedAt || "";
    return bTime.localeCompare(aTime);
  });
}

Object.assign(window, { Icon, Sparkline, Donut, StatusPill, OsIcon, formatOs, taskLabel, taskVersionLabel, sortTasksNewestFirst, fmtBytes });
