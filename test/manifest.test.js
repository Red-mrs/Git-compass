'use strict';
// Static consistency checks between package.json and the source code. Run: node test/manifest.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const src = fs.readFileSync(path.join(root, 'src/commands.js'), 'utf8');

const declared = new Set(pkg.contributes.commands.map(c => c.command));
const registered = new Set([...src.matchAll(/'(gitCompass\.[A-Za-z]+)':/g)].map(m => m[1]));
const viewIds = new Set(pkg.contributes.views.gitCompass.map(v => v.id));

let problems = [];
for (const c of declared) if (!registered.has(c)) problems.push(`declared but not registered: ${c}`);
for (const c of registered) if (!declared.has(c)) problems.push(`registered but not declared: ${c}`);
for (const [menu, entries] of Object.entries(pkg.contributes.menus)) {
  for (const e of entries) {
    if (!declared.has(e.command)) problems.push(`menu ${menu} references unknown command ${e.command}`);
    const vm = /view == ([\w.]+)/.exec(e.when || '');
    if (vm && !viewIds.has(vm[1])) problems.push(`menu ${menu} references unknown view ${vm[1]}`);
  }
}
// commands executed from code / webviews must exist (or be built-in)
const allSources = ['src', 'media'].flatMap(d => fs.readdirSync(path.join(root, d), { recursive: true })
  .filter(f => /\.(js|html)$/.test(f)).map(f => fs.readFileSync(path.join(root, d, f), 'utf8'))).join('\n');
const used = new Set([...allSources.matchAll(/gitCompass\.([A-Za-z]+)(\.focus)?\b/g)].filter(m => !m[2]).map(m => `gitCompass.${m[1]}`));
const builtinNames = new Set(['gitCompass.drafts', 'gitCompass.welcomed', 'gitCompass.status', 'gitCompass.graph', 'gitCompass.rebase', 'gitCompass.guide', 'gitCompass.welcome',
  'gitCompass.hasRepo', 'gitCompass.multipleRepos', 'gitCompass.operation', 'gitCompass.hasRemote', 'gitCompass.isGitHub', 'gitCompass.viewAsTree', 'gitCompass.fileHistoryPinned']);
const configKeys = Object.keys(pkg.contributes.configuration.properties);
for (const u of used) {
  if (declared.has(u) || viewIds.has(u) || builtinNames.has(u)) continue;
  if (configKeys.some(k => k === u || k.startsWith(u + '.'))) continue;
  problems.push(`code references unknown id ${u}`);
}
for (const f of ['main', 'icon']) assert.ok(fs.existsSync(path.join(root, pkg[f])), `${f} file missing`);
for (const s of pkg.contributes.walkthroughs[0].steps) assert.ok(fs.existsSync(path.join(root, s.media.markdown)), s.media.markdown);

if (problems.length) {
  console.log(problems.map(p => '  ✘ ' + p).join('\n'));
  process.exit(1);
}
console.log(`  ✔ manifest OK — ${declared.size} commands, ${Object.values(pkg.contributes.menus).flat().length} menu entries, ${viewIds.size} views`);
