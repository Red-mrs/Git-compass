'use strict';
// Runs the integration scenario (test/integration/index.js) headlessly against the mock `vscode`
// module, plus extra checks of the webview hosts. Run: node test/host.test.js
const Module = require('module');
const path = require('path');
const cp = require('child_process');
const os = require('os');
const assert = require('assert');

const mockPath = path.join(__dirname, 'mock', 'vscode.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return mockPath;
  return origResolve.call(this, request, ...rest);
};
const vscode = require('vscode');
const root = path.join(__dirname, '..');
vscode.__mock.setRoot(root);

const ws = cp.execFileSync(process.execPath, [path.join(__dirname, 'integration', 'prepare.js'), os.tmpdir()], {
  encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws), name: path.basename(ws), index: 0 }];

(async () => {
  try {
    await require('./integration/index.js').run();

    // ---- extra headless checks of the webviews' host side ----
    const { manager, views } = await vscode.extensions.getExtension('radomir-novy.git-compass').activate();
    const m = manager.current;

    const ov = vscode.__mock.overviewView.current;
    assert.ok(ov, 'overview resolved');
    assert.match(ov.webview.html, /Content-Security-Policy/);
    ov.webview._send({ type: 'ready' });
    await new Promise(r => setTimeout(r, 300));
    const st = ov.webview.posted.filter(p => p.type === 'state').pop();
    assert.ok(st && st.state.kind === 'repo' && st.state.branch === 'main', 'overview state posted');
    assert.ok(st.state.suggestion && st.state.suggestion.text, 'overview suggestion');
    console.log('  ✔ overview webview posts repository state');

    const graph = vscode.__mock.panels.find(p => p.viewType === 'gitCompass.graph');
    graph.webview.posted.length = 0;
    graph.webview._send({ type: 'ready' });
    await new Promise(r => setTimeout(r, 500));
    const data = graph.webview.posted.find(p => p.type === 'data');
    assert.ok(data && data.rows.length >= 5, 'graph rows');
    assert.ok(data.rows.some(r => r.merge), 'graph has a merge commit');
    assert.ok(data.rows.every(r => Array.isArray(r.lines)), 'graph lines');
    graph.webview._send({ type: 'details', sha: data.rows[0].sha });
    await new Promise(r => setTimeout(r, 400));
    const det = graph.webview.posted.find(p => p.type === 'details');
    assert.ok(det && det.commit && Array.isArray(det.files), 'graph details');
    graph.webview._send({ type: 'search', mode: 'content', text: 'topic' });
    await new Promise(r => setTimeout(r, 400));
    const sr = graph.webview.posted.find(p => p.type === 'searchResult');
    assert.ok(sr && sr.shas.length >= 1, 'content search found commit');
    console.log('  ✔ commit graph posts rows, details and search results');

    // sidebar graph view (compact) follows the current repository
    await vscode.commands.executeCommand('gitCompass.graphView.focus');
    const gv = vscode.__mock.resolvedViews.get('gitCompass.graphView');
    assert.match(gv.webview.html, /data-mode="sidebar"/);
    gv.webview._send({ type: 'ready' });
    await new Promise(r => setTimeout(r, 500));
    const gdata = gv.webview.posted.find(p => p.type === 'data');
    assert.ok(gdata && gdata.rows.length === data.rows.length && gdata.root === m.root, 'sidebar graph rows');
    gv.webview._send({ type: 'details', sha: gdata.rows.find(r => !r.wip).sha });
    await new Promise(r => setTimeout(r, 400));
    assert.ok(gv.webview.posted.some(p => p.type === 'details'), 'sidebar graph details');
    gv.webview.posted.length = 0;
    require('fs').writeFileSync(path.join(ws, 'graph-refresh.txt'), 'x');
    await m.repo.run(['add', '.']); await m.repo.run(['commit', '-qm', 'sidebar refresh check']);
    await m.refresh();
    await new Promise(r => setTimeout(r, 700));
    const upd = gv.webview.posted.find(p => p.type === 'data');
    assert.ok(upd && upd.rows.some(r => r.subject === 'sidebar refresh check'), 'sidebar graph refreshes after a commit');
    console.log('  ✔ sidebar graph view: compact mode, rows, details, live refresh');

    // interactive rebase through the panel host: reword the newest commit
    require('fs').writeFileSync(path.join(ws, 'rebase-me.txt'), 'x\n');
    await m.repo.run(['add', '.']);
    await m.repo.run(['commit', '-qm', 'to be reworded']);
    await m.refresh();
    const head = await m.repo.revParse('HEAD');
    const before = (await m.repo.log({ maxCount: 3, firstParent: true }));
    await vscode.commands.executeCommand('gitCompass.interactiveRebase', { root: m.root, sha: before[0].sha });
    const rb = vscode.__mock.panels.find(p => p.viewType === 'gitCompass.rebase');
    const payload = rb.webview.posted.find(p => p.type === 'data');
    assert.strictEqual(payload.commits.length, 1);
    rb.webview._send({ type: 'start', todo: [{ sha: payload.commits[0].sha, action: 'reword', message: 'Reworded by test' }] });
    await new Promise(r => setTimeout(r, 1500));
    const [after] = await m.repo.log({ maxCount: 1 });
    assert.strictEqual(after.subject, 'Reworded by test');
    assert.notStrictEqual(after.sha, head);
    console.log('  ✔ interactive rebase panel rewrites history');

    // discard with confirmation answered "Discard Changes"
    require('fs').writeFileSync(path.join(ws, 'README.md'), 'throw me away\n');
    await m.refresh();
    vscode.__mock.answers.push('Discard Changes');
    await vscode.commands.executeCommand('gitCompass.discard', { kind: 'change', model: m, root: m.root, file: { path: 'README.md', status: 'M' } });
    await m.refresh();
    assert.strictEqual(m.state.changeCount, 0);
    console.log('  ✔ discard (with confirmation) restores the file');

    // undo last commit
    vscode.__mock.answers.push('Undo Commit');
    await vscode.commands.executeCommand('gitCompass.undoLastCommit', { root: m.root });
    await m.refresh();
    assert.ok(m.state.staged.length > 0, 'changes back in staging after undo');
    console.log('  ✔ undo last commit puts changes back to staged');

    // ---- worktrees ----
    const fsx = require('fs');
    const wtPath = path.join(path.dirname(ws), path.basename(ws) + '-feature');
    vscode.__mock.answers.push(wtPath);
    const created = await vscode.commands.executeCommand('gitCompass.createWorktree', { root: m.root, ref: 'feature', refType: 'branch' });
    assert.strictEqual(created, wtPath);
    assert.ok(fsx.existsSync(path.join(wtPath, '.git')), 'worktree folder created');
    let wts = await views.worktrees.getChildren();
    const wtNode = wts.find(n => n.worktree && n.worktree.branch === 'feature');
    assert.ok(wtNode, 'worktree listed');
    assert.match(wtNode.item.contextValue, /^worktree;(?!main)/);
    assert.ok(wts.find(n => n.isCurrent).worktree.main, 'current folder is main worktree');
    const br = (await (await views.branches.getChildren())[0].getChildren()).find(n => n.branch && n.branch.name === 'feature');
    assert.match(br.item.description, /in worktree/);
    // switching to that branch here must explain instead of failing
    await vscode.commands.executeCommand('gitCompass.checkout', { root: m.root, ref: 'feature', refType: 'branch' });
    assert.ok(vscode.__mock.log.some(l => l[0] === 'warning' && /already checked out in the worktree/.test(l[1])));
    assert.strictEqual(m.state.branch, 'main');
    // open in new window + add to workspace
    await vscode.commands.executeCommand('gitCompass.openWorktreeNewWindow', wtNode);
    assert.ok(vscode.__mock.log.some(l => l[0] === 'command' && l[1] === 'vscode.openFolder'));
    await vscode.commands.executeCommand('gitCompass.addWorktreeToWorkspace', wtNode);
    assert.ok(vscode.workspace.workspaceFolders.some(f => f.uri.fsPath === wtPath));
    // dirty worktree: changes are shown, removal asks twice (confirm + force)
    fsx.writeFileSync(path.join(wtPath, 'dirty.txt'), 'x');
    wts = await views.worktrees.getChildren();
    assert.match(wts.find(n => n.worktree && n.worktree.branch === 'feature').item.description, /1 change/);
    vscode.__mock.answers.push('Remove Worktree', 'Remove Anyway (Discard Changes)');
    await vscode.commands.executeCommand('gitCompass.removeWorktree', wtNode);
    assert.ok(!fsx.existsSync(wtPath), 'worktree folder removed');
    assert.ok(!vscode.workspace.workspaceFolders.some(f => f.uri.fsPath === wtPath), 'removed from workspace');
    assert.strictEqual((await m.repo.worktrees()).length, 1);
    // prune a worktree whose folder was deleted by hand
    const gone = wtPath + '-gone';
    await m.repo.run(['worktree', 'add', '-q', '--detach', gone, 'HEAD']);
    fsx.rmSync(gone, { recursive: true, force: true });
    vscode.__mock.answers.push('Prune');
    await vscode.commands.executeCommand('gitCompass.pruneWorktrees', { root: m.root });
    assert.strictEqual((await m.repo.worktrees()).length, 1);
    console.log('  ✔ worktrees: create, list, branch hint, switch guard, open, workspace, remove (dirty), prune');

    // ---- publish to a brand-new GitHub repository (GitHub API stubbed, a bare repo plays GitHub) ----
    const { github } = await vscode.extensions.getExtension('radomir-novy.git-compass').activate();
    const proj = fsx.mkdtempSync(path.join(os.tmpdir(), 'gc-publish-'));
    const bare = proj + '-github.git';
    const sh = (...a) => cp.execFileSync('git', a, { cwd: proj });
    cp.execFileSync('git', ['init', '-q', '--bare', bare]);
    sh('init', '-q', '-b', 'main');
    sh('config', 'user.name', 'Test User'); sh('config', 'user.email', 'test@example.com');
    fsx.writeFileSync(path.join(proj, 'app.txt'), 'app\n');
    sh('add', '.'); sh('commit', '-qm', 'first');
    sh('branch', 'dev'); sh('tag', 'v1');
    sh('remote', 'add', 'origin', path.join(proj, 'school-gitlab-placeholder'));
    fsx.writeFileSync(path.join(proj, 'notes.txt'), 'uncommitted\n');
    const pm = await manager.open(proj);
    const createCalls = [];
    github.session = async () => ({ accessToken: 'test' });
    github.createRepository = async (name, priv) => {
      createCalls.push([name, priv]);
      if (name === 'taken-name') throw new Error('GitHub: Repository creation failed.: name already exists on this account');
      return { clone_url: bare, full_name: `tester/${name}`, html_url: `https://github.com/tester/${name}` };
    };
    vscode.__mock.answers.push(
      'Commit All & Publish', // uncommitted files
      'Add notes', // commit message
      'taken-name', // repository name (taken)
      i => i.private === true, // visibility
      'fresh-name', // second try
      'Upload Them', // other branches + tags
    );
    const published = await vscode.commands.executeCommand('gitCompass.publishToGitHub', { root: proj });
    assert.strictEqual(published, 'tester/fresh-name');
    assert.deepStrictEqual(createCalls, [['taken-name', true], ['fresh-name', true]]);
    const remotes = await pm.repo.remotes();
    assert.deepStrictEqual(remotes.map(r => r.name).sort(), ['github', 'origin'], 'existing origin kept, GitHub added as "github"');
    const remoteHeads = cp.execFileSync('git', ['for-each-ref', '--format=%(refname)'], { cwd: bare, encoding: 'utf8' }).trim().split('\n').sort();
    assert.deepStrictEqual(remoteHeads, ['refs/heads/dev', 'refs/heads/main', 'refs/tags/v1']);
    const [last] = await pm.repo.log({ maxCount: 1 });
    assert.strictEqual(last.subject, 'Add notes');
    await pm.refresh();
    assert.strictEqual(pm.state.upstream, 'github/main');
    assert.strictEqual(pm.state.changeCount, 0);
    console.log('  ✔ publish to new GitHub repo: commits pending files, retries taken name, keeps origin, uploads branches + tags');

    const errors = vscode.__mock.log.filter(l => l[0] === 'error' || l[0] === 'listenerError');
    assert.deepStrictEqual(errors, [], 'no error messages were shown');
    console.log('  ✔ no error notifications during the whole run');
    console.log('\nHeadless host test passed');
    process.exit(0);
  } catch (e) {
    console.error(e);
    const errors = vscode.__mock.log.filter(l => l[0] === 'error');
    if (errors.length) console.error('Error messages shown:', errors);
    process.exit(1);
  }
})();
