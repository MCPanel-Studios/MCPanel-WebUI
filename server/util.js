/* ═══════════════════════════════════════════════════════════════════════════
   Shared filesystem/config helpers used by the command modules. Ports of the
   free functions in src-tauri/src/commands.rs.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const paths = require('./paths');

const DEFAULT_CONFIG = { servers: [], jdkPaths: [], activeTheme: null };

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(paths.configPath(), 'utf8'));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(paths.home(), { recursive: true });
  fs.writeFileSync(paths.configPath(), JSON.stringify(cfg, null, 2));
}

function getServerDir(id) {
  const cfg = readConfig();
  const srv = (cfg.servers || []).find(s => s.id === id);
  if (!srv || !srv.dir) throw new Error('Server not found');
  return srv.dir;
}

function getProfileDir(id) {
  const dir = path.join(paths.profilesDir(), id);
  try {
    if (fs.statSync(dir).isDirectory()) return dir;
  } catch {}
  throw new Error('Profile not found');
}

/**
 * Mirrors mcpanel-cli's config.write_server_manifest: a copy of this server's
 * config entry (minus `dir`, so the manifest stays valid if the folder moves)
 * written into its own directory as mcpanel.json. Some server mutations happen
 * natively here rather than shelling out to the CLI, so this needs to run on
 * both sides to keep the manifest in sync with whichever app touched it last.
 */
function writeServerManifest(server) {
  const dir = server && server.dir;
  if (!dir) return;
  const manifest = { ...server };
  delete manifest.dir;
  const target = path.join(dir, 'mcpanel.json');
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, target);
  } catch { /* best-effort */ }
}

/** Rejects paths that would escape the server/profile directory. */
function assertSafeRel(rel, label = 'path') {
  if (rel == null) throw new Error(`Invalid ${label}`);
  if (String(rel).includes('..') || String(rel).startsWith('/')) {
    throw new Error(`Invalid ${label}`);
  }
}

/**
 * Copies a single dropped path into dst, recursing into directories so a
 * dragged folder (and its contents) lands intact rather than being skipped.
 */
function copyDroppedPath(src, dst) {
  let st;
  try { st = fs.statSync(src); } catch { return; }
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyDroppedPath(path.join(src, entry), path.join(dst, entry));
    }
  } else if (st.isFile()) {
    fs.copyFileSync(src, dst);
  }
}

/**
 * Picks a non-colliding name inside dest: "world" -> "world (1)". The export
 * target is a user folder we don't own, so silently overwriting (or merging
 * into) whatever is already there would be destructive.
 */
function uniqueExportPath(dest, name) {
  const first = path.join(dest, name);
  if (!fs.existsSync(first)) return first;

  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; n < 1000; n++) {
    const candidate = path.join(dest, `${stem} (${n})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return first;
}

function exportPaths(base, relPaths, destDir) {
  let st;
  try { st = fs.statSync(destDir); } catch { throw new Error('Destination folder not found'); }
  if (!st.isDirectory()) throw new Error('Destination folder not found');

  for (const rel of relPaths) {
    assertSafeRel(rel);
    const src = path.join(base, rel);
    if (!fs.existsSync(src)) throw new Error(`Not found: ${rel}`);
    const name = path.basename(src);
    if (!name) continue;
    copyDroppedPath(src, uniqueExportPath(destDir, name));
  }
}

/** Recursive {name,type,path,size,children} tree, sorted by name like the Rust side. */
function walkDirTree(dir, base) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // plugins/.list and mods/.list hold mcpanel-cli's install records - hidden
  // from the file manager like the CLI's own server tree does.
  const hideList = ['plugins', 'mods'].includes(path.basename(dir));

  const entries = [];
  for (const item of items) {
    if (hideList && item.name === '.list') continue;
    const full = path.join(dir, item.name);
    let meta;
    try { meta = fs.statSync(full); } catch { continue; }
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (meta.isDirectory()) {
      entries.push({ name: item.name, type: 'dir', path: rel, children: walkDirTree(full, base) });
    } else {
      entries.push({ name: item.name, type: 'file', path: rel, size: meta.size });
    }
  }
  return entries;
}

/** Fetches JSON with a timeout, resolving null on any failure (mirrors curl -fsSL). */
// The MCPanel repositories are moving from the DippyCoder account to the
// MCPanel-Studios organisation. Every GitHub URL under the old owner is tried
// at the organisation first and only then at its old path.
const GITHUB_ORG = 'MCPanel-Studios';
const OLD_OWNER_RE =
  /^(https:\/\/(?:api\.github\.com\/repos|github\.com|raw\.githubusercontent\.com|gist\.githubusercontent\.com)\/)DippyCoder\//i;

/** [organisation URL, old URL] for a DippyCoder GitHub URL, else [url]. */
function githubCandidates(url) {
  const moved = String(url).replace(OLD_OWNER_RE, `$1${GITHUB_ORG}/`);
  return moved !== url ? [moved, url] : [url];
}

/**
 * fetch() over githubCandidates(url): the first response that is ok, or null
 * if none is (network errors and timeouts included).
 */
async function fetchWithFallback(url, { timeout = 10000, ...init } = {}) {
  for (const candidate of githubCandidates(url)) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(candidate, { ...init, signal: ac.signal });
      // Read the body before the timer is cleared so a stalled transfer still aborts.
      if (res.ok) return { res, body: Buffer.from(await res.arrayBuffer()) };
    } catch {
      // try the next candidate
    } finally {
      clearTimeout(t);
    }
  }
  return null;
}

async function fetchJson(url, { timeout = 10000, headers = {} } = {}) {
  const got = await fetchWithFallback(url, { timeout, headers });
  if (!got) return null;
  try {
    return JSON.parse(got.body.toString('utf8'));
  } catch {
    return null;
  }
}

async function downloadTo(url, dest, { timeout = 60000 } = {}) {
  const got = await fetchWithFallback(url, { timeout, redirect: 'follow' });
  if (!got) return false;
  try {
    await fsp.writeFile(dest, got.body);
    return true;
  } catch {
    return false;
  }
}

/**
 * Non-internal IPv4 addresses of this machine, e.g. [{name: 'wlan0', address:
 * '192.168.1.23'}]. Used to tell an operator what LAN URL other devices should
 * actually use, since the server itself may be listening on 0.0.0.0.
 */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces() || {};
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push({ name, address: addr.address });
    }
  }
  return out;
}

module.exports = {
  DEFAULT_CONFIG,
  readConfig,
  writeConfig,
  getServerDir,
  getProfileDir,
  writeServerManifest,
  assertSafeRel,
  copyDroppedPath,
  uniqueExportPath,
  exportPaths,
  walkDirTree,
  githubCandidates,
  fetchWithFallback,
  fetchJson,
  downloadTo,
  lanAddresses,
};
