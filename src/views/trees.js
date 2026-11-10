'use strict';
const vscode = require('vscode');
const path = require('path');
const { BaseTree, Node, message, loadMoreNode, commitNode, fileNodes, commitTooltip } = require('./nodes');
const { relTime, fullDate, short, escapeMd, cfg, basename } = require('../util');
const { openRefDiff } = require('../diff');
const { githubRemote } = require('../github');

const E = vscode.TreeItemCollapsibleState.Expanded;
const C = vscode.TreeItemCollapsibleState.Collapsed;
const N = vscode.TreeItemCollapsibleState.None;

function groupItem(label, state, icon, contextValue, id, tooltip) {
  const item = new vscode.TreeItem(label, state);
  if (icon) item.iconPath = icon instanceof vscode.ThemeIcon ? icon : new vscode.ThemeIcon(icon);
  item.contextValue = contextValue;
  item.id = id;
  if (tooltip) item.tooltip = tooltip;
  return item;
}

// ============================================================================================
// Changes
// ============================================================================================
class ChangesTree extends BaseTree {
  constructor(manager) {
    super();
    this.manager = manager;
  }

  async roots() {
    const m = this.manager.current;
    if (!m || !m.state) return [];
    const s = m.state;
    const groups = [];
    const key = m.root;
    const mk = (id, label, files, icon, ctx, tooltip, describe) => {
      const item = groupItem(label, E, icon, `group;${ctx};`, `${key}:${id}`, tooltip);
      item.description = String(files.length);
      return new Node(item, { kind: 'group', group: ctx, model: m, files }, async () => fileNodes(m.root, files, describe, `${key}:${id}`));
    };
    if (s.conflicts.length) {
      groups.push(mk('conflicts', 'Merge Conflicts', s.conflicts, new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground')), 'conflicts',
        'These files have conflicting changes. Open each one, pick which version to keep (Accept Current / Incoming / Both), save, then click ✓ (mark resolved).',
        f => ({
          kind: 'change', contextValue: 'file;conflict;',
          command: { command: 'gitCompass.openFile', title: 'Open', arguments: [{ root: m.root, file: f }] },
          data: { model: m, group: 'conflicts' },
        })));
    }
    if (s.staged.length) {
      groups.push(mk('staged', 'Staged Changes', s.staged, 'pass-filled', 'staged',
        'Staged changes are what will go into your next commit.',
        f => ({
          kind: 'change', contextValue: 'file;staged;',
          command: { command: 'gitCompass.openChange', title: 'Open Changes', arguments: [{ root: m.root, file: f, group: 'staged' }] },
          data: { model: m, group: 'staged' },
        })));
    }
    const changes = [...s.unstaged, ...s.untracked];
    if (changes.length) {
      groups.push(mk('changes', s.staged.length ? 'Changes (not staged)' : 'Changes', changes, 'edit', 'changes',
        'Changes in your files that are not staged yet. Click + to stage a file (include it in the next commit).',
        f => ({
          kind: 'change', contextValue: f.status === '?' ? 'file;unstaged;untracked;' : 'file;unstaged;',
          command: { command: 'gitCompass.openChange', title: 'Open Changes', arguments: [{ root: m.root, file: f, group: 'changes' }] },
          data: { model: m, group: 'changes' },
        })));
    }
    if (!groups.length) {
      return [message('No changes — your working tree is clean.', 'check')];
    }
    return groups;
  }
}

// ============================================================================================
// Commits (history of the current branch)
// ============================================================================================
class CommitsTree extends BaseTree {
  constructor(manager) {
    super();
    this.manager = manager;
    this.maxCount = 50;
  }
  loadMore() { this.maxCount += 50; this.refresh(); }

