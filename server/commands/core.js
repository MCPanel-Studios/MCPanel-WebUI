/* ═══════════════════════════════════════════════════════════════════════════
   Core commands - CLI health, raw CLI passthrough, config persistence, app
   metadata, update checks and auto-updates, the in-app CLI installer,
   shutdown and restart.

   Port of the corresponding #[tauri::command] functions in
   src-tauri/src/commands.rs. Command names match the Tauri invoke_handler
   list one-for-one so the frontend needs no changes.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const { execFile, spawn } = require('child_process');

const paths = require('../paths');
const applog = require('../applog');
const cli = require('../cli');
const util = require('../util');

/**
 * Runs an arbitrary program and resolves { ok, stdout, stderr, error }.
 * Never rejects - callers inspect `ok`, mirroring the Rust side's explicit
 * match on Ok(success) / Ok(failure) / Err(spawn failure).
 */
function execCapture(prog, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(prog, args, {
      maxBuffer: 32 * 1024 * 1024,
      timeout: opts.timeout || 0,
      windowsHide: true, // mirrors the Rust build's CREATE_NO_WINDOW flag
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        error: err ? (err.message || String(err)) : null,
      });
    });
  });
}

async function check_cli() {
  return cli.checkCli();
}

async function run_cli({ args }) {
  return cli.runCli(args || []);
}

// Keys any signed-in user may change through save_config. Everything else in
// config.json describes the servers themselves - `servers[]` carries each
// one's on-disk `dir`, so an unrestricted write here is a path-rewrite
// primitive, not a preferences save.
//
// app.js persists the chosen theme through this same command, which is why it
// cannot simply require settings.manage: that would stop every non-admin from
// changing their theme. So the permission gate lets callers through and the
// real decision happens here, where the submitted config can be diffed against
// the one on disk.
const SAFE_CONFIG_KEYS = new Set(['activeTheme', 'firstStartDone']);

/** Top-level keys whose value differs between two config objects. */
function changedConfigKeys(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changed = [];
  for (const k of keys) {
    if (JSON.stringify((before || {})[k]) !== JSON.stringify((after || {})[k])) changed.push(k);
  }
  return changed;
}

async function save_config({ config }, ctx) {
  const user = ctx && ctx.user;
  const privileged = !user
    || user.system
    || user.isAdmin
    || (user.effectivePermissions || []).includes('settings.manage')
    || (user.effectivePermissions || []).includes('*');

  if (!privileged) {
    const changed = changedConfigKeys(util.readConfig(), config);
    const blocked = changed.filter((k) => !SAFE_CONFIG_KEYS.has(k));
    if (blocked.length) {
      applog.warn(
        `Refused save_config from "${user.username}": would change ${blocked.join(', ')}`
      );
      throw Object.assign(
        new Error(
          `Your account may only change ${[...SAFE_CONFIG_KEYS].join(' and ')} - ` +
          `this would also change ${blocked.join(', ')} (settings.manage).`
        ),
        { forbidden: true }
      );
    }
  }

  util.writeConfig(config);
}

async function get_app_version(_args, ctx) {
  return ctx.appVersion;
}

async function get_app_log_path() {
  return paths.logsDir();
}

// Lets the frontend record UI-level events (opening a server's panel, etc.)
// that have no natural backend command of their own to hang a log line off of.
async function log_event({ level, message }) {
  if (level === 'warn') applog.warn(message);
  else if (level === 'error') applog.error(message);
  else applog.info(message);
}

async function check_first_start_flag() {
  const flag = paths.firstStartFlag();
  if (fs.existsSync(flag)) {
    try { fs.unlinkSync(flag); } catch { /* ignore */ }
    return true;
  }
  return false;
}

// Both return the raw GitHub release object, or null on any failure - the
// bridge's semver comparison treats null as "no update information".

async function check_app_update() {
  return util.fetchJson(
    'https://api.github.com/repos/DippyCoder/MCPanel-WebUI/releases/latest',
    { timeout: 10000, headers: { 'User-Agent': 'MCPanel' } },
  );
}

async function check_cli_update() {
  return util.fetchJson(
    'https://api.github.com/repos/DippyCoder/mcpanel-cli/releases/latest',
    { timeout: 10000, headers: { 'User-Agent': 'MCPanel' } },
  );
}

// ─── Install CLI (for users whose packaging had no postinst step) ────────────

// Zip archive URL - pip downloads it directly, no git required on any platform.
const CLI_ZIP_URL = 'https://github.com/DippyCoder/mcpanel-cli/archive/refs/heads/main.zip';

