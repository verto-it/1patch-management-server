import { Controller, Get, Header } from '@nestjs/common';

@Controller()
export class DashboardUiController {
  @Get('/ui')
  @Header('content-type', 'text/html')
  ui() {
    return dashboardHtml;
  }
}

const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>1Patch Management</title>
  <style>
    :root{font-family:Inter,system-ui,sans-serif;color:#18202f;background:#f7f8fb}
    body{margin:0}.shell{display:grid;grid-template-columns:240px 1fr;min-height:100vh}
    aside{background:#111827;color:#e5e7eb;padding:24px}aside h1{font-size:22px;margin:0 0 24px}
    aside a{display:block;color:#cbd5e1;text-decoration:none;padding:10px 0}
    main{padding:28px 36px}.top{display:flex;justify-content:space-between;align-items:center;gap:16px}
    .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin:24px 0}
    .card,section{background:#fff;border:1px solid #dfe4ec;border-radius:8px;padding:18px}
    .card strong{font-size:30px;display:block;margin-top:8px}
    section{margin:18px 0}h2{margin:0 0 12px;font-size:18px}
    table{width:100%;border-collapse:collapse}th,td{text-align:left;border-top:1px solid #edf0f5;padding:10px;font-size:14px}
    th{color:#64748b;font-weight:700}.muted{color:#64748b}.pill{display:inline-block;border-radius:999px;padding:4px 8px;background:#eef5ff;color:#1463ff;font-size:12px}
    button,input,select{border:1px solid #cbd5e1;border-radius:8px;padding:9px 10px;background:white}
    button{background:#1463ff;color:white;border:0;font-weight:800;cursor:pointer}.row{display:flex;gap:10px;flex-wrap:wrap}
    @media(max-width:1000px){.shell{grid-template-columns:1fr}aside{position:static}.grid{grid-template-columns:1fr 1fr}}
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <h1>1Patch</h1>
      <a href="#summary">Dashboard</a>
      <a href="#devices">Devices</a>
      <a href="#apps">Apps</a>
      <a href="#rules">Rules</a>
      <a href="#tasks">Tasks</a>
      <a href="#nodes">Nodes</a>
      <a href="/docs">API Docs</a>
    </aside>
    <main>
      <div class="top"><div><h1>Management Dashboard</h1><p class="muted">Live data from the management API.</p></div><button onclick="loadAll()">Refresh</button></div>
      <div id="summary" class="grid"></div>
      <section id="devices"><h2>Devices</h2><div id="devicesTable"></div></section>
      <section id="apps"><h2>Apps</h2><div id="appsTable"></div></section>
      <section id="packages"><h2>Package Library</h2><div class="row"><input id="pkgName" placeholder="Name"><input id="pkgPublisher" placeholder="Publisher"><input id="pkgVersion" placeholder="Version"><input id="pkgSha" placeholder="SHA-256"><input id="pkgUrl" placeholder="Source URL"><input id="pkgArgs" placeholder="Install args" value="/qn /norestart"><button onclick="createPackage()">Add Package</button></div><div id="packagesTable"></div></section>
      <section id="rules"><h2>Rules</h2><div class="row"><input id="ruleName" placeholder="Rule name"><select id="ruleProperty"><option value="appName">App name</option><option value="manufacturer">Manufacturer</option><option value="guid">GUID</option><option value="packageId">Package ID</option></select><select id="ruleOperator"><option value="contains">contains</option><option value="equals">equals</option></select><input id="ruleValue" placeholder="Value"><button onclick="createRule()">Create Rule</button></div><div id="rulesTable"></div></section>
      <section id="tasks"><h2>Tasks</h2><div id="tasksTable"></div></section>
      <section id="nodes"><h2>Backend Nodes</h2><div id="nodesTable"></div></section>
      <section><h2>Alarms</h2><div id="alarmsTable"></div></section>
    </main>
  </div>
  <script>
    let token = localStorage.getItem('1patch-admin-token') || '';
    if(!token){ token = prompt('Admin API token (leave empty if none configured)') || ''; localStorage.setItem('1patch-admin-token', token); }
    const authHeaders = () => token ? {'x-1patch-admin-token': token} : {};
    const get = (url) => fetch(url,{headers:authHeaders()}).then(r => r.json());
    const post = (url, body) => fetch(url,{method:'POST',headers:{'content-type':'application/json',...authHeaders()},body:JSON.stringify(body)}).then(r=>r.json());
    const table = (rows, cols) => '<table><thead><tr>'+cols.map(c=>'<th>'+c.label+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+cols.map(c=>'<td>'+String(c.value(row) ?? '')+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
    async function loadAll(){
      const [summary, devices, apps, packages, rules, tasks, nodes] = await Promise.all([get('/dashboard/summary'),get('/devices'),get('/apps'),get('/packages'),get('/rules'),get('/tasks'),get('/nodes')]);
      document.getElementById('summary').innerHTML = [
        ['Managed Devices', summary.managedDevices], ['Online Devices', summary.onlineDevices], ['Apps', summary.appsDiscovered], ['Active Alarms', summary.activeAlarms],
        ['Active Updates', summary.activeUpdates], ['Failed Updates', summary.failedUpdates]
      ].map(([k,v]) => '<div class="card"><span class="muted">'+k+'</span><strong>'+v+'</strong></div>').join('');
      devicesTable.innerHTML = table(devices,[{label:'Host',value:r=>r.hostname},{label:'OS',value:r=>r.os},{label:'Online',value:r=>r.online?'yes':'no'},{label:'Apps',value:r=>r.installedAppCount},{label:'Pending',value:r=>r.pendingTaskCount}]);
      appsTable.innerHTML = table(apps,[{label:'Name',value:r=>r.name},{label:'Publisher',value:r=>r.publisher},{label:'Devices',value:r=>r.deviceCount},{label:'Oldest',value:r=>r.oldestVersion},{label:'Newest installed',value:r=>r.newestInstalledVersion},{label:'Action',value:r=>'<button onclick="updateAll(\\''+r.name.replaceAll("'","")+'\\')">Update all</button>'}]);
      packagesTable.innerHTML = table(packages,[{label:'Name',value:r=>r.name},{label:'Publisher',value:r=>r.publisher},{label:'Version',value:r=>r.version},{label:'Type',value:r=>r.type},{label:'Hash',value:r=>String(r.sha256).slice(0,12)+'...'},{label:'Action',value:r=>'<button onclick="deployPackageAll(\\''+r.id+'\\')">Deploy all</button>'}]);
      rulesTable.innerHTML = table(rules,[{label:'Name',value:r=>r.name},{label:'Match',value:r=>r.property+' '+r.operator+' '+r.value},{label:'Target',value:r=>r.targetVersion},{label:'Enabled',value:r=>r.enabled}]);
      tasksTable.innerHTML = table(tasks,[{label:'App',value:r=>r.appName || r.type},{label:'Device',value:r=>r.deviceId},{label:'Node',value:r=>r.nodeId},{label:'Status',value:r=>'<span class="pill">'+r.status+'</span>'},{label:'Output',value:r=>r.output || ''}]);
      nodesTable.innerHTML = table(nodes,[{label:'Name',value:r=>r.name},{label:'URL',value:r=>r.publicUrl},{label:'Status',value:r=>r.status},{label:'Last seen',value:r=>r.lastSeenAt || ''}]);
      alarmsTable.innerHTML = table(summary.alarms || [],[{label:'Severity',value:r=>r.severity},{label:'Device',value:r=>r.deviceId},{label:'Message',value:r=>r.message},{label:'Time',value:r=>r.createdAt}]);
    }
    async function createRule(){ await post('/rules',{name:ruleName.value,enabled:true,property:ruleProperty.value,operator:ruleOperator.value,value:ruleValue.value,targetVersion:'latest'}); await loadAll(); }
    async function createPackage(){ await post('/packages',{name:pkgName.value,publisher:pkgPublisher.value,version:pkgVersion.value,sourceUrl:pkgUrl.value,sha256:pkgSha.value,installArgs:pkgArgs.value,type:'msi',platform:'windows',architecture:'x64'}); await loadAll(); }
    async function updateAll(name){ await post('/apps/'+encodeURIComponent(name)+'/update-all',{targetVersion:'latest'}); await loadAll(); }
    async function deployPackageAll(id){ await post('/packages/'+encodeURIComponent(id)+'/deploy-all',{}); await loadAll(); }
    loadAll();
  </script>
</body>
</html>`;
