  // ═════════════════════════════════════════════════════════════
  // Transfer tab (WinSCP style):
  //   project switcher → your PC (drop / pick, compare) | server (browse)
  //   → upload new + changed files → Apply (backup, install/build, restart)
  //   → result (live / unhealthy / failed, logs) → history with rollback
  // ═════════════════════════════════════════════════════════════
  const tx = {
    ready: false,
    home: '',
    projects: [],
    project: null, // project name, or null = home folder (upload only, no Apply)
    root: '', // folder you can't go above
    dir: '', // server folder shown on the right (= upload target)
    entries: [],
    queue: [], // { file, src, rel, size, status, progress, include, hash, error }
    stripTop: true,
    uploading: false,
    uploaded: [], // files waiting in the project's staging folder (root-relative), from the server
    apply: null, // { id, jobId, plan }
    pollTimer: null,
    xhrs: new Set(),
  };
  const TX_SAVE = 'opsTransfer';
  const txSaved = () => { try { return JSON.parse(localStorage.getItem(TX_SAVE)) || {}; } catch { return {}; } };
  const txRemember = (patch) => localStorage.setItem(TX_SAVE, JSON.stringify({ ...txSaved(), ...patch }));
  const txProj = () => tx.projects.find((p) => p.name === tx.project) || null;
  const relToRoot = (full) => full === tx.root ? '' : full.slice(tx.root.length + 1);
  // uploads for a project wait here until Apply (the live folder is not touched before that)
  const stagingFor = (dir) => `${tx.home}/.ops-staging/${tx.project}` + (relToRoot(dir) ? '/' + relToRoot(dir) : '');

  async function txLoadStaging() {
    if (!tx.project) { tx.uploaded = []; return; }
    try {
      const r = await api('/transfer/staging?project=' + encodeURIComponent(tx.project));
      tx.uploaded = r.files;
      tx.stagedCount = r.count;
      tx.stagedSize = r.size;
    } catch { tx.uploaded = []; tx.stagedCount = 0; }
  }
  const LOCK_NAMES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);
  const NO_BUILD = /^(\.env(\..*)?|readme(\..*)?|license(\..*)?|\.gitignore)$/i;

  // ── SHA-256 (crypto.subtle only exists on https://, so a small fallback) ──
  const SHA_K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb,
    0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f,
    0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256js(bytes) {
    const len = bytes.length;
    const total = Math.ceil((len + 9) / 64) * 64;
    const m = new Uint8Array(total);
    m.set(bytes);
    m[len] = 0x80;
    const dv = new DataView(m.buffer);
    dv.setUint32(total - 8, Math.floor(len / 0x20000000));
    dv.setUint32(total - 4, (len * 8) >>> 0);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const W = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + W[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    return [...H].map((x) => x.toString(16).padStart(8, '0')).join('');
  }
  async function sha256File(file) {
    const buf = await file.arrayBuffer();
    if (window.crypto?.subtle && window.isSecureContext) {
      const d = await crypto.subtle.digest('SHA-256', buf);
      return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
    return sha256js(new Uint8Array(buf));
  }

  // ── open the tab ──────────────────────────
  async function initTransfer() {
    if (!tx.ready) {
      tx.ready = true;
      const zone = $('txDrop');
      ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); }));
      ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove('over')));
      zone.addEventListener('drop', async (e) => {
        e.preventDefault();
        txAddFiles(await collectDropped(e.dataTransfer), 'drop');
      });
      $('txServerList').addEventListener('keydown', txServerKeys);
    }
    await txLoadProjects();
    const saved = txSaved();
    const pick = tx.project ?? (saved.project && tx.projects.some((p) => p.name === saved.project) ? saved.project : tx.projects[0]?.name ?? null);
    if (pick !== tx.project || !tx.dir) txSwitch(pick, true);
    else { txRenderSwitcher(); txBrowse(tx.dir); txLoadHistory(); txLoadStaging().then(txRenderApply); }
  }

  async function txLoadProjects() {
    try {
      const r = await api('/transfer/projects');
      tx.home = r.home;
      tx.projects = r.projects;
    } catch (err) { toast(err.message, 'err'); }
    txRenderSwitcher();
  }

  function txRenderSwitcher() {
    $('txProjects').innerHTML = tx.projects.map((p) => `
      <button type="button" class="tx-proj${p.name === tx.project ? ' active' : ''}" onclick="txSwitch(${js(p.name)})" title="${esc(p.cwd)}">
        <span class="tx-dot ${p.online ? 'on' : 'off'}"></span>${esc(p.name)}${p.port ? `<span class="tx-port">:${p.port}</span>` : ''}
        ${p.staged ? `<span class="tx-waiting" title="${p.staged} uploaded file(s) not applied yet">${p.staged}</span>` : ''}
        ${p.busy ? '<span class="spin"></span>' : ''}</button>`).join('')
      + `<button type="button" class="tx-proj${tx.project === null ? ' active' : ''}" onclick="txSwitch(null)" title="${esc(tx.home)}">${ic('home')}Home folder</button>`;
    const p = txProj();
    $('txInfo').innerHTML = p ? `
      <span class="tx-dot ${p.online ? 'on' : 'off'}"></span><b>${esc(p.status || 'unknown')}</b>
      <span class="sep">·</span>${p.port ? `port <b>${p.port}</b> <a href="http://${esc(location.hostname)}:${p.port}" target="_blank" rel="noopener">Open app ↗</a>` : '<span class="muted">no port found</span>'}
      <span class="sep">·</span><span class="muted">${esc(p.cwd)}</span>
      ${p.deploy?.startCmd ? `<span class="sep">·</span><span class="muted">start: <code>${esc(p.deploy.startCmd)}</code>${p.deploy.buildCmd ? ` · build: <code>${esc(p.deploy.buildCmd)}</code>` : ''}</span>` : ''}
      ${p.last ? `<span class="sep">·</span>last apply ${txStatusPill(p.last.status)} <span class="muted">${timeAgo(p.last.at)}</span>` : ''}`
      : `<span class="muted">Home folder: upload anywhere in <b>${esc(tx.home)}</b>. Pick a project above to apply and check a deploy.</span>`;
    if (!tx.projects.length) $('txInfo').innerHTML += `<div class="notice info mt">${ic('info')}<span>No projects yet. Deploy one with <b>Deploy a project</b> (top right), then come back here to update it.</span></div>`;
  }

  function txSwitch(name, quiet = false) {
    if (tx.uploading) return toast('Wait for the upload to finish', 'err');
    if (!quiet && tx.queue.length && name !== tx.project && !confirm('Switch project? The files waiting on the left will be cleared.')) return;
    tx.project = name;
    const p = txProj();
    tx.root = p ? p.cwd : tx.home;
    const lastDir = (txSaved().dirs || {})[name || '~'];
    tx.dir = lastDir && (lastDir === tx.root || lastDir.startsWith(tx.root + '/')) ? lastDir : tx.root;
    tx.queue = [];
    tx.uploaded = [];
    tx.apply = null;
    clearInterval(tx.pollTimer);
    txRemember({ project: name });
    txRenderSwitcher();
    txRenderQueue();
    txRenderApply();
    txBrowse(tx.dir);
    txLoadHistory();
    txLoadStaging().then(txRenderApply);
  }

  // ── server side ───────────────────────────
  async function txBrowse(dir) {
    try {
      const r = await api('/files?path=' + encodeURIComponent(dir));
      if (r.type !== 'dir') return;
      tx.dir = r.path;
      tx.entries = r.entries;
      const dirs = txSaved().dirs || {};
      dirs[tx.project || '~'] = tx.dir;
      txRemember({ dirs });
    } catch (err) {
      toast(err.message, 'err');
      if (dir !== tx.root) return txBrowse(tx.root);
      tx.entries = [];
    }
    txRenderServer();
    if (tx.queue.length) txCompare(); // target folder changed: compare again
  }

  function txRenderServer() {
    const rel = relToRoot(tx.dir);
    const rootName = tx.project ? tx.project : '~';
    let acc = tx.root;
    $('txCrumbs').innerHTML = `<a onclick="txBrowse(${js(tx.root)})">${ic(tx.project ? 'box' : 'home')}${esc(rootName)}</a>`
      + rel.split('/').filter(Boolean).map((part) => { acc += '/' + part; return ` / <a onclick="txBrowse(${js(acc)})">${esc(part)}</a>`; }).join('');
    $('txUp').disabled = tx.dir === tx.root;
    const hidden = $('txHidden').checked;
    const f = $('txFilter').value.toLowerCase();
    const list = tx.entries.filter((e) => (hidden || !e.name.startsWith('.')) && (!f || e.name.toLowerCase().includes(f)));
    $('txServerList').innerHTML = list.map((e) => {
      const p = js(joinPath(tx.dir, e.name));
      const isEnv = /^\.env/.test(e.name);
      return `<tr tabindex="0" data-path="${esc(joinPath(tx.dir, e.name))}" data-dir="${e.type === 'dir' ? 1 : ''}"${e.type === 'dir' ? ` ondblclick="txBrowse(${p})"` : ''}>
        <td class="tx-name" ${e.type === 'dir' ? `onclick="txBrowse(${p})"` : ''}>${fileIcon(e.name, e.type)} ${esc(e.name)}${isEnv ? ' <span class="pill p-grey">secrets</span>' : ''}</td>
        <td class="muted">${e.type === 'dir' ? '' : fmtBytes(e.size)}</td>
        <td class="muted">${e.mtime ? timeAgo(e.mtime) : ''}</td>
        <td class="tx-acts">
          ${e.type === 'file' ? `<button type="button" class="b-ghost" onclick="txEdit(${p})" title="Open / edit">${ic('edit')}</button>
            <button type="button" class="b-ghost" onclick="downloadFile(${p})" title="Download">${ic('download')}</button>`
            : `<button type="button" class="b-ghost" onclick="downloadFolder(${p})" title="Download folder (.tar.gz)">${ic('download')}</button>`}
          <button type="button" class="b-ghost" onclick="txRename(${p})" title="Rename (F2)">${ic('copy')}</button>
          <button type="button" class="b-ghost" onclick="txDelete(${p}, ${e.type === 'dir'})" title="Delete (Del)">${ic('trash')}</button></td></tr>`;
    }).join('') || `<tr><td colspan="4" class="muted">${tx.entries.length ? 'Nothing matches the filter' : 'Empty folder'}</td></tr>`;
  }

  function txServerKeys(e) {
    const row = e.target.closest('tr[data-path]');
    if (!row) return;
    const p = row.dataset.path;
    if (e.key === 'Enter') { e.preventDefault(); row.dataset.dir ? txBrowse(p) : txEdit(p); }
    if (e.key === 'F2') { e.preventDefault(); txRename(p); }
    if (e.key === 'Delete') { e.preventDefault(); txDelete(p, Boolean(row.dataset.dir)); }
    if (e.key === 'Backspace') { e.preventDefault(); txUp(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      (e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling)?.focus();
    }
  }

  function txUp() {
    if (tx.dir !== tx.root) txBrowse(parentOf(tx.dir));
  }

  async function txEdit(p) {
    try {
      const r = await api('/files?path=' + encodeURIComponent(p));
      if (r.type === 'file') {
        window.onFileSaved = () => { if (activeTab === 'transfer') txBrowse(tx.dir); };
        editFile(r);
      }
    } catch (err) { toast(err.message, 'err'); }
  }

  async function txRename(p) {
    const oldName = p.slice(p.lastIndexOf('/') + 1);
    const name = prompt('New name:', oldName);
    if (!name || name === oldName) return;
    try {
      toast((await api('/files/rename', { method: 'POST', body: { from: p, to: joinPath(parentOf(p), name) } })).message, 'ok');
      txBrowse(tx.dir);
    } catch (err) { toast(err.message, 'err'); }
  }

  async function txDelete(p, isDir) {
    const name = p.slice(p.lastIndexOf('/') + 1);
    if (!await askConfirm(isDir ? `Delete the folder "${name}" and everything inside it?\nThis cannot be undone.` : `Delete "${name}"?\nThis cannot be undone.`,
      { ok: 'Delete', danger: true, title: 'Delete' })) return;
    try {
      toast((await api('/files?path=' + encodeURIComponent(p), { method: 'DELETE' })).message, 'ok');
      txBrowse(tx.dir);
    } catch (err) { toast(err.message, 'err'); }
  }

  async function txNewFolder() {
    const name = prompt('New folder name:');
    if (!name) return;
    try {
      toast((await api('/files/mkdir', { method: 'POST', body: { path: joinPath(tx.dir, name) } })).message, 'ok');
      txBrowse(tx.dir);
    } catch (err) { toast(err.message, 'err'); }
  }

  // ── your PC side: queue + compare ─────────
  function txPicked(fileList, kind) {
    txAddFiles([...fileList].map((file) => ({ file, path: file.webkitRelativePath || file.name })), kind);
  }

  function txAddFiles(items, kind) {
    if (tx.uploading) return toast('Wait for the upload to finish', 'err');
    const kept = items.filter((it) => !it.path.split('/').some((p) => SKIP_UPLOAD.has(p)));
    const skipped = items.length - kept.length;
    if (!kept.length) return toast(skipped ? 'Only node_modules / .git found: those are skipped' : 'No files', 'err');
    const known = new Set(tx.queue.map((q) => q.src));
    for (const it of kept) {
      if (known.has(it.path)) { // same file picked again: take the newer copy
        const q = tx.queue.find((x) => x.src === it.path);
        Object.assign(q, { file: it.file, size: it.file.size, status: 'pending', progress: 0, error: '', hash: null });
        continue;
      }
      tx.queue.push({ file: it.file, src: it.path, rel: it.path, size: it.file.size, status: 'pending', progress: 0, include: true, hash: null, error: '' });
    }
    if (skipped) toast(`Skipped ${skipped} file(s) in node_modules / .git`);
    // a whole folder picked (one top folder): upload what's inside it, not the folder itself
    const tops = new Set(tx.queue.map((q) => q.src.split('/')[0]));
    tx.stripTop = tops.size === 1 && tx.queue.every((q) => q.src.includes('/'));
    txApplyStrip();
    txCompare();
  }

  function txApplyStrip() {
    const strip = tx.stripTop && $('txStrip')?.checked !== false;
    for (const q of tx.queue) q.rel = strip ? q.src.slice(q.src.indexOf('/') + 1) : q.src;
  }

  function txToggleStrip() {
    txApplyStrip();
    txCompare();
  }

  async function txCompare() {
    if (!tx.queue.length) return txRenderQueue();
    const base = relToRoot(tx.dir);
    const items = tx.queue.filter((q) => !['uploading'].includes(q.status));
    items.forEach((q) => { q.status = 'comparing'; q.error = ''; });
    txRenderQueue();
    try {
      for (let i = 0; i < items.length; i += 500) {
        const chunk = items.slice(i, i + 500);
        const r = await api('/transfer/compare', { method: 'POST', body: { root: tx.root, files: chunk.map((q) => ({ path: (base ? base + '/' : '') + q.rel, size: q.size })) } });
        for (let k = 0; k < chunk.length; k++) {
          const q = chunk[k];
          const res = r.results[k];
          if (res.status === 'check') {
            q.hash = q.hash || await sha256File(q.file);
            q.status = q.hash === res.hash ? 'same' : 'changed';
          } else q.status = res.status;
          q.error = res.reason || (res.status === 'blocked' ? 'Not allowed here' : '');
          q.include = ['new', 'changed'].includes(q.status);
        }
        txRenderQueue();
      }
    } catch (err) {
      items.forEach((q) => { if (q.status === 'comparing') q.status = 'pending'; });
      toast(err.message, 'err');
    }
    txRenderQueue();
  }

  const TX_BADGE = {
    pending: ['p-grey', 'Waiting'], comparing: ['p-grey', 'Checking…'], new: ['p-blue', 'New'], changed: ['p-orange', 'Changed'],
    same: ['p-grey', 'Same'], blocked: ['p-red', 'Blocked'], uploading: ['p-blue', 'Uploading'], done: ['p-green', 'Uploaded'], ready: ['p-green', 'Ready to apply'], failed: ['p-red', 'Failed'],
  };

  function txRenderQueue() {
    const q = tx.queue;
    const count = (s) => q.filter((x) => x.status === s).length;
    const todo = q.filter((x) => x.include && ['new', 'changed', 'failed'].includes(x.status));
    const showSame = $('txShowSame').checked;
    const tops = new Set(q.map((x) => x.src.split('/')[0]));
    $('txStripBox').hidden = !tx.stripTop;
    if (tx.stripTop) $('txStripName').textContent = [...tops][0] || '';
    $('txEmpty').hidden = Boolean(q.length);
    $('txQueueWrap').hidden = !q.length;
    $('txSummary').innerHTML = q.length ? [
      `<b>${q.length}</b> file(s)`,
      count('new') && `<span class="pill p-blue">${count('new')} new</span>`,
      count('changed') && `<span class="pill p-orange">${count('changed')} changed</span>`,
      count('same') && `<span class="pill p-grey">${count('same')} same</span>`,
      count('done') && `<span class="pill p-green">${count('done')} uploaded</span>`,
      count('failed') && `<span class="pill p-red">${count('failed')} failed</span>`,
      count('blocked') && `<span class="pill p-red">${count('blocked')} blocked</span>`,
      count('comparing') && '<span class="spin"></span> comparing…',
    ].filter(Boolean).join(' ') : '';
    const envOver = q.some((x) => x.include && /(^|\/)\.env$/.test(x.rel) && x.status === 'changed');
    $('txEnvWarn').hidden = !envOver;
    const target = relToRoot(tx.dir);
    $('txTarget').innerHTML = `into <b>${esc(tx.project || '~')}/${esc(target)}</b>`;
    $('txUploadBtn').disabled = tx.uploading || !todo.length || q.some((x) => x.status === 'comparing');
    $('txUploadBtn').innerHTML = tx.uploading ? '<span class="spin"></span>Uploading…'
      : `${ic('upload')}Upload ${todo.length ? todo.length + ' file(s)' : ''} (${fmtBytes(todo.reduce((s, x) => s + x.size, 0))})`;
    $('txClearBtn').disabled = tx.uploading;
    const rows = q.map((x, i) => [x, i]).filter(([x]) => showSame || x.status !== 'same');
    $('txQueue').innerHTML = rows.slice(0, 800).map(([x, i]) => {
      const [cls, label] = TX_BADGE[x.status === 'done' && tx.project ? 'ready' : x.status] || TX_BADGE.pending;
      const can = ['new', 'changed', 'failed'].includes(x.status);
      return `<tr class="${x.include && can ? '' : 'dim'}">
        <td><input type="checkbox" ${x.include && can ? 'checked' : ''} ${can && !tx.uploading ? '' : 'disabled'} onchange="txInclude(${i}, this.checked)" aria-label="Upload this file"></td>
        <td class="tx-name" title="${esc(x.src)}">${fileIcon(x.rel.split('/').pop())} ${esc(x.rel)}${/(^|\/)\.env$/.test(x.rel) ? ' <span class="pill p-grey">secrets</span>' : ''}</td>
        <td class="muted">${fmtBytes(x.size)}</td>
        <td>${x.status === 'uploading' ? `<div class="tx-bar"><div style="width:${x.progress}%"></div></div>` : `<span class="pill ${cls}" title="${esc(x.error)}">${label}</span>`}</td></tr>`;
    }).join('') + (rows.length > 800 ? `<tr><td colspan="4" class="muted">…and ${rows.length - 800} more</td></tr>` : '');
  }

  function txInclude(i, on) {
    tx.queue[i].include = on;
    txRenderQueue();
  }

  function txClear() {
    if (tx.uploading) return;
    tx.queue = [];
    txRenderQueue();
  }

  // ── upload ────────────────────────────────
  function txUploadOne(q, dir) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      tx.xhrs.add(xhr);
      xhr.open('POST', `/api/files/upload?${new URLSearchParams({ dir, name: q.rel, overwrite: '1' })}`);
      xhr.setRequestHeader('x-ops-token', token());
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        q.progress = Math.round((e.loaded / e.total) * 100);
        const done = tx.queue.reduce((s, x) => s + (x.status === 'done' ? x.size : x.status === 'uploading' ? (x.size * x.progress) / 100 : 0), 0);
        $('txOverall').style.width = Math.min(100, (done / tx.uploadTotal) * 100) + '%';
        txRenderQueueSoon();
      };
      xhr.onload = () => {
        tx.xhrs.delete(xhr);
        if (xhr.status >= 200 && xhr.status < 300) { q.status = 'done'; q.progress = 100; } else {
          q.status = 'failed';
          try { q.error = JSON.parse(xhr.responseText).message; } catch { q.error = `HTTP ${xhr.status}`; }
        }
        resolve();
      };
      xhr.onerror = xhr.onabort = () => {
        tx.xhrs.delete(xhr);
        q.status = 'failed';
        q.error = xhr.status === 0 && tx.cancelled ? 'Cancelled' : 'Network error';
        resolve();
      };
      xhr.send(q.file);
    });
  }

  let txRenderTimer = null;
  function txRenderQueueSoon() {
    if (txRenderTimer) return;
    txRenderTimer = setTimeout(() => { txRenderTimer = null; txRenderQueue(); }, 150);
  }

  async function txUpload() {
    const todo = tx.queue.filter((x) => x.include && ['new', 'changed', 'failed'].includes(x.status));
    if (!todo.length) return;
    const envOver = todo.find((x) => /(^|\/)\.env$/.test(x.rel) && x.status === 'changed');
    if (envOver && !await askConfirm(`This replaces the server's ${envOver.rel} (passwords, keys, database URL) with the one from your PC.\n\nContinue?`,
      { ok: 'Replace .env', danger: true, title: 'Replace .env?' })) return;
    tx.uploading = true;
    tx.cancelled = false;
    tx.uploadTotal = todo.reduce((s, x) => s + x.size, 0) || 1;
    $('txProgress').hidden = false;
    $('txOverall').style.width = '0';
    const dir = tx.project ? stagingFor(tx.dir) : tx.dir;
    todo.forEach((x) => { x.status = 'uploading'; x.progress = 0; x.error = ''; });
    txRenderQueue();
    const queue = [...todo];
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (queue.length && !tx.cancelled) await txUploadOne(queue.shift(), dir);
    }));
    queue.forEach((x) => { x.status = 'failed'; x.error = 'Cancelled'; });
    tx.uploading = false;
    $('txProgress').hidden = true;
    const ok = todo.filter((x) => x.status === 'done');
    const failed = todo.length - ok.length;
    toast(failed ? `Uploaded ${ok.length}, ${failed} failed (tick them and upload again)`
      : tx.project ? `Uploaded ${ok.length} file(s). Click Apply to put them live` : `Uploaded ${ok.length} file(s)`, failed ? 'err' : 'ok');
    txRenderQueue();
    if (tx.project) { await txLoadStaging(); txLoadProjects(); } else txBrowse(tx.dir);
    txRenderApply();
    if (ok.length && tx.project && !failed) $('txApplyCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function txCancel() {
    tx.cancelled = true;
    tx.xhrs.forEach((x) => x.abort());
  }

  // ── apply ─────────────────────────────────
  // Same rules as the server, to show the plan before you click.
  function txPlanPreview(mode) {
    const p = txProj();
    const files = tx.uploaded;
    const base = (f) => f.split('/').pop();
    const pkg = files.some((f) => LOCK_NAMES.has(base(f)) && !f.includes('/'));
    const code = files.some((f) => !NO_BUILD.test(base(f)));
    const install = mode === 'full' || (mode === 'auto' && pkg);
    const build = Boolean(p?.deploy?.buildCmd) && (mode === 'full' || (mode === 'auto' && code));
    return [
      'Backup current files',
      install && `Install packages${p?.deploy?.installCmd ? ` (${p.deploy.installCmd})` : ''}`,
      build && `Build (${p.deploy.buildCmd})`,
      'Restart',
      'Check it is live',
    ].filter(Boolean);
  }

  function txRenderApply() {
    const card = $('txApplyCard');
    const p = txProj();
    card.hidden = !p;
    if (!p) return;
    if (tx.apply) return; // a run is shown, txPoll renders it
    const mode = $('txMode')?.value || 'auto';
    const n = tx.uploaded.length;
    $('txApplyBody').innerHTML = `
      ${n ? `<div class="notice info">${ic('upload')}<span><b>${tx.stagedCount || n} file(s)</b> (${fmtBytes(tx.stagedSize || 0)}) uploaded and waiting.
          Your live app is <b>not changed</b> until you click Apply.</span></div>`
        : `<p>Nothing uploaded and waiting. You can still restart or fully redeploy <b>${esc(p.name)}</b>.</p>`}
      ${n ? `<details class="muted small"><summary>Uploaded files</summary><div class="tx-files">${tx.uploaded.slice(0, 100).map((f) => `<code>${esc(f)}</code>`).join(' ')}${n > 100 ? ` …and ${n - 100} more` : ''}</div></details>` : ''}
      <div class="row mt">
        <label class="muted small" for="txMode">What to do</label>
        <select id="txMode" onchange="txRenderApply()">
          <option value="auto"${mode === 'auto' ? ' selected' : ''}>Automatic (recommended)</option>
          <option value="restart"${mode === 'restart' ? ' selected' : ''}>Restart only</option>
          <option value="full"${mode === 'full' ? ' selected' : ''}>Full redeploy: install + build + restart</option>
        </select>
      </div>
      <ol class="tx-plan">${txPlanPreview(mode).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      <p class="muted small">A backup is made first, so you can roll back in one click if something breaks. Only the last 3 automatic backups are kept.</p>`;
    $('txApplyFoot').innerHTML = `<button type="button" class="b-gradient" onclick="txApply()" ${p.busy ? 'disabled title="This project is busy"' : ''}>${ic('rocket')}<span>${n ? 'Apply &amp; deploy' : mode === 'full' ? 'Redeploy' : 'Restart'}</span></button>`
      + (n ? `<button type="button" class="b-grey" onclick="txDiscard()">${ic('trash')}Discard uploaded files</button>` : '');
  }

  async function txDiscard() {
    const p = txProj();
    if (!p || !await askConfirm(`Throw away the ${tx.stagedCount} uploaded file(s) waiting for ${p.name}?\nThe live project is not touched.`,
      { ok: 'Discard', danger: true, title: 'Discard upload' })) return;
    try {
      toast((await api('/transfer/discard', { method: 'POST', body: { project: p.name } })).message, 'ok');
      tx.queue = [];
      await txLoadStaging();
      txRenderQueue();
      txRenderApply();
      txLoadProjects();
    } catch (err) { toast(err.message, 'err'); }
  }

  async function txApply() {
    const p = txProj();
    if (!p) return;
    if (tx.uploading) return toast('Wait for the upload to finish', 'err');
    const mode = $('txMode').value;
    try {
      const r = await api('/transfer/apply', { method: 'POST', body: { project: p.name, mode } });
      tx.apply = { id: r.id, jobId: r.jobId, plan: r.plan, why: r.why, startedAt: Date.now() };
      tx.uploaded = [];
      tx.queue = []; // they are being applied now
      txRenderQueue();
      txRenderRun(null);
      clearInterval(tx.pollTimer);
      tx.pollTimer = setInterval(txPoll, 1500);
    } catch (err) { toast(err.message, 'err'); }
  }

  async function txPoll() {
    if (!tx.apply) return clearInterval(tx.pollTimer);
    try {
      const { record } = await api('/transfer/history/' + tx.apply.id);
      txRenderRun(record);
      if (record.status !== 'running') {
        clearInterval(tx.pollTimer);
        txLoadProjects();
        txLoadHistory();
        txLoadStaging();
        txBrowse(tx.dir);
        toast(record.status === 'live' ? `${record.project} is live ✓` : `${record.project}: ${record.summary}`, record.status === 'live' ? 'ok' : 'err');
      }
    } catch { /* the panel may be busy for a moment, keep polling */ }
  }

  // steps from the job output: ▶ STEP id … ✔ STEP id
  function txStepState(plan, output, record) {
    const started = new Set([...output.matchAll(/^▶ STEP (\w+)/gm)].map((m) => m[1]));
    const done = new Set([...output.matchAll(/^✔ STEP (\w+)/gm)].map((m) => m[1]));
    return plan.map((s) => {
      let st = done.has(s.id) ? 'ok' : started.has(s.id) ? 'run' : 'wait';
      if (record && record.status !== 'running') {
        if (st === 'run') st = 'fail';
        if (s.id === 'health') st = record.status === 'live' ? 'ok' : record.status === 'unhealthy' ? 'fail' : 'skip';
        else if (st === 'wait') st = 'skip';
      } else if (s.id === 'health' && done.has('save')) st = 'run';
      return { ...s, st };
    });
  }

  function txRenderRun(record) {
    const a = tx.apply;
    const output = record?.output || jobs.get(a.jobId)?.output || '';
    const steps = txStepState(a.plan, output, record);
    const icon = { ok: ic('check'), run: '<span class="spin"></span>', fail: ic('x'), wait: '<span class="tx-wait"></span>', skip: '<span class="tx-wait"></span>' };
    const running = !record || record.status === 'running';
    const r = record?.result;
    const host = location.hostname;
    $('txApplyBody').innerHTML = `
      ${running ? `<p class="muted">${esc(a.why ? 'Plan: ' + a.why : '')}</p>` : txResultBanner(record)}
      <div class="tx-steps">${steps.map((s) => `<div class="tx-step ${s.st}">${icon[s.st]}<span>${esc(s.label)}</span></div>`).join('')}</div>
      ${!running && r?.found ? `
        <div class="tx-facts">
          <div>Status<b>${esc(r.status)}</b></div>
          <div>Port<b>${r.port ? `<a href="http://${esc(host)}:${r.port}" target="_blank" rel="noopener">${r.port} ↗</a>` : '–'}</b></div>
          <div>HTTP<b>${r.http ? (r.http.error ? esc(r.http.error) : `${r.http.status} · ${r.http.ms} ms`) : '–'}</b></div>
          <div>Restarts<b>${r.restarts}</b></div>
        </div>
        ${r.logs.err.length ? `<div class="tx-loghead down">${ic('alert')} Errors since the apply</div><pre class="out short tx-err">${esc(r.logs.err.join('\n'))}</pre>` : ''}
        ${r.logs.out.length ? `<details${r.logs.err.length ? '' : ' open'}><summary class="muted">App output since the apply</summary><pre class="out short">${esc(r.logs.out.join('\n'))}</pre></details>` : ''}` : ''}
      <details${running ? ' open' : ''} class="mt"><summary class="muted">Command output</summary>
        <div id="job-${esc(a.jobId)}"><pre class="out short">${esc(output)}</pre></div></details>`;
    const pre = document.querySelector(`#job-${a.jobId} pre`);
    if (pre) pre.scrollTop = pre.scrollHeight;
    $('txApplyFoot').innerHTML = running ? '<span class="muted"><span class="spin"></span> Working… you can leave this tab, it keeps going.</span>'
      : `${record.status !== 'live' && record.backupFile ? `<button type="button" class="b-red" onclick="txRollback(${js(record.id)})">${ic('undo')}Roll back</button>` : ''}
         ${r?.port ? `<button type="button" class="b-grey" onclick="window.open('http://${esc(host)}:${r.port}', '_blank')">${ic('maximize')}Open app</button>` : ''}
         <button type="button" class="b-grey" onclick="showTab('logs')">${ic('logs')}Logs</button>
         <button type="button" class="b-primary" onclick="txDone()">${ic('check')}Done</button>`;
  }

  function txResultBanner(rec) {
    if (rec.status === 'live') return `<div class="notice info tx-ok">${ic('check')}<span><b>Live ✓</b> ${esc(rec.summary || '')}</span></div>`;
    if (rec.status === 'unhealthy') return `<div class="notice warn">${ic('alert')}<span><b>Deployed, but something is wrong:</b> ${esc(rec.summary || '')}</span></div>`;
    return `<div class="notice crit">${ic('alert')}<span><b>Failed.</b> ${esc(rec.summary || '')}</span></div>`;
  }

  function txDone() {
    tx.apply = null;
    clearInterval(tx.pollTimer);
    txLoadStaging().then(txRenderApply);
  }

  async function txRollback(id) {
    const p = txProj();
    if (!p) return;
    if (!await askConfirm(`Put ${p.name} back exactly as it was before this apply, and restart it?\n\nFiles uploaded since then are removed (node_modules and .git are kept).`,
      { ok: 'Roll back', danger: true, title: 'Roll back' })) return;
    try {
      const r = await api('/transfer/rollback', { method: 'POST', body: { project: p.name, id } });
      toast(r.message + ' — see Activity', 'ok');
      tx.apply = null;
      $('txApplyBody').innerHTML = `<p><span class="spin"></span> Rolling back ${esc(p.name)}…</p><div id="job-${esc(r.jobId)}"><pre class="out short"></pre></div>`;
      $('txApplyFoot').innerHTML = '';
      const job = await waitForJob(r.jobId).catch(() => null);
      const h = await api('/transfer/health?project=' + encodeURIComponent(p.name)).then((x) => x.health).catch(() => null);
      $('txApplyBody').innerHTML = (job?.status === 'success'
        ? `<div class="notice ${h?.ok ? 'info' : 'warn'}">${ic(h?.ok ? 'check' : 'alert')}<span><b>Rolled back.</b> ${esc(h?.summary || '')}</span></div>`
        : `<div class="notice crit">${ic('alert')}<span><b>Rollback failed.</b> See the output below.</span></div>`)
        + `<pre class="out short">${esc(job?.output || '')}</pre>`;
      $('txApplyFoot').innerHTML = `<button type="button" class="b-primary" onclick="txDone()">${ic('check')}Done</button>`;
      txLoadProjects();
      txLoadHistory();
      txBrowse(tx.dir);
    } catch (err) { toast(err.message, 'err'); }
  }

  // ── history ───────────────────────────────
  function txStatusPill(s) {
    const m = { live: ['p-green', 'Live'], unhealthy: ['p-orange', 'Unhealthy'], failed: ['p-red', 'Failed'], running: ['p-blue', 'Running'] }[s] || ['p-grey', s];
    return `<span class="pill ${m[0]}">${m[1]}</span>`;
  }

  async function txLoadHistory() {
    const p = txProj();
    $('txHistoryCard').hidden = !p;
    if (!p) return;
    try {
      const { history } = await api('/transfer/history?project=' + encodeURIComponent(p.name));
      $('txHistory').innerHTML = history.map((h) => `<tr>
        <td>${txStatusPill(h.status)}</td>
        <td><b>${timeAgo(h.at)}</b><div class="muted small">${new Date(h.at).toLocaleString()}</div></td>
        <td class="muted">${h.changedCount} file(s) · ${esc({ auto: 'automatic', restart: 'restart only', full: 'full redeploy' }[h.mode] || h.mode)}</td>
        <td class="tx-sum">${esc(h.summary || '')}${h.rolledBackAt ? ` <span class="pill p-grey">rolled back ${timeAgo(h.rolledBackAt)}</span>` : ''}</td>
        <td class="tx-acts">
          <button type="button" class="b-ghost" onclick="txHistoryDetails(${js(h.id)})" title="Details">${ic('eye')}</button>
          ${h.backupFile && h.status !== 'running' ? `<button type="button" class="b-ghost" onclick="txRollback(${js(h.id)})" title="Roll back to before this apply">${ic('undo')}</button>` : ''}</td></tr>`).join('')
        || '<tr><td class="muted" colspan="5">No applies yet. Upload files above, then Apply.</td></tr>';
    } catch (err) { toast(err.message, 'err'); }
  }

  async function txHistoryDetails(id) {
    try {
      const { record: h } = await api('/transfer/history/' + id);
      openModal(`Apply · ${new Date(h.at).toLocaleString()}`, `${h.status === 'running' ? '' : txResultBanner(h)}
        <p class="muted small">Plan: ${esc(h.why || '')} · backup: <code>${esc(h.backupFile || '–')}</code></p>
        ${h.changed?.length ? `<details><summary class="muted">${h.changedCount} file(s)</summary><div class="tx-files">${h.changed.map((f) => `<code>${esc(f)}</code>`).join(' ')}</div></details>` : ''}
        ${h.result?.logs?.err?.length ? `<div class="tx-loghead down">${ic('alert')} Errors</div><pre class="out short tx-err">${esc(h.result.logs.err.join('\n'))}</pre>` : ''}
        <details><summary class="muted">Command output</summary><pre class="out short">${esc(h.output || '')}</pre></details>`);
    } catch (err) { toast(err.message, 'err'); }
  }

  function timeAgo(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }
