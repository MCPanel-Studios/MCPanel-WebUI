/* ═══════════════════════════════════════════════════════════════════════════
   Theme system - port of src-tauri/src/commands.rs lines 936-1257.

   Themes are fully interchangeable between the MCPanel Tauri app and this
   WebUI: same on-disk layout (<mcpanel home>/themes/<id>/theme.{css,json}),
   same .zip package format, same theme.json schema, and the same remote
   index URL. A theme authored for either app installs and renders in the
   other unchanged - see the note on rewriteCssUrls() below for the single
   (unavoidable) runtime difference.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const paths = require('../paths');
const applog = require('../applog');
const util = require('../util');

// The remote catalogues the "Browse themes" dialog reads: MCPanel's on its
// `themes` branch, MCLib's next to its addon index on `main`. These are the
// exact URLs the Tauri app uses (MCPANEL_THEMES_INDEX / MCLIB_THEMES_INDEX in
// commands.rs) and must stay that way - both apps share the published indexes.
//
// MCPanel's lists the official themes with direct `downloadUrl`s. MCLib's is
// built like its addon index: entries only point at each theme's GitHub or
// Codeberg repository, and the version and .zip come from its releases.
const MCPANEL_THEMES_INDEX =
  'https://raw.githubusercontent.com/DippyCoder/MCPanel/themes/themes-index.json';
const MCLIB_THEMES_INDEX =
  'https://raw.githubusercontent.com/DippyCoder/MCLib/main/themes-index.json';

// Order matters only for logging; ids match public/themes/<id>/.
const BUILTIN_THEMES = ['purple-dark', 'clean-dark', 'dark-slate', 'bright-slate'];

const BUILTIN_SRC_DIR = path.join(__dirname, '..', '..', 'public', 'themes');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolves <themesDir>/<id>, rejecting ids that would escape it. The Rust had
 * no such guard because a Tauri command is only reachable from our own
 * frontend; here the same commands sit behind an HTTP endpoint, and
 * delete_theme in particular is an rm -rf.
 */
function themeDirFor(id) {
  const clean = String(id == null ? '' : id);
  if (!clean || clean.includes('..') || clean.includes('/') || clean.includes('\\')) {
    throw new Error('Invalid theme id');
  }
  return path.join(paths.themesDir(), clean);
}

/** Recursive copy that overwrites, used to seed the builtin themes. */
function copyDirOverwrite(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirOverwrite(from, to);
    else fs.copyFileSync(from, to);
  }
}

/** GET exactly `url` (no organisation fallback) as JSON, or null. */
async function fetchJsonExact(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'MCPanel' }, signal: ac.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * {version, zip} of the newest non-draft, non-prerelease release of a
 * GitHub/Codeberg `project`, taken from its first .zip asset, or the release's
 * source archive when none is attached (the installer finds theme.json under
 * the archive's wrapping folder); the release tag is the version. The project URL is used as listed (no organisation
 * fallback): it names the theme's own repository, wherever that lives.
 */
async function latestThemeRelease(project) {
  let api;
  if (project.startsWith('https://github.com/')) {
    api = `https://api.github.com/repos/${project.slice('https://github.com/'.length)}/releases?per_page=20`;
  } else if (project.startsWith('https://codeberg.org/')) {
    api = `https://codeberg.org/api/v1/repos/${project.slice('https://codeberg.org/'.length)}/releases?limit=20`;
  } else {
    return null; // MCLib only lists GitHub and Codeberg projects
  }
  const releases = await fetchJsonExact(api);
  if (!Array.isArray(releases)) return null;
  const release = releases.find(r => r && !r.draft && !r.prerelease);
  if (!release || typeof release.tag_name !== 'string') return null;
  const asset = (release.assets || []).find(a =>
    a && typeof a.name === 'string' && a.name.toLowerCase().endsWith('.zip') && a.browser_download_url);
  const zip = asset ? asset.browser_download_url : release.zipball_url;
  if (typeof zip !== 'string' || !zip) return null;
  return { version: release.tag_name.replace(/^v/i, ''), zip };
}

/** An MCLib theme entry as a theme-browser card, or null if it has no installable release. */
async function mclibThemeCard(entry) {
  if (!entry || typeof entry.project !== 'string') return null;
  const release = await latestThemeRelease(entry.project);
  if (!release) return null;
  const authors = Array.isArray(entry.authors) ? entry.authors.filter(a => typeof a === 'string') : [];
  return {
    name: entry.name,
    creator: authors.join(', '),
    creatorUrl: entry.project,
    description: entry.description,
    version: release.version,
    downloadUrl: release.zip,
    source: 'mclib',
  };
}

async function fetchOfficialThemes() {
  const index = await util.fetchJson(MCPANEL_THEMES_INDEX);
  if (!index) return null;
  const list = Array.isArray(index.themes) ? index.themes : [];
  return list
    .filter(t => t && typeof t === 'object' && !Array.isArray(t))
    .map(t => ({ ...t, source: 'mcpanel' }));
}

