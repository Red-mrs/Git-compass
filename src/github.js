'use strict';
// Minimal GitHub REST client. Authentication uses VS Code's built-in GitHub sign-in
// (Accounts menu), so no personal access token has to be created or copied.

const vscode = require('vscode');

const SCOPES = ['repo', 'read:user'];

function parseGitHubUrl(url) {
  if (!url) return null;
  const m = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** First GitHub remote of a repo state (prefers "origin", then "upstream"). */
function githubRemote(remotes) {
  const list = (remotes || []).map(r => ({ remote: r.name, ...parseGitHubUrl(r.fetchUrl || r.pushUrl) })).filter(r => r.owner);
  return list.find(r => r.remote === 'origin') || list.find(r => r.remote === 'upstream') || list[0] || null;
}

class GitHub {
  constructor(output) {
    this.output = output;
    this._onDidChangeSession = new vscode.EventEmitter();
    this.onDidChangeSession = this._onDidChangeSession.event;
    this.disposable = vscode.authentication.onDidChangeSessions(e => {
      if (e.provider.id === 'github') this._onDidChangeSession.fire();
    });
  }

  async session(createIfNone = false) {
    try {
      return await vscode.authentication.getSession('github', SCOPES, createIfNone ? { createIfNone: true } : { silent: true });
    } catch (e) {
      if (createIfNone) throw e;
      return undefined;
    }
  }

  async request(method, apiPath, body, { createIfNone = true, raw = false } = {}) {
    const session = await this.session(createIfNone);
    if (!session) throw new Error('Not signed in to GitHub.');
    const res = await fetch(`https://api.github.com${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'git-compass-vscode',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const j = await res.json();
        msg = j.message + (j.errors ? ': ' + j.errors.map(e => e.message || e.code).join(', ') : '');
      } catch { /* ignore */ }
      this.output.appendLine(`GitHub ${method} ${apiPath} failed: ${msg}`);
      throw new Error(`GitHub: ${msg}`);
    }
    if (res.status === 204) return null;
    return raw ? res.text() : res.json();
  }

  get(p, opts) { return this.request('GET', p, undefined, opts); }

  async currentUser() { return this.get('/user', { createIfNone: false }); }

  listPullRequests(owner, repo, state = 'open') {
    return this.get(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=50&sort=updated&direction=desc`, { createIfNone: false });
  }

  pullRequestFiles(owner, repo, number) {
    return this.get(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`, { createIfNone: false });
  }

  createPullRequest(owner, repo, data) {
    return this.request('POST', `/repos/${owner}/${repo}/pulls`, data);
  }

  repoInfo(owner, repo) { return this.get(`/repos/${owner}/${repo}`, { createIfNone: false }); }

  createRepository(name, isPrivate, description) {
    return this.request('POST', '/user/repos', { name, private: isPrivate, description, auto_init: false });
  }

  async fileContent(owner, repo, filePath, ref) {
    try {
      return await this.request('GET', `/repos/${owner}/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, undefined, { createIfNone: false, raw: true });
    } catch {
      return '';
    }
  }

  dispose() { this.disposable.dispose(); this._onDidChangeSession.dispose(); }
}

// ---- web URLs -------------------------------------------------------------------------------
const web = {
  repo: (gh) => `https://github.com/${gh.owner}/${gh.repo}`,
  commit: (gh, sha) => `https://github.com/${gh.owner}/${gh.repo}/commit/${sha}`,
  branch: (gh, branch) => `https://github.com/${gh.owner}/${gh.repo}/tree/${encodeURIComponent(branch).replace(/%2F/g, '/')}`,
  file: (gh, ref, rel, from, to) => `https://github.com/${gh.owner}/${gh.repo}/blob/${ref}/${rel.split('/').map(encodeURIComponent).join('/')}${from ? `#L${from}${to && to !== from ? `-L${to}` : ''}` : ''}`,
  compare: (gh, base, head) => `https://github.com/${gh.owner}/${gh.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1`,
  pulls: (gh) => `https://github.com/${gh.owner}/${gh.repo}/pulls`,
};

module.exports = { GitHub, parseGitHubUrl, githubRemote, web };
