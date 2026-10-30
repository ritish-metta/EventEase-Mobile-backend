  // ═════════════════════════════════════════════════════════════
  // Code editor: Monaco (the editor inside VS Code) + explorer,
  // quick open, find in files, git status, diff, commit & push.
  // ═════════════════════════════════════════════════════════════
  const MONACO = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min';
  let monacoLoading = null;
  let editor = null;
  let codeRoot = '';
  const openFiles = new Map(); // full path -> { model, savedVersion, viewState }
  let activeFile = null;
  let fileListCache = null; // { root, files } for quick open / tree filter
  let gitStatus = new Map(); // full path -> 'M' | 'U' | 'D' | 'A'
  let gitDirs = new Set(); // folders containing changes
  const prefs = Object.assign({ fontSize: 13, wordWrap: 'off', minimap: true }, JSON.parse(localStorage.getItem('opsEditorPrefs') || '{}'));
  const savePrefs = () => localStorage.setItem('opsEditorPrefs', JSON.stringify(prefs));

  // Loaded only when the Code tab is first opened (it's ~3 MB).
  function loadMonaco() {
    if (monacoLoading) return monacoLoading;
    monacoLoading = new Promise((resolve, reject) => {
      // Monaco's web workers must come from our origin; this proxy imports them from the CDN.
      window.MonacoEnvironment = {
        getWorkerUrl: () => `data:text/javascript;charset=utf-8,${encodeURIComponent(
          `self.MonacoEnvironment = { baseUrl: '${MONACO}/' }; importScripts('${MONACO}/vs/base/worker/workerMain.js');`)}`,
      };
      const s = document.createElement('script');
      s.src = `${MONACO}/vs/loader.js`;
      s.onload = () => {
        window.require.config({ paths: { vs: `${MONACO}/vs` } });
        window.require(['vs/editor/editor.main'], () => resolve(window.monaco));
      };
      s.onerror = () => reject(new Error('Could not load the code editor (no internet on this browser?)'));
      document.head.appendChild(s);
    });
    return monacoLoading;
  }

  const editorTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'opsedge' : 'opsedge-light');

  function defineTheme() {
    monaco.editor.defineTheme('opsedge-light', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '9aa0a8', fontStyle: 'italic' },
        { token: 'keyword', foreground: '7c3aed' },
        { token: 'string', foreground: '15803d' },
        { token: 'number', foreground: 'c2410c' },
        { token: 'type', foreground: '0e7490' },
        { token: 'key', foreground: '0e7490' },
        { token: 'string.key.json', foreground: '0e7490' },
        { token: 'string.value.json', foreground: '15803d' },
        { token: 'tag', foreground: 'be185d' },
        { token: 'attribute.name', foreground: 'b45309' },
      ],
      colors: {
        'editor.background': '#ffffff',
        'editor.lineHighlightBackground': '#f5f6f8',
        'editor.lineHighlightBorder': '#00000000',
        'editorLineNumber.foreground': '#c4c7cc',
        'editorLineNumber.activeForeground': '#121316',
        'editor.selectionBackground': '#a9b3f655',
        'editorCursor.foreground': '#121316',
        'editorIndentGuide.background1': '#eef0f2',
        'editorGutter.background': '#ffffff',
        'minimap.background': '#ffffff',
        'editorStickyScroll.background': '#fafafa',
        'editorWidget.background': '#ffffff',
        'editorWidget.border': '#dfe0e3',
        'focusBorder': '#a9b3f6',
      },
    });
    monaco.editor.defineTheme('opsedge', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '5b616b', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'c792ea' },
        { token: 'string', foreground: 'b5f23d' },
        { token: 'number', foreground: 'fbbf24' },
        { token: 'regexp', foreground: 'ff8fab' },
        { token: 'type', foreground: '5cd3ff' },
        { token: 'delimiter', foreground: '8a919b' },
        { token: 'key', foreground: '5cd3ff' },
        { token: 'string.key.json', foreground: '5cd3ff' },
        { token: 'string.value.json', foreground: 'b5f23d' },
        { token: 'tag', foreground: 'ff8fab' },
        { token: 'attribute.name', foreground: 'fbbf24' },
        { token: 'attribute.value', foreground: 'b5f23d' },
      ],
      colors: {
        'editor.background': '#0c0e11',
        'editor.foreground': '#e3e6ea',
        'editorLineNumber.foreground': '#3a3f47',
        'editorLineNumber.activeForeground': '#b5f23d',
        'editor.lineHighlightBackground': '#14171b',
        'editor.lineHighlightBorder': '#00000000',
        'editor.selectionBackground': '#b5f23d33',
        'editor.inactiveSelectionBackground': '#b5f23d1a',
        'editor.findMatchHighlightBackground': '#fbbf2433',
        'editorCursor.foreground': '#b5f23d',
        'editorIndentGuide.background1': '#1c2026',
        'editorIndentGuide.activeBackground1': '#3a3f47',
        'editorWidget.background': '#13161a',
        'editorWidget.border': '#2a2f36',
        'editorSuggestWidget.background': '#13161a',
        'editorSuggestWidget.border': '#2a2f36',
        'editorSuggestWidget.selectedBackground': '#20242a',
        'editorHoverWidget.background': '#13161a',
        'editorHoverWidget.border': '#2a2f36',
        'editorBracketMatch.background': '#b5f23d22',
        'editorBracketMatch.border': '#b5f23d66',
        'editorGutter.background': '#0c0e11',
        'editorStickyScroll.background': '#0f1114',
        'minimap.background': '#0c0e11',
        'scrollbarSlider.background': '#ffffff14',
        'scrollbarSlider.hoverBackground': '#ffffff22',
        'scrollbarSlider.activeBackground': '#ffffff2e',
        'diffEditor.insertedTextBackground': '#b5f23d22',
        'diffEditor.removedTextBackground': '#ff5f5f22',
        'quickInput.background': '#13161a',
        'list.activeSelectionBackground': '#20242a',
        'list.hoverBackground': '#1a1e23',
        'focusBorder': '#b5f23d55',
      },
    });
  }

  const currentCodeProject = () => projects.find((p) => p.cwd === codeRoot);
  const relPath = (full) => (full.startsWith(codeRoot + '/') ? full.slice(codeRoot.length + 1) : full);
  const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);

  // ── init ──────────────────────────────────
  let pendingCodeProject = null;

  async function initCode() {
    if (editor) { editor.layout(); return; }
    if (!projects.length) {
      try { projects = (await api('/projects')).projects; } catch { /* filled later */ }
    }
    try {
      await loadMonaco();
    } catch (err) {
      $('codeTree').innerHTML = `<p class="down pad">${esc(err.message)}</p>`;
      return;
    }
    defineTheme();
    editor = monaco.editor.create($('codeEditor'), {
      theme: editorTheme(),
      model: null,
      automaticLayout: true,
      fontFamily: '"JetBrains Mono", Consolas, monospace',
      fontLigatures: true,
      fontSize: prefs.fontSize,
      lineHeight: Math.round(prefs.fontSize * 1.65),
      wordWrap: prefs.wordWrap,
      minimap: { enabled: prefs.minimap, renderCharacters: false, maxColumn: 90 },
      padding: { top: 12, bottom: 12 },
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: 'active', indentation: true },
      stickyScroll: { enabled: true },
      renderWhitespace: 'selection',
      scrollBeyondLastLine: false,
      tabSize: 2,
      formatOnPaste: false,
      linkedEditing: true,
      mouseWheelZoom: true,
    });

    const K = monaco.KeyMod, C = monaco.KeyCode;
    editor.addCommand(K.CtrlCmd | C.KeyS, saveActiveCode);
    editor.addCommand(K.CtrlCmd | K.Alt | C.KeyS, saveAllCode);
    editor.addCommand(K.CtrlCmd | C.KeyP, quickOpen);
    editor.addCommand(K.CtrlCmd | K.Shift | C.KeyF, openFindInFiles);
    editor.addCommand(K.Alt | C.KeyZ, () => toggleEditorOpt('wordWrap'));
    editor.addCommand(K.Alt | C.KeyW, () => activeFile && closeCode(activeFile));
    editor.addCommand(K.CtrlCmd | C.Backquote, () => toggleIdeTerminal());
    editor.addCommand(K.CtrlCmd | C.KeyB, toggleSide);
    editor.addCommand(K.CtrlCmd | K.Shift | C.Enter, () => toggleFocus());

    editor.onDidChangeCursorSelection(updateStatusBar);
    monaco.editor.onDidChangeMarkers(updateStatusBar);
    updateStatusToggles();

    const sel = $('codeProject');
    const ordered = projects.filter((p) => !p.isAgent).concat(projects.filter((p) => p.isAgent));
    sel.innerHTML = ordered.map((p) => `<option value="${esc(p.cwd)}">${esc(p.name)}</option>`).join('')
      + '<option value="~">Home folder</option>';
    const remembered = localStorage.getItem('opsCodeRoot');
    if (pendingCodeProject) sel.value = projects.find((p) => p.name === pendingCodeProject)?.cwd || sel.value;
    else if (remembered && [...sel.options].some((o) => o.value === remembered)) sel.value = remembered;
    pendingCodeProject = null;
    setCodeRoot(sel.value);
  }

  function openInCode(name) {
    const proj = projects.find((p) => p.name === name);
    if (editor && proj) {
      $('codeProject').value = proj.cwd;
      setCodeRoot(proj.cwd);
    } else pendingCodeProject = name;
    showTab('code');
  }

  async function setCodeRoot(root) {
    if (root === '~') root = (await api('/files?path=')).path;
    if (codeRoot && codeRoot !== root && [...openFiles.values()].some(isDirty)) {
      if (!confirm('You have unsaved files. Switch project anyway? (unsaved changes are lost)')) {
        $('codeProject').value = codeRoot;
        return;
      }
    }
    for (const f of openFiles.values()) f.model.dispose();
    openFiles.clear();
    activeFile = null;
    editor.setModel(null);

    codeRoot = root;
    if (!$('ideTermPanel').hidden && !termSessions.some((t) => t.cwd === root)) ideTermNew(root); // new tab for the new project
    localStorage.setItem('opsCodeRoot', $('codeProject').value);
    fileListCache = null;
    $('treeFilter').value = '';
    $('codeRootName').textContent = baseName(root) || root;
    renderCodeTabs();
    refreshTree();
    loadGitStatus();

    // reopen the files that were open last time in this project
    const session = JSON.parse(localStorage.getItem('opsCode:' + root) || 'null');
    if (session?.files?.length) {
      for (const f of session.files) await openCode(f, null, { quiet: true, noFocus: true });
      if (session.active && openFiles.has(session.active)) openCode(session.active);
    }
    updateEmpty();
  }

  function saveSession() {
    localStorage.setItem('opsCode:' + codeRoot, JSON.stringify({ files: [...openFiles.keys()], active: activeFile }));
  }

  // ── explorer tree ─────────────────────────
  function refreshTree() {
    fileListCache = null;
    if ($('treeFilter').value.trim()) return filterTree();
    $('codeTree').innerHTML = '';
    renderTreeLevel(codeRoot, $('codeTree'), 0);
  }

  function collapseTree() {
    $('treeFilter').value = '';
    refreshTree();
  }

  function treeNode(full, name, type, depth) {
    const node = document.createElement('div');
    node.className = 'node';
    node.style.paddingLeft = 10 + depth * 14 + 'px';
    node.dataset.path = full;
    node.dataset.type = type;
    node.title = full;
    const mark = gitStatus.get(full);
    if (type === 'dir' && gitDirs.has(full)) node.classList.add('modified');
    if (mark) node.classList.add(mark === 'U' || mark === 'A' ? 'untracked' : 'modified');
    node.innerHTML = (type === 'dir' ? ic('chevron-right', 'chev') : '<span style="width:14px;flex:none"></span>')
      + fileIcon(name, type) + `<span class="label">${esc(name)}</span>`
      + (mark ? `<span class="gitmark">${mark === 'U' ? 'U' : mark}</span>` : '');
    node.addEventListener('contextmenu', (e) => { e.preventDefault(); treeContext(e, full, type); });
    return node;
  }

  async function renderTreeLevel(dir, container, depth) {
    let r;
    try {
      r = await api('/files?path=' + encodeURIComponent(dir));
    } catch (err) {
      container.innerHTML = `<div class="node down" style="padding-left:12px">${esc(err.message)}</div>`;
      return;
    }
    container.innerHTML = '';
    for (const e of r.entries.filter((x) => x.name !== '.git')) {
      const full = joinPath(r.path, e.name);
      const node = treeNode(full, e.name, e.type, depth);
      if (e.type === 'dir') {
        const children = document.createElement('div');
        children.className = 'children';
        children.hidden = true;
        children.innerHTML = `<span class="guide" style="left:${17 + depth * 14}px"></span>`;
        let loaded = false;
        node.onclick = () => {
          children.hidden = !children.hidden;
          node.classList.toggle('open', !children.hidden);
          if (!loaded) {
            loaded = true;
            const inner = document.createElement('div');
            children.appendChild(inner);
            renderTreeLevel(full, inner, depth + 1);
          }
        };
        container.append(node, children);
      } else {
        node.onclick = () => openCode(full);
        container.append(node);
      }
    }
    if (!r.entries.length && depth === 0) container.innerHTML = '<p class="muted pad">Empty folder</p>';
    markActiveNode();
  }

  function markActiveNode() {
    document.querySelectorAll('#codeTree .node').forEach((n) => n.classList.toggle('active', n.dataset.path === activeFile));
  }

  async function getFileList() {
    if (fileListCache?.root === codeRoot) return fileListCache.files;
    const r = await api('/files/tree?root=' + encodeURIComponent(codeRoot));
    fileListCache = { root: codeRoot, files: r.files };
    return r.files;
  }

  let filterTimer = null;
  function filterTree() {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(async () => {
      const q = $('treeFilter').value.trim();
      if (!q) { refreshTree(); return; }
      const files = await getFileList().catch((err) => { toast(err.message, 'err'); return []; });
      const hits = fuzzyRank(q, files).slice(0, 200);
      const tree = $('codeTree');
      tree.innerHTML = '';
      for (const h of hits) {
        const full = joinPath(codeRoot, h.item);
        const node = treeNode(full, baseName(h.item), 'file', 0);
        node.querySelector('.label').innerHTML = highlight(h.item, h.idx);
        node.onclick = () => openCode(full);
        tree.append(node);
      }
      if (!hits.length) tree.innerHTML = '<p class="muted pad">No files match</p>';
      markActiveNode();
    }, 120);
  }

  // ── fuzzy matching (quick open + tree filter) ──
  function fuzzy(query, text) {
    const q = query.toLowerCase().replace(/\s+/g, '');
    const t = text.toLowerCase();
    const base = t.lastIndexOf('/') + 1;
    let qi = 0, score = 0, last = -2;
    const idx = [];
    for (let i = 0; i < t.length && qi < q.length; i++) {
      if (t[i] !== q[qi]) continue;
      idx.push(i);
      score += 1;
      if (i === last + 1) score += 5; // consecutive letters
      if (i >= base) score += 2; // inside the file name
      if (i === base || '/-_. '.includes(t[i - 1])) score += 4; // start of a word
      last = i;
      qi++;
    }
    if (qi < q.length) return null;
    return { score: score - t.length * 0.03, idx };
  }

  function fuzzyRank(query, items) {
    return items.map((item) => ({ item, ...fuzzy(query, item) })).filter((x) => x.idx).sort((a, b) => b.score - a.score);
  }

  function highlight(text, idx) {
    const set = new Set(idx);
    return [...text].map((ch, i) => (set.has(i) ? `<mark>${esc(ch)}</mark>` : esc(ch))).join('');
  }

  // ── context menu ──────────────────────────
  const ctxEl = document.createElement('div');
  ctxEl.className = 'ctx';
  document.body.appendChild(ctxEl);
  document.addEventListener('click', () => ctxEl.classList.remove('show'));
  document.addEventListener('scroll', () => ctxEl.classList.remove('show'), true);

  function showCtx(e, items) {
    ctxEl.innerHTML = '';
    for (const it of items) {
      if (it === '-') { ctxEl.appendChild(document.createElement('hr')); continue; }
      const b = document.createElement('button');
      b.type = 'button';
      if (it.danger) b.className = 'danger';
      b.innerHTML = ic(it.icon) + `<span>${esc(it.label)}</span>`;
      b.onclick = () => { ctxEl.classList.remove('show'); it.run(); };
      ctxEl.appendChild(b);
    }
    ctxEl.classList.add('show');
    const { innerWidth: W, innerHeight: H } = window;
    const r = ctxEl.getBoundingClientRect();
    ctxEl.style.left = Math.min(e.clientX, W - r.width - 8) + 'px';
    ctxEl.style.top = Math.min(e.clientY, H - r.height - 8) + 'px';
  }

  function treeContext(e, full, type) {
    const dir = type === 'dir' ? full : parentOf(full);
    showCtx(e, [
      ...(type === 'file' ? [{ icon: 'file', label: 'Open', run: () => openCode(full) }] : []),
      { icon: 'file-plus', label: 'New file here', run: () => treeNew('file', dir) },
      { icon: 'folder-plus', label: 'New folder here', run: () => treeNew('folder', dir) },
      '-',
      { icon: 'copy', label: 'Copy', run: () => copyItem(full) },
      ...(clipboardPath ? [{ icon: 'paste', label: `Paste "${baseName(clipboardPath)}" here`, run: () => pasteInto(dir, afterTreeChange) }] : []),
      { icon: 'layers', label: 'Duplicate', run: () => duplicateItem(full) },
      { icon: 'edit', label: 'Rename…', run: () => treeRename(full) },
      '-',
      { icon: 'map', label: 'Copy path', run: () => copyPath(full) },
      { icon: 'map', label: 'Copy relative path', run: () => copyPath(relPath(full)) },
      type === 'file'
        ? { icon: 'download', label: 'Download', run: () => downloadFile(full) }
        : { icon: 'download', label: 'Download folder (.tar.gz)', run: () => downloadFolder(full) },
      ...(type === 'dir' ? [{ icon: 'upload', label: 'Upload a folder here…', run: () => pickFolderInto(full) }] : []),
      { icon: 'terminal', label: 'Open in terminal', run: () => openIdeTerminalAt(dir) },
      { icon: 'folder', label: 'Show in Files', run: () => { browse(dir); showTab('files'); } },
      '-',
      { icon: 'trash', label: 'Delete', danger: true, run: () => treeDelete(full, type) },
    ]);
  }

  $('codeTree').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.node')) return;
    e.preventDefault();
    showCtx(e, [
      { icon: 'file-plus', label: 'New file', run: () => treeNew('file') },
      { icon: 'folder-plus', label: 'New folder', run: () => treeNew('folder') },
      ...(clipboardPath ? [{ icon: 'paste', label: `Paste "${baseName(clipboardPath)}"`, run: () => pasteInto(codeRoot, afterTreeChange) }] : []),
      { icon: 'upload', label: 'Upload a folder…', run: () => pickFolderInto(codeRoot) },
      { icon: 'download', label: 'Download project', run: downloadProject },
      { icon: 'refresh', label: 'Refresh', run: refreshTree },
    ]);
  });

  const afterTreeChange = () => { refreshTree(); loadGitStatus(); };

  async function duplicateItem(full) {
    try {
      const r = await api('/files/copy', { method: 'POST', body: { from: full, to: full } });
      toast(r.message, 'ok');
      afterTreeChange();
    } catch (err) { toast(err.message, 'err'); }
  }

  // folder picker that uploads into a specific folder of the tree
  function pickFolderInto(dir) {
    const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true });
    input.webkitdirectory = true;
    input.onchange = () => {
      const items = [...input.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }))
        .filter((it) => !it.path.split('/').some((p) => SKIP_UPLOAD.has(p)));
      uploadMany(items, dir, afterTreeChange);
    };
    input.click();
  }

  const downloadProject = () => codeRoot && downloadFolder(codeRoot);

  // ── drag & drop files / whole folders onto the explorer (onto a folder = into it) ──
  let dropNode = null;
  const setDropNode = (n) => {
    dropNode?.classList.remove('drop');
    dropNode = n;
    dropNode?.classList.add('drop');
  };
  $('ideSide').addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    const node = e.target.closest('.node[data-type="dir"]');
    setDropNode(node);
    $('codeTree').classList.toggle('drop', !node);
  });
  $('ideSide').addEventListener('dragleave', (e) => {
    if ($('ideSide').contains(e.relatedTarget)) return;
    setDropNode(null);
    $('codeTree').classList.remove('drop');
  });
  $('ideSide').addEventListener('drop', async (e) => {
    e.preventDefault();
    const target = dropNode?.dataset.path || codeRoot;
    setDropNode(null);
    $('codeTree').classList.remove('drop');
    if (!codeRoot) return;
    uploadMany(await collectDropped(e.dataTransfer), target, afterTreeChange);
  });

  // ── terminal inside the editor: tabs, each opened in a folder ──
  const termSessions = []; // { id, term, fit, socket, cwd, el, alive }
  let activeTermId = null;
  let termSeq = 0;
  const activeSession = () => termSessions.find((t) => t.id === activeTermId);

  function toggleIdeTerminal(show) {
    const panel = $('ideTermPanel');
    const open = show ?? panel.hidden;
    panel.hidden = !open;
    if (open) {
      if (!termSessions.length) ideTermNew();
      else setTimeout(() => { fitSession(activeSession()); activeSession()?.term.focus(); }, 30);
    }
    setTimeout(() => editor?.layout(), 40);
  }

  function fitSession(s) {
    if (!s || $('ideTermPanel').hidden || s.el.hidden) return;
    try {
      s.fit.fit();
      s.socket?.emit('resize', { cols: s.term.cols, rows: s.term.rows });
    } catch { /* not visible yet */ }
  }

  // New terminal tab (opened in the project folder unless another folder is given).
  function ideTermNew(cwd = codeRoot) {
    if (!cwd) return;
    $('ideTermPanel').hidden = false;
    const el = document.createElement('div');
    el.className = 'term-pane';
    $('ideTerm').appendChild(el);
    const term = new Terminal({
      cursorBlink: true, fontSize: Math.max(10, prefs.fontSize - 0.5), lineHeight: 1.25, fontFamily: '"JetBrains Mono", Consolas, monospace',
      scrollback: 5000,
      theme: { background: '#0f1114', foreground: '#d7dbe0', cursor: '#a9b3f6', selectionBackground: 'rgba(169,179,246,.3)',
        green: '#9bd62a', blue: '#7dd3fc', magenta: '#c4b5fd', yellow: '#fbbf24', red: '#ff6b6b' },
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const s = { id: ++termSeq, term, fit, socket: null, cwd, el, alive: true };
    termSessions.push(s);
    switchSession(s.id);

    s.socket = io('/terminal', { auth: { token: token() }, query: { cols: term.cols, rows: term.rows, cwd }, reconnection: false });
    term.onData((d) => s.socket.emit('input', d));
    s.socket.on('output', (d) => term.write(d));
    s.socket.on('exit', () => {
      s.alive = false;
      term.write('\r\n\x1b[33m[session ended: close this tab or open a new one with +]\x1b[0m\r\n');
      renderTermTabs();
    });
    s.socket.on('disconnect', () => { s.alive = false; renderTermTabs(); });
    s.socket.on('connect_error', (err) => term.write(`\r\n\x1b[31m${err.message}\x1b[0m\r\n`));
    s.socket.on('connect', () => { fitSession(s); if (s.id === activeTermId) term.focus(); });
    setTimeout(() => editor?.layout(), 40);
    return s;
  }

  function switchSession(id) {
    activeTermId = id;
    for (const t of termSessions) t.el.hidden = t.id !== id;
    const s = activeSession();
    $('ideTermCwd').textContent = s ? s.cwd.replace(/^\/home\/[^/]+/, '~') : '';
    renderTermTabs();
    setTimeout(() => { fitSession(s); s?.term.focus(); }, 20);
  }

  function closeSession(id) {
    const i = termSessions.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [s] = termSessions.splice(i, 1);
    s.socket?.disconnect();
    s.term.dispose();
    s.el.remove();
    if (!termSessions.length) {
      activeTermId = null;
      renderTermTabs();
      toggleIdeTerminal(false);
      return;
    }
    if (activeTermId === id) switchSession(termSessions[Math.min(i, termSessions.length - 1)].id);
    else renderTermTabs();
  }

  function renderTermTabs() {
    $('termTabs').innerHTML = termSessions.map((t, i) =>
      `<span class="term-tab ${t.id === activeTermId ? 'active' : ''}" data-id="${t.id}" title="${esc(t.cwd)}">
        <span class="dot ${t.alive ? '' : 'off'}"></span>${i + 1}·${esc(baseName(t.cwd) || '~')}
        <span class="tx" data-close="1" title="Close">${ic('x')}</span></span>`).join('');
  }

  $('termTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.term-tab');
    if (!tab) return;
    if (e.target.closest('[data-close]')) closeSession(Number(tab.dataset.id));
    else switchSession(Number(tab.dataset.id));
  });

  // keep the visible terminal sized to its panel
  new ResizeObserver(() => fitSession(activeSession())).observe($('ideTerm'));

  function openIdeTerminalAt(dir) {
    toggleIdeTerminal(true);
    const existing = termSessions.find((t) => t.cwd === dir && t.alive);
    if (existing) switchSession(existing.id);
    else ideTermNew(dir);
  }

  // Types a command into the active project terminal and runs it.
  function ideRun(command) {
    toggleIdeTerminal(true);
    let s = activeSession();
    if (!s || !s.alive) s = ideTermNew();
    if (!s) return;
    const send = () => { s.socket.emit('input', command + '\r'); s.term.focus(); };
    if (s.socket?.connected) send();
    else s.socket?.once('connect', () => setTimeout(send, 400));
  }

  function ideRestartApp() {
    const proj = currentCodeProject();
    if (!proj) return toast('This folder is not a PM2 project', 'err');
    ideRun(`pm2 ${proj.mode === 'cluster' ? 'reload' : 'restart'} ${proj.name} && pm2 save`);
  }

  function ideDeploy() {
    const proj = currentCodeProject();
    if (!proj) return toast('This folder is not a PM2 project', 'err');
    projAct(proj.name, 'deploy');
  }

  const ideTermClear = () => activeSession()?.term.clear();

  // ▲ / ▼ buttons: change the terminal size in steps (height at the bottom, width on the right)
  function ideTermSize(step) {
    const panel = $('ideTermPanel');
    panel.classList.remove('min', 'max');
    if (prefs.termPos === 'right') prefs.termW = Math.min(1200, Math.max(300, (prefs.termW || 560) + step * 100));
    else prefs.termH = Math.min(900, Math.max(120, (prefs.termH || 280) + step * 80));
    savePrefs();
    applyLayout();
  }

  // minimize: collapse to the header bar; sessions keep running
  function ideTermMin() {
    const panel = $('ideTermPanel');
    panel.classList.remove('max');
    panel.classList.toggle('min');
    setTimeout(() => { editor?.layout(); fitSession(activeSession()); }, 40);
  }

  function ideTermMax() {
    $('ideTermPanel').classList.remove('min');
    $('ideTermPanel').classList.toggle('max');
    setTimeout(() => { fitSession(activeSession()); editor?.layout(); }, 40);
  }

  // ── workspace layout: explorer / terminal sizes, terminal position, focus mode ──
  function applyLayout() {
    const ide = $('ide');
    ide.style.setProperty('--side-w', (prefs.sideW || 280) + 'px');
    ide.style.setProperty('--term-h', (prefs.termH || 280) + 'px');
    ide.style.setProperty('--term-w', (prefs.termW || 560) + 'px');
    ide.classList.toggle('no-side', Boolean(prefs.sideHidden));
    const right = prefs.termPos === 'right';
    ide.classList.toggle('term-right', right);
    const panel = $('ideTermPanel');
    if (right && panel.parentElement !== ide.querySelector('.ide-body')) ide.querySelector('.ide-body').appendChild(panel);
    if (!right && panel.parentElement !== ide.querySelector('.ide-main')) ide.querySelector('.ide-main').insertBefore(panel, $('statusBar'));
    setTimeout(() => { editor?.layout(); fitSession(activeSession()); }, 40);
  }

  function toggleSide() {
    prefs.sideHidden = !prefs.sideHidden;
    savePrefs();
    applyLayout();
  }

  function toggleTermPos() {
    prefs.termPos = prefs.termPos === 'right' ? 'bottom' : 'right';
    savePrefs();
    applyLayout();
    toast(`Terminal moved to the ${prefs.termPos === 'right' ? 'right side' : 'bottom'}`, 'ok');
  }

  // Drag handle: explorer width, terminal height (or width when it's on the right).
  function makeSplitter(handle, onMove) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('drag');
      const vertical = getComputedStyle(handle).cursor === 'col-resize';
      document.body.classList.add('resizing', vertical ? 'col' : 'row');
      const move = (ev) => { onMove(ev); applyLayout(); };
      const up = () => {
        handle.releasePointerCapture(e.pointerId);
        handle.classList.remove('drag');
        document.body.classList.remove('resizing', 'col', 'row');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        savePrefs();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  makeSplitter($('splitSide'), (ev) => {
    const left = $('ide').querySelector('.ide-body').getBoundingClientRect().left;
    prefs.sideW = Math.round(Math.min(560, Math.max(180, ev.clientX - left)));
  });
  makeSplitter($('splitTerm'), (ev) => {
    const body = $('ide').querySelector('.ide-body').getBoundingClientRect();
    if (prefs.termPos === 'right') prefs.termW = Math.round(Math.min(body.width - 320, Math.max(300, body.right - ev.clientX)));
    else {
      const main = $('ide').querySelector('.ide-main').getBoundingClientRect();
      prefs.termH = Math.round(Math.min(main.height - 140, Math.max(120, main.bottom - 30 - ev.clientY)));
    }
  });

  // Focus mode: hide the panel's menus, use the whole (fullscreen) browser for code + terminal.
  function toggleFocus(on) {
    const enable = on ?? !document.body.classList.contains('ide-focus');
    document.body.classList.toggle('ide-focus', enable);
    $('focusBtn').querySelector('span').textContent = enable ? 'Exit focus' : 'Focus';
    if (enable && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    if (!enable && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    setTimeout(() => { editor?.layout(); fitSession(activeSession()); }, 80);
  }
  // Esc leaves browser fullscreen → leave focus mode with it
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && document.body.classList.contains('ide-focus')) toggleFocus(false);
  });

  applyLayout();


  async function treeNew(kind, dir = codeRoot) {
    const name = prompt(kind === 'file' ? `New file in ${relPath(dir) || baseName(dir)}/ (you can type sub/folder/name.js)` : 'New folder name:');
    if (!name) return;
    const target = joinPath(dir, name.replace(/^\/+/, ''));
    try {
      if (kind === 'file') {
        await api('/files', { method: 'PUT', body: { path: target, content: '' } });
        refreshTree();
        openCode(target);
      } else {
        await api('/files/mkdir', { method: 'POST', body: { path: target } });
        refreshTree();
      }
      toast(`Created ${name}`, 'ok');
      loadGitStatus();
    } catch (err) { toast(err.message, 'err'); }
  }

  async function treeRename(full) {
    const name = prompt('New name:', baseName(full));
    if (!name || name === baseName(full)) return;
    const target = joinPath(parentOf(full), name);
    const wasOpen = openFiles.has(full);
    if (wasOpen && isDirty(openFiles.get(full)) && !confirm('The file has unsaved changes, which are lost when renaming. Continue?')) return;
    try {
      await api('/files/rename', { method: 'POST', body: { from: full, to: target } });
      if (wasOpen) { openFiles.get(full).savedVersion = -1; forceClose(full); openCode(target); }
      refreshTree();
      loadGitStatus();
    } catch (err) { toast(err.message, 'err'); }
  }

  async function treeDelete(full, type) {
    if (!confirm(`Delete ${relPath(full)}${type === 'dir' ? ' and everything inside it' : ''}?\nThis cannot be undone.`)) return;
    try {
      await api('/files?path=' + encodeURIComponent(full), { method: 'DELETE' });
      for (const p of [...openFiles.keys()]) if (p === full || p.startsWith(full + '/')) forceClose(p);
      refreshTree();
      loadGitStatus();
      toast('Deleted ' + baseName(full), 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  function codeTerminalAt(dir) {
    showTab('terminal');
    const send = () => termSocket.emit('input', `cd '${dir.replace(/'/g, `'\\''`)}'\r`);
    if (termSocket?.connected) send();
    else termSocket?.once('connect', () => setTimeout(send, 300));
  }

  // ── tabs & opening files ──────────────────
  function languageFor(filePath) {
    const name = baseName(filePath).toLowerCase();
    if (name === '.env' || name.startsWith('.env.')) return 'ini';
    if (name === 'dockerfile') return 'dockerfile';
    if (name === '.gitignore' || name.endsWith('.log')) return 'plaintext';
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    return monaco.languages.getLanguages().find((l) => l.extensions?.includes(ext))?.id || 'plaintext';
  }

  async function openCode(filePath, line, { quiet = false, noFocus = false } = {}) {
    if (!openFiles.has(filePath)) {
      let r;
      try {
        r = await api('/files?path=' + encodeURIComponent(filePath));
      } catch (err) {
        if (!quiet) toast(err.message, 'err');
        return;
      }
      if (r.type !== 'file') return;
      const model = monaco.editor.createModel(r.content, languageFor(filePath));
      openFiles.set(filePath, { model, savedVersion: model.getAlternativeVersionId(), viewState: null });
      model.onDidChangeContent(() => { renderCodeTabs(); updateStatusBar(); });
    }
    if (noFocus) { renderCodeTabs(); saveSession(); return; }
    if (activeFile && openFiles.has(activeFile)) openFiles.get(activeFile).viewState = editor.saveViewState();
    activeFile = filePath;
    const f = openFiles.get(filePath);
    editor.setModel(f.model);
    if (f.viewState) editor.restoreViewState(f.viewState);
    if (line) {
      editor.revealLineInCenter(line);
      editor.setSelection(new monaco.Selection(line, 1, line, f.model.getLineMaxColumn(line)));
    }
    editor.focus();
    renderCodeTabs();
    markActiveNode();
    updateCrumbs();
    updateStatusBar();
    updateEmpty();
    saveSession();
  }

  const isDirty = (f) => f.model.getAlternativeVersionId() !== f.savedVersion;

  function renderCodeTabs() {
    $('codeTabs').innerHTML = [...openFiles.entries()].map(([p, f]) =>
      `<div class="code-tab ${p === activeFile ? 'active' : ''}" data-path="${esc(p)}" title="${esc(relPath(p))}">
        ${fileIcon(baseName(p))}<span>${esc(baseName(p))}</span>
        <span class="x" data-close="1" title="Close (Alt+W)">${isDirty(f) ? '<span class="dirty"></span>' : ''}${ic('x')}</span></div>`).join('');
    const dirty = [...openFiles.values()].filter(isDirty).length;
    document.title = (dirty ? `● ` : '') + 'Code · OpsEdge';
  }

  $('codeTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.code-tab');
    if (!tab) return;
    if (e.target.closest('[data-close]')) closeCode(tab.dataset.path);
    else openCode(tab.dataset.path);
  });
  $('codeTabs').addEventListener('auxclick', (e) => {
    const tab = e.target.closest('.code-tab');
    if (tab && e.button === 1) { e.preventDefault(); closeCode(tab.dataset.path); }
  });
  $('codeTabs').addEventListener('contextmenu', (e) => {
    const tab = e.target.closest('.code-tab');
    if (!tab) return;
    e.preventDefault();
    const p = tab.dataset.path;
    showCtx(e, [
      { icon: 'x', label: 'Close', run: () => closeCode(p) },
      { icon: 'x', label: 'Close others', run: () => [...openFiles.keys()].filter((k) => k !== p).forEach(closeCode) },
      { icon: 'x', label: 'Close all', run: () => [...openFiles.keys()].forEach(closeCode) },
      '-',
      { icon: 'copy', label: 'Copy path', run: () => copyPath(p) },
      { icon: 'git', label: 'Compare with last commit', run: () => currentCodeProject() && openChanges(relPath(p)) },
    ]);
  });

  function forceClose(filePath) {
    const f = openFiles.get(filePath);
    if (!f) return;
    f.model.dispose();
    openFiles.delete(filePath);
    if (activeFile === filePath) {
      activeFile = null;
      const next = [...openFiles.keys()].at(-1);
      if (next) openCode(next); else editor.setModel(null);
    }
    renderCodeTabs();
    markActiveNode();
    updateCrumbs();
    updateEmpty();
    saveSession();
  }

  function closeCode(filePath) {
    const f = openFiles.get(filePath);
    if (f && isDirty(f) && !confirm(`${baseName(filePath)} has unsaved changes. Close anyway?`)) return;
    forceClose(filePath);
  }

  function updateEmpty() {
    $('editorEmpty').hidden = Boolean(activeFile);
    if (!activeFile) { $('codeCrumbs').innerHTML = ''; updateStatusBar(); }
  }

  function updateCrumbs() {
    if (!activeFile) { $('codeCrumbs').innerHTML = ''; return; }
    const parts = relPath(activeFile).split('/');
    $('codeCrumbs').innerHTML = `<span>${esc(baseName(codeRoot))}</span>` + parts.map((p, i) =>
      `${ic('chevron-right')}${i === parts.length - 1 ? `${fileIcon(p)}<b>${esc(p)}</b>` : `<span>${esc(p)}</span>`}`).join('');
  }

  // ── status bar ────────────────────────────
  function updateStatusBar() {
    const model = editor?.getModel();
    if (!model) {
      $('sbCursor').textContent = '';
      $('sbLang').textContent = '';
      $('sbProblems').innerHTML = '';
      return;
    }
    const pos = editor.getPosition();
    const sel = editor.getSelection();
    const selected = sel && !sel.isEmpty() ? ` (${model.getValueInRange(sel).length} selected)` : '';
    $('sbCursor').textContent = pos ? `Ln ${pos.lineNumber}, Col ${pos.column}${selected}` : '';
    const lang = model.getLanguageId();
    $('sbLang').textContent = monaco.languages.getLanguages().find((l) => l.id === lang)?.aliases?.[0] || lang;
    const markers = monaco.editor.getModelMarkers({ resource: model.uri });
    const errors = markers.filter((m) => m.severity === monaco.MarkerSeverity.Error).length;
    const warnings = markers.filter((m) => m.severity === monaco.MarkerSeverity.Warning).length;
    $('sbProblems').innerHTML = errors || warnings
      ? `<span class="${errors ? 'down' : 'warn'}">${ic('alert')} ${errors} error(s), ${warnings} warning(s)</span>` : '';
  }

  function updateStatusToggles() {
    $('sbWrap').classList.toggle('on', prefs.wordWrap === 'on');
    $('sbMinimap').classList.toggle('on', prefs.minimap);
  }

  function toggleEditorOpt(opt) {
    if (opt === 'wordWrap') prefs.wordWrap = prefs.wordWrap === 'on' ? 'off' : 'on';
    if (opt === 'minimap') prefs.minimap = !prefs.minimap;
    savePrefs();
    editor?.updateOptions({ wordWrap: prefs.wordWrap, minimap: { enabled: prefs.minimap, renderCharacters: false, maxColumn: 90 } });
    updateStatusToggles();
  }

  function zoomEditor(step) {
    prefs.fontSize = Math.min(24, Math.max(10, prefs.fontSize + step));
    savePrefs();
    editor?.updateOptions({ fontSize: prefs.fontSize, lineHeight: Math.round(prefs.fontSize * 1.65) });
    for (const t of termSessions) { t.term.options.fontSize = Math.max(10, prefs.fontSize - 0.5); }
    fitSession(activeSession());
  }

  function formatCode() {
    const action = editor?.getAction('editor.action.formatDocument');
    if (!action || !editor.getModel()) return;
    action.run().catch(() => toast('No formatter for this file type', 'err'));
  }

  // ── save ──────────────────────────────────
  async function saveCode(filePath) {
    const f = openFiles.get(filePath);
    const version = f.model.getAlternativeVersionId();
    await api('/files', { method: 'PUT', body: { path: filePath, content: f.model.getValue() } });
    f.savedVersion = version;
    renderCodeTabs();
  }

  async function saveActiveCode() {
    if (!activeFile) return;
    try {
      await saveCode(activeFile);
      toast('Saved ' + baseName(activeFile), 'ok');
      loadGitStatus();
    } catch (err) { toast(err.message, 'err'); }
  }

  async function saveAllCode() {
    const dirty = [...openFiles.entries()].filter(([, f]) => isDirty(f)).map(([p]) => p);
    try {
      for (const p of dirty) await saveCode(p);
      if (dirty.length) { toast(`Saved ${dirty.length} file(s)`, 'ok'); loadGitStatus(); }
      return true;
    } catch (err) { toast(err.message, 'err'); return false; }
  }

  async function saveAndRestart() {
    const proj = currentCodeProject();
    if (!proj) return toast('Pick a project (not the home folder) to restart', 'err');
    if (!(await saveAllCode())) return;
    act(`/projects/${encodeURIComponent(proj.name)}/${proj.mode === 'cluster' ? 'reload' : 'restart'}`)
      .then((r) => r && setTimeout(loadProjects, 2500));
  }

  window.addEventListener('beforeunload', (e) => {
    if ([...openFiles.values()].some(isDirty)) e.preventDefault();
  });

  // ── git status (tree colours, change counter, branch) ──
  async function loadGitStatus() {
    const proj = currentCodeProject();
    gitStatus = new Map();
    gitDirs = new Set();
    if (!proj) {
      $('changeCount').hidden = true;
      $('sbBranch').innerHTML = `${ic('folder')}<b>${esc(baseName(codeRoot))}</b>`;
      return;
    }
    try {
      const g = await api(`/projects/${encodeURIComponent(proj.name)}/git`);
      for (const line of g.changedFiles) {
        const code = line.slice(0, 2).trim();
        const file = line.slice(3).split(' -> ').pop().replace(/^"|"$/g, '').replace(/\/$/, '');
        const full = joinPath(codeRoot, file);
        gitStatus.set(full, code === '??' ? 'U' : code[0]);
        for (let d = parentOf(full); d.length > codeRoot.length; d = parentOf(d)) gitDirs.add(d);
      }
      $('changeCount').textContent = g.changedFiles.length;
      $('changeCount').hidden = !g.changedFiles.length;
      $('sbBranch').innerHTML = `${ic('git')}<b>${esc(g.branch)}</b>`
        + (g.behind ? ` <span class="warn">↓${g.behind}</span>` : '') + (g.ahead ? ` <span class="warn">↑${g.ahead}</span>` : '');
      document.querySelectorAll('#codeTree .node').forEach((n) => {
        const mark = gitStatus.get(n.dataset.path);
        n.classList.toggle('modified', (mark && mark !== 'U' && mark !== 'A') || (n.dataset.type === 'dir' && gitDirs.has(n.dataset.path)));
        n.classList.toggle('untracked', mark === 'U' || mark === 'A');
        n.querySelector('.gitmark')?.remove();
        if (mark) n.insertAdjacentHTML('beforeend', `<span class="gitmark">${mark}</span>`);
      });
    } catch {
      $('changeCount').hidden = true;
    }
  }

  // ── palette: quick open (Ctrl+P) & find in files (Ctrl+Shift+F) ──
  const pal = document.createElement('div');
  pal.className = 'palette';
  pal.innerHTML = `<div class="palette-box">
      <div class="input-ic">${ic('search')}<input id="palInput" autocomplete="off" spellcheck="false"></div>
      <div class="palette-opts" id="palOpts">
        <label><input type="checkbox" id="palCase"> Match case</label>
        <label><input type="checkbox" id="palWord"> Whole word</label>
        <label><input type="checkbox" id="palRegex"> Regex</label>
      </div>
      <div class="palette-list" id="palList"></div></div>`;
  document.body.appendChild(pal);
  pal.addEventListener('mousedown', (e) => { if (e.target === pal) closePalette(); });

  let palMode = 'files';
  let palItems = [];
  let palSel = 0;
  let grepTimer = null;

  function openPalette(mode) {
    if (!codeRoot) return;
    palMode = mode;
    $('palOpts').hidden = mode !== 'grep';
    $('palInput').placeholder = mode === 'files' ? 'Type a file name… (fuzzy, e.g. "rtauth" finds routes/auth.js)' : 'Search text in all files…';
    $('palInput').value = mode === 'grep' ? (editor?.getModel()?.getValueInRange(editor.getSelection()) || '').split('\n')[0] : '';
    pal.classList.add('show');
    $('palInput').focus();
    $('palInput').select();
    palUpdate();
  }

  function closePalette() {
    pal.classList.remove('show');
    editor?.focus();
  }

  const quickOpen = () => openPalette('files');
  const openFindInFiles = () => openPalette('grep');

  $('palInput').addEventListener('input', () => { palSel = 0; palUpdate(); });
  ['palCase', 'palWord', 'palRegex'].forEach((id) => $(id).addEventListener('change', palUpdate));
  $('palInput').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePalette();
    if (e.key === 'ArrowDown') { palSel = Math.min(palSel + 1, palItems.length - 1); palRender(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { palSel = Math.max(palSel - 1, 0); palRender(); e.preventDefault(); }
    if (e.key === 'Enter') { palPick(palSel); e.preventDefault(); }
  });

  async function palUpdate() {
    const q = $('palInput').value;
    if (palMode === 'files') {
      const files = await getFileList().catch((err) => { $('palList').innerHTML = `<div class="pl-empty">${esc(err.message)}</div>`; return null; });
      if (!files) return;
      const recent = [...openFiles.keys()].map(relPath).reverse();
      palItems = q.trim()
        ? fuzzyRank(q, files).slice(0, 60).map((h) => ({ file: h.item, idx: h.idx }))
        : [...new Set([...recent, ...files])].slice(0, 60).map((f) => ({ file: f, idx: [] }));
      palRender();
      return;
    }
    clearTimeout(grepTimer);
    if (!q.trim()) { palItems = []; $('palList').innerHTML = '<div class="pl-empty">Type to search inside every file of the project</div>'; return; }
    $('palList').innerHTML = '<div class="pl-empty">Searching…</div>';
    grepTimer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          root: codeRoot, q,
          case: $('palCase').checked ? '1' : '0', word: $('palWord').checked ? '1' : '0', regex: $('palRegex').checked ? '1' : '0',
        });
        const r = await api('/files/grep?' + params);
        if ($('palInput').value !== q) return; // a newer search is running
        palItems = r.matches;
        palRender(r.truncated);
      } catch (err) { $('palList').innerHTML = `<div class="pl-empty down">${esc(err.message)}</div>`; }
    }, 280);
  }

  function markText(text, q) {
    if (!q || $('palRegex').checked) return esc(text);
    const flags = $('palCase').checked ? 'g' : 'gi';
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    let out = '', last = 0, m;
    while ((m = re.exec(text)) && m[0]) {
      out += esc(text.slice(last, m.index)) + `<mark>${esc(m[0])}</mark>`;
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }

  function palRender(truncated) {
    const list = $('palList');
    if (!palItems.length) { list.innerHTML = '<div class="pl-empty">No results</div>'; return; }
    if (palMode === 'files') {
      list.innerHTML = palItems.map((it, i) => {
        const name = baseName(it.file);
        const offset = it.file.length - name.length;
        return `<div class="pl-item ${i === palSel ? 'sel' : ''}" data-i="${i}">${fileIcon(name)}
          <span>${highlight(name, it.idx.filter((x) => x >= offset).map((x) => x - offset))}</span>
          <span class="path">${esc(parentOf('/' + it.file).slice(1))}</span></div>`;
      }).join('');
    } else {
      const q = $('palInput').value;
      let html = '', lastFile = null;
      palItems.forEach((m, i) => {
        if (m.file !== lastFile) {
          lastFile = m.file;
          html += `<div class="pl-group">${fileIcon(baseName(m.file))}<b>${esc(baseName(m.file))}</b><span class="muted">${esc(m.file)}</span></div>`;
        }
        html += `<div class="pl-line ${i === palSel ? 'sel' : ''}" data-i="${i}"><span class="ln">${m.line}</span><span class="txt">${markText(m.text.trim(), q)}</span></div>`;
      });
      list.innerHTML = html + (truncated ? '<div class="pl-empty">Showing the first 500 matches</div>' : '');
    }
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }

  $('palList').addEventListener('click', (e) => {
    const el = e.target.closest('[data-i]');
    if (el) palPick(Number(el.dataset.i));
  });

  function palPick(i) {
    const it = palItems[i];
    if (!it) return;
    pal.classList.remove('show');
    openCode(joinPath(codeRoot, it.file), it.line);
  }

  // global shortcuts while the Code tab is open (even when the editor isn't focused)
  document.addEventListener('keydown', (e) => {
    if (activeTab !== 'code' || !editor) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); quickOpen(); }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); openFindInFiles(); }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveActiveCode(); }
    if (mod && e.key === '`') { e.preventDefault(); toggleIdeTerminal(); }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSide(); }
    if (mod && e.shiftKey && e.key === 'Enter') { e.preventDefault(); toggleFocus(); }
  });

  // ── changes / diff / commit ──────────────
  let diffEditor = null;

  async function openChanges(focusFile) {
    const proj = currentCodeProject();
    if (!proj) return toast('Pick a project (not the home folder) to see git changes', 'err');
    await saveAllCode();
    openModal(`Changes in ${proj.name}`, '<p class="muted">Checking…</p>');
    try {
      const g = await api(`/projects/${encodeURIComponent(proj.name)}/git`);
      const files = g.changedFiles.map((line) => ({
        status: line.slice(0, 2).trim(),
        file: line.slice(3).split(' -> ').pop().replace(/^"|"$/g, ''),
      }));
      const label = { M: 'modified', A: 'added', D: 'deleted', '??': 'new', R: 'renamed' };
      const n = js(proj.name);
      $('modalBody').innerHTML = `
        <p class="row">${ic('git')} <b>${esc(g.branch)}</b>
          ${g.behind ? `<span class="pill p-orange">${g.behind} newer on GitHub</span>` : ''}
          ${g.ahead ? `<span class="pill p-orange">${g.ahead} not pushed</span>` : ''}</p>
        ${files.length ? `<div class="table-wrap"><table><tbody>${files.map((f) => `<tr>
            <td><span class="pill ${f.status === '??' || f.status === 'A' ? 'p-green' : f.status === 'D' ? 'p-red' : 'p-orange'}">${label[f.status] || esc(f.status)}</span></td>
            <td class="mono">${fileIcon(baseName(f.file))} ${esc(f.file)}</td>
            <td style="text-align:right;white-space:nowrap">
              ${f.status !== 'D' && !f.file.endsWith('/') ? `<button type="button" class="b-ghost" onclick="showDiff(${n}, ${js(f.file)})">${ic('diff')}Diff</button>
                <button type="button" class="b-ghost" onclick="closeModal(); openCode(${js(joinPath(proj.cwd, f.file))})">${ic('code')}Open</button>` : ''}
              ${f.status !== '??' ? `<button type="button" class="b-ghost" onclick="discardFile(${n}, ${js(f.file)})">${ic('undo')}Discard</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
          <div id="diffBox" style="height:0;margin-top:12px;border-radius:14px;overflow:hidden"></div>
          <h3>Commit &amp; push to GitHub</h3>
          <div class="row"><div class="input-ic grow">${ic('git')}<input id="commitMsg" placeholder="What did you change?" onkeydown="if(event.key==='Enter')commitChanges(${n})"></div>
            <button type="button" class="b-lime" onclick="commitChanges(${n})">${ic('upload')}Commit &amp; push</button></div>
          <p class="muted small">Pushing to <b>${esc(g.branch)}</b> starts the CI/CD pipeline, which deploys it the normal way.</p>`
        : `<p class="up">${ic('check')} No changes: the server matches the last commit.</p>
           ${g.ahead ? `<button type="button" class="b-lime" onclick="commitChanges(${n}, true)">${ic('upload')}Push ${g.ahead} waiting commit(s)</button>` : ''}`}`;
      if (typeof focusFile === 'string' && files.some((f) => f.file === focusFile)) showDiff(proj.name, focusFile);
    } catch (err) { $('modalBody').innerHTML = `<p class="down">${esc(err.message)}</p>`; }
  }

  async function showDiff(name, file) {
    const proj = projects.find((p) => p.name === name);
    try {
      const [orig, cur] = await Promise.all([
        api(`/projects/${encodeURIComponent(name)}/original?file=${encodeURIComponent(file)}`),
        api('/files?path=' + encodeURIComponent(joinPath(proj.cwd, file))),
      ]);
      const box = $('diffBox');
      box.style.height = '52vh';
      diffEditor?.dispose();
      diffEditor = monaco.editor.createDiffEditor(box, {
        theme: editorTheme(), readOnly: true, automaticLayout: true, renderSideBySide: box.clientWidth > 700,
        fontFamily: '"JetBrains Mono", Consolas, monospace', fontSize: 12.5, minimap: { enabled: false },
      });
      const lang = languageFor(file);
      diffEditor.setModel({ original: monaco.editor.createModel(orig.content, lang), modified: monaco.editor.createModel(cur.content, lang) });
      box.scrollIntoView({ behavior: 'smooth' });
    } catch (err) { toast(err.message, 'err'); }
  }

  async function discardFile(name, file) {
    if (!confirm(`Throw away your changes to ${file}? It goes back to the last committed version.`)) return;
    const r = await act(`/projects/${encodeURIComponent(name)}/discard`, { file });
    if (!r) return;
    const full = joinPath(projects.find((p) => p.name === name).cwd, file);
    if (openFiles.has(full)) forceClose(full);
    setTimeout(() => { openChanges(); loadGitStatus(); }, 1500);
  }

  async function commitChanges(name, pushOnly) {
    const message = pushOnly ? 'push' : $('commitMsg').value.trim();
    if (!message) return toast('Write a short commit message first', 'err');
    const r = await act(`/projects/${encodeURIComponent(name)}/commit`, { message });
    if (r) { closeModal(); showTab('activity'); setTimeout(loadGitStatus, 4000); }
  }