async function fetchMclibThemes() {
  const index = await util.fetchJson(MCLIB_THEMES_INDEX);
  if (!index || !Array.isArray(index.themes)) return null;
  // One release lookup per theme, all at once.
  const cards = await Promise.all(index.themes.map(mclibThemeCard));
  return cards.filter(Boolean);
}

// ─── CSS url() rewriting ─────────────────────────────────────────────────────

/**
 * A theme's own CSS may reference assets it ships (background images, fonts)
 * with a relative url(...). Those have to be resolved against the installed
 * theme directory, which lives outside the web root.
 *
 * The Tauri build rewrote them to url('file:///abs/path'); a browser can't
 * load file://, so here they become url('/api/theme-asset/<id>/<rel>'), which
 * server/index.js serves straight out of <themesDir>/<id>/. This is purely a
 * runtime resolution detail - the theme.css ON DISK is never modified, so the
 * exact same .zip stays valid for both apps.
 *
 * Everything else mirrors the Rust `rewrite_css_urls` exactly: case-insensitive
 * `url(` matching, quoted or bare forms with the original quote preserved, and
 * absolute references (http(s)://, data:, file://) plus empty ones left alone.
 */
function rewriteCssUrls(css, themeId) {
  const lower = css.toLowerCase();
  let result = '';
  let pos = 0;

  for (;;) {
    const abs = lower.indexOf('url(', pos);
    if (abs === -1) break;

    result += css.slice(pos, abs);

    const after = abs + 4; // skip "url("
    const rest = css.slice(after);
    const first = rest.charAt(0);
    const quote = first === "'" || first === '"' ? first : null;
    const innerStart = quote ? 1 : 0;

    const inner = rest.slice(innerStart);
    const endIdx = inner.indexOf(quote || ')');
    const endInner = endIdx === -1 ? inner.length : endIdx;

    const rel = inner.slice(0, endInner);
    const relLower = rel.toLowerCase();
    const isAbs =
      relLower.startsWith('https://') ||
      relLower.startsWith('http://') ||
      relLower.startsWith('data:') ||
      relLower.startsWith('file://') ||
      rel === '';

    if (isAbs) {
      // Copy through untouched, stopping before the closing quote/paren so the
      // next iteration (or the final tail append) carries it over verbatim.
      const len = 4 + innerStart + endInner;
      result += css.slice(abs, abs + len);
      pos = abs + len;
    } else {
      const q = quote || "'";
      result += `url(${q}${themeAssetUrl(themeId, rel)}${q})`;
      // Skip past the closing paren in the source.
      const consumed = 4 + innerStart + endInner;
      const paren = css.indexOf(')', abs + consumed);
      pos = paren === -1 ? css.length : paren + 1;
    }
  }

  return result + css.slice(pos);
}

/**
 * Builds the /api/theme-asset URL for a relative reference, percent-encoding
 * each path segment so assets with spaces or other reserved characters in
 * their filenames still resolve. Any ?query / #fragment suffix (the classic
 * `?#iefix` webfont hack, cache-busters) is preserved verbatim.
 */
