  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // value → JS literal safe inside an onclick="…" attribute
  const js = (v) => esc(JSON.stringify(v));
  const token = () => localStorage.getItem('opsAgentToken') || '';
  // inline icon from the sprite in index.html
  const ic = (name, cls = '') => `<svg class="ic ${cls}"><use href="#i-${name}"/></svg>`;

  // ── formatting ──────────────────────────
  const fmtBytes = (b) => {
    if (!b) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(4, Math.floor(Math.log(b) / Math.log(1024)));
    return (b / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
  };
  const fmtDur = (sec) => {
    sec = Math.max(0, Math.round(sec));
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${sec % 60}s` : `${sec}s`;
  };
  // short size for tiles: 517 MB, 3.5 GB
  const fmtShort = (b) => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + ' GB' : Math.round(b / 1024 ** 2) + ' MB');
  const setBar = (id, pct) => {
    $(id).style.width = Math.min(100, pct).toFixed(0) + '%';
    $(id).className = pct > 85 ? 'hot' : pct > 65 ? 'mid' : '';
  };

  // ── API ─────────────────────────────────
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-ops-token': token() },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
    if (res.status === 401) { showLogin(data.message); throw new Error(data.message); }
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    return data;
  }

  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML = ic(type === 'ok' ? 'check' : type === 'err' ? 'alert' : 'info') + '<span></span>';
    el.lastChild.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  // Runs an action; on success shows a toast and points to the Activity tab.
  async function act(path, body, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    try {
      const r = await api(path, { method: 'POST', body });
      toast(r.message + ' — see Activity', 'ok');
      return r;
    } catch (err) { toast(err.message, 'err'); }
  }

  // ── modal ───────────────────────────────
  function openModal(title, bodyHtml, footHtml = '') {
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = bodyHtml;
    $('modalFoot').innerHTML = footHtml + '<button type="button" class="b-grey" onclick="closeModal()">Close</button>';
    $('modal').classList.add('show');
  }
  function closeModal() { $('modal').classList.remove('show'); }

  // ── login ───────────────────────────────
  function showLogin(msg = '') {
    $('loginErr').textContent = msg;
    $('login').classList.add('show');
    setTimeout(() => $('tokenInput').focus(), 50);
  }
  async function login() {
    localStorage.setItem('opsAgentToken', $('tokenInput').value.trim());
    try {
      await api('/system');
      $('login').classList.remove('show');
      start();
    } catch (err) { $('loginErr').textContent = err.message; }
  }
  function logout() {
    localStorage.removeItem('opsAgentToken');
    location.reload();
  }

  // ── tabs / page header ──────────────────
  // [bold title, subtitle, icon, light first word of the big heading, tab label]
  const PAGES = {
    overview: ['Server', 'Everything happening on your server right now', 'grid', 'My', 'Overview'],
    projects: ['Projects', 'Every app running under PM2: deploy, restart, scale', 'box', 'My', 'Projects'],
    monitors: ['Monitors', 'Uptime checks with automatic healing', 'pulse', 'Uptime', 'Monitors'],
    activity: ['Activity', 'Run commands and follow every action live', 'zap', 'Live', 'Activity'],
    code: ['Editor', 'Edit your projects right on the server', 'code', 'Code', 'Code'],
    terminal: ['Terminal', 'A full shell on the server, in your browser', 'terminal', 'Server', 'Terminal'],
    files: ['Manager', 'Browse, edit, upload and download files', 'folder', 'File', 'Files'],
    logs: ['Logs', 'Output and error logs of every project', 'logs', 'Project', 'Logs'],
    services: ['Services', 'System services like Redis, nginx and cron', 'server', 'System', 'Services'],
    redis: ['Cache', 'Cache statistics and key browser', 'database', 'Redis', 'Redis'],
    cron: ['Jobs', 'Tasks that run on a schedule', 'timer', 'Cron', 'Cron jobs'],
    security: ['Center', 'Logins, blocked IPs and the audit log', 'shield', 'Security', 'Security'],
    settings: ['Settings', 'Alerts, thresholds and quick commands', 'sliders', 'Panel', 'Settings'],
  };
  const GROUPS = {
    monitor: ['overview', 'projects', 'monitors', 'activity'],
    build: ['code', 'terminal', 'files', 'logs'],
    system: ['services', 'redis', 'cron', 'security', 'settings'],
  };
  const groupOf = (tab) => Object.keys(GROUPS).find((g) => GROUPS[g].includes(tab)) || 'monitor';
  const lastTabInGroup = {};

  let activeTab = 'overview';
  let activeGroup = 'monitor';
  $('nav').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (btn) showTab(btn.dataset.tab);
  });
  $('rail').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-group]');
    if (btn) showTab(lastTabInGroup[btn.dataset.group] || GROUPS[btn.dataset.group][0]);
  });

  // Pill tab row = the pages of the current rail group.
  function renderPillTabs() {
    const running = [...jobs.values()].filter((j) => j.status === 'running').length;
    $('nav').innerHTML = GROUPS[activeGroup].map((t) => `<button type="button" data-tab="${t}" class="${t === activeTab ? 'active' : ''}">
      ${ic(PAGES[t][2])}${PAGES[t][4]}${t === 'activity' ? `<span class="badge" id="runningBadge" ${running ? '' : 'hidden'}>${running}</span>` : ''}</button>`).join('');
    document.querySelectorAll('#rail button').forEach((b) => b.classList.toggle('active', b.dataset.group === activeGroup));
  }

  function setThemeIcon() {
    $('themeIcon').innerHTML = `<use href="#i-${document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon'}"/>`;
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('opsTheme', next);
    setThemeIcon();
    if (window.monaco) monaco.editor.setTheme(next === 'dark' ? 'opsedge' : 'opsedge-light');
    drawCharts();
  }

  function toggleSidebar(open) {
    $('sidebar').classList.toggle('open', open ?? !$('sidebar').classList.contains('open'));
  }

  function showTab(name) {
    activeTab = name;
    activeGroup = groupOf(name);
    lastTabInGroup[activeGroup] = name;
    document.body.dataset.section = activeGroup; // section colour (green / orange / sky)
    $('secChip').textContent = activeGroup;
    renderPillTabs();
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
    const [title, sub, , light, label] = PAGES[name] || [name, '', '', '', name];
    $('pageLight').textContent = light;
    $('pageTitle').textContent = title;
    $('pageSub').textContent = sub;
    document.title = `${label} · OpsEdge`;
    toggleSidebar(false);
    if (name === 'overview') { loadSystem(); loadProjects(); }
    if (name === 'projects') loadProjects();
    if (name === 'services') loadServices();
    if (name === 'files' && !currentDir) browse('');
    if (name === 'logs') fillLogProjects();
    if (name === 'terminal') { if (!termSocket) newTerminal(); else setTimeout(fitTerm, 30); }
    if (name === 'overview') setTimeout(drawCharts, 30);
    if (name === 'monitors') loadMonitors();
    if (name === 'code') initCode();
    if (name === 'redis') loadRedisInfo();
    if (name === 'cron') loadCron();
    if (name === 'security') loadSecurity();
    if (name === 'settings') loadSettings();
    if (name === 'activity') renderQuickCmds();
  }

  // ── overview ────────────────────────────
  async function loadSystem() {
    try {
      const s = await api('/system');
      $('connDot').className = 'dot on';
      $('hostName').textContent = s.hostname;
      $('hostInfo').textContent = `${s.user} · Node ${s.node} · ${s.cpus} vCPU`;
      if (serverUser !== s.user) { serverUser = s.user; tickClock(); }
      const load = s.loadAvg[0];
      $('cpuVal').textContent = `${load.toFixed(2)} / ${s.cpus}`;
      setBar('cpuBar', (load / s.cpus) * 100);
      const used = s.memory.totalBytes - s.memory.freeBytes;
      $('railAvatar').querySelector('b').textContent = (s.user || 'U')[0].toUpperCase();
      $('railAvatar').title = `${s.user}@${s.hostname}`;
      const memPct = (used / s.memory.totalBytes) * 100;
      usageCard('mem', used, s.memory.totalBytes, memPct);
      if (s.disk) usageCard('disk', s.disk.usedBytes, s.disk.totalBytes, (s.disk.usedBytes / s.disk.totalBytes) * 100);
      renderPromo(s, memPct);
      renderHealth2(s, memPct);
      $('upVal').textContent = fmtDur(s.uptimeSec);
      $('osVal').textContent = s.platform;

      if (s.swap?.totalBytes) {
        const swapUsed = s.swap.totalBytes - s.swap.freeBytes;
        $('swapVal').textContent = `${fmtShort(swapUsed)} / ${fmtShort(s.swap.totalBytes)}`;
        setBar('swapBar', (swapUsed / s.swap.totalBytes) * 100);
        $('swapBtn').hidden = true;
      } else {
        $('swapVal').innerHTML = '<span class="warn">none</span>';
        $('swapBtn').hidden = false;
      }
      const notices = [];
      if (!s.swap?.totalBytes && s.memory.totalBytes < 2 * 1024 ** 3) {
        notices.push(['warn', 'alert', 'No swap and less than 2 GB RAM: if memory fills up, Linux kills your apps. Click "Create 2 GB swap".']);
      }
      if (s.rebootRequired) notices.push(['warn', 'rotate', 'Updates were installed that need a reboot to take effect.']);
      if (s.updates?.total) {
        notices.push([s.updates.security ? 'warn' : 'info', 'download',
          `${s.updates.total} package update(s) available${s.updates.security ? `, ${s.updates.security} of them security fixes` : ''}.`]);
      }
      $('serverNotices').innerHTML = notices.map(([cls, icon, text]) => `<div class="notice ${cls}">${ic(icon)}<span>${esc(text)}</span></div>`).join('');

      $('procTable').innerHTML = s.processes.map((p) => `<tr>
        <td>${p.pid}</td><td>${esc(p.user)}</td><td><b>${p.cpu}%</b></td><td>${p.mem}%</td><td class="muted">${esc(p.elapsed)}</td>
        <td class="cmd" title="${esc(p.command)}">${esc(p.command)}</td>
        <td><button type="button" class="b-ghost" onclick="killProc(${p.pid}, ${js(p.command)})" title="Kill process">${ic('x')}Kill</button></td></tr>`).join('');
      $('portTable').innerHTML = s.ports.map((p) => `<tr><td><b>${p.port}</b></td><td class="muted mono">${esc(p.address)}</td><td>${esc(p.process || '–')}${p.pid ? ` <span class="muted">(${p.pid})</span>` : ''}</td></tr>`).join('')
        || '<tr><td colspan="3" class="muted">–</td></tr>';
    } catch (err) {
      $('connDot').className = 'dot off';
      $('hostName').textContent = 'Disconnected';
      $('hostInfo').textContent = err.message;
    }
  }

  function killProc(pid, cmd) {
    if (!confirm(`Kill process ${pid} (${cmd})?`)) return;
    api('/system/kill', { method: 'POST', body: { pid } })
      .then((r) => { toast(r.message, 'ok'); setTimeout(loadSystem, 1000); })
      .catch((err) => toast(err.message, 'err'));
  }

  const serverAction = (action, text) => act('/server/' + action, null, text);

  // ── projects ────────────────────────────
  let projects = [];
  let serverUser = '';

  async function loadProjects() {
    try {
      projects = (await api('/projects')).projects;
    } catch (err) {
      $('projectList').innerHTML = `<p class="down">${esc(err.message)}</p>`;
      return;
    }
    const online = projects.filter((p) => p.online > 0).length;
    $('projVal').textContent = `${online} / ${projects.length}`;
    $('projSub').textContent = projects.filter((p) => !p.online).map((p) => p.name + ' is down').join(', ') || 'all running';

    $('projectList').innerHTML = projects.map((p) => {
      const total = p.instances.length;
      const startedAt = Math.min(...p.instances.filter((i) => i.status === 'online').map((i) => i.startedAt));
      const n = js(p.name);
      return `<div class="proj">
        <div class="head">
          ${avatar(p.name)}
          <div class="who"><div><b>${esc(p.name)}</b><span>${esc(p.cwd)}</span></div></div>
          <span class="spacer"></span>
          ${statusPill(p)}
        </div>
        <div class="row">
          <span class="pill p-grey">${p.mode}${p.mode === 'cluster' ? ' × ' + total : ''}</span>
          ${p.isAgent ? '<span class="pill p-grey">this panel</span>' : ''}
        </div>
        <div class="stats">
          <div>CPU<b>${p.cpu}%</b></div>
          <div>Memory<b>${fmtBytes(p.memory)}</b></div>
          <div>Restarts<b>${p.restarts}</b></div>
          <div>Uptime<b>${p.online ? fmtDur((Date.now() - startedAt) / 1000) : '–'}</b></div>
        </div>
        <div class="meta">
          <span>${ic('play')}${esc(p.script)}</span>
          ${p.git ? `<span>${ic('git')}${esc(p.git.branch)} · <b>${esc(p.git.commit)}</b> ${esc(p.git.message)} <i class="muted">(${esc(p.git.when)})</i></span>` : ''}
        </div>
        <div class="actions">
          ${p.online
            ? `<button type="button" class="b-primary" onclick="projAct(${n},'reload')">${ic('refresh')}Reload</button>
               <button type="button" class="b-orange" onclick="projAct(${n},'restart')">${ic('rotate')}Restart</button>
               ${p.isAgent ? '' : `<button type="button" class="b-red" onclick="projAct(${n},'stop')">${ic('stop')}Stop</button>`}`
            : `<button type="button" class="b-lime" onclick="projAct(${n},'start')">${ic('play')}Start</button>`}
          <button type="button" class="b-lime" onclick="projAct(${n},'deploy')">${ic('rocket')}Deploy</button>
          ${p.mode === 'cluster' ? `<button type="button" class="b-grey" onclick="scaleProj(${n}, ${total})">${ic('layers')}Scale</button>` : ''}
          <button type="button" class="b-grey" onclick="openInCode(${n})">${ic('code')}Code</button>
          <button type="button" class="b-grey" onclick="openLogs(${n})">${ic('logs')}Logs</button>
          <button type="button" class="b-grey" onclick="openGit(${n})">${ic('git')}Git</button>
          <button type="button" class="b-grey" onclick="openEnv(${n})">${ic('key')}.env</button>
          <button type="button" class="b-grey" onclick="openBackups(${n})">${ic('save')}Backups</button>
          <button type="button" class="b-grey" onclick="browse(${js(p.cwd)}); showTab('files')">${ic('folder')}Files</button>
          <button type="button" class="b-ghost" onclick="projAct(${n},'flush')">${ic('broom')}Clear logs</button>
          ${p.isAgent ? '' : `<button type="button" class="b-ghost" onclick="projAct(${n},'delete')" title="Stop it and remove it from PM2, keep the files">${ic('x')}Remove from PM2</button>
          <button type="button" class="b-red" onclick="destroyProject(${n})" title="Stop it, remove it from PM2 and delete its folder">${ic('trash')}Delete completely</button>`}
        </div>
      </div>`;
    }).join('') || '<p class="muted">No PM2 projects yet. Click "Add project".</p>';

    renderHealth();
  }

  // Avatar circle with initials and a stable colour per name (the people avatars of the design).
  const AVATAR_COLORS = ['#b5f23d', '#5cd3ff', '#a78bfa', '#fbbf24', '#ff8fab', '#5eead4'];
  function avatar(name) {
    const initials = name.split(/[^a-zA-Z0-9]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
    const color = AVATAR_COLORS[[...name].reduce((h, c) => h + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
    return `<span class="avatar" style="background:${color}">${esc(initials)}</span>`;
  }

  function statusPill(p) {
    const total = p.instances.length;
    if (p.online === total) return '<span class="pill p-green">online</span>';
    if (p.online) return `<span class="pill p-orange">${p.online}/${total} online</span>`;
    return `<span class="pill p-red">${esc(p.instances[0]?.status || 'down')}</span>`;
  }

  // Progress bar with a % bubble above its end (the "Progress" column of the design).
  function meter(pct, label, warn = true) {
    const v = Math.max(0, Math.min(100, pct));
    const cls = !warn ? '' : v > 85 ? 'hot' : v > 65 ? 'mid' : '';
    return `<div class="meter"><span class="bubble" style="left:${Math.min(94, Math.max(6, v))}%">${esc(label ?? Math.round(v) + '%')}</span>
      <div class="track"><div class="fill ${cls}" style="width:${v}%"></div></div></div>`;
  }

  // Overview → Project Health table.
  function renderHealth() {
    const totalMem = projects.reduce((s, p) => s + p.memory, 0) || 1;
    $('healthTable').innerHTML = projects.map((p) => `<tr>
      <td><div class="who">${avatar(p.name)}<div><b>${esc(p.name)}</b><span>${p.instances.length} instance(s) · ${fmtBytes(p.memory)}</span></div></div></td>
      <td>${statusPill(p)}</td>
      <td><b>${p.restarts}</b> <span class="muted">restarts</span></td>
      <td style="min-width:170px">${meter(Math.min(100, p.cpu), p.cpu + '%')}</td>
      <td style="min-width:200px">${meter((p.memory / totalMem) * 100, null, false)}</td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">No PM2 projects yet.</td></tr>';
  }

  // Remove a project for good: PM2 entry + its folder. Needs the name typed back.
  async function destroyProject(name) {
    const proj = projects.find((p) => p.name === name);
    const typed = prompt(`DELETE "${name}" COMPLETELY?\n\n• stops the app and removes it from PM2\n• deletes the folder ${proj?.cwd}\n  (code, .env, uploads… everything in it)\n\nThis cannot be undone. Type the project name to confirm:`);
    if (typed === null) return;
    if (typed.trim() !== name) return toast('Name did not match, nothing was deleted', 'err');
    const r = await act(`/projects/${encodeURIComponent(name)}/destroy`, { confirm: name });
    if (r) setTimeout(loadProjects, 3000);
  }

  function projAct(name, action) {
    const texts = {
      stop: `STOP ${name}? It stays down until you press Start.`,
      restart: `Restart ${name}? (short downtime)`,
      reload: `Reload ${name}? (zero-downtime in cluster mode)`,
      deploy: `Deploy ${name}? Pulls the latest code from git, installs packages and reloads.\nAny changes made directly on the server in that folder will be lost.`,
      delete: `Remove ${name} from PM2? The app stops, but its files stay on disk.`,
      flush: `Clear the log files of ${name}?`,
    };
    act(`/projects/${encodeURIComponent(name)}/${action}`, null, texts[action] ?? `${action} ${name}?`)
      .then((r) => r && setTimeout(loadProjects, 2500));
  }

  function scaleProj(name, current) {
    const n = prompt(`How many instances for ${name}? (1–8, now ${current})`, current);
    if (!n) return;
    act(`/projects/${encodeURIComponent(name)}/scale`, { instances: +n }).then((r) => r && setTimeout(loadProjects, 3000));
  }

  function openAddProject() {
    openModal('Add project', `
      <div class="form">
        <label for="apName">Name</label><input id="apName" placeholder="my-api">
        <label for="apRepo">Git repo URL</label><input id="apRepo" placeholder="https://github.com/you/repo.git">
        <label for="apBranch">Branch</label><input id="apBranch" value="main">
        <label for="apScript">Start file</label><input id="apScript" value="app.js">
        <label for="apDir">Folder</label><input id="apDir" placeholder="(default: ~/name)">
        <label for="apCluster">Cluster mode</label><span><input type="checkbox" id="apCluster"> instances <input id="apInst" type="number" min="1" max="8" value="1" style="width:70px"></span>
      </div>
      <p class="muted">Private repos need a deploy key on this server (Settings → Deploy keys on GitHub).
      After it's added, create the project's .env with the ".env" button and press Restart.</p>`,
      '<button type="button" class="b-green" onclick="addProject()">Add &amp; start</button>');
  }

  async function addProject() {
    const r = await act('/projects', {
      name: $('apName').value.trim(), repo: $('apRepo').value.trim(), branch: $('apBranch').value.trim(),
      script: $('apScript').value.trim(), dir: $('apDir').value.trim() || undefined,
      cluster: $('apCluster').checked, instances: +$('apInst').value,
    });
    if (r) { closeModal(); showTab('activity'); }
  }

  async function openGit(name) {
    openModal(`Git: ${name}`, '<p class="muted">Checking GitHub…</p>');
    try {
      const g = await api(`/projects/${encodeURIComponent(name)}/git`);
      $('modalBody').innerHTML = `
        <p>Branch <b>${esc(g.branch)}</b> · ${esc(g.remote || 'no remote')}</p>
        <p>${g.behind ? `<span class="warn"><svg class="ic"><use href="#i-download"/></svg> ${g.behind} new commit(s) on GitHub, not deployed yet</span>` : '<span class="up"><svg class="ic"><use href="#i-check"/></svg> Up to date with GitHub</span>'}
           ${g.ahead ? `<br><span class="warn"><svg class="ic"><use href="#i-upload"/></svg> ${g.ahead} local commit(s) not on GitHub</span>` : ''}</p>
        ${g.changedFiles.length ? `<p class="warn">${g.changedFiles.length} file(s) edited directly on the server (a deploy will overwrite them):</p>
          <pre class="out" style="max-height:140px">${esc(g.changedFiles.join('\n'))}</pre>` : ''}
        <h3 style="margin-top:14px">Recent commits</h3>
        <p class="muted">"Deploy this" rolls the project back (or forward) to that exact version. The next normal deploy or git push brings it back to the latest.</p>
        <table><tbody>${g.commits.map((c, i) => `<tr><td><b>${esc(c.hash)}</b></td><td>${esc(c.message)}</td><td class="muted">${esc(c.author)}</td><td class="muted">${esc(c.when)}</td>
          <td>${i === 0 ? '<span class="muted">current</span>' : `<button type="button" class="b-ghost" onclick="rollback(${js(name)}, ${js(c.hash)}, ${js(c.message)})"><svg class="ic"><use href="#i-undo"/></svg>Deploy this</button>`}</td></tr>`).join('')}</tbody></table>`;
      $('modalFoot').innerHTML = `<button type="button" class="b-green" onclick="closeModal(); projAct(${js(name)},'deploy')"><svg class="ic"><use href="#i-rocket"/></svg>Deploy latest</button>` + $('modalFoot').innerHTML;
    } catch (err) { $('modalBody').innerHTML = `<p class="down">${esc(err.message)}</p>`; }
  }

  async function openEnv(name) {
    try {
      const e = await api(`/projects/${encodeURIComponent(name)}/env`);
      openModal(`.env: ${name}`, `
        <p class="muted">${esc(e.path)}${e.exists ? '' : ' (does not exist yet, saving creates it)'}</p>
        ${e.missing?.length ? `<div class="notice warn">${ic('alert')}<span>Missing compared to .env.example: <b>${e.missing.map(esc).join(', ')}</b></span></div>` : e.missing ? `<div class="notice info">${ic('check')}<span>All keys from .env.example are set.</span></div>` : ''}
        <textarea id="envText" rows="18" spellcheck="false">${esc(e.content)}</textarea>
        <p class="warn" style="font-size:12px">⚠ Contains secrets. The previous version is kept as .env.bak. Restart the project after saving.</p>`,
        `<button type="button" class="b-green" onclick="saveEnv(${js(name)}, false)">Save</button>
         <button type="button" class="b-orange" onclick="saveEnv(${js(name)}, true)">Save &amp; restart</button>`);
    } catch (err) { toast(err.message, 'err'); }
  }

  async function saveEnv(name, restart) {
    try {
      const r = await api(`/projects/${encodeURIComponent(name)}/env`, { method: 'PUT', body: { content: $('envText').value } });
      toast(r.message, 'ok');
      closeModal();
      if (restart) act(`/projects/${encodeURIComponent(name)}/restart`).then(() => setTimeout(loadProjects, 2500));
    } catch (err) { toast(err.message, 'err'); }
  }

  // ── logs ────────────────────────────────
  let logLines = [];
  let following = false;

  function fillLogProjects() {
    const sel = $('logProject'), cur = sel.value;
    sel.innerHTML = projects.map((p) => `<option>${esc(p.name)}</option>`).join('');
    if (cur) sel.value = cur;
    if (!projects.length) api('/projects').then((r) => { projects = r.projects; fillLogProjects(); }).catch(() => {});
  }

  function openLogs(name) {
    showTab('logs');
    $('logProject').value = name;
    loadLogs();
  }

  async function loadLogs() {
    stopFollow();
    try {
      const qs = new URLSearchParams({ type: $('logType').value, lines: $('logLines').value });
      const r = await api(`/projects/${encodeURIComponent($('logProject').value)}/logs?${qs}`);
      logLines = r.lines;
      renderLogs();
    } catch (err) { $('logOut').textContent = 'Error: ' + err.message; }
  }

  function renderLogs() {
    const f = $('logFilter').value.toLowerCase();
    const shown = f ? logLines.filter((l) => l.toLowerCase().includes(f)) : logLines;
    const out = $('logOut');
    const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 30;
    out.textContent = shown.join('\n') || '(empty)';
    if (atBottom || !following) out.scrollTop = out.scrollHeight;
  }

  function toggleFollow() {
    if (following) return stopFollow();
    following = true;
    logLines = [];
    $('followBtn').innerHTML = ic('pause') + 'Stop live';
    $('followBtn').className = 'b-orange';
    opsSocket.emit('logs:follow', { name: $('logProject').value, type: $('logType').value });
  }

  function stopFollow() {
    if (!following) return;
    following = false;
    opsSocket?.emit('logs:stop');
    $('followBtn').innerHTML = ic('play') + 'Live';
    $('followBtn').className = 'b-green';
  }

  // ── services ────────────────────────────
  async function loadServices() {
    try {
      const { services } = await api('/services');
      $('serviceTable').innerHTML = services.map((s) => {
        const pill = s.active === 'active' ? 'p-green' : s.active === 'failed' ? 'p-red' : 'p-grey';
        const n = js(s.name);
        return `<tr><td><b>${esc(s.name)}</b></td><td class="muted">${esc(s.description)}</td>
          <td><span class="pill ${pill}">${esc(s.active)} (${esc(s.sub)})</span></td>
          <td>${s.active === 'active'
              ? `<button type="button" class="b-orange" onclick="svc(${n},'restart')">Restart</button>
                 ${s.protected ? '' : `<button type="button" class="b-red" onclick="svc(${n},'stop')">Stop</button>`}`
              : `<button type="button" class="b-green" onclick="svc(${n},'start')">Start</button>`}</td></tr>`;
      }).join('');
    } catch (err) { toast(err.message, 'err'); }
  }

  const svc = (name, action) => act(`/services/${name}/${action}`, null, `${action} ${name}?`).then((r) => r && setTimeout(loadServices, 2500));

  // ── files ───────────────────────────────
  let currentDir = '';
  let homeDir = '';
  let dirEntries = [];
  const dirHistory = []; // folders visited before the current one, for ⬅ Back
  const joinPath = (dir, name) => dir.replace(/\/$/, '') + '/' + name;
  const parentOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';

  // Opens a folder (or a file, which opens the editor). remember=false skips history (refresh / back).
  async function browse(target, remember = true) {
    try {
      const r = await api('/files?path=' + encodeURIComponent(target));
      if (r.type === 'file') return editFile(r);
      if (remember && currentDir && currentDir !== r.path) dirHistory.push(currentDir);
      currentDir = r.path;
      homeDir = r.home;
      dirEntries = r.entries;
      $('pathInput').value = currentDir;
      $('backBtn').disabled = !dirHistory.length;
      const rel = currentDir.slice(homeDir.length).split('/').filter(Boolean);
      let acc = homeDir;
      $('crumbs').innerHTML = `<a onclick="browse(${js(homeDir)})"><svg class="ic"><use href="#i-home"/></svg></a>` + rel.map((part) => {
        acc += '/' + part;
        return ` / <a onclick="browse(${js(acc)})">${esc(part)}</a>`;
      }).join('');
      renderFiles();
    } catch (err) {
      toast(err.message, 'err');
      $('pathInput').value = currentDir;
    }
  }

  function goBack() {
    if (dirHistory.length) browse(dirHistory.pop(), false);
  }

  function goUp() {
    if (currentDir !== homeDir) browse(parentOf(currentDir));
  }

  function renderFiles() {
    const f = $('fileFilter').value.toLowerCase();
    const hidden = $('showHidden').checked;
    const shown = dirEntries.filter((e) => (hidden || !e.name.startsWith('.')) && (!f || e.name.toLowerCase().includes(f)));
    const up = currentDir !== homeDir
      ? `<tr class="file-row" onclick="goUp()"><td colspan="4"><span class="fi dir"><svg class="ic"><use href="#i-arrow-up"/></svg></span> .. <span class="muted">parent folder</span></td></tr>` : '';
    $('fileTable').innerHTML = up + shown.map((e) => {
      const p = js(joinPath(currentDir, e.name));
      return `<tr class="file-row">
        <td onclick="browse(${p})">${fileIcon(e.name, e.type)} ${esc(e.name)}</td>
        <td class="muted" onclick="browse(${p})">${e.type === 'dir' ? '' : fmtBytes(e.size)}</td>
        <td class="muted" onclick="browse(${p})">${e.mtime ? new Date(e.mtime).toLocaleString() : ''}</td>
        <td>
          ${e.type === 'file'
            ? `<button type="button" class="b-ghost" onclick="downloadFile(${p})" title="Download">${ic('download')}</button>`
            : `<button type="button" class="b-ghost" onclick="downloadFolder(${p})" title="Download folder (.tar.gz)">${ic('download')}</button>`}
          <button type="button" class="b-ghost" onclick="renameItem(${p})" title="Rename"><svg class="ic"><use href="#i-edit"/></svg></button>
          <button type="button" class="b-ghost" onclick="copyItem(${p})" title="Copy, then Paste into another folder">${ic('copy')}</button>
          <button type="button" class="b-ghost" onclick="copyPath(${p})" title="Copy path">${ic('map')}</button>
          <button type="button" class="b-ghost" onclick="deleteItem(${p}, ${e.type === 'dir'})" title="Delete"><svg class="ic"><use href="#i-trash"/></svg></button>
        </td></tr>`;
    }).join('') || (up ? '' : '<tr><td colspan="4" class="muted">Empty folder</td></tr>');
    if (!shown.length && up) $('fileTable').innerHTML += '<tr><td colspan="4" class="muted">Empty folder</td></tr>';
  }

  // ── editor ──
  let editorOriginal = '';

  function editFile(f) {
    editorOriginal = f.content;
    openModal(f.path.replace(f.home, '~'), `
      <textarea id="fileText" rows="24" spellcheck="false">${esc(f.content)}</textarea>
      <div class="muted" id="editorInfo" style="margin-top:6px"></div>`,
      `<button type="button" class="b-grey" onclick="closeEditor()"><svg class="ic"><use href="#i-arrow-left"/></svg>Back to folder</button>
       <button type="button" class="b-green" onclick="saveFile(${js(f.path)})"><svg class="ic"><use href="#i-save"/></svg>Save (Ctrl+S)</button>`);
    const ta = $('fileText');
    const info = () => {
      const changed = ta.value !== editorOriginal;
      $('editorInfo').innerHTML = `${ta.value.split('\n').length} lines · ${fmtBytes(new Blob([ta.value]).size)}`
        + (changed ? ' · <span class="warn">● unsaved changes</span>' : '');
    };
    ta.addEventListener('input', info);
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveFile(f.path, true); }
      if (e.key === 'Tab') { // insert two spaces instead of leaving the textarea
        e.preventDefault();
        const s = ta.selectionStart;
        ta.setRangeText('  ', s, ta.selectionEnd, 'end');
        info();
      }
    });
    info();
    ta.focus();
  }

  function closeEditor() {
    const ta = $('fileText');
    if (ta && ta.value !== editorOriginal && !confirm('You have unsaved changes. Close without saving?')) return;
    closeModal();
  }

  async function saveFile(filePath, stayOpen = false) {
    try {
      const content = $('fileText').value;
      const r = await api('/files', { method: 'PUT', body: { path: filePath, content } });
      toast(r.message, 'ok');
      editorOriginal = content;
      $('fileText').dispatchEvent(new Event('input'));
      if (!stayOpen) closeModal();
      browse(currentDir, false);
    } catch (err) { toast(err.message, 'err'); }
  }

  // ── file actions ──
  function newFile() {
    const name = prompt('New file name (in this folder):');
    if (name) editFile({ path: joinPath(currentDir, name), home: homeDir, content: '' });
  }

  async function newFolder() {
    const name = prompt('New folder name:');
    if (!name) return;
    try {
      const r = await api('/files/mkdir', { method: 'POST', body: { path: joinPath(currentDir, name) } });
      toast(r.message, 'ok');
      browse(currentDir, false);
    } catch (err) { toast(err.message, 'err'); }
  }

  async function renameItem(p) {
    const oldName = p.slice(p.lastIndexOf('/') + 1);
    const name = prompt('New name:', oldName);
    if (!name || name === oldName) return;
    try {
      const r = await api('/files/rename', { method: 'POST', body: { from: p, to: joinPath(parentOf(p), name) } });
      toast(r.message, 'ok');
      browse(currentDir, false);
    } catch (err) { toast(err.message, 'err'); }
  }

  async function deleteItem(p, isDir) {
    const msg = isDir ? `Delete the folder ${p} and EVERYTHING inside it?` : `Delete ${p}?`;
    if (!confirm(msg + '\nThis cannot be undone.')) return;
    try {
      const r = await api('/files?path=' + encodeURIComponent(p), { method: 'DELETE' });
      toast(r.message, 'ok');
      browse(currentDir, false);
    } catch (err) { toast(err.message, 'err'); }
  }

  async function downloadFile(p) {
    try {
      const res = await fetch('/api/files/download?path=' + encodeURIComponent(p), { headers: { 'x-ops-token': token() } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: p.slice(p.lastIndexOf('/') + 1) });
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) { toast(err.message, 'err'); }
  }

  function copyPath(p) {
    navigator.clipboard?.writeText(p).then(() => toast('Copied: ' + p, 'ok'), () => prompt('Copy this path:', p));
  }

  async function uploadFiles(fileList) {
    for (const file of fileList) {
      const send = (overwrite) => fetch(`/api/files/upload?${new URLSearchParams({ dir: currentDir, name: file.name, overwrite: overwrite ? '1' : '0' })}`, {
        method: 'POST',
        headers: { 'x-ops-token': token(), 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      try {
        let res = await send(false);
        if (res.status === 409 && confirm(`${file.name} already exists here. Replace it?`)) res = await send(true);
        const data = await res.json().catch(() => ({}));
        toast(data.message || `HTTP ${res.status}`, res.ok ? 'ok' : 'err');
      } catch (err) { toast(err.message, 'err'); }
    }
    browse(currentDir, false);
  }

  // ── bulk upload: whole folders (drag & drop or folder picker) ──
  const SKIP_UPLOAD = new Set(['node_modules', '.git']);

  // Reads a drop (files and folders, recursively) into [{ file, path }].
  async function collectDropped(dataTransfer) {
    const out = [];
    const readAll = (reader) => new Promise((resolve) => {
      const all = [];
      const next = () => reader.readEntries((batch) => (batch.length ? (all.push(...batch), next()) : resolve(all)), () => resolve(all));
      next();
    });
    const walk = async (entry, prefix) => {
      if (SKIP_UPLOAD.has(entry.name)) return;
      if (entry.isFile) {
        const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
        if (file) out.push({ file, path: prefix + entry.name });
      } else if (entry.isDirectory) {
        for (const child of await readAll(entry.createReader())) await walk(child, `${prefix}${entry.name}/`);
      }
    };
    const entries = [...dataTransfer.items].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
    if (!entries.length) return [...dataTransfer.files].map((file) => ({ file, path: file.name }));
    for (const e of entries) await walk(e, '');
    return out;
  }

  // From <input webkitdirectory>: keep the folder structure, skip node_modules/.git.
  function uploadPicked(fileList, dir) {
    const items = [...fileList]
      .map((file) => ({ file, path: file.webkitRelativePath || file.name }))
      .filter((it) => !it.path.split('/').some((p) => SKIP_UPLOAD.has(p)));
    return uploadMany(items, dir);
  }

  // Uploads many files with a progress panel. Asks once about overwriting.
  async function uploadMany(items, dir, after) {
    if (!items.length) return toast('Nothing to upload (node_modules and .git are skipped)', 'err');
    const total = items.reduce((s, it) => s + it.file.size, 0);
    if (!confirm(`Upload ${items.length} file(s) (${fmtBytes(total)}) into\n${dir}?\n\nFiles with the same name are replaced.`)) return;
    $('uploadPanel').hidden = false;
    $('uploadTitle').textContent = `Uploading ${items.length} file(s)…`;
    let done = 0, failed = 0, sent = 0;
    const queue = [...items];
    const worker = async () => {
      while (queue.length) {
        const it = queue.shift();
        $('uploadFile').textContent = it.path;
        try {
          const res = await fetch(`/api/files/upload?${new URLSearchParams({ dir, name: it.path, overwrite: '1' })}`, {
            method: 'POST', headers: { 'x-ops-token': token(), 'Content-Type': 'application/octet-stream' }, body: it.file,
          });
          if (!res.ok) failed++;
        } catch { failed++; }
        done++;
        sent += it.file.size;
        $('uploadCount').textContent = `${done} / ${items.length}`;
        $('uploadBar').style.width = (total ? (sent / total) * 100 : (done / items.length) * 100) + '%';
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    $('uploadPanel').hidden = true;
    $('uploadBar').style.width = '0';
    toast(failed ? `Uploaded ${done - failed} file(s), ${failed} failed` : `Uploaded ${done} file(s)`, failed ? 'err' : 'ok');
    if (after) after();
    else if (activeTab === 'files') browse(currentDir, false);
  }

  // Download a folder (or a whole project) as .tar.gz, without node_modules/.git.
  async function downloadFolder(dir) {
    toast('Preparing download…');
    try {
      const res = await fetch('/api/files/archive?path=' + encodeURIComponent(dir), { headers: { 'x-ops-token': token() } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: (dir.split('/').pop() || 'home') + '.tar.gz' });
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) { toast(err.message, 'err'); }
  }

  // ── copy / paste (Files tab and code explorer) ──
  let clipboardPath = null;
  function copyItem(p) {
    clipboardPath = p;
    if ($('pasteBtn')) $('pasteBtn').hidden = false;
    toast(`Copied ${p.split('/').pop()}. Paste it into any folder`, 'ok');
  }
  async function pasteInto(dir, after) {
    if (!clipboardPath) return;
    try {
      const r = await api('/files/copy', { method: 'POST', body: { from: clipboardPath, to: joinPath(dir, clipboardPath.split('/').pop()) } });
      toast(r.message, 'ok');
      if (after) after(); else browse(currentDir, false);
    } catch (err) { toast(err.message, 'err'); }
  }

  // drag & drop upload onto the files card (files and whole folders)
  $('filesCard').addEventListener('dragover', (e) => { e.preventDefault(); $('filesCard').classList.add('drop'); });
  $('filesCard').addEventListener('dragleave', (e) => { if (!$('filesCard').contains(e.relatedTarget)) $('filesCard').classList.remove('drop'); });
  $('filesCard').addEventListener('drop', async (e) => {
    e.preventDefault();
    $('filesCard').classList.remove('drop');
    uploadMany(await collectDropped(e.dataTransfer), currentDir);
  });

  function terminalHere() {
    const dir = currentDir;
    showTab('terminal');
    const send = () => termSocket.emit('input', `cd ${"'" + dir.replace(/'/g, `'\\''`) + "'"}\r`);
    if (termSocket?.connected) send();
    else termSocket?.once('connect', () => setTimeout(send, 300));
  }

  // ── activity / jobs ─────────────────────
  const jobs = new Map();
  const openJobs = new Set();

  function renderJobs() {
    const list = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
    const running = list.filter((j) => j.status === 'running').length;
    if ($('runningBadge')) {
      $('runningBadge').hidden = !running;
      $('runningBadge').textContent = running;
    }
    $('jobList').innerHTML = list.map((j) => {
      const pill = { running: 'p-orange', success: 'p-green', failed: 'p-red', sent: 'p-grey' }[j.status];
      const took = j.endedAt ? ` · ${fmtDur((j.endedAt - j.startedAt) / 1000)}` : '';
      return `<div class="job ${openJobs.has(j.id) ? 'open' : ''}" id="job-${j.id}">
        <div class="jh" onclick="toggleJob('${j.id}')">
          <span class="pill ${pill}">${j.status}</span><span class="t">${esc(j.title)}</span>
          <span class="muted">${new Date(j.startedAt).toLocaleTimeString()}${took}</span></div>
        <pre class="out">${esc(j.output || '')}</pre></div>`;
    }).join('') || '<p class="muted">Nothing yet.</p>';
    openJobs.forEach((id) => { const pre = document.querySelector(`#job-${id} pre`); if (pre) pre.scrollTop = pre.scrollHeight; });
  }

  async function toggleJob(id) {
    if (openJobs.has(id)) openJobs.delete(id);
    else {
      openJobs.add(id);
      try { const { job } = await api('/jobs/' + id); jobs.set(id, job); } catch {}
    }
    renderJobs();
  }

  // ── sockets ─────────────────────────────
  let opsSocket = null;

  function connectOps() {
    opsSocket = io('/ops', { auth: { token: token() } });
    opsSocket.on('connect', () => { $('connDot').className = 'dot on'; });
    opsSocket.on('disconnect', () => { $('connDot').className = 'dot off'; });
    opsSocket.on('job', (j) => {
      const prev = jobs.get(j.id);
      jobs.set(j.id, { ...prev, ...j, output: j.output ?? prev?.output ?? '' });
      if (!prev) openJobs.add(j.id);
      if (prev && prev.status === 'running' && j.status !== 'running') {
        toast(`${j.title}: ${j.status}`, j.status === 'failed' ? 'err' : 'ok');
        loadProjects();
      }
      renderJobs();
    });
    opsSocket.on('job:output', ({ id, text }) => {
      const j = jobs.get(id);
      if (!j) return;
      j.output = (j.output || '') + text;
      const pre = document.querySelector(`#job-${id} pre`);
      if (pre) { pre.textContent = j.output; pre.scrollTop = pre.scrollHeight; }
    });
    opsSocket.on('metrics', (s) => {
      samples.push(s);
      if (samples.length > 720) samples.shift();
      if (activeTab === 'overview') drawCharts();
    });
    opsSocket.on('alerts', renderAlerts);
    opsSocket.on('monitor', () => { if (activeTab === 'monitors') loadMonitors(); });
    opsSocket.on('logs:data', (text) => {
      if (!following) return;
      logLines.push(...text.split('\n').filter(Boolean));
      if (logLines.length > 5000) logLines = logLines.slice(-5000);
      renderLogs();
    });
  }

  // ── terminal ────────────────────────────
  let term = null, fit = null, termSocket = null;

  function fitTerm() {
    if (!term || activeTab !== 'terminal') return;
    fit.fit();
    termSocket?.emit('resize', { cols: term.cols, rows: term.rows });
  }

  function newTerminal() {
    termSocket?.disconnect();
    if (!term) {
      term = new Terminal({
        cursorBlink: true, fontSize: 13, lineHeight: 1.25, fontFamily: '"JetBrains Mono", Consolas, monospace',
        theme: { background: '#050607', foreground: '#d7dbe0', cursor: '#b5f23d', selectionBackground: 'rgba(181,242,61,.3)',
          green: '#b5f23d', brightGreen: '#c9f76a', blue: '#5cd3ff', brightBlue: '#8be0ff', magenta: '#a78bfa', yellow: '#fbbf24', red: '#ff5f5f' },
      });
      fit = new FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open($('terminal'));
      term.onData((d) => termSocket?.emit('input', d));
      window.addEventListener('resize', fitTerm);
    }
    term.reset();
    fit.fit();
    termSocket = io('/terminal', { auth: { token: token() }, query: { cols: term.cols, rows: term.rows }, reconnection: false });
    termSocket.on('connect', () => { $('termStatus').innerHTML = '<span class="up">● Connected</span>'; term.focus(); });
    termSocket.on('output', (d) => term.write(d));
    termSocket.on('exit', () => term.write('\r\n\x1b[33m[session ended, click "New session"]\x1b[0m\r\n'));
    termSocket.on('disconnect', () => { $('termStatus').innerHTML = '<span class="down">● Disconnected</span>'; });
    termSocket.on('connect_error', (err) => { $('termStatus').innerHTML = `<span class="down">${esc(err.message)}</span>`; });
  }

  // ── usage cards (Memory / Disk with block meters) ──
  const BLOCKS = 8;
  function usageCard(key, used, total, pct) {
    const big = total >= 1024 ** 3;
    const unit = big ? 'GB' : 'MB';
    const div = big ? 1024 ** 3 : 1024 ** 2;
    $(key + 'Val').textContent = big ? (used / div).toFixed(1) : Math.round(used / div);
    $(key + 'Total').textContent = `/ ${big ? (total / div).toFixed(1) : Math.round(total / div)} ${unit}`;
    $(key + 'Badge').textContent = `${Math.round(pct)}% Used`;
    const filled = Math.round((pct / 100) * BLOCKS);
    $(key + 'Blocks').innerHTML = Array.from({ length: BLOCKS }, (_, i) =>
      `<i class="${i >= filled ? 'empty' : pct > 85 && i >= BLOCKS - 2 ? 'hot' : ''}"></i>`).join('');
  }

  // Dark promo card: the single most useful next step for this server.
  function renderPromo(s, memPct) {
    let title = 'Your Server Is Running Smoothly', text = 'All projects online and resources look healthy.';
    let btn = ['Deploy latest', 'rocket', openQuickDeploy];
    const down = projects.filter((p) => !p.online);
    if (down.length) {
      title = `${down.length} Project${down.length > 1 ? 's' : ''} Down`;
      text = `${down.map((p) => p.name).join(', ')} is not running.`;
      btn = ['Open projects', 'box', () => showTab('projects')];
    } else if (!s.swap?.totalBytes && s.memory.totalBytes < 2 * 1024 ** 3) {
      title = 'Take Your Server to the Next Level';
      text = `Only ${fmtShort(s.memory.totalBytes)} RAM and no swap: add 2 GB swap so apps don't crash.`;
      btn = ['Create swap', 'swap', () => serverAction('swap', 'Create a 2 GB swap file?')];
    } else if (s.updates?.security) {
      title = 'Security Updates Waiting';
      text = `${s.updates.security} security update(s) are ready to install.`;
      btn = ['Update now', 'download', () => serverAction('update', 'Install all Ubuntu package updates?')];
    } else if (memPct > 85) {
      title = 'Memory Is Almost Full';
      text = 'Restart heavy apps or scale down to free memory.';
      btn = ['See processes', 'cpu', () => document.getElementById('procTable').scrollIntoView({ behavior: 'smooth' })];
    }
    $('promoTitle').textContent = title;
    $('promoText').textContent = text;
    $('promoBtn').innerHTML = `<span>${esc(btn[0])}</span>${ic('play-o')}`;
    $('promoBtn').onclick = btn[2];
  }

  // ── "Recommended for you" tiles with pager dots ──
  const RECO_PAGES = [
    [['Terminal', 'terminal', 'c-pink', 'Shell on the server', () => showTab('terminal')],
     ['Code editor', 'code', 'c-blue', 'Edit & push', () => showTab('code')],
     ['Logs', 'logs', 'c-lav', 'Live output', () => showTab('logs')],
     ['Files', 'folder', 'c-sand', 'Upload & download', () => showTab('files')]],
    [['Monitors', 'pulse', 'c-mint', 'Uptime & auto-heal', () => showTab('monitors')],
     ['Redis', 'database', 'c-blue', 'Cache browser', () => showTab('redis')],
     ['Cron jobs', 'timer', 'c-yellow', 'Scheduled tasks', () => showTab('cron')],
     ['Security', 'shield', 'c-pink', 'Audit & logins', () => showTab('security')]],
    [['Add project', 'plus', 'c-lav', 'Clone & start', () => openAddProject()],
     ['Deploy', 'rocket', 'c-mint', 'Pull latest code', () => openQuickDeploy()],
     ['Clean logs', 'broom', 'c-sand', 'Free disk space', () => serverAction('clean-logs', 'Clear all PM2 logs?')],
     ['Alerts', 'bell', 'c-yellow', 'What needs attention', () => openAlerts()]],
  ];
  let recoPage = 0;
  function renderReco() {
    $('recoDots').innerHTML = RECO_PAGES.map((_, i) => `<button type="button" class="${i === recoPage ? 'active' : ''}" onclick="recoPage=${i}; renderReco()" aria-label="Page ${i + 1}"></button>`).join('');
    $('recoGrid').innerHTML = RECO_PAGES[recoPage].map(([label, icon, color, sub], i) =>
      `<button type="button" class="reco-tile" onclick="RECO_PAGES[${recoPage}][${i}][4]()">
        <span class="circle-ic ${color}">${ic(icon)}</span><span>${esc(label)}</span><small>${esc(sub)}</small></button>`).join('');
  }

  // ── statistics chart: stacked bars with hatched headroom ──
  let samples = [];
  let chartMetric = 'load';
  let chartHover = null; // index of the hovered bar
  const BARS = 10;

  const METRICS = {
    load: { parts: [['cpu', 'CPU', '--cpu'], ['mem', 'Memory', '--mem']], fmt: (v) => Math.round(v) + '%', max: () => 100 },
    net: { parts: [['rx', 'In', '--net-in'], ['tx', 'Out', '--net-out']], fmt: (v) => fmtBytes(v) + '/s', max: (vals) => Math.max(1024, ...vals) * 1.15 },
  };

  $('chartTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-metric]');
    if (!b) return;
    chartMetric = b.dataset.metric;
    document.querySelectorAll('#chartTabs button').forEach((x) => x.classList.toggle('active', x === b));
    drawCharts();
  });

  const chartCanvas = $('mainChart');
  let barRects = [];
  chartCanvas.addEventListener('mousemove', (e) => {
    const r = chartCanvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const hit = barRects.findIndex((b) => x >= b.x - 6 && x <= b.x + b.w + 6);
    if (hit !== chartHover) { chartHover = hit < 0 ? null : hit; drawCharts(); }
  });
  chartCanvas.addEventListener('mouseleave', () => { chartHover = null; drawCharts(); });

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const color = (c) => (c.startsWith('--') ? cssVar(c) : c);

  function roundRect(c, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    c.beginPath();
    c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }

  // Average the samples into BARS buckets.
  function buckets() {
    const data = samples.slice(-Number($('chartRange').value));
    if (!data.length) return [];
    const size = Math.max(1, Math.ceil(data.length / BARS));
    const out = [];
    for (let i = 0; i < data.length; i += size) {
      const chunk = data.slice(i, i + size);
      const avg = (k) => chunk.reduce((s, x) => s + x[k], 0) / chunk.length;
      out.push({ t: chunk[chunk.length - 1].t, cpu: avg('cpu'), mem: avg('mem'), rx: avg('rx'), tx: avg('tx') });
    }
    return out.slice(-BARS);
  }

  let hatch = null;
  function hatchPattern(c) {
    const p = document.createElement('canvas');
    p.width = p.height = 14;
    const pc = p.getContext('2d');
    pc.fillStyle = cssVar('--surface');
    pc.fillRect(0, 0, 14, 14);
    pc.strokeStyle = cssVar('--hatch');
    pc.lineWidth = 5;
    pc.beginPath(); pc.moveTo(-2, 16); pc.lineTo(16, -2); pc.moveTo(-9, 9); pc.lineTo(9, -9); pc.moveTo(5, 23); pc.lineTo(23, 5); pc.stroke();
    return c.createPattern(p, 'repeat');
  }

  function pillLabel(c, text, cx, cy) {
    c.font = '500 14px Outfit, Segoe UI, sans-serif';
    const w = c.measureText(text).width + 22, h = 30;
    roundRect(c, cx - w / 2, cy - h / 2, w, h, 12);
    c.fillStyle = '#17181b';
    c.fill();
    c.fillStyle = '#fff';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, cx, cy + 1);
  }

  function drawCharts() {
    if (activeTab !== 'overview') return;
    const m = METRICS[chartMetric];
    const data = buckets();
    const canvas = chartCanvas;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W) return;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const c = canvas.getContext('2d');
    c.scale(dpr, dpr);
    c.clearRect(0, 0, W, H);
    hatch = hatchPattern(c);

    const L = 44, R = W - 4, T = 10, B = H - 34;
    const muted = cssVar('--muted');
    c.font = '13px Outfit, Segoe UI, sans-serif';
    c.fillStyle = muted;
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    for (let i = 1; i <= 10; i++) c.fillText((i / 10).toFixed(1), 0, B - (i / 10) * (B - T));

    if (!data.length) {
      c.textAlign = 'center';
      c.fillText('Collecting data… the first bars appear within a minute', (L + R) / 2, (T + B) / 2);
      $('chartLegend').innerHTML = '';
      barRects = [];
      return;
    }

    const values = data.flatMap((d) => m.parts.map(([k]) => d[k]));
    const top = m.max(values);
    const slot = (R - L) / BARS;
    const bw = Math.min(96, slot * 0.72);
    const gap = 6;
    const half = (B - T) / 2; // each metric owns half of the column, like the reference chart
    barRects = [];

    data.forEach((d, i) => {
      const x = L + slot * (i + (BARS - data.length)) + (slot - bw) / 2;
      const h1 = Math.max(10, (Math.min(d[m.parts[0][0]], top) / top) * (half - gap));
      const h2 = Math.max(10, (Math.min(d[m.parts[1][0]], top) / top) * (half - gap));
      const y1 = B - h1;
      const y2 = y1 - gap - h2;
      const r = Math.min(22, bw / 3);
      const dim = chartHover != null && chartHover !== i ? 0.55 : 1;

      roundRect(c, x, T, bw, Math.max(0, y2 - gap - T), r); // headroom
      c.fillStyle = hatch;
      c.fill();
      c.globalAlpha = dim;
      roundRect(c, x, y2, bw, h2, r);
      c.fillStyle = color(m.parts[1][2]);
      c.fill();
      roundRect(c, x, y1, bw, h1, r);
      c.fillStyle = color(m.parts[0][2]);
      c.fill();
      c.globalAlpha = 1;
      barRects.push({ x, w: bw, y1, y2, h1, h2 });

      c.fillStyle = muted;
      c.font = '13px Outfit, Segoe UI, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'top';
      c.fillText(new Date(d.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), x + bw / 2, B + 12);
    });

    // black % pills on the hovered bar (or the latest one), like the reference
    const at = chartHover ?? barRects.length - 1;
    const b = barRects[at], d = data[at];
    if (b && d) {
      pillLabel(c, m.fmt(d[m.parts[1][0]]), b.x + b.w / 2, b.y2 + Math.min(32, b.h2 / 2));
      pillLabel(c, m.fmt(d[m.parts[0][0]]), b.x + b.w / 2, b.y1 + Math.min(32, b.h1 / 2));
    }

    const last = data[data.length - 1];
    $('chartLegend').innerHTML = m.parts.map(([k, label, col]) =>
      `<span><i style="background:${color(col)}"></i>${label}<b>${m.fmt(last[k])}</b></span>`).join('')
      + `<span>each bar ≈ ${Math.round((Number($('chartRange').value) * 10) / BARS / 60)} min</span>`;
  }

  // ── alerts ──────────────────────────────
  let activeAlerts = [];

  function renderAlerts(list) {
    activeAlerts = list;
    $('alertCount').textContent = list.length;
    $('alertBell').classList.toggle('has', list.length > 0);
    $('alertBanner').innerHTML = list.map((a) =>
      `<div class="notice ${a.level === 'critical' ? 'crit' : 'warn'}">${ic(a.level === 'critical' ? 'alert' : 'info')}<span>${esc(a.message)}</span>
        <span class="muted">since ${new Date(a.since).toLocaleTimeString()}</span></div>`).join('');
  }

  async function openAlerts() {
    openModal('Alerts', '<p class="muted">Loading…</p>');
    try {
      const r = await api('/alerts');
      $('modalBody').innerHTML = `
        <h3>Active now</h3>
        ${r.active.length ? r.active.map((a) => `<div class="notice ${a.level === 'critical' ? 'crit' : 'warn'}">${esc(a.message)}
          <span class="muted">since ${new Date(a.since).toLocaleString()}</span></div>`).join('') : '<p class="up"><svg class="ic"><use href="#i-check"/></svg> Everything is fine.</p>'}
        <h3 style="margin-top:14px">History</h3>
        <table><tbody>${r.history.map((h) => `<tr><td class="muted">${new Date(h.at).toLocaleString()}</td>
          <td>${h.event === 'raised' ? '<span class="pill p-red">raised</span>' : '<span class="pill p-green">resolved</span>'}</td>
          <td>${esc(h.message)}</td></tr>`).join('') || '<tr><td class="muted">No alerts yet.</td></tr>'}</tbody></table>
        <p class="muted">Set a Discord/Slack webhook and thresholds in Settings.</p>`;
    } catch (err) { $('modalBody').innerHTML = `<p class="down">${esc(err.message)}</p>`; }
  }

  // ── rollback ────────────────────────────
  function rollback(name, hash, message) {
    closeModal();
    act(`/projects/${encodeURIComponent(name)}/deploy`, { commit: hash },
      `Roll ${name} back to ${hash} ("${message}")?\nThe code on the server is replaced with that version, packages reinstalled and the app reloaded.`)
      .then((r) => r && setTimeout(loadProjects, 3000));
  }

  // ── monitors ────────────────────────────
  let monitorsData = [];

  async function loadMonitors() {
    try {
      monitorsData = (await api('/monitors')).monitors;
    } catch (err) {
      $('monitorList').innerHTML = `<p class="down">${esc(err.message)}</p>`;
      return;
    }
    $('monitorList').innerHTML = monitorsData.map((m) => {
      const up = m.last?.ok;
      const status = !m.last ? '<span class="pill p-grey">waiting</span>'
        : up ? '<span class="pill p-green">UP</span>' : '<span class="pill p-red">DOWN</span>';
      const maxMs = Math.max(100, ...m.history.map((h) => h.ms));
      const id = js(m.id);
      return `<div class="proj">
        <div class="head"><span class="name">${esc(m.name)}</span>${status}
          ${m.autoRestart ? `<span class="pill p-grey">auto-heal → ${esc(m.project)}</span>` : ''}</div>
        <div class="meta">🔗 ${esc(m.url)} · every ${m.intervalSec}s · down after ${m.failThreshold} fails</div>
        <div class="spark" title="Last checks (height = response time, red = failed)">${m.history.map((h) =>
          `<span class="${h.ok ? '' : 'bad'}" style="height:${h.ok ? Math.max(8, (h.ms / maxMs) * 100) : 100}%" title="${new Date(h.t).toLocaleTimeString()} · ${h.ok ? h.ms + ' ms' : esc(h.error || 'HTTP ' + h.status)}"></span>`).join('')}</div>
        <div class="stats">
          <div>Uptime<b>${m.uptimePct ?? '–'}${m.uptimePct != null ? '%' : ''}</b></div>
          <div>Avg response<b>${m.avgMs != null ? m.avgMs + ' ms' : '–'}</b></div>
          <div>Last<b>${m.last ? (m.last.ok ? m.last.ms + ' ms' : esc(m.last.error || 'HTTP ' + m.last.status)) : '–'}</b></div>
          <div>Fails in a row<b>${m.fails}</b></div>
        </div>
        ${m.lastHeal ? `<div class="muted">Last auto-heal restart: ${new Date(m.lastHeal).toLocaleString()}</div>` : ''}
        <div class="row" style="margin-top:8px">
          <button type="button" class="b-blue" onclick="checkMonitor(${id})"><svg class="ic"><use href="#i-play"/></svg>Check now</button>
          <button type="button" class="b-grey" onclick="openMonitorForm(${id})"><svg class="ic"><use href="#i-edit"/></svg>Edit</button>
          <button type="button" class="b-ghost" onclick="deleteMonitor(${id})"><svg class="ic"><use href="#i-trash"/></svg>Delete</button>
        </div></div>`;
    }).join('') || '<p class="muted">No monitors yet. Click "Add monitor".</p>';
  }

  function openMonitorForm(id) {
    const m = monitorsData.find((x) => x.id === id) || { name: '', url: 'http://localhost:', intervalSec: 30, timeoutMs: 5000, failThreshold: 3, project: '', autoRestart: false };
    const options = ['<option value="">(none)</option>', ...projects.map((p) => `<option ${p.name === m.project ? 'selected' : ''}>${esc(p.name)}</option>`)].join('');
    openModal(id ? `Edit monitor: ${m.name}` : 'Add monitor', `
      <div class="form">
        <label for="mName">Name</label><input id="mName" value="${esc(m.name)}" placeholder="My API">
        <label for="mUrl">URL</label><input id="mUrl" value="${esc(m.url)}" placeholder="http://localhost:5000/api">
        <label for="mInterval">Check every (s)</label><input id="mInterval" type="number" min="10" max="3600" value="${m.intervalSec}">
        <label for="mTimeout">Timeout (ms)</label><input id="mTimeout" type="number" min="1000" max="30000" value="${m.timeoutMs}">
        <label for="mFails">Down after N fails</label><input id="mFails" type="number" min="1" max="10" value="${m.failThreshold}">
        <label for="mProject">Project</label><select id="mProject">${options}</select>
        <label for="mHeal">Auto-heal</label><span><input type="checkbox" id="mHeal" ${m.autoRestart ? 'checked' : ''}> restart the project when it goes down (max once per 5 min)</span>
      </div>
      <p class="muted">Use localhost URLs for apps on this server (e.g. http://localhost:5000/api). Any public URL works too.</p>`,
      `<button type="button" class="b-green" onclick="saveMonitor(${js(id || '')})"><svg class="ic"><use href="#i-save"/></svg>Save</button>`);
  }

  async function saveMonitor(id) {
    const body = {
      name: $('mName').value, url: $('mUrl').value, intervalSec: +$('mInterval').value, timeoutMs: +$('mTimeout').value,
      failThreshold: +$('mFails').value, project: $('mProject').value, autoRestart: $('mHeal').checked,
    };
    try {
      const r = await api(id ? `/monitors/${id}` : '/monitors', { method: id ? 'PUT' : 'POST', body });
      toast(r.message, 'ok');
      closeModal();
      setTimeout(loadMonitors, 2500);
    } catch (err) { toast(err.message, 'err'); }
  }

  async function checkMonitor(id) {
    try {
      const r = await api(`/monitors/${id}/check`, { method: 'POST' });
      toast(r.message, r.result.ok ? 'ok' : 'err');
      loadMonitors();
    } catch (err) { toast(err.message, 'err'); }
  }

  async function deleteMonitor(id) {
    const m = monitorsData.find((x) => x.id === id);
    if (!confirm(`Delete monitor "${m?.name}"?`)) return;
    try {
      toast((await api(`/monitors/${id}`, { method: 'DELETE' })).message, 'ok');
      loadMonitors();
    } catch (err) { toast(err.message, 'err'); }
  }

  // ── redis ───────────────────────────────
  async function loadRedisInfo() {
    try {
      const r = await api('/redis/info');
      const tile = (label, value) => `<div class="tile"><div class="label">${label}</div><div class="value">${esc(value ?? '–')}</div></div>`;
      $('redisTiles').innerHTML = tile('Keys', r.keys) + tile('Memory used', r.memory) + tile('Ops / sec', r.opsPerSec)
        + tile('Cache hit rate', r.hitRate != null ? r.hitRate + '%' : '–') + tile('Clients', r.clients)
        + tile('Version · uptime', `${r.version} · ${fmtDur(r.uptimeSec)}`);
    } catch (err) {
      $('redisTiles').innerHTML = `<div class="notice crit">${esc(err.message)}. Check the Services tab: is redis-server running?</div>`;
    }
  }

  const fmtTtl = (t) => (t === -1 ? 'never' : t === -2 ? 'expired' : fmtDur(t));

  async function loadRedisKeys() {
    try {
      const r = await api('/redis/keys?pattern=' + encodeURIComponent($('redisPattern').value || '*'));
      $('redisKeys').innerHTML = r.keys.map((k) => `<tr>
        <td style="font-family:Consolas,monospace;word-break:break-all">${esc(k.key)}</td>
        <td><span class="pill p-grey">${esc(k.type)}</span></td><td class="muted">${fmtTtl(k.ttl)}</td>
        <td><button type="button" class="b-ghost" onclick="viewRedisKey(${js(k.key)})"><svg class="ic"><use href="#i-eye"/></svg>View</button>
            <button type="button" class="b-ghost" onclick="deleteRedisKey(${js(k.key)})" title="Delete"><svg class="ic"><use href="#i-trash"/></svg></button></td></tr>`).join('')
        || '<tr><td colspan="4" class="muted">No keys match.</td></tr>';
      $('redisNote').textContent = r.truncated ? 'Showing the first 300 matches. Narrow the pattern to see more.' : `${r.keys.length} key(s)`;
      loadRedisInfo();
    } catch (err) { toast(err.message, 'err'); }
  }

  async function viewRedisKey(key) {
    try {
      const r = await api('/redis/key?key=' + encodeURIComponent(key));
      let pretty = r.value;
      if (typeof pretty === 'string') {
        try { pretty = JSON.stringify(JSON.parse(pretty), null, 2); } catch { /* not JSON */ }
      } else pretty = JSON.stringify(pretty, null, 2);
      openModal(key, `<p class="muted">Type <b>${esc(r.type)}</b> · size ${esc(r.size ?? '–')} · expires: ${fmtTtl(r.ttl)}</p>
        <pre class="out" style="max-height:60vh">${esc(pretty)}</pre>`,
        `<button type="button" class="b-red" onclick="deleteRedisKey(${js(key)}, true)"><svg class="ic"><use href="#i-trash"/></svg>Delete</button>`);
    } catch (err) { toast(err.message, 'err'); }
  }

  async function deleteRedisKey(key, fromModal) {
    if (!confirm(`Delete Redis key "${key}"?`)) return;
    try {
      toast((await api('/redis/key?key=' + encodeURIComponent(key), { method: 'DELETE' })).message, 'ok');
      if (fromModal) closeModal();
      loadRedisKeys();
    } catch (err) { toast(err.message, 'err'); }
  }

  function openRedisSet() {
    openModal('Set a Redis key (string)', `
      <div class="form">
        <label for="rkKey">Key</label><input id="rkKey">
        <label for="rkTtl">Expires in (s)</label><input id="rkTtl" type="number" min="0" placeholder="0 = never">
      </div>
      <p class="muted" style="margin-top:10px">Value</p><textarea id="rkVal" rows="8" spellcheck="false"></textarea>`,
      '<button type="button" class="b-green" onclick="saveRedisKey()"><svg class="ic"><use href="#i-save"/></svg>Save</button>');
  }

  async function saveRedisKey() {
    try {
      const r = await api('/redis/key', { method: 'POST', body: { key: $('rkKey').value, value: $('rkVal').value, ttl: +$('rkTtl').value || 0 } });
      toast(r.message, 'ok');
      closeModal();
      loadRedisKeys();
    } catch (err) { toast(err.message, 'err'); }
  }

  async function flushRedis() {
    if (!confirm('Delete ALL keys in Redis? Caches will rebuild, but anything only stored in Redis is gone.')) return;
    if (prompt('Type DELETE to confirm') !== 'DELETE') return;
    try {
      toast((await api('/redis/flushdb', { method: 'POST' })).message, 'ok');
      loadRedisKeys();
    } catch (err) { toast(err.message, 'err'); }
  }

  // ── cron ────────────────────────────────
  const CRON_EXAMPLES = [
    ['Every 5 minutes: ping the API', '*/5 * * * * curl -s http://localhost:5000/api > /dev/null'],
    ['Every night 02:00 UTC: clean PM2 logs', '0 2 * * * pm2 flush'],
    ['Every Sunday 03:00 UTC: backup .env', '0 3 * * 0 cp ~/eventease_backend/.env ~/env-backup-$(date +\\%F).env'],
    ['Every day 04:00 UTC: delete files older than 7 days in ~/tmp', '0 4 * * * find ~/tmp -type f -mtime +7 -delete'],
    ['On every reboot: write a line to a log', '@reboot echo "rebooted $(date)" >> ~/reboots.log'],
  ];

  async function loadCron() {
    try {
      const r = await api('/cron');
      $('cronText').value = r.content;
      $('cronInfo').textContent = `${r.jobCount} active job(s)`;
      $('cronUser').textContent = serverUser || 'this user';
      $('cronExamples').innerHTML = CRON_EXAMPLES.map(([title, line]) =>
        `<div class="notice info" style="cursor:pointer" onclick="addCronLine(${js('# ' + title + '\n' + line)})">
          <b>${esc(title)}</b><br><code>${esc(line)}</code></div>`).join('');
    } catch (err) { toast(err.message, 'err'); }
  }

  function addCronLine(text) {
    const ta = $('cronText');
    ta.value = (ta.value.trim() ? ta.value.replace(/\n*$/, '\n\n') : '') + text + '\n';
    toast('Added. Click "Save crontab" to apply.', 'ok');
  }

  async function saveCron() {
    try {
      toast((await api('/cron', { method: 'PUT', body: { content: $('cronText').value } })).message, 'ok');
      loadCron();
    } catch (err) { toast(err.message, 'err'); }
  }

  // ── security ────────────────────────────
  async function loadSecurity() {
    try {
      const r = await api('/security');
      $('secSessions').textContent = r.sessions || '(nobody is logged in over SSH)';
      $('secLogins').textContent = r.logins || '(no login history available)';
      $('secLockouts').innerHTML = r.lockouts.map((l) => `<tr><td>${esc(l.ip)}</td><td>${l.failures}</td><td class="muted">${new Date(l.since).toLocaleString()}</td>
        <td><button type="button" class="b-ghost" onclick="unblockIp(${js(l.ip)})">Unblock</button></td></tr>`).join('')
        || '<tr><td colspan="4" class="muted">None.</td></tr>';
      $('secAudit').innerHTML = r.audit.map((a) => `<tr><td class="muted">${new Date(a.t).toLocaleString()}</td><td>${esc(a.ip)}</td>
        <td><b>${esc(a.method)}</b> ${esc(a.path)}</td>
        <td><span class="pill ${a.status < 400 ? 'p-green' : 'p-red'}">${a.status}</span></td>
        <td class="muted" style="font-family:Consolas,monospace;font-size:11px">${a.body && Object.keys(a.body).length ? esc(JSON.stringify(a.body)) : ''}</td></tr>`).join('')
        || '<tr><td colspan="5" class="muted">No changes yet.</td></tr>';
    } catch (err) { toast(err.message, 'err'); }
  }

  async function unblockIp(ip) {
    try {
      toast((await api('/security/lockouts/' + encodeURIComponent(ip), { method: 'DELETE' })).message, 'ok');
      loadSecurity();
    } catch (err) { toast(err.message, 'err'); }
  }

  // ── settings ────────────────────────────
  let settingsData = null;

  async function loadSettings() {
    try {
      settingsData = (await api('/settings')).settings;
      $('setWebhook').value = settingsData.webhookUrl;
      $('setCpu').value = settingsData.thresholds.cpu;
      $('setMem').value = settingsData.thresholds.memory;
      $('setDisk').value = settingsData.thresholds.disk;
      $('setLock').value = lockMinutes();
      $('setQuick').value = settingsData.quickCommands.map((c) => `${c.name} | ${c.command}`).join('\n');
    } catch (err) { toast(err.message, 'err'); }
  }

  async function saveSettings() {
    localStorage.setItem('opsLockMin', String(Math.max(0, parseInt($('setLock').value, 10) || 0)));
    const quickCommands = $('setQuick').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const i = l.indexOf('|');
      return i < 0 ? { name: l, command: l } : { name: l.slice(0, i).trim(), command: l.slice(i + 1).trim() };
    });
    try {
      const r = await api('/settings', {
        method: 'PUT',
        body: {
          webhookUrl: $('setWebhook').value.trim(),
          thresholds: { cpu: +$('setCpu').value, memory: +$('setMem').value, disk: +$('setDisk').value },
          quickCommands,
        },
      });
      settingsData = r.settings;
      toast(r.message, 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  async function testWebhook() {
    await saveSettings();
    try { toast((await api('/alerts/test', { method: 'POST' })).message, 'ok'); } catch (err) { toast(err.message, 'err'); }
  }

  // ── run command ─────────────────────────
  function renderQuickCmds() {
    $('quickCmds').innerHTML = (settingsData?.quickCommands || []).map((c, i) =>
      `<button type="button" class="b-ghost" onclick="runQuick(${i})" title="${esc(c.command)}">${esc(c.name)}</button>`).join('');
  }

  const runQuick = (i) => runCommand(settingsData.quickCommands[i].command);

  async function runCommand(preset) {
    const command = typeof preset === 'string' ? preset : $('runCmd').value.trim();
    if (!command) return;
    try {
      await api('/run', { method: 'POST', body: { command, cwd: $('runCwd').value.trim() || undefined } });
      if (typeof preset !== 'string') $('runCmd').value = '';
    } catch (err) { toast(err.message, 'err'); }
  }

  // ── file-type badges (files list + code explorer) ──
  const FILE_TYPES = {
    js: ['JS', '#f7df1e'], mjs: ['JS', '#f7df1e'], cjs: ['JS', '#f7df1e'], jsx: ['JSX', '#61dafb'],
    ts: ['TS', '#3b82f6'], tsx: ['TSX', '#61dafb'], json: ['{ }', '#fbbf24'], html: ['HTML', '#f97316'], htm: ['HTML', '#f97316'],
    css: ['CSS', '#38bdf8'], scss: ['SCSS', '#ec4899'], md: ['MD', '#a3a3a3'], env: ['ENV', '#b5f23d'], yml: ['YML', '#f87171'],
    yaml: ['YML', '#f87171'], sh: ['SH', '#4ade80'], py: ['PY', '#60a5fa'], sql: ['SQL', '#e879f9'], txt: ['TXT', '#8a919b'],
    log: ['LOG', '#8a919b'], lock: ['LCK', '#8a919b'], png: ['IMG', '#a78bfa'], jpg: ['IMG', '#a78bfa'], jpeg: ['IMG', '#a78bfa'],
    svg: ['SVG', '#fb923c'], gif: ['IMG', '#a78bfa'], xml: ['XML', '#f97316'], pem: ['KEY', '#ff5f5f'], gitignore: ['GIT', '#f05133'],
  };
  function fileIcon(name, type = 'file') {
    if (type === 'dir') return `<span class="fi dir">${ic('folder')}</span>`;
    const lower = name.toLowerCase();
    const ext = lower.startsWith('.env') ? 'env' : lower.startsWith('.') && !lower.slice(1).includes('.') ? lower.slice(1) : lower.slice(lower.lastIndexOf('.') + 1);
    const [label, color] = FILE_TYPES[ext] || ['', '#6b717b'];
    return label
      ? `<span class="fi" style="color:${color};background:${color}1f">${label}</span>`
      : `<span class="fi" style="color:${color}">${ic('file')}</span>`;
  }

  // ── logs: Output / Errors switch ──
  $('logTypeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-type]');
    if (!b) return;
    $('logType').value = b.dataset.type;
    document.querySelectorAll('#logTypeSeg button').forEach((x) => x.classList.toggle('active', x === b));
    if (following) { stopFollow(); toggleFollow(); } else loadLogs();
  });

  // ── live clock in the date pill ──
  function tickClock() {
    const d = new Date();
    const h = d.getHours();
    const part = h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 22 ? 'Good evening' : 'Working late';
    $('greeting').textContent = `${part}, ${serverUser || 'there'} 👋`;
    $('clockPill').textContent = d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
      + ' · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ── global search (Ctrl+K): pages, projects, actions ──
  let searchSel = 0;
  let searchItems = [];

  function searchCatalog() {
    const items = Object.entries(PAGES).map(([key, [title, sub, icon]]) => ({ icon, title, hint: 'Page', run: () => showTab(key), text: `${title} ${sub}` }));
    for (const p of projects) {
      items.push({ icon: 'box', title: p.name, hint: 'Project', run: () => showTab('projects'), text: `${p.name} ${p.cwd}` });
      items.push({ icon: 'rocket', title: `Deploy ${p.name}`, hint: 'Action', run: () => projAct(p.name, 'deploy'), text: `deploy ${p.name}` });
      items.push({ icon: 'rotate', title: `Restart ${p.name}`, hint: 'Action', run: () => projAct(p.name, 'restart'), text: `restart ${p.name}` });
      items.push({ icon: 'code', title: `Open ${p.name} in Code`, hint: 'Action', run: () => openInCode(p.name), text: `code edit ${p.name}` });
      items.push({ icon: 'logs', title: `Logs of ${p.name}`, hint: 'Action', run: () => openLogs(p.name), text: `logs ${p.name}` });
    }
    items.push(
      { icon: 'plus', title: 'Add project', hint: 'Action', run: openAddProject, text: 'add new project clone' },
      { icon: 'pulse', title: 'Add monitor', hint: 'Action', run: () => { showTab('monitors'); openMonitorForm(); }, text: 'add monitor uptime' },
      { icon: 'swap', title: 'Create 2 GB swap', hint: 'Action', run: () => serverAction('swap', 'Create a 2 GB swap file?'), text: 'swap memory' },
      { icon: 'broom', title: 'Clean logs', hint: 'Action', run: () => serverAction('clean-logs', 'Clear all PM2 logs?'), text: 'clean logs flush' },
      { icon: 'power', title: 'Reboot server', hint: 'Action', run: () => serverAction('reboot', 'REBOOT the whole server?'), text: 'reboot restart server' },
      { icon: 'bell', title: 'Show alerts', hint: 'Action', run: openAlerts, text: 'alerts notifications' },
    );
    return items;
  }

  function renderSearch() {
    const q = $('globalSearch').value.trim().toLowerCase();
    searchItems = searchCatalog().filter((it) => !q || q.split(/\s+/).every((w) => it.text.toLowerCase().includes(w))).slice(0, 12);
    searchSel = Math.min(searchSel, Math.max(0, searchItems.length - 1));
    $('searchResults').innerHTML = searchItems.map((it, i) =>
      `<div class="sr-item ${i === searchSel ? 'sel' : ''}" onmousedown="runSearch(${i})">${ic(it.icon)}<span>${esc(it.title)}</span><small>${it.hint}</small></div>`).join('')
      || '<div class="pl-empty">Nothing found</div>';
    $('searchResults').classList.add('show');
  }

  function runSearch(i) {
    const it = searchItems[i];
    closeSearch();
    it?.run();
  }

  function searchKey(e) {
    if (e.key === 'ArrowDown') { searchSel = Math.min(searchSel + 1, searchItems.length - 1); renderSearch(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { searchSel = Math.max(searchSel - 1, 0); renderSearch(); e.preventDefault(); }
    if (e.key === 'Enter') runSearch(searchSel);
    if (e.key === 'Escape') { $('globalSearch').blur(); $('searchResults').classList.remove('show'); }
  }
  function openSearch() {
    $('searchOverlay').classList.add('show');
    $('globalSearch').value = '';
    searchSel = 0;
    renderSearch();
    setTimeout(() => $('globalSearch').focus(), 20);
  }
  function closeSearch() { $('searchOverlay').classList.remove('show'); }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
    if (e.key === 'Escape' && $('searchOverlay').classList.contains('show')) closeSearch();
    if (e.key === 'Escape' && $('modal').classList.contains('show')) closeModal();
  });

  // ── quick deploy (the top-bar CTA) ──
  function openQuickDeploy() {
    openModal('Deploy', `<p class="muted">Pull the latest code from GitHub, install packages and reload with zero downtime.</p>
      <div class="table-wrap"><table><tbody>${projects.filter((p) => p.git).map((p) => `<tr>
        <td><div class="who">${avatar(p.name)}<div><b>${esc(p.name)}</b><span>${esc(p.git.branch)} · ${esc(p.git.commit)} ${esc(p.git.message)}</span></div></div></td>
        <td>${statusPill(p)}</td>
        <td style="text-align:right">
          <button type="button" class="b-grey" onclick="closeModal(); openGit(${js(p.name)})">${ic('git')}History</button>
          <button type="button" class="b-lime" onclick="closeModal(); projAct(${js(p.name)}, 'deploy')">${ic('rocket')}Deploy</button></td></tr>`).join('')
        || '<tr><td class="muted">No git projects found.</td></tr>'}</tbody></table></div>`);
  }

  // ── health score (header chip) ──────────
  let healthReasons = [];
  function renderHealth2(s, memPct) {
    const reasons = [];
    const down = projects.filter((p) => !p.online);
    if (down.length) reasons.push([25 * down.length, `${down.length} project(s) down: ${down.map((p) => p.name).join(', ')}`]);
    if (memPct > 85) reasons.push([15, `Memory at ${Math.round(memPct)}%`]);
    const diskPct = s.disk ? (s.disk.usedBytes / s.disk.totalBytes) * 100 : 0;
    if (diskPct > 85) reasons.push([15, `Disk at ${Math.round(diskPct)}%`]);
    if (s.loadAvg[0] > s.cpus) reasons.push([10, `CPU overloaded (load ${s.loadAvg[0].toFixed(2)} on ${s.cpus} CPUs)`]);
    if (!s.swap?.totalBytes && s.memory.totalBytes < 2 * 1024 ** 3) reasons.push([10, 'No swap on a small-memory server']);
    if (s.updates?.security) reasons.push([10, `${s.updates.security} security update(s) waiting`]);
    if (s.rebootRequired) reasons.push([5, 'Reboot required for installed updates']);
    const restarts = projects.reduce((n, p) => n + p.restarts, 0);
    if (restarts >= 10) reasons.push([5, `${restarts} app restarts (crashes?) since PM2 started`]);
    healthReasons = reasons;
    const score = Math.max(0, 100 - reasons.reduce((n, [pts]) => n + pts, 0));
    const chip = $('healthScore');
    chip.textContent = `Health ${score}`;
    chip.className = 'health-chip ' + (score >= 85 ? 'good' : score >= 60 ? 'mid' : 'bad');
  }

  function openHealth() {
    openModal('Server health', healthReasons.length
      ? `<p class="muted">Points taken off the perfect 100:</p>${healthReasons.map(([pts, text]) =>
        `<div class="notice ${pts >= 15 ? 'crit' : 'warn'}">${ic('alert')}<span><b>−${pts}</b> ${esc(text)}</span></div>`).join('')}`
      : `<p class="up">${ic('check')} Perfect score: nothing needs attention.</p>`);
  }

  // ── backups ─────────────────────────────
  async function openBackups(project) {
    openModal(project ? `Backups: ${project}` : 'Backups', '<p class="muted">Loading…</p>',
      project ? `<button type="button" class="b-primary" onclick="createBackup(${js(project)})">${ic('save')}Back up now</button>` : '');
    try {
      const r = await api('/backups' + (project ? '?project=' + encodeURIComponent(project) : ''));
      $('modalBody').innerHTML = `<p class="muted small">Snapshots of the project folder (without node_modules and .git), stored in <code>${esc(r.dir)}</code>.
        "Delete completely" makes one automatically. Restoring puts the files back and starts the app again.</p>
        ${r.backups.length ? `<div class="table-wrap"><table><tbody>${r.backups.map((b) => `<tr>
          <td><div class="who">${avatar(b.project)}<div><b>${esc(b.project)}</b><span>${new Date(b.createdAt).toLocaleString()} · ${fmtBytes(b.size)}</span></div></div></td>
          <td style="text-align:right;white-space:nowrap">
            <button type="button" class="b-lime" onclick="restoreBackup(${js(b.file)}, ${js(b.project)})">${ic('undo')}Restore</button>
            <button type="button" class="b-ghost" onclick="downloadBackup(${js(b.file)})" title="Download">${ic('download')}</button>
            <button type="button" class="b-ghost" onclick="deleteBackup(${js(b.file)}, ${js(project || '')})" title="Delete">${ic('trash')}</button></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">No backups yet.</p>'}`;
    } catch (err) { $('modalBody').innerHTML = `<p class="down">${esc(err.message)}</p>`; }
  }

  async function createBackup(project) {
    const r = await act('/backups', { project });
    if (r) setTimeout(() => openBackups(project), 2500);
  }

  async function restoreBackup(file, project) {
    const r = await act(`/backups/${encodeURIComponent(file)}/restore`, null,
      `Restore ${project} from this backup?\n\nFiles in the backup overwrite the current ones (newer files that are not in the backup stay). Packages are reinstalled and the app is (re)started.`);
    if (r) { closeModal(); showTab('activity'); }
  }

  async function deleteBackup(file, project) {
    if (!confirm('Delete this backup? This cannot be undone.')) return;
    try {
      toast((await api(`/backups/${encodeURIComponent(file)}`, { method: 'DELETE' })).message, 'ok');
      openBackups(project || undefined);
    } catch (err) { toast(err.message, 'err'); }
  }

  async function downloadBackup(file) {
    try {
      const res = await fetch(`/api/backups/${encodeURIComponent(file)}/download`, { headers: { 'x-ops-token': token() } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      Object.assign(document.createElement('a'), { href: url, download: file }).click();
      URL.revokeObjectURL(url);
    } catch (err) { toast(err.message, 'err'); }
  }

  // ── download the visible logs ───────────
  function downloadLogs() {
    const text = $('logOut').textContent;
    if (!text.trim()) return toast('Load some logs first', 'err');
    const name = `${$('logProject').value || 'logs'}-${$('logType').value}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    URL.revokeObjectURL(url);
  }

  // ── auto-lock after inactivity ──────────
  const lockMinutes = () => {
    const v = localStorage.getItem('opsLockMin');
    return v === null ? 30 : Math.max(0, parseInt(v, 10) || 0);
  };
  let lastActivity = Date.now();
  ['mousemove', 'keydown', 'mousedown', 'wheel', 'touchstart'].forEach((ev) =>
    document.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true }));
  setInterval(() => {
    const min = lockMinutes();
    if (!min || !token() || $('login').classList.contains('show')) return;
    if (Date.now() - lastActivity > min * 60000) {
      localStorage.removeItem('opsAgentToken'); // page state (open files, terminals) stays behind the lock
      $('tokenInput').value = '';
      showLogin(`Locked after ${min} minutes without activity. Enter the password to continue.`);
    }
  }, 20000);

  // ── keyboard shortcuts help ("?") ───────
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.closest?.('.monaco-editor, .xterm');
    if (e.key !== '?' || typing) return;
    openModal('Keyboard shortcuts', `<div class="kbd-grid">
      <span>Search pages, projects &amp; actions</span><kbd>Ctrl K</kbd>
      <span>Go to file (Code)</span><kbd>Ctrl P</kbd>
      <span>Find in files (Code)</span><kbd>Ctrl Shift F</kbd>
      <span>Save / save all (Code)</span><kbd>Ctrl S / Ctrl Alt S</kbd>
      <span>Toggle project terminal (Code)</span><kbd>Ctrl \`</kbd>
      <span>Format document (Code)</span><kbd>Shift Alt F</kbd>
      <span>Word wrap (Code)</span><kbd>Alt Z</kbd>
      <span>Close tab (Code)</span><kbd>Alt W</kbd>
      <span>Close dialogs</span><kbd>Esc</kbd>
      <span>This list</span><kbd>?</kbd></div>`);
  });

  // ── start ───────────────────────────────
  let started = false;
  async function start() {
    if (started) return;
    started = true;
    connectOps();
    loadSystem();
    loadProjects();
    api('/jobs').then((r) => { r.jobs.forEach((j) => jobs.set(j.id, j)); renderJobs(); }).catch(() => {});
    api('/metrics').then((r) => { samples = r.samples; drawCharts(); }).catch(() => {});
    api('/alerts').then((r) => renderAlerts(r.active)).catch(() => {});
    api('/settings').then((r) => { settingsData = r.settings; }).catch(() => {});
    window.addEventListener('resize', () => { if (activeTab === 'overview') drawCharts(); });
    setInterval(() => {
      if (!$('autoRefresh').checked) return;
      if (activeTab === 'overview') { loadSystem(); loadProjects(); }
      if (activeTab === 'projects') loadProjects();
      if (activeTab === 'services') loadServices();
      if (activeTab === 'monitors') loadMonitors();
    }, 5000);
  }

  // called from index.html once both scripts are loaded
  function start0() {
    setThemeIcon();
    renderPillTabs();
    renderReco();
    tickClock();
    setInterval(tickClock, 15000);
    if (!token()) showLogin();
    else api('/system').then(start).catch(() => {});
  }
