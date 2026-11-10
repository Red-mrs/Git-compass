'use strict';
// Unit tests for the git layer. Run with:  node test/unit.test.js
// (no test framework needed; uses node:assert). Creates throwaway repos in the OS temp dir.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { Git, Repository, parseRefs } = require('../src/git');
const { computeGraph } = require('../src/graphLayout');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-'));
  const g = (...args) => cp.execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } });
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'Test User');
  g('config', 'user.email', 'test@example.com');
  g('config', 'commit.gpgsign', 'false');
  const write = (f, c) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); };
  return { dir, g, write };
}

async function openRepo(dir) {
  const git = new Git();
  const root = await git.findRoot(dir);
  return new Repository(git, root).init();
}

test('status on empty repo', async () => {
  const { dir, write } = mkRepo();
  write('a.txt', 'hello');
  write('sub dir/ž file.txt', 'unicode');
  const repo = await openRepo(dir);
  const s = await repo.status();
  assert.strictEqual(s.initial, true);
  assert.strictEqual(s.branch, 'main');
  assert.deepStrictEqual(s.untracked.map(f => f.path).sort(), ['a.txt', 'sub dir/ž file.txt']);
  assert.deepStrictEqual(await repo.log(), []);
});

test('status staged/unstaged/rename', async () => {
  const { dir, g, write } = mkRepo();
  write('a.txt', 'line1\nline2\nline3\nline4\nline5\n');
  write('b.txt', 'b');
  g('add', '.');
  g('commit', '-q', '-m', 'first');
  g('mv', 'a.txt', 'renamed a.txt');
  write('b.txt', 'b changed');
  write('c.txt', 'c');
  g('add', 'c.txt');
  write('c.txt', 'c2');
  const repo = await openRepo(dir);
  const s = await repo.status();
  assert.strictEqual(s.initial, false);
  const staged = s.staged.map(f => `${f.status}:${f.path}:${f.origPath || ''}`).sort();
  assert.deepStrictEqual(staged, ['A:c.txt:', 'R:renamed a.txt:a.txt']);
  const unstaged = s.unstaged.map(f => `${f.status}:${f.path}`).sort();
  assert.deepStrictEqual(unstaged, ['M:b.txt', 'M:c.txt']);
});

test('log, refs, commit files, branches, tags, stash, reflog', async () => {
  const { dir, g, write } = mkRepo();
  write('a.txt', '1');
  g('add', '.'); g('commit', '-q', '-m', 'one');
  g('tag', '-a', 'v1', '-m', 'version 1');
  g('checkout', '-q', '-b', 'feature');
  write('b.txt', '2'); g('add', '.'); g('commit', '-q', '-m', 'two on feature');
  g('checkout', '-q', 'main');
  write('a.txt', '3'); g('add', '.'); g('commit', '-q', '-m', 'three on main');
  g('merge', '-q', '--no-edit', 'feature');
  write('a.txt', 'dirty');
  g('stash', 'push', '-q', '-m', 'my stash');
  const repo = await openRepo(dir);
  const log = await repo.log({ all: true });
  assert.strictEqual(log.length, 4);
  assert.strictEqual(log[0].parents.length, 2);
  assert.ok(log[0].refs.some(r => r.type === 'branch' && r.name === 'main' && r.current));
  const first = log.find(c => c.subject === 'one');
  assert.ok(first.refs.some(r => r.type === 'tag' && r.name === 'v1'));
  const files = await repo.commitFiles(first.sha, first.parents);
  assert.deepStrictEqual(files.map(f => [f.status, f.path, f.added]), [['A', 'a.txt', 1]]);
  const refs = await repo.refs([]);
  assert.deepStrictEqual(refs.local.map(b => b.name).sort(), ['feature', 'main']);
  assert.ok(refs.local.find(b => b.name === 'main').current);
  assert.strictEqual(refs.tags[0].name, 'v1');
  assert.strictEqual(refs.tags[0].sha, first.sha);
  const st = await repo.stashes();
  assert.strictEqual(st.length, 1);
  assert.match(st[0].message, /my stash/);
  const sf = await repo.stashFiles(0);
  assert.deepStrictEqual(sf.map(f => f.path), ['a.txt']);
  const rl = await repo.reflog();
  assert.ok(rl.length >= 4);
  assert.ok(rl[0].date > 0);
  const c = await repo.commit(log[0].sha);
  assert.match(c.body, /Merge branch 'feature'/);
  const shown = await repo.show(first.sha, 'a.txt');
  assert.strictEqual(shown.toString(), '1');
  assert.strictEqual(await repo.show(first.sha, 'nope.txt'), null);
});

test('blame parse, including uncommitted contents', async () => {
  const { dir, g, write } = mkRepo();
  write('a.txt', 'x\ny\n');
  g('add', '.'); g('commit', '-q', '-m', 'blame me');
  const repo = await openRepo(dir);
  const b = await repo.blame('a.txt', 'x\nchanged\nnew\n');
  assert.strictEqual(b[1].summary, 'blame me');
  assert.strictEqual(b[1].author, 'Test User');
  assert.strictEqual(b[2].uncommitted, true);
  assert.strictEqual(b[3].uncommitted, true);
});

