'use strict';
// The built-in Git guide (an editor tab). Content lives in media/guide.html.

const vscode = require('vscode');
const fs = require('fs');
const { nonce } = require('../util');

class GuidePanel {
  constructor(ctx) {
    this.ctx = ctx;
    this.panel = null;
  }

  show(section) {
    if (this.panel) {
      this.panel.reveal();
      if (section) this.panel.webview.postMessage({ type: 'goto', section });
      return;
    }
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('gitCompass.guide', 'Git Compass Guide', vscode.ViewColumn.Active, {
      enableScripts: true, localResourceRoots: [media], enableFindWidget: true, retainContextWhenHidden: true,
    });
    this.panel.iconPath = vscode.Uri.joinPath(media, 'guide-icon.svg');
    const w = this.panel.webview;
    const n = nonce();
    const u = f => w.asWebviewUri(vscode.Uri.joinPath(media, f));
    let html = fs.readFileSync(vscode.Uri.joinPath(media, 'guide.html').fsPath, 'utf8');
    html = html
      .replace(/\{\{csp\}\}/g, `default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';`)
      .replace(/\{\{nonce\}\}/g, n)
      .replace(/\{\{common\.css\}\}/g, String(u('common.css')))
      .replace(/\{\{guide\.css\}\}/g, String(u('guide.css')))
      .replace(/\{\{icons\.js\}\}/g, String(u('icons.js')))
      .replace(/\{\{section\}\}/g, section || '');
    w.html = html;
    w.onDidReceiveMessage(m => {
      if (m.type === 'command') vscode.commands.executeCommand(m.command, m.arg);
    });
    this.panel.onDidDispose(() => { this.panel = null; });
  }
}

module.exports = { GuidePanel };
