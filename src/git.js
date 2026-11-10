'use strict';
// Low-level Git wrapper. Has NO dependency on the `vscode` module so it can be unit-tested
// with plain Node. Every git call goes through Git.exec().

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const US = '\x1f'; // unit separator (between fields)
const RS = '\x1e'; // record separator (between records)

class GitError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'GitError';
    this.args = info.args || [];
    this.stdout = info.stdout || '';
    this.stderr = info.stderr || '';
    this.exitCode = info.exitCode;
    this.notFound = !!info.notFound;
  }
  /** Short human readable description of what went wrong. */
  get friendly() {
    return friendlyError(this.stderr || this.message, this.stdout);
  }
}

/** Translate common git error output into something a beginner understands. */
function friendlyError(stderr, stdout = '') {
  const s = `${stderr}\n${stdout}`;
  const rules = [
    [/not a git repository/i, 'This folder is not a Git repository.'],
    [/Authentication failed|could not read Username|terminal prompts disabled|Permission denied \(publickey\)/i,
      'Authentication with the remote failed. Sign in (e.g. to GitHub) or check your SSH key / credentials.'],
    [/Could not resolve host|unable to access/i, 'Could not reach the remote server. Check your internet connection and the remote URL.'],
    [/\[rejected\].*\(fetch first\)|non-fast-forward|Updates were rejected/i,
      'The remote has commits you don\'t have yet. Pull (or Sync) first, then push again.'],
    [/Your local changes to the following files would be overwritten/i,
      'You have uncommitted changes that would be overwritten. Commit or stash them first.'],
    [/untracked working tree files would be overwritten/i,
      'Some new (untracked) files would be overwritten. Commit, stash (with untracked) or move them first.'],
    [/CONFLICT|Automatic merge failed|could not apply|Resolve all conflicts/i,
      'There are merge conflicts. Resolve them in the Changes view, then press Continue.'],
    [/nothing to commit/i, 'There is nothing to commit.'],
    [/no changes added to commit/i, 'No changes are staged for commit.'],
    [/Please tell me who you are|empty ident name|unable to auto-detect email/i,
      'Git does not know your name/email yet. Use "Git Compass: Set Your Name & Email".'],
    [/not fully merged/i, 'This branch contains commits that are not merged anywhere. Use force delete if you really want to lose them.'],
    [/already exists/i, 'Something with that name already exists.'],
    [/does not have any commits yet|bad default revision 'HEAD'|unknown revision or path not in the working tree.*HEAD/i,
      'This repository has no commits yet. Make your first commit.'],
    [/There is no tracking information for the current branch|has no upstream branch/i,
      'This branch is not connected to a remote branch yet. Use Publish branch.'],
    [/index\.lock/i, 'Another Git process is running (index.lock exists). Wait a moment, or delete .git/index.lock if no Git process is running.'],
    [/refusing to merge unrelated histories/i, 'The two branches have no common history.'],
    [/already (checked out|used by worktree) at|used by worktree at/i,
      'This branch is checked out in another worktree. A branch can be active in only one worktree at a time — open that worktree instead (Worktrees view).'],
    [/is a main working tree/i, 'The main worktree (the original folder) cannot be removed.'],
    [/contains modified or untracked files/i, 'The worktree has uncommitted changes. Commit/stash them, or force the removal.'],
  ];
  for (const [re, msg] of rules) if (re.test(s)) return msg;
  const firstLine = (stderr || stdout || '').split('\n').map(l => l.trim()).find(l => l && !l.startsWith('hint:'));
  return firstLine ? firstLine.replace(/^(fatal|error): /, '') : 'Git command failed.';
}

class Git {
  /**
   * @param {{path?: string, log?: (line: string) => void}} opts
   */
  constructor(opts = {}) {
    this.path = opts.path || 'git';
    this.log = opts.log || (() => {});
  }

