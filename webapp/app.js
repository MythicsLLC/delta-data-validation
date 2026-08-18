/* ==========================================================================
   DELTA — Data Validation Console — frontend logic
   Talks to the Python backend exclusively through `pywebview.api.*` (see
   desktop_app.py's Api class for the exact contract). No network calls.
   ========================================================================== */

(() => {
  'use strict';

  /* ---------------------------------------------------------------- */
  /* State                                                              */
  /* ---------------------------------------------------------------- */
  const state = {
    apiReady: false,
    source: { path: '', name: '', sheets: [], sheet: '' },
    target: { path: '', name: '', sheets: [], sheet: '' },
    sourceCols: [],
    targetCols: [],
    rows: [],          // [{source, target, key, date, include}]
    running: false,
  };

  /* ---------------------------------------------------------------- */
  /* DOM shortcuts                                                      */
  /* ---------------------------------------------------------------- */
  const $ = (id) => document.getElementById(id);
  const dz = { source: $('dz-source'), target: $('dz-target') };
  const fileBox = { source: $('file-source'), target: $('file-target') };
  const fileName = { source: $('file-source-name'), target: $('file-target-name') };
  const sheetSel = { source: $('sheet-source'), target: $('sheet-target') };
  const btnLoadColumns = $('btnLoadColumns');
  const loadColumnsMsg = $('loadColumnsMsg');
  const mappingTable = $('mappingTable');
  const mappingEmpty = $('mappingEmpty');
  const mappingFilter = $('mappingFilter');
  const mappingStats = $('mappingStats');
  const btnRun = $('btnRun');
  const btnCancel = $('btnCancel');
  const progressBlock = $('progressBlock');
  const progressPct = $('progressPct');
  const progressStage = $('progressStage');
  const terminalBody = $('terminalBody');
  const resultSuccess = $('resultSuccess');
  const resultError = $('resultError');
  const resultCancelled = $('resultCancelled');
  const statGrid = $('statGrid');
  const globalStatusDot = $('globalStatusDot');
  const globalStatusText = $('globalStatusText');

  /* ---------------------------------------------------------------- */
  /* Utilities                                                          */
  /* ---------------------------------------------------------------- */
  function normName(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function setGlobalStatus(kind, text) {
    globalStatusDot.className = 'status-dot' + (kind ? ` is-${kind}` : '');
    globalStatusText.textContent = text;
  }

  function toast(message, kind = 'ok') {
    const el = document.createElement('div');
    el.className = `toast toast--${kind}`;
    el.textContent = message;
    $('toasts').appendChild(el);
    el.addEventListener('animationend', (e) => {
      if (e.animationName === 'toastOut') el.remove();
    });
  }

  function termLine(text, cls = '') {
    const line = document.createElement('div');
    line.className = `term-line ${cls}`.trim();
    line.textContent = text;
    terminalBody.appendChild(line);
    terminalBody.scrollTop = terminalBody.scrollHeight;
  }

  function clearTerminal() { terminalBody.innerHTML = ''; }

  function fmtInt(n) { return Number(n || 0).toLocaleString('en-US'); }

  /**
   * Build a mechanical odometer (one rolling strip of digits 0-9 per
   * position, comma separators static) inside `el`, then roll it to
   * `target`. Rightmost digits settle first, leftmost last — like a slot
   * machine reading left to right.
   */
  function renderOdometer(el, target) {
    const str = fmtInt(target);
    el.innerHTML = '';
    el.classList.add('odo');
    const digitEls = [];

    for (const ch of str) {
      if (ch === ',') {
        const sep = document.createElement('span');
        sep.className = 'odo-sep';
        sep.textContent = ',';
        el.appendChild(sep);
        continue;
      }
      const digit = document.createElement('span');
      digit.className = 'odo-digit';
      const strip = document.createElement('span');
      strip.className = 'odo-strip';
      for (let d = 0; d <= 9; d++) {
        const s = document.createElement('span');
        s.textContent = String(d);
        strip.appendChild(s);
      }
      digit.appendChild(strip);
      el.appendChild(digit);
      digitEls.push({ strip, value: Number(ch) });
    }

    const total = digitEls.length;
    digitEls.forEach((d, i) => {
      d.strip.style.transform = 'translateY(0)';
      // Settle left-to-right with the rightmost digit lagging slightly.
      d.strip.style.transitionDelay = `${(total - 1 - i) * 70}ms`;
      requestAnimationFrame(() => {
        d.strip.style.transform = `translateY(-${d.value * 10}%)`;
      });
    });
  }

  /** Fill/empty a row of "ticket" ticks to represent `pct` (0-100). */
  const TICKET_TICK_COUNT = 25;
  function initTicketStrip() {
    const strip = $('ticketStrip');
    strip.innerHTML = '';
    for (let i = 0; i < TICKET_TICK_COUNT; i++) {
      const tick = document.createElement('span');
      tick.className = 'ticket-tick';
      strip.appendChild(tick);
    }
  }
  function setTicketProgress(pct) {
    const ticks = $('ticketStrip').children;
    const filled = Math.round((pct / 100) * TICKET_TICK_COUNT);
    for (let i = 0; i < ticks.length; i++) {
      ticks[i].classList.toggle('is-filled', i < filled);
      ticks[i].classList.toggle('is-accent', i === filled - 1);
    }
  }

  async function callApi(method, ...args) {
    if (!state.apiReady || !window.pywebview || !window.pywebview.api) {
      throw new Error('Backend not ready yet — please wait a moment and try again.');
    }
    return window.pywebview.api[method](...args);
  }

  /* ---------------------------------------------------------------- */
  /* Stepper — exactly one panel visible at a time. The top step nav and   */
  /* each panel's Back/Next buttons all funnel through goToStep(); a step  */
  /* only becomes reachable once its prerequisite is actually met (see    */
  /* isStepUnlocked), so the nav can't be used to skip ahead of what's    */
  /* actually been done yet.                                              */
  /* ---------------------------------------------------------------- */
  const STEP_ORDER = ['files', 'mapping', 'options', 'run'];
  const STEP_PANEL_ID = {
    files: 'panel-files', mapping: 'panel-mapping',
    options: 'panel-options', run: 'panel-run',
  };
  let currentStep = 'files';

  function isStepUnlocked(step) {
    const idx = STEP_ORDER.indexOf(step);
    if (idx <= 0) return true;
    if (state.rows.length === 0) return false; // mapping/options/run all need columns loaded
    if (idx >= 2 && !state.rows.some((r) => r.target)) return false; // options/run need >=1 mapped column
    return true;
  }

  function updateStepNav() {
    const currentIdx = STEP_ORDER.indexOf(currentStep);
    document.querySelectorAll('.steps__item').forEach((item) => {
      const step = item.dataset.step;
      const idx = STEP_ORDER.indexOf(step);
      item.classList.toggle('is-active', step === currentStep);
      item.classList.toggle('is-done', idx < currentIdx);
      item.classList.toggle('is-locked', step !== currentStep && !isStepUnlocked(step));
    });
  }

  function updateStepGates() {
    const mappedCount = state.rows.filter((r) => r.target).length;
    $('btnMappingNext').disabled = mappedCount === 0;
    $('mappingNextMsg').textContent = mappedCount === 0 ? 'Map at least one column to continue.' : '';
    updateStepNav();
  }

  function goToStep(step) {
    if (step !== currentStep && !isStepUnlocked(step)) return;
    currentStep = step;
    STEP_ORDER.forEach((s) => {
      const panel = document.getElementById(STEP_PANEL_ID[s]);
      if (s === step) {
        panel.hidden = false;
        // Re-trigger the slide-in transition on every visit, not just the
        // first: drop .is-visible, force a reflow, then re-add it.
        panel.classList.remove('is-visible');
        void panel.offsetWidth;
        panel.classList.add('is-visible');
      } else {
        panel.hidden = true;
      }
    });
    updateStepGates();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function initStepper() {
    document.querySelectorAll('.steps__item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        goToStep(item.dataset.step);
      });
    });

    $('btnMappingBack').addEventListener('click', () => goToStep('files'));
    $('btnMappingNext').addEventListener('click', () => goToStep('options'));
    $('btnOptionsBack').addEventListener('click', () => goToStep('mapping'));
    $('btnOptionsNext').addEventListener('click', () => goToStep('run'));
    $('btnRunBack').addEventListener('click', () => { if (!state.running) goToStep('options'); });

    requestAnimationFrame(() => $('panel-files').classList.add('is-visible'));
    updateStepGates();
  }

  /* ---------------------------------------------------------------- */
  /* Dropzones                                                          */
  /* ---------------------------------------------------------------- */
  function initDropzones() {
    ['source', 'target'].forEach((side) => {
      const el = dz[side];

      const activate = () => pickFile(side);
      el.addEventListener('click', activate);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
      });

      // Drag visuals only — the browser File API cannot give us an absolute
      // OS path for a dropped file, so we still defer to the native picker.
      // We MUST preventDefault on dragover/drop or the webview will try to
      // navigate to the dropped file as a page.
      ['dragenter', 'dragover'].forEach((evt) => {
        el.addEventListener(evt, (e) => {
          e.preventDefault();
          el.classList.add('is-drag');
        });
      });
      ['dragleave', 'dragend'].forEach((evt) => {
        el.addEventListener(evt, () => el.classList.remove('is-drag'));
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('is-drag');
        pickFile(side);
      });
    });
  }

  async function pickFile(side) {
    try {
      const result = await callApi('pick_file', side);
      if (!result) return; // user cancelled
      state[side].path = result.path;
      state[side].name = result.name;
      state[side].sheet = '';

      fileName[side].textContent = result.name;
      fileBox[side].hidden = false;
      dz[side].classList.add('has-file');

      const sheets = await callApi('list_sheets', result.path);
      state[side].sheets = sheets || [];
      const sel = sheetSel[side];
      sel.innerHTML = '';
      if (sheets && sheets.length > 1) {
        sheets.forEach((s) => {
          const opt = document.createElement('option');
          opt.value = s; opt.textContent = s;
          sel.appendChild(opt);
        });
        sel.hidden = false;
        state[side].sheet = sheets[0];
      } else {
        sel.hidden = true;
        state[side].sheet = sheets && sheets[0] || '';
      }
      updateLoadColumnsEnabled();
    } catch (err) {
      toast(`Could not read "${side}" file: ${err.message || err}`, 'err');
    }
  }

  sheetSel.source.addEventListener('change', (e) => { state.source.sheet = e.target.value; });
  sheetSel.target.addEventListener('change', (e) => { state.target.sheet = e.target.value; });

  function updateLoadColumnsEnabled() {
    btnLoadColumns.disabled = !(state.source.path && state.target.path);
  }

  /* ---------------------------------------------------------------- */
  /* Load columns + mapping table                                       */
  /* ---------------------------------------------------------------- */
  btnLoadColumns.addEventListener('click', async () => {
    btnLoadColumns.disabled = true;
    loadColumnsMsg.className = 'inline-msg';
    loadColumnsMsg.textContent = 'Reading column headers…';
    try {
      const [sourceCols, targetCols] = await Promise.all([
        callApi('read_columns', state.source.path, state.source.sheet || null),
        callApi('read_columns', state.target.path, state.target.sheet || null),
      ]);
      state.sourceCols = sourceCols || [];
      state.targetCols = targetCols || [];
      buildMappingRows();
      loadColumnsMsg.className = 'inline-msg is-ok';
      const autoCount = state.rows.filter((r) => r.target).length;
      loadColumnsMsg.textContent =
        `Loaded ${state.sourceCols.length} source / ${state.targetCols.length} target columns — ${autoCount} auto-matched.`;
      goToStep('mapping');
    } catch (err) {
      loadColumnsMsg.className = 'inline-msg is-err';
      loadColumnsMsg.textContent = `Failed: ${err.message || err}`;
    } finally {
      updateLoadColumnsEnabled();
    }
  });

  function buildMappingRows() {
    const targetByNorm = new Map();
    state.targetCols.forEach((t) => {
      const n = normName(t);
      if (!targetByNorm.has(n)) targetByNorm.set(n, t);
    });
    state.rows = state.sourceCols.map((col) => ({
      source: col,
      target: targetByNorm.get(normName(col)) || '',
      key: false,
      date: false,
      include: false,
    }));
    renderMappingTable();
    mappingFilter.disabled = false;
  }

  function renderMappingTable() {
    // Remove existing body rows (keep header + empty placeholder node around).
    mappingTable.querySelectorAll('.mapping-row--body').forEach((n) => n.remove());
    mappingEmpty.hidden = state.rows.length > 0;

    const filterText = normName(mappingFilter.value);
    let visibleCount = 0;

    state.rows.forEach((row, i) => {
      const matches = !filterText || normName(row.source).includes(filterText);
      if (matches) visibleCount++;

      const el = document.createElement('div');
      el.className = 'mapping-row mapping-row--body' + (matches ? '' : ' is-hidden');
      el.style.animationDelay = `${Math.min(i, 24) * 18}ms`;

      const badge = row.target
        ? `<span class="mapping-col__badge mapping-col__badge--auto">auto</span>`
        : `<span class="mapping-col__badge mapping-col__badge--none">unmapped</span>`;

      el.innerHTML = `
        <span class="mapping-col__name">${escapeHtml(row.source)} ${badge}</span>
        <select class="select" data-role="target" data-i="${i}">
          <option value="">— none —</option>
          ${state.targetCols.map((t) => `<option value="${escapeHtml(t)}" ${t === row.target ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}
        </select>
        <span class="center"><button class="switch ${row.key ? 'is-on' : ''}" data-role="key" data-i="${i}" role="switch" aria-checked="${row.key}"><span class="switch__thumb"></span></button></span>
        <span class="center"><button class="switch ${row.date ? 'is-on' : ''}" data-role="date" data-i="${i}" role="switch" aria-checked="${row.date}"><span class="switch__thumb"></span></button></span>
        <span class="center"><button class="switch ${row.include ? 'is-on' : ''}" data-role="include" data-i="${i}" role="switch" aria-checked="${row.include}"><span class="switch__thumb"></span></button></span>
      `;
      mappingTable.appendChild(el);
    });

    const mappedCount = state.rows.filter((r) => r.target).length;
    const keyCount = state.rows.filter((r) => r.key).length;
    mappingStats.textContent = state.rows.length
      ? `${visibleCount}/${state.rows.length} shown · ${mappedCount} mapped · ${keyCount} key`
      : 'No columns loaded';
    updateStepGates();
  }

  mappingFilter.addEventListener('input', renderMappingTable);

  mappingTable.addEventListener('change', (e) => {
    const role = e.target.dataset.role;
    if (role !== 'target') return;
    const i = Number(e.target.dataset.i);
    state.rows[i].target = e.target.value;
    renderMappingTable();
  });

  mappingTable.addEventListener('click', (e) => {
    const btn = e.target.closest('.switch');
    if (!btn) return;
    const role = btn.dataset.role;
    const i = Number(btn.dataset.i);
    if (!(role in state.rows[i])) return;
    state.rows[i][role] = !state.rows[i][role];
    btn.classList.toggle('is-on', state.rows[i][role]);
    btn.setAttribute('aria-checked', String(state.rows[i][role]));

    // A Key column drives row-matching, so it always needs to travel with
    // the comparison — turning Key on implicitly turns Include on too, same
    // row, kept in sync without a full table re-render.
    if (role === 'key' && state.rows[i].key && !state.rows[i].include) {
      state.rows[i].include = true;
      const includeBtn = mappingTable.querySelector(`.switch[data-role="include"][data-i="${i}"]`);
      if (includeBtn) {
        includeBtn.classList.add('is-on');
        includeBtn.setAttribute('aria-checked', 'true');
      }
    }

    if (role === 'key' || role === 'target') {
      const mappedCount = state.rows.filter((r) => r.target).length;
      const keyCount = state.rows.filter((r) => r.key).length;
      mappingStats.textContent = `${state.rows.length}/${state.rows.length} shown · ${mappedCount} mapped · ${keyCount} key`;
      updateStepGates();
    }
  });

  /* ---------------------------------------------------------------- */
  /* Options                                                            */
  /* ---------------------------------------------------------------- */
  function initSwitch(id) {
    const el = $(id);
    el.addEventListener('click', () => {
      const on = !el.classList.contains('is-on');
      el.classList.toggle('is-on', on);
      el.setAttribute('aria-checked', String(on));
    });
  }
  initSwitch('optCaseSensitive');
  initSwitch('optFullData');

  $('btnPickOutputDir').addEventListener('click', async () => {
    try {
      const dir = await callApi('pick_output_dir');
      if (dir) $('optOutputDir').value = dir;
    } catch (err) {
      toast(`Could not open folder picker: ${err.message || err}`, 'err');
    }
  });

  /* ---------------------------------------------------------------- */
  /* Run validation                                                     */
  /* ---------------------------------------------------------------- */
  function collectParams() {
    const mappings = {};
    const keyColumns = [];
    const includedColumns = [];
    const dateColumns = [];
    const dateColumnsTarget = [];

    state.rows.forEach((r) => {
      if (r.target) {
        mappings[r.source] = r.target;
        if (r.date) { dateColumns.push(r.source); dateColumnsTarget.push(r.target); }
      }
      if (r.key) keyColumns.push(r.source);
      if (r.include) includedColumns.push(r.source);
    });

    if (Object.keys(mappings).length === 0) {
      throw new Error('No columns are mapped. Pick at least one Target column in the mapping table.');
    }
    const missingKeyTargets = keyColumns.filter((k) => !mappings[k]);
    if (missingKeyTargets.length) {
      throw new Error(`These Key columns have no Target column selected: ${missingKeyTargets.join(', ')}`);
    }
    if (!keyColumns.length) {
      throw new Error('Select at least one Key column (used to match rows between files).');
    }
    const outputDir = $('optOutputDir').value.trim();
    if (!outputDir) {
      throw new Error('Choose an output folder in Step 03.');
    }

    return {
      legacy_path: state.source.path,
      oracle_path: state.target.path,
      legacy_filename: state.source.name,
      oracle_filename: state.target.name,
      mappings,
      keyColumns,
      includedColumns,
      dateColumns,
      timestampColumns: [],
      dateColumnstarget: dateColumnsTarget,
      timestampColumnstarget: [],
      legacySheet: state.source.sheet || null,
      oracleSheet: state.target.sheet || null,
      includeSourceTargetFiles: $('optFullData').classList.contains('is-on'),
      sourceLabel: $('optSourceLabel').value.trim() || 'Source',
      targetLabel: $('optTargetLabel').value.trim() || 'Target',
      caseSensitive: $('optCaseSensitive').classList.contains('is-on'),
      output_dir: outputDir,
    };
  }

  btnRun.addEventListener('click', async () => {
    let params;
    try {
      params = collectParams();
    } catch (err) {
      toast(err.message, 'err');
      return;
    }

    state.running = true;
    resultSuccess.hidden = true;
    resultError.hidden = true;
    resultCancelled.hidden = true;
    clearTerminal();
    progressBlock.hidden = false;
    setTicketProgress(0);
    progressPct.textContent = '0%';
    progressStage.textContent = 'Starting…';
    btnRun.disabled = true;
    btnCancel.hidden = false;
    $('btnRunBack').disabled = true;
    setGlobalStatus('busy', 'Running');
    termLine('Starting validation…', 'is-dim');

    try {
      const res = await callApi('start_validation', params);
      if (!res || res.ok === false) {
        throw new Error((res && res.error) || 'Failed to start.');
      }
    } catch (err) {
      onValidationError(err.message || String(err));
    }
  });

  btnCancel.addEventListener('click', async () => {
    btnCancel.disabled = true;
    termLine('Cancelling…', 'is-dim');
    try { await callApi('cancel_validation'); } catch (_) { /* best effort */ }
  });

  function resetRunButtons() {
    btnRun.disabled = false;
    btnCancel.hidden = true;
    btnCancel.disabled = false;
    $('btnRunBack').disabled = false;
    state.running = false;
  }

  function onValidationError(message) {
    resetRunButtons();
    setGlobalStatus('err', 'Failed');
    termLine(`ERROR: ${message}`, 'is-err');
    resultError.hidden = false;
    $('resultErrorMsg').textContent = message;
  }
  $('btnDismissError').addEventListener('click', () => { resultError.hidden = true; });

  /* These are called directly by Python via window.evaluate_js(...). */
  window.__onProgress = (pct, stage) => {
    setTicketProgress(pct);
    progressPct.textContent = `${pct}%`;
    progressStage.textContent = stage;
    termLine(`[${String(pct).padStart(3, ' ')}%] ${stage}`);
  };

  window.__onDone = (result) => {
    resetRunButtons();
    setGlobalStatus('ok', 'Done');
    setTicketProgress(100);
    progressPct.textContent = '100%';
    termLine(`Complete in ${result.elapsed_seconds}s.`, 'is-ok');

    resultSuccess.hidden = false;
    $('resultElapsed').textContent =
      `${fmtInt(result.legacy_count)} source rows vs ${fmtInt(result.oracle_count)} target rows — finished in ${result.elapsed_seconds}s.`;

    statGrid.innerHTML = `
      <div class="stat-card stat-card--err"><span class="stat-card__value" data-count="${result.total_discrepancies}">0</span><span class="stat-card__label">Discrepancies</span></div>
      <div class="stat-card stat-card--warn"><span class="stat-card__value" data-count="${result.count_missing_in_target}">0</span><span class="stat-card__label">Missing in Target</span></div>
      <div class="stat-card stat-card--warn"><span class="stat-card__value" data-count="${result.count_missing_in_source}">0</span><span class="stat-card__label">Missing in Source</span></div>
      <div class="stat-card stat-card--ok"><span class="stat-card__value" data-count="${result.unique_discrepant_records}">0</span><span class="stat-card__label">Records Affected</span></div>
    `;
    statGrid.querySelectorAll('[data-count]').forEach((el) => renderOdometer(el, Number(el.dataset.count)));

    const extras = [];
    ['discrepancies_csv', 'missing_in_target_csv', 'missing_in_source_csv', 'full_data_csv'].forEach((k) => {
      if (result[k]) extras.push(result[k]);
    });
    $('resultExtraFiles').textContent = extras.length
      ? `Also written (exceeded sheet row cap): ${extras.join(' · ')}` : '';

    btnOpenReportPath = result.output_path;
    btnOpenFolderPath = result.output_path;
    toast('Validation complete.', 'ok');
  };

  window.__onError = (message) => onValidationError(message);

  window.__onCancelled = () => {
    resetRunButtons();
    setGlobalStatus(null, 'Idle');
    termLine('Cancelled by user.', 'is-dim');
    resultCancelled.hidden = false;
  };

  let btnOpenReportPath = '';
  let btnOpenFolderPath = '';
  $('btnOpenReport').addEventListener('click', () => callApi('open_path', btnOpenReportPath).catch((e) => toast(String(e), 'err')));
  $('btnOpenFolder').addEventListener('click', () => callApi('reveal_in_folder', btnOpenFolderPath).catch((e) => toast(String(e), 'err')));

  /* ---------------------------------------------------------------- */
  /* Custom OS titlebar — window is frameless, this drives Api chrome   */
  /* methods (minimize/maximize/close/resize) exposed by desktop_app.py */
  /* ---------------------------------------------------------------- */
  function initTitlebar() {
    const btnMin = $('btnWinMinimize');
    const btnMax = $('btnWinMaximize');
    const btnClose = $('btnWinClose');
    const iconMaximize = $('iconMaximize');
    const dragRegion = $('osTitlebarDrag');

    function applyMaximized(isMax) {
      document.body.classList.toggle('is-maximized', isMax);
      // Square glyph while normal; overlapped-squares "restore" glyph while maximized.
      iconMaximize.innerHTML = isMax
        ? '<rect x="1" y="2.5" width="6" height="6"/><path d="M3 2.5V1.5h6v6H8"/>'
        : '<rect x="1.5" y="1.5" width="7" height="7"/>';
    }

    btnMin.addEventListener('click', () => callApi('minimize_window').catch(() => {}));
    btnClose.addEventListener('click', () => callApi('close_window').catch(() => {}));
    btnMax.addEventListener('click', async () => {
      try {
        const res = await callApi('toggle_maximize_window');
        applyMaximized(!!(res && res.maximized));
      } catch (_) { /* best effort */ }
    });
    dragRegion.addEventListener('dblclick', () => btnMax.click());

    /* ---- edge/corner resize (frameless windows have no OS border) --- */
    let resizing = null; // { edge, startX, startY, startW, startH }
    let pendingFrame = null;

    function onResizeMove(e) {
      if (!resizing) return;
      const dx = e.screenX - resizing.startX;
      const dy = e.screenY - resizing.startY;
      const edge = resizing.edge;
      let w = resizing.startW, h = resizing.startH;
      if (edge.includes('e')) w = resizing.startW + dx;
      if (edge.includes('w')) w = resizing.startW - dx;
      if (edge.includes('s')) h = resizing.startH + dy;
      if (edge.includes('n')) h = resizing.startH - dy;
      if (pendingFrame) return;
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = null;
        callApi('resize_window', edge, Math.round(w), Math.round(h)).catch(() => {});
      });
    }
    function onResizeUp() {
      resizing = null;
      window.removeEventListener('mousemove', onResizeMove);
      window.removeEventListener('mouseup', onResizeUp);
    }
    document.querySelectorAll('.ez').forEach((handle) => {
      handle.addEventListener('mousedown', (e) => {
        if (document.body.classList.contains('is-maximized')) return;
        e.preventDefault();
        resizing = {
          edge: handle.dataset.edge,
          startX: e.screenX, startY: e.screenY,
          startW: window.innerWidth, startH: window.innerHeight,
        };
        window.addEventListener('mousemove', onResizeMove);
        window.addEventListener('mouseup', onResizeUp);
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* Auto-update banner — GitHub-Desktop-style "update available" bar.  */
  /* desktop_app.py's Api.check_for_updates() runs once per launch; if a  */
  /* newer release exists it starts downloading it immediately in the   */
  /* background (no click needed) and pushes progress here. The banner  */
  /* only asks for a click once the download is actually done, to pick  */
  /* when to restart — everything below is just reacting to those       */
  /* pushes, never initiating the download itself.                      */
  /* ---------------------------------------------------------------- */
  function initUpdateBanner() {
    const banner = $('updateBanner');
    const text = $('updateBannerText');
    const btnNow = $('btnUpdateNow');
    const btnLater = $('btnUpdateLater');
    let updateReady = false;

    btnLater.addEventListener('click', () => { banner.hidden = true; });

    btnNow.addEventListener('click', async () => {
      if (!updateReady) return;
      btnNow.disabled = true;
      btnLater.disabled = true;
      text.textContent = 'Installing — the app will restart automatically…';
      try {
        await callApi('restart_and_install_update');
      } catch (err) {
        text.textContent = `Update failed: ${err.message || err}`;
        btnNow.disabled = false;
        btnLater.disabled = false;
      }
    });

    window.__onUpdateAvailable = (version, _sizeBytes, releaseUrl) => {
      void releaseUrl; // not linked out to yet; reserved for a future "What's new" click-through
      updateReady = false;
      btnNow.hidden = true; // nothing to click until the background download finishes
      text.textContent = `Downloading DELTA v${version}… 0%`;
      banner.hidden = false;
    };

    window.__onUpdateDownloadProgress = (pct) => {
      text.textContent = `Downloading update… ${pct}%`;
    };

    window.__onUpdateReadyToRestart = () => {
      updateReady = true;
      text.textContent = 'Update downloaded — restart to finish installing.';
      btnNow.hidden = false;
      btnNow.disabled = false;
    };

    window.__onUpdateError = (message) => {
      text.textContent = `Update failed: ${message}`;
      banner.hidden = false;
      btnNow.hidden = true;
      btnLater.disabled = false;
    };
  }

  /* ---------------------------------------------------------------- */
  /* Welcome / init dialog                                              */
  /* ---------------------------------------------------------------- */
  const WELCOME_SKIP_KEY = 'delta.skipWelcome';

  function initWelcome() {
    const overlay = $('welcomeOverlay');
    const skipBox = $('welcomeSkip');
    let skipPersisted = false;
    try { skipPersisted = localStorage.getItem(WELCOME_SKIP_KEY) === '1'; } catch (_) { /* storage unavailable */ }

    const close = () => {
      let shouldSkip = false;
      try { shouldSkip = skipBox.checked; } catch (_) { /* ignore */ }
      overlay.classList.remove('is-open');
      if (shouldSkip) {
        try { localStorage.setItem(WELCOME_SKIP_KEY, '1'); } catch (_) { /* ignore */ }
      }
      document.removeEventListener('keydown', onKeydown);
    };
    const onKeydown = (e) => { if (e.key === 'Escape') close(); };

    if (!skipPersisted) {
      // Small delay so the entrance feels intentional rather than a flash
      // on top of an unrendered page.
      setTimeout(() => {
        overlay.classList.add('is-open');
        document.addEventListener('keydown', onKeydown);
        $('welcomeStart').focus();
      }, 220);
    }

    $('welcomeStart').addEventListener('click', close);
    $('welcomeClose').addEventListener('click', close);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  }

  /* ---------------------------------------------------------------- */
  /* Boot                                                                */
  /* ---------------------------------------------------------------- */
  initTitlebar();
  initUpdateBanner();
  initWelcome();
  initStepper();
  initDropzones();
  initTicketStrip();

  window.addEventListener('pywebviewready', () => {
    state.apiReady = true;
    setGlobalStatus(null, 'Idle');
  });
  // Fallback in case the event already fired before this script attached
  // (pywebview injects the bridge before document scripts run in some
  // versions) — poll briefly for window.pywebview.api as a safety net.
  let tries = 0;
  const poll = setInterval(() => {
    if (window.pywebview && window.pywebview.api) {
      state.apiReady = true;
      setGlobalStatus(null, 'Idle');
      clearInterval(poll);
    } else if (++tries > 100) {
      clearInterval(poll);
    }
  }, 50);
})();
