let config = { servers: [], jdkPaths: [] };
let profiles = [];
let currentServerId = null;
let systemInfo = { totalRam: null, availableStorage: null, totalStorage: null };
// Host-CPU facts, cached from getSystemStats - used for the detail CPU sub.
let systemCpu = { threads: null, cores: null, freqMhz: null, name: null };
let versionCache = {};
let statusPollInterval = null;
let statusFetchRetryAt = {};   // server id -> ms timestamp to resume polling after a fetch error
let uptimeInterval = null;
let sidebarStatsInterval = null;
let commandHistory = [];
let historyIndex = -1;
let startingServers = new Set();
let serverStartTimes = {};
let pendingEulaServerId = null;
let consoleAutoScroll = true;
let consoleLogOffset = 0;
let consolePollInterval = null;
let detailStatsInterval = null;
let selectedFilePaths = new Set();
let serverPlayerData = {};
let serversSortBy = localStorage.getItem('mcpanel-servers-sort') || 'name';
let profilesSortBy = localStorage.getItem('mcpanel-profiles-sort') || 'name';
let serversSortReversed = localStorage.getItem('mcpanel-servers-sort-dir') === '1';
let serversView = localStorage.getItem('mcpanel-servers-view') === 'list' ? 'list' : 'blocks';
let profilesSortReversed = localStorage.getItem('mcpanel-profiles-sort-dir') === '1';

async function init() {
  config = await window.mcpanel.getConfig();
  window.mcpanel.getSystemInfo().then(info => { systemInfo = info; });
  await loadAppSettings();

  await ensureBuiltinThemes();

  const defaultThemeId = await window.mcpanel.getDefaultTheme();

  // Apply saved theme before rendering UI to avoid flash
  if (!config.activeTheme) {
    config.activeTheme = defaultThemeId;
    await window.mcpanel.saveConfig(config);
  }
  await loadAndApplyTheme(config.activeTheme);
  const _initThemes = await window.mcpanel.getThemes();
  const _initTheme = _initThemes.find(t => t.id === config.activeTheme);
  if (_initTheme) {
    document.getElementById('active-theme-name').textContent = _initTheme.name;
  }
  if (config.activeTheme !== defaultThemeId) {
    document.getElementById('reset-theme-btn').style.display = '';
  }
  // Titlebar logo (respects the theme's --app-icon when on Auto)
  applyAppIcon();

  window.mcpanel.getVersion().then(v => {
    const el = document.getElementById('about-version');
    if (el) el.textContent = `MCPanel-WebUI v${v} · Built for Minecraft server management`;
  });

  profiles = await window.mcpanel.getProfiles();
  const serversSortSel = document.getElementById('servers-sort');
  if (serversSortSel) serversSortSel.value = serversSortBy;
  const profilesSortSel = document.getElementById('profiles-sort');
  if (profilesSortSel) profilesSortSel.value = profilesSortBy;
  _setSortDirBtnState('servers-sort-dir-btn', serversSortReversed);
  _setSortDirBtnState('profiles-sort-dir-btn', profilesSortReversed);
  _applyServersView();
  renderServersGrid();
  renderSidebarServers();
  startStatusPolling();
  startUptimeTicker();
  setupConsoleScroll();
  setupConsolePlayerMenu();
  setupScrollHoverGuard();

  // Awaited so the loading screen stays up until the stats are filled in.
  await Promise.allSettled([updateSidebarStats(), updateServersPageStats()]);
  if (sidebarStatsInterval) clearInterval(sidebarStatsInterval);
  sidebarStatsInterval = setInterval(updateSidebarStats, 5000);

  window.mcpanel.on('server-stopped', ({ id }) => {
    startingServers.delete(id);
    delete serverStartTimes[id];
    const uptimeEl = document.getElementById(`uptime-${id}`);
    if (uptimeEl) uptimeEl.textContent = '-';
    if (id === currentServerId) {
      appendConsoleLine('Server stopped.', 'system');
      updateDetailControls(false);
      const detailUptime = document.getElementById('detail-uptime');
      if (detailUptime) detailUptime.textContent = '-';
    }
    updateServerCardStatus(id, false, 0);
    updateSidebarDot(id, false);
  });

  window.mcpanel.on('download-progress', ({ id, progress, status }) => {
    document.getElementById('download-status-text').textContent = status;
    document.getElementById('progress-bar-fill').style.width = progress + '%';
    document.getElementById('progress-percent').textContent = progress + '%';
  });

  window.mcpanel.checkUpdate().then(result => applyUpdateResult(result));
  window.mcpanel.checkCliUpdate().then(result => applyCliUpdateResult(result));
  // Updates the server installed on its own (auto-update) - admins only.
  showPendingRestart();
  window.mcpanel.on('restart-required', showPendingRestart);
  window.mcpanel.getBuildToolsVersion().then(result => {
    applyBuildToolsResult(result);
    if (result && result.version !== 'installed') showBuildToolsMissingModal();
  }).catch(() => {});
  checkPrivacyPolicy();

  const _win = window.__TAURI__?.window?.getCurrentWindow?.();
  if (_win?.listen) {
    // Highlight the folder row under the cursor while OS files hover the window.
    _win.listen('tauri://drag-over', (event) => {
      const row = _folderRowAt(event.payload);
      document.querySelectorAll('.file-row.drop-target').forEach(r => { if (r !== row) r.classList.remove('drop-target'); });
      if (row) row.classList.add('drop-target');
    });
    _win.listen('tauri://drag-leave', () => {
      document.querySelectorAll('.file-row.drop-target').forEach(r => r.classList.remove('drop-target'));
    });
    _win.listen('tauri://drag-drop', async (event) => {
      const paths = event.payload?.paths || [];
      if (!paths.length) return;
      // Released over a folder row: drop INTO that folder, not the open one.
      const targetRow = _folderRowAt(event.payload);

      const profilePane = document.getElementById('pane-profile-files');
      if (currentProfileId && profilePane && !profilePane.classList.contains('hidden')) {
        document.getElementById('profile-file-drop-zone')?.classList.remove('drop-active');
        document.querySelectorAll('.file-row.drop-target').forEach(r => r.classList.remove('drop-target'));
        const into = targetRow && profilePane.contains(targetRow) ? targetRow.dataset.dropDir : null;
        await uploadProfileFilesFromPaths(paths, into ?? profileNavPaths.join('/'));
        return;
      }

      if (!currentServerId) return;
      const pane = document.getElementById('pane-files');
      if (!pane || pane.classList.contains('hidden')) return;
      document.getElementById('file-drop-zone')?.classList.remove('drop-active');
      document.querySelectorAll('.file-row.drop-target').forEach(r => r.classList.remove('drop-target'));
      const into = targetRow && pane.contains(targetRow) ? targetRow.dataset.dropDir : null;
      await uploadFilesFromPaths(paths, into ?? fileNavPaths.join('/'));
    });

  }

  const debugFlag = await window.mcpanel.checkFirstStartFlag();
  if (debugFlag || !config.firstStartDone) {
    openFirstStart();
  }
}

let _appSettings = { runInBackground: true, fonts: { display: 'Poppins', displayWeight: '400', mono: 'JetBrains Mono', monoWeight: '400' } };

async function loadAppSettings() {
  try {
    _appSettings = await window.mcpanel.getAppSettings();
  } catch (e) {
    // defaults already set
  }
  const el = document.getElementById('setting-run-in-bg');
  if (el) el.checked = _appSettings.runInBackground !== false;
  const clearEl = document.getElementById('setting-clear-console-on-start');
  if (clearEl) clearEl.checked = _appSettings.clearConsoleOnStart === true;
  const autoUpdateEl = document.getElementById('setting-auto-update');
  if (autoUpdateEl) autoUpdateEl.checked = _appSettings.autoUpdate === true;
  const maxLogFilesEl = document.getElementById('setting-max-log-files');
  if (maxLogFilesEl) maxLogFilesEl.value = _appSettings.maxLogFiles || 10;
  applyFontSettings(_appSettings.fonts || {});
  _syncFontSelects(_appSettings.fonts || {});
  populateFontLists(_appSettings.fonts || {});
}

async function saveRunInBackground() {
  _appSettings.runInBackground = document.getElementById('setting-run-in-bg').checked;
  await window.mcpanel.saveAppSettings(_appSettings);
}

async function saveClearConsoleOnStart() {
  _appSettings.clearConsoleOnStart = document.getElementById('setting-clear-console-on-start').checked;
  await window.mcpanel.saveAppSettings(_appSettings);
}

async function saveAutoUpdate() {
  _appSettings.autoUpdate = document.getElementById('setting-auto-update').checked;
  await window.mcpanel.saveAppSettings(_appSettings);
}

async function saveMaxLogFiles() {
  const el = document.getElementById('setting-max-log-files');
  const n = Math.max(1, Math.min(100, parseInt(el.value, 10) || 10));
  el.value = n;
  _appSettings.maxLogFiles = n;
  await window.mcpanel.saveAppSettings(_appSettings);
}

// ─── Network settings ───────────────────────────────────────────────────────
// Host/port the WebUI itself listens on - separate from _appSettings (those
// are client preferences; this is the server's own listening socket, applied
// live by save_network_config without a process restart).

async function loadNetworkSettings() {
  const hostEl = document.getElementById('setting-network-host');
  const portEl = document.getElementById('setting-network-port');
  const reachableEl = document.getElementById('network-reachable-at');
  if (!hostEl || !portEl || !reachableEl) return;

  let cfg;
  try {
    cfg = await window.mcpanel.getNetworkConfig();
  } catch (e) {
    reachableEl.textContent = 'Could not load network settings.';
    return;
  }

  hostEl.value = cfg.host || '0.0.0.0';
  portEl.value = cfg.port || 8730;

  const port = cfg.port || 8730;
  const urls = [`http://localhost:${port}/`];
  for (const addr of cfg.lanAddresses || []) {
    urls.push(`http://${addr.address}:${port}/`);
  }
  reachableEl.innerHTML = urls.map(u => `<div class="mono">${u}</div>`).join('');
}

async function saveNetworkSettings() {
  const hostEl = document.getElementById('setting-network-host');
  const portEl = document.getElementById('setting-network-port');
  const host = (hostEl.value || '').trim();
  const port = parseInt(portEl.value, 10);

  if (!host) { toast('Host is required', 'error'); return; }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    toast('Port must be between 1 and 65535', 'error');
    return;
  }

  try {
    await window.mcpanel.saveNetworkConfig(host, port);
    toast(`Applying ${host}:${port} - this tab will disconnect`, 'success');
  } catch (e) {
    toast(e && e.message ? e.message : 'Failed to save network settings', 'error');
  }
}

// ─── App Icon ─────────────────────────────────────────────────────────────────
// Swaps the in-app titlebar logo (top-left corner) between bundled variants.
// This is purely an in-app HTML image - it does NOT touch the native OS window/
// taskbar icon (that's owned by the .desktop file / platform).
// The user-facing picker has been removed; the icon now always resolves from
// the active theme's `--app-icon` hint, falling back to the default.
const APP_ICONS = [
  { key: 'default',       label: 'Default' },
  { key: 'blue',          label: 'Blue' },
  { key: 'green',         label: 'Green' },
  { key: 'red',           label: 'Red' },
  { key: 'yellow',        label: 'Yellow' },
  { key: 'black',         label: 'Black' },
  { key: 'white',         label: 'White' },
  { key: 'outline',       label: 'Outline' },
  { key: 'outline-white', label: 'Outline White' },
];
const APP_ICON_KEYS = APP_ICONS.map(i => i.key);

function _iconAssetPath(key) {
  return key === 'default' ? 'assets/icons/icon.png' : `assets/icons/icon-${key}.png`;
}

// Icon suggested by the active theme via `:root { --app-icon: <key>; }`.
// Returns '' when the theme doesn't specify one.
function themeSuggestedIcon() {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--app-icon').trim().replace(/['"]/g, '');
  return APP_ICON_KEYS.includes(raw) ? raw : '';
}

function resolveAppIcon() {
  return themeSuggestedIcon() || 'default';
}

function applyAppIcon() {
  const src = _iconAssetPath(resolveAppIcon());
  const img = document.getElementById('titlebar-logo-img');
  if (img) img.src = src;
  // Other copies of the logo (e.g. the collapsed sidebar's) follow the same choice.
  document.querySelectorAll('[data-app-logo]').forEach(el => { el.src = src; });
}

async function requestClose() {
  const runningIds = Object.keys(serverStartTimes);
  const runInBg = _appSettings.runInBackground !== false;
  if (!runInBg && runningIds.length > 0) {
    const n = runningIds.length;
    if (!confirm(`Stop ${n} server${n !== 1 ? 's' : ''} before closing MCPanel-WebUI?`)) return;
    await window.mcpanel.shutdownAllServers();
  } else if (runInBg && runningIds.length > 0) {
    const n = runningIds.length;
    if (!confirm(`${n} server${n !== 1 ? 's are' : ' is'} still running and will continue after MCPanel-WebUI closes.\n\nClose anyway?`)) return;
  }
  window.mcpanel.close();
}

function showPage(page) {
  stopConsolePoll();
  if (detailStatsInterval) { clearInterval(detailStatsInterval); detailStatsInterval = null; }
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.getElementById('page-' + page).classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navItem = document.querySelector(`[data-page="${page}"]`);
  if (navItem) navItem.classList.add('active');
  // Leaving the server page: its sidebar entry must not stay highlighted.
  document.querySelectorAll('.sidebar-server-item.active').forEach(el => el.classList.remove('active'));

  if (page === 'profiles') renderProfilesGrid();
  if (page === 'servers') renderServersGrid();
  if (page === 'settings') { renderInstalledThemes(); loadNetworkSettings(); }
  // Addon pages render here; addons can also react to built-in pages.
  window.MCPanelAddons?._pageShown(page);
}

function openServerDetail(id) {
  currentServerId = id;
  cachedFileTree = null; fileNavStack = []; fileNavPaths = []; selectedFilePaths = new Set();
  const _pluginListEl = document.getElementById('server-plugin-list');
  if (_pluginListEl) _pluginListEl.innerHTML = `<div class="plugin-state-msg">Search for plugins or mods to install them.</div>`;
  const _pluginSearchEl = document.getElementById('server-plugin-search');
  if (_pluginSearchEl) _pluginSearchEl.value = '';
  currentLogFile = 'latest.log';
  switchDetailTab('console');
  const srv = config.servers.find(s => s.id === id);
  if (!srv) return;
  window.mcpanel.logEvent(`Opened server panel: ${srv.name} -id ${id}`);
  window.MCPanelAddons?._serverOpened(id);

  document.querySelectorAll('.sidebar-server-item').forEach(el => el.classList.remove('active'));
  const sidebarItem = document.querySelector(`[data-server-id="${id}"]`);
  if (sidebarItem) sidebarItem.classList.add('active');

  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.getElementById('page-server-detail').classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  document.getElementById('detail-server-name').textContent = srv.name;
  document.getElementById('detail-server-subtitle').textContent =
    `${serverTypeLabel(srv)} · Port ${srv.port}`;
  document.getElementById('dtab-plugins-label').textContent = _pluginTabLabel(srv.software);
  // Custom servers run whatever the user brought: no plugin manager.
  document.getElementById('dtab-plugins').classList.toggle('hidden', !_pluginsSupported(srv.software));
  _toggleJavaFields('quick', srv.software);
  document.getElementById('detail-port').textContent = srv.port;
  setRamBar(0, srv.ram, srv.heap);
  setCpuGauge(null, false);

  document.getElementById('quick-port').value = srv.port;
  document.getElementById('quick-java-args').value = srv.javaArgs || '';
  populateJdkSelect('quick', 'quick-java-path', srv.javaPath || 'java');
  document.getElementById('quick-group').value = srv.group || '';

  const velocityCard = document.getElementById('velocity-quick-options');
  if (velocityCard) {
    if (srv.software === 'velocity') {
      velocityCard.classList.remove('hidden');
    } else {
      velocityCard.classList.add('hidden');
    }
  }
  renderProxyLink(srv);

  consoleAutoScroll = true;
  document.getElementById('autoscroll-banner').classList.add('hidden');
  const logEl = document.getElementById('console-output');
  logEl.innerHTML = '';
  stopConsolePoll();
  consoleLogOffset = 0;
  seedConsolePlayers(id);

  window.mcpanel.isServerRunning(id).then(running => {
    updateDetailControls(running);
    if (running) {
      updateDetailOnline(true);
      // Only load persisted logs when server is actively running (fresh log from rotate_log)
      window.mcpanel.getLogSince(id, 0).then(result => {
        consoleLogOffset = result.offset || 0;
        (result.lines || []).forEach(entry => appendConsoleLine(entry.text || '', entry.type || 'out'));
        startConsolePoll(id);
      });
    } else {
      // Server is stopped - start polling so logs appear when it starts
      startConsolePoll(id);
    }
  });

  const detailUptime = document.getElementById('detail-uptime');
  if (detailUptime) {
    detailUptime.textContent = serverStartTimes[id] ? formatUptime(Date.now() - serverStartTimes[id]) : '-';
  }

  refreshDetailStats(id);
  if (detailStatsInterval) clearInterval(detailStatsInterval);
  detailStatsInterval = setInterval(() => refreshDetailStats(currentServerId), 5000);
}

async function refreshDetailStats(id) {
  if (!id) return;
  const srv = config.servers.find(s => s.id === id);
  if (!srv) return;
  const result = await window.mcpanel.getServerDirStats(id);
  setStorageBar(result.size, srv.storageLimit);
  setRamBar(result.ramBytes || 0, srv.ram, srv.heap);
  const online = result.cpuPct != null;
  setCpuGauge(online ? result.cpuPct : null, online);
}

function onServersSortChange() {
  serversSortBy = document.getElementById('servers-sort').value;
  localStorage.setItem('mcpanel-servers-sort', serversSortBy);
  renderServersGrid();
}

function onProfilesSortChange() {
  profilesSortBy = document.getElementById('profiles-sort').value;
  localStorage.setItem('mcpanel-profiles-sort', profilesSortBy);
  renderProfilesGrid();
}

// Servers page layout: 'blocks' (cards) or 'list' (one compact row each).
// The button shows the icon of the view it switches TO.
const _VIEW_ICON_LIST = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>';
const _VIEW_ICON_BLOCKS = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg>';

function _applyServersView() {
  document.getElementById('servers-grid')?.classList.toggle('list-view', serversView === 'list');
  const btn = document.getElementById('servers-view-btn');
  if (btn) {
    btn.innerHTML = serversView === 'list' ? _VIEW_ICON_BLOCKS : _VIEW_ICON_LIST;
    btn.title = serversView === 'list' ? 'Switch to block view' : 'Switch to list view';
  }
}

function onServersViewToggle() {
  serversView = serversView === 'list' ? 'blocks' : 'list';
  localStorage.setItem('mcpanel-servers-view', serversView);
  _applyServersView();
}

function _setSortDirBtnState(btnId, reversed) {
  const btn = document.getElementById(btnId);
  if (btn) btn.classList.toggle('reversed', reversed);
}

function onServersSortDirToggle() {
  serversSortReversed = !serversSortReversed;
  localStorage.setItem('mcpanel-servers-sort-dir', serversSortReversed ? '1' : '0');
  _setSortDirBtnState('servers-sort-dir-btn', serversSortReversed);
  renderServersGrid();
}

function onProfilesSortDirToggle() {
  profilesSortReversed = !profilesSortReversed;
  localStorage.setItem('mcpanel-profiles-sort-dir', profilesSortReversed ? '1' : '0');
  _setSortDirBtnState('profiles-sort-dir-btn', profilesSortReversed);
  renderProfilesGrid();
}

function sortServers(list) {
  const sign = serversSortReversed ? -1 : 1;
  const sorted = [...list];
  if (serversSortBy === 'created') {
    sorted.sort((a, b) => sign * ((b.created || 0) - (a.created || 0)));
  } else if (serversSortBy === 'lastBoot') {
    sorted.sort((a, b) => sign * ((b.lastBoot || 0) - (a.lastBoot || 0)));
  } else {
    sorted.sort((a, b) => sign * a.name.localeCompare(b.name));
  }
  return sorted;
}

function sortProfiles(list) {
  const sign = profilesSortReversed ? -1 : 1;
  const sorted = [...list];
  if (profilesSortBy === 'created') {
    sorted.sort((a, b) => sign * ((b.created || 0) - (a.created || 0)));
  } else if (profilesSortBy === 'lastBoot') {
    // Profiles don't boot themselves - sort by the most recent boot among
    // the servers currently using each profile ("last used").
    const lastUsed = {};
    (config.servers || []).forEach(s => {
      if (!s.profileId) return;
      const t = s.lastBoot || 0;
      if (t > (lastUsed[s.profileId] || 0)) lastUsed[s.profileId] = t;
    });
    sorted.sort((a, b) => sign * ((lastUsed[b.id] || 0) - (lastUsed[a.id] || 0)));
  } else {
    sorted.sort((a, b) => sign * a.name.localeCompare(b.name));
  }
  return sorted;
}

function renderServersGrid() {
  const query = (document.getElementById('servers-search')?.value || '').trim().toLowerCase();
  const grid = document.getElementById('servers-grid');
  const empty = document.getElementById('servers-empty');
  grid.querySelectorAll('.server-card, .group-header, .grid-no-results').forEach(c => c.remove());

  if (config.servers.length === 0) {
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  const servers = sortServers(query
    ? config.servers.filter(s =>
        s.name.toLowerCase().includes(query) ||
        (s.group || '').toLowerCase().includes(query) ||
        s.software.toLowerCase().includes(query) ||
        s.version.toLowerCase().includes(query)
      )
    : config.servers);

  if (servers.length === 0) {
    const msg = document.createElement('div');
    msg.className = 'grid-no-results';
    msg.textContent = `No servers matching "${query}"`;
    grid.appendChild(msg);
    return;
  }

  if (query) {
    servers.forEach(srv => grid.appendChild(createServerCard(srv)));
    return;
  }

  const hasGroups = servers.some(s => s.group);
  if (!hasGroups) {
    servers.forEach(srv => grid.appendChild(createServerCard(srv)));
    return;
  }

  const groups = {};
  const ungrouped = [];
  servers.forEach(srv => {
    if (srv.group) {
      if (!groups[srv.group]) groups[srv.group] = [];
      groups[srv.group].push(srv);
    } else {
      ungrouped.push(srv);
    }
  });

  Object.entries(groups).forEach(([groupName, srvs]) => {
    const header = document.createElement('div');
    header.className = 'group-header';
    header.innerHTML = `<span class="group-name">${escapeHtml(groupName)}</span><span class="group-count">${srvs.length} server${srvs.length !== 1 ? 's' : ''}</span>`;
    grid.appendChild(header);
    srvs.forEach(srv => grid.appendChild(createServerCard(srv)));
  });

  if (ungrouped.length > 0) {
    const header = document.createElement('div');
    header.className = 'group-header';
    header.innerHTML = `<span class="group-name">Ungrouped</span><span class="group-count">${ungrouped.length} server${ungrouped.length !== 1 ? 's' : ''}</span>`;
    grid.appendChild(header);
    ungrouped.forEach(srv => grid.appendChild(createServerCard(srv)));
  }
}

function createServerCard(srv) {
  const card = document.createElement('div');
  card.className = 'server-card';
  card.id = `card-${srv.id}`;
  card.innerHTML = `
    <div class="server-card-header">
      <div>
        <div class="server-card-name">${escapeHtml(srv.name)}</div>
        <div class="server-card-sub">${escapeHtml(serverTypeLabel(srv))}</div>
      </div>
      <div class="status-badge offline" id="badge-${srv.id}">OFFLINE</div>
    </div>
    <div class="server-card-stats">
      <div class="stat-chip">
        <div class="stat-chip-label">Port</div>
        <div class="stat-chip-value">${srv.port}</div>
      </div>
      <div class="stat-chip">
        <div class="stat-chip-label">RAM</div>
        <div class="stat-chip-value" id="ram-${srv.id}">${cardRamText(srv)}</div>
      </div>
      <div class="stat-chip">
        <div class="stat-chip-label">Players</div>
        <div class="stat-chip-value" id="players-${srv.id}">${cardPlayersText(srv)}</div>
      </div>
      <div class="stat-chip">
        <div class="stat-chip-label">Storage</div>
        <div class="stat-chip-value" id="storage-${srv.id}">${cardStorageText(srv)}</div>
      </div>
      <div class="stat-chip">
        <div class="stat-chip-label">Uptime</div>
        <div class="stat-chip-value" id="uptime-${srv.id}">-</div>
      </div>
    </div>
    <div class="server-card-footer">
      <button class="btn-ghost" style="font-size:12px;padding:6px 12px" onclick="openServerDetail('${srv.id}')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        Manage
      </button>
      <div class="card-quick-controls">
        <button class="quick-ctrl-btn start" id="quick-start-${srv.id}" title="Start" onclick="quickStart('${srv.id}', event)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        <button class="quick-ctrl-btn stop" id="quick-stop-${srv.id}" title="Stop" onclick="quickStop('${srv.id}', event)" style="display:none">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
        </button>
      </div>
    </div>
  `;
  return card;
}

function updateServerCardStatus(id, online, players) {
  const badge = document.getElementById(`badge-${id}`);
  const playersEl = document.getElementById(`players-${id}`);
  const startBtn = document.getElementById(`quick-start-${id}`);
  const stopBtn = document.getElementById(`quick-stop-${id}`);
  if (badge) {
    if (online === 'starting') {
      badge.className = 'status-badge starting';
      badge.textContent = 'STARTING';
    } else if (online) {
      badge.className = 'status-badge online';
      badge.textContent = 'ONLINE';
    } else {
      badge.className = 'status-badge offline';
      badge.textContent = 'OFFLINE';
    }
  }
  const srv = config.servers.find(s => s.id === id);
  if (online !== true && cardStats[id]) delete cardStats[id].ramBytes;
  if (playersEl) playersEl.textContent = cardPlayersText(srv, online === true ? players : 0);
  const ramEl = document.getElementById(`ram-${id}`);
  if (ramEl) ramEl.textContent = cardRamText(srv);
  if (startBtn) startBtn.style.display = online ? 'none' : '';
  if (stopBtn) stopBtn.style.display = online ? '' : 'none';
}

// First visible character of a server name, exactly as written — lowercase
// stays lowercase, and accented letters, symbols and multi-part emoji stay
// whole (one grapheme, not one UTF-16 unit). Shown in the collapsed sidebar.
function _serverInitial(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      const first = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)[Symbol.iterator]().next();
      if (!first.done) return first.value.segment;
    }
  } catch { /* fall back below */ }
  return Array.from(s)[0];
}

const SIDEBAR_RAIL_MAX = 8;   // servers shown in the collapsed sidebar (first N, expanded order)

function renderSidebarServers() {
  const container = document.getElementById('sidebar-servers');
  if (config.servers.length === 0) {
    container.innerHTML = `<div style="padding:12px;font-size:11px;color:var(--text-muted);text-align:center">No servers</div>`;
    return;
  }
  container.innerHTML = '';

  const groups = new Map();
  config.servers.forEach(srv => {
    const key = srv.group || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(srv);
  });

  let shown = 0;
  const appendServer = (srv) => {
    const btn = document.createElement('button');
    btn.className = 'sidebar-server-item';
    if (shown++ >= SIDEBAR_RAIL_MAX) btn.classList.add('rail-overflow');
    if (_sidebarOnline[srv.id]) btn.classList.add('srv-online');
    btn.dataset.serverId = srv.id;
    btn.title = srv.name;
    btn.innerHTML = `
      <span class="srv-initial" aria-hidden="true">${escapeHtml(_serverInitial(srv.name))}</span>
      <div class="srv-dot ${_sidebarOnline[srv.id] ? 'online' : 'offline'}" id="sdot-${srv.id}"></div>
      <span class="srv-name">${escapeHtml(srv.name)}</span>
      <button class="srv-quick-btn" title="Quick start/stop" id="sqbtn-${srv.id}" onclick="sidebarQuickToggle('${srv.id}', event)">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      </button>
    `;
    btn.onclick = (e) => {
      if (e.target.closest('.srv-quick-btn')) return;
      openServerDetail(srv.id);
    };
    container.appendChild(btn);
  };

  if (groups.has('')) {
    groups.get('').forEach(appendServer);
    groups.delete('');
  }

  groups.forEach((servers, groupName) => {
    const header = document.createElement('div');
    header.className = 'sidebar-category-header';
    // A divider for a group none of whose servers fit in the rail is hidden too.
    if (shown >= SIDEBAR_RAIL_MAX) header.classList.add('rail-overflow');
    header.textContent = groupName;
    container.appendChild(header);
    servers.forEach(appendServer);
  });
}

// Last known online state per server, so a re-rendered sidebar keeps it
// instead of showing everything offline until the next status poll.
const _sidebarOnline = {};

function updateSidebarDot(id, online) {
  _sidebarOnline[id] = !!online;
  document.querySelector(`.sidebar-server-item[data-server-id="${id}"]`)?.classList.toggle('srv-online', !!online);
  const dot = document.getElementById(`sdot-${id}`);
  if (dot) {
    dot.className = `srv-dot ${online ? 'online' : 'offline'}`;
  }
  const qbtn = document.getElementById(`sqbtn-${id}`);
  if (qbtn) {
    qbtn.innerHTML = online
      ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
      : `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  }
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function startUptimeTicker() {
  if (uptimeInterval) clearInterval(uptimeInterval);
  uptimeInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, startTime] of Object.entries(serverStartTimes)) {
      const uptime = formatUptime(now - startTime);
      const cardEl = document.getElementById(`uptime-${id}`);
      if (cardEl) cardEl.textContent = uptime;
      if (currentServerId === id) {
        const detailEl = document.getElementById('detail-uptime');
        if (detailEl) detailEl.textContent = uptime;
      }
    }
  }, 1000);
}

function startStatusPolling() {
  if (statusPollInterval) clearInterval(statusPollInterval);
  statusPollInterval = setInterval(pollAllStatuses, 5000);
  pollAllStatuses();
}

async function pollAllStatuses() {
  const now = Date.now();
  for (const srv of config.servers) {
    if (statusFetchRetryAt[srv.id] && now < statusFetchRetryAt[srv.id]) continue;
    let running;
    try {
      running = await window.mcpanel.isServerRunning(srv.id);
      delete statusFetchRetryAt[srv.id];
    } catch (e) {
      // Back off this server for a minute instead of hammering a broken
      // CLI/fetch path every 5s - errors already get logged on the Rust side.
      statusFetchRetryAt[srv.id] = now + 60000;
      continue;
    }
    if (running) {
      const status = await window.mcpanel.pingServer('127.0.0.1', parseInt(srv.port));
      if (status && status.players != null) {
        if (!serverStartTimes[srv.id]) {
          const t = await window.mcpanel.getServerStartTime(srv.id);
          serverStartTimes[srv.id] = t || Date.now();
        }
        startingServers.delete(srv.id);
        serverPlayerData[srv.id] = { players: status.players || 0, maxPlayers: status.maxPlayers || 0, isVelocity: srv.software === 'velocity' };
        const live = await window.mcpanel.getServerDirStats(srv.id, { noSize: true });
        cardStats[srv.id] = { ...cardStats[srv.id], ramBytes: live.ramBytes, maxPlayers: status.maxPlayers || live.maxPlayers };
        updateServerCardStatus(srv.id, true, status.players || 0);
        updateSidebarDot(srv.id, true);
        if (currentServerId === srv.id) {
          updateDetailOnline(true, status.players, status.maxPlayers, status.playerList || []);
        }
      } else {
        // Process is running but not accepting connections yet - STARTING
        updateServerCardStatus(srv.id, 'starting', 0);
        updateSidebarDot(srv.id, true);
        if (currentServerId === srv.id) updateDetailStarting();
      }
    } else {
      startingServers.delete(srv.id);
      delete serverPlayerData[srv.id];
      if (serverStartTimes[srv.id]) {
        delete serverStartTimes[srv.id];
        const uptimeEl = document.getElementById(`uptime-${srv.id}`);
        if (uptimeEl) uptimeEl.textContent = '-';
        if (currentServerId === srv.id) {
          const detailUptime = document.getElementById('detail-uptime');
          if (detailUptime) detailUptime.textContent = '-';
        }
      }
      updateServerCardStatus(srv.id, false, 0);
      updateSidebarDot(srv.id, false);
      if (currentServerId === srv.id) {
        updateDetailControls(false);
        setRamBar(0, srv.ram, srv.heap);
        setPlayersBar(0, 0, false);
        setCpuGauge(null, false);
        currentOnlinePlayers = [];
      }
    }
  }
  updateServersPageStats();
  refreshCardSizes();
}

// ─── Server card stats (used / max) ────────────────────────────────────────────
// cardStats[id] = { size, sizeAt, ramBytes, maxPlayers }. Disk usage walks the
// whole server folder (worlds included), so it is refreshed at most once a
// minute per server; RAM comes with the 5 s status poll for running servers.
const cardStats = {};
const CARD_SIZE_TTL = 60000;
let cardSizesRunning = false;

// 1.4GB / 512MB - whole numbers past 10 GB, and no trailing ".0".
function _compactSize(bytes) {
  if (bytes == null) return '…';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb >= 10 ? Math.round(gb) : +gb.toFixed(1)}GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))}MB`;
}

// A limit as typed ("6G", "2048M", "20GB") shown in the same units as the
// usage next to it; left as typed if it can't be read. A RAM value without a
// unit is megabytes, like everywhere else in MCPanel.
function _limitText(value, bareUnit = '') {
  if (!value) return '∞';
  const bytes = parseStorageLimit(/^\d+(\.\d+)?$/.test(String(value).trim()) ? `${value}${bareUnit}` : value);
  return bytes ? _compactSize(bytes) : String(value);
}

function cardRamText(srv) {
  if (!srv) return '-';
  const used = cardStats[srv.id]?.ramBytes;
  // Over the cap, the limit shown is the RAM cap + heap cap.
  const capMb = ramToMb(srv.ram);
  const heapMb = ramToMb(srv.heap) || autoHeapMb(srv.ram);
  if (used && capMb && heapMb && used > capMb * 1048576) {
    return `${_compactSize(used)}/${_compactSize((capMb + heapMb) * 1048576)}`;
  }
  return `${used ? _compactSize(used) : '0'}/${_limitText(srv.ram, 'M')}`;
}

function cardPlayersText(srv, online) {
  if (!srv) return '-';
  const max = serverPlayerData[srv.id]?.maxPlayers || cardStats[srv.id]?.maxPlayers;
  const now = online ?? serverPlayerData[srv.id]?.players ?? 0;
  return `${now}/${max ?? '?'}`;
}

function cardStorageText(srv) {
  if (!srv) return '-';
  return `${_compactSize(cardStats[srv.id]?.size)}/${_limitText(srv.storageLimit)}`;
}

function _paintCardStats(srv) {
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  set(`storage-${srv.id}`, cardStorageText(srv));
  set(`ram-${srv.id}`, cardRamText(srv));
  set(`players-${srv.id}`, cardPlayersText(srv));
}

// One server at a time, oldest first, so a slow disk never holds up the poll.
async function refreshCardSizes() {
  if (cardSizesRunning) return;
  cardSizesRunning = true;
  try {
    const now = Date.now();
    const due = config.servers.filter(s => !cardStats[s.id]?.sizeAt || now - cardStats[s.id].sizeAt > CARD_SIZE_TTL);
    for (const srv of due) {
      const r = await window.mcpanel.getServerDirStats(srv.id);
      if (!config.servers.some(s => s.id === srv.id)) continue;   // deleted meanwhile
      cardStats[srv.id] = { ...cardStats[srv.id], size: r.size, sizeAt: Date.now(),
        maxPlayers: r.maxPlayers ?? cardStats[srv.id]?.maxPlayers };
      _paintCardStats(srv);
    }
  } finally {
    cardSizesRunning = false;
  }
}

async function startServerFlow(id) {
  // Log polling reads incrementally from consoleLogOffset, but that offset
  // sits at 0 while a server is stopped - so on start, the very next poll
  // tick would pull the *entire* on-disk log (previous run included) into
  // the console. Skip straight to the current end of the log before
  // starting so only output from this run appears.
  if (_appSettings.clearConsoleOnStart && currentServerId === id) {
    stopConsolePoll();
    try {
      const tail = await window.mcpanel.getLogSince(id, 0);
      consoleLogOffset = tail.offset || 0;
    } catch {}
    clearConsole();
    startConsolePoll(id);
  }
  const result = await window.mcpanel.startServer(id);
  if (result.needsEula) {
    pendingEulaServerId = id;
    document.getElementById('modal-eula').classList.remove('hidden');
    return;
  }
  if (result.error) { toast(result.error, 'error'); return; }
  startingServers.add(id);
  updateServerCardStatus(id, 'starting', 0);
  updateSidebarDot(id, true);
  if (currentServerId === id) { updateDetailControls(true); updateDetailStarting(); }
  toast('Server starting...', 'info');
  pollAllStatuses();
}

async function confirmEula() {
  if (!pendingEulaServerId) return;
  const id = pendingEulaServerId;
  closeEulaModal();
  const r = await window.mcpanel.acceptEula(id);
  if (r.error) { toast(r.error, 'error'); return; }
  await startServerFlow(id);
}

function closeEulaModal() {
  document.getElementById('modal-eula').classList.add('hidden');
  pendingEulaServerId = null;
}

async function checkPrivacyPolicy() {
  try {
    // MCPanel-Studios first, the old DippyCoder path as fallback.
    let res = null;
    for (const owner of ['MCPanel-Studios', 'DippyCoder']) {
      try {
        res = await fetch(`https://gist.githubusercontent.com/${owner}/559659736b49a56964dae2e5c0f5f5dc/raw`);
        if (res.ok) break;
      } catch (_) { res = null; }
    }
    if (!res || !res.ok) return;
    const text = await res.text();
    const match = text.match(/\*\*Document Last Updated:\*\*\s*(.+)/);
    if (!match) return;
    const remoteDate = match[1].trim();
    const localDate = localStorage.getItem('privacy_policy_date');
    if (localDate && localDate !== remoteDate) {
      document.getElementById('privacy-update-date').textContent = remoteDate;
      document.getElementById('modal-privacy-update').classList.remove('hidden');
    }
    localStorage.setItem('privacy_policy_date', remoteDate);
  } catch (_) {}
}

function closePrivacyUpdateModal() {
  document.getElementById('modal-privacy-update').classList.add('hidden');
}

function openPrivacyPolicy() {
  window.mcpanel.openExternal('https://get-mcpanel.vercel.app/privacy');
  closePrivacyUpdateModal();
}

function updateDetailStarting() {
  const bigStatus = document.getElementById('big-status-badge');
  if (bigStatus) { bigStatus.className = 'big-status starting'; bigStatus.textContent = 'STARTING'; }
  setPlayersBar(0, 0, false);
  const listEl = document.getElementById('detail-player-list');
  if (listEl) listEl.style.display = 'none';
}

function switchDetailTab(name) {
  // Built-in tabs plus any an addon registered (MCPanelAddons.registerServerTab).
  const addonTabs = window.MCPanelAddons ? window.MCPanelAddons._serverTabNames() : [];
  ['console', 'logs', 'files', 'plugins', 'settings', 'backups', 'schedule', 'players', ...addonTabs].forEach(t => {
    document.getElementById(`dtab-${t}`)?.classList.toggle('active', t === name);
    document.getElementById(`pane-${t}`)?.classList.toggle('hidden', t !== name);
  });
  window.MCPanelAddons?._serverTabShown(name);
  if (name === 'logs') openLogsTab();
  if (name === 'files') openFilesTab({ refresh: true });
  if (name === 'settings') openSettingsTab();
  if (name === 'plugins') openServerPluginsTab();
  if (name === 'backups') openBackupsTab();
  if (name === 'schedule') openScheduleTab();
  if (name === 'players') openPlayersTab();
}

function switchSettingsTab(name) {
  ['general', 'updates', 'appearance', 'about'].forEach(t => {
    document.getElementById(`stab-${t}`)?.classList.toggle('active', t === name);
    document.getElementById(`spane-${t}`)?.classList.toggle('hidden', t !== name);
  });
}

// ─── Logs Tab ─────────────────────────────────────────────────────────────────
// The server's own logs/ folder (latest.log + gzipped archives), read through
// the CLI. Unlike the console this is a static view: switching to the tab or
// pressing Refresh re-reads it.

let currentLogFile = 'latest.log';
let _logsLoadSeq = 0;

// "[12:34:56] [Server thread/INFO]: msg" (vanilla/Paper) and
// "[12:34:56 INFO]: msg" (Spigot/Velocity style).
const LOG_LINE_RE = /^\[(\d{2}:\d{2}:\d{2})(?:\.\d+)?\]\s*\[([^\]]*?)\/([A-Z]+)\]:?\s?(.*)$/;
const LOG_LINE_SHORT_RE = /^\[(\d{2}:\d{2}:\d{2})(?:\.\d+)?\s+([A-Z]+)\]:?\s?(.*)$/;