  /**
   * Run git. Resolves {stdout, stderr, exitCode}. Rejects with GitError on non-zero exit
   * (unless the exit code is listed in options.okCodes).
   */
  exec(cwd, args, options = {}) {
    return new Promise((resolve, reject) => {
      const fullArgs = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args];
      const env = Object.assign({}, process.env, {
        GIT_TERMINAL_PROMPT: '0',
        GIT_EDITOR: 'true', // never block waiting for an interactive editor
        LANGUAGE: 'en',
        LC_MESSAGES: 'C',
      }, options.env || {});
      const started = Date.now();
      let child;
      try {
        child = cp.spawn(this.path, fullArgs, { cwd, env, windowsHide: true });
      } catch (e) {
        reject(new GitError(e.message, { args, exitCode: -1, notFound: e.code === 'ENOENT' }));
        return;
      }
      const out = [];
      const err = [];
      child.stdout.on('data', d => out.push(d));
      child.stderr.on('data', d => err.push(d));
      child.on('error', e => {
        const notFound = e.code === 'ENOENT';
        reject(new GitError(notFound ? 'Git is not installed or not on PATH.' : e.message, { args, exitCode: -1, notFound }));
      });
      child.on('close', code => {
        const stdoutBuf = Buffer.concat(out);
        const stderr = Buffer.concat(err).toString('utf8');
        if (!options.quiet) {
          this.log(`git ${args.map(quoteArg).join(' ')}  (${Date.now() - started} ms${code ? `, exit ${code}` : ''})`);
          if (code && stderr.trim()) this.log('  ' + stderr.trim().split('\n').join('\n  '));
        }
        const stdout = options.buffer ? stdoutBuf : stdoutBuf.toString('utf8');
        if (code !== 0 && !(options.okCodes || []).includes(code)) {
          reject(new GitError(friendlyError(stderr, String(stdout)), { args, stdout: String(stdout), stderr, exitCode: code }));
        } else {
          resolve({ stdout, stderr, exitCode: code });
        }
      });
      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    });
  }

  async version() {
    const { stdout } = await this.exec(process.cwd(), ['--version'], { quiet: true });
    return stdout.trim();
  }

  /** Returns the repository root (native path) for any path inside a repo, or null. */
  async findRoot(dir) {
    try {
      const { stdout } = await this.exec(dir, ['rev-parse', '--show-toplevel'], { quiet: true });
      const root = stdout.trim();
      return root ? path.normalize(root) : null;
    } catch {
      return null;
    }
  }
}

function quoteArg(a) {
  return /[\s"'$`]/.test(a) ? JSON.stringify(a) : a;
}

// ---------------------------------------------------------------------------------------------
// Parsers (exported for tests)
// ---------------------------------------------------------------------------------------------

function splitN(s, n) {
  const res = [];
  let pos = 0;
  for (let k = 0; k < n; k++) {
    const sp = s.indexOf(' ', pos);
    if (sp === -1) { res.push(s.slice(pos)); pos = s.length; continue; }
    res.push(s.slice(pos, sp));
    pos = sp + 1;
  }
  res.push(s.slice(pos));
  return res;
}

/** Parse `git status --porcelain=v2 -z --branch` */
function parseStatus(text) {
  const r = {
    oid: null, branch: null, detached: false, upstream: null, ahead: 0, behind: 0, initial: false,
    staged: [], unstaged: [], untracked: [], conflicts: [],
  };
  const parts = text.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# ')) {
      const sp = line.indexOf(' ', 2);
      const key = line.slice(2, sp === -1 ? undefined : sp);
      const val = sp === -1 ? '' : line.slice(sp + 1);
      if (key === 'branch.oid') { if (val === '(initial)') r.initial = true; else r.oid = val; }
      else if (key === 'branch.head') { if (val === '(detached)') r.detached = true; else r.branch = val; }
      else if (key === 'branch.upstream') r.upstream = val;
      else if (key === 'branch.ab') {
        const m = /\+(\d+) -(\d+)/.exec(val);
        if (m) { r.ahead = +m[1]; r.behind = +m[2]; }
      }
      continue;
    }
    const type = line[0];
    if (type === '1' || type === '2') {
      const f = splitN(line, type === '1' ? 8 : 9);
      const xy = f[1];
      const p = f[f.length - 1];
      let origPath;
      if (type === '2') origPath = parts[++i];
      if (xy[0] !== '.') r.staged.push({ path: p, origPath: xy[0] === 'R' || xy[0] === 'C' ? origPath : undefined, status: xy[0] });
      if (xy[1] !== '.') r.unstaged.push({ path: p, origPath: xy[1] === 'R' || xy[1] === 'C' ? origPath : undefined, status: xy[1] });
    } else if (type === 'u') {
      const f = splitN(line, 10);
      r.conflicts.push({ path: f[10], status: f[1], conflict: describeConflict(f[1]) });
    } else if (type === '?') {
      r.untracked.push({ path: line.slice(2), status: '?' });
    }
  }
  return r;
}

