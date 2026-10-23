/* ═══════════════════════════════════════════════════════════════════════════
   Table editor + the built-in SQLite editor.

   The table editor is a paged, editable grid for one table. It doesn't know
   where the rows come from: it is given a "source" - four functions that read
   and write through the CLI. The SQLite editor (opened from a server's file
   browser for .db files) is its first user; the MCPanel-Databases addon builds
   its MySQL / MariaDB page on it through window.MCPanelTableEditor.

   Shared verbatim by MCPanel (src/) and MCPanel-WebUI (public/).
   ═══════════════════════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  const PAGE_SIZE = 100;
  const SQLITE_EXT = /\.(db|sqlite|sqlite3|db3)$/i;

  const esc = s => escapeHtml(String(s ?? ''));

  const ICON = {
    chevron: '<svg class="db-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>',
    db: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></svg>',
    table: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg>',
    server: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="7" rx="1"/><rect x="2" y="14" width="20" height="7" rx="1"/></svg>',
    key: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:-1px;margin-right:4px"><circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/></svg>',
    trash: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
    edit: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    plus: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>',
  };

  // ═══ Table editor ══════════════════════════════════════════════════════════
  // source: {
  //   key:                       a string identifying the database (for isShowing)
  //   rows(table, offset, limit) → { columns, rows: [{key, values}], keyMode, total, offset } | {error}
  //   update(table, key, set)    → { success } | {error}
  //   insert(table, values)      → { success } | {error}
  //   delete(table, key)         → { success } | {error}
  // }
  // The cell / add-row dialogs are shared, so whichever editor opened one is
  // remembered in `activeEdit`.
  let activeEdit = null;   // { editor, ri, ci } for the cell dialog, { editor } for add-row

  function createTableEditor(root, { emptyTitle, emptyText, onWrite }) {
    root.innerHTML = `
      <div class="empty-state db-editor-empty" data-el="empty">
        <div class="empty-icon"><svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg></div>
        <h3>${esc(emptyTitle)}</h3><p>${esc(emptyText)}</p>
      </div>
      <div class="db-editor hidden" data-el="view">
        <div class="card-header db-header">
          <div class="card-title" data-el="title"></div>
          <div class="db-toolbar">
            <button class="btn-sm" data-act="add">${ICON.plus} Add Row</button>
            <button class="btn-sm" data-act="reload">Reload</button>
            <div class="db-pager">
              <button class="btn-xs" data-act="prev">&lsaquo;</button>
              <span data-el="range"></span>
              <button class="btn-xs" data-act="next">&rsaquo;</button>
            </div>
          </div>
        </div>
        <div class="warning-box hidden db-warn" data-el="warn"></div>
        <div class="db-grid-wrap"><table class="db-grid" data-el="grid"></table></div>
        <div class="db-hint">Double-click a cell to edit it.</div>
      </div>`;
    const el = name => root.querySelector(`[data-el="${name}"]`);
    const ed = { source: null, table: null, offset: 0, data: null };

    async function load() {
      const { source, table } = ed;
      if (!source) return;
      const r = await source.rows(table, ed.offset, PAGE_SIZE);
      if (ed.source !== source || ed.table !== table) return; // switched meanwhile
      if (r.error) { toast(r.error, 'error'); return; }
      ed.data = r;
      render();
    }

    function cellHtml(v) {
      if (v === null || v === undefined) return '<span class="db-null">NULL</span>';
      if (typeof v === 'object' && '$blob' in v) return `<span class="db-blob">BLOB · ${esc(formatBytes(v.$blob))}</span>`;
      return esc(v);
    }

    function render() {
      const d = ed.data;
      const head = d.columns.map(c =>
        `<th title="${esc(c.type)}">${c.pk ? ICON.key : ''}${esc(c.name)}<span class="db-col-type">${esc(c.type)}</span></th>`).join('');
      const body = d.rows.map((r, ri) => {
        const tds = r.values.map((v, ci) => {
          const blob = v && typeof v === 'object';
          const title = blob || v === null ? '' : ` title="${esc(String(v).slice(0, 500))}"`;
          return `<td class="${blob ? '' : 'editable'}" data-r="${ri}" data-c="${ci}"${title}>${cellHtml(v)}</td>`;
        }).join('');
        return `<tr>${tds}<td class="db-actions"><button class="btn-icon-sm btn-ghost-sm" data-del="${ri}" title="Delete row">${ICON.trash}</button></td></tr>`;
      }).join('');
      el('grid').innerHTML = `<thead><tr>${head}<th class="db-actions"></th></tr></thead><tbody>${body ||
        `<tr><td class="db-muted" colspan="${d.columns.length + 1}">No rows</td></tr>`}</tbody>`;
      const from = d.rows.length ? d.offset + 1 : 0;
      el('range').textContent =
        `${from.toLocaleString()}-${(d.offset + d.rows.length).toLocaleString()} of ${Number(d.total).toLocaleString()}`;
      root.querySelector('[data-act="prev"]').disabled = d.offset === 0;
      root.querySelector('[data-act="next"]').disabled = d.offset + d.rows.length >= d.total;
    }

    async function write(promise, okMsg) {
      const r = await promise;
      if (r.error) { toast(r.error, 'error'); return false; }
      if (okMsg) toast(okMsg, 'success');
      await load();
      onWrite?.();
      return true;
    }

    async function deleteRow(ri) {
      const row = ed.data.rows[ri];
      const preview = ed.data.columns.slice(0, 3)
        .map((c, i) => `${c.name} = ${row.values[i] === null ? 'NULL' : String(row.values[i]).slice(0, 40)}`).join(', ');
      const ok = await confirmDialog({
        title: 'Delete Row',
        message: `Delete this row from "${ed.table}"?\n\n${preview}\n\nThis can't be undone.`,
        confirmLabel: 'Delete Row',
      });
      if (ok) await write(ed.source.delete(ed.table, row.key), 'Row deleted');
    }

    root.addEventListener('click', e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'add') openAddRow(editor);
      else if (act === 'reload') load();
      else if (act === 'prev' || act === 'next') {
        ed.offset = Math.max(0, ed.offset + (act === 'next' ? PAGE_SIZE : -PAGE_SIZE));
        load();
      }
      const del = e.target.closest('[data-del]');
      if (del) deleteRow(Number(del.dataset.del));
    });
    root.addEventListener('dblclick', e => {
      const td = e.target.closest('td.editable');
      if (td) openCellEditor(editor, Number(td.dataset.r), Number(td.dataset.c));
    });

    const editor = {
      ed,
      write,
      // label: breadcrumb before the table name; warning: text for the banner.
      open(source, table, { label = '', warning = '' } = {}) {
        Object.assign(ed, { source, table, offset: 0, data: null });
        el('empty').classList.add('hidden');
        el('view').classList.remove('hidden');
        el('title').innerHTML = `${ICON.table}<span class="db-title-path">${esc(label)}${label ? ' ›' : ''}</span> ${esc(table)}`;
        el('warn').classList.toggle('hidden', !warning);
        el('warn').textContent = warning;
        el('grid').innerHTML = '<tbody><tr><td class="db-muted">Loading…</td></tr></tbody>';
        load();
      },
      clear() {
        Object.assign(ed, { source: null, table: null, data: null });
        el('view').classList.add('hidden');
        el('empty').classList.remove('hidden');
      },
      // Whether this editor currently shows `source` (by its key), and `table` if given.
      isShowing: (source, table) => !!ed.source && !!source && ed.source.key === source.key &&
        (table === undefined || ed.table === table),
    };
    return editor;
  }

  // ─── shared cell / row dialogs ─────────────────────────────────────────────
  // A cell edited as text that held a number goes back as a number, so a
  // typeless SQLite column doesn't silently turn 5 into '5'. Integers past
  // 2^53 stay strings (JS can't hold them; the CLI writes them exactly).
  function coerce(text, original) {
    if (typeof original !== 'number' || !/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text.trim())) return text;
    const n = Number(text);
    return Number.isFinite(n) && (!Number.isInteger(n) || Number.isSafeInteger(n)) ? n : text;
  }

  function openCellEditor(editor, ri, ci) {
    const d = editor.ed.data;
    const col = d.columns[ci];
    const v = d.rows[ri].values[ci];
    activeEdit = { editor, ri, ci };
    document.getElementById('db-cell-meta').innerHTML =
      `<b>${esc(col.name)}</b> <span class="db-col-type">${esc(col.type || 'any')}</span>${col.pk ? ' · primary key' : ''}`;
    const ta = document.getElementById('db-cell-value');
    const isNull = v === null;
    ta.value = isNull ? '' : String(v);
    ta.disabled = isNull;
    const nullBox = document.getElementById('db-cell-null');
    nullBox.checked = isNull;
    nullBox.disabled = col.notnull && !isNull;
    openModal('modal-db-cell');
    if (!isNull) setTimeout(() => ta.focus(), 30);
  }

  function cellNullToggle() {
    document.getElementById('db-cell-value').disabled = document.getElementById('db-cell-null').checked;
  }

  async function saveCell() {
    if (!activeEdit || activeEdit.ri === undefined) return;
    const { editor, ri, ci } = activeEdit;
    const { source, table, data: d } = editor.ed;
    const row = d.rows[ri];
    const col = d.columns[ci];
    const original = row.values[ci];
    const isNull = document.getElementById('db-cell-null').checked;
    const value = isNull ? null : coerce(document.getElementById('db-cell-value').value, original);
    closeModal('modal-db-cell');
    if (value === original || (value !== null && original !== null && String(value) === String(original))) return;
    await editor.write(source.update(table, row.key, { [col.name]: value }));
  }

  function openAddRow(editor) {
    const d = editor.ed.data;
    if (!d) return;
    activeEdit = { editor };
    document.getElementById('db-row-fields').innerHTML = d.columns.filter(c => !c.blob).map((c, i) => {
      const auto = c.autoIncrement || (d.keyMode === 'rowid' && c.pk && /int/i.test(c.type));
      const hint = auto ? 'automatic' : (c.default != null ? `default: ${c.default}` : 'empty = default');
      return `<div class="form-group full">
        <label>${c.pk ? ICON.key : ''}${esc(c.name)} <span class="label-hint">${esc(c.type || 'any')}</span></label>
        <div class="input-row">
          <input type="text" class="input" data-col="${i}" placeholder="${esc(hint)}">
          ${c.notnull ? '' : `<label class="checkbox-item db-null-check"><input type="checkbox" data-null="${i}"> NULL</label>`}
        </div>
      </div>`;
    }).join('');
    openModal('modal-db-row');
  }

  async function saveRow() {
    if (!activeEdit) return;
    const { editor } = activeEdit;
    const { source, table, data } = editor.ed;
    const cols = data.columns.filter(c => !c.blob);
    const values = {};
    document.querySelectorAll('#db-row-fields [data-col]').forEach(inp => {
      const i = Number(inp.dataset.col);
      const nul = document.querySelector(`#db-row-fields [data-null="${i}"]`);
      if (nul && nul.checked) values[cols[i].name] = null;
      else if (inp.value !== '') values[cols[i].name] = inp.value;
    });
    closeModal('modal-db-row');
    await editor.write(source.insert(table, values), 'Row added');
  }

  // A table list (name + row count) with one active entry.
  function tableListHtml(tables, activeName, attrs) {
    return tables.map(tb => {
      const count = tb.rows == null ? '' : (tb.estimate ? '~' : '') + tb.rows.toLocaleString();
      return `<button class="db-item db-table-item${tb.name === activeName ? ' active' : ''}" ${attrs} data-table="${esc(tb.name)}">
        ${ICON.table}<span class="db-item-name">${esc(tb.name)}</span><span class="db-item-meta">${count}</span></button>`;
    }).join('');
  }

  // ═══ SQLite editor - opened from a server's file browser ══════════════════
  // `mcpanel api db …` (core CLI) on one file, addressed by server + path.
  function sqliteSource(serverId, file) {
    const db = args => window.mcpanel.db([...args, '-id', serverId, '-file', file]);
    return {
      key: `sqlite:${serverId}:${file}`,
      tables: () => db(['tables']),
      rows: (table, offset, limit) => db(['rows', '-table', table, '-offset', String(offset), '-limit', String(limit)]),
      update: (table, key, set) => db(['update', '-table', table, '-key', JSON.stringify(key), '-set', JSON.stringify(set)]),
      insert: (table, values) => db(['insert', '-table', table, '-values', JSON.stringify(values)]),
      delete: (table, key) => db(['delete', '-table', table, '-key', JSON.stringify(key)]),
    };
  }

  const lite = { source: null, tables: [], warning: '', editor: null };

  function renderLiteTables() {
    const active = lite.editor.isShowing(lite.source) ? lite.editor.ed.table : null;
    document.getElementById('sqlite-tables').innerHTML = lite.tables.length
      ? tableListHtml(lite.tables, active, 'data-act="lite-table"')
      : '<div class="db-muted">No tables</div>';
  }

  async function reloadLiteTables() {
    const r = await lite.source.tables();
    if (!r.error) { lite.tables = r.tables; renderLiteTables(); }
  }

  // Returns false when the file isn't SQLite after all, so the caller can fall
  // back to the text editor (e.g. LuckPerms' H2 *.trace.db is plain text).
  async function openSqlite(serverId, relPath, name) {
    const source = sqliteSource(serverId, relPath);
    const r = await source.tables();
    if (r.error) {
      if (r.code === 'not_sqlite') return false;
      toast(r.error, 'error');
      return true;
    }
    lite.source = source;
    lite.tables = r.tables;
    lite.editor.clear();
    lite.warning = r.running
      ? `${r.serverName} is running. The plugin using this database may overwrite your changes or hold it locked - stop the server before editing.`
      : '';
    document.getElementById('sqlite-title').textContent = name;
    document.getElementById('sqlite-subtitle').textContent = relPath;
    if (r.tables.length) lite.editor.open(source, r.tables[0].name, { warning: lite.warning });
    renderLiteTables();
    openModal('modal-sqlite');
    return true;
  }

  // ─── wiring ────────────────────────────────────────────────────────────────
  lite.editor = createTableEditor(document.getElementById('sqlite-editor'), {
    emptyTitle: 'No tables',
    emptyText: 'This database has no tables yet.',
    onWrite: reloadLiteTables,
  });
  document.getElementById('sqlite-tables').addEventListener('click', e => {
    const el = e.target.closest('[data-act="lite-table"]');
    if (!el) return;
    lite.editor.open(lite.source, el.dataset.table, { warning: lite.warning });
    renderLiteTables();
  });
  document.getElementById('db-cell-value').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveCell();
  });

  // Used by the cell / row / SQLite dialogs in index.html and by app.js.
  window.DatabasesUI = {
    isDbFile: name => SQLITE_EXT.test(name || ''),
    openSqlite,
    saveRow,
    saveCell,
    cellNullToggle,
  };

  // For addons (MCPanel-Databases): the same grid on any data source.
  window.MCPanelTableEditor = {
    create: createTableEditor,
    tableListHtml,
    icons: ICON,
  };
})();