  async roots() {
    const m = this.manager.current;
    if (!m || !m.state) return [];
    const s = m.state;
    if (s.initial) return [message('No commits yet — write a message in the Overview and commit your files.', 'info')];
    const nodes = [];
    if (s.upstream && s.behind > 0) {
      const item = groupItem(`${s.behind} incoming commit${s.behind > 1 ? 's' : ''} from ${s.upstream}`, C,
        new vscode.ThemeIcon('arrow-circle-down', new vscode.ThemeColor('charts.blue')), 'incoming;', `${m.root}:incoming`,
        'These commits are on the remote but not on your computer yet. Pull (or Sync) to get them.');
      item.description = 'pull to get them';
      nodes.push(new Node(item, { kind: 'incoming', model: m }, async () => {
        const commits = await m.repo.log({ refs: ['HEAD..@{u}'], maxCount: 200 });
        return commits.map(c => commitNode(m, c, { incoming: true, idPrefix: `${m.root}:in` }));
      }));
    }
    const hasRemotes = s.remotes.length > 0;
    const [unpushed, commits] = await Promise.all([
      hasRemotes ? m.repo.unpushed(!!s.upstream) : Promise.resolve(new Set()),
      m.repo.log({ refs: ['HEAD'], maxCount: this.maxCount + 1 }),
    ]);
    commits.slice(0, this.maxCount).forEach((c, i) => {
      nodes.push(commitNode(m, c, { unpushed: unpushed.has(c.sha), isHead: i === 0, idPrefix: `${m.root}:c` }));
    });
    if (commits.length > this.maxCount) nodes.push(loadMoreNode('commits'));
    return nodes;
  }
}

// ============================================================================================
// Branches (local + remote)
// ============================================================================================
class BranchesTree extends BaseTree {
  constructor(manager) {
    super();
    this.manager = manager;
  }

  async roots() {
    const m = this.manager.current;
    if (!m || !m.state) return [];
    const remotes = m.state.remotes;
    const [refs, worktrees] = await Promise.all([m.repo.refs(remotes.map(r => r.name)), m.repo.worktrees()]);
    this.inWorktree = new Map(worktrees.filter(w => w.branch && !samePath(w.path, m.root)).map(w => [w.branch, w]));
    const local = refs.local.sort((a, b) => (b.current - a.current) || (b.date - a.date));
    const nodes = [];
    const localItem = groupItem('Local branches', E, 'device-desktop', 'branchGroup;local;', `${m.root}:local`, 'Branches on your computer.');
    localItem.description = String(local.length);
    nodes.push(new Node(localItem, { kind: 'branchGroup', model: m }, async () => {
      if (!local.length) return [message('No branches yet — make the first commit.', 'info')];
      return local.map(b => this.localBranchNode(m, b));
    }));
    for (const r of remotes) {
      const branches = refs.remote.filter(b => b.remote === r.name).sort((a, b) => a.branch.localeCompare(b.branch));
      const item = groupItem(`Remote: ${r.name}`, C, 'cloud', 'remote;', `${m.root}:remote:${r.name}`, `${r.name} → ${r.fetchUrl}\nBranches as they were on the server at the last fetch.`);
      item.description = r.fetchUrl;
      nodes.push(new Node(item, { kind: 'remote', model: m, remote: r }, async () => {
        if (!branches.length) return [message('No branches fetched yet — click Fetch.', 'info')];
        return branches.map(b => this.remoteBranchNode(m, b));
      }));
    }
    if (!remotes.length) {
      nodes.push(message('No remote yet — Publish to GitHub…', 'cloud-upload', { command: 'gitCompass.publishToGitHub', title: 'Publish' }));
    }
    return nodes;
  }

  localBranchNode(m, b) {
    const item = new vscode.TreeItem(b.name, C);
    item.iconPath = b.current ? new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green')) : new vscode.ThemeIcon('git-branch');
    const desc = [];
    if (b.current) desc.push('current');
    const wt = this.inWorktree && this.inWorktree.get(b.name);
    if (wt) desc.push(`📁 in worktree ${path.basename(wt.path)}`);
    if (b.gone) desc.push('⚠ remote branch deleted');
    else if (b.upstream) {
      if (b.ahead) desc.push(`↑${b.ahead}`);
      if (b.behind) desc.push(`↓${b.behind}`);
      desc.push(`→ ${b.upstream}`);
    } else desc.push('not published');
    item.description = desc.join(' ');
    const md = new vscode.MarkdownString('', true);
    md.appendMarkdown(`**$(git-branch) ${escapeMd(b.name)}**${b.current ? ' — *you are on this branch*' : ''}\n\n`);
    if (b.upstream) {
      md.appendMarkdown(`Tracks \`${escapeMd(b.upstream)}\`` + (b.gone ? ' (deleted on the remote)' : '') + '  \n');
      if (b.ahead) md.appendMarkdown(`$(arrow-up) ${b.ahead} commit(s) to push  \n`);
      if (b.behind) md.appendMarkdown(`$(arrow-down) ${b.behind} commit(s) to pull  \n`);
    } else md.appendMarkdown('Only on your computer (not published)  \n');
    if (wt) md.appendMarkdown(`$(folder) Checked out in worktree \`${escapeMd(wt.path)}\` — open that folder to work on it  \n`);
    md.appendMarkdown(`\nLast commit: *${escapeMd(b.subject)}* — ${escapeMd(b.author)}, ${relTime(b.date)}`);
    item.tooltip = md;
    item.contextValue = `branch;local;${b.current ? 'current;' : ''}${b.upstream ? 'tracking;' : 'untracked;'}${wt ? 'inWorktree;' : ''}`;
    item.id = `${m.root}:lb:${b.name}`;
    return new Node(item, { kind: 'branch', model: m, branch: b, ref: b.name }, async () => {
      const commits = await m.repo.log({ refs: [b.name], maxCount: 30 });
      return commits.map(c => commitNode(m, c, { idPrefix: `${m.root}:lb:${b.name}` }));
    });
  }

