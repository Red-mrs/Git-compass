// Overview webview script
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let state = null;
  let currentRoot = null;
  let draftTimer = null;
  let amend = false;

  const cmd = (command, arg) => vscode.postMessage({ type: 'command', command, arg });

  app.innerHTML = `
    <div id="norepo" class="hidden"></div>
    <div id="repo" class="hidden">
      <div id="repoRow" class="repo-row hidden"></div>
      <section class="card branch-card" id="branchCard"></section>
      <div id="banner"></div>
      <div id="suggestion"></div>
      <section class="card commit-card">
        <div class="commit-head">
          <span class="title">${icon('check')} Commit</span>
          <span class="counts" id="counts"></span>
        </div>
        <textarea id="msg" rows="3" placeholder="Commit message — what did you change? (Ctrl+Enter to commit)"></textarea>
        <div class="msg-hint" id="msgHint"></div>
        <label class="amend"><input type="checkbox" id="amend"> Amend last commit <span class="muted">(change the previous commit instead of making a new one)</span></label>
        <div class="commit-buttons">
          <button id="commitBtn" title="Save a snapshot of the staged changes">${icon('check')} <span id="commitLabel">Commit</span></button>
          <button id="commitSyncBtn" class="secondary" title="Commit, then pull & push">${icon('sync')} Commit &amp; Sync</button>
        </div>
      </section>
      <section class="quick">
        <div class="section-title">Quick actions</div>
        <div class="grid">
          <button class="secondary" data-cmd="gitCompass.createBranch" title="Start a new line of work">${icon('plus')} New branch</button>
          <button class="secondary" data-cmd="gitCompass.switchBranch" title="Switch to another branch">${icon('switch')} Switch branch</button>
          <button class="secondary" data-cmd="gitCompass.merge" title="Bring another branch's commits into this one">${icon('merge')} Merge…</button>
          <button class="secondary" data-cmd="gitCompass.stash" title="Put uncommitted changes aside">${icon('stash')} Stash</button>
          <button class="secondary" data-cmd="gitCompass.openGraph" title="See all branches and commits as a graph">${icon('graph')} Commit graph</button>
          <button class="secondary" data-cmd="gitCompass.undoLastCommit" title="Take back the last commit, keep its changes">${icon('undo')} Undo commit</button>
          <button class="secondary" data-cmd="gitCompass.compareRefs" title="Compare branches or commits">${icon('compare')} Compare…</button>
          <button class="secondary" data-cmd="gitCompass.openGuide" title="Learn Git step by step">${icon('book')} Guide</button>
        </div>
      </section>
      <div class="footer muted" id="footer"></div>
    </div>`;

  const $ = id => document.getElementById(id);
  const msg = $('msg');

  msg.addEventListener('input', () => {
    updateHint();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => vscode.postMessage({ type: 'draft', message: msg.value }), 400);
  });
  msg.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doCommit(false); }
  });
  $('amend').addEventListener('change', e => {
    amend = e.target.checked;
    if (amend && !msg.value.trim()) vscode.postMessage({ type: 'lastMessage' });
    render();
  });
  $('commitBtn').addEventListener('click', () => doCommit(false));
  $('commitSyncBtn').addEventListener('click', () => doCommit(true));
  document.querySelectorAll('[data-cmd]').forEach(b => b.addEventListener('click', () => cmd(b.dataset.cmd)));

  function doCommit(push) {
    if (!state || state.kind !== 'repo') return;
    $('commitBtn').disabled = true;
    $('commitSyncBtn').disabled = true;
    vscode.postMessage({ type: 'commit', message: msg.value, amend, push });
  }

  function updateHint() {
    const first = msg.value.split('\n')[0];
    const n = first.length;
    const hint = $('msgHint');
    if (!n) { hint.textContent = ''; return; }
    if (n > 72) { hint.innerHTML = `<span class="warn">${n} characters in the first line — try to keep the summary under ~50–72. Add details after an empty line.</span>`; }
    else hint.textContent = `${n}/72 · first line = short summary, then an empty line and details if needed`;
  }

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'state') {
      state = m.state;
      if (state.kind === 'repo' && state.root !== currentRoot) {
        currentRoot = state.root;
        msg.value = state.draft || '';
        amend = false;
        $('amend').checked = false;
        updateHint();
      }
      render();
    } else if (m.type === 'commitResult') {
      $('commitBtn').disabled = false;
      $('commitSyncBtn').disabled = false;
      if (m.ok) {
        msg.value = '';
        amend = false;
        $('amend').checked = false;
        updateHint();
        render();
      }
    } else if (m.type === 'lastMessage') {
      if (!msg.value.trim()) { msg.value = m.message; updateHint(); }
    }
  });

  function render() {
    if (!state) return;
    $('norepo').classList.toggle('hidden', state.kind !== 'noRepo');
    $('repo').classList.toggle('hidden', state.kind !== 'repo');
    if (state.kind === 'noRepo') return renderNoRepo();
    const s = state;

    // repo selector
    const repoRow = $('repoRow');
    if (s.repos.length > 1) {
      repoRow.classList.remove('hidden');
      repoRow.innerHTML = `${icon('repo')} <select id="repoSel" title="Repository">${s.repos.map(r => `<option value="${esc(r.root)}" ${r.root === s.root ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>`;
      $('repoSel').addEventListener('change', e => vscode.postMessage({ type: 'selectRepo', root: e.target.value }));
    } else repoRow.classList.add('hidden');

    // branch card
    const branchName = s.detached ? `detached at ${s.head}` : (s.branch || '—');
    let syncLine;
    if (!s.hasRemote) syncLine = `<span class="muted">${icon('info')} Only on this computer (no remote)</span>`;
    else if (!s.upstream) syncLine = `<span class="muted">${icon('cloud')} Not published yet</span>`;
    else {
      const parts = [];
      parts.push(s.ahead ? `<span class="ahead" title="Commits only on your computer">${icon('arrowUp')}${s.ahead} to push</span>` : '');
      parts.push(s.behind ? `<span class="behind" title="Commits on the remote you don't have">${icon('arrowDown')}${s.behind} to pull</span>` : '');
      if (!s.ahead && !s.behind) parts.push(`<span class="insync">${icon('check')} in sync</span>`);
      syncLine = `${parts.filter(Boolean).join(' ')} <span class="muted">with ${esc(s.upstream)}</span>`;
    }
    const syncButtons = !s.hasRemote
      ? `<button data-c="gitCompass.publishToGitHub" title="Create a repository on GitHub and upload">${icon('github')} Publish to GitHub</button>`
      : !s.upstream && !s.detached && !s.initial
        ? `<button data-c="gitCompass.publishBranch" title="Upload this branch to the remote">${icon('cloud')} Publish branch</button>
           <button class="secondary" data-c="gitCompass.fetch" title="Check the remote for new commits (changes nothing locally)">${icon('fetch')} Fetch</button>`
        : `<button data-c="gitCompass.sync" title="Pull then push — get their commits and upload yours">${icon('sync')} Sync</button>
           <button class="secondary" data-c="gitCompass.pull" title="Download new commits and update your files">${icon('down')} Pull</button>
           <button class="secondary" data-c="gitCompass.push" title="Upload your commits">${icon('up')} Push</button>
           <button class="secondary icononly" data-c="gitCompass.fetch" title="Fetch: check the remote for new commits without changing your files">${icon('fetch')}</button>`;
    $('branchCard').innerHTML = `
      <div class="branch-line">
        <span class="branch-name ${s.detached ? 'detached' : ''}" title="Current branch">${icon('branch')} ${esc(branchName)}</span>
        <button class="link" data-c="gitCompass.switchBranch" title="Switch to another branch">switch</button>
      </div>
      <div class="sync-line">${syncLine}</div>
      ${s.lastCommit ? `<div class="last muted" title="Latest commit">${icon('history')} ${esc(s.lastCommit.subject)} · ${esc(relTime(s.lastCommit.date))}</div>` : ''}
      <div class="buttons">${syncButtons}</div>`;

    // operation banner
    const op = s.operation;
    if (op) {
      const labels = { merge: 'Merge in progress', rebase: `Rebase in progress${op.step ? ` (${op.step})` : ''}`, 'cherry-pick': 'Cherry-pick in progress', revert: 'Revert in progress', bisect: 'Bisect in progress' };
      $('banner').innerHTML = `<section class="card banner warn">
        <div><b>${icon('warn')} ${labels[op.kind] || op.kind}</b>${s.conflicts ? ` — <span class="conf">${s.conflicts} conflicted file(s)</span>` : ' — no conflicts left'}</div>
        <div class="buttons">
          <button data-c="gitCompass.continueOperation" ${s.conflicts ? 'disabled title="Resolve all conflicts first"' : 'title="Finish the operation"'}>${icon('play')} Continue</button>
          ${['rebase', 'cherry-pick', 'revert'].includes(op.kind) ? `<button class="secondary" data-c="gitCompass.skipOperation" title="Leave out the current commit">${icon('skip')} Skip</button>` : ''}
          <button class="secondary" data-c="gitCompass.abortOperation" title="Cancel and go back to how things were">${icon('stop')} Abort</button>
        </div></section>`;
    } else $('banner').innerHTML = '';

    // suggestion
    const sg = s.suggestion;
    $('suggestion').innerHTML = sg ? `<div class="suggest ${sg.level}">
        <span class="sicon">${icon(sg.level === 'ok' ? 'check' : sg.level === 'warn' ? 'warn' : 'light')}</span>
        <span>${esc(sg.text)}</span>
        ${sg.action ? `<button class="link" data-c="${esc(sg.action.command)}" data-arg="${esc(sg.action.arg || '')}">${esc(sg.action.label)} →</button>` : ''}
      </div>` : '';

    // commit area
    const changed = s.unstaged + s.untracked;
    const counts = [];
    if (s.staged) counts.push(`<span class="c-staged">${s.staged} staged</span>`);
    if (s.unstaged) counts.push(`<span>${s.unstaged} changed</span>`);
    if (s.untracked) counts.push(`<span>${s.untracked} new</span>`);
    if (s.conflicts) counts.push(`<span class="conf">${s.conflicts} conflicts</span>`);
    $('counts').innerHTML = counts.join(' · ') || '<span class="muted">no changes</span>';
    let label = 'Commit';
    if (amend) label = 'Amend last commit';
    else if (s.staged) label = `Commit ${s.staged} staged file${s.staged > 1 ? 's' : ''}`;
    else if (changed) label = `Commit all ${changed} change${changed > 1 ? 's' : ''}`;
    $('commitLabel').textContent = label;
    const nothing = !amend && !s.staged && !changed && !op;
    $('commitBtn').disabled = nothing || s.conflicts > 0;
    $('commitSyncBtn').disabled = nothing || s.conflicts > 0 || !s.hasRemote;
    $('commitBtn').title = s.conflicts ? 'Resolve conflicts first' : (s.staged ? 'Commit the staged changes' : 'No files are staged — all changes will be committed');
    document.querySelector('.amend').classList.toggle('hidden', !!s.initial);

    $('footer').innerHTML = [
      s.worktreeOf ? `<span title="This folder is a linked worktree: an extra checkout of the repository in ${esc(s.worktreeOf)}. Commits and branches are shared.">${icon('repo')} worktree of ${esc(s.worktreeOf)}</span>` : '',
      s.stashes ? `<span title="Changes you put aside — see the Stashes view">${icon('stash')} ${s.stashes} stash${s.stashes > 1 ? 'es' : ''}</span>` : '',
      s.github ? `<span>${icon('github')} <button class="link" data-c="gitCompass.openRepositoryOnGitHub" title="Open on GitHub">${esc(s.github)}</button></span>` : '',
    ].filter(Boolean).join(' · ');

    bindDynamic();
  }

  function renderNoRepo() {
    const s = state;
    let html;
    if (s.gitMissing) {
      html = `<section class="card"><b>${icon('warn')} Git is not installed</b>
        <p>Git Compass needs the <code>git</code> program. Install it from <a href="https://git-scm.com/downloads">git-scm.com/downloads</a>, then reload VS Code.</p></section>`;
    } else {
      html = `<section class="card welcome">
        <h3>${icon('repo')} No Git repository here yet</h3>
        <p class="muted">${s.hasFolder ? 'This folder is not tracked by Git. Turn it into a repository, or download an existing one.' : 'Open a folder, or download (clone) a repository.'}</p>
        <div class="stack">
          ${s.hasFolder ? `<button data-c="gitCompass.init">${icon('plus')} Initialize repository in this folder</button>` : `<button data-c="workbench.action.files.openFolder">${icon('file')} Open folder…</button>`}
          ${s.hasFolder ? `<button class="secondary" data-c="gitCompass.publishToGitHub" title="Create a new GitHub repository and upload this folder — Git is set up for you">${icon('github')} Publish this folder to GitHub</button>` : ''}
          <button class="secondary" data-c="gitCompass.clone">${icon('fetch')} Clone a repository (e.g. from GitHub)…</button>
          <button class="secondary" data-c="gitCompass.openGuide">${icon('book')} What is Git? Open the guide</button>
        </div></section>`;
    }
    $('norepo').innerHTML = html;
    bindDynamic();
  }

  function bindDynamic() {
    document.querySelectorAll('[data-c]').forEach(b => {
      if (b._bound) return;
      b._bound = true;
      b.addEventListener('click', e => {
        e.preventDefault();
        const arg = b.dataset.arg;
        cmd(b.dataset.c, arg ? arg : undefined);
      });
    });
  }

  vscode.postMessage({ type: 'ready' });
})();