function _logLevelClass(level) {
  if (/^(ERROR|SEVERE|FATAL)$/.test(level)) return 'err';
  if (/^WARN(ING)?$/.test(level)) return 'warn';
  if (/^(DEBUG|TRACE)$/.test(level)) return 'debug';
  return 'info';
}

function _formatLogFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function openLogsTab() {
  if (!currentServerId) return;
  const id = currentServerId;
  const res = await window.mcpanel.listLogFiles(id);
  if (id !== currentServerId) return;
  const select = document.getElementById('logs-file-select');
  const files = (res && res.files) || [];
  if (res && res.error) {
    select.innerHTML = '';
    _renderLogMessage(res.error, true);
    return;
  }
  if (!files.length) {
    select.innerHTML = '';
    currentLogFile = null;
    document.getElementById('logs-meta').classList.add('hidden');
    _renderLogMessage('No log files yet. The server writes them to its logs/ folder once it has run.');
    _updateLogUploadBtn();
    return;
  }
  if (!files.some(f => f.name === currentLogFile)) currentLogFile = files[0].name;
  select.innerHTML = files.map(f =>
    `<option value="${escapeHtml(f.name)}">${escapeHtml(f.name)} (${_formatLogFileSize(f.size || 0)})</option>`
  ).join('');
  select.value = currentLogFile;
  await loadLogFile(currentLogFile);
}

async function loadLogFile(name) {
  if (!currentServerId || !name) return;
  currentLogFile = name;
  _updateLogUploadBtn();
  const seq = ++_logsLoadSeq;
  _renderLogMessage('Loading…');
  const res = await window.mcpanel.readLogFile(currentServerId, name);
  if (seq !== _logsLoadSeq) return;   // a newer selection won
  const meta = document.getElementById('logs-meta');
  if (!res || res.error) {
    meta.classList.add('hidden');
    _renderLogMessage(res?.error || 'Could not read the log file.', true);
    return;
  }
  if (res.truncated) {
    meta.textContent = `Showing the last ${res.lines.length.toLocaleString()} of ${res.totalLines.toLocaleString()} lines.`;
    meta.classList.remove('hidden');
  } else {
    meta.classList.add('hidden');
  }
  _renderLogLines(res.lines || []);
}

function _renderLogMessage(text, isError = false) {
  const el = document.getElementById('logs-output');
  el.innerHTML = `<div class="logs-empty${isError ? ' err' : ''}">${escapeHtml(text)}</div>`;
}

function _renderLogLines(lines) {
  const el = document.getElementById('logs-output');
  if (!lines.length) { _renderLogMessage('This log file is empty.'); return; }
  // Lines without their own header (stack traces, multi-line messages) take
  // the level of the entry they belong to.
  let level = 'info';
  const html = lines.map(raw => {
    let m = raw.match(LOG_LINE_RE), time, thread = '', lvl, msg;
    if (m) { [, time, thread, lvl, msg] = m; }
    else if ((m = raw.match(LOG_LINE_SHORT_RE))) { [, time, lvl, msg] = m; }
    if (!m) {
      return `<div class="log-line log-cont ${level}"><span class="log-text">${ansiToHtml(raw) || '&nbsp;'}</span></div>`;
    }
    level = _logLevelClass(lvl);
    return `<div class="log-line ${level}">`
      + `<span class="log-time">${time}</span>`
      + `<span class="log-level">${escapeHtml(lvl)}</span>`
      + (thread ? `<span class="log-thread">${escapeHtml(thread)}</span>` : '')
      + `<span class="log-text">${ansiToHtml(msg)}</span></div>`;
  }).join('');
  el.innerHTML = html;
  el.scrollTop = el.scrollHeight;
}

function _updateLogUploadBtn(uploading = false) {
  const btn = document.getElementById('logs-upload-btn');
  btn.disabled = uploading || !currentLogFile;
  btn.classList.toggle('loading', uploading);
}

// Shown before every upload until the viewer ticks "Don't show this again"
// (remembered per browser / app install).
const MCLOGS_SKIP_KEY = 'mcpanel-mclogs-skip-notice';
let _mclogsResolve = null;

function _mclogsNoticeSkipped() {
  try { return localStorage.getItem(MCLOGS_SKIP_KEY) === '1'; } catch { return false; }
}

function confirmMclogsUpload(name) {
  if (_mclogsNoticeSkipped()) return Promise.resolve(true);
  if (_mclogsResolve) resolveMclogsNotice(false);
  document.getElementById('mclogs-notice-text').textContent =
    `${name} will be uploaded to the servers of mclo.gs, where anyone with the link can read it.`;
  document.getElementById('mclogs-skip-notice').checked = false;
  openModal('modal-mclogs');
  return new Promise(resolve => { _mclogsResolve = resolve; });
}

function resolveMclogsNotice(ok) {
  closeModal('modal-mclogs');
  if (ok && document.getElementById('mclogs-skip-notice').checked) {
    try { localStorage.setItem(MCLOGS_SKIP_KEY, '1'); } catch {}
  }
  const resolve = _mclogsResolve;
  _mclogsResolve = null;
  if (resolve) resolve(ok);
}

document.addEventListener('keydown', e => {
  if (_mclogsResolve && e.key === 'Escape') resolveMclogsNotice(false);
});

async function uploadCurrentLog() {
  if (!currentServerId || !currentLogFile) return;
  const id = currentServerId, name = currentLogFile;
  if (!(await confirmMclogsUpload(name))) return;
  if (id !== currentServerId || name !== currentLogFile) return;
  _updateLogUploadBtn(true);
  const res = await window.mcpanel.uploadLog(id, name);
  _updateLogUploadBtn(false);
  if (id !== currentServerId || name !== currentLogFile) return;
  if (!res || res.error) { toast(res?.error || 'Upload failed', 'error'); return; }
  window.mcpanel.logEvent(`Uploaded ${name} to mclo.gs: ${res.url} -id ${id}`);
  const note = res.truncated
    ? ` (newest ${res.lines.toLocaleString()} of ${res.totalLines.toLocaleString()} lines)` : '';
  toast(`Uploaded ${name} to mclo.gs${note}`, 'success', {
    buttons: [
      { label: 'Copy link', onClick: async (btn) => {
          try { await navigator.clipboard.writeText(res.url); btn.label.textContent = 'Copied'; }
          catch { btn.label.textContent = 'Copy failed'; }
          return false;   // stay open so "Open in browser" is still reachable
      } },
      { label: 'Open in browser', onClick: () => _openExternalDirect(res.url),
        icon: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6"/><path d="M11 13l9 -9"/><path d="M15 4h5v5"/></svg>' },
    ],
  });
}

let fileNavStack = [];   // stack of children arrays
let fileNavPaths = [];   // stack of name strings for breadcrumb
let cachedFileTree = null;

// "New" toolbar button - a lightweight popover (not a real <select>/<dialog>)
// listing File/Folder. Click the button again, pick an option, or click
// anywhere else to close it.
let _openFileNewMenuId = null;

function toggleFileNewMenu(e, scope) {
  e.stopPropagation();
  const menuId = scope === 'profile' ? 'profile-file-new-menu' : 'file-new-menu';
  const wasOpen = menuId === _openFileNewMenuId;
  closeFileNewMenu();
  if (!wasOpen) {
    document.getElementById(menuId)?.classList.remove('hidden');
    _openFileNewMenuId = menuId;
  }
}

function closeFileNewMenu() {
  if (_openFileNewMenuId) {
    document.getElementById(_openFileNewMenuId)?.classList.add('hidden');
    _openFileNewMenuId = null;
  }
}

document.addEventListener('click', e => {
  if (_openFileNewMenuId && !e.target.closest('.file-new-wrap')) closeFileNewMenu();
});

function fileNewMenuPick(scope, kind) {
  closeFileNewMenu();
  if (scope === 'profile') {
    if (kind === 'file') createNewProfileFile(); else createNewProfileFolder();
  } else {
    if (kind === 'file') createNewFile(); else createNewFolder();
  }
}

// refresh: re-read the folder even when a tree is cached. The previous
// listing stays on screen meanwhile, so the tab doesn't flash "Loading…".
async function openFilesTab({ refresh = false } = {}) {
  if (!currentServerId) return;
  const listEl = document.getElementById('file-list');
  const savedPaths = [...fileNavPaths];
  if (refresh && cachedFileTree) {
    const id = currentServerId;
    const r = await window.mcpanel.getServerFileTree(id);
    if (id !== currentServerId) return;      // switched servers meanwhile
    if (!r.error) cachedFileTree = r.tree || [];
  }
  if (!cachedFileTree) {
    listEl.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:12px">Loading…</div>`;
    const r = await window.mcpanel.getServerFileTree(currentServerId);
    if (r.error) {
      listEl.innerHTML = `<div style="padding:24px;color:var(--red);font-size:12px">${escapeHtml(r.error)}</div>`;
      return;
    }
    cachedFileTree = r.tree || [];
  }
  fileNavStack = [cachedFileTree];
  fileNavPaths = [];
  for (const seg of savedPaths) {
    const dir = fileNavStack[fileNavStack.length - 1].find(n => n.type === 'dir' && n.name === seg);
    if (dir) { fileNavStack.push(dir.children || []); fileNavPaths.push(seg); }
    else break;
  }
  renderFileBrowser();
}

async function reloadFileTree() {
  cachedFileTree = null;
  await openFilesTab();
}

function renderFileBrowser() {
  const children = fileNavStack[fileNavStack.length - 1];
  const listEl = document.getElementById('file-list');
  const bcEl = document.getElementById('file-breadcrumb');

  // Breadcrumb - show server ID (folder name) not the display name
  const parts = [currentServerId, ...fileNavPaths];
  bcEl.innerHTML = parts.map((seg, i) => {
    const isCurrent = i === parts.length - 1;
    return (i > 0 ? `<span class="file-bc-sep">/</span>` : '') +
      `<span class="file-bc-seg${isCurrent ? ' current' : ''}" data-depth="${i}">${escapeHtml(seg)}</span>`;
  }).join('');
  bcEl.querySelectorAll('[data-depth]').forEach(el => {
    const depth = parseInt(el.dataset.depth);
    if (depth < parts.length - 1) {
      el.onclick = () => fileBrowserGoTo(depth);
    }
  });

  listEl.innerHTML = '';
  const sorted = [...children].sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'dir' ? -1 : 1;
  });

  if (!sorted.length) {
    // The inline + offers the toolbar menu's New File / New Folder, right under itself.
    listEl.innerHTML = `
      <div class="file-empty">
        <div class="file-empty-title">Feels empty in here...</div>
        <div class="file-empty-sub">Click on
          <button class="file-empty-plus" title="Create New" onclick="openEmptyFolderNewMenu(this)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          to create a file or a folder.</div>
      </div>`;
  }

  for (const node of sorted) {
    const nodePath = [...fileNavPaths, node.name].join('/');
    const row = document.createElement('div');
    row.className = `file-row${node.type === 'dir' ? ' is-dir' : ''}${selectedFilePaths.has(nodePath) ? ' selected' : ''}`;
    row.innerHTML = `
      <input type="checkbox" class="file-row-check" ${selectedFilePaths.has(nodePath) ? 'checked' : ''}>
      <div class="file-row-icon">${fileIcon(node.name, node.type)}</div>
      <span class="file-row-name">${escapeHtml(node.name)}</span>
      <span class="file-row-size">${node.type === 'dir' ? '' : formatBytes(node.size || 0)}</span>
      <div class="file-row-actions">
        <button class="file-action-btn rename-btn" title="Rename">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="file-action-btn delete-btn" title="Delete">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </div>`;

    row.querySelector('.file-row-check').addEventListener('change', e => {
      e.stopPropagation();
      if (e.target.checked) selectedFilePaths.add(nodePath);
      else selectedFilePaths.delete(nodePath);
      row.classList.toggle('selected', e.target.checked);
      _syncFileSelectAllCheckbox('file-select-all', children, fileNavPaths, selectedFilePaths);
      _syncFileSelActions('file-sel-actions', 'file-sel-count', selectedFilePaths);
    });
    row.querySelector('.file-row-check').addEventListener('click', e => e.stopPropagation());
    row.querySelector('.rename-btn').addEventListener('click', e => { e.stopPropagation(); renameFileEntry(nodePath, node.name); });
    row.querySelector('.delete-btn').addEventListener('click', e => {
      e.stopPropagation();
      deleteFileEntry(nodePath, node.name, node.type === 'dir');
    });
    row.addEventListener('contextmenu', e => openFileContextMenu(e, row, nodePath, node));

    if (node.type === 'dir') {
      row.ondblclick = () => {
        fileNavStack.push(node.children || []);
        fileNavPaths.push(node.name);
        renderFileBrowser();
      };
      row.dataset.dropDir = [...fileNavPaths, node.name].join('/');
      row.ondragover = e => { e.preventDefault(); e.stopPropagation(); row.classList.add('drop-target'); };
      row.ondragleave = () => row.classList.remove('drop-target');
      row.ondrop = e => {
        e.preventDefault(); e.stopPropagation();
        row.classList.remove('drop-target');
        _handleDrop(e, [...fileNavPaths, node.name].join('/'));
      };
    } else {
      row.ondblclick = () => openFileEditor(nodePath, node.name);
    }
    listEl.appendChild(row);
  }
  _syncFileSelectAllCheckbox('file-select-all', children, fileNavPaths, selectedFilePaths);
  _syncFileSelActions('file-sel-actions', 'file-sel-count', selectedFilePaths);
}

// Keeps a directory's "select all" checkbox in sync (checked/indeterminate/
// unchecked) with how many of its currently-listed children are selected.
function _syncFileSelectAllCheckbox(checkboxId, children, navPaths, selectedSet) {
  const el = document.getElementById(checkboxId);
  if (!el) return;
  const total = children.length;
  const selectedCount = children.filter(n => selectedSet.has([...navPaths, n.name].join('/'))).length;
  el.checked = total > 0 && selectedCount === total;
  el.indeterminate = selectedCount > 0 && selectedCount < total;
}

// Shows the toolbar's download / move / delete cluster only while something is
// checked. Selection spans directories, so the count is the whole set, not just
// what is visible in the current folder.
function _syncFileSelActions(wrapId, countId, selectedSet) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  const n = selectedSet.size;
  wrap.classList.toggle('hidden', n === 0);
  const countEl = document.getElementById(countId);
  if (countEl) countEl.textContent = `${n} selected`;
}

function toggleSelectAllFiles(checked) {
  const children = fileNavStack[fileNavStack.length - 1] || [];
  for (const node of children) {
    const nodePath = [...fileNavPaths, node.name].join('/');
    if (checked) selectedFilePaths.add(nodePath);
    else selectedFilePaths.delete(nodePath);
  }
  renderFileBrowser();
}

function fileBrowserGoTo(depth) {
  while (fileNavStack.length > depth + 1) { fileNavStack.pop(); fileNavPaths.pop(); }
  renderFileBrowser();
}

// On Linux/WebKit2GTK, dataTransfer.files is empty and getData may also be empty
// because Tauri intercepts the drop. Parse whatever we can get.
// The folder row (file browser or profile browser) at a drag/drop position.
// Tauri reports physical pixels; the WebUI bridge passes CSS pixels and sets
// `logical: true`.
function _folderRowAt(payload) {
  const pos = payload && payload.position;
  if (!pos) return null;
  const scale = payload.logical ? 1 : (window.devicePixelRatio || 1);
  const el = document.elementFromPoint(pos.x / scale, pos.y / scale);
  return el ? el.closest('.file-row[data-drop-dir]') : null;
}

function getDroppedPaths(e) {
  const uriList = e.dataTransfer.getData('text/uri-list');
  const text    = e.dataTransfer.getData('text/plain');
  console.log('[MCPanel] getDroppedPaths uri-list:', JSON.stringify(uriList), 'text:', JSON.stringify(text));
  const raw = uriList || text;
  if (!raw?.trim()) return [];
  return raw.split(/\r?\n/).map(u => u.trim()).filter(Boolean).map(u => {
    if (u.startsWith('file://')) { try { return decodeURIComponent(new URL(u).pathname); } catch { return null; } }
    if (u.startsWith('/')) return u;
    return null;
  }).filter(Boolean);
}

function _handleDrop(e, destDir) {
  const paths = getDroppedPaths(e);
  if (paths.length) uploadFilesFromPaths(paths, destDir);
  else uploadFiles(e.dataTransfer.files, destDir);
}

function filePanelDragOver(e) { e.preventDefault(); }
function filePanelDragLeave(e) { }
function filePanelDrop(e) {
  e.preventDefault();
  _handleDrop(e, fileNavPaths.join('/'));
}
function fileZoneDragOver(e) {
  e.preventDefault();
  document.getElementById('file-drop-zone').classList.add('drop-active');
}
function fileZoneDragLeave(e) {
  document.getElementById('file-drop-zone').classList.remove('drop-active');
}
function fileZoneDrop(e) {
  e.preventDefault();
  document.getElementById('file-drop-zone').classList.remove('drop-active');
  _handleDrop(e, fileNavPaths.join('/'));
}

function handleFileInputChange(e) {
  uploadFiles(e.target.files, fileNavPaths.join('/'));
  e.target.value = '';
}

async function uploadFiles(fileList, dirPath) {
  if (!fileList || fileList.length === 0) return;
  const files = Array.from(fileList);
  const total = files.length;
  const progressEl = document.getElementById('file-upload-progress');
  const fillEl = document.getElementById('file-upload-progress-fill');
  const textEl = document.getElementById('file-upload-progress-text');
  const dropZone = document.getElementById('file-drop-zone');

  progressEl.classList.remove('hidden');
  dropZone.style.pointerEvents = 'none';

  let done = 0, errors = 0;
  for (const file of files) {
    fillEl.style.width = `${Math.round((done / total) * 100)}%`;
    textEl.textContent = `Uploading ${file.name} (${done + 1}/${total})`;
    try {
      const buf = await file.arrayBuffer();
      const data = Array.from(new Uint8Array(buf));
      const rel = dirPath ? `${dirPath}/${file.name}` : file.name;
      await window.mcpanel.writeServerFile(currentServerId, rel, data);
      done++;
    } catch (e) {
      errors++;
      textEl.textContent = `Failed: ${file.name}`;
      toast(`Failed to upload ${file.name}: ${e}`, 'error');
    }
  }

  fillEl.style.width = '100%';
  if (errors === 0) {
    textEl.textContent = `Done - ${done} file${done > 1 ? 's' : ''} uploaded`;
    toast(`Uploaded ${done} file${done > 1 ? 's' : ''}`, 'success');
  } else {
    textEl.textContent = `${done} uploaded, ${errors} failed`;
  }
  if (done > 0) {
    window.mcpanel.logEvent(`Uploaded ${done} item(s) to server${dirPath ? ` (/${dirPath})` : ''} -id ${currentServerId}`);
  }

  dropZone.style.pointerEvents = '';
  setTimeout(() => {
    progressEl.classList.add('hidden');
    fillEl.style.width = '0%';
  }, 3000);

  if (done > 0) {
    cachedFileTree = null;
    await openFilesTab();
  }
}

async function uploadFilesFromPaths(paths, destDir) {
  if (!paths.length || !currentServerId) return;
  const progressEl = document.getElementById('file-upload-progress');
  const fillEl = document.getElementById('file-upload-progress-fill');
  const textEl = document.getElementById('file-upload-progress-text');
  progressEl.classList.remove('hidden');
  fillEl.style.width = '40%';
  textEl.textContent = `Copying ${paths.length} file${paths.length !== 1 ? 's' : ''}…`;
  try {
    await window.mcpanel.uploadFilesFromPaths(currentServerId, paths, destDir);
    fillEl.style.width = '100%';
    textEl.textContent = `Done - ${paths.length} file${paths.length !== 1 ? 's' : ''} uploaded`;
    toast(`Uploaded ${paths.length} file${paths.length !== 1 ? 's' : ''}`, 'success');
    cachedFileTree = null;
    await openFilesTab();
  } catch (e) {
    textEl.textContent = 'Upload failed';
    toast(`Upload failed: ${e}`, 'error');
  }
  setTimeout(() => { progressEl.classList.add('hidden'); fillEl.style.width = '0%'; }, 3000);
}

