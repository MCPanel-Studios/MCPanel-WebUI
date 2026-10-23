/* ═══════════════════════════════════════════════════════════════════════════
   Server-side filesystem browsing - the data behind the WebUI's file picker.

   The Tauri build called `browse_folder` / `browse_file` (commands.rs lines
   1327-1351), which opened a NATIVE dialog: importing a server, picking a Java
   executable, choosing an export destination, installing a theme from a .zip.
   A browser has no equivalent - `<input type=file>` yields file CONTENT, never
   the on-disk path - and the paths those flows need belong to the machine
   running the backend, not the machine running the browser. So the picker is
   rendered in-app by public/web-bridge.js and asks this command what is on
   disk, which keeps every downstream command taking real absolute paths
   exactly as it did under Tauri.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('../paths');

function windowsDrives() {
  const drives = [];
  for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    try { if (fs.existsSync(root)) drives.push({ name: root, path: root }); }
    catch { /* an empty optical drive can throw - it just isn't a root */ }
  }
  return drives;
}

// Mount points that are part of the OS install rather than "another drive".
const SYSTEM_MOUNTS = new Set(['/', '/home', '/root', '/usr', '/var', '/opt', '/tmp', '/srv/tmp']);
const SKIP_MOUNT_PREFIXES = ['/boot', '/proc', '/sys', '/dev', '/run/user', '/snap', '/var/lib/', '/var/snap'];
const NETWORK_FS = new Set(['nfs', 'nfs4', 'cifs', 'smb3', 'smbfs', 'fuse.sshfs', 'fuse.rclone', '9p', 'virtiofs']);
const READONLY_FS = new Set(['squashfs', 'iso9660', 'udf']);

/**
 * Extra drives a server could live on: USB disks under /run/media, NAS shares,
 * second SSDs in /mnt, ... On Linux that's every real (block-device or
 * network) mount that isn't a system one; on macOS, /Volumes.
 */
function mountRoots() {
  if (process.platform === 'darwin') {
    try {
      return fs.readdirSync('/Volumes', { withFileTypes: true })
        .filter(d => d.isDirectory() || d.isSymbolicLink())
        .map(d => ({ name: d.name, path: path.join('/Volumes', d.name) }))
        .filter(r => { try { return fs.realpathSync(r.path) !== '/'; } catch { return false; } });
    } catch { return []; }
  }
  if (process.platform !== 'linux') return [];
  let lines;
  try { lines = fs.readFileSync('/proc/mounts', 'utf8').split('\n'); }
  catch { return []; }
  // /proc/mounts escapes spaces & co. as \040-style octal.
  const unescape = s => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  const out = [];
  for (const line of lines) {
    const [dev, rawMnt, type] = line.split(' ');
    if (!rawMnt || READONLY_FS.has(type)) continue;
    if (!dev.startsWith('/dev/') && !NETWORK_FS.has(type)) continue;
    const mnt = unescape(rawMnt);
    if (SYSTEM_MOUNTS.has(mnt)) continue;
    if (SKIP_MOUNT_PREFIXES.some(p => mnt === p || mnt.startsWith(p.endsWith('/') ? p : `${p}/`))) continue;
    out.push({ name: path.basename(mnt) || mnt, path: mnt });
  }
  return out;
}

function quickRoots() {
  const roots = [
    { name: 'Home', path: os.homedir() },
    { name: 'MCPanel', path: paths.home() },
  ];
  if (process.platform === 'win32') roots.push(...windowsDrives());
  else roots.push({ name: 'Filesystem', path: '/' }, ...mountRoots());

  // paths.home() sits under the home directory on Linux, so the two can
  // collapse into one entry on an unusual MCPANEL_HOME.
  const seen = new Set();
  return roots.filter(r => r.path && !seen.has(r.path) && seen.add(r.path));
}

module.exports = {
  list_dir: async (args) => {
    const requested = args && args.path ? String(args.path) : os.homedir();
    let dir = path.resolve(requested);

    // Callers often pass back a previously chosen FILE (a java binary, a theme
    // zip); listing its folder is what the user means in that case.
    try { if (fs.statSync(dir).isFile()) dir = path.dirname(dir); }
    catch { /* let readdir below report why it is unreachable */ }

    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      throw new Error(e.message);
    }

    const dirs = [];
    const files = [];
    for (const item of items) {
      const full = path.join(dir, item.name);
      let meta;
      // stat() rather than the Dirent flags so a symlinked directory browses as
      // a directory; a broken link fails here and is simply left out.
      try { meta = fs.statSync(full); } catch { continue; }
      const entry = {
        name: item.name,
        path: full,
        type: meta.isDirectory() ? 'dir' : 'file',
        size: meta.isDirectory() ? 0 : meta.size,
        // Node exposes no portable way to read FILE_ATTRIBUTE_HIDDEN, so on
        // Windows this only catches dot-prefixed names.
        hidden: item.name.startsWith('.'),
      };
      (entry.type === 'dir' ? dirs : files).push(entry);
    }

    const byName = (a, b) =>
      a.name.toLowerCase() < b.name.toLowerCase() ? -1 :
      a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0;
    dirs.sort(byName);
    files.sort(byName);

    const parent = path.dirname(dir);
    return {
      path: dir,
      parent: parent === dir ? null : parent,
      sep: path.sep,
      home: os.homedir(),
      roots: quickRoots(),
      entries: [...dirs, ...files],
    };
  },
};
