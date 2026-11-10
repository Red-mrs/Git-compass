'use strict';
// Creates the throwaway repository used by the integration test. Prints its path.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const dir = fs.mkdtempSync(path.join(process.argv[2] || os.tmpdir(), 'gc-int-'));
const g = (...a) => cp.execFileSync('git', a, { cwd: dir, env: { ...process.env, GIT_EDITOR: 'true' } });
g('init', '-q', '-b', 'main');
g('config', 'user.name', 'Test User');
g('config', 'user.email', 'test@example.com');
g('config', 'commit.gpgsign', 'false');
fs.writeFileSync(path.join(dir, 'README.md'), 'first line\n');
g('add', '.'); g('commit', '-qm', 'Initial commit');
g('tag', 'v1.0');
fs.appendFileSync(path.join(dir, 'README.md'), 'second line\n');
g('commit', '-qam', 'Second commit');
g('branch', 'feature');
fs.writeFileSync(path.join(dir, 'stashme.txt'), 'x');
g('add', 'stashme.txt'); g('stash', 'push', '-qm', 'parked work');
fs.appendFileSync(path.join(dir, 'README.md'), 'uncommitted edit\n');
fs.writeFileSync(path.join(dir, 'new file.txt'), 'hello\n');
process.stdout.write(dir);