function describeConflict(xy) {
  return ({
    UU: 'both modified', AA: 'both added', DD: 'both deleted',
    AU: 'added by us', UA: 'added by them', DU: 'deleted by us', UD: 'deleted by them',
  })[xy] || 'conflict';
}

const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ct', '%D', '%s'].join('%x1f') + '%x1e';

function parseRefs(d) {
  const refs = [];
  if (!d) return refs;
  for (let part of d.split(', ')) {
    part = part.trim();
    let current = false;
    if (part.startsWith('HEAD -> ')) { current = true; part = part.slice(8); }
    else if (part === 'HEAD') { refs.push({ type: 'head', name: 'HEAD' }); continue; }
    if (part.startsWith('tag: ')) part = part.slice(5);
    if (part.startsWith('refs/heads/')) refs.push({ type: 'branch', name: part.slice(11), current });
    else if (part.startsWith('refs/remotes/')) {
      const n = part.slice(13);
      if (!n.endsWith('/HEAD')) refs.push({ type: 'remote', name: n });
    } else if (part.startsWith('refs/tags/')) refs.push({ type: 'tag', name: part.slice(10) });
    else if (part === 'refs/stash') refs.push({ type: 'stash', name: 'stash' });
  }
  return refs;
}

function parseLog(text) {
  return text.split(RS).map(s => s.replace(/^\s+/, '')).filter(Boolean).map(rec => {
    const [sha, parents, author, email, at, committer, ct, refs, subject] = rec.split(US);
    return {
      sha,
      parents: parents ? parents.trim().split(' ').filter(Boolean) : [],
      author, email,
      date: +at * 1000,
      committer,
      commitDate: +ct * 1000,
      refs: parseRefs(refs),
      subject: subject || '',
    };
  });
}

function parseNameStatus(text) {
  const parts = text.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (!s) continue;
    const st = s[0];
    if (st === 'R' || st === 'C') {
      files.push({ status: st, origPath: parts[i + 1], path: parts[i + 2] });
      i += 2;
    } else {
      files.push({ status: st, path: parts[i + 1] });
      i += 1;
    }
  }
  return files;
}

function parseNumstat(text) {
  const parts = text.split('\0');
  const map = new Map();
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (!s) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(s);
    if (!m) continue;
    let p = m[3];
    if (p === '') { p = parts[i + 2]; i += 2; } // rename: \0old\0new
    map.set(p, { added: m[1] === '-' ? null : +m[1], deleted: m[2] === '-' ? null : +m[2] });
  }
  return map;
}

const REF_FORMAT = [
  '%(refname)', '%(objectname)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(HEAD)',
  '%(committerdate:unix)', '%(contents:subject)', '%(authorname)', '%(*objectname)', '%(upstream:remotename)',
].join('%1f');

