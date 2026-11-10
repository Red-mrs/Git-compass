// Interactive rebase webview
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let data = null;
  let items = []; // {sha, short, subject, body, author, date, action, message}
  let dragIndex = null;

  const ACTIONS = [
    ['pick', 'Keep', 'Keep the commit as it is'],
    ['reword', 'Reword', 'Keep the changes, change the message'],
    ['edit', 'Edit', 'Stop at this commit so you can change its files'],
    ['squash', 'Squash ↑', 'Merge into the commit above, combine messages'],
    ['fixup', 'Fixup ↑', 'Merge into the commit above, discard this message'],
    ['drop', 'Drop', 'Delete this commit and its changes'],
  ];

  function render() {
    app.innerHTML = `
      <div class="wrap">
        <h2>${icon('edit')} Edit history of <span class="br">${esc(data.branch)}</span></h2>
        <p class="muted">Commits are listed <b>oldest first</b> (that is the order Git replays them). Drag ${icon('drag')} or use the arrows to reorder.
          Choose what happens to each commit, then press <b>Start</b>. If something goes wrong you can always undo it from <b>Undo History</b>.</p>
        ${data.hasMerges ? `<div class="warnbox">${icon('warn')} This range contains merge commits. They will be flattened (the merged commits become a straight line).</div>` : ''}
        ${data.pushed ? `<div class="warnbox">${icon('warn')} Some of these commits are already pushed. After rewriting you will need to Force Push.</div>` : ''}
        <div class="legend">${ACTIONS.map(a => `<span class="act ${a[0]}" title="${esc(a[2])}"><b>${a[1]}</b> — ${esc(a[2])}</span>`).join('')}</div>
        <div class="base muted">${icon('graph')} starts after ${data.base ? `<span class="mono">${data.base}</span>` : 'the beginning of the repository'}</div>
        <ol class="list" id="list">
          ${items.map((it, i) => `
            <li class="item ${it.action}" draggable="true" data-i="${i}">
              <span class="handle" title="Drag to reorder">${icon('drag')}</span>
              <span class="arrows">
                <button class="icon" data-up="${i}" ${i === 0 ? 'disabled' : ''} title="Move up (earlier)">${icon('arrowUp')}</button>
                <button class="icon" data-down="${i}" ${i === items.length - 1 ? 'disabled' : ''} title="Move down (later)">${icon('arrowDown')}</button>
              </span>
              <select data-act="${i}" title="What to do with this commit">
                ${ACTIONS.map(a => `<option value="${a[0]}" ${a[0] === it.action ? 'selected' : ''}>${a[1]}</option>`).join('')}
              </select>
              <span class="mono sha">${it.short}</span>
              <span class="text">
                ${it.action === 'reword'
                  ? `<textarea data-msg="${i}" rows="${Math.min(6, Math.max(2, it.message.split('\n').length))}">${esc(it.message)}</textarea>`
                  : `<span class="subject">${esc(it.subject)}</span>`}
              </span>
              <span class="who muted">${esc(it.author)} · ${relTime(it.date)}</span>
            </li>`).join('')}
        </ol>
        <div class="base muted">${icon('branch')} ${esc(data.branch)} (newest)</div>
        <div class="error" id="err"></div>
        <div class="buttons">
          <button id="start">${icon('play')} Start</button>
          <button class="secondary" id="reset">Reset choices</button>
          <button class="secondary" id="cancel">Cancel</button>
          <button class="link" id="help">What is this? →</button>
        </div>
      </div>`;
    bind();
    validate();
  }

  function validate() {
    const err = document.getElementById('err');
    const kept = items.filter(i => i.action !== 'drop');
    let msg = '';
    if (!kept.length) msg = 'You are dropping every commit. That would remove all of them — keep at least one or use Reset instead.';
    else if (kept[0].action === 'squash' || kept[0].action === 'fixup') msg = 'The first kept commit cannot be squashed/fixed up — there is no commit above it to merge into.';
    err.textContent = msg;
    document.getElementById('start').disabled = !!msg;
  }

  function move(from, to) {
    if (to < 0 || to >= items.length) return;
    const [x] = items.splice(from, 1);
    items.splice(to, 0, x);
    render();
  }

  function bind() {
    document.querySelectorAll('[data-act]').forEach(s => s.addEventListener('change', e => {
      const it = items[+s.dataset.act];
      it.action = e.target.value;
      render();
    }));
    document.querySelectorAll('[data-msg]').forEach(t => t.addEventListener('input', e => { items[+t.dataset.msg].message = e.target.value; }));
    document.querySelectorAll('[data-up]').forEach(b => b.addEventListener('click', () => move(+b.dataset.up, +b.dataset.up - 1)));
    document.querySelectorAll('[data-down]').forEach(b => b.addEventListener('click', () => move(+b.dataset.down, +b.dataset.down + 1)));
    document.querySelectorAll('.item').forEach(li => {
      li.addEventListener('dragstart', e => { dragIndex = +li.dataset.i; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      li.addEventListener('dragover', e => { e.preventDefault(); li.classList.add('over'); });
      li.addEventListener('dragleave', () => li.classList.remove('over'));
      li.addEventListener('drop', e => { e.preventDefault(); li.classList.remove('over'); if (dragIndex !== null) move(dragIndex, +li.dataset.i); dragIndex = null; });
    });
    document.getElementById('start').addEventListener('click', () => {
      vscode.postMessage({ type: 'start', todo: items.map(i => ({ sha: i.sha, action: i.action, message: i.message })) });
    });
    document.getElementById('reset').addEventListener('click', () => { init(); render(); });
    document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    document.getElementById('help').addEventListener('click', () => vscode.postMessage({ type: 'help' }));
  }

  function init() {
    items = data.commits.map(c => ({ ...c, action: 'pick', message: c.body || c.subject }));
  }

  window.addEventListener('message', e => {
    if (e.data.type === 'data') { data = e.data; init(); render(); }
  });
  vscode.postMessage({ type: 'ready' });
})();