// Each entry is [program, args_before_url]: `program <prefix...> <ZIP_URL>`.
const INSTALL_CANDIDATES = process.platform === 'win32'
  ? [
      // py is the Python Launcher, standard on Windows installs
      ['py', ['-m', 'pip', 'install', '--user']],
      ['pip', ['install', '--user']],
      ['python', ['-m', 'pip', 'install', '--user']],
    ]
  : [
      ['pip3', ['install', '--user']],
      ['pip', ['install', '--user']],
      ['python3', ['-m', 'pip', 'install', '--user']],
    ];

const INSTALL_HINT = process.platform === 'win32'
  ? `py -m pip install --user ${CLI_ZIP_URL}`
  : `pip3 install --user ${CLI_ZIP_URL}`;

/**
 * On Windows, pip --user installs to a Scripts dir that isn't on PATH by
 * default. Ask the same Python interpreter where it put the scripts, then
 * persist that directory into the user's PATH registry entry.
 *
 * Uses PowerShell's [Environment]::SetEnvironmentVariable rather than setx,
 * which silently truncates PATH at 1024 characters. Entirely best-effort:
 * a failure here still leaves a working install, just not on PATH.
 */
async function addWindowsScriptsToPath(prog) {
  // The pip candidate may be "pip" itself; find the associated Python.
  const py = prog.startsWith('pip') ? 'python' : prog;
  const probe = await execCapture(py, [
    '-c', "import sysconfig; print(sysconfig.get_path('scripts', 'nt_user'))",
  ]);
  const scripts = probe.stdout;
  if (!scripts) return;

  const s = scripts.replace(/'/g, "''"); // PowerShell single-quote escaping
  const psCmd =
    `$s='${s}'; ` +
    `$m=[Environment]::GetEnvironmentVariable('PATH','Machine'); ` +
    `$u=[Environment]::GetEnvironmentVariable('PATH','User'); ` +
    `if($m -notlike ('*'+$s+'*')){ ` +
    `try{[Environment]::SetEnvironmentVariable('PATH',$m.TrimEnd(';')+';'+$s,'Machine')}catch{} ` +
    `}; ` +
    `if((([Environment]::GetEnvironmentVariable('PATH','Machine')) -notlike ('*'+$s+'*')) -and ($u -notlike ('*'+$s+'*'))){ ` +
    `[Environment]::SetEnvironmentVariable('PATH',$u.TrimEnd(';')+';'+$s,'User') ` +
    `}`;

  await execCapture('powershell', [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass', '-Command', psCmd,
  ]);
  applog.info(`install_cli: added ${scripts} to PATH`);
}

async function install_cli() {
  let lastErr = '';

  const attempts = INSTALL_CANDIDATES.flatMap(([prog, prefixArgs]) =>
    util.githubCandidates(CLI_ZIP_URL).map(zipUrl => [prog, prefixArgs, zipUrl]));
  for (const [prog, prefixArgs, zipUrl] of attempts) {
    const result = await execCapture(prog, [...prefixArgs, zipUrl]);
    if (result.ok) {
      applog.info(`install_cli: mcpanel-cli installed from ${zipUrl}`);
      if (process.platform === 'win32') {
        try { await addWindowsScriptsToPath(prog); } catch { /* best-effort */ }
      }
      return 'mcpanel-cli installed successfully';
    }
    lastErr = result.stderr || result.error || '';
  }

  throw new Error(
    'Could not install mcpanel-cli. Make sure Python and pip are installed, then run:\n' +
    `  ${INSTALL_HINT}\nLast error: ${lastErr}`,
  );
}

// Settings → "Update WebUI" / "Update CLI": `mcpanel api updateapp -p <cli|path>`,
// the same code path as the terminal command. The WebUI is updated by passing
// this checkout's own folder as the path.
async function update_app({ product } = {}, ctx) {
  if (product !== 'webui' && product !== 'cli') {
    throw new cli.CliError('Unknown product', 'invalid_arguments');
  }
  applog.info(`update_app: updating ${product}`);
  const r = await runUpdate(product);
  if (r && r.updated && ctx) markRestartPending(ctx, r.message);
  return r;
}

function runUpdate(product) {
  return cli.runCliJson(['updateapp', '-p', product === 'webui' ? cli.WEBUI_DIR : 'cli']);
}

// ─── Auto-update ─────────────────────────────────────────────────────────────
// With Settings → Updates → "Install updates automatically" on, the server
// itself (not a browser tab - there may be none open, or several) installs new
// WebUI / CLI releases shortly after boot and then every few hours. It never
// restarts on its own: running sessions get a "restart required" toast.

const AUTO_UPDATE_FIRST_MS = 60 * 1000;
const AUTO_UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
let autoUpdaterStarted = false;

function autoUpdateEnabled() {
  try {
    return JSON.parse(fs.readFileSync(paths.appSettingsPath(), 'utf8')).autoUpdate === true;
  } catch {
    return false;
  }
}

/** Remembered until the restart, so a tab opened later still gets the toast. */
function markRestartPending(ctx, reason) {
  ctx.state.restartPending = { reason: reason || 'An update was installed.', at: Date.now() };
  ctx.emit('restart-required', ctx.state.restartPending);
}

async function autoUpdateOnce(ctx) {
  if (!autoUpdateEnabled()) return;
  // WebUI first, so the CLI that installs it is still the one that started it.
  for (const product of ['webui', 'cli']) {
    try {
      const r = await runUpdate(product);
      if (r && r.error) applog.warn(`auto-update: ${product}: ${r.error}`);
      else if (r && r.updated) {
        applog.info(`auto-update: ${r.message}`);
        markRestartPending(ctx, r.message);
      }
    } catch (e) {
      applog.warn(`auto-update: ${product}: ${e.message}`);
    }
  }
}

function __start_autoupdater(_args, ctx) {
  if (autoUpdaterStarted) return;
  autoUpdaterStarted = true;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await autoUpdateOnce(ctx); } finally { running = false; }
  };
  const first = setTimeout(tick, AUTO_UPDATE_FIRST_MS);
  const timer = setInterval(tick, AUTO_UPDATE_EVERY_MS);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
}