function fileIcon(name, type) {
  if (type === 'dir') {
    return `<svg class="file-icon-dir" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
  }
  return `<svg class="file-icon-file" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}

let _fileInputCallback = null;

function openFileInput(title, label, defaultVal, cb) {
  _fileInputCallback = cb;
  document.getElementById('file-input-title').textContent = title;
  document.getElementById('file-input-label').textContent = label;
  const inp = document.getElementById('file-input-value');
  inp.value = defaultVal || '';
  openModal('modal-file-input');
  setTimeout(() => { inp.select(); inp.focus(); }, 50);
}

function submitFileInput() {
  const val = document.getElementById('file-input-value').value.trim();
  if (!val) return;
  closeModal('modal-file-input');
  if (_fileInputCallback) { _fileInputCallback(val); _fileInputCallback = null; }
}

let _editorRelPath = null;
let _editorCtx = null; // { type: 'server'|'profile', id: string }

let _aceEditor = null;
let _fileEditorMaximized = false;
try { _fileEditorMaximized = localStorage.getItem('fileEditorMaximized') === '1'; } catch {}

function _applyFileEditorMaximize() {
  const modal = document.querySelector('#modal-file-editor .file-editor-modal');
  const btn = document.getElementById('file-editor-maximize');
  if (!modal) return;
  modal.classList.toggle('maximized', _fileEditorMaximized);
  if (btn) btn.title = _fileEditorMaximized ? 'Restore editor size' : 'Enlarge editor';
  if (_aceEditor) requestAnimationFrame(() => _aceEditor && _aceEditor.resize());
}

function toggleFileEditorMaximize() {
  _fileEditorMaximized = !_fileEditorMaximized;
  try { localStorage.setItem('fileEditorMaximized', _fileEditorMaximized ? '1' : '0'); } catch {}
  _applyFileEditorMaximize();
}

function _initAceEditor() {
  if (_aceEditor) return;
  _aceEditor = ace.edit('file-editor-content');
  _aceEditor.setOptions({
    showPrintMargin: false,
    tabSize: 2,
    useSoftTabs: true,
    useWorker: false,
    wrap: false,
    scrollPastEnd: 0.3,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace',
    fontSize: 12,
  });
  _aceEditor.renderer.setScrollMargin(4, 4, 0, 0);
  _aceEditor.on('change', _runEditorValidation);
  if (document.fonts) document.fonts.addEventListener('loadingdone', _aceRemeasure);
}

// Ace caches the char width; if it measured the fallback font before the webfont swapped in, cursor and selection drift.
function _aceRemeasure() {
  if (!_aceEditor) return;
  const apply = () => {
    if (!_aceEditor) return;
    _aceEditor.renderer.updateFontSize();
    _aceEditor.resize(true);
  };
  if (document.fonts && document.fonts.load) {
    document.fonts.load('12px "JetBrains Mono"').then(apply, apply);
  } else {
    apply();
  }
}

function _aceTheme() {
  return (config.activeTheme === 'bright-slate')
    ? 'ace/theme/github'
    : 'ace/theme/tomorrow_night';
}

function _aceMode(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const map = {
    yml: 'yaml', yaml: 'yaml',
    json: 'json',
    properties: 'properties',
    toml: 'toml',
    xml: 'xml', htm: 'xml', html: 'xml',
  };
  return `ace/mode/${map[ext] || 'text'}`;
}

function _runEditorValidation() {
  if (!_aceEditor) return;
  const modeId = _aceEditor.session.getMode().$id || '';
  const src = _aceEditor.getValue();
  const anns = [];

  if (modeId.endsWith('json') && src.trim()) {
    try { JSON.parse(src); }
    catch (e) {
      const m = e.message.match(/position (\d+)/i);
      if (m) {
        const pos = parseInt(m[1]);
        const before = src.slice(0, pos);
        const lines = before.split('\n');
        anns.push({ row: lines.length - 1, column: lines[lines.length - 1].length, text: e.message, type: 'error' });
      } else {
        anns.push({ row: 0, column: 0, text: e.message, type: 'error' });
      }
    }
  } else if (modeId.endsWith('yaml') && src.trim()) {
    try { jsyaml.load(src); }
    catch (e) {
      const row = (e.mark && e.mark.line != null) ? e.mark.line : 0;
      const col = (e.mark && e.mark.column != null) ? e.mark.column : 0;
      anns.push({ row, column: col, text: e.reason || e.message, type: 'error' });
    }
  }

  _aceEditor.session.setAnnotations(anns);
}

async function openFileEditor(relPath, name, ctx) {
  // Database files open in the built-in database editor; anything that turns
  // out not to be SQLite (e.g. an H2 trace .db) falls through to the text editor.
  if ((!ctx || ctx.type === 'server') && window.DatabasesUI?.isDbFile(name)) {
    if (await window.DatabasesUI.openSqlite(currentServerId, relPath, name)) return;
  }
  _editorRelPath = relPath;
  _editorCtx = ctx || { type: 'server', id: currentServerId };
  document.getElementById('file-editor-title').textContent = name;
  const saveBtn = document.getElementById('file-editor-save');
  saveBtn.disabled = true; saveBtn.textContent = 'Loading…';
  _applyFileEditorMaximize();
  openModal('modal-file-editor');
  _initAceEditor();
  _aceEditor.setTheme(_aceTheme());
  try {
    const content = _editorCtx.type === 'profile'
      ? await window.mcpanel.readProfileFile(_editorCtx.id, relPath)
      : await window.mcpanel.readServerFile(_editorCtx.id, relPath);
    _aceEditor.session.setMode(_aceMode(name));
    _aceEditor.setValue(content, -1);
    _runEditorValidation();
    saveBtn.disabled = false; saveBtn.textContent = 'Save';
    setTimeout(_aceRemeasure, 50);
  } catch (e) {
    closeModal('modal-file-editor');
    toast(String(e), 'error');
  }
}

async function saveFileEditor() {
  if (!_editorRelPath || !_editorCtx || !_aceEditor) return;
  const saveBtn = document.getElementById('file-editor-save');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
  try {
    const content = _aceEditor.getValue();
    const data = Array.from(new TextEncoder().encode(content));
    if (_editorCtx.type === 'profile') {
      await window.mcpanel.writeProfileFile(_editorCtx.id, _editorRelPath, data);
      closeModal('modal-file-editor');
      toast('File saved', 'success');
      profileCachedFileTree = null;
      renderProfileFileBrowser();
    } else {
      await window.mcpanel.writeServerFile(_editorCtx.id, _editorRelPath, data);
      closeModal('modal-file-editor');
      toast('File saved', 'success');
      cachedFileTree = null;
      await openFilesTab();
    }
  } catch (e) {
    toast('Save failed: ' + e, 'error');
    saveBtn.disabled = false; saveBtn.textContent = 'Save';
  }
}

async function deleteFileEntry(relPath, name, isDir) {
  const ok = await confirmDialog({
    title: isDir ? 'Delete Folder' : 'Delete File',
    message: isDir
      ? `Delete the folder "${name}" and all its contents?\n\nThis action cannot be undone.`
      : `Delete the file "${name}"?\n\nThis action cannot be undone.`,
  });
  if (!ok) return;
  try {
    await window.mcpanel.deleteServerFile(currentServerId, relPath);
    toast(`Deleted "${name}"`, 'info');
    cachedFileTree = null;
    await openFilesTab();
  } catch (e) {
    toast('Delete failed: ' + e, 'error');
  }
}

async function deleteSelectedFiles() {
  const count = selectedFilePaths.size;
  if (!count) return;
  const ok = await confirmDialog({
    title: 'Delete Items',
    message: `Delete ${count} selected item${count !== 1 ? 's' : ''}?\n\nFolders are deleted with all their contents. This action cannot be undone.`,
    confirmLabel: `Delete ${count} Item${count !== 1 ? 's' : ''}`,
  });
  if (!ok) return;
  const paths = [...selectedFilePaths];
  let failed = 0;
  for (const p of paths) {
    try { await window.mcpanel.deleteServerFile(currentServerId, p); }
    catch { failed++; }
  }
  selectedFilePaths.clear();
  if (failed === 0) toast(`Deleted ${paths.length} item${paths.length !== 1 ? 's' : ''}`, 'info');
  else toast(`Deleted ${paths.length - failed}, failed ${failed}`, 'error');
  cachedFileTree = null;
  await openFilesTab();
}

async function downloadSelectedFiles() {
  await _downloadSelection('server');
}

async function downloadSelectedProfileFiles() {
  await _downloadSelection('profile');
}

async function _downloadSelection(scope) {
  const isProfile = scope === 'profile';
  const paths = [...(isProfile ? selectedProfileFilePaths : selectedFilePaths)];
  if (!paths.length) return;
  const dest = await window.mcpanel.browseFolder();
  if (!dest) return;
  const id = isProfile ? currentProfileId : currentServerId;
  try {
    if (isProfile) await window.mcpanel.exportProfileFiles(id, paths, dest);
    else await window.mcpanel.exportServerFiles(id, paths, dest);
    toast(`Downloaded ${paths.length} item${paths.length !== 1 ? 's' : ''} to ${dest}`, 'success');
  } catch (e) {
    toast('Download failed: ' + e, 'error');
  }
}

let _fileMoveCtx = null;              // { scope, paths, dest }  - dest is a rel path, '' = root
let _fileMoveExpanded = new Set();    // rel paths of expanded folders in the picker

// `only`: move just these paths (the right-click menu on one unselected item)
// instead of the current selection, which is then left as it was.
function openFileMoveModal(scope, only = null) {
  const isProfile = scope === 'profile';
  const paths = only || [...(isProfile ? selectedProfileFilePaths : selectedFilePaths)];
  if (!paths.length) return;
  _fileMoveCtx = { scope, paths, dest: null, keepSelection: !!only };
  // Root is expanded, plus the chain down to where the items currently live so
  // the tree opens near them.
  _fileMoveExpanded = new Set(['', ..._ancestorPaths(paths[0])]);
  document.getElementById('file-move-title').textContent =
    `Move ${paths.length} Item${paths.length !== 1 ? 's' : ''}`;
  renderFileMoveTree();
  openModal('modal-file-move');
}

function _ancestorPaths(relPath) {
  const segs = relPath.split('/');
  segs.pop();
  return segs.map((_, i) => segs.slice(0, i + 1).join('/'));
}

function _fileMoveParentOf(relPath) {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? '' : relPath.slice(0, i);
}

// A destination is unusable if it is one of the moved folders or lives inside
// one (you cannot move a folder into itself), or if every selected item is
// already sitting in it.
function _fileMoveDestBlocked(dest) {
  const { paths } = _fileMoveCtx;
  if (paths.some(p => dest === p || dest.startsWith(p + '/'))) return true;
  return paths.every(p => _fileMoveParentOf(p) === dest);
}

function renderFileMoveTree() {
  const { scope, dest } = _fileMoveCtx;
  const tree = scope === 'profile' ? (profileCachedFileTree || []) : (cachedFileTree || []);
  const rootName = scope === 'profile' ? currentProfileId : currentServerId;
  const el = document.getElementById('file-move-tree');
  el.innerHTML = '';

  const chevron = open => `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transform:rotate(${open ? 90 : 0}deg);transition:transform .12s;color:var(--text-muted)"><polyline points="9 18 15 12 9 6"/></svg>`;
  const folderIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;

  const addRow = (label, path, depth, hasChildren) => {
    const blocked = path !== null && _fileMoveDestBlocked(path);
    const row = document.createElement('div');
    row.className = `file-move-row${dest === path ? ' selected' : ''}${blocked ? ' disabled' : ''}`;
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.innerHTML =
      `<span class="file-move-caret" style="width:12px;display:flex;justify-content:center">${hasChildren ? chevron(_fileMoveExpanded.has(path)) : ''}</span>` +
      folderIcon +
      `<span class="file-move-name">${escapeHtml(label)}</span>`;
    if (hasChildren) {
      row.querySelector('.file-move-caret').addEventListener('click', e => {
        e.stopPropagation();
        if (_fileMoveExpanded.has(path)) _fileMoveExpanded.delete(path);
        else _fileMoveExpanded.add(path);
        renderFileMoveTree();
      });
    }
    if (!blocked) {
      row.addEventListener('click', () => { _fileMoveCtx.dest = path; renderFileMoveTree(); });
    }
    el.appendChild(row);
  };

  const walk = (nodes, parentPath, depth) => {
    const dirs = nodes.filter(n => n.type === 'dir').sort((a, b) => a.name.localeCompare(b.name));
    for (const n of dirs) {
      const path = parentPath ? `${parentPath}/${n.name}` : n.name;
      const kids = (n.children || []).filter(c => c.type === 'dir');
      addRow(n.name, path, depth, kids.length > 0);
      if (_fileMoveExpanded.has(path)) walk(n.children || [], path, depth + 1);
    }
  };

  addRow(rootName, '', 0, tree.some(n => n.type === 'dir'));
  if (_fileMoveExpanded.has('')) walk(tree, '', 1);
}

async function submitFileMove() {
  if (!_fileMoveCtx) return;
  const { scope, paths, dest, keepSelection } = _fileMoveCtx;
  if (dest === null) { toast('Pick a destination folder', 'error'); return; }
  closeModal('modal-file-move');

  const isProfile = scope === 'profile';
  const id = isProfile ? currentProfileId : currentServerId;
  let moved = 0, skipped = 0, failed = 0, lastErr = '';
  for (const p of paths) {
    const name = p.split('/').pop();
    if (_fileMoveParentOf(p) === dest || dest === p || dest.startsWith(p + '/')) { skipped++; continue; }
    const newPath = dest ? `${dest}/${name}` : name;
    try {
      if (isProfile) await window.mcpanel.renameProfileFile(id, p, newPath);
      else await window.mcpanel.renameServerFile(id, p, newPath);
      moved++;
    } catch (e) { failed++; lastErr = String(e); }
  }

  const where = dest || (isProfile ? currentProfileId : currentServerId);
  if (failed) toast(`Moved ${moved}, failed ${failed}: ${lastErr}`, 'error');
  else if (moved) toast(`Moved ${moved} item${moved !== 1 ? 's' : ''} to ${where}`, 'success');
  else if (skipped) toast('Nothing to move - items are already there', 'info');

  _fileMoveCtx = null;
  const selection = isProfile ? selectedProfileFilePaths : selectedFilePaths;
  if (keepSelection) paths.forEach(p => selection.delete(p));
  else selection.clear();
  if (isProfile) {
    await reloadProfileFileTree();
  } else {
    cachedFileTree = null;
    await openFilesTab();
  }
}

function renameFileEntry(relPath, name) {
  openFileInput('Rename', 'New name', name, async (newName) => {
    if (newName === name) return;
    const parts = relPath.split('/');
    parts[parts.length - 1] = newName;
    const newPath = parts.join('/');
    try {
      await window.mcpanel.renameServerFile(currentServerId, relPath, newPath);
      toast(`Renamed to "${newName}"`, 'success');
      cachedFileTree = null;
      await openFilesTab();
    } catch (e) {
      toast('Rename failed: ' + e, 'error');
    }
  });
}

function createNewFolder() {
  if (!currentServerId) return;
  openFileInput('New Folder', 'Folder name', '', async (name) => {
    const relPath = fileNavPaths.length ? fileNavPaths.join('/') + '/' + name : name;
    try {
      await window.mcpanel.createServerDir(currentServerId, relPath);
      toast(`Folder "${name}" created`, 'success');
      cachedFileTree = null;
      await openFilesTab();
    } catch (e) {
      toast('Create failed: ' + e, 'error');
    }
  });
}

function createNewFile() {
  if (!currentServerId) return;
  openFileInput('New File', 'File name', '', async (name) => {
    const relPath = fileNavPaths.length ? fileNavPaths.join('/') + '/' + name : name;
    try {
      await window.mcpanel.createServerFile(currentServerId, relPath);
      toast(`File "${name}" created`, 'success');
      cachedFileTree = null;
      await openFilesTab();
    } catch (e) {
      toast('Create failed: ' + e, 'error');
    }
  });
}

const PAPER_SOFTWARES = new Set(['paper', 'purpur', 'folia', 'leaf']);

function openSettingsTab() {
  if (!currentServerId) return;
  const srv = config.servers.find(s => s.id === currentServerId);
  if (!srv) return;
  document.getElementById('tsett-name').value = srv.name || '';
  setRamDropdown('tsett', srv.ram || '2G');
  document.getElementById('tsett-heap').value = srv.heap || '';
  updateHeapPlaceholder('tsett');
  document.getElementById('tsett-storage').value = srv.storageLimit || '';
  document.getElementById('tsett-port').value = srv.port || '';
  document.getElementById('tsett-group').value = srv.group || '';
  document.getElementById('tsett-java-args').value = srv.javaArgs || '';
  populateJdkSelect('tsett', 'tsett-java-path', srv.javaPath || 'java');
  _showRunFileGroup('tsett', srv.software);
  document.getElementById('tsett-run').value = srv.runFile || '';
  const proxyBtnRow = document.getElementById('tsett-proxy-btn-row');
  if (proxyBtnRow) proxyBtnRow.classList.toggle('hidden', !PAPER_SOFTWARES.has(srv.software));
  renderProxyLink(srv);
}

async function saveTabSettings() {
  const name = document.getElementById('tsett-name').value.trim();
  if (!name) { toast('Server name is required', 'error'); return; }
  const ram = getRamValue('tsett');
  if (!ram) { toast('Please enter a custom RAM value', 'error'); return; }
  const heapRaw = document.getElementById('tsett-heap').value.trim();
  const heapErr = heapError(heapRaw, ram);
  if (heapErr) { toast(heapErr, 'error'); return; }
  // Saved straight into the config (not via the CLI), and it becomes -Xmx
  // as-is - so store the "4G" / "2048M" form Java accepts, never "4GB".
  const heapMb = ramToMb(heapRaw);
  const heap = heapMb ? (heapMb % 1024 === 0 ? `${heapMb / 1024}G` : `${heapMb}M`) : null;
  const storageLimit = document.getElementById('tsett-storage').value.trim() || null;
  const port = parseInt(document.getElementById('tsett-port').value) || null;
  const group = document.getElementById('tsett-group').value.trim() || null;
  const javaArgs = document.getElementById('tsett-java-args').value.trim();
  const javaPath = document.getElementById('tsett-java-path').value.trim() || 'java';

  if (storageLimit) {
    const bytes = parseStorageLimit(storageLimit);
    if (bytes === null) { toast('Invalid storage limit format', 'error'); return; }
  }
  const deviceErr = validateRamAndStorage(ram, storageLimit);
  if (deviceErr) { toast(deviceErr, 'error'); return; }

  const updates = { name, ram, heap, storageLimit, port, group, javaArgs, javaPath };
  if (!(await _saveRunFile('tsett'))) return;
  const oldPort = config.servers.find(s => s.id === currentServerId)?.port;
  const newVersion = await _refreshJavaVersion(currentServerId, javaPath);
  if (newVersion) updates.version = newVersion;
  const r = await window.mcpanel.updateServer(currentServerId, updates);
  if (r && r.error) { toast(r.error, 'error'); return; }

  const idx = config.servers.findIndex(s => s.id === currentServerId);
  if (idx !== -1) config.servers[idx] = { ...config.servers[idx], ...updates };
  const srv = config.servers[idx];

  document.getElementById('detail-server-name').textContent = name;
  document.getElementById('detail-server-subtitle').textContent = `${serverTypeLabel(srv)} · Port ${srv.port}`;
  if (port) document.getElementById('detail-port').textContent = port;
  const nameEl = document.querySelector(`#card-${currentServerId} .server-card-name`);
  if (nameEl) nameEl.textContent = name;
  const sidebarName = document.querySelector(`[data-server-id="${currentServerId}"] .srv-name`);
  if (sidebarName) sidebarName.textContent = name;
  renderSidebarServers();
  refreshDetailStats(currentServerId);

  toast('Settings saved', 'success');
  switchDetailTab('console');
  offerProxyPortSync(currentServerId, oldPort);
}

async function browseJavaTabSettings() {
  const path = await window.mcpanel.browseJava();
  if (path) setJdkDropdown('tsett', 'tsett-java-path', path);
}

const MODDED_SOFTWARES = new Set(['fabric']);
const PLUGIN_SOFTWARES = new Set(['paper', 'purpur', 'folia', 'leaf', 'spigot', 'velocity']);
const PLUGIN_PLATFORM_NAMES = { modrinth: 'Modrinth', hangar: 'Hangar', spigotmc: 'SpigotMC' };

let _serverPluginProvider = 'hangar';
let _profilePluginProvider = 'hangar';
let _pluginSearchTimer = null;
// key: `server_${id}` or `profile_${id}` → { 'platform:id': record }. The
// records come from mcpanel-cli's `plugins list`, i.e. the .list/*.toml files
// it keeps next to the jars, so the installed state survives restarts.
let _pluginInstalledMap = {};
let _pluginBusy = {};        // key: `${ctx}|${pkey}` → button label while an install/update/uninstall runs
let _pluginPageState = {};   // key: ctx → { provider, query, offset, software, mcVersion }
let _pluginDetailCache = {}; // key: ctx → { pkey: <raw search result row> }
let _pluginDetailState = null; // { ctx, pkey, row, offset } for the currently-open details modal

function _pluginCtxKey(ctx) {
  return ctx === 'server' ? `server_${currentServerId}` : `profile_${currentProfileId}`;
}
function _pluginKey(platform, slug) {
  return `${platform}:${String(slug).toLowerCase()}`;
}
function _pluginTarget(ctx) {
  return ctx === 'server' ? { serverId: currentServerId } : { profileId: currentProfileId };
}
function _installedPlugin(ctx, pkey) {
  return _pluginInstalledMap[_pluginCtxKey(ctx)]?.[pkey] || null;
}

// "1.21.4 · Paper", "Java 25 · Custom" (custom-java: the version is the Java
// it runs on), or just "Custom" for a start-script server.
function serverTypeLabel(srv) {
  // custom-java whose Java couldn't be read has the version "Custom" itself.
  if (srv.software === 'custom' || (srv.software === 'custom-java' && !/^Java /.test(srv.version || ''))) return 'Custom';
  if (srv.software === 'pumpkin') return `${String(srv.version || 'Unknown').split('+')[0]} · Pumpkin`;
  return `${srv.version} · ${capitalise(srv.software)}`;
}

function _pluginsSupported(software) {
  return !['custom', 'custom-java', 'pumpkin'].includes(software);
}

function _pluginTabLabel(software) {
  return MODDED_SOFTWARES.has(software) ? 'Mods' : 'Plugins';
}

function _pluginKind(ctx) {
  return MODDED_SOFTWARES.has(_pluginCtxSoftware(ctx).software) ? 'mod' : 'plugin';
}

async function _loadInstalledPlugins(ctx) {
  const k = _pluginCtxKey(ctx);
  try {
    const r = await window.mcpanel.listPlugins(_pluginTarget(ctx));
    if (r && !r.error) {
      const map = {};
      (r.plugins || []).forEach(p => { map[_pluginKey(p.platform, p.id)] = p; });
      _pluginInstalledMap[k] = map;
    }
  } catch { /* keep whatever was known - the buttons just fall back to Install */ }
  // Never leave the Installed tab on "Loading…" when the list couldn't be read.
  if (!_pluginInstalledMap[k]) _pluginInstalledMap[k] = {};
  if (k === _pluginCtxKey(ctx)) _refreshPluginRows(ctx);
}

function openServerPluginsTab() {
  const srv = config.servers.find(s => s.id === currentServerId);
  if (!srv) return;
  if (!_pluginsSupported(srv.software)) { switchDetailTab('console'); return; }
  const label = _pluginTabLabel(srv.software);
  document.getElementById('dtab-plugins-label').textContent = label;
  _setupPluginProviders(srv.software, 'server');
  searchPlugins('server');
  _loadInstalledPlugins('server');
}

function openProfilePluginsTab() {
  const profile = profiles.find(p => p.id === currentProfileId);
  const software = (profile && profile.software && profile.software.length === 1)
    ? profile.software[0] : 'paper';
  const label = _pluginTabLabel(software);
  document.getElementById('ptab-plugins-label').textContent = label;
  _setupPluginProviders(software, 'profile');
  searchPlugins('profile');
  _loadInstalledPlugins('profile');
}

function _setupPluginProviders(software, ctx) {
  const isMod = MODDED_SOFTWARES.has(software);
  const hangarBtn = document.getElementById(`${ctx === 'server' ? 's' : 'p'}provider-hangar`);
  const spigotBtn = document.getElementById(`${ctx === 'server' ? 's' : 'p'}provider-spigotmc`);
  if (hangarBtn) hangarBtn.classList.toggle('hidden', isMod);
  // SpigotMC only hosts Bukkit/Spigot plugins - nothing for mods or Velocity.
  if (spigotBtn) spigotBtn.classList.toggle('hidden', isMod || software === 'velocity');
  const defaultProvider = 'installed';
  delete _pluginPageState[ctx]; // a stale "installed" view must not re-render into a new server's tab
  if (ctx === 'server') _serverPluginProvider = defaultProvider;
  else _profilePluginProvider = defaultProvider;
  document.querySelectorAll(`#${ctx === 'server' ? 'server' : 'profile'}-plugin-providers .plugin-provider-tab`)
    .forEach(btn => btn.classList.toggle('active', btn.id.endsWith(defaultProvider)));
}

function switchPluginProvider(provider, ctx) {
  if (ctx === 'server') _serverPluginProvider = provider;
  else _profilePluginProvider = provider;
  document.querySelectorAll(`#${ctx === 'server' ? 'server' : 'profile'}-plugin-providers .plugin-provider-tab`)
    .forEach(btn => btn.classList.toggle('active', btn.id.endsWith(provider)));
  searchPlugins(ctx);
}

function pluginSearchDebounce(ctx) {
  clearTimeout(_pluginSearchTimer);
  _pluginSearchTimer = setTimeout(() => searchPlugins(ctx), 400);
}

function _pluginCtxSoftware(ctx) {
  const srv = ctx === 'server' ? config.servers.find(s => s.id === currentServerId) : null;
  const profile = ctx === 'profile' ? profiles.find(p => p.id === currentProfileId) : null;
  return {
    software: srv?.software || (profile?.software?.[0]) || 'paper',
    mcVersion: srv?.version || (profile?.versions?.[0]) || '',
  };
}

async function searchPlugins(ctx, append = false) {
  const query = (document.getElementById(`${ctx}-plugin-search`)?.value || '').trim();
  const provider = ctx === 'server' ? _serverPluginProvider : _profilePluginProvider;
  const listEl = document.getElementById(`${ctx}-plugin-list`);
  if (!listEl) return;

  const { software, mcVersion } = _pluginCtxSoftware(ctx);

  if (provider === 'installed') {
    _pluginPageState[ctx] = { provider, query, software, mcVersion, offset: 0 };
    _renderInstalledPlugins(ctx);
    return;
  }

  const PAGE_SIZE = 100;

  if (!append) {
    listEl.innerHTML = `<div class="plugin-state-msg">Searching…</div>`;
    _pluginPageState[ctx] = { provider, query, software, mcVersion, offset: 0 };
    _pluginDetailCache[ctx] = {};
  } else {
    listEl.querySelector('.plugin-load-more')?.remove();
    const loadingEl = document.createElement('div');
    loadingEl.className = 'plugin-state-msg plugin-loading-more';
    loadingEl.textContent = 'Loading…';
    listEl.appendChild(loadingEl);
  }

  const state = _pluginPageState[ctx];
  const requestOffset = append ? state.offset : 0;

  try {
    const { results, hasMore } = await _searchViaCli(state.provider, state.query,
      { software: state.software, mcVersion: state.mcVersion }, PAGE_SIZE, requestOffset);
    if (_pluginPageState[ctx] !== state) return; // provider switched while awaiting
    state.offset = requestOffset + results.length;
    results.forEach(r => { _pluginDetailCache[ctx][_pluginKey(r.platform, r.slug)] = r; });

    if (!append) {
      if (!results.length) {
        listEl.innerHTML = `<div class="plugin-state-msg">No results for "${escapeHtml(state.query || 'featured')}".</div>`;
        return;
      }
      listEl.innerHTML = results.map(r => _renderPluginRow(r, ctx)).join('');
    } else {
      listEl.querySelector('.plugin-loading-more')?.remove();
      results.forEach(r => listEl.insertAdjacentHTML('beforeend', _renderPluginRow(r, ctx)));
    }

    if (hasMore) {
      const loadMoreDiv = document.createElement('div');
      loadMoreDiv.className = 'plugin-load-more';
      loadMoreDiv.innerHTML = `<button class="btn-ghost-sm" onclick="_loadMorePlugins('${ctx}')">Load 100 more…</button>`;
      listEl.appendChild(loadMoreDiv);
    }
  } catch (e) {
    if (!append) {
      listEl.innerHTML = `<div class="plugin-state-msg" style="color:var(--red)">Error: ${escapeHtml(e.message)}</div>`;
    } else {
      listEl.querySelector('.plugin-loading-more')?.remove();
      toast('Failed to load more: ' + e.message, 'error');
    }
  }
}

function _loadMorePlugins(ctx) { searchPlugins(ctx, true); }

// The "Installed" tab lists every jar in plugins/ (or mods/) instead of
// searching a platform: MCPanel's .list records, plus jars added some other
// way (platform "local" - those can only be uninstalled).
function _renderInstalledPlugins(ctx) {
  const listEl = document.getElementById(`${ctx}-plugin-list`);
  const state = _pluginPageState[ctx];
  if (!listEl || !state) return;
  if (!_pluginInstalledMap[_pluginCtxKey(ctx)]) {
    listEl.innerHTML = '<div class="plugin-state-msg">Loading…</div>';
    return;
  }
  const q = (state.query || '').toLowerCase();
  const recs = Object.values(_pluginInstalledMap[_pluginCtxKey(ctx)] || {})
    .filter(p => !q || String(p.name).toLowerCase().includes(q) || String(p.id).toLowerCase().includes(q))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  _pluginDetailCache[ctx] = {};
  if (!recs.length) {
    const kind = MODDED_SOFTWARES.has(state.software) ? 'mods' : 'plugins';
    listEl.innerHTML = `<div class="plugin-state-msg">${q
      ? `No installed ${kind} match "${escapeHtml(state.query)}".`
      : `No ${kind} installed yet.`}</div>`;
    return;
  }
  const rows = recs.map(p => ({
    slug: p.id, platform: p.platform, name: p.name || p.id,
    author: PLUGIN_PLATFORM_NAMES[p.platform] || p.platform,
    ownerName: p.owner || '', description: p.filename,
    latestVersion: p.version, dependencies: p.dependencies || [],
  }));
  rows.forEach(r => { _pluginDetailCache[ctx][_pluginKey(r.platform, r.slug)] = r; });
  listEl.innerHTML = rows.map(r => _renderPluginRow(r, ctx, true)).join('');
}

// Re-draw the action buttons after the installed state changed (or the whole
// list, on the Installed tab, where rows come and go).
function _refreshPluginRows(ctx) {
  if (_pluginPageState[ctx]?.provider === 'installed') { _renderInstalledPlugins(ctx); }
  else {
    document.querySelectorAll(`#${ctx}-plugin-list [data-pacts]`).forEach(el => {
      const pkey = el.dataset.pacts.slice(ctx.length + 1);
      const row = _pluginDetailCache[ctx]?.[pkey];
      if (row) el.outerHTML = _renderPluginActions(row, ctx);
    });
  }
  const detail = document.getElementById('pdetail-plugin-actions');
  if (detail && _pluginDetailState?.ctx === ctx) {
    detail.innerHTML = _renderPluginActions(_pluginDetailState.row, ctx, true);
  }
}

function _fmtDownloads(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function _fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(); } catch { return ''; }
}

// Spiget resources hosted externally usually redirect to a human-facing
// release page rather than a jar - those can't be auto-installed. A few
// do link straight to a .jar file (e.g. a GitHub release asset) and are
// still safe to install directly, matching the same check the CLI backend
// makes in plugins.get_spiget_download. Purchase-required (premium) Spiget
// resources never reach here at all - the CLI filters them out of results.
function _isBlockedExternal(r) {
  return !!r.external && !(r.externalUrl && r.externalUrl.toLowerCase().split('?')[0].endsWith('.jar'));
}

// Install, or Update + Uninstall once installed. `inModal` stacks them for the
// details modal. The wrapper's data-pacts ("ctx|platform:id") is how
// _pluginAction and _refreshPluginRows find the row again.
function _renderPluginActions(r, ctx, inModal = false) {
  const pkey = _pluginKey(r.platform, r.slug);
  const busy = _pluginBusy[`${ctx}|${pkey}`];
  let inner;
  if (busy) {
    inner = `<button class="plugin-install-btn installing" disabled>${escapeHtml(busy)}</button>`;
  } else if (_isBlockedExternal(r)) {
    inner = r.externalUrl
      ? `<button class="plugin-install-btn" onclick="window.mcpanel.openExternal('${escapeHtml(r.externalUrl)}')">View Page</button>`
      : `<button class="plugin-install-btn" onclick="toast('This plugin is hosted externally - check its SpigotMC resource page','info')">View Page</button>`;
  } else if (_installedPlugin(ctx, pkey)) {
    const rec = _installedPlugin(ctx, pkey);
    inner = rec.platform === 'local' ? '' : `<button class="plugin-install-btn" onclick="_pluginAction('update','${ctx}',this)" title="Installed: ${escapeHtml(rec.version || '?')} - update to the newest compatible version">Update</button>`
      + `<button class="plugin-install-btn uninstall" onclick="_pluginAction('uninstall','${ctx}',this)" title="Delete ${escapeHtml(rec.path || rec.filename)}">Uninstall</button>`;
  } else {
    inner = `<button class="plugin-install-btn" onclick="_pluginAction('install','${ctx}',this)">Install</button>`;
  }
  return inModal ? `<div class="plugin-actions stacked" data-pacts="${escapeHtml(`${ctx}|${pkey}`)}">${inner}</div>`
    : `<div class="plugin-actions" data-pacts="${escapeHtml(`${ctx}|${pkey}`)}" onclick="event.stopPropagation()">${inner}</div>`;
}

function _renderPluginRow(r, ctx, installedView = false) {
  const pkey = _pluginKey(r.platform, r.slug);
  const icon = r.iconUrl
    ? `<img class="plugin-icon" src="${escapeHtml(r.iconUrl)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        + `<div class="plugin-icon-placeholder" style="display:none"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/></svg></div>`
    : `<div class="plugin-icon-placeholder"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/></svg></div>`;
  const externalBadge = _isBlockedExternal(r) ? `<span class="plugin-external-badge">EXTERNAL</span>` : '';
  const meta = installedView
    ? `${r.latestVersion ? `<span class="plugin-meta-version">${escapeHtml(r.latestVersion)}</span>` : ''}
      ${r.dependencies?.length ? `<span class="plugin-meta-updated" title="Required dependencies">needs ${escapeHtml(r.dependencies.join(', '))}</span>` : ''}`
    : `<span class="plugin-meta-downloads">⬇ ${_fmtDownloads(r.downloads)}</span>
      ${r.latestVersion ? `<span class="plugin-meta-version">${escapeHtml(r.latestVersion)}</span>` : ''}
      ${r.updatedAt ? `<span class="plugin-meta-updated">${_fmtDate(r.updatedAt)}</span>` : ''}`;
  const local = r.platform === 'local';
  const rowAttrs = local ? 'class="plugin-row"'
    : `class="plugin-row clickable" onclick="_openPluginDetails('${ctx}',this.dataset.pkey)"`;
  return `<div ${rowAttrs} data-pkey="${escapeHtml(pkey)}">
    ${icon}
    <div class="plugin-info">
      <div class="plugin-name">${escapeHtml(r.name)}${externalBadge}</div>
      <div class="plugin-author">${local ? 'Added manually' : `${installedView ? 'from' : 'by'} ${escapeHtml(r.author)}`}</div>
      ${r.description ? `<div class="plugin-desc">${escapeHtml(r.description)}</div>` : ''}
    </div>
    <div class="plugin-meta">
      ${meta}
    </div>
    ${_renderPluginActions(r, ctx)}
  </div>`;
}

function _pluginAction(op, ctx, btn) {
  const pkey = btn.closest('[data-pacts]').dataset.pacts.slice(ctx.length + 1);
  const row = _pluginDetailCache[ctx]?.[pkey]
    || (_pluginDetailState?.pkey === pkey ? _pluginDetailState.row : null);
  if (!row) return;
  if (op === 'install') installPlugin(row, ctx);
  else if (op === 'update') updatePlugin(row, ctx);
  else if (op === 'uninstall') uninstallPlugin(row, ctx);
}

function _openPluginDetails(ctx, pkey) {
  const row = _pluginDetailCache[ctx]?.[pkey];
  if (!row) return;

  document.getElementById('pdetail-name').textContent = row.name;
  document.getElementById('pdetail-author').textContent = row.author;
  document.getElementById('pdetail-desc').textContent = row.description || '';
  document.getElementById('pdetail-longdesc').textContent = 'Loading…';
  document.getElementById('pdetail-icon-wrap').innerHTML = row.iconUrl
    ? `<img class="plugin-detail-icon" src="${escapeHtml(row.iconUrl)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        + `<div class="plugin-detail-icon-placeholder" style="display:none"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/></svg></div>`
    : `<div class="plugin-detail-icon-placeholder"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/></svg></div>`;
  document.getElementById('pdetail-versions').innerHTML = `<div class="plugin-state-msg">Loading…</div>`;

  const websiteBtn = document.getElementById('pdetail-website-btn');
  websiteBtn.onclick = null;
  websiteBtn.disabled = true;

  _pluginDetailState = { ctx, pkey, slug: row.slug, row, offset: 0 };
  document.getElementById('pdetail-plugin-actions').innerHTML = _renderPluginActions(row, ctx, true);
  openModal('modal-plugin-details');
  _loadPluginInfo(false);
}

async function _loadPluginInfo(append = false) {
  const state = _pluginDetailState;
  if (!state) return;
  const versionsEl = document.getElementById('pdetail-versions');
  const LIMIT = 25;

  if (append) {
    versionsEl.querySelector('.plugin-detail-loadmore')?.remove();
    const loadingEl = document.createElement('div');
    loadingEl.className = 'plugin-state-msg plugin-loading-more';
    loadingEl.textContent = 'Loading…';
    versionsEl.appendChild(loadingEl);
  }

  try {
    const data = await window.mcpanel.pluginInfo(state.row.platform, state.slug, {
      owner: state.row.ownerName, limit: LIMIT, offset: state.offset,
    });
    if (data.error) throw new Error(data.error);
    if (_pluginDetailState !== state) return; // modal closed/switched while awaiting

    const websiteBtn = document.getElementById('pdetail-website-btn');
    if (data.websiteUrl) {
      websiteBtn.disabled = false;
      websiteBtn.onclick = () => window.mcpanel.openExternal(data.websiteUrl);
    }

    if (!append) {
      document.getElementById('pdetail-longdesc').textContent =
        data.longDescription || state.row.description || 'No description available.';
    }

    const versions = data.versions || [];
    if (!append) {
      if (!versions.length) {
        versionsEl.innerHTML = `<div class="plugin-state-msg">No version history available.</div>`;
        return;
      }
      versionsEl.innerHTML = versions.map(v => _renderVersionRow(v, state)).join('');
    } else {
      versionsEl.querySelector('.plugin-loading-more')?.remove();
      versions.forEach(v => versionsEl.insertAdjacentHTML('beforeend', _renderVersionRow(v, state)));
    }
    state.offset += versions.length;

    if (data.hasMoreVersions) {
      const loadMoreDiv = document.createElement('div');
      loadMoreDiv.className = 'plugin-detail-loadmore';
      loadMoreDiv.innerHTML = `<button class="btn-ghost-sm" onclick="_loadPluginInfo(true)">Load more…</button>`;
      versionsEl.appendChild(loadMoreDiv);
    }
  } catch (e) {
    if (_pluginDetailState !== state) return;
    if (!append) {
      document.getElementById('pdetail-longdesc').textContent = state.row.description || '';
      versionsEl.innerHTML = `<div class="plugin-state-msg" style="color:var(--red)">Error: ${escapeHtml(e.message)}</div>`;
    } else {
      versionsEl.querySelector('.plugin-loading-more')?.remove();
      toast('Failed to load more versions: ' + e.message, 'error');
    }
  }
}

function _renderVersionRow(v, state) {
  const rowId = `pvrow-${state.ctx}-${String(v.id).replace(/[^a-zA-Z0-9]/g, '_')}`;
  const title = v.changelog ? ` title="${escapeHtml(v.changelog)}"` : '';
  return `<div class="plugin-version-row" id="${rowId}"${title} onclick="_installPluginVersion(this, '${escapeHtml(String(v.id))}')">
    <div class="plugin-version-name">${escapeHtml(v.name || '?')}</div>
    ${v.date ? `<div class="plugin-version-date">${_fmtDate(v.date)}</div>` : ''}
  </div>`;
}

function _installPluginVersion(row, versionId) {
  const state = _pluginDetailState;
  if (!state || row.classList.contains('installing')) return;
  const originalName = row.querySelector('.plugin-version-name').textContent;
  row.classList.add('installing');
  row.querySelector('.plugin-version-name').textContent = 'Installing…';
  installPlugin(state.row, state.ctx, versionId).finally(() => {
    if (row.isConnected) {
      row.classList.remove('installing');
      row.querySelector('.plugin-version-name').textContent = originalName;
    }
  });
}

// Search is routed through mcpanel-cli's own `search plugins` API instead of
// fetch()ing each platform directly - that avoids browser CORS entirely.
async function _searchViaCli(platform, query, { software, mcVersion } = {}, limit = 100, offset = 0) {
  const data = await window.mcpanel.searchPlugins(platform, query, { software, mcVersion, limit, offset });
  if (data.error) throw new Error(data.error);
  return { results: data.results || [], hasMore: !!data.hasMore };
}

// ─── Third-party disclaimer (plugins/mods + addons) ──────────────────────────
// Accepting hides the disclaimer for 15 minutes; ticking "Don't show this
// again" hides it for good. Remembered per browser / app install, per topic
// ('plugins', 'addons'). The wording itself comes from the CLI's
// `disclaimer_required` reply.
const DISCLAIMER_SNOOZE_MS = 15 * 60 * 1000;
let _pluginDisclaimerResolve = null;

function disclaimerSuppressed(topic) {
  try {
    const rec = JSON.parse(localStorage.getItem(`mcpanel-disclaimer-${topic}`) || 'null');
    return !!rec && (rec.hidden === true || Number(rec.until) > Date.now());
  } catch { return false; }
}

function rememberDisclaimer(topic, forever) {
  try {
    localStorage.setItem(`mcpanel-disclaimer-${topic}`,
      JSON.stringify(forever ? { hidden: true } : { until: Date.now() + DISCLAIMER_SNOOZE_MS }));
  } catch {}
}

function askPluginDisclaimer(doc) {
  if (_pluginDisclaimerResolve) resolvePluginDisclaimer(false);
  const kind = doc.kind === 'mod' ? 'Mod' : 'Plugin';
  document.getElementById('plugin-disclaimer-title').textContent = `Third-party ${kind.toLowerCase()}`;
  document.getElementById('plugin-disclaimer-text').textContent = doc.disclaimer || doc.error;

  const deps = doc.dependencies || [];
  document.getElementById('plugin-disclaimer-deps').classList.toggle('hidden', !deps.length);
  document.getElementById('plugin-disclaimer-deps-list').innerHTML = deps.map(d =>
    `<li><span>${escapeHtml(d.name)}</span><span class="plugin-dep-version">${escapeHtml(d.version || '')}</span></li>`).join('');

  const missing = doc.missingDependencies || [];
  document.getElementById('plugin-disclaimer-missing').classList.toggle('hidden', !missing.length);
  document.getElementById('plugin-disclaimer-missing-list').innerHTML = missing.map(d =>
    `<li>${escapeHtml(d.name)} <span class="plugin-dep-version">(${escapeHtml(d.reason || 'manual install')})</span></li>`).join('');

  const tos = document.getElementById('plugin-disclaimer-tos');
  tos.classList.toggle('hidden', !doc.tos);
  tos.textContent = `Read ${doc.platformName || 'the platform'}'s terms`;
  tos.onclick = () => doc.tos && window.mcpanel.openExternal(doc.tos);
  document.getElementById('plugin-disclaimer-skip').checked = false;
  openModal('modal-plugin-disclaimer');
  return new Promise(resolve => { _pluginDisclaimerResolve = resolve; });
}

