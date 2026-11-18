/**
 * Browser-side injection script for Antigravity Quota Injector.
 * Version and formatting helpers are spliced in by daemon.mjs.
 */
(function bootAntigravityQuotaInjector(fromDcl) {
  if (window.top !== window) return;

  const isHost = () => {
    if (window.__APP_CONFIG__ && window.__APP_CONFIG__.productName === 'antigravity') return true;
    return !!(typeof document !== 'undefined' && document.getElementById('antigravity.agentSidePanelInputBox'));
  };

  if (typeof document === 'undefined' || !document.body) {
    if (typeof document !== 'undefined' && !fromDcl && document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => bootAntigravityQuotaInjector(true), { once: true });
    }
    return;
  }

  if (!isHost()) {
    if (!fromDcl && document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => bootAntigravityQuotaInjector(true), { once: true });
    }
    return;
  }

  const INJECT_VERSION = '__AQ_VERSION__';
  const CODEX_THEME_CSS = __AQ_CODEX_THEME_CSS__;
  if (window.__aq_version === INJECT_VERSION && document.getElementById('aq-style')) {
    return;
  }

  if (typeof window.__aqCleanup === 'function') {
    try {
      window.__aqCleanup();
    } catch {}
  }

  // __AQ_FORMATTING_HELPERS__
  // __AQ_I18N_HELPERS__

  const TURN_TOOLTIP_DELAY_MS = 500;
  const QUOTA_TOOLTIP_DELAY_MS = 300;

  const state = {
    cascadeId: '',
    turnsPayload: null,
    quotaData: null,
    quotaFetchedAt: 0,
    quotaFetching: false,
    quotaError: '',
    selectedModelLabel: '',
    renderRaf: 0,
    quotaTimer: null,
    lastTurnsCid: '',
    routeTimer: null,
    domObserver: null,
    footerObserver: null,
    observedFooterBox: null,
    turnTooltipAnchor: null,
    turnTooltipShowTimer: null,
    turnTooltipHideTimer: null,
    quotaTooltipAnchor: null,
    quotaTooltipShowTimer: null,
    quotaTooltipHideTimer: null,
    quotaTooltipPinned: false,
    userProfile: null,
    accounts: [],
    accountsMetaLoaded: false,
    accountsSupported: true,
    accountsUnsupportedReason: '',
    accountsBusy: false,
    accountsStatus: '',
    accountsError: '',
    pendingSwitchConfirmId: '',
    pendingSwitchTimer: null,
    autoSavedEmail: '',
    updateInfo: null,
    updateOpening: false,
    updateRequestId: '',
    isTranslating: false,
    cleanups: [],
  };

  function bindTooltipTrigger(triggerEl, { tooltipId, delayMs, showTimerKey, hideTimerKey, anchorKey, showFn, hideFn }) {
    const clearShowTimer = () => {
      if (state[showTimerKey]) {
        clearTimeout(state[showTimerKey]);
        state[showTimerKey] = null;
      }
    };
    triggerEl.addEventListener('pointerenter', () => {
      clearShowTimer();
      const tt = document.getElementById(tooltipId);
      if (tt?.getAttribute('data-visible') === '1' && state[anchorKey] === triggerEl) {
        if (state[hideTimerKey]) {
          clearTimeout(state[hideTimerKey]);
          state[hideTimerKey] = null;
        }
        return;
      }
      state[showTimerKey] = setTimeout(() => {
        state[showTimerKey] = null;
        if (triggerEl.isConnected) showFn(triggerEl);
      }, delayMs);
    });
    triggerEl.addEventListener('pointerleave', (ev) => {
      clearShowTimer();
      const tt = document.getElementById(tooltipId);
      if (tt && ev.relatedTarget && tt.contains(ev.relatedTarget)) return;
      hideFn();
    });
    triggerEl.addEventListener('focus', () => {
      clearShowTimer();
      showFn(triggerEl);
    });
    triggerEl.addEventListener('blur', () => {
      clearShowTimer();
      hideFn();
    });
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function injectStyles() {
    let themeStyle = document.getElementById('aq-codex-theme');
    if (CODEX_THEME_CSS) {
      if (!themeStyle) {
        themeStyle = document.createElement('style');
        themeStyle.id = 'aq-codex-theme';
        (document.head || document.documentElement).appendChild(themeStyle);
      }
      if (themeStyle.textContent !== CODEX_THEME_CSS) {
        themeStyle.textContent = CODEX_THEME_CSS;
      }
    } else if (themeStyle) {
      themeStyle.remove();
    }

    let style = document.getElementById('aq-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'aq-style';
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = `
      [data-aq-turn-usage] {
        display: block;
        width: 100%;
        margin: 6px 0 2px 0;
        padding: 0 2px;
        color: var(--muted-foreground, #71717a);
        font: 500 11px/16px var(--font-sans, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
        font-variant-numeric: tabular-nums;
        white-space: normal;
        overflow-wrap: anywhere;
        opacity: 0.86;
        user-select: text;
        cursor: default;
        transition: opacity 0.12s ease, color 0.12s ease;
      }
      [data-aq-turn-usage]:hover,
      [data-aq-turn-usage]:focus-visible {
        opacity: 1;
        color: var(--foreground, #18181b);
        outline: none;
      }

      #aq-context-chip,
      #aq-quota-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        height: 26px;
        padding: 0 8px;
        margin-right: 4px;
        border-radius: 9999px;
        border: 1px solid var(--border, rgba(127, 127, 127, 0.22));
        background: transparent;
        color: var(--secondary-foreground, var(--foreground, #3f3f46));
        font: 500 11.5px/1 var(--font-sans, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        cursor: pointer;
        user-select: none;
        transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease;
      }
      #aq-context-chip {
        cursor: default;
      }
      #aq-context-chip:hover,
      #aq-context-chip:focus-visible,
      #aq-quota-chip:hover,
      #aq-quota-chip:focus-visible {
        background: var(--secondary, rgba(127, 127, 127, 0.1));
        border-color: var(--border, rgba(127, 127, 127, 0.36));
        outline: none;
      }
      #aq-quota-chip[data-loading="1"] {
        opacity: 0.72;
      }
      #aq-quota-chip .aq-chip-sep {
        margin: 0 1px;
        opacity: 0.45;
      }
      .aq-lvl-ok {
        color: #15803d;
      }
      .aq-lvl-warn {
        color: #b45309;
      }
      .aq-lvl-crit {
        color: #dc2626;
      }
      .aq-lvl-muted {
        color: var(--muted-foreground, #71717a);
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-lvl-ok {
        color: #4ade80;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-lvl-warn {
        color: #fbbf24;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-lvl-crit {
        color: #f87171;
      }

      .aq-floating-tooltip {
        position: fixed;
        z-index: 2147483647;
        min-width: 240px;
        max-width: 340px;
        padding: 11px 13px;
        border-radius: 10px;
        background: #ffffff;
        color: #202124;
        border: 1px solid rgba(15, 23, 42, 0.08);
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16), 0 2px 6px rgba(0, 0, 0, 0.06);
        font: 400 11px/1.5 var(--font-sans, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
        font-variant-numeric: tabular-nums;
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
        transform: translateY(4px);
        transition: opacity 0.12s ease, transform 0.12s ease, visibility 0.12s ease;
      }
      #aq-turn-tooltip {
        min-width: 340px;
        max-width: 430px;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-floating-tooltip {
        background: #24242d;
        color: #f4f4f7;
        border-color: rgba(255, 255, 255, 0.1);
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.42), 0 2px 8px rgba(0, 0, 0, 0.28);
      }
      .aq-floating-tooltip[data-visible="1"] {
        opacity: 1;
        visibility: visible;
        transform: translateY(0);
        pointer-events: auto;
      }

      .aq-tt-hdr {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 16px;
        font-weight: 650;
        font-size: 11.5px;
        margin-bottom: 8px;
      }
      .aq-tt-sub {
        font-size: 10px;
        font-weight: 450;
        color: #71717a;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-tt-sub {
        color: #9a9aa4;
      }
      .aq-tt-section {
        display: grid;
        gap: 5px;
        padding: 7px 0;
        border-top: 1px solid rgba(127, 127, 127, 0.2);
        border-bottom: 1px solid rgba(127, 127, 127, 0.2);
      }
      .aq-tt-grid {
        display: grid;
        gap: 4px;
      }
      .aq-tt-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: baseline;
        gap: 16px;
      }
      .aq-tt-row-strong {
        font-weight: 650;
      }
      .aq-tt-row-sec .aq-tt-lbl {
        color: #5f6368;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-tt-row-sec .aq-tt-lbl {
        color: #b2b2bc;
      }
      .aq-tt-row-ter {
        color: #71717a;
        font-size: 10px;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-tt-row-ter {
        color: #9a9aa4;
      }
      .aq-tt-lbl {
        color: #71717a;
        min-width: 0;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-tt-lbl {
        color: #9a9aa4;
      }
      .aq-tt-row-strong .aq-tt-lbl {
        color: inherit;
      }
      .aq-tt-val {
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        text-align: right;
      }
      .aq-tt-details {
        margin-top: 2px;
        padding-top: 5px;
        border-top: 1px solid rgba(127, 127, 127, 0.14);
      }
      .aq-tt-details summary {
        cursor: pointer;
        color: #71717a;
        font-size: 10px;
        user-select: none;
        list-style-position: inside;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-tt-details summary {
        color: #9a9aa4;
      }
      .aq-tt-details-body {
        display: grid;
        gap: 5px;
        margin-top: 5px;
        max-height: 240px;
        overflow-x: hidden;
        overflow-y: auto;
        scrollbar-gutter: stable;
      }
      .aq-tt-req-hdr {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: baseline;
        gap: 12px;
        font-size: 10px;
      }
      .aq-tt-req-name {
        min-width: 0;
        color: #71717a;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-tt-req-name {
        color: #9a9aa4;
      }
      .aq-tt-req-metrics {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .aq-tt-req-details summary {
        cursor: pointer;
        user-select: none;
        list-style-position: outside;
      }
      .aq-tt-req-sub {
        display: grid;
        gap: 4px;
        max-height: 160px;
        overflow-y: auto;
        margin: 4px 0 1px 13px;
        padding: 4px 0 4px 6px;
        border-left: 1px solid rgba(127, 127, 127, 0.2);
      }
      .aq-tt-req-stages {
        display: flex;
        flex-wrap: wrap;
        gap: 2px 10px;
        color: #71717a;
        font-size: 9px;
        font-variant-numeric: tabular-nums;
      }
      .aq-tt-tool-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        color: #71717a;
        font-size: 9px;
        font-variant-numeric: tabular-nums;
      }
      .aq-tt-tool-row > span:first-child {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-tt-req-stages,
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-tt-tool-row {
        color: #9a9aa4;
      }
      .aq-tt-more-btn {
        border: 0;
        padding: 2px 0;
        background: transparent;
        color: #71717a;
        font: inherit;
        font-size: 10px;
        text-align: left;
        cursor: pointer;
      }
      .aq-tt-more-btn:hover {
        text-decoration: underline;
      }
      .aq-tt-cum {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 16px;
        padding-top: 7px;
        font-weight: 650;
      }
      .aq-tt-meta {
        display: grid;
        gap: 2px;
        margin-top: 6px;
        color: #71717a;
        font-size: 10px;
        line-height: 14px;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-tt-meta {
        color: #9a9aa4;
      }

      .aq-q-group {
        padding: 6px 0;
      }
      .aq-q-group + .aq-q-group {
        border-top: 1px dashed rgba(127, 127, 127, 0.22);
      }
      .aq-q-group-hdr {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-weight: 600;
        font-size: 11px;
        margin-bottom: 4px;
      }
      .aq-q-active-tag {
        font-size: 10px;
        font-weight: 500;
        padding: 1px 6px;
        border-radius: 9999px;
        background: rgba(59, 130, 246, 0.14);
        color: #2563eb;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-active-tag {
        color: #60a5fa;
      }
      .aq-q-group-desc {
        font-size: 10.5px;
        color: var(--muted-foreground, #71717a);
        margin-bottom: 5px;
        line-height: 1.35;
      }
      .aq-q-bucket {
        display: grid;
        grid-template-columns: 1fr auto;
        align-items: center;
        gap: 4px 10px;
        margin-top: 4px;
      }
      .aq-q-bucket-top {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        grid-column: 1 / -1;
        font-size: 11px;
      }
      .aq-q-bar {
        height: 4px;
        border-radius: 9999px;
        background: rgba(127, 127, 127, 0.18);
        overflow: hidden;
      }
      .aq-q-bar-fill {
        height: 100%;
        border-radius: 9999px;
        background: currentColor;
      }
      .aq-q-accounts {
        margin-top: 6px;
        padding-top: 7px;
        border-top: 1px dashed rgba(127, 127, 127, 0.22);
        display: grid;
        gap: 5px;
      }
      .aq-q-acct-hdr {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 11px;
        font-weight: 600;
      }
      .aq-q-acct-actions {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .aq-q-btn {
        appearance: none;
        border: 1px solid rgba(127, 127, 127, 0.24);
        background: transparent;
        color: inherit;
        border-radius: 6px;
        padding: 1px 6px;
        font: inherit;
        font-size: 10px;
        line-height: 16px;
        cursor: pointer;
        white-space: nowrap;
      }
      .aq-q-btn:hover:not(:disabled) {
        background: rgba(127, 127, 127, 0.12);
      }
      .aq-q-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .aq-q-btn-primary {
        border-color: rgba(37, 99, 235, 0.35);
        color: #2563eb;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-btn-primary {
        color: #60a5fa;
      }
      .aq-q-btn-warn {
        border-color: rgba(217, 119, 6, 0.45);
        color: #b45309;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-btn-warn {
        color: #fbbf24;
      }
      .aq-q-acct-list {
        display: grid;
        gap: 4px;
        max-height: 140px;
        overflow-y: auto;
      }
      .aq-q-acct-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 10.5px;
        padding: 3px 6px;
        border-radius: 6px;
        background: rgba(127, 127, 127, 0.06);
      }
      .aq-q-acct-info {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .aq-q-acct-email {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .aq-q-acct-plan {
        margin-left: auto;
        font-size: 9.5px;
        padding: 0 5px;
        border-radius: 9999px;
        background: rgba(127, 127, 127, 0.14);
        color: #71717a;
        flex-shrink: 0;
      }
      .aq-q-acct-note {
        font-size: 10px;
        color: #71717a;
      }
      .aq-q-acct-err {
        font-size: 10px;
        color: #dc2626;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-plan,
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-note {
        color: #9a9aa4;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-err {
        color: #f87171;
      }
      .aq-q-reset {
        font-size: 10px;
        color: var(--muted-foreground, #71717a);
        white-space: nowrap;
      }
      .aq-update-dot {
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 9999px;
        background: #22c55e;
        margin-left: 2px;
        flex-shrink: 0;
      }
      .aq-q-update {
        margin-top: 6px;
        padding-top: 7px;
        border-top: 1px dashed rgba(127, 127, 127, 0.22);
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        justify-content: flex-end;
        gap: 4px 10px;
        font-size: 10px;
      }
      .aq-update-open {
        appearance: none;
        border: 0;
        padding: 2px 0;
        margin-left: auto;
        background: transparent;
        color: #16a34a;
        font: inherit;
        font-size: 10px;
        line-height: 1.4;
        cursor: pointer;
        white-space: nowrap;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-update-open {
        color: #4ade80;
      }
      .aq-update-open:hover:not(:disabled) {
        text-decoration: underline;
      }
      .aq-update-open:disabled {
        cursor: default;
        opacity: 0.75;
      }
      .aq-panel-version-text,
      .aq-update-open.aq-panel-version-text {
        margin-left: auto;
        color: var(--muted-foreground, #71717a);
        white-space: nowrap;
        font-size: 10px;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-panel-version-text,
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-update-open.aq-panel-version-text {
        color: #9a9aa4;
      }
      .aq-update-error {
        flex-basis: 100%;
        text-align: right;
        color: #dc2626;
        font-size: 10px;
        overflow-wrap: anywhere;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-update-error {
        color: #f87171;
      }
    `;
  }

  function extractCascadeId() {
    try {
      const m = window.location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
      if (m) return m[1];
      const q = new URLSearchParams(window.location.search).get('cascadeId');
      if (q && /^[0-9a-f-]{36}$/i.test(q)) return q;
      const selected = document.querySelector('[data-testid="conversation-row-sidebar"][data-selected="true"]');
      const cid = selected?.getAttribute('data-cascade-id');
      if (cid && /^[0-9a-f-]{36}$/i.test(cid)) return cid;
    } catch {}
    return '';
  }

  function ensureTooltipEl(id) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.className = 'aq-floating-tooltip';
      document.body.appendChild(el);
    } else if (el.parentElement !== document.body) {
      document.body.appendChild(el);
    }
    return el;
  }

  function positionTooltipAbove(tt, anchorRect) {
    const ttW = tt.offsetWidth || 320;
    const ttH = tt.offsetHeight || 180;
    const left = Math.max(10, Math.min(anchorRect.left, window.innerWidth - ttW - 12));
    const preferTop = anchorRect.top - ttH - 8;
    const top = preferTop >= 10 ? preferTop : Math.min(window.innerHeight - ttH - 10, anchorRect.bottom + 8);
    tt.style.left = `${Math.round(left)}px`;
    tt.style.top = `${Math.round(Math.max(8, top))}px`;
  }

  function showTurnTooltip(lineEl) {
    if (state.turnTooltipShowTimer) {
      clearTimeout(state.turnTooltipShowTimer);
      state.turnTooltipShowTimer = null;
    }
    if (state.turnTooltipHideTimer) {
      clearTimeout(state.turnTooltipHideTimer);
      state.turnTooltipHideTimer = null;
    }
    const turn = lineEl?.__aqTurnData;
    if (!turn) return;
    state.turnTooltipAnchor = lineEl;
    const tt = ensureTooltipEl('aq-turn-tooltip');

    const cacheHit = formatCacheHitRate(turn.cachedInputTokens, turn.inputTokens);
    const firstTok = formatDurationMs(turn.firstTokenLatencyMs) || '—';
    const speed = formatRate(turn.outputSpeed) || '—';
    const modelLabel = turn.model || '未知模型';
    const statusLabel = turn.completed ? '本轮 Token' : '实时统计';
    const callDetails = Array.isArray(turn.callDetails) ? turn.callDetails : [];
    const orderedCalls = callDetails.slice().reverse();
    const renderCallRowsHtml = (limit) => {
      const visibleCalls = orderedCalls.slice(0, limit);
      const rows = visibleCalls
        .map((c, idx) => {
          const title = formatCallDetailTitle(c, idx === 0 && Boolean(turn.completed));
          const cTtft = formatDurationMs(c.ttftMs);
          const cStream = formatDurationMs(c.streamMs);
          const cSpeed = formatRate(c.speed);
          const metricParts = [];
          if (cTtft) metricParts.push(`首字 ${cTtft}`);
          if (cSpeed) {
            metricParts.push(`速率 ${cSpeed}`);
          } else if (c.outTok > 0) {
            metricParts.push(cStream ? `流式 ${cStream} · ${c.outTok} tok` : `短调用 · ${c.outTok} tok`);
          }
          const primaryMetrics = metricParts.join(' · ') || '—';
          const headerHtml = `<div class="aq-tt-req-hdr"><span class="aq-tt-req-name" title="${escapeHtml(title)}">${escapeHtml(title)}</span><span class="aq-tt-req-metrics">${escapeHtml(primaryMetrics)}</span></div>`;

          const toolList = Array.isArray(c.toolCalls) ? c.toolCalls : [];
          const stageParts = [`第 #${c.callIndex} 次`];
          if (cTtft) stageParts.push(`首字 ${cTtft}`);
          if (cStream) stageParts.push(`流式 ${cStream}`);
          if (c.outTok > 0) stageParts.push(`输出 ${formatTokenCount(c.outTok)}`);
          if (cSpeed) stageParts.push(`速率 ${cSpeed}`);
          const stagesHtml = `<div class="aq-tt-req-stages">${stageParts.map((s) => `<span>${escapeHtml(s)}</span>`).join('')}</div>`;
          const toolsHtml = toolList
            .map((tc) => {
              const dur = tc.durationMs != null ? formatDurationMs(tc.durationMs) || '<1ms' : '未记录';
              return `<div class="aq-tt-tool-row"><span title="${escapeHtml(tc.toolName)}">${escapeHtml(tc.toolName)} · 调用耗时</span><span>${escapeHtml(dur)}</span></div>`;
            })
            .join('');

          return `
            <details class="aq-tt-req-details">
              <summary>${headerHtml}</summary>
              <div class="aq-tt-req-sub">${stagesHtml}${toolsHtml}</div>
            </details>
          `;
        })
        .join('');
      const remaining = Math.max(0, orderedCalls.length - limit);
      const moreBtn =
        remaining > 0
          ? `<button type="button" class="aq-tt-more-btn" data-aq-more-calls="${limit + 20}">显示更早 ${Math.min(20, remaining)} 次</button>`
          : '';
      return rows + moreBtn;
    };
    const callsSummaryHtml =
      callDetails.length > 0
        ? `
          <details class="aq-tt-details">
            <summary>请求明细 ${callDetails.length} 次 · 平均首字 ${firstTok} · 平均速率 ${speed}</summary>
            <div class="aq-tt-details-body" data-aq-calls-body>${renderCallRowsHtml(20)}</div>
          </details>
        `
        : '';
    const thinkingHtml =
      Number(turn.thinkingTokens) > 0
        ? `
          <details class="aq-tt-details">
            <summary>显示思考输出 ${formatTokenCount(turn.thinkingTokens)}（已计入输出）</summary>
            <div class="aq-tt-details-body">
              <div class="aq-tt-row aq-tt-row-sec"><span class="aq-tt-lbl">思考输出</span><span class="aq-tt-val">${formatTokenCount(turn.thinkingTokens)}</span></div>
              <div class="aq-tt-row aq-tt-row-sec"><span class="aq-tt-lbl">正文 / 工具输出</span><span class="aq-tt-val">${formatTokenCount(turn.responseTokens)}</span></div>
            </div>
          </details>
        `
        : '';

    tt.innerHTML = `
      <div class="aq-tt-hdr">
        <span>${escapeHtml(modelLabel)}</span>
        <span class="aq-tt-val">${statusLabel} ${formatTokenCount(turn.totalTokens)}</span>
      </div>
      <div class="aq-tt-section">
        <div class="aq-tt-row aq-tt-row-strong"><span class="aq-tt-lbl">输入总量</span><span class="aq-tt-val">${formatTokenCount(turn.inputTokens)}</span></div>
        <div class="aq-tt-row aq-tt-row-sec"><span class="aq-tt-lbl">未缓存输入</span><span class="aq-tt-val">${formatTokenCount(turn.uncachedInputTokens)}</span></div>
        <div class="aq-tt-row aq-tt-row-sec"><span class="aq-tt-lbl">缓存读取</span><span class="aq-tt-val">${formatTokenCount(turn.cachedInputTokens)}</span></div>
        <div class="aq-tt-row aq-tt-row-ter"><span>缓存命中率 ${cacheHit}</span><span class="aq-tt-val">${formatTokenCount(turn.cachedInputTokens)} / ${formatTokenCount(turn.inputTokens)}</span></div>
        <div class="aq-tt-row aq-tt-row-sec"><span class="aq-tt-lbl">输出</span><span class="aq-tt-val">${formatTokenCount(turn.outputTokens)}</span></div>
        ${callsSummaryHtml}
        ${thinkingHtml}
      </div>
      <div class="aq-tt-cum">
        <span>累计 Token</span>
        <span class="aq-tt-val">${formatTokenCount(turn.cumulativeTotalTokens)}</span>
      </div>
      <div class="aq-tt-meta">
        <span>第 ${Number(turn.turnIndex) + 1} 轮 · 首字 ${firstTok} · 速率 ${speed}</span>
        <span>速率按可测流式窗口计算，不含首字排队等待</span>
      </div>
    `;
    const bindCallsPagination = () => {
      const btn = tt.querySelector('[data-aq-more-calls]');
      if (!btn) return;
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const nextLimit = Number(btn.getAttribute('data-aq-more-calls')) || 40;
        const body = tt.querySelector('[data-aq-calls-body]');
        if (!body) return;
        body.innerHTML = renderCallRowsHtml(nextLimit);
        bindCallsPagination();
      });
    };
    bindCallsPagination();
    positionTooltipAbove(tt, lineEl.getBoundingClientRect());
    tt.setAttribute('data-visible', '1');
  }

  function scheduleHideTurnTooltip() {
    if (state.turnTooltipHideTimer) clearTimeout(state.turnTooltipHideTimer);
    state.turnTooltipHideTimer = setTimeout(() => {
      state.turnTooltipHideTimer = null;
      const tt = document.getElementById('aq-turn-tooltip');
      if (tt) tt.removeAttribute('data-visible');
      state.turnTooltipAnchor = null;
    }, 120);
  }

  function mountTurnLine(turnEl, turnData) {
    const toolbar = turnEl.querySelector('[data-testid="cascade-system-message-toolbar"]');
    const toolbarContainer = toolbar?.parentElement && toolbar.parentElement !== turnEl ? toolbar.parentElement : toolbar;
    const host = toolbarContainer?.parentElement || turnEl.querySelector('[data-testid="agent-response"]') || turnEl;

    // Deduplicate across the whole turn container so streaming->completed host transitions never leave a second line behind
    const existingLines = [...turnEl.querySelectorAll('[data-aq-turn-usage]')];
    let line = existingLines[0] || null;
    for (let i = 1; i < existingLines.length; i++) {
      existingLines[i].remove();
    }

    if (!line) {
      line = document.createElement('div');
      line.setAttribute('role', 'status');
      line.setAttribute('tabindex', '0');
      bindTooltipTrigger(line, {
        tooltipId: 'aq-turn-tooltip',
        delayMs: TURN_TOOLTIP_DELAY_MS,
        showTimerKey: 'turnTooltipShowTimer',
        hideTimerKey: 'turnTooltipHideTimer',
        anchorKey: 'turnTooltipAnchor',
        showFn: showTurnTooltip,
        hideFn: scheduleHideTurnTooltip,
      });
    }

    const idxAttr = String(turnData.turnIndex);
    if (line.getAttribute('data-aq-turn-usage') !== idxAttr) {
      line.setAttribute('data-aq-turn-usage', idxAttr);
    }

    if (toolbarContainer && toolbarContainer.parentElement === host) {
      if (line.parentElement !== host || line.nextElementSibling !== toolbarContainer) {
        host.insertBefore(line, toolbarContainer);
      }
    } else if (line.parentElement !== host || line !== host.lastElementChild) {
      host.appendChild(line);
    }

    line.__aqTurnData = turnData;
    const summary = formatTurnSummary(turnData);
    if (line.textContent !== summary) {
      line.textContent = summary;
    }
    return line;
  }

  function isTurnRowElement(ch) {
    return (
      ch?.tagName === 'DIV' &&
      Boolean(
        ch.querySelector('[data-turn-content]') ||
          ch.querySelector('[data-testid="agent-response"]') ||
          ch.querySelector('[data-testid="user-message"]') ||
          ch.querySelector('[data-testid="cascade-system-message-toolbar"]')
      )
    );
  }

  function findTurnRows() {
    const quotableRoot = document.querySelector('[data-quotable-root]');
    if (quotableRoot) {
      for (const child of quotableRoot.children) {
        if (child.tagName === 'DIV') {
          const rows = [...child.children].filter(isTurnRowElement);
          if (rows.length > 0) return rows;
        }
      }
    }
    const anchor =
      document.querySelector('[data-turn-content]') ||
      document.querySelector('[data-testid="agent-response"]') ||
      document.querySelector('[data-testid="cascade-system-message-toolbar"]');
    const row = anchor?.closest?.('.flex.items-start');
    const listParent = row?.parentElement;
    if (listParent) {
      return [...listParent.children].filter(isTurnRowElement);
    }
    return [...document.querySelectorAll('[data-turn-content]')];
  }

  function renderTurnUsageLines() {
    const payload = state.turnsPayload;
    const currentId = extractCascadeId();
    if (!currentId || !payload || !payload.hasData || payload.cascadeId !== currentId) {
      document.querySelectorAll('[data-aq-turn-usage]').forEach((el) => el.remove());
      return;
    }

    const turns = Array.isArray(payload.turns) ? payload.turns : [];
    const turnEls = findTurnRows();
    if (turnEls.length === 0 || turns.length === 0) return;

    const offset = computeTurnPairingOffset(turnEls.length, turns.length);
    const activeLines = new Set();
    for (let i = 0; i < turnEls.length; i++) {
      const turnData = turns[offset + i] || null;
      if (turnData && (turnData.totalTokens > 0 || !turnData.completed)) {
        activeLines.add(mountTurnLine(turnEls[i], turnData));
      } else {
        turnEls[i].querySelectorAll('[data-aq-turn-usage]').forEach((el) => el.remove());
      }
    }
    document.querySelectorAll('[data-aq-turn-usage]').forEach((el) => {
      if (!activeLines.has(el)) el.remove();
    });
  }

  // ---- Quota Chip & Hover Panel ----

  function findComposerParts() {
    const box = document.getElementById('antigravity.agentSidePanelInputBox');
    if (!box) return null;
    const footer =
      box.querySelector('.agy-composer-footer') ||
      [...box.querySelectorAll('div.flex.w-full.items-center.justify-between')].find((r) =>
        r.querySelector('[data-testid="permissions-selector-trigger"], [data-testid="send-button"]')
      );
    if (!footer) return null;
    const turboBtn = footer.querySelector('[data-testid="permissions-selector-trigger"]');
    const rightGroup = turboBtn?.parentElement || footer.children[1] || null;
    const leftGroup = footer.children[0] || null;
    return { box, footer, leftGroup, rightGroup, turboBtn };
  }

  function detectSelectedModelLabel(leftGroup) {
    if (!leftGroup) return '';
    const explicit = leftGroup.querySelector('[data-testid="model-selector-trigger"]');
    if (explicit) {
      const aria = String(explicit.getAttribute('aria-label') || '');
      const m = aria.match(/current:\s*(.+)$/i);
      if (m && m[1]?.trim()) return m[1].trim();
      if (explicit.textContent?.trim()) return explicit.textContent.trim();
    }
    const btns = [...leftGroup.querySelectorAll('button')];
    for (let i = btns.length - 1; i >= 0; i--) {
      const aria = String(btns[i].getAttribute('aria-label') || '');
      if (/add context/i.test(aria)) continue;
      const m = aria.match(/current:\s*(.+)$/i);
      if (m && m[1]?.trim()) return m[1].trim();
      const text = String(btns[i].textContent || '').trim();
      if (text) return text;
    }
    return '';
  }

  function getActiveContext() {
    const cid = extractCascadeId();
    const payload = state.turnsPayload;
    if (!cid || !payload || payload.cascadeId !== cid || !payload.latestContext) return null;
    const { usedTokens, maxTokens } = payload.latestContext;
    if (!(Number(usedTokens) > 0 && Number(maxTokens) > 0)) return null;
    return { usedTokens: Number(usedTokens), maxTokens: Number(maxTokens) };
  }

  function renderContextChipContent() {
    const ctxChip = document.getElementById('aq-context-chip');
    if (!ctxChip) return;
    const cid = extractCascadeId();
    if (!cid) {
      ctxChip.style.display = 'none';
      return;
    }
    ctxChip.style.display = 'inline-flex';
    const ctx = getActiveContext();
    if (!ctx) {
      ctxChip.innerHTML = '<span class="aq-lvl-muted">--</span>';
      return;
    }
    const ctxCls = contextLevelClass(ctx.usedTokens, ctx.maxTokens);
    ctxChip.innerHTML = `<span class="${ctxCls}">${formatContextK(ctx.usedTokens)}</span><span class="aq-lvl-muted">/${formatContextK(ctx.maxTokens)}</span>`;
  }

  function renderQuotaChipContent() {
    renderContextChipContent();
    const chip = document.getElementById('aq-quota-chip');
    if (!chip) return;
    chip.setAttribute('data-loading', state.quotaFetching ? '1' : '0');

    const parts = findComposerParts();
    const modelLabel = detectSelectedModelLabel(parts?.leftGroup);
    if (modelLabel) state.selectedModelLabel = modelLabel;

    const u = state.updateInfo;
    const hasUpdateDot = Boolean(
      u &&
        (u.available === true ||
          (Boolean(u.latestVersion) && ['available', 'downloading', 'ready', 'installing'].includes(u.status)))
    );
    const updateDotHtml = hasUpdateDot
      ? `<span class="aq-update-dot" title="${escapeHtml(`发现新版本 v${u.latestVersion}`)}"></span>`
      : '';

    const groups = state.quotaData?.groups || [];
    if (groups.length === 0) {
      chip.innerHTML =
        (state.quotaError ? '<span class="aq-lvl-muted">--</span>' : '<span class="aq-lvl-muted">…</span>') +
        updateDotHtml;
      return;
    }

    const activeGroup = matchQuotaGroup(groups, state.selectedModelLabel);
    const { fiveHour, weekly } = extractQuotaBuckets(activeGroup);

    const quotaParts = [];
    if (fiveHour) {
      quotaParts.push(
        `<span class="${quotaLevelClass(fiveHour.remainingFraction)}">${formatRemainingPercent(fiveHour.remainingFraction)}</span>`
      );
    }
    if (weekly) {
      quotaParts.push(
        `<span class="${quotaLevelClass(weekly.remainingFraction)}">${formatRemainingPercent(weekly.remainingFraction)}</span>`
      );
    }
    if (quotaParts.length === 0) {
      quotaParts.push('<span class="aq-lvl-muted">--</span>');
    }
    chip.innerHTML = quotaParts.join('<span class="aq-chip-sep">/</span>') + updateDotHtml;
  }

  function showQuotaTooltip(chipEl) {
    if (state.quotaTooltipShowTimer) {
      clearTimeout(state.quotaTooltipShowTimer);
      state.quotaTooltipShowTimer = null;
    }
    if (state.quotaTooltipHideTimer) {
      clearTimeout(state.quotaTooltipHideTimer);
      state.quotaTooltipHideTimer = null;
    }
    state.quotaTooltipAnchor = chipEl;
    const tt = ensureTooltipEl('aq-quota-tooltip');
    const groups = state.quotaData?.groups || [];
    const activeGroup = matchQuotaGroup(groups, state.selectedModelLabel);
    const ctx = getActiveContext();
    const ctxSectionHtml = ctx
      ? (() => {
          const pct = Math.round((ctx.usedTokens / ctx.maxTokens) * 100);
          const lvl = contextLevelClass(ctx.usedTokens, ctx.maxTokens);
          return `
            <div class="aq-tt-row" style="margin-bottom:6px">
              <span class="aq-tt-lbl">上下文</span>
              <span class="aq-tt-val"><span class="${lvl}">${formatContextK(ctx.usedTokens)}</span> / ${formatContextK(ctx.maxTokens)} (${pct}%)</span>
            </div>
          `;
        })()
      : '';

    const curEmail = state.userProfile?.email || '';
    const accountsSupported = state.accountsSupported !== false;
    const unsupportedReason = state.accountsUnsupportedReason || '当前系统暂不支持账号快照与一键切换';
    const acctRows = accountsSupported
      ? (Array.isArray(state.accounts) ? state.accounts : [])
          .map((acct) => {
            const isCur = Boolean(acct.active || (curEmail && acct.email?.toLowerCase() === curEmail.toLowerCase()));
            const confirming = state.pendingSwitchConfirmId === acct.id;
            const switchBtn = isCur
              ? '<span class="aq-q-active-tag">当前</span>'
              : `<button type="button" class="aq-q-btn ${confirming ? 'aq-q-btn-warn' : 'aq-q-btn-primary'}" data-aq-acct-switch="${escapeHtml(acct.id)}" ${state.accountsBusy ? 'disabled' : ''}>${confirming ? '确认重启' : '切换'}</button>`;
            return `
              <div class="aq-q-acct-row">
                <div class="aq-q-acct-info">
                  <span class="aq-q-acct-email" title="${escapeHtml(acct.email)}">${escapeHtml(acct.email)}</span>
                  ${acct.planName ? `<span class="aq-q-acct-plan">${escapeHtml(acct.planName)}</span>` : ''}
                </div>
                <div class="aq-q-acct-actions">
                  ${switchBtn}
                  <button type="button" class="aq-q-btn" data-aq-acct-del="${escapeHtml(acct.id)}" title="删除快照" ${state.accountsBusy ? 'disabled' : ''}>×</button>
                </div>
              </div>
            `;
          })
          .join('')
      : '';
    const statusHtml = !accountsSupported
      ? ''
      : state.accountsError
        ? `<div class="aq-q-acct-err">${escapeHtml(state.accountsError)}</div>`
        : state.accountsStatus
          ? `<div class="aq-q-acct-note">${escapeHtml(state.accountsStatus)}</div>`
          : '';
    const accountsBodyHtml = !accountsSupported
      ? `<div class="aq-q-acct-note">${escapeHtml(unsupportedReason)}</div>`
      : acctRows
        ? `<div class="aq-q-acct-list">${acctRows}</div>`
        : '<div class="aq-q-acct-note">暂无已保存快照，登录后会自动保存</div>';
    const addConfirming = state.pendingSwitchConfirmId === '__add__';
    const disabledTipAttr = !accountsSupported ? ` title="${escapeHtml(unsupportedReason)}"` : '';
    const accountsHtml = `
      <div class="aq-q-accounts">
        <div class="aq-q-acct-hdr">
          <span>账号切换</span>
          <div class="aq-q-acct-actions">
            <button type="button" class="aq-q-btn ${addConfirming ? 'aq-q-btn-warn' : 'aq-q-btn-primary'}" data-aq-acct-add="1" ${!accountsSupported || state.accountsBusy ? 'disabled' : ''}${disabledTipAttr}>${addConfirming ? '确认重启' : '+ 登录新号'}</button>
          </div>
        </div>
        ${accountsBodyHtml}
        ${statusHtml}
      </div>
    `;

    const upd = state.updateInfo || {};
    const curVer = upd.currentVersion
      ? `v${escapeHtml(upd.currentVersion)}${upd.mode === 'dev' ? '.dev' : ''}`
      : '';
    const updAvailable = Boolean(
      upd.available === true ||
        (upd.latestVersion && ['available', 'downloading', 'ready', 'installing'].includes(upd.status))
    );
    const updInstalling = upd.status === 'installing';
    const updDownloading = upd.status === 'downloading';
    const updOpening = Boolean(state.updateOpening || upd.opening);
    const pctText =
      updDownloading && Number(upd.total) > 0
        ? ` ${Math.min(100, Math.round((Number(upd.received || 0) / Number(upd.total)) * 100))}%`
        : '';

    let versionLabel = curVer;
    if (updInstalling) {
      versionLabel = '正在原地替换注入器并重新注入…';
    } else if (updOpening) {
      versionLabel = updDownloading ? `正在下载更新${pctText}…` : '正在检查更新…';
    } else if (updAvailable && upd.latestVersion) {
      versionLabel = `${curVer ? `${curVer} → ` : ''}v${escapeHtml(upd.latestVersion)}`;
    }

    const versionControlHtml =
      upd.enabled !== false
        ? `<button type="button" class="aq-update-open${updAvailable || updInstalling ? '' : ' aq-panel-version-text'}" data-aq-update-open="1" ${updOpening || updInstalling ? 'disabled aria-busy="true"' : ''}>${versionLabel}</button>`
        : `<span class="aq-panel-version-text">${versionLabel}</span>`;

    const updateHtml = upd.currentVersion
      ? `
        <div class="aq-q-update">
          ${versionControlHtml}
          ${upd.error ? `<div class="aq-update-error" role="alert">${escapeHtml(upd.error)}</div>` : ''}
        </div>
      `
      : '';

    if (groups.length === 0) {
      tt.innerHTML = `
        <div class="aq-tt-hdr">
          <span>上下文与配额</span>
          <span class="aq-tt-sub">${state.quotaError ? escapeHtml(state.quotaError) : '加载中…'}</span>
        </div>
        ${ctxSectionHtml}
        ${accountsHtml}
        ${updateHtml}
      `;
    } else {
      const blocks = groups.map((g) => {
        const isMatched = activeGroup && g.displayName === activeGroup.displayName;
        const buckets = orderQuotaBuckets(g.buckets);
        const bucketHtml = buckets
          .map((b) => {
            const pct = formatRemainingPercent(b.remainingFraction);
            const lvl = quotaLevelClass(b.remainingFraction);
            const win = String(b.window || '').toLowerCase();
            const label =
              win === '5h'
                ? '5h'
                : win === 'weekly'
                  ? '周'
                  : escapeHtml(b.displayName || b.bucketId || '配额');
            const reset = formatResetCountdown(b.resetTime);
            return `
              <div class="aq-tt-row">
                <span class="aq-tt-lbl">${label}</span>
                <span class="aq-tt-val"><span class="${lvl}">${pct}</span>${reset ? `<span class="aq-q-reset"> · ${escapeHtml(reset)}</span>` : ''}</span>
              </div>
            `;
          })
          .join('');

        return `
          <div class="aq-q-group">
            <div class="aq-q-group-hdr">
              <span>${escapeHtml(g.displayName || '模型分组')}</span>
              ${isMatched ? '<span class="aq-q-active-tag">当前</span>' : ''}
            </div>
            <div class="aq-tt-grid">${bucketHtml || '<div class="aq-tt-sub">暂无配额</div>'}</div>
          </div>
        `;
      });

      tt.innerHTML = `
        <div class="aq-tt-hdr">
          <span>上下文与配额</span>
          ${state.quotaError ? `<span class="aq-tt-sub">${escapeHtml(state.quotaError)}</span>` : ''}
        </div>
        ${ctxSectionHtml}
        ${blocks.join('')}
        ${accountsHtml}
        ${updateHtml}
      `;
    }

    bindQuotaTooltipActions(tt);
    positionTooltipAbove(tt, chipEl.getBoundingClientRect());
    tt.setAttribute('data-visible', '1');
  }

  function sendAccountAction(payload) {
    if (typeof window.__aqAccountAction !== 'function') return;
    try {
      window.__aqAccountAction(JSON.stringify({ ...payload, profile: state.userProfile }));
    } catch {}
  }

  function sendUpdateAction(payload) {
    if (typeof window.__aqUpdateAction !== 'function') return;
    try {
      window.__aqUpdateAction(JSON.stringify(payload || {}));
    } catch {}
  }

  function refreshQuotaTooltipIfVisible() {
    const tt = document.getElementById('aq-quota-tooltip');
    const anchor = state.quotaTooltipAnchor?.isConnected
      ? state.quotaTooltipAnchor
      : document.getElementById('aq-quota-chip');
    if (tt?.getAttribute('data-visible') === '1' && anchor) {
      showQuotaTooltip(anchor);
    }
  }

  function bindQuotaTooltipActions(tt) {
    const addBtn = tt.querySelector('[data-aq-acct-add]');
    if (addBtn) {
      addBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!state.accountsSupported || state.accountsBusy) return;
        state.quotaTooltipPinned = true;
        if (state.pendingSwitchConfirmId !== '__add__') {
          state.pendingSwitchConfirmId = '__add__';
          if (state.pendingSwitchTimer) clearTimeout(state.pendingSwitchTimer);
          state.pendingSwitchTimer = setTimeout(() => {
            state.pendingSwitchTimer = null;
            if (state.pendingSwitchConfirmId === '__add__') {
              state.pendingSwitchConfirmId = '';
              refreshQuotaTooltipIfVisible();
            }
          }, 3000);
          refreshQuotaTooltipIfVisible();
          return;
        }
        state.pendingSwitchConfirmId = '';
        if (state.pendingSwitchTimer) {
          clearTimeout(state.pendingSwitchTimer);
          state.pendingSwitchTimer = null;
        }
        state.accountsError = '';
        state.accountsBusy = true;
        state.accountsStatus = '正在保存当前账号并重启 Antigravity 进入登录页…';
        refreshQuotaTooltipIfVisible();
        sendAccountAction({ type: 'add-account' });
      });
    }
    const switchBtns = tt.querySelectorAll('[data-aq-acct-switch]');
    for (let i = 0; i < switchBtns.length; i++) {
      switchBtns[i].addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const id = switchBtns[i].getAttribute('data-aq-acct-switch') || '';
        if (!id || state.accountsBusy) return;
        state.quotaTooltipPinned = true;
        if (state.pendingSwitchConfirmId !== id) {
          state.pendingSwitchConfirmId = id;
          if (state.pendingSwitchTimer) clearTimeout(state.pendingSwitchTimer);
          state.pendingSwitchTimer = setTimeout(() => {
            state.pendingSwitchTimer = null;
            if (state.pendingSwitchConfirmId === id) {
              state.pendingSwitchConfirmId = '';
              refreshQuotaTooltipIfVisible();
            }
          }, 3000);
          refreshQuotaTooltipIfVisible();
          return;
        }
        state.pendingSwitchConfirmId = '';
        if (state.pendingSwitchTimer) {
          clearTimeout(state.pendingSwitchTimer);
          state.pendingSwitchTimer = null;
        }
        state.accountsError = '';
        state.accountsBusy = true;
        state.accountsStatus = '正在切换账号并重启 Antigravity…';
        refreshQuotaTooltipIfVisible();
        sendAccountAction({ type: 'switch', id });
      });
    }
    const delBtns = tt.querySelectorAll('[data-aq-acct-del]');
    for (let i = 0; i < delBtns.length; i++) {
      delBtns[i].addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const id = delBtns[i].getAttribute('data-aq-acct-del') || '';
        if (!id || state.accountsBusy) return;
        sendAccountAction({ type: 'delete', id });
      });
    }
    const openUpdateBtn = tt.querySelector('[data-aq-update-open]');
    if (openUpdateBtn) {
      openUpdateBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (state.updateOpening || state.updateInfo?.opening || state.updateInfo?.status === 'installing') {
          return;
        }
        state.quotaTooltipPinned = true;
        if (typeof state.updateInfo?.opening !== 'boolean') {
          state.updateInfo = {
            ...(state.updateInfo || {}),
            error: '后台守护进程代码已更新，请重新运行 启动开发版.command 后重试',
          };
          refreshQuotaTooltipIfVisible();
          return;
        }
        const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        state.updateRequestId = requestId;
        state.updateOpening = true;
        refreshQuotaTooltipIfVisible();
        sendUpdateAction({ type: 'open', requestId });
      });
    }
  }

  function closeQuotaTooltip() {
    if (state.quotaTooltipHideTimer) {
      clearTimeout(state.quotaTooltipHideTimer);
      state.quotaTooltipHideTimer = null;
    }
    state.quotaTooltipPinned = false;
    state.pendingSwitchConfirmId = '';
    const tt = document.getElementById('aq-quota-tooltip');
    if (tt) tt.removeAttribute('data-visible');
    state.quotaTooltipAnchor = null;
  }

  function scheduleHideQuotaTooltip() {
    if (state.quotaTooltipPinned) return;
    if (state.quotaTooltipHideTimer) clearTimeout(state.quotaTooltipHideTimer);
    state.quotaTooltipHideTimer = setTimeout(() => {
      state.quotaTooltipHideTimer = null;
      if (state.quotaTooltipPinned) return;
      const tt = document.getElementById('aq-quota-tooltip');
      if (tt) tt.removeAttribute('data-visible');
      state.quotaTooltipAnchor = null;
    }, 140);
  }

  function ensureQuotaChip() {
    const parts = findComposerParts();
    if (!parts || !parts.rightGroup) return;

    const quotaTriggerOpts = {
      tooltipId: 'aq-quota-tooltip',
      delayMs: QUOTA_TOOLTIP_DELAY_MS,
      showTimerKey: 'quotaTooltipShowTimer',
      hideTimerKey: 'quotaTooltipHideTimer',
      anchorKey: 'quotaTooltipAnchor',
      showFn: showQuotaTooltip,
      hideFn: scheduleHideQuotaTooltip,
    };

    let ctxChip = document.getElementById('aq-context-chip');
    if (!ctxChip) {
      ctxChip = document.createElement('div');
      ctxChip.id = 'aq-context-chip';
      ctxChip.setAttribute('tabindex', '0');
      ctxChip.setAttribute('aria-label', '当前会话上下文占用');
      bindTooltipTrigger(ctxChip, quotaTriggerOpts);
    }

    let chipCreated = false;
    let chip = document.getElementById('aq-quota-chip');
    if (!chip) {
      chipCreated = true;
      chip = document.createElement('button');
      chip.type = 'button';
      chip.id = 'aq-quota-chip';
      chip.setAttribute('aria-label', '查看模型配额');
      bindTooltipTrigger(chip, quotaTriggerOpts);
      chip.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const tt = document.getElementById('aq-quota-tooltip');
        const isOpen = tt?.getAttribute('data-visible') === '1' && state.quotaTooltipPinned;
        if (isOpen) {
          closeQuotaTooltip();
          return;
        }
        state.quotaTooltipPinned = true;
        sendAccountAction({ type: 'list' });
        if (state.updateInfo && state.updateInfo.enabled !== false) {
          sendUpdateAction({ type: 'check' });
        }
        showQuotaTooltip(chip);
        void fetchQuota(true);
      });
    }

    if (parts.turboBtn && parts.turboBtn.parentElement === parts.rightGroup) {
      if (chip.parentElement !== parts.rightGroup || chip.nextElementSibling !== parts.turboBtn) {
        parts.rightGroup.insertBefore(chip, parts.turboBtn);
      }
      if (ctxChip.parentElement !== parts.rightGroup || ctxChip.nextElementSibling !== chip) {
        parts.rightGroup.insertBefore(ctxChip, chip);
      }
    } else {
      if (chip.parentElement !== parts.rightGroup) {
        parts.rightGroup.prepend(chip);
      }
      if (ctxChip.parentElement !== parts.rightGroup || ctxChip.nextElementSibling !== chip) {
        parts.rightGroup.insertBefore(ctxChip, chip);
      }
    }

    if (parts.leftGroup && state.observedFooterBox !== parts.leftGroup) {
      if (state.footerObserver) {
        try {
          state.footerObserver.disconnect();
        } catch {}
      }
      state.observedFooterBox = parts.leftGroup;
      state.footerObserver = new MutationObserver(() => {
        renderQuotaChipContent();
      });
      state.footerObserver.observe(parts.leftGroup, { childList: true, subtree: true, characterData: true });
    }

    renderQuotaChipContent();
    if (chipCreated && !state.quotaData && !state.quotaFetching) {
      void fetchQuota(true);
    }
  }

  async function fetchQuota(force = false) {
    if (state.quotaFetching) return;
    if (!force && Date.now() - state.quotaFetchedAt < 10_000 && state.quotaData) return;
    state.quotaFetching = true;
    renderQuotaChipContent();
    try {
      const csrf = window.__APP_CONFIG__?.csrfToken || '';
      const headers = {
        'Content-Type': 'application/json',
        ...(csrf ? { 'x-codeium-csrf-token': csrf } : {}),
      };
      const [quotaRes, userRes] = await Promise.all([
        fetch('/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
        }),
        fetch('/exa.language_server_pb.LanguageServerService/GetUserStatus', {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
        }).catch(() => null),
      ]);
      if (userRes && userRes.ok) {
        const uJson = await userRes.json().catch(() => null);
        const us = uJson?.userStatus || uJson?.response?.userStatus || uJson;
        const email = String(us?.email || '').trim();
        if (email) {
          state.userProfile = {
            email,
            name: String(us?.name || '').trim(),
            planName: String(us?.planStatus?.planInfo?.planName || us?.userTier?.name || '').trim(),
          };
          if (state.accountsMetaLoaded && state.accountsSupported && state.autoSavedEmail !== email) {
            state.autoSavedEmail = email;
            sendAccountAction({ type: 'save', silent: true });
          } else {
            sendAccountAction({ type: 'list' });
          }
        }
      }
      if (!quotaRes.ok) throw new Error(`HTTP ${quotaRes.status}`);
      const json = await quotaRes.json();
      const resp = json?.response || json;
      if (Array.isArray(resp?.groups)) {
        state.quotaData = resp;
        state.quotaFetchedAt = Date.now();
        state.quotaError = '';
      }
    } catch (err) {
      state.quotaError = String(err?.message || '获取失败');
    } finally {
      state.quotaFetching = false;
      renderQuotaChipContent();
      refreshQuotaTooltipIfVisible();
    }
  }

  const TRANSLATE_SKIP_SELECTOR =
    '[data-markdown-root], [data-testid="agent-response"], [data-testid="user-message"], [data-testid="user-message-content"], [data-lexical-editor], [data-aq-turn-usage], #aq-turn-tooltip, #aq-quota-tooltip, #aq-context-chip, #aq-quota-chip, code, pre, script, style, .codicon, .google-symbols, .agy-sidebar-row';

  const CHROME_ROOT_SELECTOR = [
    '.settings-modal-container',
    '[data-base-ui-portal]',
    '[data-testid="context-menu-popup"]',
    '[data-testid="context-menu-submenu-popup"]',
    '[data-popover-popup]',
    '[data-select-popup]',
    '[data-hover-card-popup]',
    '[data-bottom-sheet-popup]',
    '[data-drawer-content]',
    '[data-mention-menu]',
    '.agy-overlay',
    '[role="dialog"]',
    '[role="menu"]',
    '[role="listbox"]',
    '[role="tooltip"]',
    '[data-radix-popper-content-wrapper]',
    '[data-radix-popper-content]',
    '.bg-sidebar',
  ].join(', ');

  function isProjectFolderNode(el) {
    const span = el?.closest?.('span');
    return Boolean(span && span.querySelector(':scope > [data-project-glyph="folder"]'));
  }

  function translateTextInRoot(root, allowRules = true) {
    if (!root || typeof translateUiText !== 'function') return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const val = node.nodeValue;
      if (!val || !/[A-Za-z]/.test(val)) continue;
      const parent = node.parentElement;
      if (!parent || parent.closest(TRANSLATE_SKIP_SELECTOR) || isProjectFolderNode(parent)) continue;
      const next = translateUiText(val, allowRules);
      if (next && next !== val) {
        node.nodeValue = next;
      }
    }
    const translateAttrs = (el) => {
      if (!el || el.nodeType !== 1) return;
      if (el.closest(TRANSLATE_SKIP_SELECTOR) || isProjectFolderNode(el)) return;
      for (const attr of ['placeholder', 'aria-label', 'title']) {
        const val = el.getAttribute(attr);
        if (!val || !/[A-Za-z]/.test(val)) continue;
        const nextVal = translateUiText(val, false);
        if (nextVal && nextVal !== val) {
          el.setAttribute(attr, nextVal);
        }
      }
    };
    translateAttrs(root);
    if (typeof root.querySelectorAll === 'function') {
      const fields = root.querySelectorAll('input[placeholder], textarea[placeholder], [aria-label], [title]');
      for (let i = 0; i < fields.length; i++) {
        translateAttrs(fields[i]);
      }
    }
  }

  function applyUiTranslations() {
    if (state.isTranslating || typeof translateUiText !== 'function') return;
    state.isTranslating = true;
    try {
      const chromeRoots = document.querySelectorAll(CHROME_ROOT_SELECTOR);
      for (let i = 0; i < chromeRoots.length; i++) {
        translateTextInRoot(chromeRoots[i], true);
      }

      const composerBox = document.getElementById('antigravity.agentSidePanelInputBox');
      if (composerBox) {
        const footerContainer = composerBox.parentElement?.parentElement || composerBox.parentElement || composerBox;
        translateTextInRoot(footerContainer, true);
      }

      const chromeControls = document.querySelectorAll('button, [role="tab"], [data-testid="title-menu-bar"] *');
      for (let i = 0; i < chromeControls.length; i++) {
        const ctrl = chromeControls[i];
        if (ctrl.closest(TRANSLATE_SKIP_SELECTOR) || isProjectFolderNode(ctrl)) continue;
        if (ctrl.closest('[data-turn-content]')) continue;
        const txt = ctrl.textContent;
        const aria = ctrl.getAttribute('aria-label');
        const title = ctrl.getAttribute('title');
        if ((txt && txt.length <= 60 && /[A-Za-z]/.test(txt)) || (aria && /[A-Za-z]/.test(aria)) || (title && /[A-Za-z]/.test(title))) {
          translateTextInRoot(ctrl, false);
        }
      }
    } finally {
      state.isTranslating = false;
    }
  }

  function syncCascadeRoute() {
    const cid = extractCascadeId();
    if (cid !== state.cascadeId) {
      state.cascadeId = cid;
      if (!cid) {
        state.turnsPayload = null;
      } else if (typeof window.__aqRequestTurns === 'function') {
        try {
          window.__aqRequestTurns(cid);
        } catch {}
      }
    }
  }

  function scheduleRenderAll() {
    if (state.renderRaf) return;
    state.renderRaf = requestAnimationFrame(() => {
      state.renderRaf = 0;
      syncCascadeRoute();
      ensureQuotaChip();
      renderTurnUsageLines();
      applyUiTranslations();
    });
  }

  function checkRoute() {
    syncCascadeRoute();
    scheduleRenderAll();
  }

  // Expose receiver called by Node daemon
  window.__aqRenderTurns = function (payload) {
    try {
      const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
      const sameChat = Boolean(cid && cid === state.lastTurnsCid);
      state.lastTurnsCid = cid;
      state.turnsPayload = payload;
      scheduleRenderAll();
      if (sameChat && !document.hidden) {
        void fetchQuota(false);
      }
    } catch {}
  };

  window.__aqGetWatchedCascadeId = function () {
    return extractCascadeId();
  };

  window.__aqRenderAccounts = function (payload) {
    try {
      state.accountsMetaLoaded = true;
      if (typeof payload?.supported === 'boolean') {
        state.accountsSupported = payload.supported;
      }
      state.accountsUnsupportedReason = String(payload?.unsupportedReason || '');
      if (Array.isArray(payload?.accounts)) state.accounts = payload.accounts;
      state.accountsBusy = Boolean(payload?.busy);
      state.accountsStatus = String(payload?.status || '');
      state.accountsError = String(payload?.error || '');

      const email = state.userProfile?.email || '';
      if (state.accountsSupported && email && state.autoSavedEmail !== email) {
        state.autoSavedEmail = email;
        sendAccountAction({ type: 'save', silent: true });
      }
      refreshQuotaTooltipIfVisible();
    } catch {}
  };

  window.__aqRenderUpdate = function (payload) {
    try {
      state.updateInfo = payload && typeof payload === 'object' ? payload : null;
      if (
        payload?.requestId &&
        payload.requestId === state.updateRequestId &&
        payload.opening === false
      ) {
        state.updateOpening = false;
      }
      renderQuotaChipContent();
      refreshQuotaTooltipIfVisible();
    } catch {}
  };

  // Setup tooltip hover keep-alive
  for (const [ttId, hideFn] of [
    ['aq-turn-tooltip', scheduleHideTurnTooltip],
    ['aq-quota-tooltip', scheduleHideQuotaTooltip],
  ]) {
    const tt = ensureTooltipEl(ttId);
    tt.addEventListener('pointerenter', () => {
      if (ttId === 'aq-turn-tooltip' && state.turnTooltipHideTimer) {
        clearTimeout(state.turnTooltipHideTimer);
        state.turnTooltipHideTimer = null;
      }
      if (ttId === 'aq-quota-tooltip' && state.quotaTooltipHideTimer) {
        clearTimeout(state.quotaTooltipHideTimer);
        state.quotaTooltipHideTimer = null;
      }
    });
    tt.addEventListener('pointerleave', hideFn);
  }

  injectStyles();

  // Watch DOM changes in chat, chrome & composer
  state.domObserver = new MutationObserver((mutations) => {
    if (state.isTranslating) return;
    let shouldFlushNow = false;
    let relevant = false;
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      const t = m.target;
      if (m.type === 'characterData') {
        const p = t?.parentElement;
        if (p?.closest?.(CHROME_ROOT_SELECTOR)) {
          relevant = true;
          shouldFlushNow = true;
        }
        continue;
      }
      if (t?.nodeType === 1 && t.closest?.('[data-aq-turn-usage], #aq-context-chip, #aq-quota-chip, #aq-quota-tooltip, #aq-turn-tooltip')) {
        continue;
      }
      relevant = true;
      if (t?.nodeType === 1 && t.closest?.(CHROME_ROOT_SELECTOR)) {
        shouldFlushNow = true;
      } else if (m.addedNodes?.length) {
        for (let j = 0; j < m.addedNodes.length; j++) {
          const n = m.addedNodes[j];
          if (n?.nodeType === 1 && (n.matches?.(CHROME_ROOT_SELECTOR) || n.querySelector?.(CHROME_ROOT_SELECTOR))) {
            shouldFlushNow = true;
            break;
          }
        }
      }
    }
    if (shouldFlushNow) applyUiTranslations();
    if (relevant) scheduleRenderAll();
  });
  state.domObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Hook history API
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function (...args) {
    const r = origPush.apply(this, args);
    setTimeout(checkRoute, 0);
    setTimeout(checkRoute, 120);
    return r;
  };
  history.replaceState = function (...args) {
    const r = origReplace.apply(this, args);
    setTimeout(checkRoute, 0);
    return r;
  };
  const onPopState = () => checkRoute();
  const onVisChange = () => {
    if (!document.hidden) {
      checkRoute();
      void fetchQuota(false);
    }
  };
  const onDocPointerDown = (ev) => {
    if (!state.quotaTooltipPinned) return;
    const t = ev.target;
    if (t?.closest?.('#aq-quota-tooltip, #aq-quota-chip, #aq-context-chip')) return;
    closeQuotaTooltip();
  };
  const onDocKeyDown = (ev) => {
    if (ev.key === 'Escape' && state.quotaTooltipPinned) {
      closeQuotaTooltip();
    }
  };
  window.addEventListener('popstate', onPopState);
  document.addEventListener('visibilitychange', onVisChange);
  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('keydown', onDocKeyDown, true);

  state.routeTimer = setInterval(checkRoute, 2000);
  state.quotaTimer = setInterval(() => {
    if (!document.hidden) void fetchQuota(false);
  }, 60_000);

  window.__aqCleanup = function () {
    try {
      history.pushState = origPush;
      history.replaceState = origReplace;
    } catch {}
    window.removeEventListener('popstate', onPopState);
    document.removeEventListener('visibilitychange', onVisChange);
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
    if (state.renderRaf) cancelAnimationFrame(state.renderRaf);
    if (state.routeTimer) clearInterval(state.routeTimer);
    if (state.quotaTimer) clearInterval(state.quotaTimer);
    if (state.turnTooltipShowTimer) clearTimeout(state.turnTooltipShowTimer);
    if (state.turnTooltipHideTimer) clearTimeout(state.turnTooltipHideTimer);
    if (state.quotaTooltipShowTimer) clearTimeout(state.quotaTooltipShowTimer);
    if (state.quotaTooltipHideTimer) clearTimeout(state.quotaTooltipHideTimer);
    if (state.pendingSwitchTimer) clearTimeout(state.pendingSwitchTimer);
    state.domObserver?.disconnect();
    state.footerObserver?.disconnect();
    document.getElementById('aq-codex-theme')?.remove();
    document.getElementById('aq-style')?.remove();
    document.getElementById('aq-context-chip')?.remove();
    document.getElementById('aq-quota-chip')?.remove();
    document.getElementById('aq-quota-tooltip')?.remove();
    document.getElementById('aq-turn-tooltip')?.remove();
    document.querySelectorAll('[data-aq-turn-usage]').forEach((el) => el.remove());
    delete window.__aqRenderTurns;
    delete window.__aqGetWatchedCascadeId;
    delete window.__aqRenderAccounts;
    delete window.__aqRenderUpdate;
    delete window.__aqHydrated;
    delete window.__aq_version;
    delete window.__aqCleanup;
  };

  window.__aqHydrated = false;
  window.__aq_version = INJECT_VERSION;
  checkRoute();
  void fetchQuota(true);
})();
