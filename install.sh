#!/usr/bin/env sh
# Build the .vsix and install it into VS Code (Linux / macOS).
#   ./install.sh              build + install
#   ./install.sh --no-install only build the .vsix
#   ./install.sh --test       run the tests first
set -e
cd "$(dirname "$0")"

# Find a JavaScript runtime: real Node.js if installed, otherwise the one bundled inside VS Code.
if command -v node >/dev/null 2>&1; then
  run_js() { node "$@"; }
else
  for c in /snap/code/current/usr/share/code/code /usr/share/code/code /opt/visual-studio-code/code \
           /usr/lib/code/code "/Applications/Visual Studio Code.app/Contents/MacOS/Electron"; do
    if [ -x "$c" ]; then VSCODE_BIN="$c"; break; fi
  done
  if [ -z "$VSCODE_BIN" ]; then echo "Could not find Node.js or VS Code's runtime." >&2; exit 1; fi
  run_js() { ELECTRON_RUN_AS_NODE=1 "$VSCODE_BIN" "$@"; }
fi

if [ "$1" = "--test" ]; then
  run_js test/unit.test.js
  run_js test/manifest.test.js
  run_js test/host.test.js
fi

run_js scripts/package.js
VSIX=$(ls -t git-compass-*.vsix | head -1)

if [ "$1" != "--no-install" ]; then
  # `code` must not inherit ELECTRON_RUN_AS_NODE (it is set inside VS Code's own terminal)
  env -u ELECTRON_RUN_AS_NODE code --install-extension "$VSIX" --force
  echo "Installed $VSIX — run 'Developer: Reload Window' in VS Code to load the new version."
fi