function resolvePluginDisclaimer(ok) {
  closeModal('modal-plugin-disclaimer');
  if (ok) rememberDisclaimer('plugins', document.getElementById('plugin-disclaimer-skip').checked);
  const resolve = _pluginDisclaimerResolve;
  _pluginDisclaimerResolve = null;
  if (resolve) resolve(ok);
}

document.addEventListener('keydown', e => {
  if (_pluginDisclaimerResolve && e.key === 'Escape') resolvePluginDisclaimer(false);
});

// ─── Install / update / uninstall ─────────────────────────────────────────────
// mcpanel-cli does the real work: it resolves the download (including
// Hangar's owner lookup and Spiget's external/non-jar checks), installs
// missing required dependencies, swaps out the jar of a previously installed
// version and keeps the .list records - the UI only reloads `plugins list`.

function _setPluginBusy(ctx, pkey, label) {
  if (label) _pluginBusy[`${ctx}|${pkey}`] = label;
  else delete _pluginBusy[`${ctx}|${pkey}`];
  _refreshPluginRows(ctx);
}

function _toastDependencyResult(result) {
  const failed = result.failedDependencies || [];
  const missing = result.missingDependencies || [];
  failed.forEach(d => toast(`Dependency ${d.name} failed: ${d.error}`, 'error'));
  if (missing.length) {
    toast(`Install manually: ${missing.map(d => d.name).join(', ')} (required, but not available on ${PLUGIN_PLATFORM_NAMES[result.platform] || result.platform})`, 'info');
  }
}

async function installPlugin(pluginData, ctx, versionId) {
  const target = _pluginTarget(ctx);
  if (!target.serverId && !target.profileId) return;
  const pkey = _pluginKey(pluginData.platform, pluginData.slug);
  const { mcVersion } = _pluginCtxSoftware(ctx);
  const opts = {
    ...target,
    mcVersion: ctx === 'server' ? mcVersion : '',
    owner: pluginData.ownerName || pluginData.author,
    versionId,
  };

  _setPluginBusy(ctx, pkey, 'Installing…');
  try {
    let result = await window.mcpanel.installPlugin(pluginData.platform, pluginData.slug,
      { ...opts, yes: disclaimerSuppressed('plugins') });
    if (result?.code === 'disclaimer_required') {
      if (!(await askPluginDisclaimer(result))) return;
      result = await window.mcpanel.installPlugin(pluginData.platform, pluginData.slug, { ...opts, yes: true });
    }
    if (result?.error) {
      toast('Install failed: ' + result.error, 'error');
      return;
    }
    const deps = result.dependencies || [];
    toast(`Installed ${result.name || pluginData.name} → ${result.relPath || result.filename}`
      + (deps.length ? ` (+ ${deps.map(d => d.name).join(', ')})` : ''), 'success');
    _toastDependencyResult(result);
    await _loadInstalledPlugins(ctx);
  } catch (e) {
    toast('Install failed: ' + e.message, 'error');
  } finally {
    _setPluginBusy(ctx, pkey, null);
  }
}

async function updatePlugin(pluginData, ctx) {
  const pkey = _pluginKey(pluginData.platform, pluginData.slug);
  const rec = _installedPlugin(ctx, pkey);
  if (!rec) return;
  _setPluginBusy(ctx, pkey, 'Updating…');
  try {
    const result = await window.mcpanel.updatePlugin(rec.platform, rec.id, _pluginTarget(ctx));
    if (result?.error) {
      toast('Update failed: ' + result.error, 'error');
    } else if (result.unchanged) {
      toast(result.message || `${rec.name} is already up to date`, 'info');
    } else {
      const deps = result.dependencies || [];
      toast(`Updated ${result.name}: ${result.previousVersion || '?'} → ${result.version || '?'}`
        + (deps.length ? ` (+ ${deps.map(d => d.name).join(', ')})` : ''), 'success');
      _toastDependencyResult(result);
      await _loadInstalledPlugins(ctx);
    }
  } catch (e) {
    toast('Update failed: ' + e.message, 'error');
  } finally {
    _setPluginBusy(ctx, pkey, null);
  }
}

async function uninstallPlugin(pluginData, ctx) {
  const pkey = _pluginKey(pluginData.platform, pluginData.slug);
  const rec = _installedPlugin(ctx, pkey);
  if (!rec) return;
  const kind = _pluginKind(ctx) === 'mod' ? 'Mod' : 'Plugin';
  const neededBy = Object.values(_pluginInstalledMap[_pluginCtxKey(ctx)] || {})
    .filter(p => p !== rec && (p.dependencies || []).some(d => String(d).toLowerCase() === String(rec.id).toLowerCase()))
    .map(p => p.name);
  const ok = await confirmDialog({
    title: `Uninstall ${kind}`,
    message: `Uninstall "${rec.name}"?\n\nThis deletes ${rec.path} from disk and cannot be undone.`
      + (neededBy.length ? `\n\nRequired by: ${neededBy.join(', ')}` : ''),
    confirmLabel: 'Uninstall',
  });
  if (!ok) return;
  _setPluginBusy(ctx, pkey, 'Removing…');
  try {
    const result = await window.mcpanel.uninstallPlugin(rec.platform, rec.id, _pluginTarget(ctx));
    if (result?.error) {
      toast('Uninstall failed: ' + result.error, 'error');
    } else {
      delete _pluginInstalledMap[_pluginCtxKey(ctx)]?.[pkey];
      toast(`${rec.name} uninstalled`, 'info');
    }
  } catch (e) {
    toast('Uninstall failed: ' + e.message, 'error');
  } finally {
    _setPluginBusy(ctx, pkey, null);
  }
}

async function openVelocityLinkModal() {
  if (!currentServerId) return;
  const srv = config.servers.find(s => s.id === currentServerId);
  if (!srv) return;
  await loadProxySection(srv);
  openModal('modal-velocity-link');
}

async function loadProxySection(srv) {
  const velocityServers = config.servers.filter(s => s.software === 'velocity');
  const sel = document.getElementById('tsett-proxy-velocity');
  if (velocityServers.length === 0) {
    sel.innerHTML = '<option value="">No Velocity servers found</option>';
  } else {
    sel.innerHTML = velocityServers
      .map(v => `<option value="${v.id}">${escapeHtml(v.name)}</option>`)
      .join('');
  }

  const safeName = (srv.name || '').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
  document.getElementById('tsett-proxy-name').value = safeName;
  document.getElementById('tsett-proxy-custom-ip-toggle').checked = false;
  document.getElementById('tsett-proxy-custom-ip-wrap').classList.add('hidden');
  document.getElementById('tsett-proxy-custom-ip').value = '';

  if (velocityServers.length > 0) await updateProxyPrioritySlider(velocityServers[0].id);
}

async function onProxyVelocityChange() {
  const id = document.getElementById('tsett-proxy-velocity').value;
  if (id) await updateProxyPrioritySlider(id);
}

async function updateProxyPrioritySlider(velocityId) {
  try {
    const info = await window.mcpanel.proxyInfo(velocityId);
    const tryList = (info && info.tryList) ? info.tryList : [];
    const slider = document.getElementById('tsett-proxy-priority');
    const valEl = document.getElementById('tsett-proxy-priority-val');
    const labelsEl = document.getElementById('tsett-proxy-priority-labels');
    slider.max = tryList.length;
    slider.value = tryList.length;
    valEl.textContent = tryList.length;
    labelsEl.innerHTML = tryList.length > 0
      ? tryList.map((n, i) => `<span>${i}: ${escapeHtml(n)}</span>`).join('') + `<span>${tryList.length}: (end)</span>`
      : '<span style="opacity:0.55">Try list is empty - this will be the first server</span>';
  } catch { /* ignore */ }
}

