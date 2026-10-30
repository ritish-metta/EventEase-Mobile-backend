  // ═════════════════════════════════════════════════════════════
  // Deploy from the code editor:
  //   save all → commit → push to GitHub → CI/CD deploys → "Live ✓"
  // plus the one-time "GitHub access" setup the push needs.
  // ═════════════════════════════════════════════════════════════
  let deployWatch = null; // timer of the running "is it live yet?" check

  function setDeployStatus(text, kind = '', action = null) {
    const el = $('deployStatus');
    el.hidden = !text;
    el.className = 'deploy-status ' + kind;
    el.innerHTML = (kind === 'busy' ? '<span class="spin"></span>' : kind === 'ok' ? ic('check') : kind === 'err' ? ic('alert') : '')
      + `<span>${esc(text)}</span>` + (action ? ` <a href="#" onclick="event.preventDefault(); ${action[1]}">${esc(action[0])}</a>` : '');
  }

  async function openEditorDeploy() {
    const proj = currentCodeProject();
    if (!proj) return toast('Pick a project (not the home folder) to deploy', 'err');
    await saveAllCode();
    openModal(`Deploy ${proj.name}`, '<p class="muted">Checking changes…</p>');
    let g, access;
    try {
      [g, access] = await Promise.all([
        api(`/projects/${encodeURIComponent(proj.name)}/git`),
        api(`/projects/${encodeURIComponent(proj.name)}/git-access`),
      ]);
    } catch (err) {
      $('modalBody').innerHTML = `<p class="down">${esc(err.message)}</p>`;
      return;
    }
    const n = js(proj.name);
    const nothing = !g.changedFiles.length && !g.ahead;
    $('modalBody').innerHTML = `
      <div class="deploy-steps">
        <div><b>1</b>Save all files <span class="up">${ic('check')}</span></div>
        <div><b>2</b>Commit ${g.changedFiles.length ? `${g.changedFiles.length} changed file(s)` : ''}${g.ahead ? ` + ${g.ahead} waiting commit(s)` : ''}</div>
        <div><b>3</b>Push to GitHub <span class="muted">(${esc(access.repo || g.remote || '')} · ${esc(g.branch)})</span></div>
        <div><b>4</b>Your CI/CD pipeline deploys it, and this button shows <b>Live ✓</b></div>
      </div>
      ${!access.ssh ? `<div class="notice warn">${ic('key')}<span>This server can't push to GitHub yet. Do the one-time
        <a href="#" onclick="event.preventDefault(); openGitAccess(${n})">GitHub access setup</a> (about 2 minutes).</span></div>` : ''}
      ${nothing ? `<div class="notice info">${ic('info')}<span>No changes since the last commit, so there is nothing new to deploy.</span></div>` : `
        <label class="muted small" for="deployMsg">What did you change?</label>
        <div class="input-ic">${ic('git')}<input id="deployMsg" placeholder="e.g. Fix login redirect" onkeydown="if(event.key==='Enter')runEditorDeploy(${n})"></div>
        <label class="check mt"><input type="checkbox" id="deployRestartNow"> Also restart the app on the server right now (don't wait for the pipeline)</label>
        ${g.behind ? `<div class="notice warn mt">${ic('alert')}<span>GitHub has ${g.behind} newer commit(s) than this server. The push may be rejected: pull first (terminal: <code>git pull</code>).</span></div>` : ''}`}`;
    $('modalFoot').innerHTML = (nothing ? '' : `<button type="button" class="b-gradient ide-deploy" onclick="runEditorDeploy(${n})">${ic('rocket')}<span>Deploy</span></button>`)
      + `<button type="button" class="b-grey" onclick="openGitAccess(${n})">${ic('key')}GitHub access</button>`
      + '<button type="button" class="b-grey" onclick="closeModal()">Close</button>';
    setTimeout(() => $('deployMsg')?.focus(), 50);
  }

  async function runEditorDeploy(name) {
    const message = $('deployMsg').value.trim();
    if (!message) { $('deployMsg').focus(); return toast('Write a short message about what you changed', 'err'); }
    const restartNow = $('deployRestartNow').checked;
    closeModal();
    clearInterval(deployWatch);
    const proj = projects.find((p) => p.name === name);
    const before = Math.max(0, ...(proj?.instances || []).map((i) => i.startedAt || 0));
    $('ideDeployBtn').disabled = true;
    setDeployStatus('Pushing to GitHub…', 'busy');

    let job;
    try {
      const r = await api(`/projects/${encodeURIComponent(name)}/commit`, { method: 'POST', body: { message } });
      job = await waitForJob(r.jobId);
    } catch (err) {
      $('ideDeployBtn').disabled = false;
      return setDeployStatus('Deploy failed: ' + err.message, 'err');
    }
    if (job.status !== 'success') {
      $('ideDeployBtn').disabled = false;
      const noAccess = /Push failed|Permission denied|could not read Username|Authentication failed/i.test(job.output || '');
      return noAccess
        ? setDeployStatus('Push failed: this server has no GitHub write access.', 'err', ['Set it up', `openGitAccess(${js(name)})`])
        : setDeployStatus('Push failed (see Activity).', 'err', ['Open Activity', "showTab('activity')"]);
    }

    loadGitStatus();
    if (restartNow) act(`/projects/${encodeURIComponent(name)}/${proj?.mode === 'cluster' ? 'reload' : 'restart'}`);
    setDeployStatus('Pushed ✓ GitHub is deploying…', 'busy');

    // "Live" = the app was restarted after our push (the pipeline reloads it with PM2)
    const access = await api(`/projects/${encodeURIComponent(name)}/git-access`).catch(() => ({}));
    const giveUpAt = Date.now() + 8 * 60 * 1000;
    deployWatch = setInterval(async () => {
      try {
        const p = (await api('/projects')).projects.find((x) => x.name === name);
        const started = Math.max(0, ...(p?.instances || []).map((i) => i.startedAt || 0));
        // compare server time with server time (the browser clock may differ)
        if (p && p.online && started > before) {
          clearInterval(deployWatch);
          $('ideDeployBtn').disabled = false;
          setDeployStatus(`Live ✓ ${p.git?.commit || ''}`.trim(), 'ok');
          toast(`${name} is live with your changes`, 'ok');
          loadProjects();
        } else if (Date.now() > giveUpAt) {
          clearInterval(deployWatch);
          $('ideDeployBtn').disabled = false;
          setDeployStatus('Pushed, but no restart seen yet. Is deploy switched off, or did the pipeline fail?', 'err',
            access.actionsUrl ? ['Open GitHub Actions', `window.open(${js(access.actionsUrl)}, '_blank')`] : null);
        }
      } catch { /* the panel itself may be restarting during the deploy, so keep waiting */ }
    }, 5000);
  }

  // Wait until a background job (Activity) finishes; returns it with its output.
  async function waitForJob(id) {
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const { job } = await api('/jobs/' + id);
      if (job.status !== 'running') return job;
    }
    throw new Error('Timed out waiting for the push');
  }

  // ── one-time GitHub access setup (deploy key with write access) ──
  async function openGitAccess(name) {
    openModal('GitHub access for deploys', '<p class="muted">Preparing this server\'s key…</p>');
    try {
      const [access, key] = await Promise.all([
        api(`/projects/${encodeURIComponent(name)}/git-access`),
        api('/git/deploy-key', { method: 'POST' }),
      ]);
      const n = js(name);
      $('modalBody').innerHTML = `
        ${access.ssh ? `<div class="notice info">${ic('check')}<span>Already connected: <b>${esc(name)}</b> pushes over SSH. You can test again below.</span></div>` : ''}
        <div class="deploy-steps">
          <div><b>1</b>Copy this server's public key (safe to share, it can only be used together with this server)</div>
        </div>
        <pre class="out short" id="pubKey">${esc(key.publicKey)}</pre>
        <div class="row mt"><button type="button" class="b-grey" onclick="copyPath(document.getElementById('pubKey').textContent)">${ic('copy')}Copy key</button></div>
        <div class="deploy-steps mt">
          <div><b>2</b>Open ${access.deployKeysUrl ? `<a href="${esc(access.deployKeysUrl)}" target="_blank" rel="noopener">GitHub → ${esc(access.repo)} → Deploy keys → Add</a>` : 'your repo on GitHub → Settings → Deploy keys → Add deploy key'}</div>
          <div><b>3</b>Title: <code>${esc(location.hostname)} server</code>, paste the key, and tick <b>Allow write access</b>. Click <b>Add key</b>.</div>
          <div><b>4</b>Come back and click <b>Test &amp; connect</b>. Nothing changes on the server until the test passes.</div>
        </div>
        <div id="gitTestResult"></div>`;
      $('modalFoot').innerHTML = `<button type="button" class="b-lime" onclick="testGitAccess(${n})">${ic('check')}Test &amp; connect</button>`
        + '<button type="button" class="b-grey" onclick="closeModal()">Close</button>';
    } catch (err) { $('modalBody').innerHTML = `<p class="down">${esc(err.message)}</p>`; }
  }

  async function testGitAccess(name) {
    $('gitTestResult').innerHTML = `<div class="notice info"><span class="spin"></span><span>Testing with GitHub…</span></div>`;
    try {
      const r = await api(`/projects/${encodeURIComponent(name)}/git-ssh`, { method: 'POST' });
      $('gitTestResult').innerHTML = `<div class="notice info">${ic('check')}<span>${esc(r.message)}. You can deploy from the editor now.</span></div>`;
      $('modalFoot').innerHTML = `<button type="button" class="b-gradient ide-deploy" onclick="openEditorDeploy()">${ic('rocket')}<span>Continue to Deploy</span></button>`
        + '<button type="button" class="b-grey" onclick="closeModal()">Close</button>';
      setDeployStatus('');
    } catch (err) {
      $('gitTestResult').innerHTML = `<div class="notice crit">${ic('alert')}<span>${esc(err.message)}</span></div>`;
    }
  }
