'use strict';
// Shared tree node builders used by all tree views.

const vscode = require('vscode');
const path = require('path');
const { statusInfo, relTime, fullDate, short, escapeMd, basename, dirname, nestFiles, cfg } = require('../util');
const { openRefDiff } = require('../diff');

const STATUS_SCHEME = 'gitcompass-status';

/** Generic node: holds a TreeItem plus optional lazy children and arbitrary data. */
class Node {
  constructor(item, data = {}, children) {
    this.item = item;
    Object.assign(this, data);
    this._children = children;
  }
  async getChildren() { return this._children ? this._children() : []; }
}

class BaseTree {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }
  refresh(node) { this._onDidChangeTreeData.fire(node); }
  getTreeItem(node) { return node.item; }
  getChildren(node) { return node ? node.getChildren() : this.roots(); }
  async roots() { return []; }
}

/** Decorates our tree items with the coloured status letter (M, A, D, U, …). */
class StatusDecorationProvider {
  provideFileDecoration(uri) {
    if (uri.scheme !== STATUS_SCHEME || !uri.query) return undefined;
    const info = statusInfo(uri.query);
    return new vscode.FileDecoration(info.short, info.label, new vscode.ThemeColor(info.color));
  }
}

function decoratedUri(root, rel, status) {
  return vscode.Uri.file(path.join(root, ...rel.split('/'))).with({ scheme: STATUS_SCHEME, query: status || '' });
}

function message(text, icon = 'info', command) {
  const item = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(icon);
  if (command) item.command = command;
  item.contextValue = 'message';
  return new Node(item, { kind: 'message' });
}

function loadMoreNode(viewKey, label = 'Load more…') {
  const item = new vscode.TreeItem(label);
  item.iconPath = new vscode.ThemeIcon('ellipsis');
  item.command = { command: 'gitCompass.loadMore', title: 'Load more', arguments: [viewKey] };
  return new Node(item, { kind: 'loadMore' });
}

function commitTooltip(c, extra = {}) {
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = true;
  md.supportThemeIcons = true;
  md.appendMarkdown(`**${escapeMd(c.subject)}**\n\n`);
  md.appendMarkdown(`$(account) ${escapeMd(c.author)}${c.email ? ` <${escapeMd(c.email)}>` : ''}  \n`);
  md.appendMarkdown(`$(clock) ${fullDate(c.date)} (${relTime(c.date)})  \n`);
  md.appendMarkdown(`$(git-commit) \`${short(c.sha)}\`${c.parents.length > 1 ? ' — merge commit' : ''}  \n`);
  const refs = (c.refs || []).filter(r => r.type !== 'head');
  if (refs.length) md.appendMarkdown(`$(tag) ${refs.map(r => `\`${escapeMd(r.name)}\``).join(' ')}  \n`);
  if (extra.unpushed) md.appendMarkdown(`\n$(arrow-up) *Not pushed yet — this commit exists only on your computer.*`);
  if (extra.incoming) md.appendMarkdown(`\n$(arrow-down) *On the remote but not on your computer yet — Pull to get it.*`);
  return md;
}

function refsLabel(c) {
  return (c.refs || []).filter(r => r.type !== 'head' && r.type !== 'stash').map(r => r.type === 'tag' ? `🏷 ${r.name}` : r.name).join(', ');
}

/**
 * @param {import('../repoManager').RepoModel} model
 * @param {object} c commit
 */
function commitNode(model, c, opts = {}) {
  const item = new vscode.TreeItem(c.subject || '(no message)', opts.noFiles ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
  const refs = refsLabel(c);
  item.description = [refs && `⎇ ${refs}`, opts.description ?? `${c.author}, ${relTime(c.date)}`].filter(Boolean).join('  ');
  let icon;
  if (opts.unpushed) icon = new vscode.ThemeIcon('arrow-circle-up', new vscode.ThemeColor('charts.orange'));
  else if (opts.incoming) icon = new vscode.ThemeIcon('arrow-circle-down', new vscode.ThemeColor('charts.blue'));
  else if (c.parents.length > 1) icon = new vscode.ThemeIcon('git-merge');
  else icon = new vscode.ThemeIcon('git-commit');
  item.iconPath = icon;
  item.tooltip = commitTooltip(c, opts);
  item.id = opts.idPrefix ? `${opts.idPrefix}:${c.sha}` : undefined;
  const flags = ['commit'];
  if (opts.unpushed) flags.push('unpushed');
  if (opts.isHead) flags.push('head');
  if (opts.fileHistory) flags.push('fileHistory');
  item.contextValue = flags.join(';') + ';';
  if (opts.command) item.command = opts.command;
  return new Node(item, { kind: 'commit', model, commit: c, root: model.root, file: opts.file }, async () => {
    const files = await model.repo.commitFiles(c.sha, c.parents);
    if (!files.length) return [message('No file changes (empty commit)')];
    return fileNodes(model.root, files, f => ({
      kind: 'commitFile',
      contextValue: 'commitFile;',
      command: { command: 'gitCompass.openCommitFileDiff', title: 'Open Changes', arguments: [{ root: model.root, commit: c, file: f }] },
      data: { model, commit: c, file: f },
      stats: f.added !== undefined && f.added !== null ? `+${f.added} −${f.deleted}` : '',
    }), opts.idPrefix ? `${opts.idPrefix}:${c.sha}` : undefined);
  });
}

/**
 * Build file (and optionally folder) nodes.
 * @param {(f:any) => {kind:string, contextValue:string, command?:any, data?:any, stats?:string}} describe
 */
function fileNodes(root, files, describe, idPrefix, forceFlat = false) {
  const asTree = !forceFlat && cfg('viewAsTree', false);
  const build = entries => entries.map(e => {
    if (e.type === 'folder') {
      const item = new vscode.TreeItem(e.name, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = vscode.ThemeIcon.Folder;
      item.resourceUri = decoratedUri(root, e.path, '');
      item.id = idPrefix ? `${idPrefix}:dir:${e.path}` : undefined;
      item.contextValue = 'folder;';
      return new Node(item, { kind: 'folder', root, folderPath: e.path }, async () => build(e.children));
    }
    const d = describe(e);
    const info = statusInfo(e.status);
    const item = new vscode.TreeItem(decoratedUri(root, e.path, e.status), vscode.TreeItemCollapsibleState.None);
    item.label = basename(e.path);
    const desc = [];
    if (!asTree && dirname(e.path)) desc.push(dirname(e.path));
    if (e.origPath && e.origPath !== e.path) desc.push(`← ${basename(e.origPath)}`);
    if (d.stats) desc.push(d.stats);
    item.description = desc.join('  ');
    item.tooltip = `${e.path}\n${info.label}${e.origPath ? ` (from ${e.origPath})` : ''}${e.conflict ? ` — ${e.conflict}` : ''}`;
    item.iconPath = vscode.ThemeIcon.File;
    item.contextValue = d.contextValue;
    item.id = idPrefix ? `${idPrefix}:${e.path}` : undefined;
    if (d.command) item.command = d.command;
    return new Node(item, { kind: d.kind, root, file: e, ...(d.data || {}) });
  });
  return build(nestFiles(files, asTree));
}

async function openCommitFileDiff({ root, commit, file }) {
  const parent = commit.parents[0] || null;
  await openRefDiff(root, file, parent, commit.sha);
}

module.exports = {
  Node, BaseTree, StatusDecorationProvider, STATUS_SCHEME, decoratedUri, message, loadMoreNode,
  commitNode, commitTooltip, fileNodes, openCommitFileDiff, refsLabel,
};