function parseRefList(text, remoteNames = []) {
  const res = { local: [], remote: [], tags: [] };
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [refname, sha, upstream, track, head, date, subject, author, peeled, upstreamRemote] = line.split(US);
    const common = { sha, date: +date * 1000, subject, author };
    if (refname.startsWith('refs/heads/')) {
      let ahead = 0, behind = 0;
      const a = /ahead (\d+)/.exec(track || ''); if (a) ahead = +a[1];
      const b = /behind (\d+)/.exec(track || ''); if (b) behind = +b[1];
      res.local.push({
        ...common, name: refname.slice(11), upstream: upstream || null, upstreamRemote: upstreamRemote || null,
        ahead, behind, gone: track === 'gone', current: head === '*',
      });
    } else if (refname.startsWith('refs/remotes/')) {
      const full = refname.slice(13);
      if (full.endsWith('/HEAD')) continue;
      let remote = remoteNames.filter(r => full.startsWith(r + '/')).sort((x, y) => y.length - x.length)[0];
      if (!remote) remote = full.split('/')[0];
      res.remote.push({ ...common, name: full, remote, branch: full.slice(remote.length + 1) });
    } else if (refname.startsWith('refs/tags/')) {
      res.tags.push({ ...common, name: refname.slice(10), sha: peeled || sha, annotated: !!peeled });
    }
  }
  return res;
}

/** Parse `git worktree list --porcelain`. The first entry is always the main worktree. */
function parseWorktrees(text) {
  const list = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: path.normalize(line.slice(9)), sha: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
      list.push(cur);
    } else if (!cur || !line) continue;
    else if (line.startsWith('HEAD ')) cur.sha = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line.startsWith('locked')) { cur.locked = true; cur.lockReason = line.slice(7).trim(); }
    else if (line.startsWith('prunable')) { cur.prunable = true; cur.prunableReason = line.slice(9).trim(); }
  }
  list.forEach((w, i) => { w.main = i === 0; });
  return list;
}

