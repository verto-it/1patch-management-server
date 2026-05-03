// Shared SVG icons + small primitives
const Icon = {
  dashboard: (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>),
  devices:  (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3" width="12" height="8" rx="1"/><path d="M5 14h6M8 11v3"/></svg>),
  apps:     (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="4" cy="4" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="4" cy="12" r="2"/><circle cx="12" cy="12" r="2"/></svg>),
  packages: (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2 2 5v6l6 3 6-3V5L8 2zM2 5l6 3 6-3M8 8v6"/></svg>),
  rules:    (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 4h7M3 8h10M3 12h6"/><circle cx="12" cy="4" r="1.5"/><circle cx="11" cy="12" r="1.5"/></svg>),
  tasks:    (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 4h2l1 1h9v8H2zM6 8l1.5 1.5L11 6"/></svg>),
  nodes:    (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="3" r="1.5"/><circle cx="3" cy="13" r="1.5"/><circle cx="13" cy="13" r="1.5"/><path d="M8 4.5v3M7 8.5l-3 3M9 8.5l3 3"/></svg>),
  alarms:   (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2a4 4 0 0 0-4 4v3l-1 2h10l-1-2V6a4 4 0 0 0-4-4zM6.5 13a1.5 1.5 0 0 0 3 0"/></svg>),
  audit:    (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 2h7l3 3v9H3z"/><path d="M10 2v3h3M5 8h6M5 11h4"/></svg>),
  search:   (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>),
  bell:     (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2a4 4 0 0 0-4 4v3l-1 2h10l-1-2V6a4 4 0 0 0-4-4zM6.5 13a1.5 1.5 0 0 0 3 0"/></svg>),
  refresh:  (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 8a5 5 0 0 1 8.5-3.5L13 6M13 8a5 5 0 0 1-8.5 3.5L3 10"/><path d="M13 3v3h-3M3 13v-3h3"/></svg>),
  plus:     (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 3v10M3 8h10"/></svg>),
  arrowR:   (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 4l4 4-4 4"/></svg>),
  windows:  (<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 3.2 7.3 2.5v5H2zM7.9 2.4 14 1.5v6H7.9zM2 8.5h5.3v5L2 12.8zM7.9 8.5H14v6l-6.1-.9z"/></svg>),
  linux:    (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><ellipse cx="8" cy="10" rx="4.5" ry="4"/><circle cx="6.5" cy="6.5" r=".7" fill="currentColor"/><circle cx="9.5" cy="6.5" r=".7" fill="currentColor"/><path d="M7 8.5l1 .8 1-.8"/></svg>),
  close:    (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m4 4 8 8M12 4l-8 8"/></svg>),
  filter:   (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 4h12l-4.5 5v4l-3 1V9z"/></svg>),
  download: (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 3v8m0 0L5 8m3 3 3-3M3 13h10"/></svg>),
  play:     (<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.5v9l8-4.5z"/></svg>),
};

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

function StatusPill({ status }) {
  const map = {
    online:    { cls: "ok",     label: "Online" },
    offline:   { cls: "",       label: "Offline" },
    pending:   { cls: "",       label: "Pending" },
    dispatched:{ cls: "accent", label: "Dispatched" },
    completed: { cls: "ok",     label: "Completed" },
    failed:    { cls: "crit",   label: "Failed" },
    rejected:  { cls: "warn",   label: "Rejected" },
    cancelled: { cls: "",       label: "Cancelled" },
    valid:     { cls: "ok",     label: "Signed" },
    unsigned:  { cls: "warn",   label: "Unsigned" },
    unknown:   { cls: "",       label: "Unknown" },
  };
  const it = map[status] || { cls: "", label: status };
  return <span className={"pill " + it.cls}><span className="dot"/>{it.label}</span>;
}

function OsIcon({ platform }) {
  return <span style={{ display:"inline-flex", width:14, height:14, color:"var(--text-3)" }}>{platform === "linux" ? Icon.linux : Icon.windows}</span>;
}

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

function taskLabel(task) {
  if (!task) return "Task";
  if (task.type === "refresh_inventory") return "Refresh inventory";
  return task.appName || task.packageId || task.packageArtifactId || task.type || task.id;
}

function taskVersionLabel(task) {
  if (!task) return "—";
  if (task.type === "refresh_inventory") return "Inventory scan";
  return (task.fromVersion || "—") + " → " + (task.targetVersion ?? task.toVersion ?? "latest");
}

function sortTasksNewestFirst(tasks) {
  return (tasks || []).slice().sort((a, b) => {
    const aTime = a.createdAt || a.dispatchedAt || a.completedAt || "";
    const bTime = b.createdAt || b.dispatchedAt || b.completedAt || "";
    return bTime.localeCompare(aTime);
  });
}

Object.assign(window, { Icon, Sparkline, Donut, StatusPill, OsIcon, formatOs, taskLabel, taskVersionLabel, sortTasksNewestFirst });
