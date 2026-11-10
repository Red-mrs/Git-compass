'use strict';
// Builds git-compass-<version>.vsix without npm/vsce. Run with any Node.js — or with VS Code's
// bundled runtime (ELECTRON_RUN_AS_NODE=1 <path-to-code-binary> scripts/package.js).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const INCLUDE = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE.txt', 'src', 'media'];

function walk(rel, out) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return out;
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) walk(path.join(rel, name), out);
  } else out.push(rel.split(path.sep).join('/'));
  return out;
}
const files = INCLUDE.flatMap(f => walk(f, []));

const esc = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}" />
    <DisplayName>${esc(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description)}</Description>
    <Tags>${esc((pkg.keywords || []).join(','))}</Tags>
    <Categories>${esc((pkg.categories || []).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${esc((pkg.extensionKind || ['workspace']).join(','))}" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
    <Icon>extension/${esc(pkg.icon)}</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${esc(pkg.icon)}" Addressable="true" />
  </Assets>
</PackageManifest>
`;

const MIME = { js: 'application/javascript', json: 'application/json', css: 'text/css', html: 'text/html', svg: 'image/svg+xml', png: 'image/png', md: 'text/markdown', txt: 'text/plain', vsixmanifest: 'text/xml' };
const exts = new Set(['vsixmanifest', ...files.map(f => path.extname(f).slice(1).toLowerCase()).filter(Boolean)]);
const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${[...exts].map(e => `<Default Extension=".${e}" ContentType="${MIME[e] || 'application/octet-stream'}" />`).join('')}</Types>
`;

// ---- minimal ZIP writer ------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const entries = [
  { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
  { name: 'extension.vsixmanifest', data: Buffer.from(manifest) },
  ...files.map(f => ({ name: `extension/${f}`, data: fs.readFileSync(path.join(root, f)) })),
];

const chunks = [];
const central = [];
let offset = 0;
const now = new Date();
const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
for (const e of entries) {
  const name = Buffer.from(e.name, 'utf8');
  const comp = zlib.deflateRawSync(e.data, { level: 9 });
  const crc = crc32(e.data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(e.data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  chunks.push(local, name, comp);
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(20, 4);
  cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(0x0800, 8);
  cen.writeUInt16LE(8, 10);
  cen.writeUInt16LE(dosTime, 12);
  cen.writeUInt16LE(dosDate, 14);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(comp.length, 20);
  cen.writeUInt32LE(e.data.length, 24);
  cen.writeUInt16LE(name.length, 28);
  cen.writeUInt32LE(offset, 42);
  central.push(cen, name);
  offset += local.length + name.length + comp.length;
}
const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);

const outFile = path.join(root, `${pkg.name}-${pkg.version}.vsix`);
fs.writeFileSync(outFile, Buffer.concat([...chunks, centralBuf, end]));
console.log(`Created ${path.basename(outFile)} (${entries.length} files, ${(fs.statSync(outFile).size / 1024).toFixed(0)} KB)`);
