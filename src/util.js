'use strict';
const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');

const STATUS = {
  M: { label: 'Modified', short: 'M', color: 'gitDecoration.modifiedResourceForeground', icon: 'diff-modified' },
  A: { label: 'Added', short: 'A', color: 'gitDecoration.addedResourceForeground', icon: 'diff-added' },
  D: { label: 'Deleted', short: 'D', color: 'gitDecoration.deletedResourceForeground', icon: 'diff-removed' },
  R: { label: 'Renamed', short: 'R', color: 'gitDecoration.renamedResourceForeground', icon: 'diff-renamed' },
  C: { label: 'Copied', short: 'C', color: 'gitDecoration.addedResourceForeground', icon: 'diff-added' },
  T: { label: 'Type changed', short: 'T', color: 'gitDecoration.modifiedResourceForeground', icon: 'diff-modified' },
  U: { label: 'Conflict', short: '!', color: 'gitDecoration.conflictingResourceForeground', icon: 'warning' },
  '?': { label: 'New file (untracked)', short: 'U', color: 'gitDecoration.untrackedResourceForeground', icon: 'diff-added' },
};

function statusInfo(letter) {
  return STATUS[letter] || STATUS[letter && letter[0]] || { label: letter, short: letter, color: 'foreground', icon: 'circle-small' };
}

function relTime(ms) {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  const units = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [604800, 'week'], [2629800, 'month'], [31557600, 'year']];
  let unit = units[0];
  for (const u of units) if (s >= u[0]) unit = u;
  const n = Math.max(1, Math.round(s / unit[0]));
  return `${n} ${unit[1]}${n === 1 ? '' : 's'} ago`;
}

function fullDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function short(sha) { return sha ? sha.slice(0, 7) : ''; }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function escapeMd(s) {
  return String(s ?? '').replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

function nonce() { return crypto.randomBytes(16).toString('base64'); }

function cfg(key, def) {
  return vscode.workspace.getConfiguration('gitCompass').get(key, def);
}

/** Build a command: link usable inside a trusted MarkdownString. */
function cmdLink(label, command, args) {
  const q = args === undefined ? '' : '?' + encodeURIComponent(JSON.stringify(args));
  return `[${label}](command:${command}${q})`;
}

function basename(p) { return path.posix.basename(p); }
function dirname(p) { const d = path.posix.dirname(p); return d === '.' ? '' : d; }

/** Standard HTML skeleton for our webviews. */
function webviewHtml(webview, extUri, { title, scripts = [], styles = [], body = '' }) {
  const n = nonce();
  const uri = f => webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', f));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${uri('common.css')}">
${styles.map(s => `<link rel="stylesheet" href="${uri(s)}">`).join('\n')}
</head>
<body>
${body}
${scripts.map(s => `<script nonce="${n}" src="${uri(s)}"></script>`).join('\n')}
</body>
</html>`;
}

/**
 * Turns a flat list of {path} entries into folder nodes when tree mode is on.
 * Returns an array of either {type:'folder', name, path, children} or the original entries.
 */
function nestFiles(files, asTree) {
  if (!asTree) return files;
  const root = { children: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.children.has(parts[i])) node.children.set(parts[i], { name: parts[i], children: new Map(), files: [], path: parts.slice(0, i + 1).join('/') });
      node = node.children.get(parts[i]);
    }
    node.files.push(f);
  }
  const convert = node => {
    const folders = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name)).map(ch => {
      // compact chains of single folders: a/b/c
      let cur = ch;
      let name = ch.name;
      while (cur.files.length === 0 && cur.children.size === 1) {
        cur = [...cur.children.values()][0];
        name += '/' + cur.name;
      }
      return { type: 'folder', name, path: cur.path, children: convert(cur) };
    });
    return [...folders, ...node.files.sort((a, b) => a.path.localeCompare(b.path))];
  };
  return convert(root);
}

module.exports = {
  statusInfo, relTime, fullDate, short, escapeHtml, escapeMd, nonce, cfg, cmdLink,
  basename, dirname, webviewHtml, nestFiles,
};