async function linkToVelocityProxy(btn) {
  const velocityId = document.getElementById('tsett-proxy-velocity').value;
  const serverName = document.getElementById('tsett-proxy-name').value.trim();
  const priority = parseInt(document.getElementById('tsett-proxy-priority').value) || 0;
  const useCustomIp = document.getElementById('tsett-proxy-custom-ip-toggle').checked;
  const customIp = useCustomIp ? document.getElementById('tsett-proxy-custom-ip').value.trim() : null;

  if (!velocityId) { toast('Please select a Velocity proxy server', 'error'); return; }
  if (!serverName) { toast('Please enter a server name', 'error'); return; }

  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = 'Linking…';

  try {
    const result = await window.mcpanel.linkToProxy(currentServerId, velocityId, serverName, priority, customIp);
    if (result && result.error) {
      toast('Link failed: ' + result.error, 'error');
    } else {
      toast('Server linked to Velocity proxy!', 'success');
      closeModal('modal-velocity-link');
      // The CLI saved the link to config.json; mirror it so the UI updates.
      const srv = config.servers.find(s => s.id === currentServerId);
      if (srv) {
        srv.velocityLink = { velocityId, serverName: result.serverName || serverName, customIp };
        renderProxyLink(srv);
      }
    }
  } catch (e) {
    toast('Link failed: ' + e, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

// Linked servers get a "Velocity Proxy" card on the console tab (proxy name
// opens the proxy, X unlinks) and Unlink instead of Link in Settings.
function renderProxyLink(srv) {
  const link = srv && srv.velocityLink;
  const linked = !!(link && typeof link === 'object');
  const card = document.getElementById('proxy-link-card');
  if (card) card.classList.toggle('hidden', !linked);
  const linkBtn = document.querySelector('#tsett-proxy-btn-row > button:not(#tsett-proxy-unlink-btn)');
  const unlinkBtn = document.getElementById('tsett-proxy-unlink-btn');
  if (linkBtn) linkBtn.classList.toggle('hidden', linked);
  if (unlinkBtn) unlinkBtn.classList.toggle('hidden', !linked);
  if (!linked) return;

  const proxy = config.servers.find(s => s.id === link.velocityId);
  const openBtn = document.getElementById('proxy-link-open');
  document.getElementById('proxy-link-name').textContent = proxy ? proxy.name : 'Missing proxy';
  document.getElementById('proxy-link-as').textContent = link.serverName ? `as ${link.serverName}` : '';
  openBtn.disabled = !proxy;
  openBtn.title = proxy ? `Open ${proxy.name}` : 'The linked proxy no longer exists';
}

// A linked server's port lives in two places: its own config and its entry
// in the proxy's velocity.toml. After a port change, ask whether the proxy
// entry should follow (it may deliberately point elsewhere, e.g. a tunnel).
async function offerProxyPortSync(serverId, oldPort) {
  const srv = config.servers.find(s => s.id === serverId);
  const link = srv && srv.velocityLink;
  if (!link || !srv.port || srv.port === oldPort) return;
  const proxy = config.servers.find(s => s.id === link.velocityId);
  if (!proxy) return;
  const ok = await confirmDialog({
    title: 'Update proxy too?',
    message: `"${srv.name}" is linked to "${proxy.name}" as "${link.serverName}". `
      + `Change its address in the proxy's velocity.toml to port ${srv.port} as well?`,
    confirmLabel: 'Update proxy',
    cancelLabel: 'Only this server',
    danger: false,
  });
  if (!ok) return;
  try {
    const r = await window.mcpanel.syncProxyPort(serverId);
    if (r && r.error) { toast('Proxy not updated: ' + r.error, 'error'); return; }
    const running = await window.mcpanel.isServerRunning(proxy.id).catch(() => false);
    if (!running) { toast(`Proxy updated (${r.address})`, 'success'); return; }
    toast(`Proxy updated (${r.address}) - restart "${proxy.name}" to apply it`, 'info', {
      duration: Infinity,
      buttons: [
        { label: 'Later', onClick: () => {} },
        { label: 'Restart proxy', onClick: () => restartProxyFromToast(proxy) },
      ],
    });
  } catch (e) {
    toast('Proxy not updated: ' + e, 'error');
  }
}

async function restartProxyFromToast(proxy) {
  toast(`Restarting "${proxy.name}"...`, 'info');
  const r = await window.mcpanel.restartServer(proxy.id);
  if (r && r.error) { toast(r.error, 'error'); return; }
  if (r && r.success) {
    startingServers.add(proxy.id);
    if (currentServerId === proxy.id) { updateDetailControls(true); updateDetailStarting(); }
    updateServerCardStatus(proxy.id, 'starting', 0);
    updateSidebarDot(proxy.id, true);
    pollAllStatuses();
  }
}

function openLinkedProxy() {
  const srv = config.servers.find(s => s.id === currentServerId);
  const id = srv && srv.velocityLink && srv.velocityLink.velocityId;
  if (id && config.servers.some(s => s.id === id)) openServerDetail(id);
}

async function unlinkFromVelocityProxy(btn) {
  const serverId = currentServerId;
  const srv = config.servers.find(s => s.id === serverId);
  if (!srv || !srv.velocityLink) return;
  const proxy = config.servers.find(s => s.id === srv.velocityLink.velocityId);
  const ok = await confirmDialog({
    title: 'Unlink from proxy',
    message: `Remove "${srv.name}" from ${proxy ? `"${proxy.name}"` : 'its proxy'}? `
      + 'Its velocity.toml entry is removed, Velocity forwarding is turned off and online-mode is set back to true.',
    confirmLabel: 'Unlink',
  });
  if (!ok) return;

  btn.disabled = true;
  try {
    const result = await window.mcpanel.unlinkFromProxy(serverId);
    if (result && result.error) {
      toast('Unlink failed: ' + result.error, 'error');
      return;
    }
    delete srv.velocityLink;
    if (currentServerId === serverId) renderProxyLink(srv);
    toast('Server unlinked from Velocity proxy', 'success');
  } catch (e) {
    toast('Unlink failed: ' + e, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function quickStart(id, e) {
  e.stopPropagation();
  await startServerFlow(id);
}

async function quickStop(id, e) {
  e.stopPropagation();
  await window.mcpanel.stopServer(id);
  toast('Stop command sent', 'info');
}

async function sidebarQuickToggle(id, e) {
  e.stopPropagation();
  const running = await window.mcpanel.isServerRunning(id);
  if (running) {
    await window.mcpanel.stopServer(id);
    toast('Stop command sent', 'info');
  } else {
    await startServerFlow(id);
  }
}

function updateDetailControls(running) {
  const actionsEl = document.getElementById('detail-actions');
  const statusDot = document.getElementById('console-status-dot');
  const bigStatus = document.getElementById('big-status-badge');

  statusDot.className = `status-dot ${running ? 'online' : ''}`;
  bigStatus.className = `big-status ${running ? 'online' : ''}`;
  bigStatus.textContent = running ? 'ONLINE' : 'OFFLINE';

  actionsEl.innerHTML = '';

  const controls = !running ? [
    { label: 'Start', cls: 'start', icon: `<polygon points="5 3 19 12 5 21 5 3"/>`, fill: true, action: () => startServerFlow(currentServerId) },
  ] : [
    { label: 'Stop', cls: 'stop', icon: `<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>`, fill: true, action: async () => {
      await window.mcpanel.stopServer(currentServerId);
      toast('Stop command sent', 'info');
    }},
    { label: 'Restart', cls: 'restart', icon: `<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>`, action: async () => {
      toast('Restarting server...', 'info');
      const r = await window.mcpanel.restartServer(currentServerId);
      if (r && r.error) toast(r.error, 'error');
      else if (r && r.success) {
        startingServers.add(currentServerId);
        updateDetailControls(true);
        updateDetailStarting();
        updateServerCardStatus(currentServerId, 'starting', 0);
        updateSidebarDot(currentServerId, true);
        pollAllStatuses();
      }
    }},
    { label: 'Kill', cls: 'kill', icon: `<path d="M18 6L6 18M6 6l12 12"/>`, action: async () => { await window.mcpanel.killServer(currentServerId); updateDetailControls(false); toast('Server killed', 'error'); } },
  ];

  controls.forEach(({ label, cls, icon, fill, action }) => {
    const btn = document.createElement('button');
    btn.className = `btn-control ${cls}`;
    const svg = fill
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">${icon}</svg>`
      : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${icon}</svg>`;
    btn.innerHTML = `${svg}${label}`;
    btn.onclick = () => action();
    actionsEl.appendChild(btn);
  });
}

// Mini donut gauges in the detail status bar. Circumference = 2π × 26.
const DETAIL_CIRC = 163.363;
function setMiniCircle(arcId, pct, colorClass) {
  const arc = document.getElementById(arcId);
  if (!arc) return;
  const p = Math.min(Math.max(pct, 0), 100);
  arc.style.strokeDashoffset = DETAIL_CIRC * (1 - p / 100);
  arc.className = 'mini-circle-arc' + (colorClass ? ' ' + colorClass : '');
}

// Show one decimal when a value rounds to 0% (e.g. a nearly-idle CPU) so it
// doesn't flatten to a bare "0%".
function fmtPct(p) {
  return Math.round(p) === 0 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}

function setPlayersBar(current, max, online) {
  const textEl = document.getElementById('detail-players');
  if (!textEl) return;
  if (!online) {
    setMiniCircle('detail-players-arc', 0);
    textEl.textContent = '0/0';
    return;
  }
  const pct = max > 0 ? (current / max) * 100 : 0;
  setMiniCircle('detail-players-arc', pct, 'arc-green');
  textEl.textContent = `${current}/${max}`;
}

function setCpuGauge(pct, online) {
  const valEl = document.getElementById('detail-cpu');
  const subEl = document.getElementById('detail-cpu-sub');
  if (!valEl) return;
  // Offline (or no reading) still reads 0.0% rather than a bare dash.
  const p = (online && pct != null) ? Math.min(100, Math.max(0, pct)) : 0;
  setMiniCircle('detail-cpu-arc', p, p > 85 ? 'arc-danger' : p > 65 ? 'arc-warn' : '');
  valEl.textContent = fmtPct(p);
  if (subEl) {
    const model = stripCpuName(systemCpu.name) || systemCpu.name;
    subEl.textContent = model || '-';
    subEl.title = systemCpu.name || '';
  }
}

function formatCap(capStr) {
  const bytes = parseStorageLimit(capStr);
  return bytes !== null ? formatBytes(bytes) : (capStr || '-');
}

// `heapStr`: the server's heap limit, or empty for the automatic one. Once
// usage passes the RAM cap, the limit shown is the RAM cap + heap cap.
function setRamBar(usedBytes, capStr, heapStr) {
  const valEl = document.getElementById('detail-ram');
  const subEl = document.getElementById('detail-ram-sub');
  if (!valEl) return;
  // A bare number is megabytes for RAM (parseStorageLimit would read bytes).
  const capMb = ramToMb(capStr);
  let capBytes = capMb ? capMb * 1048576 : parseStorageLimit(capStr);
  const used = usedBytes || 0;
  if (capBytes !== null && capBytes > 0) {
    const heapMb = ramToMb(heapStr) || autoHeapMb(capStr);
    if (used > capBytes && heapMb) capBytes += heapMb * 1048576;
    const pct = Math.min(100, (used / capBytes) * 100);
    setMiniCircle('detail-ram-arc', pct, pct > 90 ? 'arc-danger' : pct > 75 ? 'arc-warn' : '');
    valEl.textContent = fmtPct(pct);
    if (subEl) subEl.textContent = `${formatBytes(used)} / ${formatBytes(capBytes)}`;
  } else {
    setMiniCircle('detail-ram-arc', 0);
    valEl.textContent = used > 0 ? formatBytes(used) : '-';
    if (subEl) subEl.textContent = formatCap(capStr);
  }
}

function setStorageBar(usedBytes, limitStr) {
  const valEl = document.getElementById('detail-storage');
  const subEl = document.getElementById('detail-storage-sub');
  if (!valEl) return;
  const used = usedBytes || 0;
  const usedFmt = formatBytes(used);
  const limitBytes = limitStr ? parseStorageLimit(limitStr) : null;
  const capBytes = limitBytes !== null ? limitBytes : (systemInfo.totalStorage || null);
  const capFmt = limitBytes !== null ? formatCap(limitStr)
    : (capBytes ? formatBytes(capBytes) : null);
  if (capBytes && capBytes > 0) {
    const ratio = (used / capBytes) * 100;
    const over = used > capBytes;
    setMiniCircle('detail-storage-arc', ratio, over ? 'arc-danger' : ratio > 90 ? 'arc-warn' : '');
    valEl.textContent = fmtPct(ratio);
    valEl.style.color = over ? 'var(--red)' : '';
    if (subEl) subEl.textContent = `${usedFmt} / ${capFmt}`;
    return;
  }
  setMiniCircle('detail-storage-arc', 0);
  valEl.textContent = usedFmt;
  valEl.style.color = '';
  if (subEl) subEl.textContent = '';
}

function updateDetailOnline(online, players = 0, maxPlayers = 0, playerList = []) {
  const bigStatus = document.getElementById('big-status-badge');
  bigStatus.className = `big-status ${online ? 'online' : ''}`;
  bigStatus.textContent = online ? 'ONLINE' : 'OFFLINE';
  currentOnlinePlayers = online ? (playerList || []) : [];
  setPlayersBar(players, maxPlayers, online);
  const listEl = document.getElementById('detail-player-list');
  if (listEl) {
    if (online && playerList.length > 0) {
      const shown = playerList.slice(0, 5);
      const extra = playerList.length - shown.length;
      listEl.textContent = shown.join(', ') + (extra > 0 ? ` +${extra} more` : '');
      listEl.style.display = '';
    } else {
      listEl.style.display = 'none';
    }
  }
}

let currentOnlinePlayers = [];
let playerData = { players: [], banned: [] };
let _selectedPlayerName = null;

// Player-head avatar. minotar resolves by UUID (dashless) or, failing that, by
// name; unknown players fall back to the default Steve head.
function playerHeadUrl(p, size = 38) {
  const id = p && p.uuid ? p.uuid.replace(/-/g, '') : encodeURIComponent((p && p.name) || 'Steve');
  return `https://minotar.net/helm/${id}/${size}.png`;
}

async function _readServerJson(id, rel) {
  try {
    return JSON.parse(await window.mcpanel.readServerFile(id, rel));
  } catch { return null; }
}

function _isServerRunning() {
  return !!(currentServerId && serverStartTimes[currentServerId]);
}

// Aggregate the roster from the server's own JSON files (each optional) plus the
// currently-online sample. Banned players are split into their own list.
async function loadPlayerData(id) {
  const [whitelist, ops, banned, usercache] = await Promise.all([
    _readServerJson(id, 'whitelist.json'),
    _readServerJson(id, 'ops.json'),
    _readServerJson(id, 'banned-players.json'),
    _readServerJson(id, 'usercache.json'),
  ]);

  const map = new Map(); // lowercased name → player
  const put = (name, uuid) => {
    if (!name) return null;
    const key = String(name).toLowerCase();
    let p = map.get(key);
    if (!p) { p = { name, uuid: uuid || null, whitelisted: false, op: false, online: false }; map.set(key, p); }
    if (!p.uuid && uuid) p.uuid = uuid;
    return p;
  };

  (Array.isArray(usercache) ? usercache : []).forEach(e => put(e.name, e.uuid));
  (Array.isArray(whitelist) ? whitelist : []).forEach(e => { const p = put(e.name, e.uuid); if (p) p.whitelisted = true; });
  (Array.isArray(ops) ? ops : []).forEach(e => { const p = put(e.name, e.uuid); if (p) { p.op = true; p.opLevel = e.level; } });
  (currentOnlinePlayers || []).forEach(n => { const p = put(n); if (p) p.online = true; });

  const bannedList = (Array.isArray(banned) ? banned : []).map(e => ({
    name: e.name, uuid: e.uuid || null, reason: e.reason || '', source: e.source || '', created: e.created || '',
  }));
  const bannedKeys = new Set(bannedList.map(b => String(b.name || '').toLowerCase()));

  const players = [...map.values()].filter(p => !bannedKeys.has(p.name.toLowerCase()));
  players.sort((a, b) => (b.online - a.online) || (b.op - a.op) || a.name.localeCompare(b.name));

  return { players, banned: bannedList };
}

async function openPlayersTab() {
  showPlayerRoster();
  await reloadPlayers();
}

async function reloadPlayers() {
  const id = currentServerId;
  if (!id) return;
  playerData = await loadPlayerData(id);
  renderPlayerRoster();
  // Keep an open control panel in sync with the freshly-loaded data.
  if (_selectedPlayerName && !document.getElementById('player-view-detail').classList.contains('hidden')) {
    renderPlayerDetail(_selectedPlayerName);
  }
}

function showPlayerRoster() {
  document.getElementById('psub-list').classList.add('active');
  document.getElementById('psub-detail').classList.remove('active');
  document.getElementById('player-view-roster').classList.remove('hidden');
  document.getElementById('player-view-detail').classList.add('hidden');
}
function showPlayerDetailTab() {
  const detailTab = document.getElementById('psub-detail');
  detailTab.classList.remove('hidden');
  detailTab.classList.add('active');
  document.getElementById('psub-list').classList.remove('active');
  document.getElementById('player-view-roster').classList.add('hidden');
  document.getElementById('player-view-detail').classList.remove('hidden');
}

function renderPlayerRoster() {
  const grid = document.getElementById('player-grid');
  if (!grid) return;
  const running = _isServerRunning();
  const players = playerData.players || [];
  document.getElementById('player-count').textContent = players.length;
  document.getElementById('player-empty').classList.toggle('hidden', players.length > 0);
  grid.innerHTML = players.map(playerItemHtml).join('');

  const banned = playerData.banned || [];
  document.getElementById('player-banned-count').textContent = banned.length;
  document.getElementById('player-banned-head').style.display = banned.length ? '' : 'none';
  document.getElementById('player-banned-grid').innerHTML = banned.map(b => bannedItemHtml(b, running)).join('');
}

function playerItemHtml(p) {
  const tags = [];
  if (p.online) tags.push('<span class="ptag online">Online</span>');
  if (p.op) tags.push('<span class="ptag op">OP</span>');
  if (p.whitelisted) tags.push('<span class="ptag wl">Whitelist</span>');
  if (!tags.length) tags.push('<span class="ptag" style="color:var(--text-muted);background:var(--bg-base)">Known</span>');
  const enc = encodeURIComponent(p.name);
  return `<div class="player-item" onclick="openPlayerControl('${enc}')">
    <img class="player-head" src="${playerHeadUrl(p, 38)}" alt="" onerror="this.style.visibility='hidden'">
    <div class="player-item-info">
      <span class="player-item-name">${escapeHtml(p.name)}</span>
      <div class="player-tags">${tags.join('')}</div>
    </div>
  </div>`;
}

function bannedItemHtml(b, running) {
  const enc = encodeURIComponent(b.name);
  const reasonAttr = b.reason ? ` title="${escapeHtml(b.reason)}"` : '';
  return `<div class="player-item" onclick="openPlayerControl('${enc}')">
    <img class="player-head" src="${playerHeadUrl(b, 38)}" alt="" onerror="this.style.visibility='hidden'">
    <div class="player-item-info">
      <span class="player-item-name">${escapeHtml(b.name)}</span>
      <div class="player-tags"><span class="ptag banned"${reasonAttr}>Banned</span></div>
    </div>
    <button class="btn-ghost-sm player-unban" ${running ? '' : 'disabled'}
      onclick="event.stopPropagation(); unbanPlayer('${enc}')">Unban</button>
  </div>`;
}

function findPlayerByName(name) {
  const key = name.toLowerCase();
  const p = (playerData.players || []).find(x => x.name.toLowerCase() === key);
  if (p) return { ...p, banned: false };
  const b = (playerData.banned || []).find(x => String(x.name || '').toLowerCase() === key);
  if (b) return { ...b, banned: true, whitelisted: false, op: false, online: false };
  return { name, uuid: null, banned: false, whitelisted: false, op: false, online: false };
}

function openPlayerControl(enc) {
  const name = decodeURIComponent(enc);
  _selectedPlayerName = name;
  renderPlayerDetail(name);
  showPlayerDetailTab();
}

function renderPlayerDetail(name) {
  const p = findPlayerByName(name);
  const view = document.getElementById('player-view-detail');
  if (!view) return;
  const running = _isServerRunning();
  const dis = running ? '' : 'disabled';
  const enc = encodeURIComponent(p.name);

  const tags = [];
  if (p.online) tags.push('<span class="ptag online">Online</span>');
  if (p.op) tags.push('<span class="ptag op">OP</span>');
  if (p.whitelisted) tags.push('<span class="ptag wl">Whitelist</span>');
  if (p.banned) tags.push('<span class="ptag banned">Banned</span>');

  let actions;
  if (p.banned) {
    actions = `<button class="btn-control start" ${dis} onclick="unbanPlayer('${enc}')">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg> Unban</button>`;
  } else {
    actions = `
      <button class="btn-control wl" ${dis} onclick="togglePlayerWhitelist('${enc}', ${p.whitelisted})">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
        ${p.whitelisted ? 'Remove from whitelist' : 'Add to whitelist'}</button>
      <button class="btn-control op" ${dis} onclick="togglePlayerOp('${enc}', ${p.op})">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15 8.5 22 9.3 17 14 18.2 21 12 17.6 5.8 21 7 14 2 9.3 9 8.5 12 2"/></svg>
        ${p.op ? 'Deop' : 'Op'}</button>
      <button class="btn-control warn" ${(p.online && running) ? '' : 'disabled'} onclick="kickPlayer('${enc}')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/></svg>
        Kick</button>
      <button class="btn-control stop" ${dis} onclick="banPlayer('${enc}')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M4.9 4.9l14.2 14.2"/></svg>
        Ban</button>`;
  }

  const note = running ? '' : `<div class="player-offline-note">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
    Start the server to manage this player.</div>`;

  view.innerHTML = `
    <div class="player-detail-head">
      <img class="player-head lg" src="${playerHeadUrl(p, 72)}" alt="" onerror="this.style.visibility='hidden'">
      <div class="player-detail-meta">
        <div class="player-detail-name">${escapeHtml(p.name)}</div>
        ${p.uuid ? `<div class="player-detail-uuid">${escapeHtml(p.uuid)}</div>` : ''}
        <div class="player-detail-tags player-tags">${tags.join('')}</div>
      </div>
    </div>
    ${note}
    <div class="player-detail-actions">${actions}</div>`;

  document.getElementById('psub-detail-name').textContent = p.name;
}

async function _playerCmd(cmd, okMsg) {
  if (!currentServerId) return false;
  const r = await window.mcpanel.sendCommand(currentServerId, cmd);
  if (r && r.error) { toast(r.error, 'error'); return false; }
  toast(okMsg, 'success');
  setTimeout(reloadPlayers, 700); // let the server write its JSON files first
  return true;
}
function togglePlayerWhitelist(enc, isWl) {
  const name = decodeURIComponent(enc);
  _playerCmd(`whitelist ${isWl ? 'remove' : 'add'} ${name}`, isWl ? `Removed ${name} from whitelist` : `Added ${name} to whitelist`);
}
function togglePlayerOp(enc, isOp) {
  const name = decodeURIComponent(enc);
  _playerCmd(`${isOp ? 'deop' : 'op'} ${name}`, isOp ? `Deopped ${name}` : `Opped ${name}`);
}
function kickPlayer(enc) {
  const name = decodeURIComponent(enc);
  _playerCmd(`kick ${name}`, `Kicked ${name}`);
}
function banPlayer(enc) {
  const name = decodeURIComponent(enc);
  _playerCmd(`ban ${name}`, `Banned ${name}`);
}
function unbanPlayer(enc) {
  const name = decodeURIComponent(enc);
  _playerCmd(`pardon ${name}`, `Unbanned ${name}`);
}

const ANSI_16 = [
  '#000000','#cc3333','#33cc55','#d4c84a','#4466cc','#cc44cc','#33cccc','#cccccc',
  '#666666','#ff5555','#55ff77','#ffff55','#5588ff','#ff55ff','#55ffff','#ffffff',
];

function ansi256(n) {
  if (n < 16) return ANSI_16[n];
  if (n >= 232) { const g = 8 + 10 * (n - 232); return `rgb(${g},${g},${g})`; }
  n -= 16;
  const v = i => i === 0 ? 0 : 55 + 40 * i;
  return `rgb(${v(Math.floor(n/36))},${v(Math.floor(n/6)%6)},${v(n%6)})`;
}

function ansiToHtml(text) {
  const re = /\x1b\[([0-9;]*)m/g;
  let html = '', lastIdx = 0;
  let fg = null, bg = null, bold = false, openSpan = false;

  const flush = () => {
    if (openSpan) { html += '</span>'; openSpan = false; }
    if (fg || bg || bold) {
      let s = '';
      if (fg) s += `color:${fg};`;
      if (bg) s += `background:${bg};`;
      if (bold) s += 'font-weight:600;';
      html += `<span style="${s}">`;
      openSpan = true;
    }
  };

  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) html += escapeHtml(text.slice(lastIdx, m.index));
    lastIdx = re.lastIndex;

    const codes = m[1] ? m[1].split(';').map(Number) : [0];
    let changed = false, i = 0;
    while (i < codes.length) {
      const c = codes[i];
      if (c === 0 || isNaN(c))           { fg = null; bg = null; bold = false; changed = true; }
      else if (c === 1)                   { bold = true; changed = true; }
      else if (c === 22)                  { bold = false; changed = true; }
      else if (c >= 30 && c <= 37)        { fg = ANSI_16[c - 30]; changed = true; }
      else if (c === 38) {
        if (codes[i+1] === 5 && codes[i+2] != null)             { fg = ansi256(codes[i+2]); i += 2; changed = true; }
        else if (codes[i+1] === 2 && codes[i+4] != null)         { fg = `rgb(${codes[i+2]},${codes[i+3]},${codes[i+4]})`; i += 4; changed = true; }
      }
      else if (c === 39)                  { fg = null; changed = true; }
      else if (c >= 40 && c <= 47)        { bg = ANSI_16[c - 40]; changed = true; }
      else if (c === 48) {
        if (codes[i+1] === 5 && codes[i+2] != null)             { bg = ansi256(codes[i+2]); i += 2; changed = true; }
        else if (codes[i+1] === 2 && codes[i+4] != null)         { bg = `rgb(${codes[i+2]},${codes[i+3]},${codes[i+4]})`; i += 4; changed = true; }
      }
      else if (c === 49)                  { bg = null; changed = true; }
      else if (c >= 90 && c <= 97)        { fg = ANSI_16[c - 82]; changed = true; }
      else if (c >= 100 && c <= 107)      { bg = ANSI_16[c - 92]; changed = true; }
      i++;
    }
    if (changed) flush();
  }

  if (lastIdx < text.length) html += escapeHtml(text.slice(lastIdx));
  if (openSpan) html += '</span>';
  return html;
}

async function _pollStep(id) {
  if (consolePollInterval === null || id !== currentServerId) return;
  let delay = 50;
  try {
    const result = await window.mcpanel.getLogSince(id, consoleLogOffset);
    if (result && id === currentServerId) {
      consoleLogOffset = result.offset;
      (result.lines || []).forEach(entry => appendConsoleLine(entry.text || '', entry.type || 'out'));
    }
  } catch {
    // Don't hammer a broken read every 50ms - back off for a minute.
    delay = 60000;
  }
  if (consolePollInterval !== null && id === currentServerId) {
    consolePollInterval = setTimeout(() => _pollStep(id), delay);
  }
}

function startConsolePoll(id) {
  stopConsolePoll();
  consolePollInterval = setTimeout(() => _pollStep(id), 50);
}

// Marks the main pane as scrolling until it has been still for a moment, so
// CSS can switch off hover effects that would otherwise fire on every card
// the cursor passes while flicking through the server list.
function setupScrollHoverGuard() {
  const main = document.querySelector('.main');
  if (!main) return;
  let timer = null;
  main.addEventListener('scroll', () => {
    if (!timer) main.classList.add('is-scrolling');
    clearTimeout(timer);
    timer = setTimeout(() => { main.classList.remove('is-scrolling'); timer = null; }, 150);
  }, { passive: true });
}

function stopConsolePoll() {
  if (consolePollInterval) { clearTimeout(consolePollInterval); consolePollInterval = null; }
}

function setupConsoleScroll() {
  const el = document.getElementById('console-output');
  el.addEventListener('scroll', () => {
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
    if (atBottom && !consoleAutoScroll) {
      consoleAutoScroll = true;
      document.getElementById('autoscroll-banner').classList.add('hidden');
    } else if (!atBottom && consoleAutoScroll) {
      consoleAutoScroll = false;
      document.getElementById('autoscroll-banner').classList.remove('hidden');
    }
  });
}

function resumeAutoscroll() {
  const el = document.getElementById('console-output');
  consoleAutoScroll = true;
  document.getElementById('autoscroll-banner').classList.add('hidden');
  el.scrollTop = el.scrollHeight;
}

function appendConsoleLine(text, type = 'out') {
  const el = document.getElementById('console-output');
  if (!el) return;
  const line = document.createElement('div');

  if (type === 'system') {
    line.className = 'log-line system';
  } else {
    const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
    if (type === 'err' || /\b(ERROR|SEVERE|FATAL)\b/i.test(plain)) line.className = 'log-line err';
    else if (/\b(WARN(?:ING)?)\b/i.test(plain))                     line.className = 'log-line warn';
    else                                                              line.className = 'log-line';
  }

  const time = new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const body = type === 'system' ? escapeHtml(text) : ansiToHtml(text);
  line.innerHTML = `<span class="log-time">[${time}]</span><span class="log-text">${body}</span>`;
  if (type !== 'system') {
    learnConsolePlayers(text.replace(/\x1b\[[0-9;]*m/g, ''));
    linkConsolePlayers(line);
  }
  el.appendChild(line);
  if (consoleAutoScroll && !_consoleMenuOpen) el.scrollTop = el.scrollHeight;
}

function clearConsole() {
  const el = document.getElementById('console-output');
  if (el) el.innerHTML = '';
  consoleAutoScroll = true;
  document.getElementById('autoscroll-banner').classList.add('hidden');
}

// ─── Console player names ─────────────────────────────────────────────────────
// Names of this server's players are clickable in the console and open a menu
// (op / whitelist / kick / ban) titled with the player's name and head. Known
// names come from the server's player files (usercache, ops, whitelist, bans),
// the online list, and lines like joins, logins and chat as they arrive.
let _consolePlayers = new Map();   // lowercased → name as Minecraft prints it
let _consolePlayerRe = null;
// The context menu closes on any scroll, autoscroll included, so new lines
// don't scroll the console while the player menu is open.
let _consoleMenuOpen = false;

const _CONSOLE_PLAYER_PATTERNS = [
  /UUID of player ([A-Za-z0-9_]{3,16}) is/,
  /\b([A-Za-z0-9_]{3,16})\[\/[^\]]+\] logged in/,
  /\b([A-Za-z0-9_]{3,16}) (?:joined|left) the game/,
  /\b([A-Za-z0-9_]{3,16}) lost connection/,
  /<([A-Za-z0-9_]{3,16})>/,
];

function _addConsolePlayer(name) {
  if (!name || !/^[A-Za-z0-9_]{3,16}$/.test(name)) return false;
  const key = name.toLowerCase();
  if (_consolePlayers.get(key) === name) return false;
  _consolePlayers.set(key, name);
  _consolePlayerRe = null;
  return true;
}

async function seedConsolePlayers(id) {
  _consolePlayers = new Map();
  _consolePlayerRe = null;
  const data = await loadPlayerData(id);
  if (currentServerId !== id) return;
  let added = false;
  for (const p of [...data.players, ...data.banned]) added = _addConsolePlayer(p.name) || added;
  // Lines already printed before the files were read get linked too.
  if (added) document.querySelectorAll('#console-output .log-line:not(.system)').forEach(linkConsolePlayers);
}

function learnConsolePlayers(plain) {
  for (const re of _CONSOLE_PLAYER_PATTERNS) {
    const m = plain.match(re);
    if (m) _addConsolePlayer(m[1]);
  }
  (currentOnlinePlayers || []).forEach(_addConsolePlayer);
}

// Wraps known names in the line's text nodes - never inside ansiToHtml's
// markup, and never twice.
function linkConsolePlayers(line) {
  if (!_consolePlayers.size) return;
  if (!_consolePlayerRe) {
    const names = [..._consolePlayers.values()].sort((a, b) => b.length - a.length);
    _consolePlayerRe = new RegExp(`(?<![A-Za-z0-9_])(${names.join('|')})(?![A-Za-z0-9_])`, 'g');
  }
  const textEl = line.querySelector('.log-text');
  if (!textEl) return;
  const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT, {
    acceptNode: n => n.parentElement.closest('.log-player') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const t = node.nodeValue;
    _consolePlayerRe.lastIndex = 0;
    if (!_consolePlayerRe.test(t)) continue;
    _consolePlayerRe.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = _consolePlayerRe.exec(t)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(t.slice(last, m.index)));
      const span = document.createElement('span');
      span.className = 'log-player';
      span.dataset.player = m[1];
      span.textContent = m[1];
      frag.appendChild(span);
      last = m.index + m[1].length;
    }
    if (last < t.length) frag.appendChild(document.createTextNode(t.slice(last)));
    node.replaceWith(frag);
  }
}

function setupConsolePlayerMenu() {
  const el = document.getElementById('console-output');
  if (!el) return;
  el.addEventListener('click', e => {
    const span = e.target.closest('.log-player');
    if (!span) return;
    // A drag that selects text ends in a click too - leave that selection alone.
    if (String(window.getSelection?.() || '')) return;
    openConsolePlayerMenu(e, span.dataset.player);
  });
}

async function openConsolePlayerMenu(e, name) {
  const id = currentServerId;
  if (!id) return;
  const pos = { clientX: e.clientX, clientY: e.clientY, preventDefault() {}, stopPropagation() {} };
  e.preventDefault();
  e.stopPropagation();
  // Fresh from the server's files, so the toggles match what the server has.
  playerData = await loadPlayerData(id);
  if (currentServerId !== id) return;
  const p = findPlayerByName(name);
  const enc = encodeURIComponent(p.name);
  const off = !_isServerRunning();
  const icon = d => `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${d}</svg>`;
  const items = p.banned ? [
    { label: 'Unban', icon: icon('<path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/>'), disabled: off, onClick: () => unbanPlayer(enc) },
  ] : [
    { label: p.op ? 'Deop' : 'Op', icon: icon('<polygon points="12 2 15 8.5 22 9.3 17 14 18.2 21 12 17.6 5.8 21 7 14 2 9.3 9 8.5 12 2"/>'),
      disabled: off, onClick: () => togglePlayerOp(enc, p.op) },
    { label: p.whitelisted ? 'Remove from whitelist' : 'Add to whitelist',
      icon: icon('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
      disabled: off, onClick: () => togglePlayerWhitelist(enc, p.whitelisted) },
    'sep',
    { label: 'Kick', icon: icon('<path d="M16 17l5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>'),
      disabled: off, onClick: () => kickPlayer(enc) },
    { label: 'Ban', icon: icon('<circle cx="12" cy="12" r="10"/><path d="M4.9 4.9l14.2 14.2"/>'),
      danger: true, disabled: off, onClick: () => banPlayer(enc) },
  ];
  _consoleMenuOpen = true;
  showContextMenu(pos, items, {
    title: p.name,
    titleImage: playerHeadUrl(p, 40),
    onClose: () => {
      _consoleMenuOpen = false;
      const el = document.getElementById('console-output');
      if (consoleAutoScroll && el) el.scrollTop = el.scrollHeight;
    },
  });
}

function handleConsoleKey(e) {
  if (e.key === 'Enter') {
    sendConsoleCommand();
  } else if (e.key === 'ArrowUp') {
    historyIndex = Math.min(historyIndex + 1, commandHistory.length - 1);
    e.target.value = commandHistory[commandHistory.length - 1 - historyIndex] || '';
  } else if (e.key === 'ArrowDown') {
    historyIndex = Math.max(historyIndex - 1, -1);
    e.target.value = historyIndex === -1 ? '' : commandHistory[commandHistory.length - 1 - historyIndex];
  }
}

async function sendConsoleCommand() {
  const input = document.getElementById('console-input');
  const cmd = input.value.trim();
  if (!cmd || !currentServerId) return;
  commandHistory.push(cmd);
  historyIndex = -1;
  input.value = '';
  appendConsoleLine('> ' + cmd, 'system');
  const r = await window.mcpanel.sendCommand(currentServerId, cmd);
  if (r.error) toast(r.error, 'error');
}

async function applyQuickPort() {
  const port = parseInt(document.getElementById('quick-port').value);
  if (!port || !currentServerId) return;
  const oldPort = config.servers.find(s => s.id === currentServerId)?.port;
  const r = await window.mcpanel.updateServer(currentServerId, { port });
  if (r.error) { toast(r.error, 'error'); return; }
  const idx = config.servers.findIndex(s => s.id === currentServerId);
  if (idx !== -1) config.servers[idx].port = port;
  document.getElementById('detail-port').textContent = port;
  document.getElementById('detail-server-subtitle').textContent =
    `${serverTypeLabel(config.servers[idx])} · Port ${port}`;
  toast('Port updated', 'success');
  offerProxyPortSync(currentServerId, oldPort);
}

// A custom-java server's "version" is its Java ("Java 25"): when the Java
// executable changes, the CLI re-reads it. Returns the new version or null.
async function _refreshJavaVersion(id, javaPath) {
  const srv = config.servers.find(s => s.id === id);
  if (!srv || srv.software !== 'custom-java' || srv.javaPath === javaPath) return null;
  try {
    const r = await window.mcpanel.setServerJava(id, javaPath);
    return r && r.server ? r.server.version : null;
  } catch { return null; }
}

async function saveQuickSettings() {
  if (!currentServerId) return;
  const javaArgs = document.getElementById('quick-java-args').value;
  const javaPath = document.getElementById('quick-java-path').value;
  const group = document.getElementById('quick-group').value.trim() || null;
  const newVersion = await _refreshJavaVersion(currentServerId, javaPath);
  const r = await window.mcpanel.updateServer(currentServerId, { javaArgs, javaPath, group });
  if (r.error) { toast(r.error, 'error'); return; }
  if (newVersion) {
    const s = config.servers.find(x => x.id === currentServerId);
    if (s) s.version = newVersion;
    if (s) document.getElementById('detail-server-subtitle').textContent = `${serverTypeLabel(s)} · Port ${s.port}`;
  }
  const idx = config.servers.findIndex(s => s.id === currentServerId);
  if (idx !== -1) {
    config.servers[idx].javaArgs = javaArgs;
    config.servers[idx].javaPath = javaPath;
    config.servers[idx].group = group;
  }
  renderServersGrid();
  toast('Settings saved', 'success');
}

async function browseJava() {
  const p = await window.mcpanel.browseJava();
  if (p) setJdkDropdown('quick', 'quick-java-path', p);
}

function openServerSettingsModal() {
  if (!currentServerId) return;
  const srv = config.servers.find(s => s.id === currentServerId);
  if (!srv) return;
  document.getElementById('ss-name').value = srv.name;
  setRamDropdown('ss', srv.ram || '2G');
  document.getElementById('ss-storage').value = srv.storageLimit || '';
  document.getElementById('ss-port').value = srv.port;
  document.getElementById('ss-group').value = srv.group || '';
  document.getElementById('ss-java-args').value = srv.javaArgs || '';
  populateJdkSelect('ss', 'ss-java-path', srv.javaPath || 'java');
  _showRunFileGroup('ss', srv.software);
  document.getElementById('ss-run').value = srv.runFile || '';
  openModal('modal-server-settings');
}

async function saveServerSettings() {
  if (!currentServerId) return;
  const name = document.getElementById('ss-name').value.trim();
  if (!name) { toast('Please enter a server name', 'error'); return; }
  const ram = getRamValue('ss');
  if (!ram) { toast('Please enter a custom RAM value (e.g. 3G, 2048M)', 'error'); return; }
  const storageLimit = document.getElementById('ss-storage').value.trim() || null;
  const port = parseInt(document.getElementById('ss-port').value) || null;
  const group = document.getElementById('ss-group').value.trim() || null;
  const javaArgs = document.getElementById('ss-java-args').value.trim();
  const javaPath = document.getElementById('ss-java-path').value.trim() || 'java';

  if (storageLimit) {
    const bytes = parseStorageLimit(storageLimit);
    if (bytes === null) { toast('Invalid storage limit format (e.g. 10GB, 2048MB)', 'error'); return; }
    if (bytes < 500 * 1048576) { toast('Storage limit must be at least 500MB', 'error'); return; }
  }
  const deviceErr = validateRamAndStorage(ram, storageLimit);
  if (deviceErr) { toast(deviceErr, 'error'); return; }

  const updates = { name, ram, storageLimit, javaArgs, javaPath, group };
  if (port) updates.port = port;

  if (!(await _saveRunFile('ss'))) return;

  const oldPort = config.servers.find(s => s.id === currentServerId)?.port;
  const newVersion = await _refreshJavaVersion(currentServerId, javaPath);
  if (newVersion) updates.version = newVersion;
  const r = await window.mcpanel.updateServer(currentServerId, updates);
  if (r.error) { toast(r.error, 'error'); return; }

  const idx = config.servers.findIndex(s => s.id === currentServerId);
  if (idx !== -1) config.servers[idx] = { ...config.servers[idx], ...updates };
  const srv = config.servers[idx];

  document.getElementById('detail-server-name').textContent = name;
  document.getElementById('detail-server-subtitle').textContent = `${serverTypeLabel(srv)} · Port ${srv.port}`;
  refreshDetailStats(currentServerId);
  if (port) document.getElementById('detail-port').textContent = port;

  const nameEl = document.querySelector(`#card-${currentServerId} .server-card-name`);
  if (nameEl) nameEl.textContent = name;
  const sidebarName = document.querySelector(`[data-server-id="${currentServerId}"] .srv-name`);
  if (sidebarName) sidebarName.textContent = name;

  if (port) document.getElementById('quick-port').value = port;
  document.getElementById('quick-java-args').value = javaArgs;
  document.getElementById('quick-java-path').value = javaPath;
  document.getElementById('quick-group').value = group || '';

  closeModal('modal-server-settings');
  renderServersGrid();
  toast('Settings saved', 'success');
  offerProxyPortSync(currentServerId, oldPort);
}

async function browseJavaSettings() {
  const p = await window.mcpanel.browseJava();
  if (p) setJdkDropdown('ss', 'ss-java-path', p);
}

async function browseJavaCreate() {
  const path = await window.mcpanel.browseJava();
  if (path) setJdkDropdown('cs', 'cs-java', path);
}

function onRamChange(prefix) {
  const sel = document.getElementById(`${prefix}-ram`);
  const customEl = document.getElementById(`${prefix}-ram-custom`);
  if (!customEl) return;
  const isCustom = sel.value === 'custom';
  customEl.style.display = isCustom ? '' : 'none';
  if (isCustom) customEl.focus();
  updateHeapPlaceholder(prefix);
}

// RAM is a server's TOTAL memory; the Java heap (-Xmx) is the part left after
// the JVM's own needs. Mirrors ram_mb / auto_heap in mcpanel-cli's util.py.
function ramToMb(value) {
  const m = String(value || '').trim().match(/^(\d+)\s*(M|MB|G|GB)?$/i);
  if (!m) return null;
  return (m[2] || 'M').toUpperCase()[0] === 'G' ? Number(m[1]) * 1024 : Number(m[1]);
}

function autoHeapMb(ram) {
  const total = ramToMb(ram);
  if (total == null) return null;
  const overhead = Math.min(Math.max(Math.floor(total / 5), 384), 1536);
  return Math.max(total - overhead, 256);
}

function updateHeapPlaceholder(prefix) {
  const el = document.getElementById(`${prefix}-heap`);
  if (!el) return;
  const mb = autoHeapMb(getRamValue(prefix));
  el.placeholder = mb ? `Auto (≈${_compactSize(mb * 1048576)})` : 'Auto';
}

// An optional heap limit checked against the RAM limit: error text or null.
function heapError(heap, ram) {
  if (!heap) return null;
  const h = ramToMb(heap);
  if (!h) return 'Invalid heap limit - use e.g. 4G or 2048M';
  const r = ramToMb(ram);
  if (r && h > r) return "The heap limit can't be larger than the RAM limit - the heap is part of it";
  return null;
}

function getRamValue(prefix) {
  const sel = document.getElementById(`${prefix}-ram`);
  if (sel.value === 'custom') {
    return document.getElementById(`${prefix}-ram-custom`).value.trim() || null;
  }
  return sel.value;
}

function setRamDropdown(prefix, value) {
  const sel = document.getElementById(`${prefix}-ram`);
  const customEl = document.getElementById(`${prefix}-ram-custom`);
  const knownValues = ['512M','1G','2G','4G','6G','8G','12G','16G'];
  if (knownValues.includes(value)) {
    sel.value = value;
    if (customEl) customEl.style.display = 'none';
  } else {
    sel.value = 'custom';
    if (customEl) { customEl.value = value || ''; customEl.style.display = ''; }
  }
}

// ─── JDK picker (dropdown of detected JDKs + a custom-path fallback) ──────────
// The underlying text input (`inputId`) is always kept in sync with the
// resolved choice, so existing save/read code that reads that input's
// `.value` needs no changes - the dropdown is purely a UI layer on top.
async function populateJdkSelect(prefix, inputId, currentValue) {
  const sel = document.getElementById(`${prefix}-java-select`);
  if (!sel) return;
  sel.innerHTML = '<option value="java" title="java">Auto-detect (recommended)</option>';
  let jdks = [];
  try { jdks = await window.mcpanel.detectJdk(); } catch { jdks = []; }
  jdks.forEach(j => {
    const opt = document.createElement('option');
    opt.value = j.path;
    opt.title = j.path;
    opt.textContent = `Java ${j.version}`;
    sel.appendChild(opt);
  });
  const custom = document.createElement('option');
  custom.value = '__custom__';
  custom.textContent = 'Custom path…';
  sel.appendChild(custom);

  setJdkDropdown(prefix, inputId, currentValue);
}

// The dropdown's visible option text is just the JDK name - the actual
// install path only shows as a tooltip (on the closed select, reflecting the
// current selection; on each option, while the dropdown is open), so long
// paths don't get truncated or clutter the option list.
function _updateJdkSelectTooltip(sel, customPath) {
  sel.title = sel.value === '__custom__' ? (customPath || '') : (sel.selectedOptions[0]?.title || sel.value);
}

function setJdkDropdown(prefix, inputId, value) {
  const sel = document.getElementById(`${prefix}-java-select`);
  const customRow = document.getElementById(`${prefix}-java-custom-row`);
  const input = document.getElementById(inputId);
  if (!sel) return;
  const v = value || 'java';
  const known = Array.from(sel.options).some(o => o.value === v);
  if (known) {
    sel.value = v;
    if (customRow) customRow.style.display = 'none';
  } else {
    sel.value = '__custom__';
    if (customRow) customRow.style.display = '';
  }
  if (input) input.value = v;
  _updateJdkSelectTooltip(sel, v);
}

function onJdkSelectChange(prefix, inputId) {
  const sel = document.getElementById(`${prefix}-java-select`);
  const customRow = document.getElementById(`${prefix}-java-custom-row`);
  const input = document.getElementById(inputId);
  if (!sel) return;
  const isCustom = sel.value === '__custom__';
  if (customRow) customRow.style.display = isCustom ? '' : 'none';
  if (isCustom) {
    if (input) input.focus();
  } else if (input) {
    input.value = sel.value;
  }
  _updateJdkSelectTooltip(sel, input?.value);
}

function validateRamAndStorage(ram, storageLimit) {
  const ramBytes = parseStorageLimit(ram);
  if (ramBytes !== null && systemInfo.totalRam !== null && ramBytes > systemInfo.totalRam) {
    return `RAM limit cannot exceed your system's total RAM (${formatBytes(systemInfo.totalRam)})`;
  }
  if (storageLimit) {
    const storageBytes = parseStorageLimit(storageLimit);
    if (storageBytes !== null && systemInfo.availableStorage !== null && storageBytes > systemInfo.availableStorage) {
      return `Storage limit cannot exceed available disk space (${formatBytes(systemInfo.availableStorage)})`;
    }
  }
  return null;
}

function parseStorageLimit(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|K|M|G|T)?$/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  const unit = ((m[2] || 'B').toUpperCase()).replace(/B$/, '');
  const mult = { '': 1, 'K': 1024, 'M': 1048576, 'G': 1073741824, 'T': 1099511627776 };
  return num * (mult[unit] ?? 1);
}

function openServerFolder() {
  if (currentServerId) window.mcpanel.openServerFolder(currentServerId);
}

function openRenameModal() {
  openServerSettingsModal();
}

async function confirmDeleteServer() {
  if (!currentServerId) return;
  const srv = config.servers.find(s => s.id === currentServerId);
  // A linked server's files live outside MCPanel's own folder - its original
  // folder (imported in place) or the location it was created/cloned into.
  const where = srv?.linked ? `\n\nThis server's folder is outside MCPanel's data folder and will be deleted:\n${srv.dir}` : '';
  const ok = await confirmDialog({
    title: 'Delete Server',
    message: `Permanently delete "${srv?.name || currentServerId}" and all its files?${where}\n\nThis action cannot be undone.`,
    confirmLabel: 'Delete Server',
  });
  if (ok) await executeDeleteServer();
}

// "Remove" only takes the server off MCPanel's list; its folder is kept.
async function confirmRemoveServer() {
  if (!currentServerId) return;
  const srv = config.servers.find(s => s.id === currentServerId);
  const ok = await confirmDialog({
    title: 'Remove Server',
    message: `Remove "${srv?.name || currentServerId}" from MCPanel?\n\nIts files are kept${srv?.dir ? ` at:\n${srv.dir}` : ''}\n\nYou can import it again later.`,
    confirmLabel: 'Remove',
  });
  if (ok) await executeDeleteServer({ keepFiles: true });
}

async function executeDeleteServer({ keepFiles = false } = {}) {
  if (!currentServerId) return;
  const r = await window.mcpanel.deleteServer(currentServerId, { keepFiles });
  if (r.error) { toast(r.error, 'error'); return; }
  config.servers = config.servers.filter(s => s.id !== currentServerId);
  currentServerId = null;
  renderServersGrid();
  renderSidebarServers();
  showPage('servers');
  toast(keepFiles ? 'Server removed - its files were kept' : 'Server deleted', 'info');
  if (r.warning) toast(r.warning, 'error');
}

async function openCreateServerModal() {
  const pre = document.getElementById('cs-prerelease');
  if (pre) pre.checked = false;
  const unstable = document.getElementById('cs-unstable');
  if (unstable) unstable.checked = false;
  setRamDropdown('cs', '2G');
  document.getElementById('cs-heap').value = '';
  updateHeapPlaceholder('cs');
  populateJdkSelect('cs', 'cs-java', 'java');
  document.getElementById('cs-dest').value = '';
  document.getElementById('cs-run').value = '';
  updateServerDestHint('cs');
  await loadProfilesForCreate();
  openModal('modal-create-server');
  onSoftwareChange();
}

// ─── Custom software ("custom" = start script / executable, "custom-java" = any .jar)
const CUSTOM_SOFTWARE = ['custom', 'custom-java'];
const isCustomSoftware = sw => CUSTOM_SOFTWARE.includes(sw);

// File types a custom server can use on the machine the CLI runs on (from
// `mcpanel system`), falling back to every type until that has loaded.
function _runFileTypes(software) {
  if (software === 'custom-java') return ['.jar'];
  return systemInfo?.runFileTypes?.[software] || ['.sh', '.command', '.bat', '.cmd', '.ps1', '.exe'];
}

function _runFileHint(software) {
  return `Supported: ${_runFileTypes(software).join(', ')}`;
}

// A start script launches its own java, so MCPanel's Java settings (path,
// arguments, heap) don't apply to "custom" servers. RAM stays: it is enforced
// as a memory limit on everything the script starts.
const _JAVA_FIELDS = {
  cs: ['cs-java-select', 'cs-java-args', 'cs-heap'],
  is: ['is-java', 'is-java-args'],
  ss: ['ss-java-select', 'ss-java-args'],
  quick: ['quick-java-args', 'quick-java-select'],
  tsett: ['tsett-heap', 'tsett-java-args', 'tsett-java-select'],
};
function _toggleJavaFields(prefix, software) {
  const hide = software === 'custom' || software === 'pumpkin';
  for (const id of _JAVA_FIELDS[prefix] || []) {
    document.getElementById(id)?.closest('.form-group, .setting-row')?.classList.toggle('hidden', hide);
  }
}

// Shows/hides a form's run-file field. prefix: cs (create), is (import), ss (settings).
function _showRunFileGroup(prefix, software) {
  _toggleJavaFields(prefix, software);
  const group = document.getElementById(`${prefix}-run-group`);
  if (!group) return;
  const custom = isCustomSoftware(software);
  group.classList.toggle('hidden', !custom);
  if (custom) document.getElementById(`${prefix}-run-hint`).textContent = _runFileHint(software);
}

// The run file goes through the CLI, which checks it exists and has the
// right type, and stores it relative to the server folder. false = failed.
async function _saveRunFile(prefix) {
  const cur = config.servers.find(s => s.id === currentServerId);
  if (!cur || !isCustomSoftware(cur.software)) return true;
  const runFile = document.getElementById(`${prefix}-run`).value.trim();
  if (runFile === (cur.runFile || '')) return true;
  let rr;
  try { rr = await window.mcpanel.setRunFile(currentServerId, runFile); }
  catch (e) { rr = { error: e.message }; }
  if (rr.error) { toast(rr.error, 'error'); return false; }
  cur.runFile = rr.server ? rr.server.runFile : (runFile || null);
  return true;
}

async function browseRunFile(prefix) {
  const software = (prefix === 'ss' || prefix === 'tsett')
    ? config.servers.find(s => s.id === currentServerId)?.software
    : document.getElementById(`${prefix}-software`).value;
  const p = await window.mcpanel.browseRunFile(software, _runFileTypes(software).map(e => e.slice(1)));
  if (p) document.getElementById(`${prefix}-run`).value = p;
}

// Import: offer the run files the folder scan found for the picked type.
function onImportSoftwareChange() {
  const software = document.getElementById('is-software').value;
  _showRunFileGroup('is', software);
  const list = document.getElementById('is-run-list');
  const input = document.getElementById('is-run');
  const scan = _importFolders.length === 1 ? (_importFolders[0].scan || {}) : {};
  const found = software === 'custom-java' ? (scan.jars || []) : software === 'custom' ? (scan.runFiles || []) : [];
  list.innerHTML = found.map(f => `<option value="${escHtml(f)}"></option>`).join('');
  input.value = found[0] || '';
}

async function onSoftwareChange() {
  const software = document.getElementById('cs-software').value;
  const versionSel = document.getElementById('cs-version');
  const spigotWarn = document.getElementById('cs-spigot-warning');
  spigotWarn.classList.toggle('hidden', software !== 'spigot');

  // Custom servers: no version list or build options, just a run file.
  const custom = isCustomSoftware(software);
  _showRunFileGroup('cs', software);
  document.getElementById('cs-version-group').classList.toggle('hidden', custom);
  document.getElementById('cs-build-opts').classList.toggle('hidden', custom);
  if (custom) {
    document.getElementById('cs-spigot-jdk-warning').classList.add('hidden');
    populateJdkSelect('cs', 'cs-java', document.getElementById('cs-java').value || 'java');
    filterProfilesForSoftware(software);
    return;
  }

  const preReleaseEl = document.getElementById('cs-prerelease');
  const preReleaseLbl = document.getElementById('lbl-prerelease');
  const supportsSnapshot = ['vanilla', 'fabric'].includes(software);
  if (preReleaseEl) {
    preReleaseEl.disabled = !supportsSnapshot;
    if (!supportsSnapshot) preReleaseEl.checked = false;
  }
  if (preReleaseLbl) preReleaseLbl.style.opacity = supportsSnapshot ? '' : '0.35';

  const unstableEl = document.getElementById('cs-unstable');
  const unstableLbl = document.getElementById('lbl-unstable');
  const supportsUnstable = ['paper', 'purpur', 'folia', 'leaf', 'velocity', 'pumpkin'].includes(software);
  if (unstableEl) {
    unstableEl.disabled = !supportsUnstable;
    if (!supportsUnstable) unstableEl.checked = false;
  }
  if (unstableLbl) unstableLbl.style.opacity = supportsUnstable ? '' : '0.35';

  const preRelease = preReleaseEl?.checked || false;
  const unstable = unstableEl?.checked || false;

  if (software !== 'spigot') {
    document.getElementById('cs-spigot-jdk-warning').classList.add('hidden');
  }

  versionSel.innerHTML = '<option>Loading...</option>';
  const cacheKey = `${software}_${preRelease}_${unstable}`;
  if (versionCache[cacheKey]) {
    populateVersions(versionCache[cacheKey]);
    filterProfilesForSoftware(software);
    await onVersionChange();
    return;
  }

  const r = await window.mcpanel.fetchVersions(software, preRelease, unstable);
  if (r.error) {
    versionSel.innerHTML = '<option>Failed to load</option>';
    toast('Failed to fetch versions: ' + r.error, 'error');
    return;
  }
  versionCache[cacheKey] = r.versions;
  populateVersions(r.versions);
  filterProfilesForSoftware(software);
  await onVersionChange();
}

// Re-checks the JDK picker whenever the version changes - Spigot's required
// Java range is per-version (e.g. 1.21.11 needs 21, 26.2 needs 25-26), so a
// JDK that was fine for one version may not be for another.
async function onVersionChange() {
  const software = document.getElementById('cs-software').value;
  const version = document.getElementById('cs-version').value;

  if (software === 'pumpkin') return;
  if (software !== 'spigot') {
    document.getElementById('cs-spigot-jdk-warning')?.classList.add('hidden');
    populateJdkSelect('cs', 'cs-java', document.getElementById('cs-java').value || 'java');
    return;
  }
  if (!version || version === 'Loading...' || version === 'Failed to load') return;
  await updateSpigotJdkPicker(version);
}

// Spigot-specific JDK picker: BuildTools enforces an exact compile-time Java
// range that also matches what the compiled server needs to run, so this
// shows real per-version compatibility instead of a generic "Auto-detect".
async function updateSpigotJdkPicker(version) {
  const sel = document.getElementById('cs-java-select');
  const warnEl = document.getElementById('cs-spigot-jdk-warning');
  if (!sel) return;

  sel.innerHTML = '<option value="java">Checking installed JDKs…</option>';

  let compat = null;
  try {
    compat = await window.mcpanel.getJdkCompatibility('spigot', version);
  } catch (e) {
    compat = null;
  }

  const jdks = compat?.jdks || [];
  const recommended = compat?.recommended || null;
  const rng = compat?.range;
  const reqText = rng ? `Java ${rng.min}${rng.max ? '–' + rng.max : '+'}` : 'an unknown Java version';

  sel.innerHTML = '';
  jdks.forEach(j => {
    const opt = document.createElement('option');
    opt.value = j.path;
    opt.disabled = !j.compatible;
    const recTag = j.path === recommended ? ' (recommended)' : '';
    opt.textContent = j.compatible
      ? `Java ${j.version} - ${j.path}${recTag}`
      : `Java ${j.version} - ${j.path}  (${j.reason})`;
    sel.appendChild(opt);
  });
  const custom = document.createElement('option');
  custom.value = '__custom__';
  custom.textContent = jdks.length ? 'Custom path…' : 'No JDKs detected - enter a path manually';
  sel.appendChild(custom);

  if (recommended) {
    setJdkDropdown('cs', 'cs-java', recommended);
  } else {
    sel.value = '__custom__';
    document.getElementById('cs-java-custom-row').style.display = '';
  }

  if (warnEl) {
    if (!recommended) {
      warnEl.textContent = `⚠ None of your installed JDKs support ${reqText} for Spigot ${version} - install one, or enter a path manually below.`;
      warnEl.classList.remove('hidden');
    } else {
      warnEl.classList.add('hidden');
    }
  }
}

function populateVersions(versions) {
  const sel = document.getElementById('cs-version');
  sel.innerHTML = '';
  versions.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = v;
    sel.appendChild(opt);
  });
}

function filterProfilesForSoftware(software) {
  const profileSel = document.getElementById('cs-profile');
  const version = document.getElementById('cs-version').value;
  const hint = document.getElementById('cs-profile-hint');
  
  profileSel.innerHTML = '<option value="">- No profile (plain server) -</option>';
  
  profiles.forEach(p => {
    const softwareOk = p.software.length === 0 || p.software.includes(software);
    const versionOk = p.versions.length === 0 || p.versions.includes(version);
    if (softwareOk && versionOk) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name + (p.description ? ` - ${p.description}` : '');
      profileSel.appendChild(opt);
    }
  });
  
  const compatible = profiles.filter(p => {
    return p.software.length === 0 || p.software.includes(software);
  });
  hint.textContent = compatible.length > 0 ? `${compatible.length} compatible profile(s) available` : '';
}

async function loadProfilesForCreate() {
  profiles = await window.mcpanel.getProfiles();
  filterProfilesForSoftware(document.getElementById('cs-software')?.value || 'paper');
}

async function createServer() {
  const name = document.getElementById('cs-name').value.trim();
  const software = document.getElementById('cs-software').value;
  const version = document.getElementById('cs-version').value;
  const port = parseInt(document.getElementById('cs-port').value) || 25565;
  const ram = getRamValue('cs');
  const storageLimit = document.getElementById('cs-storage').value.trim();
  const javaPath = document.getElementById('cs-java').value.trim() || 'java';
  const javaArgs = document.getElementById('cs-java-args').value.trim();
  const profileId = document.getElementById('cs-profile').value;

  if (!name) { toast('Please enter a server name', 'error'); return; }
  if (!ram) { toast('Please enter a custom RAM value (e.g. 3G, 2048M)', 'error'); return; }
  const heap = document.getElementById('cs-heap').value.trim();
  const heapErr = heapError(heap, ram);
  if (heapErr) { toast(heapErr, 'error'); return; }
  const custom = isCustomSoftware(software);
  const runFile = custom ? document.getElementById('cs-run').value.trim() : '';
  if (!custom && (!version || version === 'Loading...' || version === 'Failed to load')) {
    toast('Please select a version', 'error'); return;
  }
  if (storageLimit) {
    const bytes = parseStorageLimit(storageLimit);
    if (bytes === null) { toast('Invalid storage limit format (e.g. 10GB, 2048MB)', 'error'); return; }
    if (bytes < 500 * 1048576) { toast('Storage limit must be at least 500MB', 'error'); return; }
  }
  const deviceErr = validateRamAndStorage(ram, storageLimit);
  if (deviceErr) { toast(deviceErr, 'error'); return; }

  const btn = document.getElementById('cs-submit');
  btn.disabled = true; btn.textContent = 'Creating...';

  closeModal('modal-create-server');
  openModal('modal-download');

  const r = await window.mcpanel.createServer({
    name, software, version: custom ? null : version, runFile: runFile || null, port, ram,
    storageLimit: storageLimit || null,
    javaPath, javaArgs,
    profileId: profileId || null,
    unstableBuilds: document.getElementById('cs-unstable')?.checked || false,
    dest: document.getElementById('cs-dest').value.trim() || null,
    heap: heap || null,
  });

  closeModal('modal-download');
  btn.disabled = false;
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg> Create Server`;

  if (r.error) { toast('Error: ' + r.error, 'error'); return; }

  config.servers.push(r.server);
  renderServersGrid();
  renderSidebarServers();
  toast(`Server "${name}" created!`, 'success');
}

let currentProfileId = null;
let currentProfile = null;
let profileNavStack = [];
let profileNavPaths = [];
let profileCachedFileTree = null;
let selectedProfileFilePaths = new Set();

function _profileSubtitle(profile) {
  const sw = profile.software && profile.software.length ? profile.software.map(capitalise).join(', ') : 'Any Software';
  const ver = profile.versions && profile.versions.length ? profile.versions.join(', ') : 'Any Version';
  return `${sw} · ${ver}`;
}

function openProfileDetail(profileId) {
  const profile = profiles.find(p => p.id === profileId);
  if (!profile) return;
  window.mcpanel.logEvent(`Opened profile panel: ${profile.name} -id ${profileId}`);
  currentProfileId = profileId;
  currentProfile = profile;
  profileNavStack = [];
  profileNavPaths = [];
  profileCachedFileTree = null;
  selectedProfileFilePaths.clear();
  const _pPluginListEl = document.getElementById('profile-plugin-list');
  if (_pPluginListEl) _pPluginListEl.innerHTML = `<div class="plugin-state-msg">Search for plugins or mods to install them.</div>`;
  const _pPluginSearchEl = document.getElementById('profile-plugin-search');
  if (_pPluginSearchEl) _pPluginSearchEl.value = '';

  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.getElementById('page-profile-detail').classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  document.getElementById('pd-name').textContent = profile.name;
  document.getElementById('pd-subtitle').textContent = _profileSubtitle(profile);
  document.getElementById('pd-id').textContent = profile.id;
  document.getElementById('pd-created').textContent = profile.created
    ? new Date(profile.created).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : '-';

  _renderProfileSidebarTags();
  switchProfileTab('overview');
}

function _renderProfileSidebarTags() {
  const profile = currentProfile;
  const swEl = document.getElementById('pd-sw-tags');
  const verEl = document.getElementById('pd-ver-tags');
  const swList = profile.software && profile.software.length ? profile.software : [];
  const verList = profile.versions && profile.versions.length ? profile.versions : [];
  swEl.innerHTML = swList.length
    ? swList.map(s => `<span class="profile-tag">${escapeHtml(capitalise(s))}</span>`).join('')
    : `<span style="font-size:12px;color:var(--text-muted)">Any software</span>`;
  verEl.innerHTML = verList.length
    ? verList.map(v => `<span class="profile-tag">${escapeHtml(v)}</span>`).join('')
    : `<span style="font-size:12px;color:var(--text-muted)">Any version</span>`;
}

function switchProfileTab(name) {
  ['overview', 'files', 'plugins', 'settings'].forEach(t => {
    document.getElementById(`ptab-${t}`).classList.toggle('active', t === name);
    document.getElementById(`pane-profile-${t}`).classList.toggle('hidden', t !== name);
  });
  if (name === 'overview') openProfileOverviewTab();
  if (name === 'files') openProfileFileBrowser();
  if (name === 'settings') openProfileSettingsTab();
  if (name === 'plugins') openProfilePluginsTab();
}

function openProfileOverviewTab() {
  const using = (config.servers || []).filter(s => s.profileId === currentProfileId);
  const listEl = document.getElementById('pd-server-list');
  const descEl = document.getElementById('pd-description');

  if (using.length === 0) {
    listEl.innerHTML = `<div class="pd-server-empty">No servers are currently using this profile.</div>`;
  } else {
    listEl.innerHTML = using.map(srv => `
      <div class="pd-server-row">
        <div class="pd-server-info">
          <span class="pd-server-name">${escapeHtml(srv.name)}</span>
          <span class="pd-server-meta">${escapeHtml(serverTypeLabel(srv))}</span>
        </div>
        <button class="btn-xs" onclick="openServerDetail('${srv.id}')">Go to Server</button>
      </div>
    `).join('');
  }

  const desc = currentProfile.description || '';
  descEl.innerHTML = desc
    ? `<p class="pd-desc-text">${escapeHtml(desc)}</p>`
    : `<p class="pd-desc-text" style="color:var(--text-muted)">No description.</p>`;
}

function openProfileSettingsTab() {
  const profile = currentProfile;
  document.getElementById('ps-name').value = profile.name || '';
  document.getElementById('ps-desc').value = profile.description || '';
  document.getElementById('ps-versions').value = (profile.versions || []).join(', ');
  document.querySelectorAll('#ps-software-checks input[type=checkbox]').forEach(cb => {
    cb.checked = (profile.software || []).includes(cb.value);
  });
}

async function saveProfileSettings() {
  const name = document.getElementById('ps-name').value.trim();
  if (!name) { toast('Profile name is required', 'error'); return; }
  const description = document.getElementById('ps-desc').value.trim();
  const software = [...document.querySelectorAll('#ps-software-checks input:checked')].map(cb => cb.value);
  const versionsRaw = document.getElementById('ps-versions').value.trim();
  const versions = versionsRaw ? versionsRaw.split(',').map(v => v.trim()).filter(Boolean) : [];

  try {
    await window.mcpanel.updateProfile(currentProfileId, { name, description, software, versions });
    currentProfile = { ...currentProfile, name, description, software, versions };
    document.getElementById('pd-name').textContent = name;
    document.getElementById('pd-subtitle').textContent = _profileSubtitle(currentProfile);
    _renderProfileSidebarTags();
    profiles = profiles.map(p => p.id === currentProfileId ? currentProfile : p);
    toast('Profile updated', 'success');
    switchProfileTab('overview');
  } catch (e) {
    toast('Save failed: ' + e, 'error');
  }
}

async function deleteCurrentProfile() {
  const ok = await confirmDialog({
    title: 'Delete Profile',
    message: `Permanently delete the profile "${currentProfile.name}" and all its files?\n\nThis action cannot be undone.`,
    confirmLabel: 'Delete Profile',
  });
  if (!ok) return;
  const r = await window.mcpanel.deleteProfile(currentProfileId);
  if (r && r.error) { toast(r.error, 'error'); return; }
  profiles = profiles.filter(p => p.id !== currentProfileId);
  toast('Profile deleted', 'info');
  showPage('profiles');
}

async function openProfileFileBrowser() {
  if (!currentProfileId) return;
  const listEl = document.getElementById('profile-file-list');
  const savedPaths = [...profileNavPaths];
  if (!profileCachedFileTree) {
    listEl.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:12px">Loading…</div>`;
    const r = await window.mcpanel.getProfileFileTree(currentProfileId);
    if (r.error) {
      listEl.innerHTML = `<div style="padding:24px;color:var(--red);font-size:12px">${escapeHtml(r.error)}</div>`;
      return;
    }
    profileCachedFileTree = r.tree || [];
  }
  profileNavStack = [profileCachedFileTree];
  profileNavPaths = [];
  for (const seg of savedPaths) {
    const dir = profileNavStack[profileNavStack.length - 1].find(n => n.type === 'dir' && n.name === seg);
    if (dir) { profileNavStack.push(dir.children || []); profileNavPaths.push(seg); }
    else break;
  }
  renderProfileFileBrowser();
}

async function reloadProfileFileTree() {
  profileCachedFileTree = null;
  await openProfileFileBrowser();
}

function renderProfileFileBrowser() {
  const children = profileNavStack[profileNavStack.length - 1];
  const listEl = document.getElementById('profile-file-list');
  const bcEl = document.getElementById('profile-file-breadcrumb');

  const parts = [currentProfileId, ...profileNavPaths];
  bcEl.innerHTML = parts.map((seg, i) => {
    const isCurrent = i === parts.length - 1;
    return (i > 0 ? `<span class="file-bc-sep">/</span>` : '') +
      `<span class="file-bc-seg${isCurrent ? ' current' : ''}" data-depth="${i}">${escapeHtml(seg)}</span>`;
  }).join('');
  bcEl.querySelectorAll('[data-depth]').forEach(el => {
    const depth = parseInt(el.dataset.depth);
    if (depth < parts.length - 1) el.onclick = () => profileFileBrowserGoTo(depth);
  });

  listEl.innerHTML = '';
  const sorted = [...children].sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'dir' ? -1 : 1;
  });

  for (const node of sorted) {
    const nodePath = [...profileNavPaths, node.name].join('/');
    const row = document.createElement('div');
    row.className = `file-row${node.type === 'dir' ? ' is-dir' : ''}${selectedProfileFilePaths.has(nodePath) ? ' selected' : ''}`;
    row.innerHTML = `
      <input type="checkbox" class="file-row-check" ${selectedProfileFilePaths.has(nodePath) ? 'checked' : ''}>
      <div class="file-row-icon">${fileIcon(node.name, node.type)}</div>
      <span class="file-row-name">${escapeHtml(node.name)}</span>
      <span class="file-row-size">${node.type === 'dir' ? '' : formatBytes(node.size || 0)}</span>
      <div class="file-row-actions">
        <button class="file-action-btn rename-btn" title="Rename">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="file-action-btn delete-btn" title="Delete">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </div>`;

    row.querySelector('.file-row-check').addEventListener('change', e => {
      e.stopPropagation();
      if (e.target.checked) selectedProfileFilePaths.add(nodePath);
      else selectedProfileFilePaths.delete(nodePath);
      row.classList.toggle('selected', e.target.checked);
      _syncFileSelectAllCheckbox('profile-file-select-all', children, profileNavPaths, selectedProfileFilePaths);
      _syncFileSelActions('profile-file-sel-actions', 'profile-file-sel-count', selectedProfileFilePaths);
    });
    row.querySelector('.file-row-check').addEventListener('click', e => e.stopPropagation());
    row.querySelector('.rename-btn').addEventListener('click', e => { e.stopPropagation(); renameProfileFileEntry(nodePath, node.name); });
    row.querySelector('.delete-btn').addEventListener('click', e => {
      e.stopPropagation();
      deleteProfileFileEntry(nodePath, node.name, node.type === 'dir');
    });

    if (node.type === 'dir') {
      row.ondblclick = () => {
        profileNavStack.push(node.children || []);
        profileNavPaths.push(node.name);
        renderProfileFileBrowser();
      };
      row.dataset.dropDir = [...profileNavPaths, node.name].join('/');
      row.ondragover = e => { e.preventDefault(); e.stopPropagation(); row.classList.add('drop-target'); };
      row.ondragleave = () => row.classList.remove('drop-target');
      row.ondrop = e => {
        e.preventDefault(); e.stopPropagation();
        row.classList.remove('drop-target');
        _handleProfileDrop(e, [...profileNavPaths, node.name].join('/'));
      };
    } else {
      row.ondblclick = () => openFileEditor(nodePath, node.name, { type: 'profile', id: currentProfileId });
    }
    listEl.appendChild(row);
  }
  _syncFileSelectAllCheckbox('profile-file-select-all', children, profileNavPaths, selectedProfileFilePaths);
  _syncFileSelActions('profile-file-sel-actions', 'profile-file-sel-count', selectedProfileFilePaths);
}

