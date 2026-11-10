'use strict';
// Virtual documents for "file at revision X" and helpers to open diffs.

const vscode = require('vscode');
const path = require('path');
const { short, basename } = require('./util');

const SCHEME = 'gitcompass';

/**
 * @param {string} root repo root (native path)
 * @param {string} rel  repo-relative path with forward slashes
 * @param {string} ref  commit-ish, ':' for the index (staged version), '' for an empty document
 * @param {object} extra extra query fields (e.g. fallbackRef, gh)
 */
function gitUri(root, rel, ref, extra = {}) {
  const abs = path.join(root, ...rel.split('/'));
  return vscode.Uri.file(abs).with({ scheme: SCHEME, query: JSON.stringify({ root, rel, ref, ...extra }) });
}

function emptyUri(root, rel) { return gitUri(root, rel, '', { empty: true }); }

class GitContentProvider {
  constructor(manager, github) {
    this.manager = manager;
    this.github = github;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
  }

  async provideTextDocumentContent(uri) {
    let q;
    try { q = JSON.parse(uri.query); } catch { return ''; }
    if (q.empty) return '';
    if (q.gh) return this.github.fileContent(q.gh.owner, q.gh.repo, q.rel, q.ref);
    const model = this.manager.findModel(q.root) || await this.manager.open(q.root).catch(() => null);
    if (!model) return '';
    let buf = await model.repo.show(q.ref, q.rel);
    if (buf === null && q.fallbackRef) buf = await model.repo.show(q.fallbackRef, q.rel);
    if (buf === null && q.ref === ':') buf = await model.repo.show('HEAD', q.rel); // conflicted: no stage 0
    return buf ? buf.toString('utf8') : '';
  }
}

function refLabel(ref) {
  if (ref === ':') return 'Staged';
  if (ref === '') return 'Empty';
  if (ref === 'HEAD') return 'HEAD';
  return /^[0-9a-f]{40,64}$/.test(ref) ? short(ref) : ref;
}

/** Open a diff between two refs of one file. A null `rightRef` means the working tree file. */
async function openRefDiff(root, file, leftRef, rightRef, opts = {}) {
  const rel = file.path;
  const leftRel = file.origPath || rel;
  const status = file.status;
  const left = status === 'A' || status === '?' || leftRef === null ? emptyUri(root, leftRel) : gitUri(root, leftRel, leftRef);
  let right;
  if (status === 'D') right = emptyUri(root, rel);
  else if (rightRef === null) right = vscode.Uri.file(path.join(root, ...rel.split('/')));
  else right = gitUri(root, rel, rightRef, opts.fallbackRef ? { fallbackRef: opts.fallbackRef } : {});
  const title = opts.title || `${basename(rel)} (${leftRef === null ? 'new' : refLabel(leftRef)} ↔ ${rightRef === null ? 'Working Tree' : refLabel(rightRef)})`;
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: opts.preview !== false, preserveFocus: !!opts.preserveFocus });
}

async function openFileAt(root, rel, ref) {
  if (ref === null) {
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, ...rel.split('/'))));
    return;
  }
  const doc = await vscode.workspace.openTextDocument(gitUri(root, rel, ref));
  await vscode.window.showTextDocument(doc, { preview: true });
}

module.exports = { SCHEME, gitUri, emptyUri, GitContentProvider, openRefDiff, openFileAt, refLabel };
