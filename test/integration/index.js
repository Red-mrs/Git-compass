'use strict';
// End-to-end smoke test that runs INSIDE a real VS Code instance.
// Launch:  code --extensionDevelopmentPath=<repo> --extensionTestsPath=<repo>/test/integration/index.js <workspaceFolder>
// The workspace folder must be a git repository prepared by test/integration/prepare.js.

const vscode = require('vscode');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, what, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function allNodes(provider, node, depth = 0, out = []) {
  const children = await provider.getChildren(node);
  for (const c of children || []) {
    out.push(c);
    if (depth < 2 && c.item.collapsibleState !== vscode.TreeItemCollapsibleState.None) await allNodes(provider, c, depth + 1, out);
  }
  return out;
}

async function run() {
  const results = [];
  const step = async (name, fn) => {
    try { await fn(); results.push(`  ✔ ${name}`); } catch (e) { results.push(`  ✘ ${name}\n      ${e.stack.split('\n').slice(0, 4).join('\n      ')}`); }
  };

  const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const cfg = vscode.workspace.getConfiguration('gitCompass');
  await cfg.update('smartCommit', 'always', vscode.ConfigurationTarget.Global);
  await cfg.update('autoFetch', 0, vscode.ConfigurationTarget.Global);

  const ext = vscode.extensions.getExtension('radomir-novy.git-compass');
  const api = await ext.activate();
  const { manager, views } = api;

  await step('repository discovered', async () => {
    await waitFor(() => manager.current && manager.current.state, 'repo');
    assert.strictEqual(path.normalize(manager.current.root), path.normalize(folder));
    assert.strictEqual(manager.current.state.branch, 'main');
  });
  const m = manager.current;

  await step('all tree views render without errors', async () => {
    for (const [key, v] of Object.entries(views)) {
      const nodes = await allNodes(v);
      assert.ok(Array.isArray(nodes), key);
    }
    const branches = await allNodes(views.branches);
    assert.ok(branches.some(n => n.kind === 'branch' && n.branch.name === 'feature'), 'feature branch listed');
    const tags = await views.tags.getChildren();
    assert.ok(tags.some(n => n.tag && n.tag.name === 'v1.0'), 'tag listed');
    const stashes = await views.stashes.getChildren();
    assert.strictEqual(stashes.filter(n => n.kind === 'stash').length, 1, 'one stash');
  });

  await step('changes view shows modified + untracked files', async () => {
    const groups = await views.changes.getChildren();
    const changes = groups.find(g => g.group === 'changes');
    assert.ok(changes, 'changes group');
    const names = changes.files.map(f => f.path).sort();
    assert.deepStrictEqual(names, ['README.md', 'new file.txt']);
  });

  await step('stage + unstage via commands', async () => {
    let groups = await views.changes.getChildren();
    const fileNode = (await groups.find(g => g.group === 'changes').getChildren()).find(n => n.file && n.file.path === 'README.md');
    await vscode.commands.executeCommand('gitCompass.stage', fileNode);
    await waitFor(() => m.state.staged.some(f => f.path === 'README.md'), 'staged');
    groups = await views.changes.getChildren();
    const stagedNode = (await groups.find(g => g.group === 'staged').getChildren())[0];
    await vscode.commands.executeCommand('gitCompass.unstage', stagedNode);
    await waitFor(() => !m.state.staged.length, 'unstaged');
  });

  await step('diff content provider serves file at HEAD', async () => {
    const { gitUri } = require(path.join(ext.extensionPath, 'src/diff.js'));
    const doc = await vscode.workspace.openTextDocument(gitUri(m.root, 'README.md', 'HEAD'));
    assert.match(doc.getText(), /second line/);
    assert.doesNotMatch(doc.getText(), /uncommitted edit/);
    await vscode.commands.executeCommand('gitCompass.openChange', { root: m.root, file: { path: 'README.md', status: 'M' }, group: 'changes' });
    await sleep(300);
  });

  await step('commit (smart commit stages everything)', async () => {
    const ok = await vscode.commands.executeCommand('gitCompass.commit', { root: m.root, message: 'Integration commit' });
    assert.strictEqual(ok, true);
    await waitFor(() => m.state.changeCount === 0, 'clean tree');
    const [head] = await m.repo.log({ maxCount: 1 });
    assert.strictEqual(head.subject, 'Integration commit');
  });

  await step('commits view lists the new commit; commit files expand', async () => {
    await sleep(400);
    const nodes = await views.commits.getChildren();
    const c = nodes.find(n => n.kind === 'commit');
    assert.strictEqual(c.commit.subject, 'Integration commit');
    const files = await c.getChildren();
    assert.ok(files.some(f => f.file && f.file.path === 'new file.txt'));
  });

  await step('file history + blame', async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(folder, 'README.md'));
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('gitCompass.fileHistory', doc.uri);
    const hist = await waitFor(async () => { const n = await views.fileHistory.getChildren(); return n.length >= 2 && n; }, 'history');
    assert.ok(hist.every(n => n.kind === 'commit'));
    await vscode.commands.executeCommand('gitCompass.openFileHistoryDiff', { root: m.root, commit: hist[1].commit });
    const b = await m.repo.blame('README.md');
    assert.ok(b[1] && b[1].author === 'Test User');
  });

  await step('create branch, switch back, merge (fast-forward)', async () => {
    await m.repo.run(['branch', 'topic']);
    await vscode.commands.executeCommand('gitCompass.checkout', { root: m.root, ref: 'topic', refType: 'branch' });
    await waitFor(() => m.state.branch === 'topic', 'on topic');
    fs.writeFileSync(path.join(folder, 'topic.txt'), 'topic\n');
    await vscode.commands.executeCommand('gitCompass.commit', { root: m.root, message: 'Topic work' });
    await vscode.commands.executeCommand('gitCompass.checkout', { root: m.root, ref: 'main', refType: 'branch' });
    await waitFor(() => m.state.branch === 'main', 'back on main');
    await m.repo.run(['merge', '--no-edit', 'topic']);
    await m.refresh();
    assert.ok(fs.existsSync(path.join(folder, 'topic.txt')));
  });

  await step('compare view', async () => {
    views.compare.set(m, 'v1.0', 'main');
    const nodes = await allNodes(views.compare);
    assert.ok(nodes.some(n => n.kind === 'compareFiles'));
    views.compare.clear();
  });

  await step('reflog view humanizes entries', async () => {
    const nodes = await views.reflog.getChildren();
    assert.ok(nodes.length > 3);
    assert.ok(nodes.some(n => /^(Committed|Switched|Merged)/.test(n.item.label)), nodes.map(n => n.item.label).join(' | '));
  });

  await step('webview panels open (graph, guide)', async () => {
    await vscode.commands.executeCommand('gitCompass.openGraph');
    await vscode.commands.executeCommand('gitCompass.showCommit', { root: m.root, sha: (await m.repo.revParse('HEAD')) });
    await vscode.commands.executeCommand('gitCompass.openGuide', 'conflicts');
    await vscode.commands.executeCommand('gitCompass.overview.focus');
    await sleep(800);
  });

  await step('copy SHA to clipboard', async () => {
    const sha = await m.repo.revParse('HEAD');
    await vscode.commands.executeCommand('gitCompass.copySha', { root: m.root, sha });
    assert.strictEqual(await vscode.env.clipboard.readText(), sha);
  });

  await step('merge conflict is detected and resolvable', async () => {
    await m.repo.run(['switch', '-c', 'clash']);
    fs.writeFileSync(path.join(folder, 'README.md'), 'clash version\n');
    await m.repo.run(['commit', '-qam', 'clash']);
    await m.repo.run(['switch', 'main']);
    fs.writeFileSync(path.join(folder, 'README.md'), 'main version\n');
    await m.repo.run(['commit', '-qam', 'main change']);
    await m.repo.run(['merge', 'clash']).catch(() => {});
    await m.refresh();
    assert.strictEqual(m.state.operation.kind, 'merge');
    assert.strictEqual(m.state.conflicts.length, 1);
    const groups = await views.changes.getChildren();
    const conf = (await groups.find(g => g.group === 'conflicts').getChildren())[0];
    await vscode.commands.executeCommand('gitCompass.acceptTheirs', conf);
    await waitFor(() => m.state.conflicts.length === 0, 'resolved');
    await vscode.commands.executeCommand('gitCompass.continueOperation', { root: m.root });
    await waitFor(() => !m.state.operation, 'merge finished');
    assert.strictEqual(fs.readFileSync(path.join(folder, 'README.md'), 'utf8'), 'clash version\n');
  });

  await step('overview suggestion logic', async () => {
    const { suggest } = require(path.join(ext.extensionPath, 'src/webviews/overview.js'));
    assert.match(suggest({ ...m.state, ahead: 2, behind: 0, upstream: 'origin/main', remotes: [{}] }).text, /Push/);
    assert.match(suggest({ ...m.state, remotes: [] }).text, /GitHub/);
  });

  console.log('\nGit Compass integration test\n' + results.join('\n'));
  const failed = results.filter(r => r.includes('✘')).length;
  await cfg.update('smartCommit', undefined, vscode.ConfigurationTarget.Global);
  if (failed) throw new Error(`${failed} integration step(s) failed`);
  console.log(`\nAll ${results.length} integration steps passed`);
}

module.exports = { run };