function toggleSelectAllProfileFiles(checked) {
  const children = profileNavStack[profileNavStack.length - 1] || [];
  for (const node of children) {
    const nodePath = [...profileNavPaths, node.name].join('/');
    if (checked) selectedProfileFilePaths.add(nodePath);
    else selectedProfileFilePaths.delete(nodePath);
  }
  renderProfileFileBrowser();
}

function profileFileBrowserGoTo(depth) {
  while (profileNavStack.length > depth + 1) { profileNavStack.pop(); profileNavPaths.pop(); }
  renderProfileFileBrowser();
}

function _handleProfileDrop(e, destDir) {
  const paths = getDroppedPaths(e);
  if (paths.length) uploadProfileFilesFromPaths(paths, destDir);
  else uploadProfileFiles(e.dataTransfer.files, destDir);
}

function profileFilePanelDragOver(e) { e.preventDefault(); }
function profileFilePanelDrop(e) {
  e.preventDefault();
  _handleProfileDrop(e, profileNavPaths.join('/'));
}
function profileFileZoneDragOver(e) {
  e.preventDefault();
  document.getElementById('profile-file-drop-zone').classList.add('drop-active');
}
function profileFileZoneDragLeave(e) {
  document.getElementById('profile-file-drop-zone').classList.remove('drop-active');
}
function profileFileZoneDrop(e) {
  e.preventDefault();
  document.getElementById('profile-file-drop-zone').classList.remove('drop-active');
  _handleProfileDrop(e, profileNavPaths.join('/'));
}

function handleProfileFileInputChange(e) {
  uploadProfileFiles(e.target.files, profileNavPaths.join('/'));
  e.target.value = '';
}

async function uploadProfileFiles(fileList, dirPath) {
  if (!fileList || fileList.length === 0 || !currentProfileId) return;
  const files = Array.from(fileList);
  const total = files.length;
  const progressEl = document.getElementById('profile-file-upload-progress');
  const fillEl = document.getElementById('profile-file-upload-progress-fill');
  const textEl = document.getElementById('profile-file-upload-progress-text');
  const dropZone = document.getElementById('profile-file-drop-zone');
  progressEl.classList.remove('hidden');
  dropZone.style.pointerEvents = 'none';
  let done = 0, errors = 0;
  for (const file of files) {
    fillEl.style.width = `${Math.round((done / total) * 100)}%`;
    textEl.textContent = `Uploading ${file.name} (${done + 1}/${total})`;
    try {
      const buf = await file.arrayBuffer();
      const data = Array.from(new Uint8Array(buf));
      const rel = dirPath ? `${dirPath}/${file.name}` : file.name;
      await window.mcpanel.writeProfileFile(currentProfileId, rel, data);
      done++;
    } catch (e) {
      errors++;
      toast(`Failed to upload ${file.name}: ${e}`, 'error');
    }
  }
  fillEl.style.width = '100%';
  if (errors === 0) {
    textEl.textContent = `Done - ${done} file${done > 1 ? 's' : ''} uploaded`;
    toast(`Uploaded ${done} file${done > 1 ? 's' : ''}`, 'success');
  } else {
    textEl.textContent = `${done} uploaded, ${errors} failed`;
  }
  if (done > 0) {
    window.mcpanel.logEvent(`Uploaded ${done} item(s) to profile${dirPath ? ` (/${dirPath})` : ''} -id ${currentProfileId}`);
  }
  dropZone.style.pointerEvents = '';
  setTimeout(() => { progressEl.classList.add('hidden'); fillEl.style.width = '0%'; }, 3000);
  if (done > 0) { profileCachedFileTree = null; await openProfileFileBrowser(); }
}

async function uploadProfileFilesFromPaths(paths, destDir) {
  if (!paths.length || !currentProfileId) return;
  const progressEl = document.getElementById('profile-file-upload-progress');
  const fillEl = document.getElementById('profile-file-upload-progress-fill');
  const textEl = document.getElementById('profile-file-upload-progress-text');
  progressEl.classList.remove('hidden');
  textEl.textContent = `Copying ${paths.length} file${paths.length > 1 ? 's' : ''}…`;
  try {
    await window.mcpanel.uploadFilesToProfile(currentProfileId, paths, destDir);
    fillEl.style.width = '100%';
    textEl.textContent = `Done - ${paths.length} file${paths.length > 1 ? 's' : ''} copied`;
    toast(`Copied ${paths.length} file${paths.length > 1 ? 's' : ''}`, 'success');
  } catch (e) {
    toast('Upload failed: ' + e, 'error');
    fillEl.style.width = '0%';
  }
  setTimeout(() => { progressEl.classList.add('hidden'); fillEl.style.width = '0%'; }, 3000);
  profileCachedFileTree = null;
  await openProfileFileBrowser();
}

async function deleteProfileFileEntry(relPath, name, isDir) {
  const ok = await confirmDialog({
    title: isDir ? 'Delete Folder' : 'Delete File',
    message: isDir
      ? `Delete the folder "${name}" and all its contents?\n\nThis action cannot be undone.`
      : `Delete the file "${name}"?\n\nThis action cannot be undone.`,
  });
  if (!ok) return;
  try {
    await window.mcpanel.deleteProfileFile(currentProfileId, relPath);
    toast(`Deleted "${name}"`, 'info');
    profileCachedFileTree = null;
    await openProfileFileBrowser();
  } catch (e) { toast('Delete failed: ' + e, 'error'); }
}

async function deleteSelectedProfileFiles() {
  const count = selectedProfileFilePaths.size;
  if (!count) return;
  const ok = await confirmDialog({
    title: 'Delete Items',
    message: `Delete ${count} selected item${count !== 1 ? 's' : ''}?\n\nFolders are deleted with all their contents. This action cannot be undone.`,
    confirmLabel: `Delete ${count} Item${count !== 1 ? 's' : ''}`,
  });
  if (!ok) return;
  const paths = [...selectedProfileFilePaths];
  let failed = 0;
  for (const p of paths) {
    try { await window.mcpanel.deleteProfileFile(currentProfileId, p); }
    catch { failed++; }
  }
  selectedProfileFilePaths.clear();
  if (failed === 0) toast(`Deleted ${paths.length} item${paths.length !== 1 ? 's' : ''}`, 'info');
  else toast(`Deleted ${paths.length - failed}, failed ${failed}`, 'error');
  profileCachedFileTree = null;
  await openProfileFileBrowser();
}

function renameProfileFileEntry(relPath, name) {
  openFileInput('Rename', 'New name', name, async (newName) => {
    if (newName === name) return;
    const parts = relPath.split('/');
    parts[parts.length - 1] = newName;
    try {
      await window.mcpanel.renameProfileFile(currentProfileId, relPath, parts.join('/'));
      toast(`Renamed to "${newName}"`, 'success');
      profileCachedFileTree = null;
      await openProfileFileBrowser();
    } catch (e) { toast('Rename failed: ' + e, 'error'); }
  });
}

function createNewProfileFolder() {
  if (!currentProfileId) return;
  openFileInput('New Folder', 'Folder name', '', async (name) => {
    const relPath = profileNavPaths.length ? profileNavPaths.join('/') + '/' + name : name;
    try {
      await window.mcpanel.createProfileDir(currentProfileId, relPath);
      toast(`Folder "${name}" created`, 'success');
      profileCachedFileTree = null;
      await openProfileFileBrowser();
    } catch (e) { toast('Create failed: ' + e, 'error'); }
  });
}

function createNewProfileFile() {
  if (!currentProfileId) return;
  openFileInput('New File', 'File name', '', async (name) => {
    const relPath = profileNavPaths.length ? profileNavPaths.join('/') + '/' + name : name;
    try {
      await window.mcpanel.createProfileFile(currentProfileId, relPath);
      toast(`File "${name}" created`, 'success');
      profileCachedFileTree = null;
      await openProfileFileBrowser();
    } catch (e) { toast('Create failed: ' + e, 'error'); }
  });
}

function renderProfilesGrid() {
  window.mcpanel.getProfiles().then(p => {
    profiles = p;
    const query = (document.getElementById('profiles-search')?.value || '').trim().toLowerCase();
    const grid = document.getElementById('profiles-grid');
    const empty = document.getElementById('profiles-empty');
    grid.querySelectorAll('.server-card.profile-card, .grid-no-results').forEach(c => c.remove());
    if (p.length === 0) {
      if (empty) empty.classList.remove('hidden');
      return;
    }
    if (empty) empty.classList.add('hidden');
    const filtered = sortProfiles(query
      ? p.filter(pr =>
          pr.name.toLowerCase().includes(query) ||
          (pr.description || '').toLowerCase().includes(query) ||
          (pr.software || []).some(sw => sw.toLowerCase().includes(query))
        )
      : p);
    if (filtered.length === 0) {
      const msg = document.createElement('div');
      msg.className = 'grid-no-results';
      msg.textContent = `No profiles matching "${query}"`;
      grid.appendChild(msg);
      return;
    }
    filtered.forEach(profile => grid.appendChild(createProfileCard(profile)));
  });
}

function createProfileCard(profile) {
  const card = document.createElement('div');
  card.className = 'server-card profile-card';
  card.id = `pcard-${profile.id}`;

  const swList = profile.software || [];
  const verList = profile.versions || [];
  const usingCount = (config.servers || []).filter(s => s.profileId === profile.id).length;

  const swDisplay = swList.length === 0
    ? 'Any'
    : swList.length <= 2
      ? swList.map(capitalise).join(', ')
      : `${swList.slice(0, 2).map(capitalise).join(', ')} +${swList.length - 2}`;

  const verDisplay = verList.length === 0
    ? 'Any'
    : verList.length <= 2
      ? verList.join(', ')
      : `${verList.slice(0, 2).join(', ')} +${verList.length - 2}`;

  const sub = profile.description
    ? escapeHtml(profile.description)
    : '<span style="color:var(--text-muted)">No description</span>';

  card.innerHTML = `
    <div class="server-card-header">
      <div>
        <div class="server-card-name">${escapeHtml(profile.name)}</div>
        <div class="server-card-sub">${sub}</div>
      </div>
      <div class="profile-server-count">${usingCount} server${usingCount !== 1 ? 's' : ''}</div>
    </div>
    <div class="server-card-stats">
      <div class="stat-chip">
        <div class="stat-chip-label">Software</div>
        <div class="stat-chip-value">${escapeHtml(swDisplay)}</div>
      </div>
      <div class="stat-chip">
        <div class="stat-chip-label">Versions</div>
        <div class="stat-chip-value">${escapeHtml(verDisplay)}</div>
      </div>
      <div class="stat-chip">
        <div class="stat-chip-label">Used By</div>
        <div class="stat-chip-value">${usingCount} server${usingCount !== 1 ? 's' : ''}</div>
      </div>
      <div class="stat-chip">
        <div class="stat-chip-label">Created</div>
        <div class="stat-chip-value">${profile.created ? new Date(profile.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' }) : '-'}</div>
      </div>
    </div>
    <div class="server-card-footer">
      <button class="btn-ghost" style="font-size:12px;padding:6px 12px" onclick="openProfileDetail('${profile.id}')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        Manage
      </button>
    </div>
  `;
  return card;
}

async function deleteProfile(id) {
  const p = profiles.find(x => x.id === id);
  const ok = await confirmDialog({
    title: 'Delete Profile',
    message: `Permanently delete the profile "${p?.name || id}" and all its files?\n\nThis action cannot be undone.`,
    confirmLabel: 'Delete Profile',
  });
  if (!ok) return;
  const r = await window.mcpanel.deleteProfile(id);
  if (r.error) { toast(r.error, 'error'); return; }
  profiles = profiles.filter(p => p.id !== id);
  renderProfilesGrid();
  toast('Profile deleted', 'info');
}

function openCreateProfileModal() {
  document.getElementById('cp-name').value = '';
  document.getElementById('cp-desc').value = '';
  document.getElementById('cp-versions').value = '';
  document.querySelectorAll('#cp-software-checks input').forEach(cb => cb.checked = false);
  openModal('modal-create-profile');
}

async function createProfile() {
  const name = document.getElementById('cp-name').value.trim();
  if (!name) { toast('Please enter a profile name', 'error'); return; }
  const description = document.getElementById('cp-desc').value.trim();
  const software = Array.from(document.querySelectorAll('#cp-software-checks input:checked')).map(cb => cb.value);
  const versionsRaw = document.getElementById('cp-versions').value.trim();
  const versions = versionsRaw ? versionsRaw.split(',').map(v => v.trim()).filter(Boolean) : [];

  const r = await window.mcpanel.createProfile({ name, description, software, versions });
  if (r.error) { toast(r.error, 'error'); return; }
  profiles.push(r.profile);
  closeModal('modal-create-profile');
  renderProfilesGrid();
  toast(`Profile "${name}" created! Open the folder to add files.`, 'success');
  window.mcpanel.openProfileFolder(r.profile.id);
}

function openImportProfileModal() {
  document.getElementById('ip-folder-path').value = '';
  document.getElementById('ip-name').value = '';
  document.getElementById('ip-desc').value = '';
  document.getElementById('ip-versions').value = '';
  document.querySelectorAll('#ip-software-checks input').forEach(cb => cb.checked = false);
  openModal('modal-import-profile');
}

async function browseImportProfileFolder() {
  const folderPath = await window.mcpanel.browseFolder();
  if (!folderPath) return;
  document.getElementById('ip-folder-path').value = folderPath;
  const scan = await window.mcpanel.scanProfileFolder(folderPath);
  if (scan.name) document.getElementById('ip-name').value = scan.name;
  if (scan.description) document.getElementById('ip-desc').value = scan.description;
  if (scan.software && scan.software.length > 0) {
    document.querySelectorAll('#ip-software-checks input').forEach(cb => {
      cb.checked = scan.software.includes(cb.value);
    });
  }
  if (scan.versions && scan.versions.length > 0) {
    document.getElementById('ip-versions').value = scan.versions.join(', ');
  }
  if (!document.getElementById('ip-name').value) {
    document.getElementById('ip-name').value = folderPath.split(/[/\\]/).pop();
  }
}

async function importProfile() {
  const folderPath = document.getElementById('ip-folder-path').value.trim();
  const name = document.getElementById('ip-name').value.trim();
  if (!folderPath) { toast('Please select a folder', 'error'); return; }
  if (!name) { toast('Please enter a profile name', 'error'); return; }

  const description = document.getElementById('ip-desc').value.trim();
  const software = Array.from(document.querySelectorAll('#ip-software-checks input:checked')).map(cb => cb.value);
  const versionsRaw = document.getElementById('ip-versions').value.trim();
  const versions = versionsRaw ? versionsRaw.split(',').map(v => v.trim()).filter(Boolean) : [];

  const btn = document.getElementById('ip-submit');
  btn.disabled = true; btn.textContent = 'Importing...';

  const r = await window.mcpanel.importProfile({ folderPath, name, description, software, versions });
  btn.disabled = false; btn.textContent = 'Import Profile';

  if (r.error) { toast('Error: ' + r.error, 'error'); return; }
  profiles.push(r.profile);
  closeModal('modal-import-profile');
  renderProfilesGrid();
  toast(`Profile "${name}" imported!`, 'success');
}

// Each entry: { path, name, scan }. With one folder the Name/Software/Version/Port
// fields edit that server; with several, each row has its own name and the
// detected software/version/port are used per server.
let _importFolders = [];

function openImportServerModal() {
  _importFolders = [];
  document.getElementById('is-name').value = '';
  document.getElementById('is-version').value = '';
  document.getElementById('is-port').value = '25565';
  document.getElementById('is-software').value = 'paper';
  onImportSoftwareChange();
  setRamDropdown('is', '2G');
  document.getElementById('is-java').value = 'java';
  document.getElementById('is-java-args').value = '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200';
  const linkEl = document.getElementById('is-link');
  if (linkEl) linkEl.checked = false;
  renderImportFolders();
  openModal('modal-import-server');
}

function _importScanLabel(scan) {
  if (scan.isServer === false) return isCustomSoftware(scan.software) ? 'No server files found' : 'No server jar found';
  if (!scan.software) return 'Not detected';
  return `${capitalise(scan.software)}${scan.version ? ' ' + scan.version : ''}${scan.port ? ' · port ' + scan.port : ''}`;
}

// Fill the single-server fields from a folder's scan.
function _applyImportScan(entry) {
  const scan = entry.scan;
  document.getElementById('is-name').value = entry.name;
  if (scan.port) document.getElementById('is-port').value = scan.port;
  if (scan.software) document.getElementById('is-software').value = scan.software;
  // Always overwrite: a version left over from a previously picked folder
  // (e.g. a Minecraft version on a Velocity proxy) would be wrong.
  document.getElementById('is-version').value = scan.version || '';
  if (scan.ram) setRamDropdown('is', scan.ram);
  onImportSoftwareChange();
}

function renderImportFolders() {
  const multi = _importFolders.length > 1;
  document.querySelectorAll('#modal-import-server .is-single-only')
    .forEach(el => { el.style.display = multi ? 'none' : ''; });

  const list = document.getElementById('is-folder-list');
  list.innerHTML = _importFolders.length ? '' :
    '<div style="font-size:12px;color:var(--text-muted)">No folder selected</div>';
  _importFolders.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'input-row';
    row.innerHTML = `
      <div style="flex:1;min-width:0">
        <div style="font-family:var(--font-mono);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(f.path)}">${escHtml(f.path)}</div>
        <div style="font-size:11px;color:${f.scan.isServer === false ? 'var(--yellow)' : 'var(--text-muted)'}">${escHtml(_importScanLabel(f.scan))}</div>
      </div>
      ${multi ? `<input type="text" class="input" style="width:180px" placeholder="Server name" value="${escHtml(f.name)}">` : ''}
      <button class="btn-sm" title="Remove">✕</button>`;
    const nameEl = row.querySelector('input');
    if (nameEl) nameEl.oninput = () => { f.name = nameEl.value; };
    row.querySelector('button').onclick = () => removeImportFolder(i);
    list.appendChild(row);
  });
}

function removeImportFolder(i) {
  _importFolders.splice(i, 1);
  if (_importFolders.length === 1) _applyImportScan(_importFolders[0]);
  renderImportFolders();
}

async function browseImportServerFolder() {
  const paths = await window.mcpanel.browseFolders();
  if (!paths || !paths.length) return;
  // Keep the single-server name edit when switching to the multi-folder list.
  if (_importFolders.length === 1) {
    _importFolders[0].name = document.getElementById('is-name').value.trim() || _importFolders[0].name;
  }
  for (const folderPath of paths) {
    if (_importFolders.some(f => f.path === folderPath)) continue;
    const scan = await window.mcpanel.scanServerFolder(folderPath) || {};
    _importFolders.push({ path: folderPath, name: folderPath.split(/[/\\]/).pop(), scan });
  }
  if (_importFolders.length === 1) _applyImportScan(_importFolders[0]);
  renderImportFolders();
}

async function browseJavaImport() {
  const p = await window.mcpanel.browseJava();
  if (p) document.getElementById('is-java').value = p;
}

async function importServer() {
  if (!_importFolders.length) { toast('Please select a server folder', 'error'); return; }
  const multi = _importFolders.length > 1;

  // Shared settings.
  const ram = getRamValue('is');
  if (!ram) { toast('Please enter a custom RAM value (e.g. 3G, 2048M)', 'error'); return; }
  const deviceErr = validateRamAndStorage(ram, null);
  if (deviceErr) { toast(deviceErr, 'error'); return; }
  const javaPath = document.getElementById('is-java').value.trim() || 'java';
  const javaArgs = document.getElementById('is-java-args').value.trim();
  const link = !!document.getElementById('is-link')?.checked;

  // Per-server settings: from the form for one folder, from each scan for several.
  const jobs = _importFolders.map(f => multi ? {
    folderPath: f.path,
    name: f.name.trim(),
    software: f.scan.software || 'paper',
    // Custom: the CLI auto-detects the run file and labels the version.
    version: f.scan.version || (isCustomSoftware(f.scan.software) ? '' : 'Unknown'),
    port: parseInt(f.scan.port) || 25565,
  } : {
    folderPath: f.path,
    name: document.getElementById('is-name').value.trim(),
    software: document.getElementById('is-software').value,
    version: document.getElementById('is-version').value.trim()
      || (isCustomSoftware(document.getElementById('is-software').value) ? '' : 'Unknown'),
    runFile: isCustomSoftware(document.getElementById('is-software').value)
      ? document.getElementById('is-run').value.trim() : '',
    port: parseInt(document.getElementById('is-port').value) || 25565,
  });
  if (jobs.some(j => !j.name)) { toast(multi ? 'Please enter a name for every server' : 'Please enter a server name', 'error'); return; }
  const names = jobs.map(j => j.name.toLowerCase());
  if (new Set(names).size !== names.length) { toast('Each server needs a different name', 'error'); return; }

  const btn = document.getElementById('is-submit');
  btn.disabled = true; btn.textContent = 'Importing...';

  closeModal('modal-import-server');
  openModal('modal-download');

  const imported = [];
  const failed = [];
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    document.getElementById('modal-download-title').textContent =
      multi ? `Importing Server ${i + 1}/${jobs.length}` : 'Importing Server';
    const r = await window.mcpanel.importServer({ ...job, ram, javaPath, javaArgs, link });
    if (r.error) { failed.push(`${job.name}: ${r.error}`); continue; }
    config.servers.push(r.server);
    imported.push(job.name);
  }

  closeModal('modal-download');
  document.getElementById('modal-download-title').textContent = 'Creating Server';
  btn.disabled = false; btn.textContent = 'Import Server';

  if (imported.length) {
    renderServersGrid();
    renderSidebarServers();
  }
  for (const msg of failed) toast('Error: ' + msg, 'error');
  if (!imported.length) return;
  if (multi) {
    toast(`${imported.length} server${imported.length === 1 ? '' : 's'} ${link ? 'linked' : 'imported'}!`, 'success');
  } else {
    const name = imported[0];
    toast(link ? `Server "${name}" linked - MCPanel uses the original folder` : `Server "${name}" imported!`, 'success');
  }
}

function applyUpdateResult(result) {
  const statusEl = document.getElementById('update-status-text');
  const pillEl = document.getElementById('update-pill');
  if (result.hasUpdate) {
    if (statusEl) {
      statusEl.innerHTML = `MCPanel-WebUI: <span style="color:var(--yellow)">v${result.latest} available - </span><a href="#" style="color:var(--purple-300)" onclick="window.mcpanel.openExternal('${result.url}');return false">View release</a>`;
    }
    if (pillEl) pillEl.classList.remove('hidden');
    if (!_appSettings.autoUpdate) toast(`MCPanel-WebUI v${result.latest} is available on GitHub`, 'info');
  } else if (result.latest) {
    if (statusEl) statusEl.textContent = `MCPanel-WebUI: up to date (v${result.current})`;
  } else {
    if (statusEl) statusEl.textContent = `MCPanel-WebUI: could not reach GitHub (v${result.current} installed)`;
  }
}

async function checkForUpdates() {
  const statusEl = document.getElementById('update-status-text');
  if (statusEl) statusEl.textContent = 'Checking…';
  const result = await window.mcpanel.checkUpdate();
  applyUpdateResult(result);
}