  remoteBranchNode(m, b) {
    const item = new vscode.TreeItem(b.branch, C);
    item.iconPath = new vscode.ThemeIcon('git-branch');
    item.description = `${relTime(b.date)}`;
    item.tooltip = `${b.name}\nLast commit: ${b.subject} — ${b.author}, ${relTime(b.date)}`;
    item.contextValue = 'branch;remote;';
    item.id = `${m.root}:rb:${b.name}`;
    return new Node(item, { kind: 'branch', model: m, branch: b, ref: b.name, remoteBranch: true }, async () => {
      const commits = await m.repo.log({ refs: [b.name], maxCount: 30 });
      return commits.map(c => commitNode(m, c, { idPrefix: `${m.root}:rb:${b.name}` }));
    });
  }
}

// ============================================================================================
// Worktrees
// ============================================================================================
class WorktreesTree extends BaseTree {
  constructor(manager) { super(); this.manager = manager; }

  async roots() {
    const m = this.manager.current;
    if (!m || !m.state) return [];
    const list = await m.repo.worktrees();
    const nodes = list.filter(w => !w.bare).map(w => this.worktreeNode(m, w));
    await Promise.all(nodes.map(async n => {
      const w = n.worktree;
      if (w.prunable || n.isCurrent) return;
      try {
        const out = await m.repo.git.exec(w.path, ['--no-optional-locks', 'status', '--porcelain'], { quiet: true });
        w.changes = out.stdout.split('\n').filter(Boolean).length;
        if (w.changes) n.item.description += ` · ✎ ${w.changes} change${w.changes > 1 ? 's' : ''}`;
      } catch { /* folder unreadable */ }
    }));
    if (list.length <= 1) {
      nodes.push(message('Only the main folder. Create a worktree to have another branch checked out in a separate folder at the same time.', 'info'));
      nodes.push(message('Create worktree…', 'add', { command: 'gitCompass.createWorktree', title: 'Create worktree' }));
    }
    return nodes;
  }

  worktreeNode(m, w) {
    const isCurrent = samePath(w.path, m.root);
    const item = new vscode.TreeItem(path.basename(w.path), N);
    const what = w.branch ? `⎇ ${w.branch}` : w.detached ? `detached at ${short(w.sha)}` : '';
    const flags = [];
    if (isCurrent) flags.push('this window');
    if (w.main) flags.push('main');
    if (w.locked) flags.push('🔒 locked');
    if (w.prunable) flags.push('⚠ folder missing');
    item.description = [what, flags.length ? `(${flags.join(', ')})` : ''].filter(Boolean).join(' ');
    if (isCurrent) item.changes = m.state.changeCount + m.state.stagedCount;
    if (isCurrent && item.changes) item.description += ` · ✎ ${item.changes} change${item.changes > 1 ? 's' : ''}`;
    item.iconPath = w.prunable ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
      : isCurrent ? new vscode.ThemeIcon('folder-active', new vscode.ThemeColor('charts.green'))
        : new vscode.ThemeIcon(w.main ? 'repo' : 'folder');
    const md = new vscode.MarkdownString('', true);
    md.appendMarkdown(`**$(folder) ${escapeMd(w.path)}**\n\n`);
    md.appendMarkdown(w.branch ? `Branch \`${escapeMd(w.branch)}\` is checked out here.  \n` : `Detached HEAD at \`${short(w.sha)}\`.  \n`);
    if (w.main) md.appendMarkdown('This is the **main worktree** (the original repository folder).  \n');
    if (isCurrent) md.appendMarkdown('You are working in this folder right now.  \n');
    if (w.locked) md.appendMarkdown(`🔒 Locked${w.lockReason ? `: ${escapeMd(w.lockReason)}` : ''} — protected from removal/prune.  \n`);
    if (w.prunable) md.appendMarkdown('⚠ The folder no longer exists. Use **Prune** to clean up this entry.  \n');
    md.appendMarkdown('\nAll worktrees share the same commits, branches and stashes — only the checked-out files differ.');
    item.tooltip = md;
    item.contextValue = `worktree;${w.main ? 'main;' : ''}${isCurrent ? 'current;' : ''}${w.locked ? 'locked;' : ''}${w.prunable ? 'prunable;' : ''}`;
    item.id = `${m.root}:wt:${w.path}`;
    const node = new Node(item, { kind: 'worktree', model: m, worktree: w, isCurrent });
    return node;
  }
}