function themeAssetUrl(themeId, rel) {
  const cut = rel.search(/[?#]/);
  const filePart = cut === -1 ? rel : rel.slice(0, cut);
  const suffix = cut === -1 ? '' : rel.slice(cut);

  const encoded = filePart
    .replace(/^\.\//, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');

  return `/api/theme-asset/${encodeURIComponent(themeId)}/${encoded}${suffix}`;
}

// ─── Zip installer ───────────────────────────────────────────────────────────

/** Port of `_install_theme_zip` (commands.rs:1119-1185). */
function installThemeZip(zipPath) {
  let archive;
  try {
    archive = new AdmZip(zipPath);
  } catch (e) {
    throw new Error(e && e.message ? e.message : String(e));
  }

  const entries = archive.getEntries();
  const metaEntry = entries.find(
    (e) => e.entryName.endsWith('theme.json') && !e.entryName.startsWith('__MACOSX'),
  );
  if (!metaEntry) throw new Error('theme.json not found in archive');

  let meta;
  try {
    meta = JSON.parse(metaEntry.getData().toString('utf8'));
  } catch (e) {
    throw new Error(`Invalid theme.json: ${e.message}`);
  }
  if (!meta || typeof meta.name !== 'string' || meta.name === '') {
    throw new Error('theme.json must include a name field');
  }

  // Everything inside the archive is relative to whatever directory holds
  // theme.json, so a zip with or without a wrapping folder installs the same.
  const prefix = metaEntry.entryName.slice(0, metaEntry.entryName.length - 'theme.json'.length);

  const tid = `theme_${Date.now()}`;
  const themeDir = path.join(paths.themesDir(), tid);
  fs.mkdirSync(themeDir, { recursive: true });

  for (const entry of entries) {
    const raw = entry.entryName;
    if (raw.startsWith('__MACOSX') || raw.endsWith('/') || entry.isDirectory) continue;

    const rel = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    if (!rel) continue;

    const dest = path.join(themeDir, rel);
    if (!path.resolve(dest).startsWith(path.resolve(themeDir) + path.sep)) continue;

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
  }

  applog.info(`Installed theme "${meta.name}" as ${tid}`);
  return { success: true, theme: { ...meta, id: tid, dir: themeDir } };
}

// ─── Commands ────────────────────────────────────────────────────────────────

module.exports = {
  /**
   * Seeds the four stock themes into the shared themes directory. The Tauri
   * build baked them in with include_str!; here they are read from
   * public/themes/ at runtime. The whole directory is copied so a builtin that
   * ships extra assets keeps them.
   */
  async ensure_builtin_themes() {
    for (const id of BUILTIN_THEMES) {
      const src = path.join(BUILTIN_SRC_DIR, id);
      if (!fs.existsSync(src)) {
        applog.warn(`ensure_builtin_themes: missing bundled theme ${id}`);
        continue;
      }
      // Unconditional overwrite, matching the Rust - a builtin always tracks
      // the version shipped with the app.
      copyDirOverwrite(src, path.join(paths.themesDir(), id));
    }
    return null;
  },

  async get_default_theme() {
    const p = paths.defaultThemePath();
    try {
      const s = fs.readFileSync(p, 'utf8').trim();
      if (s) return s;
    } catch { /* not written yet */ }
    try {
      fs.mkdirSync(paths.home(), { recursive: true });
      fs.writeFileSync(p, 'clean-dark');
    } catch { /* best-effort, the default still applies */ }
    return 'clean-dark';
  },

  async set_default_theme({ id }) {
    fs.mkdirSync(paths.home(), { recursive: true });
    fs.writeFileSync(paths.defaultThemePath(), String(id == null ? '' : id));
    return null;
  },

  async theme_exists({ id }) {
    try {
      return fs.existsSync(path.join(themeDirFor(id), 'theme.json'));
    } catch {
      return false;
    }
  },

  async install_builtin_theme({ id, css, json }) {
    const dir = themeDirFor(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'theme.css'), css == null ? '' : String(css));
    fs.writeFileSync(path.join(dir, 'theme.json'), json == null ? '' : String(json));
    return null;
  },

  async get_themes() {
    const themesDir = paths.themesDir();
    let entries;
    try {
      entries = fs.readdirSync(themesDir);
    } catch {
      return [];
    }

    const themes = [];
    for (const name of entries) {
      // ._foo are macOS resource forks; _tmp_ / _download_ are our own
      // in-flight install scratch files.
      if (name.startsWith('._') || name.startsWith('_tmp_') || name.startsWith('_download_')) {
        continue;
      }
      const metaPath = path.join(themesDir, name, 'theme.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta && typeof meta === 'object') {
          meta.id = name;
          meta.dir = path.join(themesDir, name);
          themes.push(meta);
        }
      } catch { /* a malformed theme.json just isn't listed */ }
    }
    return themes;
  },

  async delete_theme({ id }) {
    const dir = themeDirFor(id);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      applog.info(`Deleted theme ${id}`);
    }
    return null;
  },

  /**
   * Reads both theme catalogues and merges them, tagging each theme with its
   * `source`; MCLib themes without an installable release are left out. Only
   * when neither catalogue is readable is an error reported, matching the
   * Rust - the UI shows an error banner only then.
   */
  async fetch_github_themes() {
    const [official, mclib] = await Promise.all([fetchOfficialThemes(), fetchMclibThemes()]);
    if (!official && !mclib) return { themes: [], error: 'Failed to fetch themes' };
    return { themes: [...(official || []), ...(mclib || [])] };
  },

  async install_theme_from_url({ url }) {
    const themesDir = paths.themesDir();
    fs.mkdirSync(themesDir, { recursive: true });

    // The ._download_ prefix keeps this scratch file out of get_themes() while
    // it is being written.
    const tmp = path.join(themesDir, `._download_${Date.now()}.zip`);
    try {
      const ok = await util.downloadTo(url, tmp, { timeout: 60000 });
      if (!ok) throw new Error('Download failed');
      return installThemeZip(tmp);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* never downloaded */ }
    }
  },

  async install_theme_from_file({ path: filePath }) {
    return installThemeZip(filePath);
  },

  async get_theme_css({ id }) {
    if (!id) return null;
    let cssPath;
    try {
      cssPath = path.join(themeDirFor(id), 'theme.css');
    } catch {
      return null;
    }
    if (!fs.existsSync(cssPath)) return null;

    let css;
    try {
      css = fs.readFileSync(cssPath, 'utf8');
    } catch {
      return null;
    }
    return rewriteCssUrls(css, id);
  },
};