function parseBlame(text) {
  const lines = text.split('\n');
  const commits = new Map();
  const result = []; // 1-based final line -> commit info
  let i = 0;
  while (i < lines.length) {
    const m = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: (\d+))?$/.exec(lines[i]);
    if (!m) { i++; continue; }
    const sha = m[1];
    const finalLine = +m[3];
    let c = commits.get(sha);
    if (!c) { c = { sha, uncommitted: /^0+$/.test(sha) }; commits.set(sha, c); }
    i++;
    while (i < lines.length && !lines[i].startsWith('\t')) {
      const l = lines[i];
      const sp = l.indexOf(' ');
      const key = sp === -1 ? l : l.slice(0, sp);
      const val = sp === -1 ? '' : l.slice(sp + 1);
      switch (key) {
        case 'author': c.author = val; break;
        case 'author-mail': c.email = val.replace(/[<>]/g, ''); break;
        case 'author-time': c.date = +val * 1000; break;
        case 'summary': c.summary = val; break;
        case 'filename': c.filename = val; break;
        case 'previous': {
          const sp2 = val.indexOf(' ');
          c.previous = val.slice(0, sp2);
          c.previousPath = val.slice(sp2 + 1);
          break;
        }
      }
      i++;
    }
    i++; // skip the "\t<content>" line
    result[finalLine] = c;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Repository: higher level read operations
// ---------------------------------------------------------------------------------------------

class Repository {
  /**
   * @param {Git} git
   * @param {string} root native absolute path of the work tree
   */
  constructor(git, root) {
    this.git = git;
    this.root = root;
    this.gitDir = null;
    this.commonDir = null;
  }

  run(args, options) { return this.git.exec(this.root, args, options); }
  async out(args, options) { return (await this.run(args, options)).stdout; }

  async init() {
    const out = await this.out(['rev-parse', '--absolute-git-dir', '--git-common-dir'], { quiet: true });
    const [gitDir, commonDir] = out.trim().split('\n');
    this.gitDir = path.normalize(gitDir);
    this.commonDir = path.isAbsolute(commonDir) ? path.normalize(commonDir) : path.resolve(this.root, commonDir);
    return this;
  }

  toRel(absPath) { return path.relative(this.root, absPath).split(path.sep).join('/'); }
  toAbs(rel) { return path.join(this.root, ...rel.split('/')); }

  async status() {
    const out = await this.out(['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], { quiet: true });
    return parseStatus(out);
  }

  /** Which multi-step operation (merge, rebase, …) is in progress, if any. */
  operation() {
    const g = this.gitDir;
    if (!g) return null;
    const ex = f => fs.existsSync(path.join(g, f));
    if (ex('rebase-merge') || ex('rebase-apply')) {
      let step = null;
      try {
        const dir = ex('rebase-merge') ? 'rebase-merge' : 'rebase-apply';
        const n = fs.readFileSync(path.join(g, dir, ex('rebase-merge') ? 'msgnum' : 'next'), 'utf8').trim();
        const t = fs.readFileSync(path.join(g, dir, ex('rebase-merge') ? 'end' : 'last'), 'utf8').trim();
        step = `${n}/${t}`;
      } catch { /* ignore */ }
      let onto = null;
      try { onto = fs.readFileSync(path.join(g, 'rebase-merge', 'head-name'), 'utf8').trim().replace('refs/heads/', ''); } catch { /* ignore */ }
      return { kind: 'rebase', step, branch: onto };
    }
    if (ex('MERGE_HEAD')) return { kind: 'merge' };
    if (ex('CHERRY_PICK_HEAD')) return { kind: 'cherry-pick' };
    if (ex('REVERT_HEAD')) return { kind: 'revert' };
    if (ex('BISECT_LOG')) return { kind: 'bisect' };
    return null;
  }

  async log(opts = {}) {
    const {
      refs, maxCount = 100, skip = 0, file, follow = true, grep, author, content, all = false,
      order = 'date', firstParent = false,
    } = opts;
    const args = ['log', `--format=${LOG_FORMAT}`, '--decorate=full', `-n${maxCount}`];
    if (skip) args.push(`--skip=${skip}`);
    if (order === 'date') args.push('--date-order');
    else if (order === 'topo') args.push('--topo-order');
    if (firstParent) args.push('--first-parent');
    if (grep) args.push(`--grep=${grep}`, '--regexp-ignore-case', '--fixed-strings');
    if (author) args.push(`--author=${author}`, '--regexp-ignore-case');
    if (content) args.push(`-S${content}`);
    if (file && follow) args.push('--follow');
    if (all) args.push('--branches', '--remotes', '--tags', 'HEAD');
    else if (refs && refs.length) args.push(...refs);
    args.push('--');
    if (file) args.push(file);
    try {
      return parseLog(await this.out(args, { quiet: true }));
    } catch (e) {
      if (/does not have any commits|bad default revision|unknown revision|ambiguous argument 'HEAD'/i.test(e.stderr || '')) return [];
      throw e;
    }
  }

  /** History of one file (following renames). Each commit gets {filePath, fileOrigPath, fileStatus}. */
  async fileHistory(rel, maxCount = 200) {
    const commits = await this.log({ file: rel, follow: true, maxCount, order: 'none' });
    if (!commits.length) return commits;
    let out = '';
    try {
      out = await this.out(['log', '--follow', `-n${maxCount}`, '--format=%x1e%H', '--name-status', '-M', '--', rel], { quiet: true });
    } catch { /* ignore */ }
    const map = new Map();
    for (const rec of out.split(RS)) {
      const lines = rec.split('\n').filter(Boolean);
      if (!lines.length) continue;
      const sha = lines[0];
      const st = (lines[1] || '').split('\t');
      if (st.length >= 3) map.set(sha, { status: st[0][0], origPath: st[1], path: st[2] });
      else if (st.length === 2) map.set(sha, { status: st[0][0], path: st[1] });
    }
    for (const c of commits) {
      const f = map.get(c.sha) || { status: 'M', path: rel };
      c.filePath = f.path;
      c.fileOrigPath = f.origPath;
      c.fileStatus = f.status;
    }
    return commits;
  }

  async commit(sha) {
    const out = await this.out(['show', '-s', `--format=${LOG_FORMAT}%B`, '--decorate=full', sha], { quiet: true });
    const idx = out.indexOf(RS);
    const c = parseLog(out.slice(0, idx + 1))[0];
    c.body = out.slice(idx + 1).trim();
    return c;
  }

  async commitFiles(sha, parents) {
    let ns, num;
    if (!parents || parents.length === 0) {
      ns = await this.out(['diff-tree', '--root', '--no-commit-id', '-r', '-z', '-M', '--name-status', sha], { quiet: true });
      num = await this.out(['diff-tree', '--root', '--no-commit-id', '-r', '-z', '-M', '--numstat', sha], { quiet: true });
    } else {
      ns = await this.out(['diff', '-z', '-M', '--name-status', parents[0], sha], { quiet: true });
      num = await this.out(['diff', '-z', '-M', '--numstat', parents[0], sha], { quiet: true });
    }
    const stats = parseNumstat(num);
    return parseNameStatus(ns).map(f => Object.assign(f, stats.get(f.path) || {}));
  }

  async diffFiles(from, to) {
    const args = ['diff', '-z', '-M', '--name-status', from];
    if (to) args.push(to);
    return parseNameStatus(await this.out(args, { quiet: true }));
  }

  async remotes() {
    const out = await this.out(['remote', '-v'], { quiet: true });
    const map = new Map();
    for (const line of out.split('\n')) {
      const m = /^(\S+)\t(\S+) \((fetch|push)\)$/.exec(line);
      if (!m) continue;
      const r = map.get(m[1]) || { name: m[1] };
      r[m[3] === 'fetch' ? 'fetchUrl' : 'pushUrl'] = m[2];
      map.set(m[1], r);
    }
    return [...map.values()];
  }

  async refs(remoteNames) {
    const out = await this.out(['for-each-ref', `--format=${REF_FORMAT}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes', 'refs/tags'], { quiet: true });
    return parseRefList(out, remoteNames);
  }

  /** Cheap fingerprint of all refs + HEAD: changes whenever a commit/branch/tag/stash changes. */
  async refsSignature() {
    const [refs, head] = await Promise.all([
      this.out(['for-each-ref', '--format=%(refname) %(objectname)'], { quiet: true }),
      this.out(['rev-parse', '--symbolic-full-name', 'HEAD'], { quiet: true, okCodes: [128] }).catch(() => ''),
    ]);
    return head + '\n' + refs;
  }

  async stashes() {
    const out = await this.out(['stash', 'list', '--date=unix', `--format=%gd${'%x1f'}%H${'%x1f'}%P${'%x1f'}%gs`], { quiet: true });
    return out.split('\n').filter(Boolean).map((line, index) => {
      const [sel, sha, parents, msg] = line.split(US);
      const t = /\{(\d+)\}/.exec(sel);
      return {
        index, ref: `stash@{${index}}`, sha, parents: parents.split(' '),
        date: t ? +t[1] * 1000 : 0, message: msg || '',
      };
    });
  }

  async stashFiles(index) {
    const ref = `stash@{${index}}`;
    let files;
    try {
      files = parseNameStatus(await this.out(['stash', 'show', '--name-status', '-z', '--include-untracked', ref], { quiet: true }));
    } catch {
      files = parseNameStatus(await this.out(['stash', 'show', '--name-status', '-z', ref], { quiet: true }));
    }
    return files;
  }

  async reflog(max = 200) {
    let out;
    try {
      out = await this.out(['reflog', 'show', '--date=unix', `-n${max}`, `--format=%H${'%x1f'}%gd${'%x1f'}%gs${'%x1f'}%s`, 'HEAD'], { quiet: true });
    } catch { return []; }
    return out.split('\n').filter(Boolean).map((line, index) => {
      const [sha, sel, action, subject] = line.split(US);
      const t = /\{(\d+)\}/.exec(sel);
      return { index, sha, ref: `HEAD@{${index}}`, date: t ? +t[1] * 1000 : 0, action, subject };
    });
  }

  /** Contents of `rel` at `ref` (''=index). Returns Buffer, or null if it does not exist. */
  async show(ref, rel) {
    const spec = ref === ':' || ref === '' ? `:${rel}` : /^:\d:$/.test(ref) ? `${ref}${rel}` : `${ref}:${rel}`;
    try {
      return (await this.run(['show', spec], { quiet: true, buffer: true })).stdout;
    } catch {
      return null;
    }
  }

  async blame(rel, contents) {
    const args = ['blame', '--porcelain'];
    if (contents !== undefined) args.push('--contents', '-');
    args.push('--', rel);
    const out = await this.out(args, { quiet: true, input: contents });
    return parseBlame(out);
  }

  async aheadBehind(a, b) {
    const out = await this.out(['rev-list', '--left-right', '--count', `${a}...${b}`], { quiet: true });
    const [left, right] = out.trim().split(/\s+/).map(Number);
    return { ahead: left, behind: right };
  }

  /** SHAs on HEAD not yet on the upstream (or on any remote if there is no upstream). */
  async unpushed(hasUpstream) {
    try {
      const args = hasUpstream ? ['rev-list', '@{u}..HEAD'] : ['rev-list', 'HEAD', '--not', '--remotes'];
      const out = await this.out(args, { quiet: true });
      return new Set(out.split('\n').filter(Boolean));
    } catch { return new Set(); }
  }

  async mergeBase(a, b) {
    try { return (await this.out(['merge-base', a, b], { quiet: true })).trim(); } catch { return null; }
  }

  async config(key) {
    try { return (await this.out(['config', '--get', key], { quiet: true })).trim(); } catch { return ''; }
  }

  async revParse(ref) {
    try { return (await this.out(['rev-parse', '--verify', '--quiet', ref + '^{commit}'], { quiet: true })).trim(); } catch { return null; }
  }

  /** Is `sha` contained in any remote-tracking branch (i.e. already pushed)? */
  async worktrees() {
    try {
      return parseWorktrees(await this.out(['worktree', 'list', '--porcelain'], { quiet: true }));
    } catch { return []; }
  }

  /** True when this work tree is a linked worktree (not the original repository folder). */
  get isLinkedWorktree() {
    return !!(this.gitDir && this.commonDir && path.normalize(this.gitDir) !== path.normalize(this.commonDir));
  }

  async isPushed(sha) {
    try {
      const out = await this.out(['branch', '-r', '--contains', sha], { quiet: true });
      return out.trim().length > 0;
    } catch { return false; }
  }

  /**
   * Interactive rebase without an editor. `todo` is an array of {action, sha, message?}
   * in git order (oldest first). Reword messages are applied with an `exec` step.
   */
  async rebaseInteractive(base, todo, { autostash = true } = {}) {
    // Reword messages live inside .git so they survive if the rebase pauses (conflict / edit).
    const tmp = path.join(this.gitDir || os.tmpdir(), 'git-compass-rebase');
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.mkdirSync(tmp, { recursive: true });
    const fwd = p => p.replace(/\\/g, '/');
    const lines = [];
    todo.forEach((t, i) => {
      if (t.action === 'reword') {
        const msgFile = path.join(tmp, `msg-${i}.txt`);
        fs.writeFileSync(msgFile, t.message || '');
        lines.push(`pick ${t.sha}`);
        lines.push(`exec git commit --amend --allow-empty --no-verify -F "${fwd(msgFile)}"`);
      } else {
        lines.push(`${t.action} ${t.sha}`);
      }
    });
    const todoFile = path.join(tmp, 'todo.txt');
    fs.writeFileSync(todoFile, lines.join('\n') + '\n');
    const args = ['rebase', '-i'];
    if (autostash) args.push('--autostash');
    args.push(base ? base : '--root');
    return this.run(args, {
      env: { GIT_SEQUENCE_EDITOR: `cp "${fwd(todoFile)}"`, GIT_EDITOR: 'true' },
    });
  }
}

module.exports = {
  Git, GitError, Repository, friendlyError,
  parseStatus, parseLog, parseRefs, parseNameStatus, parseNumstat, parseRefList, parseBlame, parseWorktrees,
  LOG_FORMAT,
};
