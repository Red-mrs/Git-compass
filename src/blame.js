'use strict';
// Inline "who changed this line" annotation + full-file blame + hover with details.

const vscode = require('vscode');
const { relTime, fullDate, short, escapeMd, cfg, cmdLink } = require('./util');

class BlameController {
  constructor(manager) {
    this.manager = manager;
    this.cache = new Map(); // uri -> {version, promise}
    this.fileBlameOn = new Set(); // uris with full-file blame visible
    this.lineDeco = vscode.window.createTextEditorDecorationType({
      after: { margin: '0 0 0 3em', color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic' },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    });
    this.fileDeco = vscode.window.createTextEditorDecorationType({
      before: { margin: '0 1.5em 0 0', color: new vscode.ThemeColor('editorCodeLens.foreground'), width: '28ch' },
    });
    this.timer = null;
    this.disposables = [
      this.lineDeco, this.fileDeco,
      vscode.window.onDidChangeTextEditorSelection(e => this.schedule(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor(e => { this.schedule(e); if (e) this.renderFile(e); }),
      vscode.workspace.onDidChangeTextDocument(e => {
        this.cache.delete(e.document.uri.toString());
        const ed = vscode.window.activeTextEditor;
        if (ed && ed.document === e.document) { ed.setDecorations(this.lineDeco, []); }
      }),
      vscode.workspace.onDidCloseTextDocument(d => this.cache.delete(d.uri.toString())),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('gitCompass.blame')) this.schedule(vscode.window.activeTextEditor); }),
      manager.onDidChange(e => { if (e.refsChanged) { this.cache.clear(); this.schedule(vscode.window.activeTextEditor); } }),
      vscode.languages.registerHoverProvider({ scheme: 'file' }, { provideHover: (doc, pos) => this.hover(doc, pos) }),
    ];
  }

  async blameFor(doc) {
    const key = doc.uri.toString();
    const c = this.cache.get(key);
    if (c && c.version === doc.version) return c.promise;
    const m = this.manager.modelFor(doc.uri);
    if (!m || doc.lineCount > cfg('blame.maxLines', 20000)) return null;
    const rel = m.repo.toRel(doc.uri.fsPath);
    const promise = m.repo.blame(rel, doc.isDirty ? doc.getText() : undefined).then(lines => ({ model: m, rel, lines })).catch(() => null);
    this.cache.set(key, { version: doc.version, promise });
    return promise;
  }

  schedule(editor) {
    clearTimeout(this.timer);
    if (!editor) return;
    this.timer = setTimeout(() => this.renderLine(editor), 120);
  }

  async renderLine(editor) {
    if (!cfg('blame.currentLine', true) || editor.document.uri.scheme !== 'file' || editor.selections.length !== 1) {
      editor.setDecorations(this.lineDeco, []);
      return;
    }
    const line = editor.selection.active.line;
    const b = await this.blameFor(editor.document);
    if (!b || editor !== vscode.window.activeTextEditor || editor.selection.active.line !== line) {
      if (!b) editor.setDecorations(this.lineDeco, []);
      return;
    }
    const c = b.lines[line + 1];
    if (!c) { editor.setDecorations(this.lineDeco, []); return; }
    const text = c.uncommitted
      ? 'You, not committed yet'
      : `${c.author}, ${relTime(c.date)} • ${truncate(c.summary, 60)}`;
    const end = editor.document.lineAt(line).range.end;
    editor.setDecorations(this.lineDeco, [{ range: new vscode.Range(end, end), renderOptions: { after: { contentText: text } } }]);
  }

  async toggleFileBlame() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const key = ed.document.uri.toString();
    if (this.fileBlameOn.has(key)) { this.fileBlameOn.delete(key); ed.setDecorations(this.fileDeco, []); return; }
    this.fileBlameOn.add(key);
    await this.renderFile(ed);
  }

  async renderFile(editor) {
    const key = editor.document.uri.toString();
    if (!this.fileBlameOn.has(key)) { editor.setDecorations(this.fileDeco, []); return; }
    const b = await this.blameFor(editor.document);
    if (!b) return;
    const decos = [];
    const now = Date.now();
    const dates = b.lines.filter(Boolean).map(c => c.date || now);
    const oldest = Math.min(...dates);
    let prevSha = null;
    for (let i = 0; i < editor.document.lineCount; i++) {
      const c = b.lines[i + 1];
      if (!c) continue;
      const first = c.sha !== prevSha;
      prevSha = c.sha;
      const age = c.uncommitted ? 0 : (now - c.date) / Math.max(1, now - oldest); // 0 = newest, 1 = oldest
      const label = first ? (c.uncommitted ? 'not committed yet' : `${short(c.sha)} ${truncate(c.author, 12)} ${shortAge(c.date)}`) : '';
      decos.push({
        range: new vscode.Range(i, 0, i, 0),
        renderOptions: {
          before: {
            contentText: ' ' + (label || ' ').padEnd(26, ' '),
            border: `none; border-left: 3px solid ${heat(age)}`,
          },
        },
      });
    }
    editor.setDecorations(this.fileDeco, decos);
  }

  async hover(doc, pos) {
    if (!cfg('blame.hover', true)) return null;
    const ed = vscode.window.activeTextEditor;
    // only show on the annotated (current) line or when full-file blame is on, to stay unobtrusive
    const fileOn = this.fileBlameOn.has(doc.uri.toString());
    if (!fileOn && (!ed || ed.document !== doc || ed.selection.active.line !== pos.line)) return null;
    if (!fileOn && pos.character < doc.lineAt(pos.line).range.end.character) return null;
    const b = await this.blameFor(doc);
    if (!b) return null;
    const c = b.lines[pos.line + 1];
    if (!c) return null;
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.supportThemeIcons = true;
    if (c.uncommitted) {
      md.appendMarkdown('**$(edit) Not committed yet** — you changed this line.\n\n');
      md.appendMarkdown(cmdLink('$(git-commit) Go to Commit', 'gitCompass.overview.focus'));
      return new vscode.Hover(md);
    }
    const root = b.model.root;
    md.appendMarkdown(`**${escapeMd(c.summary)}**\n\n`);
    md.appendMarkdown(`$(account) ${escapeMd(c.author)} · $(clock) ${fullDate(c.date)} (${relTime(c.date)}) · $(git-commit) \`${short(c.sha)}\`\n\n---\n\n`);
    const links = [
      cmdLink('$(git-compare) Show commit', 'gitCompass.showCommit', { root, sha: c.sha }),
      c.previous ? cmdLink('$(diff) Changes in this file', 'gitCompass.openCommitFileDiff', { root, commit: { sha: c.sha, parents: [c.previous] }, file: { path: c.filename, origPath: c.previousPath !== c.filename ? c.previousPath : undefined, status: 'M' } }) : '',
      cmdLink('$(history) File history', 'gitCompass.fileHistory', { root, rel: b.rel }),
      cmdLink('$(copy) Copy SHA', 'gitCompass.copySha', c.sha),
    ].filter(Boolean);
    md.appendMarkdown(links.join(' &nbsp;|&nbsp; '));
    return new vscode.Hover(md);
  }

  dispose() { this.disposables.forEach(d => d.dispose()); }
}

function truncate(s, n) { s = s || ''; return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function shortAge(ms) {
  const d = (Date.now() - ms) / 86400000;
  if (d < 1) return 'today';
  if (d < 30) return `${Math.round(d)}d`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}
function heat(age) {
  // new = warm orange, old = cool blue/grey
  const hue = Math.round(30 + age * 180);
  const light = Math.round(55 - age * 15);
  return `hsl(${hue}, 70%, ${light}%)`;
}

module.exports = { BlameController };
