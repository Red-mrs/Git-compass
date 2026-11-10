// Commit Graph webview script
(function () {
  const vscode = acquireVsCodeApi();
  const LANE = 16; // px per lane
  const H = 28; // row height
  const COLORS = ['#3fb950', '#4c9aff', '#f0883e', '#d2a8ff', '#ff7b72', '#39c5cf', '#e3b341', '#f778ba', '#7ee787', '#a5d6ff'];
  const color = i => COLORS[i % COLORS.length];

  let data = null;
  let selected = null; // sha
  let matches = []; // indices
  let matchPos = -1;
  const saved = vscode.getState() || {};

  const app = document.getElementById('app');
  const compact = app.dataset.mode === 'sidebar'; // compact version shown in the sidebar
  if (compact) document.body.classList.add('compact');
  app.innerHTML = `
    <div class="toolbar">
      <div class="tb-title" id="title"></div>
      <div class="search">
        ${icon('search')}
        <select id="mode" title="What to search">
          <option value="message">Message</option>
          <option value="author">Author</option>
          <option value="sha">Commit ID</option>
          <option value="content" title="Commits that added or removed this text (slower)">Changed text</option>
          <option value="file" title="Commits that touched this file path">File path</option>
        </select>
        <input type="search" id="q" placeholder="${compact ? 'Search…' : 'Search commits… (Enter = next)'}">
        <span class="count muted" id="count"></span>
        <button class="icon" id="prev" title="Previous match">${icon('arrowUp')}</button>
        <button class="icon" id="next" title="Next match">${icon('arrowDown')}</button>
      </div>
      <label class="chk" title="Show commits of all branches, or only the current one"><input type="checkbox" id="all"> ${compact ? 'All' : 'All branches'}</label>
      <button class="icon" id="fetch" title="Fetch from remotes">${icon('fetch')}</button>
      <button class="icon" id="refresh" title="Refresh">${icon('refresh')}</button>
      <button class="icon" id="help" title="How to read this graph">${icon('info')}</button>
      ${compact ? `<button class="icon" id="full" title="Open the big Commit Graph in an editor tab">${icon('graph')}</button>` : ''}
    </div>
    <div class="legend hidden" id="legend">
      <b>How to read the graph:</b> each dot is a commit (newest at the top). Lines connect a commit to its parent; each colour is one line of development (branch).
      A dot where two lines join is a <b>merge</b>. <span class="badge branch current">✓ main</span> = your current branch,
      <span class="badge branch">feature</span> = local branch, <span class="badge remote">${icon('cloud')} origin/main</span> = branch on the server,
      <span class="badge tag">${icon('tag')} v1.0</span> = tag, <span class="up">↑</span> = commit not pushed yet.
      <b>Right-click</b> a commit or a branch label for actions (checkout, merge, cherry-pick, revert, reset…). <b>Double-click</b> a branch label to switch to it.
      <button class="link" id="legendClose">Got it</button>
    </div>
    <div class="main">
      <div class="list" id="list" tabindex="0"></div>
      <div class="details hidden" id="details"></div>
    </div>`;

  const $ = id => document.getElementById(id);
  const list = $('list');
  const details = $('details');

  const post = (type, extra) => vscode.postMessage({ type, ...extra });

  $('mode').value = saved.mode || 'message';
  $('all').addEventListener('change', e => post('toggleAll', { value: e.target.checked }));
  $('refresh').addEventListener('click', () => post('refresh'));
  $('fetch').addEventListener('click', () => post('command', { command: 'gitCompass.fetch' }));
  $('help').addEventListener('click', () => $('legend').classList.toggle('hidden'));
  $('legendClose').addEventListener('click', () => { $('legend').classList.add('hidden'); vscode.setState({ ...vscode.getState(), legendSeen: true }); });
  if (!saved.legendSeen && !compact) $('legend').classList.remove('hidden');
  if (compact) $('full').addEventListener('click', () => post('command', selected && selected !== 'WORKING' ? { command: 'gitCompass.showCommit', arg: { sha: selected } } : { command: 'gitCompass.openGraph' }));

  let searchTimer;
  $('q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 250); });
  $('mode').addEventListener('change', () => { vscode.setState({ ...vscode.getState(), mode: $('mode').value }); runSearch(); });
  $('q').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { $('q').value = ''; runSearch(); }
  });
  $('next').addEventListener('click', () => step(1));
  $('prev').addEventListener('click', () => step(-1));

  function runSearch() {
    const text = $('q').value.trim();
    const mode = $('mode').value;
    if (!text) { setMatches([]); return; }
    if (mode === 'content' || mode === 'file') {
      $('count').textContent = 'searching…';
      post('search', { text, mode });
      return;
    }
    const t = text.toLowerCase();
    const idx = [];
    data.rows.forEach((r, i) => {
      if (r.wip) return;
      const hay = mode === 'author' ? `${r.author} ${r.email}` : mode === 'sha' ? r.sha : `${r.subject} ${r.refs.map(x => x.name).join(' ')}`;
      if (mode === 'sha' ? hay.startsWith(t) : hay.toLowerCase().includes(t)) idx.push(i);
    });
    setMatches(idx);
  }

  function setMatches(idx, notLoaded = 0) {
    matches = idx;
    matchPos = -1;
    list.querySelectorAll('.row').forEach(el => {
      el.classList.remove('match', 'dim');
    });
    const active = $('q').value.trim();
    if (active) {
      const set = new Set(idx);
      list.querySelectorAll('.row').forEach(el => {
        const i = +el.dataset.i;
        el.classList.add(set.has(i) ? 'match' : 'dim');
      });
      $('count').textContent = `${idx.length} found${notLoaded ? ` (+${notLoaded} older, load more)` : ''}`;
      if (idx.length) step(1);
    } else $('count').textContent = '';
  }

  function step(d) {
    if (!matches.length) return;
    matchPos = (matchPos + d + matches.length) % matches.length;
    const r = data.rows[matches[matchPos]];
    select(r.sha, true);
  }

  // ---------------------------------------------------------------------------------------
  function render() {
    const s = data;
    if (compact) $('title').classList.add('hidden');
    $('title').innerHTML = `${icon('repo')} <b>${esc(s.repoName)}</b> <span class="muted">${s.branch ? `on ${icon('branch')} ${esc(s.branch)}` : 'detached HEAD'}</span>`;
    $('all').checked = s.showAll;
    const gw = Math.max(1, s.width) * LANE + 6;
    document.documentElement.style.setProperty('--graph-w', gw + 'px');
    const rows = s.rows.map((r, i) => rowHtml(r, i, gw)).join('');
    list.innerHTML = `
      ${compact ? '' : '<div class="row header"><div></div><div>Message</div><div>Author</div><div>Date</div><div>Commit</div></div>'}
      ${rows}
      ${s.hasMore ? '<div class="more"><button class="secondary" id="more">Load more commits…</button></div>' : ''}
      ${!s.rows.length ? '<div class="empty muted">No commits yet.</div>' : ''}`;
    const more = $('more');
    if (more) more.addEventListener('click', () => { more.disabled = true; more.textContent = 'Loading…'; post('loadMore'); });
    if (selected && !s.rows.some(r => r.sha === selected)) closeDetails();
    if (selected) markSelected();
    if ($('q').value.trim()) runSearch();
  }

  function svg(r, gw) {
    const x = c => c * LANE + LANE / 2 + 2;
    const y = v => v * H / 2;
    let out = '';
    for (const [fc, fy, tc, ty] of r.lines) {
      const col = fc === tc ? fc : (fy === 1 ? tc : fc);
      const x1 = x(fc), y1 = y(fy), x2 = x(tc), y2 = y(ty);
      const d = fc === tc ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
      out += `<path d="${d}" stroke="${color(col)}" ${r.wip && fy === 1 ? 'stroke-dasharray="3 2"' : ''}/>`;
    }
    const cx = x(r.col), cy = H / 2, c = color(r.col);
    if (r.wip) out += `<circle cx="${cx}" cy="${cy}" r="5" class="wipdot" stroke="${c}"/>`;
    else if (r.merge) out += `<circle cx="${cx}" cy="${cy}" r="4.5" class="mergedot" stroke="${c}"/>`;
    else out += `<circle cx="${cx}" cy="${cy}" r="4.5" fill="${c}" class="dot"/>`;
    if (data.head === r.sha) out += `<circle cx="${cx}" cy="${cy}" r="7.5" fill="none" stroke="${c}" stroke-width="1.5" opacity=".7"/>`;
    return `<svg width="${gw}" height="${H}" class="g">${out}</svg>`;
  }

  function ctx(o) { return esc(JSON.stringify({ ...o, root: data.root, preventDefaultContextMenuItems: true })); }

  function badges(r) {
    const refs = r.refs || [];
    const remotes = refs.filter(x => x.type === 'remote');
    const used = new Set();
    let html = '';
    for (const b of refs.filter(x => x.type === 'branch')) {
      const twin = remotes.find(x => x.name.endsWith('/' + b.name));
      if (twin) used.add(twin.name);
      const section = b.current ? 'currentBranch' : 'branch';
      html += `<span class="badge branch ${b.current ? 'current' : ''}" data-ref="${esc(b.name)}" data-type="branch" title="${b.current ? 'Current branch' : 'Local branch — double-click to switch'}${twin ? ` · also on the server as ${esc(twin.name)}` : ' · not on the server'}" data-vscode-context="${ctx({ webviewSection: section, ref: b.name, refType: 'branch', sha: r.sha })}">${b.current ? '✓ ' : ''}${esc(b.name)}${twin ? ` ${icon('cloud')}` : ''}</span>`;
    }
    for (const x of remotes) {
      if (used.has(x.name)) continue;
      html += `<span class="badge remote" data-ref="${esc(x.name)}" data-type="remote" title="Branch on the server — double-click to check it out locally" data-vscode-context="${ctx({ webviewSection: 'remoteBranch', ref: x.name, refType: 'remote', sha: r.sha })}">${icon('cloud')} ${esc(x.name)}</span>`;
    }
    for (const t of refs.filter(x => x.type === 'tag')) {
      html += `<span class="badge tag" title="Tag" data-vscode-context="${ctx({ webviewSection: 'tag', ref: t.name, refType: 'tag', sha: r.sha })}">${icon('tag')} ${esc(t.name)}</span>`;
    }
    if (refs.some(x => x.type === 'head')) html += '<span class="badge head" title="You are here (detached HEAD)">HEAD</span>';
    if (refs.some(x => x.type === 'stash')) html += '<span class="badge stash" title="Latest stash">stash</span>';
    return html;
  }

  function rowHtml(r, i, gw) {
    if (r.wip) {
      const w = data.wip;
      const parts = [];
      if (w.conflicts) parts.push(`${w.conflicts} conflicts`);
      if (w.staged) parts.push(`${w.staged} staged`);
      if (w.changed) parts.push(`${w.changed} changed`);
      return `<div class="row wip" data-i="${i}" data-sha="WORKING" title="Your uncommitted changes — click to open the Changes view" data-vscode-context="${ctx({ webviewSection: 'wip' })}">
        ${svg(r, gw)}<div class="msg"><i>Uncommitted changes</i> <span class="muted">(${parts.join(', ')})</span></div>${compact ? '<div></div>' : '<div></div><div></div><div></div>'}</div>`;
    }
    const msgCell = `<div class="msg">${badges(r)}${r.unpushed ? '<span class="up" title="Not pushed yet — only on your computer">↑</span>' : ''}<span class="subject" title="${esc(r.subject)}">${esc(r.subject)}</span></div>`;
    if (compact) {
      return `<div class="row ${r.sha === data.head ? 'is-head' : ''}" data-i="${i}" data-sha="${r.sha}" title="${esc(r.subject)}\n${esc(r.author)} · ${new Date(r.date).toLocaleString()} · ${r.sha.slice(0, 7)}" data-vscode-context="${ctx({ webviewSection: 'commit', sha: r.sha })}">
        ${svg(r, gw)}${msgCell}<div class="date">${shortAge(r.date)}</div></div>`;
    }
    return `<div class="row ${r.sha === data.head ? 'is-head' : ''}" data-i="${i}" data-sha="${r.sha}" data-vscode-context="${ctx({ webviewSection: 'commit', sha: r.sha })}">
      ${svg(r, gw)}
      ${msgCell}
      <div class="author" title="${esc(r.email)}">${esc(r.author)}</div>
      <div class="date" title="${new Date(r.date).toLocaleString()}">${relTime(r.date)}</div>
      <div class="sha mono">${r.sha.slice(0, 7)}</div>
    </div>`;
  }

  // ---------------------------------------------------------------------------------------
  list.addEventListener('click', e => {
    const row = e.target.closest('.row');
    if (!row || row.classList.contains('header')) return;
    if (row.dataset.sha === 'WORKING') { post('focusChanges'); return; }
    select(row.dataset.sha, false);
  });
  list.addEventListener('dblclick', e => {
    const b = e.target.closest('.badge[data-ref]');
    if (b) post('command', { command: 'gitCompass.checkout', arg: { ref: b.dataset.ref, refType: b.dataset.type } });
  });
  list.addEventListener('keydown', e => {
    if (!data || !data.rows.length) return;
    if (e.key === 'Escape') { closeDetails(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const d = e.key === 'ArrowDown' ? 1 : -1;
    let i = data.rows.findIndex(r => r.sha === selected);
    do { i += d; } while (i >= 0 && i < data.rows.length && data.rows[i].wip);
    if (i >= 0 && i < data.rows.length) select(data.rows[i].sha, true);
  });

  function shortAge(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
    if (s < 86400 * 365) return `${Math.round(s / 86400 / 30)}mo`;
    return `${(s / 86400 / 365).toFixed(1)}y`;
  }

  function select(sha, scroll) {
    if (compact && sha === selected && !details.classList.contains('hidden')) { closeDetails(); return; } // click again = collapse
    selected = sha;
    markSelected(scroll);
    details.classList.remove('hidden');
    details.innerHTML = '<div class="muted pad">Loading…</div>';
    post('details', { sha });
  }

  function markSelected(scroll) {
    list.querySelectorAll('.row.selected').forEach(el => el.classList.remove('selected'));
    const el = list.querySelector(`.row[data-sha="${selected}"]`);
    if (el) {
      el.classList.add('selected');
      if (compact) el.after(details); // details unfold right below the clicked commit
      if (scroll) el.scrollIntoView({ block: 'nearest' });
    }
  }

  function closeDetails() {
    selected = null;
    details.classList.add('hidden');
    markSelected();
  }

  const STATUS = { M: ['M', 'mod', 'Modified'], A: ['A', 'add', 'Added'], D: ['D', 'del', 'Deleted'], R: ['R', 'ren', 'Renamed'], C: ['C', 'add', 'Copied'], T: ['T', 'mod', 'Type changed'] };

  function renderDetails(d) {
    const c = d.commit;
    const bodyRest = (c.body || '').split('\n').slice(1).join('\n').trim();
    const add = d.files.reduce((a, f) => a + (f.added || 0), 0);
    const del = d.files.reduce((a, f) => a + (f.deleted || 0), 0);
    const isHead = c.sha === data.head;
    const act = (cmdName, label, ic, title, cls = 'secondary') => `<button class="${cls}" data-cmd="${cmdName}" title="${esc(title)}">${icon(ic)} ${label}</button>`;
    details.innerHTML = `
      <div class="d-head">
        <h3>${esc(c.subject)}</h3>
        <button class="icon" id="dclose" title="Close (Esc)">${icon('close')}</button>
      </div>
      ${bodyRest ? `<pre class="body">${esc(bodyRest)}</pre>` : ''}
      <div class="meta">${icon('history')} <b>${esc(c.author)}</b> <span class="muted">&lt;${esc(c.email)}&gt;</span> · ${new Date(c.date).toLocaleString()} <span class="muted">(${relTime(c.date)})</span></div>
      <div class="meta">${icon('graph')} <span class="mono">${c.sha}</span> <button class="icon" data-cmd="gitCompass.copySha" title="Copy commit ID">${icon('copy')}</button></div>
      ${c.parents.length ? `<div class="meta">Parent${c.parents.length > 1 ? 's' : ''}: ${c.parents.map(p => `<a href="#" class="mono" data-goto="${p}">${p.slice(0, 7)}</a>`).join(', ')}${c.parents.length > 1 ? ' <span class="muted">(merge commit)</span>' : ''}</div>` : '<div class="meta muted">First commit of the repository</div>'}
      ${d.branches.length ? `<div class="meta">Contained in: ${d.branches.map(b => `<span class="badge ${b.includes('/') && !b.startsWith('(') ? 'remote' : 'branch'}">${esc(b)}</span>`).join(' ')}</div>` : ''}
      <div class="actions">
        ${act('gitCompass.checkoutCommit', 'Checkout', 'switch', 'Look at the project as it was at this commit')}
        ${act('gitCompass.createBranchAt', 'Branch here', 'branch', 'Create a new branch starting at this commit')}
        ${isHead ? '' : act('gitCompass.cherryPick', 'Cherry-pick', 'plus', 'Copy this commit onto your current branch')}
        ${act('gitCompass.revert', 'Revert', 'undo', 'Make a new commit that undoes this one (safe)')}
        ${act('gitCompass.resetTo', 'Reset to here…', 'warn', 'Move your current branch back to this commit')}
        ${act('gitCompass.createTagAt', 'Tag', 'tag', 'Put a tag (e.g. v1.0) on this commit')}
        ${act('gitCompass.interactiveRebase', 'Edit history…', 'edit', 'Reorder, squash, reword or drop commits from here up to now')}
        ${act('gitCompass.compareWithHead', 'Compare with HEAD', 'compare', 'What changed between this commit and now')}
        ${data.github ? act('gitCompass.openCommitOnGitHub', 'GitHub', 'github', 'Open this commit on GitHub') : ''}
      </div>
      <div class="files-title"><b>${d.files.length} file${d.files.length === 1 ? '' : 's'} changed</b> <span class="add">+${add}</span> <span class="del">−${del}</span> <span class="muted">— click a file to see its changes</span></div>
      <ul class="files">
        ${d.files.map((f, i) => {
          const st = STATUS[f.status] || [f.status, 'mod', f.status];
          return `<li data-f="${i}" title="${esc(st[2])}: ${esc(f.path)}${f.origPath ? ` (from ${esc(f.origPath)})` : ''}">
            <span class="st ${st[1]}">${st[0]}</span>
            <span class="fname">${esc(f.path.split('/').pop())}</span>
            <span class="fdir muted">${esc(f.path.split('/').slice(0, -1).join('/'))}${f.origPath ? ` ← ${esc(f.origPath)}` : ''}</span>
            <span class="fstat">${f.added != null ? `<span class="add">+${f.added}</span> <span class="del">−${f.deleted}</span>` : ''}</span>
            ${f.status !== 'D' ? `<button class="icon" data-open="${i}" title="Open the file as it was in this commit">${icon('file')}</button>` : ''}
          </li>`;
        }).join('')}
      </ul>`;
    $('dclose').addEventListener('click', closeDetails);
    details.querySelectorAll('[data-cmd]').forEach(b => b.addEventListener('click', () => post('command', { command: b.dataset.cmd, arg: { sha: c.sha } })));
    details.querySelectorAll('[data-goto]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); if (data.rows.some(r => r.sha === a.dataset.goto)) select(a.dataset.goto, true); }));
    details.querySelectorAll('li[data-f]').forEach(li => li.addEventListener('click', e => {
      const f = d.files[+li.dataset.f];
      if (e.target.closest('[data-open]')) post('openFileAt', { sha: c.sha, path: f.path });
      else post('openFile', { sha: c.sha, parent: c.parents[0], file: f });
    }));
  }

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'data') {
      data = m;
      render();
      if (m.select) select(m.select, true);
    } else if (m.type === 'details') {
      if (m.commit.sha === selected) renderDetails(m);
    } else if (m.type === 'searchResult') {
      if (m.text !== $('q').value.trim()) return;
      const pos = new Map(data.rows.map((r, i) => [r.sha, i]));
      const idx = m.shas.filter(s => pos.has(s)).map(s => pos.get(s));
      setMatches(idx, m.shas.length - idx.length);
    }
  });

  post('ready');
})();