// ============================================================================================
// Tags
// ============================================================================================
class TagsTree extends BaseTree {
  constructor(manager) { super(); this.manager = manager; }
  async roots() {
    const m = this.manager.current;
    if (!m || !m.state) return [];
    const refs = await m.repo.refs(m.state.remotes.map(r => r.name));
    if (!refs.tags.length) return [message('No tags. Tags mark important commits, e.g. releases (v1.0).', 'info')];
    return refs.tags.sort((a, b) => b.date - a.date).map(t => {
      const item = new vscode.TreeItem(t.name, N);
      item.iconPath = new vscode.ThemeIcon('tag');
      item.description = `${t.subject} · ${relTime(t.date)}`;
      item.tooltip = `${t.name}${t.annotated ? ' (annotated)' : ''}\n${t.subject}\nCommit ${short(t.sha)}`;
      item.contextValue = 'tag;';
      item.command = { command: 'gitCompass.showCommit', title: 'Show', arguments: [{ root: m.root, sha: t.sha }] };
      return new Node(item, { kind: 'tag', model: m, tag: t, ref: t.name });
    });
  }
}

// ============================================================================================
// Stashes
// ============================================================================================
class StashesTree extends BaseTree {
  constructor(manager) { super(); this.manager = manager; }
  async roots() {
    const m = this.manager.current;
    if (!m || !m.state) return [];
    const stashes = await m.repo.stashes();
    if (!stashes.length) return [message('No stashes. A stash is a "drawer" where you can park unfinished changes.', 'info')];
    return stashes.map(st => {
      const mm = /^(?:WIP on|On) ([^:]+): (.*)$/.exec(st.message);
      const item = new vscode.TreeItem(mm ? mm[2] : st.message, C);
      item.iconPath = new vscode.ThemeIcon('archive');
      item.description = `${mm ? `on ${mm[1]} · ` : ''}${relTime(st.date)}`;
      item.tooltip = `${st.ref}\n${st.message}\n${fullDate(st.date)}\n\nApply = bring the changes back and keep the stash.\nPop = bring them back and delete the stash.`;
      item.contextValue = 'stash;';
      item.id = `${m.root}:stash:${st.sha}`;
      return new Node(item, { kind: 'stash', model: m, stash: st }, async () => {
        const files = await m.repo.stashFiles(st.index);
        return fileNodes(m.root, files, f => ({
          kind: 'stashFile', contextValue: 'stashFile;',
          command: { command: 'gitCompass.openStashFileDiff', title: 'Open', arguments: [{ root: m.root, stash: st, file: f }] },
          data: { model: m, stash: st },
        }), `${m.root}:stash:${st.sha}`);
      });
    });
  }
}

// ============================================================================================
// File history (follows the active editor)
// ============================================================================================
class FileHistoryTree extends BaseTree {
  constructor(manager) {
    super();
    this.manager = manager;
    this.target = null; // {model, rel}
    this.pinned = false;
    this._timer = null;
  }