test('operation detection + conflicts', async () => {
  const { dir, g, write } = mkRepo();
  write('a.txt', 'base\n'); g('add', '.'); g('commit', '-q', '-m', 'base');
  g('checkout', '-q', '-b', 'other');
  write('a.txt', 'other\n'); g('commit', '-qam', 'other');
  g('checkout', '-q', 'main');
  write('a.txt', 'main\n'); g('commit', '-qam', 'main');
  try { g('merge', 'other'); } catch { /* conflict expected */ }
  const repo = await openRepo(dir);
  assert.deepStrictEqual(repo.operation(), { kind: 'merge' });
  const s = await repo.status();
  assert.deepStrictEqual(s.conflicts.map(c => [c.path, c.status]), [['a.txt', 'UU']]);
});

test('interactive rebase: reorder, squash, reword, drop', async () => {
  const { dir, g, write } = mkRepo();
  write('f.txt', '0'); g('add', '.'); g('commit', '-q', '-m', 'base');
  for (const n of ['A', 'B', 'C', 'D']) { write(`${n}.txt`, n); g('add', '.'); g('commit', '-q', '-m', `commit ${n}`); }
  const repo = await openRepo(dir);
  const log = await repo.log({ maxCount: 4 }); // D C B A
  const [D, C, B, A] = log;
  await repo.rebaseInteractive(log[3].parents[0], [
    { action: 'pick', sha: B.sha },
    { action: 'reword', sha: A.sha, message: 'A reworded\n\nwith body' },
    { action: 'squash', sha: C.sha },
    { action: 'drop', sha: D.sha },
  ]);
  const after = await repo.log({ maxCount: 10 });
  assert.deepStrictEqual(after.map(c => c.subject), ['A reworded', 'commit B', 'base']);
  assert.ok(!fs.existsSync(path.join(dir, 'D.txt')));
  assert.ok(fs.existsSync(path.join(dir, 'C.txt')));
  assert.strictEqual(repo.operation(), null);
});

test('worktrees: list, detached, locked, prunable', async () => {
  const { dir, g, write } = mkRepo();
  write('a.txt', '1'); g('add', '.'); g('commit', '-qm', 'one');
  g('branch', 'side');
  const wt1 = dir + '-side';
  const wt2 = dir + '-detached';
  const wt3 = dir + '-gone';
  g('worktree', 'add', '-q', wt1, 'side');
  g('worktree', 'add', '-q', '--detach', wt2, 'HEAD');
  g('worktree', 'add', '-q', '-b', 'temp', wt3);
  g('worktree', 'lock', '--reason', 'usb drive', wt2);
  fs.rmSync(wt3, { recursive: true, force: true });
  const repo = await openRepo(dir);
  assert.strictEqual(repo.isLinkedWorktree, false);
  const list = await repo.worktrees();
  assert.strictEqual(list.length, 4);
  assert.ok(list[0].main && list[0].branch === 'main');
  const side = list.find(w => w.branch === 'side');
  assert.strictEqual(side.path, path.normalize(fs.realpathSync(wt1)));
  const det = list.find(w => w.detached);
  assert.ok(det.locked && det.lockReason === 'usb drive');
  assert.ok(list.find(w => w.branch === 'temp').prunable);
  const linked = await openRepo(wt1);
  assert.strictEqual(linked.isLinkedWorktree, true);
  assert.strictEqual((await linked.status()).branch, 'side');
  // a branch in use elsewhere gives a friendly error
  await assert.rejects(linked.run(['switch', 'main']), e => /another worktree/.test(e.friendly));
});

test('parseRefs', () => {
  const r = parseRefs('HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1.0, refs/stash');
  assert.deepStrictEqual(r, [
    { type: 'branch', name: 'main', current: true },
    { type: 'remote', name: 'origin/main' },
    { type: 'tag', name: 'v1.0' },
    { type: 'stash', name: 'stash' },
  ]);
  assert.deepStrictEqual(parseRefs('HEAD'), [{ type: 'head', name: 'HEAD' }]);
});

test('graph layout: branch and merge', () => {
  // M merges F into C; C and F both come from B; B from A
  const commits = [
    { sha: 'M', parents: ['C', 'F'] },
    { sha: 'F', parents: ['B'] },
    { sha: 'C', parents: ['B'] },
    { sha: 'B', parents: ['A'] },
    { sha: 'A', parents: [] },
  ];
  const { rows, width } = computeGraph(commits);
  assert.strictEqual(width, 2);
  assert.deepStrictEqual(rows.map(r => r.col), [0, 1, 0, 0, 0]);
  assert.ok(rows[0].merge);
  // B row: both lanes converge into col 0
  assert.ok(rows[3].lines.some(l => l[0] === 1 && l[2] === 0));
  assert.ok(rows[4].root);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✔ ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`  ✘ ${t.name}\n    ${e.stack.split('\n').slice(0, 6).join('\n    ')}`);
    }
  }
  console.log(failed ? `\n${failed} test(s) failed` : `\nAll ${tests.length} tests passed`);
  process.exit(failed ? 1 : 0);
})();