async function get_restart_pending(_args, ctx) {
  return ctx.state.restartPending || null;
}

// ─── Quit / restart ──────────────────────────────────────────────────────────

function releaseResources(state) {
  // Cancel any in-progress backup and delete the partial zip - a half-written
  // archive left behind would look like a real restore point.
  if (state.activeBackup) {
    const bkp = state.activeBackup;
    state.activeBackup = null;
    try { bkp.child.kill('SIGKILL'); } catch { /* already gone */ }
    if (bkp.zipPath) {
      try { fs.rmSync(bkp.zipPath, { force: true }); } catch { /* ignore */ }
    }
  }

  for (const [, streamer] of state.logStreamers) {
    try { streamer.stop(); } catch { /* ignore */ }
  }
  state.logStreamers.clear();

  try { fs.rmSync(paths.uploadStageDir(), { recursive: true, force: true }); } catch { /* ignore */ }
}

async function quit_app(_args, ctx) {
  releaseResources(ctx.state);
  applog.info('quit_app: shutting down');

  // Deferred so this invoke's HTTP response still flushes to the browser.
  setTimeout(() => process.exit(0), 150);

  return { success: true };
}

// Exit code that tells a supervisor this exit is a restart request. systemd
// (Restart=on-failure or always) and pm2 relaunch the process themselves, so
// spawning a replacement under them would leave two WebUIs fighting over the
// port - or one the supervisor kills along with its old main process.
const RESTART_EXIT_CODE = 75;

function supervised() {
  if (process.env.MCPANEL_WEBUI_SUPERVISED === '1' || process.env.pm_id !== undefined) return true;
  // A systemd service's stderr is the journal, which systemd announces as
  // JOURNAL_STREAM=<dev>:<inode>. Desktop sessions pass the variable down to
  // terminals too, so it only counts when it really is our stderr (and
  // INVOCATION_ID can't be used at all - every session scope sets it).
  const js = process.env.JOURNAL_STREAM;
  if (!js) return false;
  try {
    const st = fs.fstatSync(2);
    return js === `${st.dev}:${st.ino}`;
  } catch {
    return false;
  }
}

function relaunch() {
  if (supervised()) process.exit(RESTART_EXIT_CODE);
  // Same node, flags, script and arguments. The replacement retries its listen
  // while this process lets go of the port (see MCPANEL_WEBUI_RELAUNCHED in
  // index.js). Detached on Unix so it survives this process's group; Windows
  // doesn't kill children with their parent anyway.
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    cwd: process.cwd(),
    env: { ...process.env, MCPANEL_WEBUI_RELAUNCHED: '1' },
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  child.unref();
  process.exit(0);
}

// The "Restart MCPanel-WebUI" toast button after an update or an addon
// change. Minecraft servers run under the CLI's supervisor and keep running.
async function restart_app(_args, ctx) {
  releaseResources(ctx.state);
  applog.info('restart_app: restarting');
  setTimeout(relaunch, 150);
  return { success: true };
}

module.exports = {
  check_cli,
  run_cli,
  save_config,
  get_app_version,
  get_app_log_path,
  log_event,
  check_first_start_flag,
  check_app_update,
  update_app,
  check_cli_update,
  install_cli,
  quit_app,
  restart_app,
  get_restart_pending,
  __start_autoupdater,
};