  onEditorChanged(editor) {
    if (this.pinned || !editor) return;
    const uri = editor.document.uri;
    let model = null;
    let rel = null;
    if (uri.scheme === 'file') {
      model = this.manager.modelFor(uri);
      if (model) rel = model.repo.toRel(uri.fsPath);
    } else if (uri.scheme === 'gitcompass') {
      try {
        const q = JSON.parse(uri.query);
        model = this.manager.findModel(q.root);
        rel = q.rel;
      } catch { /* ignore */ }
    } else return;
    if (!model || !rel) return;
    if (this.target && this.target.model === model && this.target.rel === rel) return;
    this.target = { model, rel };
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.refresh(), 200);
  }

  setTarget(model, rel) { this.target = { model, rel }; this.refresh(); }

  async roots() {
    if (!this.target) return [message('Open a file to see its history.', 'info')];
    const { model: m, rel } = this.target;
    const commits = await m.repo.fileHistory(rel, cfg('fileHistory.maxCount', 200));
    if (!commits.length) return [message(`${basename(rel)} has no committed history yet.`, 'info')];
    return commits.map(c => {
      const node = commitNode(m, c, {
        noFiles: true, fileHistory: true,
        description: `${c.author}, ${relTime(c.date)}${c.filePath !== rel ? `  (as ${c.filePath})` : ''}`,
        command: { command: 'gitCompass.openFileHistoryDiff', title: 'Open', arguments: [{ root: m.root, commit: c }] },
        file: { path: c.filePath, origPath: c.fileOrigPath, status: c.fileStatus },
      });
      return node;
    });
  }
}

// ============================================================================================
// Compare two refs
// ============================================================================================
class CompareTree extends BaseTree {
  constructor(manager) {
    super();
    this.manager = manager;
    this.cmp = null; // {model, left, right (null = working tree)}
  }
  set(model, left, right) { this.cmp = { model, left, right }; this.refresh(); }
  swap() { if (this.cmp && this.cmp.right !== null) { const { left, right } = this.cmp; this.cmp.left = right; this.cmp.right = left; this.refresh(); } }
  clear() { this.cmp = null; this.refresh(); }

  async roots() {
    if (!this.cmp) {
      return [
        message('Compare two branches, tags or commits…', 'git-compare', { command: 'gitCompass.compareRefs', title: 'Compare' }),
        message('Compare a branch with your working files…', 'file-diff', { command: 'gitCompass.compareWithWorkingTree', title: 'Compare' }),
      ];
    }
    const { model: m, left, right } = this.cmp;
    const rightLabel = right === null ? 'Working Tree' : right;
    const header = groupItem(`${left}  ↔  ${rightLabel}`, N, 'git-compare', 'compareHeader;', undefined, 'Left side ↔ right side. Use the swap button to flip them.');
    const nodes = [new Node(header, { kind: 'compareHeader' })];
    if (right !== null) {
      const { ahead: onlyLeft, behind: onlyRight } = await m.repo.aheadBehind(left, right);
      const mkCommits = (label, range, count, icon) => {
        const it = groupItem(label, count ? C : N, icon, 'compareCommits;', `cmp:${left}:${right}:${range}`);
        it.description = String(count);
        return new Node(it, { kind: 'compareCommits' }, async () => {
          const commits = await m.repo.log({ refs: [range], maxCount: 300 });
          return commits.map(c => commitNode(m, c, { idPrefix: `cmp:${range}` }));
        });
      };
      nodes.push(mkCommits(`Commits only in ${right}`, `${left}..${right}`, onlyRight, 'arrow-right'));
      nodes.push(mkCommits(`Commits only in ${left}`, `${right}..${left}`, onlyLeft, 'arrow-left'));
    }
    const files = await m.repo.diffFiles(left, right === null ? undefined : right);
    const fi = groupItem('Files that differ', files.length ? E : N, 'files', 'compareFiles;', `cmp:${left}:${right}:files`);
    fi.description = String(files.length);
    nodes.push(new Node(fi, { kind: 'compareFiles' }, async () => fileNodes(m.root, files, f => ({
      kind: 'compareFile', contextValue: 'compareFile;',
      command: { command: 'gitCompass.openCompareFileDiff', title: 'Open', arguments: [{ root: m.root, left, right, file: f }] },
      data: { model: m, left, right },
    }), `cmp:${left}:${right}:f`)));
    return nodes;
  }
}