function applyCliUpdateResult(result) {
  const statusEl = document.getElementById('cli-update-status-text');
  if (result.hasUpdate) {
    if (statusEl) {
      statusEl.innerHTML = `MCPanel-CLI: <span style="color:var(--yellow)">v${result.latest} available - </span><a href="#" style="color:var(--purple-300)" onclick="window.mcpanel.openExternal('${result.url}');return false">View on GitHub</a>`;
    }
    if (!_appSettings.autoUpdate) toast(`MCPanel-CLI v${result.latest} is available on GitHub`, 'info');
  } else if (result.latest) {
    if (statusEl) statusEl.textContent = `MCPanel-CLI: up to date (v${result.current})`;
  } else {
    if (statusEl) statusEl.textContent = result.current ? `MCPanel-CLI: could not reach GitHub (v${result.current} installed)` : 'MCPanel-CLI: could not check version';
  }
}

async function checkForCliUpdates() {
  const statusEl = document.getElementById('cli-update-status-text');
  if (statusEl) statusEl.textContent = 'Checking…';
  const result = await window.mcpanel.checkCliUpdate();
  applyCliUpdateResult(result);
}

// Settings → "Update WebUI" / "Update CLI": fetches the newest release and
// installs it on the host through `mcpanel api updateapp -p <product>`.
async function updateAppNow(product) {
  const btn = document.getElementById(`update-app-btn-${product}`);
  const statusEl = document.getElementById(product === 'cli' ? 'cli-update-status-text' : 'update-status-text');
  const name = product === 'cli' ? 'MCPanel-CLI' : 'MCPanel-WebUI';
  const label = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }
  if (statusEl) statusEl.textContent = `${name}: downloading and installing the latest release…`;
  try {
    const r = await window.mcpanel.updateApp(product);
    if (!r || r.error) {
      const msg = (r && r.error) || 'Update failed';
      if (statusEl) statusEl.textContent = `${name}: ${msg}`;
      toast(msg, 'error');
      return;
    }
    if (statusEl) statusEl.textContent = `${name}: ${r.message}`;
    if (r.updated) {
      promptRestart(r.message);
      if (product === 'cli') setTimeout(checkForCliUpdates, 4000);
    } else {
      toast(r.message, 'info');
    }
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (statusEl) statusEl.textContent = `${name}: ${msg}`;
    toast(msg, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = label; }
  }
}

// ─── Restart prompt ───────────────────────────────────────────────────────────
// After an update or an addon install / update / uninstall: a toast that stays
// until dismissed, with a button that restarts MCPanel-WebUI. Only one is shown -
// a newer reason replaces the text of the one already open.
let _restartToast = null;

function promptRestart(reason) {
  const msg = /restart/i.test(reason) ? reason : `${reason} - restart MCPanel-WebUI to apply it`;
  if (_restartToast && _restartToast.el.isConnected) {
    _restartToast.el.querySelector('.toast-msg').textContent = msg;
    return;
  }
  _restartToast = toast(msg, 'info', {
    duration: Infinity,
    buttons: [
      { label: 'Later', onClick: () => {} },
      {
        label: 'Restart MCPanel-WebUI',
        onClick: async (btn) => {
          btn.disabled = true;
          btn.label.textContent = 'Restarting…';
          try { await window.mcpanel.restartApp(); }
          catch (e) { toast(`Could not restart MCPanel-WebUI: ${(e && e.message) || e}`, 'error'); }
        },
      },
    ],
  });
}

// With auto-update on, the server installs WebUI / CLI updates itself
// (server/commands/core.js) and broadcasts `restart-required`. Fetching the
// pending state is admin-only, so other users never get a restart button.
async function showPendingRestart() {
  try {
    const p = await window.mcpanel.getRestartPending();
    if (p && p.reason) promptRestart(p.reason);
  } catch { /* not an admin */ }
}

let spigotDisabled = false;

function enableSpigotFunctionality() {
  spigotDisabled = false;
  const opt = document.getElementById('cs-opt-spigot');
  if (opt) { opt.disabled = false; opt.textContent = 'Spigot'; }
}

function disableSpigotFunctionality() {
  spigotDisabled = true;
  const opt = document.getElementById('cs-opt-spigot');
  if (opt) {
    opt.disabled = true;
    opt.textContent = 'Spigot (unavailable)';
  }
  const sel = document.getElementById('cs-software');
  if (sel && sel.value === 'spigot') {
    sel.value = 'paper';
    onSoftwareChange();
  }
}

function showBuildToolsMissingModal() {
  openModal('modal-buildtools-missing');
}

function ignoreBuildToolsMissing() {
  closeModal('modal-buildtools-missing');
  disableSpigotFunctionality();
  toast('Spigot support hidden - BuildTools could not be loaded', 'info');
}

// result: { version: "installed" | "none", path?, error?, helpUrl? }
function applyBuildToolsResult(result) {
  const statusEl = document.getElementById('buildtools-status-text');
  if (!result) {
    if (statusEl) statusEl.textContent = 'BuildTools: could not check status';
    return;
  }
  if (result.version === 'installed') {
    if (statusEl) statusEl.textContent = 'BuildTools: installed, operational';
    enableSpigotFunctionality();
  } else {
    if (statusEl) {
      statusEl.innerHTML = `BuildTools: <span style="color:var(--red)">unavailable - ${result.error || 'could not be downloaded'}</span>`;
    }
    disableSpigotFunctionality();
  }
}

async function checkBuildToolsVersion() {
  const statusEl = document.getElementById('buildtools-status-text');
  if (statusEl) statusEl.textContent = 'Checking…';
  try {
    const result = await window.mcpanel.getBuildToolsVersion();
    applyBuildToolsResult(result);
  } catch (e) {
    if (statusEl) statusEl.textContent = `BuildTools: ${e}`;
  }
}

async function updateBuildToolsNow() {
  const btn = document.getElementById('buildtools-update-btn');
  const statusEl = document.getElementById('buildtools-status-text');
  if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }
  if (statusEl) statusEl.textContent = 'Updating BuildTools…';
  try {
    const result = await window.mcpanel.updateBuildTools();
    applyBuildToolsResult(result);
    if (result && result.version === 'installed') toast('BuildTools is up to date', 'success');
  } catch (e) {
    if (statusEl) statusEl.textContent = `BuildTools: ${e}`;
    toast(String(e), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Update Now'; }
  }
}

async function detectJdk() {
  const list = document.getElementById('jdk-list');
  list.innerHTML = '<div style="color:var(--text-muted);font-size:12px">Scanning...</div>';
  const found = await window.mcpanel.detectJdk();
  list.innerHTML = '';
  if (found.length === 0) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:12px">No Java installations detected automatically.</div>';
    return;
  }
  found.forEach(jdk => {
    const item = document.createElement('div');
    item.className = 'jdk-item';
    item.innerHTML = `
      <span class="jdk-path">${escapeHtml(jdk.path)}</span>
      <span class="jdk-version">Java ${jdk.version}</span>
    `;
    list.appendChild(item);
  });
}

// ─── Server location (create / clone) ────────────────────────────────────────
// The chosen folder is a PARENT: the CLI gives the server its own subfolder in
// it, named after the server (mirrors _folder_name in mcpanel-cli's servers.py;
// a "-2" suffix is added there if that name is taken).
function serverFolderName(name) {
  return (name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/^\.+|\.+$/g, '').slice(0, 100);
}

function updateServerDestHint(prefix) {
  const hint = document.getElementById(`${prefix}-dest-hint`);
  if (!hint) return;
  const dest = document.getElementById(`${prefix}-dest`).value.trim();
  if (!dest) { hint.textContent = ''; return; }
  const sep = dest.includes('\\') && !dest.includes('/') ? '\\' : '/';
  const folder = serverFolderName(document.getElementById(`${prefix}-name`).value) || '<server id>';
  hint.textContent = `Server folder: ${dest.replace(/[\\/]+$/, '')}${sep}${folder}`;
}

async function browseServerDest(prefix) {
  const folder = await window.mcpanel.browseFolder();
  if (!folder) return;
  document.getElementById(`${prefix}-dest`).value = folder;
  updateServerDestHint(prefix);
}

// ─── Clone (Duplicate) Server ─────────────────────────────────────────────────
function openDuplicateServerModal() {
  if (!currentServerId) return;
  const srv = config.servers.find(s => s.id === currentServerId);
  if (!srv) return;
  document.getElementById('dup-name').value = `Copy of ${srv.name}`;
  document.getElementById('dup-dest').value = '';
  const keep = document.createElement('option');
  keep.value = '';
  keep.textContent = `Keep current (${srv.version || 'unknown'})`;
  document.getElementById('dup-version').replaceChildren(keep);
  document.getElementById('dup-version-warning').classList.add('hidden');
  updateServerDestHint('dup');
  closeModal('modal-server-settings');
  openModal('modal-duplicate-server');
  loadCloneVersions(srv);
}

// Fills the version picker after the modal is already open; if the list can't
// be fetched the clone still works with "Keep current".
async function loadCloneVersions(srv) {
  const cacheKey = `${srv.software}_false_false`;
  let versions = versionCache[cacheKey];
  if (!versions) {
    const r = await window.mcpanel.fetchVersions(srv.software, false, false);
    if (r.error || !Array.isArray(r.versions)) return;
    versions = versionCache[cacheKey] = r.versions;
  }
  if (currentServerId !== srv.id) return;
  const sel = document.getElementById('dup-version');
  for (const v of versions) {
    if (v === srv.version) continue;
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = v;
    sel.appendChild(opt);
  }
}

function onCloneVersionChange() {
  const srv = config.servers.find(s => s.id === currentServerId);
  const version = document.getElementById('dup-version').value;
  const warn = document.getElementById('dup-version-warning');
  warn.classList.toggle('hidden', !version);
  if (!version || !srv) return;
  const spigot = srv.software === 'spigot' ? ' Spigot is rebuilt with BuildTools, which takes a few minutes.' : '';
  warn.textContent = `The copy gets a fresh ${capitalise(srv.software || '')} ${version} jar; worlds, plugins and configs are copied as-is. ` +
    `Plugins/mods may need updating, and opening a world on an older version than it was saved with can corrupt it.${spigot}`;
}

async function executeDuplicateServer() {
  const newName = document.getElementById('dup-name').value.trim();
  if (!newName) { toast('Please enter a name', 'error'); return; }
  const version = document.getElementById('dup-version').value || null;
  const dest = document.getElementById('dup-dest').value.trim() || null;
  const btn = document.getElementById('dup-submit');
  btn.disabled = true; btn.textContent = 'Cloning…';
  closeModal('modal-duplicate-server');
  document.getElementById('modal-download-title').textContent = 'Cloning Server';
  openModal('modal-download');
  const r = await window.mcpanel.duplicateServer(currentServerId, newName, { version, dest });
  closeModal('modal-download');
  document.getElementById('modal-download-title').textContent = 'Creating Server';
  btn.disabled = false; btn.textContent = 'Clone';
  if (r.error) { toast('Error: ' + r.error, 'error'); return; }
  config.servers.push(r.server);
  renderServersGrid();
  renderSidebarServers();
  toast(`Server "${newName}" cloned!`, 'success');
}

const FTREE_SELECTED_DEFAULTS = new Set(['mods', 'plugins']);

async function openCreateProfileFromServerModal() {
  if (!currentServerId) return;
  const srv = config.servers.find(s => s.id === currentServerId);
  if (!srv) return;
  document.getElementById('pfs-name').value = srv.name + ' Profile';
  document.getElementById('pfs-desc').value = '';
  document.getElementById('pfs-versions').value = '';
  document.querySelectorAll('#pfs-software-checks input').forEach(cb => cb.checked = false);
  document.getElementById('pfs-submit').disabled = false;
  document.getElementById('pfs-submit').textContent = 'Create Profile';
  closeModal('modal-server-settings');
  openModal('modal-profile-from-server');
  const ftreeEl = document.getElementById('pfs-ftree');
  ftreeEl.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:12px">Loading files…</div>`;
  const r = await window.mcpanel.getServerFileTree(currentServerId);
  ftreeEl.innerHTML = '';
  if (r.error) {
    ftreeEl.innerHTML = `<div style="padding:24px;color:var(--red);font-size:12px">${escapeHtml(r.error)}</div>`;
    return;
  }
  if (!r.tree || r.tree.length === 0) {
    ftreeEl.innerHTML = `<div style="padding:24px;color:var(--text-muted);font-size:12px">No files found.</div>`;
    return;
  }
  r.tree.forEach(node => ftreeEl.appendChild(buildFtreeNode(node, 0, false)));
}