// ============================================================================================
// Undo history (reflog)
// ============================================================================================
function humanizeReflog(a) {
  const rules = [
    [/^commit \(initial\): (.*)/, m => `First commit: ${m[1]}`, 'git-commit'],
    [/^commit \(amend\): (.*)/, m => `Amended commit: ${m[1]}`, 'edit'],
    [/^commit \(merge\): (.*)/, m => `Merge commit: ${m[1]}`, 'git-merge'],
    [/^commit: (.*)/, m => `Committed: ${m[1]}`, 'git-commit'],
    [/^checkout: moving from (.+) to (.+)/, m => `Switched from ${m[1]} to ${m[2]}`, 'arrow-swap'],
    [/^reset: moving to (.+)/, m => `Reset to ${m[1]}`, 'discard'],
    [/^merge (.+?): (.*)/, m => `Merged ${m[1]} (${m[2]})`, 'git-merge'],
    [/^pull.*?: (.*)/, m => `Pulled (${m[1]})`, 'arrow-down'],
    [/^rebase.*?\((\w+)\): (.*)/, m => `Rebase ${m[1]}: ${m[2]}`, 'git-pull-request'],
    [/^rebase.*?: (.*)/, m => `Rebase: ${m[1]}`, 'git-pull-request'],
    [/^cherry-pick: (.*)/, m => `Cherry-picked: ${m[1]}`, 'git-commit'],
    [/^revert: (.*)/, m => `Reverted: ${m[1]}`, 'discard'],
    [/^clone: (.*)/, () => 'Cloned the repository', 'repo-clone'],
    [/^branch: (.*)/, m => `Branch: ${m[1]}`, 'git-branch'],
  ];
  for (const [re, f, icon] of rules) {
    const m = re.exec(a);
    if (m) return { label: f(m), icon };
  }
  return { label: a, icon: 'history' };
}

class ReflogTree extends BaseTree {
  constructor(manager) { super(); this.manager = manager; this.maxCount = 100; }
  loadMore() { this.maxCount += 100; this.refresh(); }
  async roots() {
    const m = this.manager.current;
    if (!m || !m.state) return [];
    const entries = await m.repo.reflog(this.maxCount + 1);
    if (!entries.length) return [message('Nothing here yet. Every commit, switch, reset, merge… will be listed so you can go back.', 'info')];
    const nodes = entries.slice(0, this.maxCount).map(e => {
      const h = humanizeReflog(e.action);
      const item = new vscode.TreeItem(h.label, N);
      item.iconPath = new vscode.ThemeIcon(h.icon);
      item.description = `${short(e.sha)} · ${relTime(e.date)}`;
      const md = new vscode.MarkdownString('', true);
      md.appendMarkdown(`**${escapeMd(h.label)}**\n\n${fullDate(e.date)}\n\nAfter this step HEAD was at \`${short(e.sha)}\` — *${escapeMd(e.subject)}*\n\n`);
      md.appendMarkdown('Right-click → **Restore to this point** to go back here (your current state stays in this list, so you can come back).');
      item.tooltip = md;
      item.contextValue = 'reflog;';
      item.command = { command: 'gitCompass.showCommit', title: 'Show', arguments: [{ root: m.root, sha: e.sha }] };
      return new Node(item, { kind: 'reflog', model: m, entry: e, sha: e.sha });
    });
    if (entries.length > this.maxCount) nodes.push(loadMoreNode('reflog'));
    return nodes;
  }
}