function buildFtreeNode(node, depth, parentSelected) {
  const selected = parentSelected || FTREE_SELECTED_DEFAULTS.has(node.name);
  const wrap = document.createElement('div');

  if (node.type === 'dir') {
    const row = document.createElement('div');
    row.className = 'ftree-item';
    row.style.paddingLeft = `${depth * 16 + 6}px`;

    const toggle = document.createElement('button');
    toggle.className = 'ftree-toggle';
    toggle.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>`;

    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'ftree-check';
    cb.dataset.path = node.path; cb.dataset.ftype = 'dir';
    cb.checked = selected;

    const icon = document.createElement('span');
    icon.className = 'ftree-icon';
    icon.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;

    const label = document.createElement('span');
    label.className = 'ftree-name dir';
    label.textContent = node.name;

    row.append(toggle, cb, icon, label);

    const children = document.createElement('div');
    children.className = 'ftree-children';
    children.style.display = 'none';
    node.children.forEach(child => children.appendChild(buildFtreeNode(child, depth + 1, selected)));

    toggle.onclick = () => {
      const collapsed = children.style.display === 'none';
      children.style.display = collapsed ? '' : 'none';
      toggle.style.transform = collapsed ? 'rotate(90deg)' : '';
    };

    cb.onchange = () => {
      children.querySelectorAll('.ftree-check').forEach(c => { c.checked = cb.checked; c.indeterminate = false; });
    };
    children.addEventListener('change', () => ftreeSyncParent(cb, children));

    wrap.append(row, children);
  } else {
    const row = document.createElement('div');
    row.className = 'ftree-item';
    row.style.paddingLeft = `${depth * 16 + 22}px`;

    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'ftree-check';
    cb.dataset.path = node.path; cb.dataset.ftype = 'file';
    cb.checked = selected;

    const icon = document.createElement('span');
    icon.className = 'ftree-icon';
    icon.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

    const label = document.createElement('span');
    label.className = 'ftree-name';
    label.textContent = node.name;

    const size = document.createElement('span');
    size.className = 'ftree-size';
    size.textContent = formatBytes(node.size);

    row.append(cb, icon, label, size);
    wrap.appendChild(row);
  }
  return wrap;
}

function ftreeSyncParent(parentCb, childrenEl) {
  const all = Array.from(childrenEl.querySelectorAll(':scope > div > .ftree-item > .ftree-check'));
  if (!all.length) return;
  const checked = all.filter(c => c.checked && !c.indeterminate).length;
  const indeterminate = all.some(c => c.indeterminate) || (checked > 0 && checked < all.length);
  parentCb.indeterminate = indeterminate;
  parentCb.checked = indeterminate ? true : checked === all.length;
}

function ftreeSelectAll() {
  document.querySelectorAll('#pfs-ftree .ftree-check').forEach(cb => { cb.checked = true; cb.indeterminate = false; });
}

function ftreeSelectNone() {
  document.querySelectorAll('#pfs-ftree .ftree-check').forEach(cb => { cb.checked = false; cb.indeterminate = false; });
}

async function submitCreateProfileFromServer() {
  const name = document.getElementById('pfs-name').value.trim();
  if (!name) { toast('Please enter a profile name', 'error'); return; }
  const selectedPaths = Array.from(document.querySelectorAll('#pfs-ftree .ftree-check[data-ftype="file"]:checked'))
    .map(cb => cb.dataset.path);
  if (selectedPaths.length === 0) { toast('Select at least one file', 'error'); return; }
  const btn = document.getElementById('pfs-submit');
  btn.disabled = true; btn.textContent = 'Creating…';
  const software = Array.from(document.querySelectorAll('#pfs-software-checks input:checked')).map(cb => cb.value);
  const versionsRaw = document.getElementById('pfs-versions').value.trim();
  const versions = versionsRaw ? versionsRaw.split(',').map(v => v.trim()).filter(Boolean) : [];
  const r = await window.mcpanel.createProfileFromServer(
    currentServerId,
    { name, description: document.getElementById('pfs-desc').value.trim(), software, versions },
    selectedPaths
  );
  btn.disabled = false; btn.textContent = 'Create Profile';
  if (r.error) { toast('Error: ' + r.error, 'error'); return; }
  profiles.push(r.profile);
  closeModal('modal-profile-from-server');
  toast(`Profile "${name}" created!`, 'success');
}

function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// Only when the press also started on the overlay: drag-selecting text inside
// a modal and releasing outside it fires a click on the overlay too.
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  let pressedOnOverlay = false;
  overlay.addEventListener('mousedown', e => { pressedOnOverlay = e.target === overlay; });
  overlay.addEventListener('click', e => {
    if (e.target === overlay && pressedOnOverlay) {
      const id = overlay.id;
      if (id === 'modal-confirm') { resolveConfirmDialog(false); return; }
      if (id === 'modal-external-link') { resolveExternalLink(false); return; }
      if (id === 'modal-mclogs') { resolveMclogsNotice(false); return; }
      if (id === 'modal-plugin-disclaimer') { resolvePluginDisclaimer(false); return; }
      if (id !== 'modal-download' && id !== 'modal-cli-missing' && id !== 'modal-buildtools-missing') closeModal(id);
    }
  });
});

// ─── External link confirmation ──────────────────────────────────────────────
// Every link in the app (addons included) goes through
// window.mcpanel.openExternal, so wrapping it here puts a "you're leaving
// MCPanel" modal in front of all of them. The modal stacks over any modal
// that's already open instead of replacing it. _openExternalDirect skips the
// prompt - only for buttons that already say "Open in browser".
const _openExternalDirect = window.mcpanel.openExternal;
let _externalLinkPending = null;   // { url, resolve }
const EXTERNAL_LINK_SKIP_KEY = 'mcpanel-external-link-skip-notice';

function _externalLinkNoticeSkipped() {
  try { return localStorage.getItem(EXTERNAL_LINK_SKIP_KEY) === '1'; } catch { return false; }
}

function confirmExternalLink(url) {
  if (_externalLinkNoticeSkipped()) {
    _openExternalDirect(url);
    return Promise.resolve(true);
  }
  if (_externalLinkPending) resolveExternalLink(false);
  document.getElementById('external-link-url').textContent = String(url);
  document.getElementById('external-link-skip').checked = false;
  openModal('modal-external-link');
  return new Promise(resolve => { _externalLinkPending = { url, resolve }; });
}

function resolveExternalLink(ok) {
  closeModal('modal-external-link');
  const pending = _externalLinkPending;
  _externalLinkPending = null;
  if (!pending) return;
  if (ok) {
    if (document.getElementById('external-link-skip').checked) {
      try { localStorage.setItem(EXTERNAL_LINK_SKIP_KEY, '1'); } catch {}
    }
    _openExternalDirect(pending.url);
  }
  pending.resolve(ok);
}

async function copyExternalLinkUrl() {
  const url = document.getElementById('external-link-url').textContent;
  try { await navigator.clipboard.writeText(url); toast('Link copied', 'success'); }
  catch { toast('Could not copy the link', 'error'); }
}

window.mcpanel.openExternal = (url) => confirmExternalLink(url);

// Escape closes only this top-most modal, not the one underneath it.
window.addEventListener('keydown', e => {
  if (_externalLinkPending && e.key === 'Escape') {
    e.stopImmediatePropagation();
    resolveExternalLink(false);
  }
}, true);

// ─── Confirm dialog ───────────────────────────────────────────────────────────
// Every destructive action goes through this instead of window.confirm(), so
// deletions look like the rest of the app. Returns a promise resolving to
// true only when the user hits the confirm button.
let _confirmResolve = null;

function confirmDialog({ title = 'Confirm', message = '', confirmLabel = 'Delete',
                         cancelLabel = 'Cancel', danger = true } = {}) {
  // A second dialog while one is open would orphan the first promise.
  if (_confirmResolve) resolveConfirmDialog(false);
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  const okBtn = document.getElementById('confirm-ok');
  okBtn.textContent = confirmLabel;
  okBtn.className = danger ? 'btn-danger' : 'btn-primary';
  document.getElementById('confirm-cancel').textContent = cancelLabel;
  openModal('modal-confirm');
  return new Promise(resolve => { _confirmResolve = resolve; });
}

function resolveConfirmDialog(ok) {
  closeModal('modal-confirm');
  const resolve = _confirmResolve;
  _confirmResolve = null;
  if (resolve) resolve(ok);
}

// Escape cancels. Enter is deliberately not bound: key auto-repeat from
// whatever opened the dialog could confirm a delete the user never read.
document.addEventListener('keydown', e => {
  if (_confirmResolve && e.key === 'Escape') resolveConfirmDialog(false);
});

// toast(msg, type, { buttons, duration })
//   buttons: [{ label, icon, onClick }] - only rendered when given. `icon` is
//   trusted SVG markup shown after the label. A click runs onClick(btn) and
//   closes the toast, unless onClick returns false (e.g. to relabel the button
//   to "Copied" and stay open - set btn.label.textContent for that).
//   duration: ms before it fades out (Infinity: stays until a button closes
//   it); toasts with buttons default to 10s and don't fade while hovered, so
//   there's time to reach a button.
// Returns { el, close }.
function toast(msg, type = 'info', opts = {}) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const buttons = Array.isArray(opts.buttons) ? opts.buttons : [];
  const duration = opts.duration ?? (buttons.length ? 10000 : 3500);

  let closed = false, timer = null;
  const close = () => {
    if (closed) return;
    closed = true; clearTimeout(timer);
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0'; el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 300);
  };
  const arm = () => {
    clearTimeout(timer);
    if (Number.isFinite(duration)) timer = setTimeout(close, duration);
  };

  if (buttons.length) {
    const text = document.createElement('div');
    text.className = 'toast-msg';
    text.textContent = msg;
    const row = document.createElement('div');
    row.className = 'toast-actions';
    buttons.forEach(b => {
      const btn = document.createElement('button');
      btn.className = 'toast-btn';
      btn.label = document.createElement('span');
      btn.label.textContent = b.label;
      btn.appendChild(btn.label);
      if (b.icon) btn.insertAdjacentHTML('beforeend', b.icon);
      btn.onclick = async () => {
        let keepOpen = false;
        try { keepOpen = (await b.onClick?.(btn)) === false; }
        catch (e) { console.error('toast button failed', e); }
        if (!keepOpen) close();
      };
      row.appendChild(btn);
    });
    el.append(text, row);
  } else {
    el.textContent = msg;
  }
  // Hovering pauses the hide timer so the message can be read or selected/copied
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => { if (!closed) arm(); });
  container.appendChild(el);
  arm();
  return { el, close };
}

function capitalise(s) {
  if (s === 'custom-java') return 'Custom';
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// ─── Context menu ─────────────────────────────────────────────────────────────
// showContextMenu(event, items, { title }) replaces the browser's right-click
// menu. items: [{ label, icon, onClick, danger, disabled }] - a falsy entry is skipped
// and the string 'sep' draws a divider. `icon` is trusted SVG markup; `title`
// is plain text shown as the menu's heading, with `titleImage` (a URL) beside it.
let _ctxMenuEl = null;
let _ctxMenuOnClose = null;

function closeContextMenu() {
  if (!_ctxMenuEl || _ctxMenuEl.classList.contains('hidden')) return;
  _ctxMenuEl.classList.add('hidden');
  const cb = _ctxMenuOnClose;
  _ctxMenuOnClose = null;
  if (cb) cb();
}

function showContextMenu(e, items, { title, titleImage, onClose } = {}) {
  e.preventDefault();
  e.stopPropagation();
  closeContextMenu();
  if (!_ctxMenuEl) {
    _ctxMenuEl = document.createElement('div');
    _ctxMenuEl.className = 'ctx-menu hidden';
    _ctxMenuEl.setAttribute('role', 'menu');
    document.body.appendChild(_ctxMenuEl);
    document.addEventListener('mousedown', ev => { if (!_ctxMenuEl.contains(ev.target)) closeContextMenu(); }, true);
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeContextMenu(); });
    window.addEventListener('blur', closeContextMenu);
    window.addEventListener('resize', closeContextMenu);
    document.addEventListener('scroll', closeContextMenu, true);
  }
  _ctxMenuEl.innerHTML = '';
  if (title) {
    const head = Object.assign(document.createElement('div'),
      { className: 'ctx-menu-title', textContent: title, title });
    if (titleImage) {
      const img = Object.assign(document.createElement('img'), { className: 'ctx-menu-title-img', src: titleImage, alt: '' });
      img.onerror = () => img.remove();
      head.prepend(img);
      head.classList.add('has-img');
    }
    _ctxMenuEl.appendChild(head);
  }
  for (const item of items) {
    if (!item) continue;
    if (item === 'sep') {
      _ctxMenuEl.appendChild(Object.assign(document.createElement('div'), { className: 'ctx-menu-sep' }));
      continue;
    }
    const btn = document.createElement('button');
    btn.className = `ctx-menu-item${item.danger ? ' danger' : ''}`;
    btn.setAttribute('role', 'menuitem');
    btn.disabled = !!item.disabled;
    btn.innerHTML = `<span class="ctx-menu-icon">${item.icon || ''}</span><span>${escapeHtml(item.label)}</span>`;
    btn.onclick = () => { closeContextMenu(); item.onClick(); };
    _ctxMenuEl.appendChild(btn);
  }
  _ctxMenuOnClose = onClose || null;
  _ctxMenuEl.classList.remove('hidden');
  // Keep it on screen: open up/left of the cursor near the right/bottom edge.
  const { offsetWidth: w, offsetHeight: h } = _ctxMenuEl;
  const x = e.clientX + w > window.innerWidth - 4 ? Math.max(4, e.clientX - w) : e.clientX;
  const y = e.clientY + h > window.innerHeight - 4 ? Math.max(4, e.clientY - h) : e.clientY;
  _ctxMenuEl.style.left = `${x}px`;
  _ctxMenuEl.style.top = `${y}px`;
  _ctxMenuEl.querySelector('.ctx-menu-item:not(:disabled)')?.focus({ preventScroll: true });
}

// navigator.clipboard only exists in a secure context - the WebUI opened over
// plain http from another device isn't one - so fall back to execCommand.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* fall through */ }
    ta.remove();
    return ok;
  }
}

const CTX_ICON = {
  rename: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  move: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6M9 14l3 3 3-3"/></svg>',
  newFile: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="15" x2="12" y2="9"/><line x1="9" y1="12" x2="15" y2="12"/></svg>',
  newFolder: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  copy: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  download: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  delete: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>',
};

// Right-click menu for a row in a server's file browser. Right-clicking a row
// that is part of a multi-selection acts on the whole selection.
function openFileContextMenu(e, row, nodePath, node) {
  const srv = config.servers.find(s => s.id === currentServerId);
  // Copied paths start at the server's folder name, e.g. "Survival/plugins/x.yml".
  const folder = (srv?.dir || currentServerId).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const multi = selectedFilePaths.size > 1 && selectedFilePaths.has(nodePath);
  const targets = multi ? [...selectedFilePaths] : [nodePath];
  const isDir = node.type === 'dir';

  const copyPaths = async () => {
    const ok = await copyText(targets.map(p => `${folder}/${p}`).join('\n'));
    toast(ok ? (multi ? `${targets.length} paths copied` : 'Path copied') : 'Could not copy the path', ok ? 'success' : 'error');
  };
  // Only the WebUI can hand a file to the browser; the desktop app has the
  // toolbar's export instead.
  const canDownload = !!window.mcpanel.downloadServerPath;
  const download = () => targets.forEach(p => window.mcpanel.downloadServerPath(currentServerId, p));

  if (multi) row.parentElement.querySelectorAll('.file-row.selected').forEach(r => r.classList.add('ctx-active'));
  else row.classList.add('ctx-active');
  showContextMenu(e, [
    { label: 'Rename', icon: CTX_ICON.rename, disabled: multi, onClick: () => renameFileEntry(nodePath, node.name) },
    { label: multi ? `Move ${targets.length} items…` : 'Move…', icon: CTX_ICON.move,
      onClick: () => openFileMoveModal('server', multi ? null : [nodePath]) },
    { label: multi ? 'Copy paths' : 'Copy path', icon: CTX_ICON.copy, onClick: copyPaths },
    canDownload && {
      label: multi ? `Download ${targets.length} items` : (isDir ? 'Download as .zip' : 'Download'),
      icon: CTX_ICON.download, onClick: download,
    },
    'sep',
    multi
      ? { label: `Delete ${targets.length} items`, icon: CTX_ICON.delete, danger: true, onClick: () => deleteSelectedFiles() }
      : { label: 'Delete', icon: CTX_ICON.delete, danger: true, onClick: () => deleteFileEntry(nodePath, node.name, isDir) },
  ], {
    title: multi ? `${targets.length} Selected` : node.name,
    onClose: () => document.querySelectorAll('.file-row.ctx-active').forEach(r => r.classList.remove('ctx-active')),
  });
}

// The "Feels empty in here" + button: New File / New Folder in a menu that
// opens below the button itself (the toolbar's menu is pinned to the toolbar).
function openEmptyFolderNewMenu(btn) {
  const r = btn.getBoundingClientRect();
  const at = { clientX: r.left, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} };
  showContextMenu(at, [
    { label: 'New File', icon: CTX_ICON.newFile, onClick: () => fileNewMenuPick('server', 'file') },
    { label: 'New Folder', icon: CTX_ICON.newFolder, onClick: () => fileNewMenuPick('server', 'folder') },
  ]);
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function stripCpuName(full) {
  if (!full || full === 'Unknown CPU') return full;
  return full
    .replace(/\(R\)/g, '').replace(/\(TM\)/g, '')
    .replace(/\bCPU\b\s*/g, '')                      // drop bare "CPU" word, keep clock speed
    .replace(/\s+\d+-Core\s+Processor.*/i, '')
    .replace(/\s+\d+-Core.*/i, '')
    .replace(/\s+Processor\b.*/i, '')
    .replace(/\s+/g, ' ').trim();
}

function formatBytes(bytes) {
  if (bytes === 0) return '0B';
  const k = 1024;
  const sizes = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + sizes[i];
}

let installedThemes = [];

const BUILTIN_THEMES = ['purple-dark', 'clean-dark', 'dark-slate', 'bright-slate'];

async function ensureBuiltinThemes() {
  await window.mcpanel.ensureBuiltinThemes();
}

async function loadAndApplyTheme(id) {
  const styleEl = document.getElementById('theme-override');
  if (!id) {
    styleEl.textContent = '';
    return;
  }
  const css = await window.mcpanel.getThemeCss(id);
  styleEl.textContent = css || '';
}

async function applyTheme(id) {
  await loadAndApplyTheme(id);
  config.activeTheme = id;
  await window.mcpanel.saveConfig(config);
  const defaultId = await window.mcpanel.getDefaultTheme();
  const theme = installedThemes.find(t => t.id === id);
  document.getElementById('active-theme-name').textContent = theme ? theme.name : id;
  document.getElementById('reset-theme-btn').style.display = id !== defaultId ? '' : 'none';
  renderInstalledThemes();
  // A theme may hint an icon via --app-icon; re-resolve on theme change.
  applyAppIcon();
  window.mcpanel.logEvent(`Applied theme: ${theme?.name || id}`);
  toast(`Theme "${theme?.name || id}" applied`, 'success');
}

async function resetTheme() {
  const defaultId = await window.mcpanel.getDefaultTheme();
  await loadAndApplyTheme(defaultId);
  config.activeTheme = defaultId;
  await window.mcpanel.saveConfig(config);
  const themes = await window.mcpanel.getThemes();
  const theme = themes.find(t => t.id === defaultId);
  document.getElementById('active-theme-name').textContent = theme ? theme.name : defaultId;
  document.getElementById('reset-theme-btn').style.display = 'none';
  renderInstalledThemes();
  applyAppIcon();
  toast('Theme reset to default', 'info');
}

async function renderInstalledThemes() {
  installedThemes = await window.mcpanel.getThemes();
  const container = document.getElementById('installed-themes-list');
  if (!container) return;
  container.innerHTML = '';

  if (installedThemes.length === 0) {
    container.innerHTML = `<div style="font-size:12px;color:var(--text-muted);padding:8px 0">No themes installed. Browse online or import a ZIP.</div>`;
    return;
  }

  installedThemes.forEach(theme => {
    const isActive = config.activeTheme === theme.id;
    const item = document.createElement('div');
    item.className = `installed-theme-item${isActive ? ' active-theme' : ''}`;

    const creatorHtml = theme.creatorUrl
      ? `<a href="#" onclick="window.mcpanel.openExternal('${escapeHtml(theme.creatorUrl)}');return false" style="color:var(--accent)">${escapeHtml(theme.creator || 'Unknown')}</a>`
      : escapeHtml(theme.creator || 'Unknown');

    item.innerHTML = `
      <div class="theme-item-info">
        <div class="theme-item-name">${escapeHtml(theme.name)}${isActive ? ' <span style="font-size:10px;color:var(--accent);font-weight:400">(active)</span>' : ''}</div>
        <div class="theme-item-meta">by ${creatorHtml} · v${escapeHtml(theme.version || '?')} · for MCPanel ${escapeHtml(theme.appVersion || '?')}</div>
        ${theme.description ? `<div class="theme-item-meta" style="margin-top:2px">${escapeHtml(theme.description)}</div>` : ''}
      </div>
      <div class="theme-item-actions">
        ${!isActive ? `<button class="btn-xs" style="color:var(--accent);border-color:rgba(168,85,247,0.3)" onclick="applyTheme('${theme.id}')">Apply</button>` : ''}
        ${!theme.builtin ? `<button class="btn-xs" style="color:var(--red);border-color:rgba(239,68,68,0.25)" onclick="confirmDeleteTheme('${theme.id}')">Delete</button>` : ''}
      </div>
    `;
    container.appendChild(item);
  });
}

async function confirmDeleteTheme(id) {
  const theme = installedThemes.find(t => t.id === id);
  const ok = await confirmDialog({
    title: 'Delete Theme',
    message: `Delete the theme "${theme?.name || id}"?\n\nThis action cannot be undone.`,
    confirmLabel: 'Delete Theme',
  });
  if (!ok) return;
  const r = await window.mcpanel.deleteTheme(id);
  if (r.error) { toast('Error: ' + r.error, 'error'); return; }
  if (config.activeTheme === id) await resetTheme();
  await renderInstalledThemes();
  toast('Theme deleted', 'info');
}

async function importThemeFromFile() {
  const filePath = await window.mcpanel.browseThemeFile();
  if (!filePath) return;
  toast('Installing theme…', 'info');
  const r = await window.mcpanel.installThemeFile(filePath);
  if (r.error) { toast('Error: ' + r.error, 'error'); return; }
  await renderInstalledThemes();
  toast(`Theme "${r.theme.name}" installed!`, 'success');
}

function openThemeUrlModal() {
  document.getElementById('theme-url-input').value = '';
  openModal('modal-theme-url');
}

async function installThemeFromUrl() {
  const url = document.getElementById('theme-url-input').value.trim();
  if (!url) { toast('Please enter a URL', 'error'); return; }

  const btn = document.getElementById('theme-url-submit');
  btn.disabled = true; btn.textContent = 'Installing…';

  const r = await window.mcpanel.installThemeUrl(url);

  btn.disabled = false; btn.textContent = 'Install';

  if (r.error) { toast('Error: ' + r.error, 'error'); return; }
  closeModal('modal-theme-url');
  await renderInstalledThemes();
  toast(`Theme "${r.theme.name}" installed!`, 'success');
}

// Theme browser: themes from every catalogue, shown one library at a time.
let _themeBrowserThemes = null;
let _themeBrowserSource = 'mcpanel';

async function openThemeBrowser() {
  openModal('modal-theme-browser');
  document.getElementById('theme-browser-source').value = _themeBrowserSource;
  const content = document.getElementById('theme-browser-content');
  content.innerHTML = `<div style="text-align:center;padding:40px 0;color:var(--text-muted)">Fetching themes…</div>`;

  const r = await window.mcpanel.fetchGithubThemes();
  _themeBrowserThemes = r.themes || [];
  renderThemeBrowser();
}

function switchThemeSource(source) {
  _themeBrowserSource = source;
  if (_themeBrowserThemes) renderThemeBrowser();
}

function renderThemeBrowser() {
  const content = document.getElementById('theme-browser-content');
  const themes = _themeBrowserThemes.filter(t => (t.source || 'mcpanel') === _themeBrowserSource);

  if (themes.length === 0) {
    content.innerHTML = `
      <div class="theme-browser-empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        <p>No online themes available from this library.</p>
        <p style="margin-top:6px;font-size:11px">Import a local ZIP or install from a direct URL instead.</p>
      </div>`;
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'theme-browser-grid';

  themes.forEach(theme => {
    const card = document.createElement('div');
    card.className = 'theme-browser-card';

    const creatorHtml = theme.creatorUrl
      ? `<a href="#" onclick="window.mcpanel.openExternal('${escapeHtml(theme.creatorUrl)}');return false" style="color:var(--accent)">${escapeHtml(theme.creator || 'Unknown')}</a>`
      : escapeHtml(theme.creator || 'Unknown');

    card.innerHTML = `
      <div class="theme-browser-card-name">${escapeHtml(theme.name)}</div>
      <div class="theme-browser-card-by">by ${creatorHtml}</div>
      <div class="theme-browser-card-desc">${escapeHtml(theme.description || '')}</div>
      <div class="theme-browser-card-footer">
        <span class="theme-version-tag">v${escapeHtml(theme.version || '?')}${theme.appVersion ? ` · MCPanel ${escapeHtml(theme.appVersion)}` : ''}</span>
        <button class="btn-sm" onclick="installOnlineTheme('${escapeHtml(theme.downloadUrl)}', this)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Install
        </button>
      </div>
    `;
    grid.appendChild(card);
  });

  content.innerHTML = '';
  content.appendChild(grid);
}

async function installOnlineTheme(url, btn) {
  btn.disabled = true; btn.textContent = 'Installing…';
  const r = await window.mcpanel.installThemeUrl(url);
  if (r.error) {
    btn.disabled = false; btn.textContent = 'Install';
    toast('Error: ' + r.error, 'error');
    return;
  }
  btn.textContent = 'Installed';
  await renderInstalledThemes();
  toast(`Theme "${r.theme.name}" installed!`, 'success');
}

let _term = null;
let _termFit = null;
let _ptyUnlisten = null;
let _ptyClosedUnlisten = null;

let _terminalMaximized = false;
try { _terminalMaximized = localStorage.getItem('terminalMaximized') === '1'; } catch {}

function _applyTerminalMaximize() {
  const modal = document.querySelector('#modal-terminal .terminal-modal');
  const btn = document.getElementById('terminal-maximize');
  if (!modal) return;
  modal.classList.toggle('maximized', _terminalMaximized);
  if (btn) btn.title = _terminalMaximized ? 'Restore terminal size' : 'Enlarge terminal';
  if (_termFit) requestAnimationFrame(() => _termFit && _termFit.fit());
}

function toggleTerminalMaximize() {
  _terminalMaximized = !_terminalMaximized;
  try { localStorage.setItem('terminalMaximized', _terminalMaximized ? '1' : '0'); } catch {}
  _applyTerminalMaximize();
  if (_term) _term.focus();
}

async function openTerminal() {
  _applyTerminalMaximize();
  openModal('modal-terminal');
  const container = document.getElementById('terminal-container');

  if (!_term) {
    _term = new Terminal({
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      theme: {
        background: '#0a0a10',
        foreground: '#f0eeff',
        cursor: '#a855f7',
        selectionBackground: 'rgba(168,85,247,0.3)',
        black: '#000000', red: '#ff6b6b', green: '#22c55e', yellow: '#fbbf24',
        blue: '#60a5fa', magenta: '#a855f7', cyan: '#22d3ee', white: '#cccccc',
        brightBlack: '#666666', brightRed: '#ff8888', brightGreen: '#55ff77',
        brightYellow: '#ffff55', brightBlue: '#7cb9ff', brightMagenta: '#c084fc',
        brightCyan: '#55ffff', brightWhite: '#ffffff',
      },
    });
    if (window.FitAddon) {
      _termFit = new FitAddon.FitAddon();
      _term.loadAddon(_termFit);
    }
    _term.open(container);
    if (_termFit) _termFit.fit();
    // Ctrl+Shift+C copies the selection instead of sending ^C to the shell.
    _term.attachCustomKeyEventHandler(e => {
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        const sel = _term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        return false; // handled - don't forward to the PTY
      }
      return true;
    });
    _term.onData(data => window.__TAURI_INTERNALS__.invoke('pty_write', { data }).catch(() => {}));
    _term.onResize(({ rows, cols }) => {
      window.__TAURI_INTERNALS__.invoke('pty_resize', { rows, cols }).catch(() => {});
    });
    window.addEventListener('resize', () => { if (_termFit) _termFit.fit(); });
  }

  if (_ptyUnlisten) { _ptyUnlisten(); _ptyUnlisten = null; }
  if (_ptyClosedUnlisten) { _ptyClosedUnlisten(); _ptyClosedUnlisten = null; }

  try {
    await window.__TAURI_INTERNALS__.invoke('pty_open');
    _ptyUnlisten = await window.__TAURI__.event.listen('pty-data', e => _term.write(e.payload));
    _ptyClosedUnlisten = await window.__TAURI__.event.listen('pty-closed', () => {
      _term.write('\r\n\x1b[31m[Process exited]\x1b[0m\r\n');
    });
    setTimeout(() => {
      if (_termFit) _termFit.fit();
      if (_term) window.__TAURI_INTERNALS__.invoke('pty_resize', { rows: _term.rows, cols: _term.cols }).catch(() => {});
      _term.focus();
    }, 50);
  } catch (e) {
    toast('Failed to open terminal: ' + String(e), 'error');
    closeModal('modal-terminal');
  }
}

function closeTerminal() {
  if (_ptyUnlisten) { _ptyUnlisten(); _ptyUnlisten = null; }
  if (_ptyClosedUnlisten) { _ptyClosedUnlisten(); _ptyClosedUnlisten = null; }
  window.__TAURI_INTERNALS__.invoke('pty_close').catch(() => {});
  closeModal('modal-terminal');
}

function openFirstStart() {
  openModal('modal-first-start');
}

async function dismissFirstStart() {
  closeModal('modal-first-start');
  if (!config.firstStartDone) {
    config.firstStartDone = true;
    await window.mcpanel.saveConfig(config);
  }
}

async function updateSidebarStats() {
  const serversEl    = document.getElementById('stat-servers');
  const ramEl        = document.getElementById('stat-ram');
  const ramBar       = document.getElementById('stat-ram-bar');
  const cpuEl        = document.getElementById('stat-cpu');
  const cpuBar       = document.getElementById('stat-cpu-bar');
  const storageEl    = document.getElementById('stat-storage');
  const storageBar   = document.getElementById('stat-storage-bar');

  const total  = config.servers.length;
  const online = Object.keys(serverStartTimes).length;
  if (serversEl) serversEl.textContent = `${online} / ${total}`;

  try {
    const stats = await window.mcpanel.getSystemStats();
    if (stats && !stats.error) {
      const ramPct = stats.totalRam > 0 ? Math.round((stats.usedRam / stats.totalRam) * 100) : 0;
      if (ramEl)  ramEl.textContent = `${ramPct}%`;
      if (ramBar) {
        ramBar.style.width = ramPct + '%';
        ramBar.className = 'sidebar-stat-bar-fill' +
          (ramPct > 85 ? ' bar-danger' : ramPct > 65 ? ' bar-warn' : '');
      }
      const cpuPct = Math.min(stats.cpuPct, 100);
      if (cpuEl)  cpuEl.textContent = `${cpuPct}%`;
      if (cpuBar) {
        cpuBar.style.width = cpuPct + '%';
        cpuBar.className = 'sidebar-stat-bar-fill' +
          (cpuPct > 85 ? ' bar-danger' : cpuPct > 65 ? ' bar-warn' : '');
      }
    }
  } catch {}

  if (systemInfo && systemInfo.totalStorage > 0) {
    const used = systemInfo.totalStorage - (systemInfo.availableStorage || 0);
    const pct  = Math.round((used / systemInfo.totalStorage) * 100);
    const GB = 1024 ** 3, TB = 1024 ** 4;
    const useTB = systemInfo.totalStorage >= TB;
    const div   = useTB ? TB : GB;
    const unit  = useTB ? 'TB' : 'GB';
    const fmt   = useTB ? 2 : 1;
    if (storageEl) storageEl.textContent =
      `${(used / div).toFixed(fmt)}/${(systemInfo.totalStorage / div).toFixed(fmt)}${unit}`;
    if (storageBar) {
      storageBar.style.width = pct + '%';
      storageBar.className = 'sidebar-stat-bar-fill' +
        (pct > 85 ? ' bar-danger' : pct > 65 ? ' bar-warn' : '');
    }
  }

  updateServersPageStats();
}

async function updateServersPageStats() {
  const CIRC = 402.12; // 2π × 64

  function setCircle(arcId, pct, colorClass) {
    const arc = document.getElementById(arcId);
    if (!arc) return;
    arc.style.strokeDashoffset = CIRC * (1 - Math.min(Math.max(pct, 0), 100) / 100);
    arc.className = 'stat-circle-arc' + (colorClass ? ' ' + colorClass : '');
  }

  const total  = config.servers.length;
  const online = Object.keys(serverStartTimes).length;
  const offline = total - online;
  const serversOnlineEl    = document.getElementById('sco-servers-online');
  const serversOfflineEl   = document.getElementById('sco-servers-offline');
  const serversDetOnlineEl = document.getElementById('sco-servers-detail-online');
  const serversDetOfflineEl= document.getElementById('sco-servers-detail-offline');
  if (serversOnlineEl)     serversOnlineEl.textContent     = online;
  if (serversOfflineEl)    serversOfflineEl.textContent    = offline;
  if (serversDetOnlineEl)  serversDetOnlineEl.textContent  = `${online} online`;
  if (serversDetOfflineEl) serversDetOfflineEl.textContent = `${offline} offline`;
  setCircle('sco-servers-arc', total > 0 ? (online / total) * 100 : 0, 'arc-green');

  try {
    const stats = await window.mcpanel.getSystemStats();
    if (stats && !stats.error) {
      systemCpu = { threads: stats.cpuThreads ?? null, cores: stats.cpuCores ?? null, freqMhz: stats.cpuFreqMhz ?? null, name: stats.cpuName ?? null };
      const ramPct = stats.totalRam > 0 ? Math.round((stats.usedRam / stats.totalRam) * 100) : 0;
      const ramValEl  = document.getElementById('sco-ram-val');
      const ramDetEl  = document.getElementById('sco-ram-detail');
      if (ramValEl) ramValEl.textContent = `${ramPct}%`;
      if (ramDetEl) ramDetEl.textContent = `${formatBytes(stats.usedRam)} / ${formatBytes(stats.totalRam)}`;
      setCircle('sco-ram-arc', ramPct, ramPct > 85 ? 'arc-danger' : ramPct > 65 ? 'arc-warn' : '');

      const cpuPct = Math.min(Math.round(stats.cpuPct), 100);
      const cpuValEl   = document.getElementById('sco-cpu-val');
      const cpuNameEl  = document.getElementById('sco-cpu-name');
      const cpuCoresEl = document.getElementById('sco-cpu-cores');
      if (cpuValEl)   cpuValEl.textContent   = `${cpuPct}%`;
      const cpuFreq = stats.cpuFreqMhz || 0;
      const cpuFreqStr = cpuFreq >= 1000
        ? `${(cpuFreq / 1000).toFixed(2)} GHz`
        : cpuFreq > 0 ? `${Math.round(cpuFreq)} MHz` : '';
      const cpuTooltip = [stats.cpuName, cpuFreqStr ? `@ ${cpuFreqStr}` : ''].filter(Boolean).join(' ');
      if (cpuNameEl)  { cpuNameEl.textContent = stripCpuName(stats.cpuName) || '-'; cpuNameEl.title = cpuTooltip; }
      if (cpuCoresEl) {
        cpuCoresEl.textContent = stats.cpuCores != null
          ? `${stats.cpuCores}C / ${stats.cpuThreads}T`
          : '-';
        cpuCoresEl.title = cpuTooltip;
      }
      const cpuCardEl = document.getElementById('sco-cpu-card');
      if (cpuCardEl) cpuCardEl.title = cpuTooltip;
      setCircle('sco-cpu-arc', cpuPct, cpuPct > 85 ? 'arc-danger' : cpuPct > 65 ? 'arc-warn' : '');
    }
  } catch {}

  if (systemInfo && systemInfo.totalStorage > 0) {
    const used = systemInfo.totalStorage - (systemInfo.availableStorage || 0);
    const pct  = Math.round((used / systemInfo.totalStorage) * 100);
    const storageValEl = document.getElementById('sco-storage-val');
    const storageDetEl = document.getElementById('sco-storage-detail');
    if (storageValEl) storageValEl.textContent = `${pct}%`;
    if (storageDetEl) storageDetEl.textContent = `${formatBytes(used)} / ${formatBytes(systemInfo.totalStorage)}`;
    setCircle('sco-storage-arc', pct, pct > 85 ? 'arc-danger' : pct > 65 ? 'arc-warn' : '');
  }

  let totalPlayers = 0, totalMaxPlayers = 0, velocityPlayers = 0, inGamePlayers = 0;
  for (const d of Object.values(serverPlayerData)) {
    totalPlayers    += d.players    || 0;
    totalMaxPlayers += d.maxPlayers || 0;
    if (d.isVelocity) velocityPlayers += d.players || 0;
    else              inGamePlayers   += d.players || 0;
  }
  const hasVelocityServer = config.servers.some(s => s.software === 'velocity');
  const playersOnlineEl   = document.getElementById('sco-players-online');
  const playersMaxEl      = document.getElementById('sco-players-max');
  const playersIngameEl   = document.getElementById('sco-players-detail-ingame');
  const playersVelocityEl = document.getElementById('sco-players-detail-velocity');
  if (playersOnlineEl) playersOnlineEl.textContent = totalPlayers;
  if (playersMaxEl)    playersMaxEl.textContent    = totalMaxPlayers;
  if (playersIngameEl) playersIngameEl.textContent = `${inGamePlayers} ingame`;
  if (playersVelocityEl) {
    playersVelocityEl.textContent = `${velocityPlayers} velocity`;
    playersVelocityEl.classList.toggle('hidden', !hasVelocityServer);
  }
  const playersPct = totalMaxPlayers > 0 ? (totalPlayers / totalMaxPlayers) * 100 : 0;
  setCircle('sco-players-arc', playersPct, '');
}

async function copyVelocitySecret() {
  if (!currentServerId) return;
  try {
    const result = await window.mcpanel.getVelocitySecret(currentServerId);
    if (result && result.secret) {
      await navigator.clipboard.writeText(result.secret);
      toast('Forwarding secret copied!', 'success');
    } else {
      toast(result?.error || 'Forwarding secret not found', 'error');
    }
  } catch {
    toast('Failed to read forwarding secret', 'error');
  }
}

// Fades out the startup loading screen. Safe to call more than once.
function hideAppLoader() {
  const el = document.getElementById('app-loader');
  if (!el || el.classList.contains('done')) return;
  try {
    const css = getComputedStyle(document.documentElement);
    const v = n => css.getPropertyValue(n).trim();
    localStorage.setItem('mcpanel-loader-colors', JSON.stringify({ bg: v('--bg-base'), fg: v('--text-secondary'), accent: v('--accent') }));
  } catch (_) {}
  el.classList.add('done');
  setTimeout(() => el.remove(), 150);
}
// Never leave the loader up forever if something hangs.
setTimeout(hideAppLoader, 20000);

window._cliReady.then(ok => {
  if (ok) {
    init().catch(e => console.error('init failed:', e)).finally(hideAppLoader);
  } else {
    // CLI missing: skip full init, but still apply the default theme so the
    // app isn't unstyled behind the "CLI not found" modal. Theme handling is
    // entirely Rust-native and doesn't touch the CLI.
    applyDefaultThemeNoCli().finally(hideAppLoader);
  }
});

async function applyDefaultThemeNoCli() {
  try {
    await ensureBuiltinThemes();
    const defaultThemeId = await window.mcpanel.getDefaultTheme();
    await loadAndApplyTheme(defaultThemeId);
  } catch (e) {
    console.error('Failed to apply default theme without CLI:', e);
  }
}

async function populateFontLists(currentFonts) {
  const BUNDLED_DISPLAY = ['Poppins', 'system-ui'];
  const BUNDLED_MONO = ['JetBrains Mono', 'monospace'];
  const display = currentFonts?.display || 'Poppins';
  const mono = currentFonts?.mono || 'JetBrains Mono';

  let systemFonts = [];
  try { systemFonts = await window.mcpanel.listSystemFonts(); } catch (_) {}

  function fillSelect(id, bundled, all, selected) {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = '';
    const seen = new Set();
    const bundledSet = new Set(bundled);
    const all_fonts = [...bundled, selected, ...all].filter(Boolean);
    for (const f of all_fonts) {
      if (seen.has(f)) continue;
      seen.add(f);
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = bundledSet.has(f) ? `${f} (built-in)` : f;
      if (f === selected) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  fillSelect('font-display-select', BUNDLED_DISPLAY, systemFonts, display);
  fillSelect('font-mono-select', BUNDLED_MONO, systemFonts, mono);
  _syncWeightSelects(currentFonts);
  applyFontPreview();
}

function _syncWeightSelects(fonts) {
  const dw = document.getElementById('font-display-weight');
  const mw = document.getElementById('font-mono-weight');
  if (dw) dw.value = fonts?.displayWeight || '400';
  if (mw) mw.value = fonts?.monoWeight || '400';
}

function _getDisplayFontValue() {
  const sel = document.getElementById('font-display-select');
  return (sel && sel.value) || 'Poppins';
}

function _getMonoFontValue() {
  const sel = document.getElementById('font-mono-select');
  return (sel && sel.value) || 'JetBrains Mono';
}

function _getDisplayWeightValue() {
  const sel = document.getElementById('font-display-weight');
  return (sel && sel.value) || '400';
}

function _getMonoWeightValue() {
  const sel = document.getElementById('font-mono-weight');
  return (sel && sel.value) || '400';
}

function _syncFontSelects(fonts) {
  const dSel = document.getElementById('font-display-select');
  const mSel = document.getElementById('font-mono-select');
  if (dSel) dSel.value = fonts?.display || 'Poppins';
  if (mSel) mSel.value = fonts?.mono || 'JetBrains Mono';
  _syncWeightSelects(fonts);
  applyFontPreview();
}

function applyFontSettings(fonts) {
  const display = fonts.display || 'Poppins';
  const mono = fonts.mono || 'JetBrains Mono';
  const dw = fonts.displayWeight || '400';
  const mw = fonts.monoWeight || '400';
  let el = document.getElementById('font-override');
  if (!el) { el = document.createElement('style'); el.id = 'font-override'; document.head.appendChild(el); }
  el.textContent = `:root { --font-display: '${display}', system-ui, -apple-system, 'Segoe UI', sans-serif; --font-mono: '${mono}', 'Cascadia Code', Consolas, monospace; --font-display-weight: ${dw}; --font-mono-weight: ${mw}; }`;
}

function applyFontPreview() {
  const display = _getDisplayFontValue();
  const mono = _getMonoFontValue();
  const dw = _getDisplayWeightValue();
  const mw = _getMonoWeightValue();
  const dEl = document.getElementById('font-preview-display');
  const mEl = document.getElementById('font-preview-mono');
  if (dEl) { dEl.style.fontFamily = `'${display}', system-ui, sans-serif`; dEl.style.fontWeight = dw; }
  if (mEl) { mEl.style.fontFamily = `'${mono}', monospace`; mEl.style.fontWeight = mw; }
}

async function saveFontSettings() {
  const fonts = { display: _getDisplayFontValue(), displayWeight: _getDisplayWeightValue(), mono: _getMonoFontValue(), monoWeight: _getMonoWeightValue() };
  _appSettings.fonts = fonts;
  await window.mcpanel.saveAppSettings(_appSettings);
  applyFontSettings(fonts);
  toast('Fonts applied');
}

async function resetFontSettings() {
  const fonts = { display: 'Poppins', displayWeight: '400', mono: 'JetBrains Mono', monoWeight: '400' };
  _appSettings.fonts = fonts;
  await window.mcpanel.saveAppSettings(_appSettings);
  applyFontSettings(fonts);
  _syncFontSelects(fonts);
  toast('Fonts reset to default');
}

let backupProgressListener = null;

async function openBackupsTab() {
  if (!currentServerId) return;
  await loadBackupList();
}

async function loadBackupList() {
  const res = await window.mcpanel.listBackups(currentServerId);
  const list = document.getElementById('backup-list');
  const empty = document.getElementById('backup-empty');
  const backups = res.backups || [];

  const cards = list.querySelectorAll('.backup-entry');
  cards.forEach(c => c.remove());

  if (backups.length === 0) {
    empty.style.display = '';
  } else {
    empty.style.display = 'none';
    backups.forEach(b => {
      const el = document.createElement('div');
      el.className = 'backup-entry';
      el.innerHTML = `
        <div class="backup-entry-info">
          <span class="backup-entry-name">${b.name}</span>
          <span class="backup-entry-meta">${formatBytes(b.size)} &bull; ${formatDate(b.created)}</span>
        </div>
        <div class="backup-entry-actions">
          <button class="btn-sm" onclick="restoreBackup('${b.name}')">Restore</button>
          <button class="btn-sm btn-danger-sm" onclick="deleteBackup('${b.name}')">Delete</button>
        </div>
      `;
      list.appendChild(el);
    });
  }
}

async function createBackup() {
  if (!currentServerId) return;
  const btn = document.getElementById('backup-create-btn');
  const wrap = document.getElementById('backup-progress-wrap');
  const fill = document.getElementById('backup-progress-fill');
  const text = document.getElementById('backup-progress-text');

  btn.disabled = true;
  wrap.classList.remove('hidden');
  fill.style.width = '0%';
  text.textContent = 'Starting…';

  if (backupProgressListener) {
    await window.mcpanel.off('backup-progress', backupProgressListener);
  }
  backupProgressListener = (ev) => {
    if (ev.payload && ev.payload.id === currentServerId) {
      fill.style.width = ev.payload.progress + '%';
      text.textContent = ev.payload.status;
    }
  };
  await window.mcpanel.on('backup-progress', backupProgressListener);

  try {
    const res = await window.mcpanel.createBackup(currentServerId);
    if (res.error) {
      toast('Backup failed: ' + res.error, 'error');
    } else {
      toast('Backup created successfully');
      await loadBackupList();
    }
  } finally {
    btn.disabled = false;
    setTimeout(() => wrap.classList.add('hidden'), 2000);
  }
}

async function deleteBackup(backupName) {
  if (!currentServerId) return;
  const ok = await confirmDialog({
    title: 'Delete Backup',
    message: `Delete the backup "${backupName}"?\n\nThis action cannot be undone.`,
    confirmLabel: 'Delete Backup',
  });
  if (!ok) return;
  const res = await window.mcpanel.deleteBackup(currentServerId, backupName);
  if (res.error) { toast('Failed to delete backup: ' + res.error, 'error'); return; }
  toast('Backup deleted');
  await loadBackupList();
}

async function restoreBackup(backupName) {
  if (!currentServerId) return;
  const ok = await confirmDialog({
    title: 'Restore Backup',
    message: `Restore from "${backupName}"?\n\nThis overwrites the current server files and cannot be undone. Stop the server first if it is running.`,
    confirmLabel: 'Restore',
  });
  if (!ok) return;
  const wrap = document.getElementById('backup-progress-wrap');
  const fill = document.getElementById('backup-progress-fill');
  const text = document.getElementById('backup-progress-text');

  wrap.classList.remove('hidden');
  fill.style.width = '10%';
  text.textContent = 'Restoring…';

  if (backupProgressListener) {
    await window.mcpanel.off('backup-progress', backupProgressListener);
  }
  backupProgressListener = (ev) => {
    if (ev.payload && ev.payload.id === currentServerId) {
      fill.style.width = ev.payload.progress + '%';
      text.textContent = ev.payload.status;
    }
  };
  await window.mcpanel.on('backup-progress', backupProgressListener);

  const res = await window.mcpanel.restoreBackup(currentServerId, backupName);
  if (res.error) {
    toast('Restore failed: ' + res.error, 'error');
  } else {
    toast('Restore complete');
  }
  setTimeout(() => wrap.classList.add('hidden'), 2000);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return bytes.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function formatDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString();
}

let _editingScheduleId = null;

async function openScheduleTab() {
  if (!currentServerId) return;
  await loadScheduleList();
}

async function loadScheduleList() {
  const res = await window.mcpanel.getSchedules(currentServerId);
  const list = document.getElementById('schedule-list');
  const empty = document.getElementById('schedule-empty');
  const schedules = res.schedules || [];

  const cards = list.querySelectorAll('.schedule-card');
  cards.forEach(c => c.remove());

  if (schedules.length === 0) {
    empty.style.display = '';
  } else {
    empty.style.display = 'none';
    schedules.forEach(s => {
      const el = document.createElement('div');
      el.className = 'schedule-card';
      const actionLabel = { restart: 'Restart', start: 'Start', stop: 'Stop', backup: 'Backup', command: 'Run Command' }[s.action] || s.action;
      const repeatStr = s.repeat ? `Every ${s.repeat_every} ${s.repeat_unit}` : 'Once';
      const nextStr = s.next_run ? formatDate(s.next_run) : 'Not set';
      el.innerHTML = `
        <div class="schedule-card-header">
          <div class="schedule-card-label">${s.label || actionLabel}</div>
          <div class="schedule-card-badges">
            <span class="schedule-badge">${actionLabel}</span>
            <span class="schedule-badge">${repeatStr}</span>
            ${!s.enabled ? '<span class="schedule-badge muted">Disabled</span>' : ''}
          </div>
        </div>
        ${s.action === 'command' && s.command ? `<div class="schedule-card-cmd"><code>${escHtml(s.command)}</code></div>` : ''}
        <div class="schedule-card-meta">Next: ${nextStr}</div>
        <div class="schedule-card-actions">
          <button class="btn-sm" onclick="runScheduleNow('${s.id}','${s.server_id}','${s.action}',${JSON.stringify(s.command||'')})">Run now</button>
          <button class="btn-sm" onclick="editSchedule(${JSON.stringify(s)})">Edit</button>
          <button class="btn-sm" onclick="toggleSchedule(${JSON.stringify(s)})">${s.enabled ? 'Disable' : 'Enable'}</button>
          <button class="btn-sm btn-danger-sm" onclick="deleteSchedule('${s.id}')">Delete</button>
        </div>
      `;
      list.appendChild(el);
    });
  }
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function openCreateScheduleModal() {
  _editingScheduleId = null;
  document.getElementById('schedule-modal-title').textContent = 'Add Scheduled Task';
  document.getElementById('sch-label').value = '';
  document.getElementById('sch-action').value = 'restart';
  document.getElementById('sch-command').value = '';
  document.getElementById('sch-repeat').checked = false;
  document.getElementById('sch-repeat-every').value = 1;
  document.getElementById('sch-repeat-unit').value = 'days';
  const now = new Date();
  document.getElementById('sch-date').value = now.toISOString().slice(0, 10);
  document.getElementById('sch-time').value = now.toTimeString().slice(0, 5);
  document.getElementById('sch-command-row').classList.add('hidden');
  document.getElementById('sch-repeat-row').classList.add('hidden');
  document.getElementById('sch-submit').textContent = 'Save Task';
  openModal('modal-create-schedule');
}

function editSchedule(s) {
  _editingScheduleId = s.id;
  document.getElementById('schedule-modal-title').textContent = 'Edit Scheduled Task';
  document.getElementById('sch-label').value = s.label || '';
  document.getElementById('sch-action').value = s.action || 'restart';
  document.getElementById('sch-command').value = s.command || '';
  document.getElementById('sch-repeat').checked = !!s.repeat;
  document.getElementById('sch-repeat-every').value = s.repeat_every || 1;
  document.getElementById('sch-repeat-unit').value = s.repeat_unit || 'days';
  const d = s.next_run ? new Date(s.next_run) : new Date();
  document.getElementById('sch-date').value = d.toISOString().slice(0, 10);
  document.getElementById('sch-time').value = d.toTimeString().slice(0, 5);
  document.getElementById('sch-command-row').classList.toggle('hidden', s.action !== 'command');
  document.getElementById('sch-repeat-row').classList.toggle('hidden', !s.repeat);
  document.getElementById('sch-submit').textContent = 'Update Task';
  openModal('modal-create-schedule');
}

function onScheduleActionChange() {
  const action = document.getElementById('sch-action').value;
  document.getElementById('sch-command-row').classList.toggle('hidden', action !== 'command');
}

function onScheduleRepeatChange() {
  const checked = document.getElementById('sch-repeat').checked;
  document.getElementById('sch-repeat-row').classList.toggle('hidden', !checked);
}

async function saveSchedule() {
  const label = document.getElementById('sch-label').value.trim();
  const action = document.getElementById('sch-action').value;
  const command = document.getElementById('sch-command').value.trim();
  const repeat = document.getElementById('sch-repeat').checked;
  const repeatEvery = parseInt(document.getElementById('sch-repeat-every').value) || 1;
  const repeatUnit = document.getElementById('sch-repeat-unit').value;
  const dateVal = document.getElementById('sch-date').value;
  const timeVal = document.getElementById('sch-time').value;

  if (!dateVal || !timeVal) { toast('Please set a date and time', 'error'); return; }
  const nextRun = new Date(`${dateVal}T${timeVal}`).getTime();
  if (isNaN(nextRun)) { toast('Invalid date/time', 'error'); return; }

  const schedule = {
    id: _editingScheduleId || ('sch_' + Date.now()),
    server_id: currentServerId,
    label,
    action,
    command,
    next_run: nextRun,
    repeat,
    repeat_every: repeatEvery,
    repeat_unit: repeatUnit,
    enabled: true,
    last_run: null,
  };

  const res = await window.mcpanel.saveSchedule(schedule);
  if (res.error) { toast('Failed to save schedule: ' + res.error, 'error'); return; }
  closeModal('modal-create-schedule');
  toast(_editingScheduleId ? 'Schedule updated' : 'Schedule created');
  await loadScheduleList();
}

async function deleteSchedule(scheduleId) {
  const ok = await confirmDialog({
    title: 'Delete Schedule',
    message: 'Delete this scheduled task?\n\nThis action cannot be undone.',
    confirmLabel: 'Delete Schedule',
  });
  if (!ok) return;
  const res = await window.mcpanel.deleteSchedule(scheduleId);
  if (res.error) { toast('Failed to delete schedule: ' + res.error, 'error'); return; }
  toast('Schedule deleted');
  await loadScheduleList();
}

async function toggleSchedule(s) {
  const updated = Object.assign({}, s, { enabled: !s.enabled });
  const res = await window.mcpanel.saveSchedule(updated);
  if (res.error) { toast('Failed to update schedule: ' + res.error, 'error'); return; }
  await loadScheduleList();
}

async function runScheduleNow(scheduleId, serverId, action, command) {
  const res = await window.mcpanel.runScheduleNow(serverId, action, command || null);
  if (res.error) { toast('Failed to run task: ' + res.error, 'error'); return; }
  toast('Task executed');
}


// ─── Sidebar: resize + collapse ──────────────────────────────────────────────
// Width and collapsed state are per-device conveniences, remembered like the
// servers sort/view settings.
const SIDEBAR_DEFAULT_WIDTH = 220;
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_COLLAPSE_BELOW = 120;   // dragging narrower than this collapses it
const _SIDEBAR_ICON_COLLAPSE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 4v16"/><path d="M15 10l-2 2l2 2"/></svg>';
const _SIDEBAR_ICON_EXPAND = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 4v16"/><path d="M14 10l2 2l-2 2"/></svg>';

function _setSidebarWidth(px, persist = true) {
  const w = Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, px)));
  document.querySelector('.app')?.style.setProperty('--sidebar-width', `${w}px`);
  if (persist) localStorage.setItem('mcpanel-sidebar-width', String(w));
  return w;
}

function setSidebarCollapsed(collapsed) {
  const app = document.querySelector('.app');
  if (!app) return;
  app.classList.toggle('sidebar-collapsed', collapsed);
  localStorage.setItem('mcpanel-sidebar-collapsed', collapsed ? '1' : '0');
  const btn = document.getElementById('sidebar-collapse-btn');
  if (btn) {
    btn.innerHTML = collapsed ? _SIDEBAR_ICON_EXPAND : _SIDEBAR_ICON_COLLAPSE;
    btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  }
  // Icon-only nav items need a tooltip (addon pages may have been added since).
  if (collapsed) {
    document.querySelectorAll('.sidebar .nav-item').forEach(n => {
      if (!n.title) n.title = n.querySelector('span')?.textContent.trim() || '';
    });
  }
}

function toggleSidebarCollapsed() {
  setSidebarCollapsed(!document.querySelector('.app')?.classList.contains('sidebar-collapsed'));
}

(function initSidebarLayout() {
  const saved = parseInt(localStorage.getItem('mcpanel-sidebar-width'), 10);
  _setSidebarWidth(Number.isFinite(saved) ? saved : SIDEBAR_DEFAULT_WIDTH, false);
  setSidebarCollapsed(localStorage.getItem('mcpanel-sidebar-collapsed') === '1');

  const handle = document.getElementById('sidebar-resizer');
  const sidebar = document.querySelector('.sidebar');
  if (!handle || !sidebar) return;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const left = sidebar.getBoundingClientRect().left;
    document.body.classList.add('sidebar-resizing');
    const move = (ev) => {
      const w = ev.clientX - left;
      if (w < SIDEBAR_COLLAPSE_BELOW) { setSidebarCollapsed(true); return; }
      if (document.querySelector('.app').classList.contains('sidebar-collapsed')) setSidebarCollapsed(false);
      _setSidebarWidth(w);
    };
    const up = () => {
      document.body.classList.remove('sidebar-resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => {
    setSidebarCollapsed(false);
    _setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  });
})();