// ============================================================================================
// GitHub pull requests
// ============================================================================================
const PR_STATUS = { added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C', changed: 'M' };

class PullRequestsTree extends BaseTree {
  constructor(manager, github) {
    super();
    this.manager = manager;
    this.github = github;
    this.cache = new Map();
  }
  refresh(node) { if (!node) this.cache.clear(); super.refresh(node); }

  async roots() {
    const m = this.manager.current;
    if (!m || !m.state) return [];
    const gh = githubRemote(m.state.remotes);
    if (!gh) {
      return [
        message('This repository is not connected to GitHub.', 'info'),
        message('Publish it to GitHub…', 'cloud-upload', { command: 'gitCompass.publishToGitHub', title: 'Publish' }),
      ];
    }
    const session = await this.github.session(false);
    if (!session) return [message('Sign in to GitHub to see pull requests…', 'sign-in', { command: 'gitCompass.githubSignIn', title: 'Sign in' })];
    let prs;
    try {
      const key = `${gh.owner}/${gh.repo}`;
      prs = this.cache.get(key);
      if (!prs) { prs = await this.github.listPullRequests(gh.owner, gh.repo); this.cache.set(key, prs); }
    } catch (e) {
      return [message(`Could not load pull requests: ${e.message}`, 'error')];
    }
    const nodes = [];
    const branch = m.state.branch;
    const mine = branch && prs.find(p => p.head.ref === branch && p.head.repo && p.head.repo.owner.login === gh.owner);
    if (branch && !mine) {
      nodes.push(message(`Create a pull request for “${branch}”…`, 'git-pull-request-create', { command: 'gitCompass.createPullRequest', title: 'Create PR' }));
    }
    const it = groupItem('Open pull requests', E, 'git-pull-request', 'prGroup;', `${m.root}:prs`);
    it.description = String(prs.length);
    nodes.push(new Node(it, { kind: 'prGroup' }, async () => {
      if (!prs.length) return [message('No open pull requests.', 'check')];
      return prs.map(pr => this.prNode(m, gh, pr, mine && mine.number === pr.number));
    }));
    return nodes;
  }

  prNode(m, gh, pr, isCurrent) {
    const item = new vscode.TreeItem(`#${pr.number} ${pr.title}`, C);
    item.iconPath = new vscode.ThemeIcon(pr.draft ? 'git-pull-request-draft' : 'git-pull-request', isCurrent ? new vscode.ThemeColor('charts.green') : undefined);
    item.description = `${pr.user.login} · ${pr.head.ref} → ${pr.base.ref}${isCurrent ? ' · your branch' : ''}`;
    const md = new vscode.MarkdownString('', true);
    md.appendMarkdown(`**#${pr.number} ${escapeMd(pr.title)}**${pr.draft ? ' *(draft)*' : ''}\n\n`);
    md.appendMarkdown(`$(account) ${escapeMd(pr.user.login)} · updated ${relTime(Date.parse(pr.updated_at))}  \n`);
    md.appendMarkdown(`$(git-branch) \`${escapeMd(pr.head.label)}\` → \`${escapeMd(pr.base.label)}\`\n\n`);
    if (pr.body) md.appendMarkdown(escapeMd(pr.body.slice(0, 400)) + (pr.body.length > 400 ? '…' : ''));
    item.tooltip = md;
    item.contextValue = 'pr;';
    item.id = `${m.root}:pr:${pr.number}`;
    return new Node(item, { kind: 'pr', model: m, gh, pr }, async () => {
      try {
        const [files, cmp] = await Promise.all([
          this.github.pullRequestFiles(gh.owner, gh.repo, pr.number),
          this.github.get(`/repos/${gh.owner}/${gh.repo}/compare/${pr.base.sha}...${pr.head.sha}`, { createIfNone: false }),
        ]);
        const baseSha = cmp.merge_base_commit ? cmp.merge_base_commit.sha : pr.base.sha;
        const headRepo = pr.head.repo ? { owner: pr.head.repo.owner.login, repo: pr.head.repo.name } : gh;
        const list = files.map(f => ({ path: f.filename, origPath: f.previous_filename, status: PR_STATUS[f.status] || 'M', added: f.additions, deleted: f.deletions }));
        return fileNodes(m.root, list, f => ({
          kind: 'prFile', contextValue: 'prFile;', stats: `+${f.added} −${f.deleted}`,
          command: { command: 'gitCompass.openPullRequestFileDiff', title: 'Open', arguments: [{ root: m.root, gh, headRepo, base: baseSha, head: pr.head.sha, file: f, number: pr.number }] },
          data: { model: m, pr },
        }), `${m.root}:pr:${pr.number}`);
      } catch (e) {
        return [message(`Could not load files: ${e.message}`, 'error')];
      }
    });
  }
}

/** Diff for a single file of a pull request, fetched through the GitHub API. */
async function openPullRequestFileDiff({ root, gh, headRepo, base, head, file, number }) {
  const { gitUri, emptyUri } = require('../diff');
  const left = file.status === 'A' ? emptyUri(root, file.path) : gitUri(root, file.origPath || file.path, base, { gh });
  const right = file.status === 'D' ? emptyUri(root, file.path) : gitUri(root, file.path, head, { gh: headRepo });
  await vscode.commands.executeCommand('vscode.diff', left, right, `${basename(file.path)} (PR #${number})`, { preview: true });
}

function samePath(a, b) {
  const n = p => path.normalize(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

module.exports = {
  ChangesTree, CommitsTree, BranchesTree, WorktreesTree, TagsTree, StashesTree, FileHistoryTree, CompareTree, ReflogTree,
  PullRequestsTree, openPullRequestFileDiff, humanizeReflog, commitTooltip, openRefDiff,
};
