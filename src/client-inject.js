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
  const QUOTA_FORCE_COOLDOWN_MS = 10_000;
  const QUOTA_RUNNING_INTERVAL_MS = 30_000;
  const TRAJ_STATUS_POLL_MS = 10_000;

  const state = {
    cascadeId: '',
    turnsPayload: null,
    quotaData: null,
    quotaFetchedAt: 0,
    quotaForceFetchedAt: 0,
    userStatusFetchedAt: 0,
    quotaFetching: false,
    quotaPendingRefresh: false,
    quotaPendingForce: false,
    quotaDebounceTimer: null,
    quotaError: '',
    selectedModelLabel: '',
    renderRaf: 0,
    quotaTimer: null,
    trajStatusTimer: null,
    lastTurnsCid: '',
    lastTurnActivitySig: '',
    lastTurnCompleted: true,
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
    acctQuotaTooltipId: '',
    acctQuotaTooltipShowTimer: null,
    acctQuotaTooltipHideTimer: null,
    lastSyncedQuotaSnapSig: '',
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
    autoSavedSignature: '',
    updateInfo: null,
    updateOpening: false,
    updateRequestId: '',
    groupsLoaded: false,
    groupsCollapsedSection: false,
    groups: [],
    groupsError: '',
    groupCreating: false,
    groupCreateParentId: '',
    groupCreateInitialItem: null,
    groupRenamingId: '',
    groupDeleteConfirmId: '',
    groupDeleteConfirmTimer: null,
    groupDragId: '',
    groupDragMode: '',
    groupDragTargetId: '',
    groupMenuTarget: null,
    groupRenderKey: '',
    smartActiveCollapsed: (() => {
      try {
        const raw = localStorage.getItem('aq_smart_groups_collapsed_v1');
        if (raw) {
          const parsed = JSON.parse(raw);
          return Boolean(parsed?.active);
        }
      } catch {}
      return false;
    })(),
    smartStableMap: new Map(),
    smartGraceTimer: null,
    localViewedAtById: Object.create(null),
    groupsBodyHeight: (() => {
      try {
        const v = Number(localStorage.getItem('aq_groups_body_height_v1'));
        return Number.isFinite(v) && v >= 64 ? Math.round(v) : 0;
      } catch {
        return 0;
      }
    })(),
    groupResizeDrag: null,
    groupResizeSnapTimer: null,
    convDrag: null,
    convDragExpandTimer: null,
    convDragHoverGroupTimer: null,
    convDragHoverGroupId: '',
    pendingUnpinCascadeIds: new Set(),
    suppressGroupClickUntil: 0,
    trajMetaById: Object.create(null),
    trajFetchedAt: 0,
    lastMetaSyncKey: '',
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
        cursor: text;
      }
      [data-aq-turn-usage]:focus-visible {
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
        min-width: min(340px, calc(100vw - 24px));
        max-width: min(460px, calc(100vw - 24px));
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
        transition: background-color 0.12s ease;
      }
      .aq-q-acct-row:hover {
        background: rgba(127, 127, 127, 0.14);
      }
      #aq-acct-quota-tooltip {
        width: 288px;
        max-width: min(304px, calc(100vw - 24px));
      }
      .aq-acct-tt-hdr-left {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
        flex: 1;
      }
      .aq-acct-tt-email {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .aq-acct-tt-foot {
        margin-top: 7px;
        padding-top: 6px;
        border-top: 1px solid rgba(127, 127, 127, 0.14);
        font-size: 10px;
        color: var(--muted-foreground, #71717a);
        line-height: 1.4;
      }
      .aq-acct-tt-empty {
        padding: 4px 0 2px;
        font-size: 11px;
        color: var(--muted-foreground, #71717a);
        line-height: 1.5;
      }
      .aq-q-acct-info {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .aq-q-acct-gem {
        display: inline-block;
        width: 5px;
        height: 5px;
        border-radius: 9999px;
        flex-shrink: 0;
        transition: opacity 0.12s ease, background-color 0.12s ease;
      }
      .aq-q-acct-gem.is-available {
        background: rgba(22, 163, 74, 0.56);
      }
      .aq-q-acct-row:hover .aq-q-acct-gem.is-available {
        background: rgba(22, 163, 74, 0.82);
      }
      .aq-q-acct-gem.is-depleted {
        background: rgba(220, 38, 38, 0.46);
      }
      .aq-q-acct-row:hover .aq-q-acct-gem.is-depleted {
        background: rgba(220, 38, 38, 0.74);
      }
      .aq-q-acct-gem.is-unknown {
        background: rgba(127, 127, 127, 0.22);
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-gem.is-available {
        background: rgba(74, 222, 128, 0.52);
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-row:hover .aq-q-acct-gem.is-available {
        background: rgba(74, 222, 128, 0.8);
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-gem.is-depleted {
        background: rgba(248, 113, 113, 0.48);
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-row:hover .aq-q-acct-gem.is-depleted {
        background: rgba(248, 113, 113, 0.76);
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-gem.is-unknown {
        background: rgba(161, 161, 170, 0.24);
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

      /* Sidebar custom conversation groups */
      #aq-conv-groups {
        position: relative;
        flex-shrink: 0;
        margin-top: -7px;
        padding: 6px 8px 6px;
        border-top: 1px solid rgba(127, 127, 127, 0.16);
        border-bottom: 1px solid rgba(127, 127, 127, 0.16);
        font-size: 13px;
        line-height: 1.35;
        user-select: none;
      }
      .aq-grp-resizer {
        position: absolute;
        left: 0;
        right: 0;
        bottom: -5px;
        height: 9px;
        cursor: row-resize;
        z-index: 6;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .aq-grp-resizer::after {
        content: "";
        width: 100%;
        height: 2px;
        border-radius: 1px;
        background: transparent;
        transition: background-color 0.12s ease;
      }
      .aq-grp-resizer:hover::after,
      .aq-grp-resizer.is-resizing::after {
        background: rgba(37, 99, 235, 0.45);
      }
      .aq-grp-resizer-badge {
        position: absolute;
        right: 8px;
        bottom: 6px;
        padding: 1px 6px;
        border-radius: 9999px;
        background: var(--background, #ffffff);
        border: 1px solid rgba(37, 99, 235, 0.35);
        color: #2563eb;
        font-size: 10px;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        line-height: 15px;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.1s ease;
      }
      .aq-grp-resizer.is-resizing .aq-grp-resizer-badge {
        opacity: 1;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-resizer:hover::after,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-resizer.is-resizing::after {
        background: rgba(96, 165, 250, 0.52);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-resizer-badge {
        background: #27272a;
        border-color: rgba(96, 165, 250, 0.45);
        color: #93c5fd;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
      }
      body.aq-resizing-groups,
      body.aq-resizing-groups * {
        cursor: row-resize !important;
        user-select: none !important;
      }
      .aq-grp-sec-hdr {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        padding: 0 6px 4px;
        color: var(--muted-foreground, #71717a);
        font-size: 12px;
        font-weight: 500;
      }
      .aq-grp-sec-toggle {
        appearance: none;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        padding: 0;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
        min-width: 0;
      }
      .aq-grp-sec-toggle:hover {
        color: var(--foreground, #18181b);
      }
      .aq-grp-icon-btn {
        appearance: none;
        border: 0;
        background: transparent;
        color: var(--muted-foreground, #71717a);
        width: 22px;
        height: 22px;
        border-radius: 6px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        padding: 0;
        flex-shrink: 0;
        transition: background 0.12s ease, color 0.12s ease;
      }
      .aq-grp-icon-btn:hover {
        background: rgba(127, 127, 127, 0.14);
        color: var(--foreground, #18181b);
      }
      .aq-grp-icon-btn.aq-grp-danger-confirm {
        width: auto;
        padding: 0 5px;
        font-size: 10.5px;
        font-weight: 600;
        color: #dc2626;
        background: rgba(220, 38, 38, 0.12);
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-icon-btn.aq-grp-danger-confirm {
        color: #f87171;
        background: rgba(248, 113, 113, 0.16);
      }
      .aq-grp-body {
        height: auto;
        max-height: clamp(180px, 40vh, 380px);
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .aq-grp-empty {
        padding: 2px 6px 4px;
        font-size: 11px;
        color: var(--muted-foreground, #71717a);
        opacity: 0.85;
      }
      .aq-grp-error {
        margin: 2px 6px 4px;
        font-size: 11px;
        color: #dc2626;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-error {
        color: #f87171;
      }
      #aq-conv-groups.aq-grp-panel-drop-target {
        background: rgba(37, 99, 235, 0.06);
        box-shadow: inset 0 0 0 1.5px rgba(37, 99, 235, 0.45);
        border-radius: 8px;
      }
      .aq-grp-sec-hdr.aq-grp-drag-root {
        background: rgba(37, 99, 235, 0.1);
        box-shadow: inset 0 0 0 1.5px rgba(37, 99, 235, 0.45);
        border-radius: 6px;
        color: #2563eb;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-sec-hdr.aq-grp-drag-root {
        background: rgba(96, 165, 250, 0.14);
        box-shadow: inset 0 0 0 1.5px rgba(96, 165, 250, 0.5);
        color: #93c5fd;
      }
      .aq-grp-block {
        display: flex;
        flex-direction: column;
        gap: 1px;
        border-radius: 8px;
      }
      .aq-grp-block.aq-grp-drag-before > .aq-grp-hdr {
        box-shadow: inset 0 2px 0 0 #2563eb;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-block.aq-grp-drag-before > .aq-grp-hdr {
        box-shadow: inset 0 2px 0 0 #60a5fa;
      }
      .aq-grp-block.aq-grp-drop-target > .aq-grp-hdr,
      .aq-grp-block.aq-grp-drag-inside > .aq-grp-hdr {
        background: rgba(37, 99, 235, 0.12);
        box-shadow: inset 0 0 0 1.5px rgba(37, 99, 235, 0.55);
        color: #1d4ed8;
      }
      .aq-grp-block.aq-grp-drop-target > .aq-grp-hdr .aq-grp-folder-ico,
      .aq-grp-block.aq-grp-drop-target > .aq-grp-hdr .aq-grp-chev,
      .aq-grp-block.aq-grp-drop-target > .aq-grp-hdr .aq-grp-count,
      .aq-grp-block.aq-grp-drag-inside > .aq-grp-hdr .aq-grp-folder-ico,
      .aq-grp-block.aq-grp-drag-inside > .aq-grp-hdr .aq-grp-chev,
      .aq-grp-block.aq-grp-drag-inside > .aq-grp-hdr .aq-grp-count {
        color: #2563eb;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-block.aq-grp-drop-target > .aq-grp-hdr,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-block.aq-grp-drag-inside > .aq-grp-hdr {
        background: rgba(96, 165, 250, 0.16);
        box-shadow: inset 0 0 0 1.5px rgba(96, 165, 250, 0.58);
        color: #93c5fd;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-block.aq-grp-drop-target > .aq-grp-hdr .aq-grp-folder-ico,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-block.aq-grp-drop-target > .aq-grp-hdr .aq-grp-chev,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-block.aq-grp-drop-target > .aq-grp-hdr .aq-grp-count,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-block.aq-grp-drag-inside > .aq-grp-hdr .aq-grp-folder-ico,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-block.aq-grp-drag-inside > .aq-grp-hdr .aq-grp-chev,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-block.aq-grp-drag-inside > .aq-grp-hdr .aq-grp-count {
        color: #60a5fa;
      }
      .aq-grp-hdr {
        display: flex;
        align-items: center;
        gap: 5px;
        height: 28px;
        padding: 0 6px;
        box-sizing: border-box;
        border-radius: 7px;
        cursor: pointer;
        color: var(--secondary-foreground, #3f3f46);
        font-size: 12.5px;
        font-weight: 500;
      }
      .aq-grp-hdr:hover {
        background: var(--sidebar-muted, rgba(127, 127, 127, 0.1));
        color: var(--foreground, #18181b);
      }
      .aq-grp-chev {
        width: 12px;
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--muted-foreground, #71717a);
        transition: transform 0.12s ease;
      }
      .aq-grp-chev.is-open {
        transform: rotate(90deg);
      }
      .aq-grp-folder-ico {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--muted-foreground, #71717a);
      }
      .aq-grp-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .aq-grp-count {
        font-size: 11px;
        color: var(--muted-foreground, #71717a);
        flex-shrink: 0;
        margin-right: 2px;
      }
      .aq-grp-actions {
        display: none;
        align-items: center;
        gap: 1px;
        flex-shrink: 0;
      }
      .aq-grp-hdr:hover .aq-grp-actions,
      .aq-grp-hdr.has-confirm .aq-grp-actions {
        display: inline-flex;
      }
      .aq-grp-hdr:hover .aq-grp-count,
      .aq-grp-hdr.has-confirm .aq-grp-count {
        display: none;
      }
      .aq-grp-hdr.is-smart:hover .aq-grp-count {
        display: inline;
      }
      .aq-grp-count.is-highlight {
        color: var(--foreground, #18181b);
        font-weight: 600;
      }
      .aq-grp-smart-sep {
        height: 1px;
        margin: 4px 4px;
        background: rgba(127, 127, 127, 0.14);
      }
      .aq-smart-children {
        display: grid;
        grid-template-rows: 1fr;
        opacity: 1;
        transition: grid-template-rows 190ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 160ms ease;
      }
      .aq-smart-children.is-collapsed {
        grid-template-rows: 0fr;
        opacity: 0;
        pointer-events: none;
      }
      .aq-smart-children-inner {
        overflow: hidden;
        min-height: 0;
      }
      .aq-smart-list {
        display: flex;
        flex-direction: column;
      }
      .aq-smart-slot {
        display: grid;
        grid-template-rows: 1fr;
        opacity: 1;
        transition: grid-template-rows 200ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 180ms ease;
      }
      .aq-smart-slot.is-entering,
      .aq-smart-slot.is-leaving {
        grid-template-rows: 0fr;
        opacity: 0;
        pointer-events: none;
      }
      .aq-smart-slot-inner {
        overflow: hidden;
        min-height: 0;
        padding-bottom: 1px;
      }
      .aq-smart-empty-wrap {
        display: grid;
        grid-template-rows: 1fr;
        opacity: 1;
        transition: grid-template-rows 180ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 150ms ease;
      }
      .aq-smart-empty-wrap.is-hidden {
        grid-template-rows: 0fr;
        opacity: 0;
        pointer-events: none;
      }
      .aq-smart-empty-inner {
        overflow: hidden;
        min-height: 0;
      }
      .aq-grp-children {
        display: flex;
        flex-direction: column;
        gap: 1px;
        margin-left: 11px;
        padding-left: 6px;
        border-left: 1px solid rgba(127, 127, 127, 0.16);
      }
      .aq-gm-tree-branch {
        color: var(--muted-foreground, #71717a);
        opacity: 0.7;
        font-size: 11px;
        flex-shrink: 0;
        margin-right: -2px;
      }
      .aq-grp-item {
        position: relative;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 6px 4px 10px;
        min-height: 32px;
        box-sizing: border-box;
        border-radius: 8px;
        cursor: pointer;
        color: var(--secondary-foreground, #3f3f46);
        min-width: 0;
      }
      .aq-grp-item.is-dragging {
        opacity: 0.45;
      }
      .aq-grp-item:hover {
        background: var(--sidebar-muted, rgba(127, 127, 127, 0.1));
        color: var(--foreground, #18181b);
      }
      .aq-grp-item.is-active {
        background: var(--sidebar-secondary, rgba(127, 127, 127, 0.16));
        color: var(--foreground, #18181b);
        font-weight: 500;
      }
      .aq-grp-item-main {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .aq-grp-item-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12.5px;
        line-height: 1.35;
      }
      .aq-grp-item-sub {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        font-size: 11px;
        color: var(--muted-foreground, #71717a);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .aq-grp-item-sub > span {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .aq-grp-item-status {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        color: var(--foreground, #18181b);
      }
      .aq-grp-item:hover .aq-grp-item-status {
        display: none;
      }
      @keyframes aqAgentStateDot {
        0%, 100% {
          opacity: 0.25;
        }
        50% {
          opacity: 1;
        }
      }
      .aq-grp-status-spinner {
        display: grid;
        place-content: center;
        width: 16px;
        height: 16px;
        grid-template-columns: repeat(2, 4px);
        gap: 2px;
        opacity: 0.7;
      }
      .aq-grp-status-spinner > span {
        width: 4px;
        height: 4px;
        border-radius: 9999px;
        background: currentColor;
        animation: 1.4s ease-in-out infinite aqAgentStateDot;
      }
      .aq-grp-status-spinner > span:nth-child(1) {
        animation-delay: 0s;
      }
      .aq-grp-status-spinner > span:nth-child(2) {
        animation-delay: -1.05s;
      }
      .aq-grp-status-spinner > span:nth-child(3) {
        animation-delay: -0.35s;
      }
      .aq-grp-status-spinner > span:nth-child(4) {
        animation-delay: -0.7s;
      }
      .aq-grp-status-unread {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
      }
      .aq-grp-status-unread-halo {
        position: absolute;
        width: 14px;
        height: 14px;
        border-radius: 9999px;
        background: var(--primary, var(--foreground, #18181b));
        opacity: 0.12;
      }
      .aq-grp-status-unread-core {
        width: 6px;
        height: 6px;
        border-radius: 9999px;
        background: var(--primary, var(--foreground, #18181b));
      }
      @keyframes aqWaitingPulse {
        0%, 100% {
          transform: scale(0.85);
          opacity: 0.35;
        }
        50% {
          transform: scale(1.2);
          opacity: 0.12;
        }
      }
      .aq-grp-status-waiting {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
      }
      .aq-grp-status-waiting-halo {
        position: absolute;
        width: 14px;
        height: 14px;
        border-radius: 9999px;
        background: #d97706;
        animation: 1.6s ease-in-out infinite aqWaitingPulse;
      }
      .aq-grp-status-waiting-core {
        width: 6px;
        height: 6px;
        border-radius: 9999px;
        background: #d97706;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-status-waiting-halo,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-status-waiting-core {
        background: #fbbf24;
      }
      .aq-grp-item-actions {
        display: none;
        align-items: center;
        gap: 1px;
        flex-shrink: 0;
      }
      .aq-grp-item:hover .aq-grp-item-actions {
        display: inline-flex;
      }
      .aq-grp-item-empty {
        padding: 3px 10px 4px;
        font-size: 11px;
        color: var(--muted-foreground, #71717a);
        opacity: 0.78;
      }
      .aq-grp-inline-form {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 3px 6px;
      }
      .aq-grp-input {
        flex: 1;
        min-width: 0;
        height: 24px;
        padding: 0 7px;
        border-radius: 6px;
        border: 1px solid rgba(127, 127, 127, 0.35);
        background: var(--background, #ffffff);
        color: var(--foreground, #18181b);
        font: inherit;
        font-size: 12px;
        outline: none;
      }
      .aq-grp-input:focus {
        border-color: #2563eb;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-input {
        background: #18181b;
        color: #f4f4f5;
        border-color: rgba(255, 255, 255, 0.2);
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-hdr,
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-item {
        color: #d4d4d8;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-hdr:hover,
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-item:hover,
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-item.is-active,
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-sec-toggle:hover,
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-icon-btn:hover {
        color: #fafafa;
      }
      .aq-grp-mini-btn {
        appearance: none;
        border: 1px solid rgba(127, 127, 127, 0.28);
        background: rgba(127, 127, 127, 0.08);
        color: inherit;
        height: 24px;
        padding: 0 7px;
        border-radius: 6px;
        font: inherit;
        font-size: 11px;
        cursor: pointer;
        flex-shrink: 0;
      }
      .aq-grp-mini-btn:hover {
        background: rgba(127, 127, 127, 0.18);
      }
      .aq-grp-mini-btn.is-primary {
        background: rgba(37, 99, 235, 0.14);
        border-color: rgba(37, 99, 235, 0.36);
        color: #2563eb;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-mini-btn.is-primary {
        color: #60a5fa;
      }
      .bg-sidebar .agy-sidebar-row .agy-row-actions > button[data-testid="conversation-archive-button"],
      .bg-sidebar .agy-sidebar-row .agy-row-actions > button[aria-label="Stop execution"],
      .bg-sidebar .agy-sidebar-row .agy-row-actions > button[aria-label="停止执行"] {
        display: none !important;
      }
      body.aq-dragging-to-group .bg-sidebar [aria-hidden="true"].surface-opaque {
        opacity: 0 !important;
      }
      #aq-conv-drag-ghost {
        position: fixed;
        z-index: 2147483646;
        display: none;
        align-items: center;
        gap: 6px;
        max-width: 228px;
        padding: 6px 10px;
        border-radius: 9px;
        background: rgba(255, 255, 255, 0.97);
        color: #18181b;
        border: 1px solid rgba(37, 99, 235, 0.35);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
        font-size: 12px;
        font-weight: 500;
        line-height: 1.3;
        pointer-events: none;
        user-select: none;
      }
      #aq-conv-drag-ghost.is-visible {
        display: inline-flex;
      }
      #aq-conv-drag-ghost .aq-cdg-ico {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        color: #2563eb;
      }
      #aq-conv-drag-ghost .aq-cdg-title {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #aq-conv-drag-ghost .aq-cdg-badge {
        flex-shrink: 0;
        padding: 1px 5px;
        border-radius: 5px;
        background: rgba(37, 99, 235, 0.12);
        color: #2563eb;
        font-size: 10.5px;
        font-weight: 600;
        max-width: 96px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) #aq-conv-drag-ghost {
        background: rgba(24, 24, 30, 0.97);
        color: #f4f4f5;
        border-color: rgba(96, 165, 250, 0.4);
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.48);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) #aq-conv-drag-ghost .aq-cdg-ico {
        color: #60a5fa;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) #aq-conv-drag-ghost .aq-cdg-badge {
        background: rgba(96, 165, 250, 0.18);
        color: #93c5fd;
      }
      #aq-group-menu {
        position: fixed;
        z-index: 2147483647;
        display: none;
        width: 224px;
        padding: 8px;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.98);
        color: #18181b;
        border: 1px solid rgba(0, 0, 0, 0.12);
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16);
        font-size: 12px;
        line-height: 1.4;
      }
      #aq-group-menu.is-visible {
        display: block;
      }
      :is(body.dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) #aq-group-menu {
        background: rgba(24, 24, 27, 0.98);
        color: #f4f4f5;
        border-color: rgba(255, 255, 255, 0.14);
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
      }
      .aq-gm-hdr {
        font-size: 11px;
        font-weight: 600;
        color: var(--muted-foreground, #71717a);
        padding: 0 4px 6px;
        border-bottom: 1px solid rgba(127, 127, 127, 0.16);
        margin-bottom: 5px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .aq-gm-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
        max-height: 180px;
        overflow-y: auto;
        margin-bottom: 6px;
      }
      .aq-gm-opt {
        appearance: none;
        border: 0;
        background: transparent;
        color: inherit;
        width: 100%;
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 5px 6px;
        border-radius: 6px;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .aq-gm-opt:hover {
        background: rgba(127, 127, 127, 0.12);
      }
      .aq-gm-check {
        width: 14px;
        height: 14px;
        border-radius: 4px;
        border: 1.5px solid rgba(127, 127, 127, 0.45);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        flex-shrink: 0;
      }
      .aq-gm-opt.is-checked .aq-gm-check {
        background: #2563eb;
        border-color: #2563eb;
        color: #ffffff;
      }
      .aq-gm-opt-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .aq-gm-opt-cnt {
        font-size: 10.5px;
        color: var(--muted-foreground, #71717a);
      }
      .aq-gm-create {
        display: flex;
        align-items: center;
        gap: 4px;
        padding-top: 6px;
        border-top: 1px solid rgba(127, 127, 127, 0.16);
      }
    `;
  }

  function extractCascadeId() {
    try {
      const view = document.querySelector('[data-testid="conversation-view"][data-cascade-id]');
      const viewCid = view?.getAttribute('data-cascade-id')?.trim() || '';
      if (viewCid && /^[0-9a-f-]{36}$/i.test(viewCid)) return viewCid;

      const selected = document.querySelector(
        '.bg-sidebar [data-testid="conversation-row-sidebar"][data-selected="true"][data-cascade-id]'
      );
      const selCid = selected?.getAttribute('data-cascade-id')?.trim() || '';
      if (selCid && /^[0-9a-f-]{36}$/i.test(selCid)) return selCid;

      const hasSidebarRows = Boolean(
        document.querySelector('.bg-sidebar [data-testid="conversation-row-sidebar"]')
      );
      if (hasSidebarRows) return '';

      const m = window.location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
      if (m) return m[1];
      const q = new URLSearchParams(window.location.search).get('cascadeId');
      if (q && /^[0-9a-f-]{36}$/i.test(q)) return q;
    } catch {}
    return '';
  }

  function ensureTooltipEl(id) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.className = 'aq-floating-tooltip';
      if (id === 'aq-quota-tooltip') {
        el.addEventListener('click', (ev) => {
          const target = ev.target;
          if (target?.closest?.('button, a, input, [data-aq-acct-add], [data-aq-acct-switch], [data-aq-acct-del], [data-aq-update-open]')) {
            return;
          }
          if (String(window.getSelection?.()?.toString() || '').trim()) {
            return;
          }
          state.quotaTooltipPinned = true;
          sendAccountAction({ type: 'list' });
          void fetchQuota({ force: true, immediate: true, includeUserStatus: true });
        });
      } else if (id === 'aq-acct-quota-tooltip') {
        el.addEventListener('pointerenter', () => {
          if (state.acctQuotaTooltipHideTimer) {
            clearTimeout(state.acctQuotaTooltipHideTimer);
            state.acctQuotaTooltipHideTimer = null;
          }
          if (state.quotaTooltipHideTimer) {
            clearTimeout(state.quotaTooltipHideTimer);
            state.quotaTooltipHideTimer = null;
          }
        });
        el.addEventListener('pointerleave', () => {
          scheduleHideAccountQuotaTooltip();
          if (!state.quotaTooltipPinned) {
            scheduleHideQuotaTooltip();
          }
        });
      }
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

    const cost = turn.cost || {};
    const cacheHit = formatCacheHitRate(turn.cachedInputTokens, turn.inputTokens);
    const firstTok = formatDurationMs(turn.firstTokenLatencyMs) || '—';
    const speed = formatRate(turn.outputSpeed) || '—';
    const modelLabel =
      (cost.normalizedModel && cost.normalizedModel !== 'multiple' ? cost.normalizedModel : '') ||
      turn.modelLabel ||
      turn.model ||
      'Token 费用明细';
    const totalLabel = turn.completed ? cost.label || '本轮费用' : '实时估算';
    const headerRightText = cost.available ? `${totalLabel} ${formatCny(cost.totalCny)}` : '费用暂不可算';

    const rawTiers =
      Array.isArray(cost.tiers) && cost.tiers.length > 0
        ? cost.tiers.map((t) => ({ cost: t, usage: t.tokenUsage || {} }))
        : [
            {
              cost,
              usage: {
                inputTokens: Number(turn.inputTokens || 0),
                uncachedInputTokens: Number(turn.uncachedInputTokens || 0),
                cachedInputTokens: Number(turn.cachedInputTokens || 0),
                outputTokens: Number(turn.outputTokens || 0),
                thinkingTokens: Number(turn.thinkingTokens || 0),
                responseTokens: Number(turn.responseTokens || 0),
              },
            },
          ];
    const tierModels = new Set(rawTiers.map((t) => t.cost?.normalizedModel).filter(Boolean));
    const tierCtxSet = new Set(rawTiers.map((t) => t.cost?.contextTier).filter(Boolean));
    const showTierModel = tierModels.size > 1;
    const isMixedCtx = tierCtxSet.has('short') && tierCtxSet.has('long');
    const isPureLongCtx = tierCtxSet.has('long') && !tierCtxSet.has('short');

    const tiers = rawTiers.map((t) => {
      const ctxName = t.cost?.contextTier;
      const ctxSuffix = isMixedCtx ? formatContextTier(ctxName) : isPureLongCtx && ctxName === 'long' ? '长' : '';
      const suffixParts = [showTierModel ? t.cost?.normalizedModel : '', ctxSuffix].filter(Boolean);
      const u = t.usage || {};
      return {
        cost: t.cost,
        inputTokens: Math.max(0, Number(u.inputTokens || 0)),
        uncachedInputTokens: Math.max(0, Number(u.uncachedInputTokens || 0)),
        cachedInputTokens: Math.max(0, Number(u.cachedInputTokens || 0)),
        outputTokens: Math.max(0, Number(u.outputTokens || 0)),
        thinkingTokens: Math.max(0, Number(u.thinkingTokens || 0)),
        responseTokens: Math.max(0, Number(u.responseTokens || 0)),
        labelSuffix: suffixParts.length > 0 ? `（${suffixParts.join(' · ')}）` : '',
      };
    });

    const inputSummaryCostCny = cost.available
      ? tiers.reduce(
          (sum, t) =>
            sum +
            (Number(t.cost?.componentsCny?.ordinaryInput) || 0) +
            (Number(t.cost?.componentsCny?.cachedInput) || 0),
          0
        )
      : null;

    const renderTierRowHtml = (label, getTokens, component, note = '', unitComponent = component) =>
      tiers
        .map((t) => {
          const unitPrice = t.cost?.available ? formatUnitPrice(t.cost, unitComponent) : '未知';
          const amtText = t.cost?.available
            ? `${formatCny(t.cost.componentsCny?.[component])}${note ? `（${note}）` : ''}`
            : '暂不可算';
          return `<div class="aq-tt-row aq-tt-row-sec"><span class="aq-tt-lbl">${escapeHtml(`${label}${t.labelSuffix}`)} ${formatTokenCount(getTokens(t))} · ${escapeHtml(unitPrice)}</span><span class="aq-tt-val">${escapeHtml(amtText)}</span></div>`;
        })
        .join('');

    const callDetails = Array.isArray(turn.callDetails) ? turn.callDetails : [];
    const callModels = new Set(callDetails.map((c) => c.model).filter(Boolean));
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
          if (callModels.size > 1 && c.model) stageParts.push(c.model);
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

    const thinkingTiers = tiers.filter((t) => t.thinkingTokens > 0);
    const thinkingRowsHtml = thinkingTiers
      .map((t) => {
        const unitPrice = t.cost?.available ? formatUnitPrice(t.cost, 'output') : '未知';
        const amtText = t.cost?.available
          ? `${formatCny(t.cost.componentsCny?.reasoningOutput)}（已包含在输出费用中）`
          : '暂不可算';
        return `<div class="aq-tt-row aq-tt-row-sec"><span class="aq-tt-lbl">${escapeHtml(`思考输出${t.labelSuffix}`)} ${formatTokenCount(t.thinkingTokens)} · ${escapeHtml(unitPrice)}</span><span class="aq-tt-val">${escapeHtml(amtText)}</span></div>`;
      })
      .join('');
    const thinkingHtml =
      Number(turn.thinkingTokens) > 0
        ? `
          <details class="aq-tt-details">
            <summary>显示思考输出 ${formatTokenCount(turn.thinkingTokens)}（已计入输出）</summary>
            <div class="aq-tt-details-body">
              ${thinkingRowsHtml}
              <div class="aq-tt-row aq-tt-row-sec"><span class="aq-tt-lbl">正文 / 工具输出</span><span class="aq-tt-val">${formatTokenCount(turn.responseTokens)}</span></div>
            </div>
          </details>
        `
        : '';

    const cumulativeText = cost.cumulativeAvailable
      ? formatCny(cost.cumulativeCny)
      : Number(cost.cumulativeCny) > 0
        ? `已确认 ${formatCny(cost.cumulativeCny)} · 待确认 ${Number(cost.cumulativePendingTurns) || 1} 轮`
        : '待确认';

    const hasAnthropicUncached =
      Number(turn.uncachedInputTokens) > 0 &&
      (cost.provider === 'anthropic' || (Array.isArray(cost.providers) && cost.providers.includes('anthropic')));
    const anthropicCacheNoteHtml = hasAnthropicUncached
      ? '<span>未区分缓存写入与普通输入，未缓存部分按标准输入计价</span>'
      : '';
    const exchangeRateHtml = cost.exchangeRate
      ? `<span>${escapeHtml(`汇率 1 USD = ${formatExchangeRate(cost.exchangeRate.rate)} CNY · ${cost.exchangeRate.date} · ${cost.exchangeRate.source}${cost.exchangeRate.fallback ? '（内置备用值）' : ''}`)}</span>`
      : '';

    tt.innerHTML = `
      <div class="aq-tt-hdr">
        <span>${escapeHtml(modelLabel)}</span>
        <span class="aq-tt-val">${escapeHtml(headerRightText)}</span>
      </div>
      <div class="aq-tt-section">
        <div class="aq-tt-row aq-tt-row-strong"><span class="aq-tt-lbl">输入总量 ${formatTokenCount(turn.inputTokens)}</span><span class="aq-tt-val">${escapeHtml(inputSummaryCostCny == null ? '暂不可算' : formatCny(inputSummaryCostCny))}</span></div>
        ${renderTierRowHtml('未缓存输入', (t) => t.uncachedInputTokens, 'ordinaryInput')}
        ${renderTierRowHtml('缓存输入', (t) => t.cachedInputTokens, 'cachedInput')}
        <div class="aq-tt-row aq-tt-row-ter"><span>缓存命中率 ${cacheHit}</span><span class="aq-tt-val">${formatTokenCount(turn.cachedInputTokens)} / ${formatTokenCount(turn.inputTokens)}</span></div>
        ${renderTierRowHtml('输出', (t) => t.outputTokens, 'output')}
        ${callsSummaryHtml}
        ${thinkingHtml}
      </div>
      <div class="aq-tt-cum">
        <span>累计费用</span>
        <span class="aq-tt-val">${escapeHtml(cumulativeText)}</span>
      </div>
      <div class="aq-tt-meta">
        <span>${escapeHtml(formatPricingSourceNote(cost))}</span>
        ${anthropicCacheNoteHtml}
        ${exchangeRateHtml}
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
            const planLabel = (isCur && state.userProfile?.planName) || acct.planName;
            const gemQuotaSource = isCur && state.quotaData?.groups?.length ? state.quotaData : acct.quotaSnapshot;
            const gemStatus = resolveGeminiQuotaAvailability(gemQuotaSource, { isCurrent: isCur });
            const confirming = state.pendingSwitchConfirmId === acct.id;
            const switchBtn = isCur
              ? '<span class="aq-q-active-tag">当前</span>'
              : `<button type="button" class="aq-q-btn ${confirming ? 'aq-q-btn-warn' : 'aq-q-btn-primary'}" data-aq-acct-switch="${escapeHtml(acct.id)}" ${state.accountsBusy ? 'disabled' : ''}>${confirming ? '确认重启' : '切换'}</button>`;
            return `
              <div class="aq-q-acct-row" data-aq-acct-id="${escapeHtml(acct.id)}">
                <div class="aq-q-acct-info">
                  <span class="aq-q-acct-gem is-${escapeHtml(gemStatus.state)}" data-aq-acct-gem="${escapeHtml(gemStatus.state)}" title="${escapeHtml(gemStatus.label)}" aria-label="${escapeHtml(gemStatus.label)}"></span>
                  <span class="aq-q-acct-email" title="${escapeHtml(acct.email)}">${escapeHtml(acct.email)}</span>
                  ${planLabel ? `<span class="aq-q-acct-plan">${escapeHtml(planLabel)}</span>` : ''}
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

      const headerStatusHtml = state.quotaError
        ? `<span class="aq-tt-sub">${escapeHtml(state.quotaError)}</span>`
        : state.quotaFetching
          ? '<span class="aq-tt-sub">刷新中…</span>'
          : '';

      tt.innerHTML = `
        <div class="aq-tt-hdr">
          <span>上下文与配额</span>
          ${headerStatusHtml}
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

  function buildCurrentQuotaSnapshot() {
    const rawGroups = state.quotaData?.groups;
    if (!Array.isArray(rawGroups) || rawGroups.length === 0) return null;
    const groups = [];
    for (let i = 0; i < rawGroups.length; i++) {
      const g = rawGroups[i];
      if (!g || typeof g !== 'object') continue;
      const rawBuckets = Array.isArray(g.buckets) ? g.buckets : [];
      const buckets = [];
      for (let j = 0; j < rawBuckets.length; j++) {
        const b = rawBuckets[j];
        if (!b || typeof b !== 'object' || b.disabled) continue;
        const frac = Number(b.remainingFraction);
        if (!Number.isFinite(frac)) continue;
        buckets.push({
          bucketId: String(b.bucketId || '').trim(),
          displayName: String(b.displayName || '').trim(),
          window: String(b.window || '').trim(),
          remainingFraction: Math.max(0, Math.min(1, frac)),
          resetTime: String(b.resetTime || '').trim(),
        });
      }
      const displayName = String(g.displayName || '').trim();
      if (displayName || buckets.length > 0) {
        groups.push({ displayName: displayName || '模型分组', buckets });
      }
    }
    if (groups.length === 0) return null;
    return {
      updatedAt: new Date(state.quotaFetchedAt || Date.now()).toISOString(),
      groups,
    };
  }

  function syncCurrentAccountQuotaSnapshot() {
    if (!state.accountsMetaLoaded || !state.accountsSupported) return;
    const email = String(state.userProfile?.email || '').trim().toLowerCase();
    if (!email) return;
    const snap = buildCurrentQuotaSnapshot();
    if (!snap) return;
    const sig = `${email}|${JSON.stringify(snap.groups)}`;
    if (sig === state.lastSyncedQuotaSnapSig) return;
    state.lastSyncedQuotaSnapSig = sig;
    sendAccountAction({ type: 'sync-quota', quota: snap });
  }

  function sendAccountAction(payload) {
    if (typeof window.__aqAccountAction !== 'function') return;
    try {
      const type = String(payload?.type || '');
      const shouldAttachQuota =
        !payload?.quota &&
        (type === 'save' || type === 'switch' || type === 'add-account' || type === 'prepare-add');
      const quota = shouldAttachQuota ? buildCurrentQuotaSnapshot() : payload?.quota || null;
      window.__aqAccountAction(
        JSON.stringify({
          ...payload,
          ...(quota ? { quota } : {}),
          profile: state.userProfile,
        })
      );
    } catch {}
  }

  function sendUpdateAction(payload) {
    if (typeof window.__aqUpdateAction !== 'function') return;
    try {
      window.__aqUpdateAction(JSON.stringify(payload || {}));
    } catch {}
  }

  function formatSnapshotTimeLabel(isoStr) {
    const ts = Date.parse(String(isoStr || ''));
    if (!Number.isFinite(ts)) return '本地快照';
    const diffMs = Date.now() - ts;
    if (diffMs < 60_000) return '刚刚记录';
    if (diffMs < 3600_000) return `记录于 ${Math.floor(diffMs / 60_000)}分钟前`;
    if (diffMs < 24 * 3600_000) return `记录于 ${Math.floor(diffMs / 3600_000)}小时前`;
    const d = new Date(ts);
    const pad2 = (n) => String(n).padStart(2, '0');
    return `记录于 ${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function positionAccountQuotaTooltip(subTt, anchorRow) {
    const mainTt = document.getElementById('aq-quota-tooltip');
    const mainRect = mainTt?.getBoundingClientRect?.();
    const rowRect = anchorRow?.getBoundingClientRect?.() || mainRect;
    if (!rowRect) return;
    const subW = subTt.offsetWidth || 288;
    const subH = subTt.offsetHeight || 160;
    const gap = 8;

    let left;
    if (mainRect && mainRect.left - subW - gap >= 8) {
      left = mainRect.left - subW - gap;
    } else if (mainRect && mainRect.right + gap + subW <= window.innerWidth - 8) {
      left = mainRect.right + gap;
    } else {
      left = Math.max(8, Math.min(rowRect.left, window.innerWidth - subW - 8));
    }

    const preferTop = rowRect.top - 8;
    const maxTop = Math.max(8, window.innerHeight - subH - 8);
    const top = Math.max(8, Math.min(preferTop, maxTop));
    subTt.style.left = `${Math.round(left)}px`;
    subTt.style.top = `${Math.round(top)}px`;
  }

  function hideAccountQuotaTooltip() {
    if (state.acctQuotaTooltipShowTimer) {
      clearTimeout(state.acctQuotaTooltipShowTimer);
      state.acctQuotaTooltipShowTimer = null;
    }
    if (state.acctQuotaTooltipHideTimer) {
      clearTimeout(state.acctQuotaTooltipHideTimer);
      state.acctQuotaTooltipHideTimer = null;
    }
    state.acctQuotaTooltipId = '';
    const subTt = document.getElementById('aq-acct-quota-tooltip');
    if (subTt) subTt.removeAttribute('data-visible');
  }

  function scheduleHideAccountQuotaTooltip() {
    if (state.acctQuotaTooltipShowTimer) {
      clearTimeout(state.acctQuotaTooltipShowTimer);
      state.acctQuotaTooltipShowTimer = null;
    }
    if (state.acctQuotaTooltipHideTimer) clearTimeout(state.acctQuotaTooltipHideTimer);
    state.acctQuotaTooltipHideTimer = setTimeout(() => {
      state.acctQuotaTooltipHideTimer = null;
      state.acctQuotaTooltipId = '';
      const subTt = document.getElementById('aq-acct-quota-tooltip');
      if (subTt) subTt.removeAttribute('data-visible');
    }, 140);
  }

  function showAccountQuotaTooltip(acctId, anchorRow) {
    if (state.acctQuotaTooltipShowTimer) {
      clearTimeout(state.acctQuotaTooltipShowTimer);
      state.acctQuotaTooltipShowTimer = null;
    }
    if (state.acctQuotaTooltipHideTimer) {
      clearTimeout(state.acctQuotaTooltipHideTimer);
      state.acctQuotaTooltipHideTimer = null;
    }
    const acct = (Array.isArray(state.accounts) ? state.accounts : []).find((a) => a.id === acctId);
    if (!acct) {
      hideAccountQuotaTooltip();
      return;
    }

    state.acctQuotaTooltipId = acct.id;
    const subTt = ensureTooltipEl('aq-acct-quota-tooltip');
    const curEmail = String(state.userProfile?.email || '').trim().toLowerCase();
    const isCur = Boolean(acct.active || (curEmail && String(acct.email || '').toLowerCase() === curEmail));
    const planLabel = (isCur && state.userProfile?.planName) || acct.planName || '';
    const liveSnap = isCur ? buildCurrentQuotaSnapshot() : null;
    const snap = liveSnap || acct.quotaSnapshot || null;
    const groups = Array.isArray(snap?.groups) ? snap.groups : [];
    const nowMs = Date.now();

    const subLabel = isCur
      ? '当前实时'
      : snap
        ? formatSnapshotTimeLabel(snap.updatedAt)
        : '暂无记录';

    if (groups.length === 0) {
      subTt.innerHTML = `
        <div class="aq-tt-hdr">
          <span class="aq-acct-tt-hdr-left">
            <span class="aq-acct-tt-email" title="${escapeHtml(acct.email)}">${escapeHtml(acct.email)}</span>
            ${planLabel ? `<span class="aq-q-acct-plan">${escapeHtml(planLabel)}</span>` : ''}
          </span>
          <span class="aq-tt-sub">${escapeHtml(subLabel)}</span>
        </div>
        <div class="aq-acct-tt-empty">${
          isCur ? '正在加载当前账号配额…' : '尚未记录该账号的额度快照，切换登录一次后将自动记录。'
        }</div>
      `;
    } else {
      const blocks = groups.map((g) => {
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
            const resetTs = Date.parse(b.resetTime || '');
            const isExpired = !isCur && Number.isFinite(resetTs) && resetTs <= nowMs;
            let valHtml;
            if (isExpired) {
              const origNote = Number(b.remainingFraction) < 0.995 ? `原 ${pct}` : '预计满额';
              valHtml = `<span class="aq-lvl-ok">已重置</span><span class="aq-q-reset"> · ${escapeHtml(origNote)}</span>`;
            } else {
              const reset = formatResetCountdown(b.resetTime);
              valHtml = `<span class="${lvl}">${pct}</span>${reset ? `<span class="aq-q-reset"> · ${escapeHtml(reset)}</span>` : ''}`;
            }
            return `
              <div class="aq-tt-row">
                <span class="aq-tt-lbl">${label}</span>
                <span class="aq-tt-val">${valHtml}</span>
              </div>
            `;
          })
          .join('');

        return `
          <div class="aq-q-group">
            <div class="aq-q-group-hdr">
              <span>${escapeHtml(g.displayName || '模型分组')}</span>
            </div>
            <div class="aq-tt-grid">${bucketHtml || '<div class="aq-tt-sub">暂无配额</div>'}</div>
          </div>
        `;
      });

      const footHtml = isCur
        ? ''
        : '<div class="aq-acct-tt-foot">基于本地记录与重置时间推算 · 若在其他设备消耗过请切换后刷新</div>';

      subTt.innerHTML = `
        <div class="aq-tt-hdr">
          <span class="aq-acct-tt-hdr-left">
            <span class="aq-acct-tt-email" title="${escapeHtml(acct.email)}">${escapeHtml(acct.email)}</span>
            ${planLabel ? `<span class="aq-q-acct-plan">${escapeHtml(planLabel)}</span>` : ''}
          </span>
          <span class="aq-tt-sub">${escapeHtml(subLabel)}</span>
        </div>
        ${blocks.join('')}
        ${footHtml}
      `;
    }

    positionAccountQuotaTooltip(subTt, anchorRow);
    subTt.setAttribute('data-visible', '1');
  }

  function refreshQuotaTooltipIfVisible() {
    const tt = document.getElementById('aq-quota-tooltip');
    const anchor = state.quotaTooltipAnchor?.isConnected
      ? state.quotaTooltipAnchor
      : document.getElementById('aq-quota-chip');
    if (tt?.getAttribute('data-visible') === '1' && anchor) {
      showQuotaTooltip(anchor);
      const subTt = document.getElementById('aq-acct-quota-tooltip');
      if (state.acctQuotaTooltipId && subTt?.getAttribute('data-visible') === '1') {
        const row = tt.querySelector(`.aq-q-acct-row[data-aq-acct-id="${CSS.escape(state.acctQuotaTooltipId)}"]`);
        if (row) {
          showAccountQuotaTooltip(state.acctQuotaTooltipId, row);
        } else {
          hideAccountQuotaTooltip();
        }
      }
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
    const acctRows = tt.querySelectorAll('.aq-q-acct-row[data-aq-acct-id]');
    for (let i = 0; i < acctRows.length; i++) {
      const row = acctRows[i];
      const acctId = row.getAttribute('data-aq-acct-id') || '';
      if (!acctId) continue;
      row.addEventListener('pointerenter', () => {
        if (state.acctQuotaTooltipHideTimer) {
          clearTimeout(state.acctQuotaTooltipHideTimer);
          state.acctQuotaTooltipHideTimer = null;
        }
        const subTt = document.getElementById('aq-acct-quota-tooltip');
        if (subTt?.getAttribute('data-visible') === '1') {
          showAccountQuotaTooltip(acctId, row);
          return;
        }
        if (state.acctQuotaTooltipShowTimer) clearTimeout(state.acctQuotaTooltipShowTimer);
        state.acctQuotaTooltipShowTimer = setTimeout(() => {
          state.acctQuotaTooltipShowTimer = null;
          if (!row.isConnected) return;
          showAccountQuotaTooltip(acctId, row);
        }, 100);
      });
      row.addEventListener('pointerleave', () => {
        scheduleHideAccountQuotaTooltip();
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
    hideAccountQuotaTooltip();
  }

  function scheduleHideQuotaTooltip() {
    if (state.quotaTooltipPinned) return;
    if (state.quotaTooltipHideTimer) clearTimeout(state.quotaTooltipHideTimer);
    state.quotaTooltipHideTimer = setTimeout(() => {
      state.quotaTooltipHideTimer = null;
      if (state.quotaTooltipPinned) return;
      if (document.querySelector('#aq-quota-tooltip:hover, #aq-acct-quota-tooltip:hover')) return;
      const tt = document.getElementById('aq-quota-tooltip');
      if (tt) tt.removeAttribute('data-visible');
      state.quotaTooltipAnchor = null;
      hideAccountQuotaTooltip();
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

    const handleQuotaChipClick = (anchorEl, ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (state.quotaTooltipShowTimer) {
        clearTimeout(state.quotaTooltipShowTimer);
        state.quotaTooltipShowTimer = null;
      }
      if (state.quotaTooltipHideTimer) {
        clearTimeout(state.quotaTooltipHideTimer);
        state.quotaTooltipHideTimer = null;
      }
      state.quotaTooltipPinned = true;
      state.quotaTooltipAnchor = anchorEl;
      sendAccountAction({ type: 'list' });
      if (state.updateInfo && state.updateInfo.enabled !== false) {
        sendUpdateAction({ type: 'check' });
      }
      showQuotaTooltip(anchorEl);
      void fetchQuota({ force: true, immediate: true, includeUserStatus: true });
    };

    let ctxChip = document.getElementById('aq-context-chip');
    if (!ctxChip) {
      ctxChip = document.createElement('div');
      ctxChip.id = 'aq-context-chip';
      ctxChip.setAttribute('role', 'button');
      ctxChip.setAttribute('tabindex', '0');
      ctxChip.setAttribute('aria-label', '当前会话上下文占用，点击立即刷新配额');
      bindTooltipTrigger(ctxChip, quotaTriggerOpts);
      ctxChip.addEventListener('click', (ev) => handleQuotaChipClick(ctxChip, ev));
      ctxChip.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          handleQuotaChipClick(ctxChip, ev);
        }
      });
    }

    let chipCreated = false;
    let chip = document.getElementById('aq-quota-chip');
    if (!chip) {
      chipCreated = true;
      chip = document.createElement('button');
      chip.type = 'button';
      chip.id = 'aq-quota-chip';
      chip.setAttribute('aria-label', '查看模型配额，点击立即刷新');
      bindTooltipTrigger(chip, quotaTriggerOpts);
      chip.addEventListener('click', (ev) => handleQuotaChipClick(chip, ev));
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

  function hasExpiredQuotaBucket(nowMs = Date.now()) {
    const groups = state.quotaData?.groups;
    if (!Array.isArray(groups) || groups.length === 0) return false;
    for (let i = 0; i < groups.length; i++) {
      const buckets = groups[i]?.buckets;
      if (!Array.isArray(buckets)) continue;
      for (let j = 0; j < buckets.length; j++) {
        const ts = Date.parse(buckets[j]?.resetTime || '');
        if (Number.isFinite(ts) && ts <= nowMs) return true;
      }
    }
    return false;
  }

  function scheduleQuotaForceRefresh(delayMs = 1500) {
    if (state.quotaDebounceTimer) {
      clearTimeout(state.quotaDebounceTimer);
    }
    state.quotaDebounceTimer = setTimeout(() => {
      state.quotaDebounceTimer = null;
      if (!document.hidden) {
        void fetchQuota({ force: true });
      }
    }, Math.max(0, delayMs));
  }

  async function fetchQuota(arg = false) {
    const opts =
      typeof arg === 'boolean'
        ? { force: arg, immediate: arg, includeUserStatus: arg }
        : arg && typeof arg === 'object'
          ? arg
          : {};
    const force = Boolean(opts.force);
    const immediate = Boolean(opts.immediate);
    const includeUserStatus = Boolean(opts.includeUserStatus);

    if (state.quotaFetching) {
      state.quotaPendingRefresh = true;
      if (force) state.quotaPendingForce = true;
      return;
    }

    const now = Date.now();
    if (force && !immediate && state.quotaData) {
      const elapsedForce = now - state.quotaForceFetchedAt;
      if (elapsedForce < QUOTA_FORCE_COOLDOWN_MS) {
        scheduleQuotaForceRefresh(QUOTA_FORCE_COOLDOWN_MS - elapsedForce + 50);
        return;
      }
    } else if (!force && now - state.quotaFetchedAt < 10_000 && state.quotaData) {
      return;
    }

    state.quotaFetching = true;
    renderQuotaChipContent();
    refreshQuotaTooltipIfVisible();
    try {
      const csrf = window.__APP_CONFIG__?.csrfToken || '';
      const headers = {
        'Content-Type': 'application/json',
        ...(csrf ? { 'x-codeium-csrf-token': csrf } : {}),
      };
      const needUserStatus =
        !state.userProfile || includeUserStatus || now - state.userStatusFetchedAt >= 300_000;
      const quotaPromise = fetch('/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', {
        method: 'POST',
        headers,
        body: JSON.stringify(force ? { forceRefresh: true } : {}),
      });
      const userPromise = needUserStatus
        ? fetch('/exa.language_server_pb.LanguageServerService/GetUserStatus', {
            method: 'POST',
            headers,
            body: JSON.stringify({}),
          }).catch(() => null)
        : Promise.resolve(null);

      const [quotaRes, userRes] = await Promise.all([quotaPromise, userPromise]);
      if (userRes && userRes.ok) {
        const uJson = await userRes.json().catch(() => null);
        const us = uJson?.userStatus || uJson?.response?.userStatus || uJson;
        const email = String(us?.email || '').trim();
        if (email) {
          state.userStatusFetchedAt = Date.now();
          const planName = resolveUserPlanLabel(us);
          state.userProfile = {
            email,
            name: String(us?.name || '').trim(),
            planName,
          };
          const saveSig = `${email.toLowerCase()}|${planName}`;
          if (state.accountsMetaLoaded && state.accountsSupported && state.autoSavedSignature !== saveSig) {
            state.autoSavedSignature = saveSig;
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
        const doneAt = Date.now();
        state.quotaData = resp;
        state.quotaFetchedAt = doneAt;
        if (force) state.quotaForceFetchedAt = doneAt;
        state.quotaError = '';
        syncCurrentAccountQuotaSnapshot();
      }
    } catch (err) {
      state.quotaError = String(err?.message || '获取失败');
    } finally {
      state.quotaFetching = false;
      renderQuotaChipContent();
      refreshQuotaTooltipIfVisible();
      if (state.quotaPendingRefresh) {
        const nextForce = state.quotaPendingForce;
        state.quotaPendingRefresh = false;
        state.quotaPendingForce = false;
        if (!document.hidden) {
          if (nextForce) {
            scheduleQuotaForceRefresh(800);
          } else {
            void fetchQuota({ force: false });
          }
        }
      }
    }
  }

  const TRANSLATE_SKIP_SELECTOR =
    '[data-markdown-root], [data-testid="agent-response"], [data-testid="user-message"], [data-testid="user-message-content"], [data-lexical-editor], [data-aq-turn-usage], #aq-turn-tooltip, #aq-quota-tooltip, #aq-acct-quota-tooltip, #aq-context-chip, #aq-quota-chip, #aq-conv-groups, #aq-group-menu, #aq-conv-drag-ghost, code, pre, script, style, .codicon, .google-symbols, .agy-sidebar-row';

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

  const SVG_FOLDER =
    '<svg viewBox="0 -960 960 960" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M172.31-180Q142-180 121-201t-21-51.31V-707.69Q100-738 121-759t51.31-21H391.92l80 80H787.69Q818-700 839-679t21 51.31v375.38Q860-222 839-201t-51.31 21H172.31Zm0-60H787.69q5.39 0 8.85-3.46t3.46-8.85V-627.69q0-5.39-3.46-8.85T787.69-640H447.38l-80-80H172.31q-5.39 0-8.85 3.46T160-707.69v455.38q0 5.39 3.46 8.85t8.85 3.46Z"/></svg>';
  const SVG_FOLDER_PLUS =
    '<svg viewBox="0 -960 960 960" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M560-330h60v-80h80v-60h-80v-80h-60v80h-80v60h80v80ZM172.31-180Q142-180 121-201t-21-51.31V-707.69Q100-738 121-759t51.31-21H391.92l80 80H787.69Q818-700 839-679t21 51.31v375.38Q860-222 839-201t-51.31 21H172.31Zm0-60H787.69q5.39 0 8.85-3.46t3.46-8.85V-627.69q0-5.39-3.46-8.85T787.69-640H447.38l-80-80H172.31q-5.39 0-8.85 3.46T160-707.69v455.38q0 5.39 3.46 8.85t8.85 3.46Z"/></svg>';
  const SVG_PLUS =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>';
  const SVG_CHEVRON =
    '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5"/></svg>';
  const SVG_EDIT =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.4 2.6a1.4 1.4 0 0 1 2 2L5.5 12.5l-2.8.7.7-2.8 8-7.8Z"/></svg>';
  const SVG_CLOSE =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/></svg>';
  const SVG_SMART_ACTIVE =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none"/></svg>';

  function unpinConversationIfPinned(cascadeId) {
    const cidLower = String(cascadeId || '').trim().toLowerCase();
    if (!/^[0-9a-f-]{36}$/i.test(cidLower)) return false;
    const rows = document.querySelectorAll(
      '.bg-sidebar [data-testid="conversation-row-sidebar"][data-pinned="true"][data-cascade-id]'
    );
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.closest('[aria-hidden="true"]')) continue;
      if (String(row.getAttribute('data-cascade-id') || '').trim().toLowerCase() !== cidLower) continue;
      const pinBtn = row.querySelector('[data-testid="conversation-pin-button"]');
      if (pinBtn && typeof pinBtn.click === 'function') {
        pinBtn.click();
        return true;
      }
    }
    return false;
  }

  function sendGroupAction(payload) {
    if (typeof window.__aqGroupAction !== 'function') return false;
    try {
      const type = String(payload?.type || '');
      const itemCid = String(payload?.item?.cascadeId || '').trim().toLowerCase();
      if (
        itemCid &&
        /^[0-9a-f-]{36}$/i.test(itemCid) &&
        (type === 'add-item' || type === 'move-item' || type === 'create')
      ) {
        state.pendingUnpinCascadeIds.add(itemCid);
      }
      window.__aqGroupAction(JSON.stringify(payload || {}));
      return true;
    } catch {
      return false;
    }
  }

  const MAX_GROUP_DEPTH = 4;

  function buildGroupTreeIndex(groups) {
    const list = Array.isArray(groups) ? groups : [];
    const byId = new Map();
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      if (g && g.id) byId.set(g.id, g);
    }

    const childrenByParent = new Map();
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      if (!g || !g.id) continue;
      const rawParent = String(g.parentId || '').trim();
      const pid = rawParent && rawParent !== g.id && byId.has(rawParent) ? rawParent : '';
      let bucket = childrenByParent.get(pid);
      if (!bucket) {
        bucket = [];
        childrenByParent.set(pid, bucket);
      }
      bucket.push(g);
    }

    const depthById = new Map();
    const totalCountById = new Map();
    const orderedFlat = [];
    const visited = new Set();

    const walk = (parentId, depth) => {
      const kids = childrenByParent.get(parentId) || [];
      let sum = 0;
      for (let i = 0; i < kids.length; i++) {
        const g = kids[i];
        if (visited.has(g.id)) continue;
        visited.add(g.id);
        depthById.set(g.id, depth);
        const directCount = Array.isArray(g.items) ? g.items.length : 0;
        const entry = {
          group: g,
          depth,
          hasChildren: (childrenByParent.get(g.id) || []).length > 0,
          totalCount: directCount,
        };
        orderedFlat.push(entry);
        const subCount = walk(g.id, depth + 1);
        const total = directCount + subCount;
        entry.totalCount = total;
        totalCountById.set(g.id, total);
        sum += total;
      }
      return sum;
    };

    walk('', 0);
    return { byId, childrenByParent, depthById, totalCountById, orderedFlat };
  }

  function isGroupDescendant(groups, ancestorId, targetId) {
    if (!ancestorId || !targetId) return false;
    if (ancestorId === targetId) return true;
    const byId = new Map((groups || []).map((g) => [g.id, g]));
    const visited = new Set();
    let cur = byId.get(targetId);
    while (cur && cur.parentId && !visited.has(cur.id)) {
      visited.add(cur.id);
      if (cur.parentId === ancestorId) return true;
      cur = byId.get(cur.parentId);
    }
    return false;
  }

  function getGroupSubtreeHeight(childrenByParent, rootId) {
    const visited = new Set([rootId]);
    const dfs = (id) => {
      const kids = childrenByParent.get(id) || [];
      let maxH = 0;
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        if (visited.has(k.id)) continue;
        visited.add(k.id);
        maxH = Math.max(maxH, 1 + dfs(k.id));
      }
      return maxH;
    };
    return dfs(rootId);
  }

  function isConversationGrouped(cascadeId) {
    const cid = String(cascadeId || '').trim().toLowerCase();
    if (!cid) return false;
    for (let i = 0; i < state.groups.length; i++) {
      const items = state.groups[i]?.items || [];
      for (let j = 0; j < items.length; j++) {
        if (String(items[j]?.cascadeId || '').toLowerCase() === cid) return true;
      }
    }
    return false;
  }

  function findNearestProjectHeaderAbove(row) {
    try {
      const sidebar = row?.closest?.('.bg-sidebar');
      if (!sidebar) return '';
      const rowTop = row.getBoundingClientRect().top;
      const glyphs = sidebar.querySelectorAll('[data-project-glyph]');
      let bestText = '';
      let bestTop = -Infinity;
      for (let i = 0; i < glyphs.length; i++) {
        const g = glyphs[i];
        if (g.closest('[data-testid="conversation-row-sidebar"]')) continue;
        const rect = g.getBoundingClientRect();
        if (rect.height <= 0 || rect.top > rowTop + 2) continue;
        if (rect.top > bestTop) {
          const text = String(g.parentElement?.textContent || '').replace(/\s+/g, ' ').trim();
          if (text) {
            bestTop = rect.top;
            bestText = text;
          }
        }
      }
      return bestText;
    } catch {
      return '';
    }
  }

  function extractRowConversationInfo(row) {
    const cascadeId = String(row?.getAttribute?.('data-cascade-id') || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(cascadeId)) return null;
    const anchor = row.querySelector('a[aria-label]');
    const titleSpan = row.querySelector('span.truncate');
    const cached = state.trajMetaById[cascadeId.toLowerCase()] || null;
    const title = String(
      anchor?.getAttribute('aria-label') || titleSpan?.textContent || cached?.title || ''
    )
      .replace(/\s+/g, ' ')
      .trim();
    const project = String(
      row.getAttribute('data-subtext') || findNearestProjectHeaderAbove(row) || cached?.project || ''
    )
      .replace(/\s+/g, ' ')
      .trim();
    return {
      cascadeId,
      title: title || '未命名对话',
      project,
    };
  }

  function navigateToConversation(cascadeId) {
    const cid = String(cascadeId || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(cid)) return;
    if (extractCascadeId().toLowerCase() === cid.toLowerCase()) return;
    const rows = document.querySelectorAll('.bg-sidebar [data-testid="conversation-row-sidebar"][data-cascade-id]');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.closest('[aria-hidden="true"]')) continue;
      if (String(row.getAttribute('data-cascade-id') || '').trim().toLowerCase() !== cid.toLowerCase()) continue;
      const anchor = row.querySelector('a[href]');
      if (anchor && typeof anchor.click === 'function') {
        anchor.click();
        return;
      }
    }
    try {
      window.history.pushState({}, '', `/c/${encodeURIComponent(cid)}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch {
      window.location.pathname = `/c/${encodeURIComponent(cid)}`;
    }
  }

  function extractProjectBasenameFromWorkspace(ws) {
    const uri = String(ws?.workspaceFolderAbsoluteUri || ws?.gitRootAbsoluteUri || '').trim();
    if (uri) {
      const cleaned = uri.replace(/^file:\/\//i, '').replace(/[\\/]+$/, '');
      const seg = cleaned.split(/[\\/]/).pop() || '';
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    }
    const repo = String(ws?.repository?.computedName || '').trim();
    if (repo) return repo.split('/').pop() || repo;
    return '';
  }

  function syncGroupedConversationMetadata() {
    if (!state.groups.length) return;
    const needed = new Set();
    for (let i = 0; i < state.groups.length; i++) {
      const items = state.groups[i]?.items || [];
      for (let j = 0; j < items.length; j++) {
        const cid = String(items[j]?.cascadeId || '').toLowerCase();
        if (cid) needed.add(cid);
      }
    }
    if (!needed.size) return;

    const rows = document.querySelectorAll('[data-testid="conversation-row-sidebar"][data-cascade-id]');
    for (let i = 0; i < rows.length; i++) {
      const info = extractRowConversationInfo(rows[i]);
      if (info) {
        const key = info.cascadeId.toLowerCase();
        const prev = state.trajMetaById[key] || {};
        state.trajMetaById[key] = {
          ...prev,
          title: info.title || prev.title || '',
          project: info.project || prev.project || '',
        };
      }
    }

    const diff = {};
    let hasDiff = false;
    for (let i = 0; i < state.groups.length; i++) {
      const items = state.groups[i]?.items || [];
      for (let j = 0; j < items.length; j++) {
        const item = items[j];
        const cid = String(item?.cascadeId || '').toLowerCase();
        const fresh = state.trajMetaById[cid];
        if (!fresh) continue;
        const nextTitle = fresh.title && fresh.title !== '未命名对话' ? fresh.title : item.title;
        const nextProject = fresh.project || item.project || '';
        if (nextTitle !== item.title || nextProject !== (item.project || '')) {
          diff[item.cascadeId] = { title: nextTitle, project: nextProject };
          hasDiff = true;
        }
      }
    }
    if (!hasDiff) return;
    const syncKey = JSON.stringify(diff);
    if (syncKey === state.lastMetaSyncKey) return;
    state.lastMetaSyncKey = syncKey;
    sendGroupAction({ type: 'sync-meta', metadata: diff });
  }

  function saveSmartGroupCollapsed() {
    try {
      localStorage.setItem('aq_smart_groups_collapsed_v1', JSON.stringify({ active: state.smartActiveCollapsed }));
    } catch {}
  }

  function clampGroupsBodyHeight(rawHeight, panelEl = null) {
    const panel = panelEl || document.getElementById('aq-conv-groups');
    const panelTop = panel?.getBoundingClientRect?.().top ?? 150;
    const maxH = Math.max(120, Math.floor(window.innerHeight - panelTop - 160));
    const minH = 64;
    return Math.max(minH, Math.min(maxH, Math.round(rawHeight)));
  }

  function saveGroupsBodyHeight(heightPx) {
    state.groupsBodyHeight = heightPx > 0 ? Math.round(heightPx) : 0;
    try {
      if (state.groupsBodyHeight > 0) {
        localStorage.setItem('aq_groups_body_height_v1', String(state.groupsBodyHeight));
      } else {
        localStorage.removeItem('aq_groups_body_height_v1');
      }
    } catch {}
  }

  function cleanupGroupResizeDrag({ commit = false } = {}) {
    const drag = state.groupResizeDrag;
    if (!drag) return;
    state.groupResizeDrag = null;
    document.body.classList.remove('aq-resizing-groups');
    if (drag.resizerEl?.isConnected) {
      drag.resizerEl.classList.remove('is-resizing');
      const badge = drag.resizerEl.querySelector('[data-aq-grp-resizer-badge]');
      if (badge) badge.textContent = '';
    }
    const bodyEl = drag.bodyEl;
    if (!bodyEl?.isConnected) return;

    if (commit && drag.moved) {
      const capH = drag.currentHeight;
      saveGroupsBodyHeight(capH);
      bodyEl.style.transition = '';
      bodyEl.style.height = 'auto';
      bodyEl.style.maxHeight = `${capH}px`;
      const naturalH = Math.round(bodyEl.getBoundingClientRect().height);
      if (capH > naturalH + 1) {
        bodyEl.style.height = `${capH}px`;
        void bodyEl.offsetHeight;
        bodyEl.style.transition = 'height 180ms cubic-bezier(0.2, 0.8, 0.2, 1)';
        bodyEl.style.height = `${naturalH}px`;
        if (state.groupResizeSnapTimer) clearTimeout(state.groupResizeSnapTimer);
        state.groupResizeSnapTimer = setTimeout(() => {
          state.groupResizeSnapTimer = null;
          if (bodyEl.isConnected && !state.groupResizeDrag) {
            bodyEl.style.transition = '';
            bodyEl.style.height = 'auto';
          }
        }, 190);
      }
      return;
    }

    bodyEl.style.transition = '';
    bodyEl.style.height = 'auto';
    if (state.groupsBodyHeight > 0) {
      bodyEl.style.maxHeight = `${clampGroupsBodyHeight(state.groupsBodyHeight, drag.panel)}px`;
    } else {
      bodyEl.style.maxHeight = '';
    }
  }

  function collectAllConversationStates(activeCid) {
    const domStatus = Object.create(null);
    const domInfo = Object.create(null);
    const rank = { idle: 0, unread: 1, running: 2, waiting: 3 };
    const rows = document.querySelectorAll('.bg-sidebar [data-testid="conversation-row-sidebar"][data-cascade-id]');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.closest('[aria-hidden="true"]')) continue;
      const cid = String(row.getAttribute('data-cascade-id') || '').toLowerCase();
      if (!cid) continue;
      let status = 'idle';
      if (row.querySelector('[data-testid="attention-dot"]')) {
        status = 'waiting';
      } else if (
        row.querySelector('[data-testid="status-loading-spinner"], [data-testid="status-task-running"]')
      ) {
        status = 'running';
      } else if (row.querySelector('[data-testid="status-unread-dot"]')) {
        status = 'unread';
      }
      if (!domStatus[cid] || rank[status] > rank[domStatus[cid]]) {
        domStatus[cid] = status;
      }
      if (!domInfo[cid]) {
        const info = extractRowConversationInfo(row);
        if (info) domInfo[cid] = info;
      }
    }

    const statusById = Object.create(null);
    const allPrimaryCids = new Set();
    for (const cid of Object.keys(domStatus)) {
      allPrimaryCids.add(cid);
    }
    for (const [cid, meta] of Object.entries(state.trajMetaById)) {
      if (meta?.isPrimary && !meta?.archived) {
        allPrimaryCids.add(cid);
      }
    }
    for (let i = 0; i < state.groups.length; i++) {
      const items = state.groups[i]?.items || [];
      for (let j = 0; j < items.length; j++) {
        const cid = String(items[j]?.cascadeId || '').toLowerCase();
        if (cid) allPrimaryCids.add(cid);
      }
    }

    const activeItems = [];
    for (const cid of allPrimaryCids) {
      const meta = state.trajMetaById[cid] || null;
      if (meta?.archived && !(cid in domStatus)) continue;

      let status = '';
      if (cid in domStatus) {
        status = domStatus[cid] === 'idle' ? '' : domStatus[cid];
      } else if (meta) {
        if (!meta.killed && (meta.waiting || meta.subagentWaiting)) {
          status = 'waiting';
        } else if (!meta.killed && (meta.running || meta.subagentRunning)) {
          status = 'running';
        } else if (meta.markedAsUnread || (meta.lastModifiedMs > 0 && meta.lastModifiedMs > (meta.lastUserViewMs || 0))) {
          status = 'unread';
        }
      }

      if (status === 'unread' && activeCid && cid === activeCid && !meta?.markedAsUnread) {
        status = '';
      }
      if (!status) continue;
      statusById[cid] = status;

      // Only list primary / sidebar-visible conversations inside smart group
      if (!(cid in domStatus) && !(meta?.isPrimary && !meta?.archived)) continue;

      const dInfo = domInfo[cid];
      const title =
        (dInfo?.title && dInfo.title !== '未命名对话' ? dInfo.title : '') ||
        meta?.title ||
        dInfo?.title ||
        '未命名对话';
      const project = dInfo?.project || meta?.project || '';
      activeItems.push({
        cascadeId: dInfo?.cascadeId || meta?.cascadeId || cid,
        title,
        project,
        status,
        lastModifiedMs: meta?.lastModifiedMs || 0,
      });
    }

    const orderPriority = { waiting: 3, unread: 2, running: 1 };
    activeItems.sort((a, b) => {
      const pa = orderPriority[a.status] || 0;
      const pb = orderPriority[b.status] || 0;
      if (pa !== pb) return pb - pa;
      return (b.lastModifiedMs || 0) - (a.lastModifiedMs || 0);
    });

    return { statusById, activeItems };
  }

  async function refreshTrajectoryMetadata(force = false, minIntervalMs = 60_000) {
    if (!force && Date.now() - state.trajFetchedAt < minIntervalMs) return;
    state.trajFetchedAt = Date.now();
    try {
      const csrf = window.__APP_CONFIG__?.csrfToken || '';
      const headers = {
        'Content-Type': 'application/json',
        ...(csrf ? { 'x-codeium-csrf-token': csrf } : {}),
      };
      const res = await fetch('/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories', {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      if (!res.ok) return;
      const json = await res.json().catch(() => null);
      const map = json?.trajectorySummaries || {};
      const nextById = Object.create(null);
      for (const [cid, entry] of Object.entries(map)) {
        if (!/^[0-9a-f-]{36}$/i.test(cid) || !entry || typeof entry !== 'object') continue;
        const key = cid.toLowerCase();
        const title = String(entry.annotations?.title || entry.summary || '')
          .replace(/\s+/g, ' ')
          .trim();
        const wsList = Array.isArray(entry.workspaces) ? entry.workspaces : [];
        const project = wsList.length ? extractProjectBasenameFromWorkspace(wsList[0]) : '';
        const tMeta = entry.trajectoryMetadata || {};
        const tType = String(entry.trajectoryType || '');
        const parentId = String(
          tMeta.parentConversationId ||
            (tMeta.sourceMetadata?.hideFromConversationList && tMeta.sourceMetadata?.payload?.case === 'tool'
              ? tMeta.sourceMetadata.payload.value?.conversationId || ''
              : '')
        )
          .trim()
          .toLowerCase();
        const archived = Boolean(entry.annotations?.archived);
        const killed = Boolean(entry.killed);
        const isPrimary =
          !archived &&
          !parentId &&
          !tMeta.isBattleModeFork &&
          !tMeta.subagentSpec &&
          !tMeta.sourceMetadata?.hideFromConversationList &&
          tType !== 'CORTEX_TRAJECTORY_TYPE_SIDE_QUESTION' &&
          tType !== 'CORTEX_TRAJECTORY_TYPE_COMMIT_MESSAGE_GENERATION';
        const waiting = !killed && Array.isArray(entry.waitingSteps) && entry.waitingSteps.length > 0;
        const running =
          !killed &&
          (entry.status === 'CASCADE_RUN_STATUS_RUNNING' ||
            entry.status === 'CASCADE_RUN_STATUS_BUSY' ||
            Boolean(entry.notFullyIdle) ||
            Boolean(entry.hasRunningSubagents));
        const lastModifiedMs = Date.parse(entry.lastModifiedTime || '') || 0;
        let lastUserViewMs = Date.parse(entry.annotations?.lastUserViewTime || '') || 0;
        let markedAsUnread = Boolean(entry.annotations?.markedAsUnread);
        const localViewedAt = state.localViewedAtById[key] || 0;
        if (localViewedAt && Date.now() - localViewedAt < 60_000) {
          if (localViewedAt > lastUserViewMs) lastUserViewMs = localViewedAt;
          if (lastModifiedMs <= localViewedAt) markedAsUnread = false;
        }
        const prev = state.trajMetaById[key] || {};
        nextById[key] = {
          cascadeId: cid,
          title: title || prev.title || '',
          project: project || prev.project || '',
          archived,
          killed,
          isPrimary,
          parentId,
          waiting,
          running,
          subagentWaiting: false,
          subagentRunning: false,
          markedAsUnread,
          lastModifiedMs,
          lastUserViewMs,
        };
      }
      // Bubble subagent waiting/running state up to root parent conversation
      for (const item of Object.values(nextById)) {
        if (!item.parentId || item.killed || (!item.waiting && !item.running)) continue;
        let curParentId = item.parentId;
        const visited = new Set();
        while (curParentId && !visited.has(curParentId)) {
          visited.add(curParentId);
          const parent = nextById[curParentId];
          if (!parent) break;
          if (item.waiting) parent.subagentWaiting = true;
          if (item.running) parent.subagentRunning = true;
          curParentId = parent.parentId;
        }
      }
      state.trajMetaById = nextById;
      syncGroupedConversationMetadata();
      renderSidebarGroupsPanel();
    } catch {}
  }

  function clearGroupDeleteConfirm() {
    state.groupDeleteConfirmId = '';
    if (state.groupDeleteConfirmTimer) {
      clearTimeout(state.groupDeleteConfirmTimer);
      state.groupDeleteConfirmTimer = null;
    }
  }

  function closeGroupMenu() {
    state.groupMenuTarget = null;
    const menu = document.getElementById('aq-group-menu');
    if (menu) menu.classList.remove('is-visible');
  }

  function ensureGroupMenuEl() {
    let menu = document.getElementById('aq-group-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'aq-group-menu';
      document.body.appendChild(menu);
      menu.addEventListener('click', (ev) => {
        const opt = ev.target?.closest?.('[data-aq-gm-toggle]');
        if (opt) {
          ev.preventDefault();
          ev.stopPropagation();
          const groupId = opt.getAttribute('data-aq-gm-toggle') || '';
          const target = state.groupMenuTarget;
          if (!groupId || !target?.cascadeId) return;
          const isChecked = opt.classList.contains('is-checked');
          if (isChecked) {
            sendGroupAction({ type: 'remove-item', groupId, cascadeId: target.cascadeId });
          } else {
            sendGroupAction({ type: 'add-item', groupId, item: target });
          }
          return;
        }
        const createBtn = ev.target?.closest?.('[data-aq-gm-create-btn]');
        if (createBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          const input = menu.querySelector('input[data-aq-gm-input]');
          const name = String(input?.value || '').trim();
          const target = state.groupMenuTarget;
          if (!name || !target?.cascadeId) {
            input?.focus();
            return;
          }
          sendGroupAction({ type: 'create', name, item: target });
          if (input) input.value = '';
        }
      });
      menu.addEventListener('keydown', (ev) => {
        const input = ev.target?.closest?.('input[data-aq-gm-input]');
        if (!input) return;
        if (ev.key === 'Enter') {
          ev.preventDefault();
          ev.stopPropagation();
          const name = String(input.value || '').trim();
          const target = state.groupMenuTarget;
          if (!name || !target?.cascadeId) return;
          sendGroupAction({ type: 'create', name, item: target });
          input.value = '';
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          closeGroupMenu();
        }
      });
    }
    return menu;
  }

  function renderGroupMenuContent() {
    const menu = document.getElementById('aq-group-menu');
    const target = state.groupMenuTarget;
    if (!menu || !target || !menu.classList.contains('is-visible')) return;
    const prevInput = menu.querySelector('input[data-aq-gm-input]');
    const preservedValue = prevInput ? prevInput.value : '';
    const hadFocus = Boolean(prevInput && document.activeElement === prevInput);
    const cidLower = target.cascadeId.toLowerCase();

    const tree = buildGroupTreeIndex(state.groups);
    const listHtml = tree.orderedFlat.length
      ? tree.orderedFlat
          .map(({ group: g, depth }) => {
            const items = Array.isArray(g.items) ? g.items : [];
            const checked = items.some((it) => String(it?.cascadeId || '').toLowerCase() === cidLower);
            const indentPx = 6 + depth * 14;
            const branchHtml = depth > 0 ? '<span class="aq-gm-tree-branch">↳</span>' : '';
            return `
              <button type="button" class="aq-gm-opt ${checked ? 'is-checked' : ''}" data-aq-gm-toggle="${escapeHtml(g.id)}" style="padding-left:${indentPx}px">
                <span class="aq-gm-check">${checked ? '✓' : ''}</span>
                ${branchHtml}
                <span class="aq-gm-opt-name">${escapeHtml(g.name)}</span>
                <span class="aq-gm-opt-cnt">${items.length}</span>
              </button>
            `;
          })
          .join('')
      : '<div class="aq-grp-empty">暂无分组，在下方新建</div>';

    const errHtml = state.groupsError
      ? `<div class="aq-grp-error">${escapeHtml(state.groupsError)}</div>`
      : '';

    menu.innerHTML = `
      <div class="aq-gm-hdr" title="${escapeHtml(target.title)}">归组：${escapeHtml(target.title)}</div>
      <div class="aq-gm-list">${listHtml}</div>
      ${errHtml}
      <div class="aq-gm-create">
        <input type="text" class="aq-grp-input" data-aq-gm-input="1" maxlength="48" placeholder="新分组名，回车创建" value="${escapeHtml(preservedValue)}" />
        <button type="button" class="aq-grp-mini-btn is-primary" data-aq-gm-create-btn="1">新建</button>
      </div>
    `;
    if (hadFocus) {
      const nextInput = menu.querySelector('input[data-aq-gm-input]');
      if (nextInput) {
        nextInput.focus();
        nextInput.setSelectionRange(nextInput.value.length, nextInput.value.length);
      }
    }
  }

  function openGroupMenu(anchorEl, conversationInfo) {
    if (!anchorEl || !conversationInfo?.cascadeId) return;
    state.groupsError = '';
    state.groupMenuTarget = conversationInfo;
    const menu = ensureGroupMenuEl();
    menu.classList.add('is-visible');
    renderGroupMenuContent();

    const rect = anchorEl.getBoundingClientRect();
    const mRect = menu.getBoundingClientRect();
    const mw = mRect.width || 224;
    const mh = mRect.height || 180;
    let left = rect.right + 6;
    if (left + mw > window.innerWidth - 8) {
      left = Math.max(8, rect.left - mw - 6);
    }
    let top = rect.top - 4;
    if (top + mh > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - mh - 8);
    }
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    if (!state.groups.length) {
      menu.querySelector('input[data-aq-gm-input]')?.focus();
    }
  }

  function clearConvDragExpandTimer() {
    if (state.convDragExpandTimer) {
      clearTimeout(state.convDragExpandTimer);
      state.convDragExpandTimer = null;
    }
    if (state.convDragHoverGroupTimer) {
      clearTimeout(state.convDragHoverGroupTimer);
      state.convDragHoverGroupTimer = null;
    }
    state.convDragHoverGroupId = '';
  }

  function ensureConvDragGhostEl() {
    let el = document.getElementById('aq-conv-drag-ghost');
    if (!el) {
      el = document.createElement('div');
      el.id = 'aq-conv-drag-ghost';
      el.setAttribute('aria-hidden', 'true');
      document.body.appendChild(el);
    }
    return el;
  }

  function cleanupConversationPointerDrag() {
    clearConvDragExpandTimer();
    const d = state.convDrag;
    state.convDrag = null;
    if (d?.mode === 'group-item') {
      d.sourceEl?.classList?.remove('is-dragging');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
    document.body.classList.remove('aq-dragging-to-group');
    const panel = document.getElementById('aq-conv-groups');
    if (panel) {
      panel.classList.remove('aq-grp-panel-drop-target');
      panel.querySelectorAll('.aq-grp-drop-target').forEach((el) => el.classList.remove('aq-grp-drop-target'));
    }
    const ghost = document.getElementById('aq-conv-drag-ghost');
    if (ghost) ghost.classList.remove('is-visible');
  }

  function startConversationPointerDrag({ mode, sourceGroupId = '', sourceEl = null, item, startX, startY }) {
    if (!item?.cascadeId) return;
    cleanupConversationPointerDrag();
    state.convDrag = {
      mode,
      sourceGroupId,
      sourceEl,
      item,
      startX,
      startY,
      lastX: startX,
      lastY: startY,
      started: false,
      overPanel: false,
      overGroupId: '',
      overEmptyPanel: false,
    };
  }

  function updateConversationDragTarget(clientX, clientY) {
    const d = state.convDrag;
    if (!d || !d.started) return;
    d.lastX = clientX;
    d.lastY = clientY;
    const panel = document.getElementById('aq-conv-groups');
    if (!panel || !panel.isConnected) {
      d.overPanel = false;
      d.overGroupId = '';
      d.overEmptyPanel = false;
      document.body.classList.remove('aq-dragging-to-group');
      const ghost = document.getElementById('aq-conv-drag-ghost');
      if (ghost) ghost.classList.remove('is-visible');
      return;
    }

    const pRect = panel.getBoundingClientRect();
    const inPanel =
      pRect.width > 0 &&
      pRect.height > 0 &&
      clientX >= pRect.left - 8 &&
      clientX <= pRect.right + 8 &&
      clientY >= pRect.top - 4 &&
      clientY <= pRect.bottom + 4;

    if (d.mode === 'native-row') {
      document.body.classList.toggle('aq-dragging-to-group', inPanel);
    }

    if (inPanel && state.groupsCollapsedSection && state.groups.length > 0) {
      if (!state.convDragExpandTimer) {
        state.convDragExpandTimer = setTimeout(() => {
          state.convDragExpandTimer = null;
          if (state.convDrag?.started && state.groupsCollapsedSection) {
            sendGroupAction({ type: 'toggle-collapse', section: true });
          }
        }, 320);
      }
    } else if (state.convDragExpandTimer) {
      clearTimeout(state.convDragExpandTimer);
      state.convDragExpandTimer = null;
    }

    let hitGroupId = '';
    if (inPanel) {
      const hdrs = panel.querySelectorAll('[data-aq-grp-hdr]');
      for (let i = 0; i < hdrs.length; i++) {
        const h = hdrs[i];
        const hRect = h.getBoundingClientRect();
        if (hRect.height <= 0) continue;
        if (clientY >= hRect.top && clientY <= hRect.bottom) {
          hitGroupId = h.getAttribute('data-aq-grp-hdr') || '';
          break;
        }
      }
      if (!hitGroupId) {
        const blocks = panel.querySelectorAll('[data-aq-grp-block]');
        let bestDepth = -1;
        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i];
          const bRect = b.getBoundingClientRect();
          if (bRect.height <= 0) continue;
          if (clientY >= bRect.top && clientY <= bRect.bottom) {
            const depth = Number.parseInt(b.getAttribute('data-aq-grp-depth') || '0', 10) || 0;
            if (depth >= bestDepth) {
              bestDepth = depth;
              hitGroupId = b.getAttribute('data-aq-grp-block') || '';
            }
          }
        }
      }

      // Hovering over a collapsed folder auto-expands it so users can drop into nested subgroups
      const hitGrp = hitGroupId ? state.groups.find((g) => g.id === hitGroupId) : null;
      const hasSubgroups = hitGrp ? state.groups.some((g) => g.parentId === hitGrp.id) : false;
      if (hitGrp && hitGrp.collapsed && hasSubgroups) {
        if (state.convDragHoverGroupId !== hitGrp.id) {
          if (state.convDragHoverGroupTimer) clearTimeout(state.convDragHoverGroupTimer);
          state.convDragHoverGroupId = hitGrp.id;
          state.convDragHoverGroupTimer = setTimeout(() => {
            state.convDragHoverGroupTimer = null;
            const gid = state.convDragHoverGroupId;
            state.convDragHoverGroupId = '';
            if (state.convDrag?.started && gid) {
              const latest = state.groups.find((g) => g.id === gid);
              if (latest?.collapsed) {
                sendGroupAction({ type: 'toggle-collapse', groupId: gid });
              }
            }
          }, 420);
        }
      } else {
        if (state.convDragHoverGroupTimer) {
          clearTimeout(state.convDragHoverGroupTimer);
          state.convDragHoverGroupTimer = null;
        }
        state.convDragHoverGroupId = '';
      }

      if (d.mode === 'group-item' && hitGroupId && hitGroupId === d.sourceGroupId) {
        hitGroupId = '';
      }
    } else if (state.convDragHoverGroupTimer) {
      clearTimeout(state.convDragHoverGroupTimer);
      state.convDragHoverGroupTimer = null;
      state.convDragHoverGroupId = '';
    }

    panel.querySelectorAll('[data-aq-grp-block]').forEach((b) => {
      const gid = b.getAttribute('data-aq-grp-block') || '';
      b.classList.toggle('aq-grp-drop-target', Boolean(hitGroupId && gid === hitGroupId));
    });

    const overEmptyPanel = Boolean(inPanel && state.groups.length === 0 && !state.groupCreating);
    panel.classList.toggle('aq-grp-panel-drop-target', overEmptyPanel);

    d.overPanel = inPanel;
    d.overGroupId = hitGroupId;
    d.overEmptyPanel = overEmptyPanel;

    const showGhost = d.mode === 'group-item' || inPanel;
    const ghost = ensureConvDragGhostEl();
    if (!showGhost) {
      ghost.classList.remove('is-visible');
      return;
    }

    let badgeText = '';
    if (hitGroupId) {
      const targetGrp = state.groups.find((g) => g.id === hitGroupId);
      if (targetGrp?.name) {
        badgeText = `${d.mode === 'group-item' ? '移至' : '加入'} ${targetGrp.name}`;
      }
    } else if (overEmptyPanel) {
      badgeText = '新建分组';
    }

    const ghostSig = `${d.item.title}|${badgeText}`;
    if (ghost.dataset.sig !== ghostSig) {
      ghost.dataset.sig = ghostSig;
      ghost.innerHTML = `
        <span class="aq-cdg-ico">${SVG_FOLDER}</span>
        <span class="aq-cdg-title">${escapeHtml(d.item.title)}</span>
        ${badgeText ? `<span class="aq-cdg-badge">${escapeHtml(badgeText)}</span>` : ''}
      `;
    }
    const left = Math.min(window.innerWidth - 236, Math.max(8, Math.round(clientX + 12)));
    const top = Math.min(window.innerHeight - 38, Math.max(8, Math.round(clientY - 14)));
    ghost.style.left = `${left}px`;
    ghost.style.top = `${top}px`;
    ghost.classList.add('is-visible');
  }

  const SMART_EXIT_GRACE_MS = 1200;

  function renderConvStatusBadgeHtml(status) {
    if (status === 'waiting') {
      return '<span class="aq-grp-item-status" data-aq-grp-status="waiting" aria-label="等待确认" title="等待确认"><span class="aq-grp-status-waiting" aria-hidden="true"><span class="aq-grp-status-waiting-halo"></span><span class="aq-grp-status-waiting-core"></span></span></span>';
    }
    if (status === 'running') {
      return '<span class="aq-grp-item-status" data-aq-grp-status="running" aria-label="正在运行" title="正在运行"><span class="aq-grp-status-spinner" aria-hidden="true"><span></span><span></span><span></span><span></span></span></span>';
    }
    if (status === 'unread') {
      return '<span class="aq-grp-item-status" data-aq-grp-status="unread" aria-label="未读消息" title="未读"><span class="aq-grp-status-unread" aria-hidden="true"><span class="aq-grp-status-unread-halo"></span><span class="aq-grp-status-unread-core"></span></span></span>';
    }
    return '';
  }

  function stabilizeSmartActiveItems(rawItems, activeCid) {
    const now = Date.now();
    const freshByCid = new Map();
    for (let i = 0; i < rawItems.length; i++) {
      const it = rawItems[i];
      const key = String(it.cascadeId || '').toLowerCase();
      if (!key) continue;
      freshByCid.set(key, it);
      state.smartStableMap.set(key, { item: it, missingSince: 0 });
    }

    let nextWakeInMs = 0;
    for (const [key, entry] of state.smartStableMap.entries()) {
      if (freshByCid.has(key)) continue;
      // If user explicitly opened an unread item, let it leave immediately without grace wait
      if (entry.item?.status === 'unread' && activeCid && key === activeCid) {
        state.smartStableMap.delete(key);
        continue;
      }
      if (!entry.missingSince) {
        entry.missingSince = now;
      }
      const elapsed = now - entry.missingSince;
      if (elapsed >= SMART_EXIT_GRACE_MS) {
        state.smartStableMap.delete(key);
      } else {
        const remain = SMART_EXIT_GRACE_MS - elapsed + 40;
        if (!nextWakeInMs || remain < nextWakeInMs) {
          nextWakeInMs = remain;
        }
      }
    }

    if (nextWakeInMs > 0) {
      if (!state.smartGraceTimer) {
        state.smartGraceTimer = setTimeout(() => {
          state.smartGraceTimer = null;
          renderSidebarGroupsPanel();
        }, nextWakeInMs);
      }
    } else if (state.smartGraceTimer) {
      clearTimeout(state.smartGraceTimer);
      state.smartGraceTimer = null;
    }

    const orderPriority = { waiting: 3, unread: 2, running: 1 };
    const result = [...state.smartStableMap.values()].map((e) => e.item);
    result.sort((a, b) => {
      const pa = orderPriority[a.status] || 0;
      const pb = orderPriority[b.status] || 0;
      if (pa !== pb) return pb - pa;
      return (b.lastModifiedMs || 0) - (a.lastModifiedMs || 0);
    });
    return result;
  }

  function patchItemStatusBadgeInPlace(itemEl, nextStatus) {
    const normStatus = nextStatus || '';
    const prevStatus = itemEl.dataset.aqStatus || '';
    if (prevStatus === normStatus) return;
    itemEl.dataset.aqStatus = normStatus;
    const existing = itemEl.querySelector(':scope > .aq-grp-item-status');
    if (!normStatus) {
      if (existing) existing.remove();
      return;
    }
    const actionsEl = itemEl.querySelector(':scope > .aq-grp-item-actions');
    const html = renderConvStatusBadgeHtml(normStatus);
    if (existing) {
      existing.outerHTML = html;
    } else if (actionsEl) {
      actionsEl.insertAdjacentHTML('beforebegin', html);
    } else {
      itemEl.insertAdjacentHTML('beforeend', html);
    }
  }

  function createSmartSlotEl(it, activeCid, animateEnter) {
    const cid = String(it.cascadeId || '');
    const cidLower = cid.toLowerCase();
    const isActive = Boolean(activeCid && cidLower === activeCid);
    const subHtml = it.project
      ? `<span class="aq-grp-item-sub">${SVG_FOLDER}<span>${escapeHtml(it.project)}</span></span>`
      : '';
    const slot = document.createElement('div');
    slot.className = animateEnter ? 'aq-smart-slot is-entering' : 'aq-smart-slot';
    slot.setAttribute('data-aq-smart-cid', cidLower);
    slot.innerHTML = `
      <div class="aq-smart-slot-inner">
        <div class="aq-grp-item ${isActive ? 'is-active' : ''}" data-aq-grp-open="${escapeHtml(cid)}" data-aq-smart-item="active" data-aq-status="${escapeHtml(it.status || '')}" title="${escapeHtml(it.title)}">
          <div class="aq-grp-item-main">
            <span class="aq-grp-item-title">${escapeHtml(it.title)}</span>
            ${subHtml}
          </div>
          ${renderConvStatusBadgeHtml(it.status)}
          <span class="aq-grp-item-actions">
            <button type="button" class="aq-grp-icon-btn" data-aq-grp-item-menu="${escapeHtml(cid)}" title="管理所属分组">${SVG_FOLDER_PLUS}</button>
          </span>
        </div>
      </div>
    `;
    return slot;
  }

  function updateSmartSlotElInPlace(slot, it, activeCid) {
    if (slot._leaveTimer) {
      clearTimeout(slot._leaveTimer);
      slot._leaveTimer = null;
    }
    if (slot.classList.contains('is-leaving')) {
      slot.classList.remove('is-leaving');
    }
    const itemEl = slot.querySelector('.aq-grp-item');
    if (!itemEl) return;
    const cidLower = String(it.cascadeId || '').toLowerCase();
    itemEl.classList.toggle('is-active', Boolean(activeCid && cidLower === activeCid));
    if (itemEl.getAttribute('title') !== it.title) {
      itemEl.setAttribute('title', it.title);
    }
    const titleEl = itemEl.querySelector('.aq-grp-item-title');
    if (titleEl && titleEl.textContent !== it.title) {
      titleEl.textContent = it.title;
    }
    const mainEl = itemEl.querySelector('.aq-grp-item-main');
    const subEl = mainEl?.querySelector('.aq-grp-item-sub');
    if (it.project) {
      if (subEl) {
        const subText = subEl.querySelector('span');
        if (subText && subText.textContent !== it.project) {
          subText.textContent = it.project;
        }
      } else if (mainEl) {
        mainEl.insertAdjacentHTML(
          'beforeend',
          `<span class="aq-grp-item-sub">${SVG_FOLDER}<span>${escapeHtml(it.project)}</span></span>`
        );
      }
    } else if (subEl) {
      subEl.remove();
    }
    patchItemStatusBadgeInPlace(itemEl, it.status);
  }

  function patchSidebarGroupsDynamicState(panel, activeCid, convStatuses, stableActiveItems) {
    // 1. Update smart group header, collapse state, count, empty placeholder, and keyed list
    const chevEl = panel.querySelector('[data-aq-smart-chev]');
    const countEl = panel.querySelector('[data-aq-smart-count]');
    const childrenEl = panel.querySelector('[data-aq-smart-children]');
    const listEl = panel.querySelector('[data-aq-smart-list]');
    const emptyEl = panel.querySelector('[data-aq-smart-empty]');

    const smartExpanded = !state.smartActiveCollapsed;
    const count = stableActiveItems.length;
    if (chevEl) chevEl.classList.toggle('is-open', smartExpanded);
    if (countEl) {
      const countText = String(count);
      if (countEl.textContent !== countText) countEl.textContent = countText;
      countEl.classList.toggle('is-highlight', count > 0);
    }
    if (childrenEl) childrenEl.classList.toggle('is-collapsed', !smartExpanded);
    if (emptyEl) emptyEl.classList.toggle('is-hidden', count > 0);

    if (listEl) {
      const animateNew = listEl.dataset.aqHydrated === '1';
      const existingByCid = new Map();
      const currentSlots = [...listEl.querySelectorAll(':scope > .aq-smart-slot[data-aq-smart-cid]')];
      for (let i = 0; i < currentSlots.length; i++) {
        const s = currentSlots[i];
        const k = s.getAttribute('data-aq-smart-cid') || '';
        if (k) existingByCid.set(k, s);
      }

      const desiredKeys = new Set();
      const enteringSlots = [];
      let cursor = null;

      for (let i = 0; i < stableActiveItems.length; i++) {
        const it = stableActiveItems[i];
        const key = String(it.cascadeId || '').toLowerCase();
        if (!key) continue;
        desiredKeys.add(key);

        let slot = existingByCid.get(key);
        if (slot) {
          updateSmartSlotElInPlace(slot, it, activeCid);
        } else {
          slot = createSmartSlotEl(it, activeCid, animateNew);
          if (animateNew) enteringSlots.push(slot);
        }

        const expectedNext = cursor ? cursor.nextElementSibling : listEl.firstElementChild;
        if (slot !== expectedNext) {
          listEl.insertBefore(slot, expectedNext || null);
        }
        cursor = slot;
      }

      // Smoothly collapse and remove items no longer in active list
      for (const [key, slot] of existingByCid.entries()) {
        if (desiredKeys.has(key)) continue;
        if (!animateNew) {
          if (slot._leaveTimer) {
            clearTimeout(slot._leaveTimer);
            slot._leaveTimer = null;
          }
          slot.remove();
          continue;
        }
        if (!slot.classList.contains('is-leaving')) {
          slot.classList.remove('is-entering');
          slot.classList.add('is-leaving');
          slot._leaveTimer = setTimeout(() => {
            slot._leaveTimer = null;
            if (slot.isConnected && slot.classList.contains('is-leaving')) {
              slot.remove();
            }
          }, 230);
        }
      }

      if (enteringSlots.length > 0) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            for (let i = 0; i < enteringSlots.length; i++) {
              const s = enteringSlots[i];
              if (s.isConnected && !s.classList.contains('is-leaving')) {
                s.classList.remove('is-entering');
              }
            }
          });
        });
      }
      listEl.dataset.aqHydrated = '1';
    }

    // 2. Patch custom folder items' active state and status badges in-place (zero rebuild!)
    const customItems = panel.querySelectorAll('.aq-grp-item[data-aq-grp-gid]');
    for (let i = 0; i < customItems.length; i++) {
      const itemEl = customItems[i];
      const cidLower = String(itemEl.getAttribute('data-aq-grp-open') || '').toLowerCase();
      itemEl.classList.toggle('is-active', Boolean(activeCid && cidLower === activeCid));
      patchItemStatusBadgeInPlace(itemEl, convStatuses[cidLower] || '');
    }

    // 3. Keep max-height ceiling synced without disturbing active drag or spring-back animation
    if (!state.groupResizeDrag && !state.groupResizeSnapTimer) {
      const bodyEl = panel.querySelector('.aq-grp-body');
      if (bodyEl) {
        const expectedMaxH =
          state.groupsBodyHeight > 0 ? `${clampGroupsBodyHeight(state.groupsBodyHeight, panel)}px` : '';
        if (bodyEl.style.maxHeight !== expectedMaxH) {
          bodyEl.style.maxHeight = expectedMaxH;
        }
        if (bodyEl.style.height && bodyEl.style.height !== 'auto') {
          bodyEl.style.height = 'auto';
        }
      }
    }
  }

  function renderSidebarGroupsPanel(force = false) {
    const panel = document.getElementById('aq-conv-groups');
    if (!panel || !panel.isConnected) return;

    const editingActive = Boolean(state.groupCreating || state.groupRenamingId);
    if (!force && editingActive && panel.querySelector('input.aq-grp-input')) {
      return;
    }

    const activeCid = extractCascadeId().toLowerCase();
    const { statusById: convStatuses, activeItems } = collectAllConversationStates(activeCid);
    const stableActiveItems = stabilizeSmartActiveItems(activeItems, activeCid);

    // Only structural changes rebuild panel.innerHTML; status/active/smart-list updates patch in-place!
    const structureKey = JSON.stringify({
      c: state.groupsCollapsedSection,
      g: state.groups,
      err: state.groupsError,
      cr: state.groupCreating,
      cp: state.groupCreateParentId,
      ci: Boolean(state.groupCreateInitialItem),
      rn: state.groupRenamingId,
      dc: state.groupDeleteConfirmId,
    });

    const needRebuild = force || structureKey !== state.groupRenderKey || !panel.querySelector('[data-aq-grp-sec-hdr]');
    if (!needRebuild) {
      patchSidebarGroupsDynamicState(panel, activeCid, convStatuses, stableActiveItems);
      return;
    }

    const prevScrollTop = panel.querySelector('.aq-grp-body')?.scrollTop || 0;
    state.groupRenderKey = structureKey;

    const smartExpanded = !state.smartActiveCollapsed;
    const smartGroupsHtml = `
      <div class="aq-grp-block" data-aq-smart-block="active">
        <div class="aq-grp-hdr is-smart" data-aq-smart-hdr="active" title="未确认 / 运行中">
          <span class="aq-grp-chev ${smartExpanded ? 'is-open' : ''}" data-aq-smart-chev="1">${SVG_CHEVRON}</span>
          <span class="aq-grp-folder-ico">${SVG_SMART_ACTIVE}</span>
          <span class="aq-grp-name">未确认 / 运行中</span>
          <span class="aq-grp-count" data-aq-smart-count="1">0</span>
        </div>
        <div class="aq-smart-children ${smartExpanded ? '' : 'is-collapsed'}" data-aq-smart-children="1">
          <div class="aq-smart-children-inner">
            <div class="aq-grp-children">
              <div class="aq-smart-list" data-aq-smart-list="1"></div>
              <div class="aq-smart-empty-wrap" data-aq-smart-empty="1">
                <div class="aq-smart-empty-inner">
                  <div class="aq-grp-item-empty">暂无未确认或运行中的对话</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const tree = buildGroupTreeIndex(state.groups);
    const totalGroups = state.groups.length;
    const creatingTop = Boolean(
      state.groupCreating && (!state.groupCreateParentId || !tree.byId.has(state.groupCreateParentId))
    );
    const buildCreateFormHtml = (placeholder) => `
      <div class="aq-grp-inline-form" data-aq-grp-create-form="1">
        <input type="text" class="aq-grp-input" data-aq-grp-create-input="1" maxlength="48" placeholder="${escapeHtml(placeholder)}" />
        <button type="button" class="aq-grp-mini-btn is-primary" data-aq-grp-create-ok="1">确定</button>
        <button type="button" class="aq-grp-mini-btn" data-aq-grp-create-cancel="1">取消</button>
      </div>
    `;
    const topCreateFormHtml = creatingTop
      ? buildCreateFormHtml(state.groupCreateInitialItem ? '输入新分组名并归入该对话' : '输入分组名称')
      : '';

    const renderGroupBlock = (g, depth) => {
      const items = Array.isArray(g.items) ? g.items : [];
      const childGroups = tree.childrenByParent.get(g.id) || [];
      const totalCount = tree.totalCountById.get(g.id) ?? items.length;
      const isRenaming = state.groupRenamingId === g.id;
      const isDeleteConfirm = state.groupDeleteConfirmId === g.id;
      const isCreatingChildHere = Boolean(state.groupCreating && state.groupCreateParentId === g.id);
      const canCreateChild = depth < MAX_GROUP_DEPTH - 1;
      const isExpanded = !g.collapsed || isCreatingChildHere;

      const newChildBtnHtml = canCreateChild
        ? `<button type="button" class="aq-grp-icon-btn" data-aq-grp-new-child="${escapeHtml(g.id)}" title="新建子分组">${SVG_FOLDER_PLUS}</button>`
        : '';
      const delTitle = isDeleteConfirm
        ? '再次点击确认删除分组'
        : childGroups.length
          ? '删除分组及全部子分组'
          : '删除分组';

      const hdrHtml = isRenaming
        ? `
          <div class="aq-grp-inline-form" data-aq-grp-rename-form="${escapeHtml(g.id)}">
            <input type="text" class="aq-grp-input" data-aq-grp-rename-input="${escapeHtml(g.id)}" maxlength="48" value="${escapeHtml(g.name)}" />
            <button type="button" class="aq-grp-mini-btn is-primary" data-aq-grp-rename-ok="${escapeHtml(g.id)}">保存</button>
            <button type="button" class="aq-grp-mini-btn" data-aq-grp-rename-cancel="1">取消</button>
          </div>
        `
        : `
          <div class="aq-grp-hdr ${isDeleteConfirm ? 'has-confirm' : ''}" draggable="true" data-aq-grp-hdr="${escapeHtml(g.id)}" title="${escapeHtml(g.name)}">
            <span class="aq-grp-chev ${isExpanded ? 'is-open' : ''}">${SVG_CHEVRON}</span>
            <span class="aq-grp-folder-ico">${SVG_FOLDER}</span>
            <span class="aq-grp-name">${escapeHtml(g.name)}</span>
            <span class="aq-grp-count">${totalCount}</span>
            <span class="aq-grp-actions">
              ${newChildBtnHtml}
              <button type="button" class="aq-grp-icon-btn" data-aq-grp-rename="${escapeHtml(g.id)}" title="重命名分组">${SVG_EDIT}</button>
              <button type="button" class="aq-grp-icon-btn ${isDeleteConfirm ? 'aq-grp-danger-confirm' : ''}" data-aq-grp-del="${escapeHtml(g.id)}" title="${delTitle}">${isDeleteConfirm ? '删?' : SVG_CLOSE}</button>
            </span>
          </div>
        `;

      let childrenHtml = '';
      if (isExpanded) {
        const childCreateHtml = isCreatingChildHere ? buildCreateFormHtml('输入子分组名称') : '';
        const subGroupsHtml = childGroups.map((cg) => renderGroupBlock(cg, depth + 1)).join('');
        const itemsListHtml = items
          .map((it) => {
            const cidLower = String(it.cascadeId || '').toLowerCase();
            const isActive = activeCid && cidLower === activeCid;
            const status = convStatuses[cidLower] || '';
            const statusHtml = renderConvStatusBadgeHtml(status);
            const subHtml = it.project
              ? `<span class="aq-grp-item-sub">${SVG_FOLDER}<span>${escapeHtml(it.project)}</span></span>`
              : '';
            return `
              <div class="aq-grp-item ${isActive ? 'is-active' : ''}" data-aq-grp-open="${escapeHtml(it.cascadeId)}" data-aq-grp-gid="${escapeHtml(g.id)}" data-aq-status="${escapeHtml(status)}" title="${escapeHtml(it.title)}">
                <div class="aq-grp-item-main">
                  <span class="aq-grp-item-title">${escapeHtml(it.title)}</span>
                  ${subHtml}
                </div>
                ${statusHtml}
                <span class="aq-grp-item-actions">
                  <button type="button" class="aq-grp-icon-btn" data-aq-grp-item-menu="${escapeHtml(it.cascadeId)}" data-aq-grp-gid="${escapeHtml(g.id)}" title="管理所属分组">${SVG_FOLDER_PLUS}</button>
                  <button type="button" class="aq-grp-icon-btn" data-aq-grp-item-rm="${escapeHtml(it.cascadeId)}" data-aq-grp-gid="${escapeHtml(g.id)}" title="移出此分组">${SVG_CLOSE}</button>
                </span>
              </div>
            `;
          })
          .join('');
        const emptyHtml =
          !isCreatingChildHere && childGroups.length === 0 && items.length === 0
            ? `<div class="aq-grp-item-empty">${
                canCreateChild ? '暂无对话 · 拖入对话或点右侧新建子分组' : '暂无对话 · 直接拖入对话'
              }</div>`
            : '';
        childrenHtml = `<div class="aq-grp-children">${childCreateHtml}${subGroupsHtml}${itemsListHtml}${emptyHtml}</div>`;
      }

      return `<div class="aq-grp-block" data-aq-grp-block="${escapeHtml(g.id)}" data-aq-grp-depth="${depth}">${hdrHtml}${childrenHtml}</div>`;
    };

    const topGroups = tree.childrenByParent.get('') || [];
    const groupsHtml = topGroups.map((g) => renderGroupBlock(g, 0)).join('');

    const showBody = !state.groupsCollapsedSection || state.groupCreating;
    const errHtml = state.groupsError
      ? `<div class="aq-grp-error">${escapeHtml(state.groupsError)}</div>`
      : '';
    const bodyHeightStyle =
      state.groupsBodyHeight > 0
        ? ` style="max-height:${clampGroupsBodyHeight(state.groupsBodyHeight, panel)}px"`
        : '';
    const resizerHtml = showBody
      ? '<div class="aq-grp-resizer" data-aq-grp-resizer="1" title="上下拖动设置分组最大高度，双击恢复默认"><span class="aq-grp-resizer-badge" data-aq-grp-resizer-badge="1"></span></div>'
      : '';
    const bodyHtml = showBody
      ? `
        ${errHtml}
        ${topCreateFormHtml}
        <div class="aq-grp-body"${bodyHeightStyle}>
          ${smartGroupsHtml}
          ${totalGroups ? `<div class="aq-grp-smart-sep"></div>${groupsHtml}` : ''}
        </div>
        ${
          !totalGroups && !state.groupCreating
            ? '<div class="aq-grp-empty">点击右侧 + 新建，或直接拖入下方对话</div>'
            : ''
        }
      `
      : '';

    panel.innerHTML = `
      <div class="aq-grp-sec-hdr" data-aq-grp-sec-hdr="1">
        <button type="button" class="aq-grp-sec-toggle" data-aq-grp-sec-toggle="1" title="${state.groupsCollapsedSection ? '展开分组' : '折叠分组'}">
          <span class="aq-grp-chev ${state.groupsCollapsedSection ? '' : 'is-open'}">${SVG_CHEVRON}</span>
          <span>分组${totalGroups ? ` (${totalGroups})` : ''}</span>
        </button>
        <button type="button" class="aq-grp-icon-btn" data-aq-grp-new="1" title="新建分组">${SVG_PLUS}</button>
      </div>
      ${bodyHtml}
      ${resizerHtml}
    `;

    patchSidebarGroupsDynamicState(panel, activeCid, convStatuses, stableActiveItems);

    if (prevScrollTop > 0) {
      const nextBody = panel.querySelector('.aq-grp-body');
      if (nextBody) nextBody.scrollTop = prevScrollTop;
    }

    if (state.groupCreating) {
      const inp = panel.querySelector('input[data-aq-grp-create-input]');
      if (inp) inp.focus();
    } else if (state.groupRenamingId) {
      const inp = panel.querySelector('input[data-aq-grp-rename-input]');
      if (inp) {
        inp.focus();
        inp.select();
      }
    }
  }

  function bindSidebarGroupsEvents(panel) {
    if (panel.dataset.aqBound === '1') return;
    panel.dataset.aqBound = '1';

    panel.addEventListener('dblclick', (ev) => {
      const resizer = ev.target?.closest?.('[data-aq-grp-resizer]');
      if (!resizer) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (state.groupResizeSnapTimer) {
        clearTimeout(state.groupResizeSnapTimer);
        state.groupResizeSnapTimer = null;
      }
      cleanupGroupResizeDrag();
      saveGroupsBodyHeight(0);
      renderSidebarGroupsPanel(false);
    });

    panel.addEventListener('click', (ev) => {
      if (Date.now() < state.suppressGroupClickUntil) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      const target = ev.target;
      const secToggle = target?.closest?.('[data-aq-grp-sec-toggle]');
      if (secToggle) {
        ev.preventDefault();
        ev.stopPropagation();
        state.groupsError = '';
        sendGroupAction({ type: 'toggle-collapse', section: true });
        return;
      }

      const newBtn = target?.closest?.('[data-aq-grp-new]');
      if (newBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        state.groupsError = '';
        state.groupRenamingId = '';
        clearGroupDeleteConfirm();
        state.groupCreateInitialItem = null;
        if (state.groupCreating && !state.groupCreateParentId) {
          state.groupCreating = false;
        } else {
          state.groupCreateParentId = '';
          state.groupCreating = true;
        }
        renderSidebarGroupsPanel(true);
        return;
      }

      const newChildBtn = target?.closest?.('[data-aq-grp-new-child]');
      if (newChildBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        const parentId = newChildBtn.getAttribute('data-aq-grp-new-child') || '';
        state.groupsError = '';
        state.groupRenamingId = '';
        clearGroupDeleteConfirm();
        state.groupCreateInitialItem = null;
        if (state.groupCreating && state.groupCreateParentId === parentId) {
          state.groupCreating = false;
          state.groupCreateParentId = '';
        } else {
          state.groupCreateParentId = parentId;
          state.groupCreating = true;
        }
        renderSidebarGroupsPanel(true);
        return;
      }

      const createOk = target?.closest?.('[data-aq-grp-create-ok]');
      if (createOk) {
        ev.preventDefault();
        ev.stopPropagation();
        const inp = panel.querySelector('input[data-aq-grp-create-input]');
        const name = String(inp?.value || '').trim();
        if (!name) {
          state.groupsError = '请输入分组名称';
          renderSidebarGroupsPanel(true);
          return;
        }
        const pendingItem = state.groupCreateInitialItem;
        const parentId = state.groupCreateParentId || '';
        state.groupsError = '';
        state.groupCreating = false;
        state.groupCreateParentId = '';
        state.groupCreateInitialItem = null;
        sendGroupAction({
          type: 'create',
          name,
          ...(parentId ? { parentId } : {}),
          ...(pendingItem ? { item: pendingItem } : {}),
        });
        return;
      }

      const createCancel = target?.closest?.('[data-aq-grp-create-cancel]');
      if (createCancel) {
        ev.preventDefault();
        ev.stopPropagation();
        state.groupsError = '';
        state.groupCreating = false;
        state.groupCreateParentId = '';
        state.groupCreateInitialItem = null;
        renderSidebarGroupsPanel(true);
        return;
      }

      const renameOk = target?.closest?.('[data-aq-grp-rename-ok]');
      if (renameOk) {
        ev.preventDefault();
        ev.stopPropagation();
        const groupId = renameOk.getAttribute('data-aq-grp-rename-ok') || '';
        const inp = panel.querySelector(`input[data-aq-grp-rename-input="${groupId}"]`);
        const name = String(inp?.value || '').trim();
        if (!name) {
          state.groupsError = '请输入分组名称';
          renderSidebarGroupsPanel(true);
          return;
        }
        state.groupsError = '';
        state.groupRenamingId = '';
        sendGroupAction({ type: 'rename', groupId, name });
        return;
      }

      const renameCancel = target?.closest?.('[data-aq-grp-rename-cancel]');
      if (renameCancel) {
        ev.preventDefault();
        ev.stopPropagation();
        state.groupsError = '';
        state.groupRenamingId = '';
        renderSidebarGroupsPanel(true);
        return;
      }

      const renameBtn = target?.closest?.('[data-aq-grp-rename]');
      if (renameBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        state.groupsError = '';
        state.groupCreating = false;
        state.groupCreateParentId = '';
        state.groupCreateInitialItem = null;
        clearGroupDeleteConfirm();
        state.groupRenamingId = renameBtn.getAttribute('data-aq-grp-rename') || '';
        renderSidebarGroupsPanel(true);
        return;
      }

      const delBtn = target?.closest?.('[data-aq-grp-del]');
      if (delBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        const groupId = delBtn.getAttribute('data-aq-grp-del') || '';
        if (!groupId) return;
        if (state.groupDeleteConfirmId !== groupId) {
          clearGroupDeleteConfirm();
          state.groupDeleteConfirmId = groupId;
          state.groupDeleteConfirmTimer = setTimeout(() => {
            clearGroupDeleteConfirm();
            renderSidebarGroupsPanel(true);
          }, 3000);
          renderSidebarGroupsPanel(true);
          return;
        }
        clearGroupDeleteConfirm();
        state.groupsError = '';
        sendGroupAction({ type: 'delete', groupId });
        return;
      }

      const smartHdr = target?.closest?.('[data-aq-smart-hdr]');
      if (smartHdr) {
        ev.preventDefault();
        ev.stopPropagation();
        state.smartActiveCollapsed = !state.smartActiveCollapsed;
        saveSmartGroupCollapsed();
        renderSidebarGroupsPanel(false);
        return;
      }

      const hdr = target?.closest?.('[data-aq-grp-hdr]');
      if (hdr) {
        ev.preventDefault();
        ev.stopPropagation();
        const groupId = hdr.getAttribute('data-aq-grp-hdr') || '';
        if (groupId) {
          state.groupsError = '';
          sendGroupAction({ type: 'toggle-collapse', groupId });
        }
        return;
      }

      const itemMenuBtn = target?.closest?.('[data-aq-grp-item-menu]');
      if (itemMenuBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        const cid = itemMenuBtn.getAttribute('data-aq-grp-item-menu') || '';
        const gid = itemMenuBtn.getAttribute('data-aq-grp-gid') || '';
        let item = null;
        if (gid) {
          const grp = state.groups.find((g) => g.id === gid);
          item = grp?.items?.find((it) => String(it.cascadeId || '') === cid) || null;
        }
        if (!item && cid) {
          const meta = state.trajMetaById[cid.toLowerCase()];
          const rowEl = itemMenuBtn.closest('.aq-grp-item');
          const title =
            meta?.title ||
            rowEl?.querySelector('.aq-grp-item-title')?.textContent?.trim() ||
            '未命名对话';
          const project =
            meta?.project ||
            rowEl?.querySelector('.aq-grp-item-sub > span')?.textContent?.trim() ||
            '';
          item = { cascadeId: cid, title, project };
        }
        if (item) {
          openGroupMenu(itemMenuBtn, item);
        }
        return;
      }

      const itemRmBtn = target?.closest?.('[data-aq-grp-item-rm]');
      if (itemRmBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        const cid = itemRmBtn.getAttribute('data-aq-grp-item-rm') || '';
        const gid = itemRmBtn.getAttribute('data-aq-grp-gid') || '';
        if (cid && gid) {
          sendGroupAction({ type: 'remove-item', groupId: gid, cascadeId: cid });
        }
        return;
      }

      const openRow = target?.closest?.('[data-aq-grp-open]');
      if (openRow) {
        ev.preventDefault();
        ev.stopPropagation();
        const cid = openRow.getAttribute('data-aq-grp-open') || '';
        navigateToConversation(cid);
      }
    });

    panel.addEventListener('keydown', (ev) => {
      const createInp = ev.target?.closest?.('input[data-aq-grp-create-input]');
      if (createInp) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          ev.stopPropagation();
          const name = String(createInp.value || '').trim();
          if (!name) {
            state.groupsError = '请输入分组名称';
            renderSidebarGroupsPanel(true);
            return;
          }
          const pendingItem = state.groupCreateInitialItem;
          const parentId = state.groupCreateParentId || '';
          state.groupsError = '';
          state.groupCreating = false;
          state.groupCreateParentId = '';
          state.groupCreateInitialItem = null;
          sendGroupAction({
            type: 'create',
            name,
            ...(parentId ? { parentId } : {}),
            ...(pendingItem ? { item: pendingItem } : {}),
          });
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          state.groupsError = '';
          state.groupCreating = false;
          state.groupCreateParentId = '';
          state.groupCreateInitialItem = null;
          renderSidebarGroupsPanel(true);
        }
        return;
      }

      const renameInp = ev.target?.closest?.('input[data-aq-grp-rename-input]');
      if (renameInp) {
        const groupId = renameInp.getAttribute('data-aq-grp-rename-input') || '';
        if (ev.key === 'Enter') {
          ev.preventDefault();
          ev.stopPropagation();
          const name = String(renameInp.value || '').trim();
          if (!name) {
            state.groupsError = '请输入分组名称';
            renderSidebarGroupsPanel(true);
            return;
          }
          state.groupsError = '';
          state.groupRenamingId = '';
          sendGroupAction({ type: 'rename', groupId, name });
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          state.groupsError = '';
          state.groupRenamingId = '';
          renderSidebarGroupsPanel(true);
        }
      }
    });

    const clearGroupDragHighlights = () => {
      panel
        .querySelectorAll('.aq-grp-drag-before, .aq-grp-drag-inside, .aq-grp-drag-root')
        .forEach((el) => el.classList.remove('aq-grp-drag-before', 'aq-grp-drag-inside', 'aq-grp-drag-root'));
    };

    panel.addEventListener('dragstart', (ev) => {
      const hdr = ev.target?.closest?.('[data-aq-grp-hdr]');
      if (!hdr || state.groupRenamingId || state.groupCreating) {
        ev.preventDefault();
        return;
      }
      state.groupDragId = hdr.getAttribute('data-aq-grp-hdr') || '';
      state.groupDragMode = '';
      state.groupDragTargetId = '';
      try {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', state.groupDragId);
      } catch {}
    });

    panel.addEventListener('dragover', (ev) => {
      if (!state.groupDragId) return;
      const dragId = state.groupDragId;
      const dragGrp = state.groups.find((g) => g.id === dragId);
      if (!dragGrp) return;

      const secHdr = ev.target?.closest?.('[data-aq-grp-sec-hdr]');
      if (secHdr) {
        if (!dragGrp.parentId) {
          clearGroupDragHighlights();
          state.groupDragMode = '';
          state.groupDragTargetId = '';
          return;
        }
        ev.preventDefault();
        clearGroupDragHighlights();
        secHdr.classList.add('aq-grp-drag-root');
        state.groupDragMode = 'root';
        state.groupDragTargetId = '';
        return;
      }

      const block = ev.target?.closest?.('[data-aq-grp-block]');
      if (!block) return;
      const targetId = block.getAttribute('data-aq-grp-block') || '';
      if (!targetId || targetId === dragId || isGroupDescendant(state.groups, dragId, targetId)) {
        clearGroupDragHighlights();
        state.groupDragMode = '';
        state.groupDragTargetId = '';
        return;
      }

      const tree = buildGroupTreeIndex(state.groups);
      const targetDepth = tree.depthById.get(targetId) ?? 0;
      const dragHeight = getGroupSubtreeHeight(tree.childrenByParent, dragId);
      const canNestInside = targetDepth + 1 + dragHeight < MAX_GROUP_DEPTH;

      const hdr = block.querySelector(':scope > [data-aq-grp-hdr]');
      const hRect = hdr?.getBoundingClientRect?.();
      let mode = canNestInside ? 'inside' : 'before';
      if (hRect && hRect.height > 0 && ev.clientY <= hRect.top + hRect.height * 0.28) {
        mode = 'before';
      }

      const targetGrp = tree.byId.get(targetId);
      const targetParentDepth = targetGrp?.parentId ? (tree.depthById.get(targetGrp.parentId) ?? 0) : -1;
      if (mode === 'before' && targetParentDepth + 1 + dragHeight >= MAX_GROUP_DEPTH) {
        if (!canNestInside) {
          clearGroupDragHighlights();
          state.groupDragMode = '';
          state.groupDragTargetId = '';
          return;
        }
        mode = 'inside';
      }

      ev.preventDefault();
      clearGroupDragHighlights();
      block.classList.add(mode === 'inside' ? 'aq-grp-drag-inside' : 'aq-grp-drag-before');
      state.groupDragMode = mode;
      state.groupDragTargetId = targetId;
    });

    panel.addEventListener('dragleave', (ev) => {
      if (!panel.contains(ev.relatedTarget)) {
        clearGroupDragHighlights();
        state.groupDragMode = '';
        state.groupDragTargetId = '';
      }
    });

    panel.addEventListener('drop', (ev) => {
      if (!state.groupDragId) return;
      const dragId = state.groupDragId;
      const mode = state.groupDragMode;
      const targetId = state.groupDragTargetId;
      state.groupDragId = '';
      state.groupDragMode = '';
      state.groupDragTargetId = '';
      clearGroupDragHighlights();
      if (!mode) return;
      ev.preventDefault();
      if (mode === 'root') {
        sendGroupAction({ type: 'move-group', groupId: dragId, parentId: '' });
        return;
      }
      if (!targetId || targetId === dragId || isGroupDescendant(state.groups, dragId, targetId)) return;
      if (mode === 'inside') {
        sendGroupAction({ type: 'move-group', groupId: dragId, parentId: targetId });
      } else if (mode === 'before') {
        const targetGrp = state.groups.find((g) => g.id === targetId);
        sendGroupAction({
          type: 'move-group',
          groupId: dragId,
          parentId: targetGrp?.parentId || '',
          beforeGroupId: targetId,
        });
      }
    });

    panel.addEventListener('dragend', () => {
      state.groupDragId = '';
      state.groupDragMode = '';
      state.groupDragTargetId = '';
      clearGroupDragHighlights();
    });
  }

  function ensureSidebarGroupsPanel() {
    const sidebar = document.querySelector('.bg-sidebar');
    if (!sidebar) return;
    const convList = sidebar.querySelector('[data-testid="conversation-list-sidebar"]');
    if (!convList) return;

    let scrollWrap = convList;
    while (scrollWrap && scrollWrap.parentElement && scrollWrap.parentElement !== sidebar) {
      scrollWrap = scrollWrap.parentElement;
    }
    if (!scrollWrap || scrollWrap.parentElement !== sidebar) return;

    let panel = document.getElementById('aq-conv-groups');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'aq-conv-groups';
      bindSidebarGroupsEvents(panel);
    }
    if (panel.parentElement !== sidebar || panel.nextElementSibling !== scrollWrap) {
      sidebar.insertBefore(panel, scrollWrap);
      state.groupRenderKey = '';
    }
    renderSidebarGroupsPanel(false);
    syncGroupedConversationMetadata();
  }

  function syncCascadeRoute() {
    const cid = extractCascadeId();
    if (cid !== state.cascadeId) {
      state.cascadeId = cid;
      if (!cid) {
        state.turnsPayload = null;
      } else {
        const cidLower = cid.toLowerCase();
        const now = Date.now();
        state.localViewedAtById[cidLower] = now;
        const meta = state.trajMetaById[cidLower];
        if (meta) {
          meta.lastUserViewMs = Math.max(meta.lastUserViewMs || 0, meta.lastModifiedMs || 0, now);
          meta.markedAsUnread = false;
        }
        if (typeof window.__aqRequestTurns === 'function') {
          try {
            window.__aqRequestTurns(cid);
          } catch {}
        }
      }
    }
  }

  function scheduleRenderAll() {
    if (state.renderRaf) return;
    state.renderRaf = requestAnimationFrame(() => {
      state.renderRaf = 0;
      syncCascadeRoute();
      ensureQuotaChip();
      ensureSidebarGroupsPanel();
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
      const turns = Array.isArray(payload?.turns) ? payload.turns : [];
      let totalTokens = 0;
      let totalCalls = 0;
      for (let i = 0; i < turns.length; i++) {
        totalTokens += Number(turns[i]?.totalTokens || 0);
        totalCalls += Number(turns[i]?.calls || 0);
      }
      const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
      const lastCompleted = lastTurn ? Boolean(lastTurn.completed) : true;
      const prevCompleted = state.lastTurnCompleted;
      const activitySig = `${cid}|${turns.length}|${totalTokens}|${totalCalls}`;
      const activityChanged = Boolean(sameChat && activitySig !== state.lastTurnActivitySig);
      state.lastTurnsCid = cid;
      state.lastTurnActivitySig = activitySig;
      state.lastTurnCompleted = lastCompleted;
      state.turnsPayload = payload;
      scheduleRenderAll();
      if (sameChat && !document.hidden) {
        if (lastCompleted && (activityChanged || !prevCompleted)) {
          scheduleQuotaForceRefresh(1500);
        } else if (!lastCompleted && activityChanged) {
          if (Date.now() - state.quotaForceFetchedAt >= QUOTA_RUNNING_INTERVAL_MS) {
            scheduleQuotaForceRefresh(1500);
          }
        }
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
      const planName = state.userProfile?.planName || '';
      const saveSig = email ? `${email.toLowerCase()}|${planName}` : '';
      if (state.accountsSupported && email && state.autoSavedSignature !== saveSig) {
        state.autoSavedSignature = saveSig;
        sendAccountAction({ type: 'save', silent: true });
      } else {
        syncCurrentAccountQuotaSnapshot();
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

  window.__aqRenderGroups = function (payload) {
    try {
      state.groupsLoaded = true;
      state.groupsCollapsedSection = Boolean(payload?.collapsedSection);
      if (Array.isArray(payload?.groups)) {
        state.groups = payload.groups;
      }
      state.groupsError = String(payload?.error || '');
      if (state.groupRenamingId && !state.groups.some((g) => g.id === state.groupRenamingId)) {
        state.groupRenamingId = '';
      }
      if (state.groupCreateParentId && !state.groups.some((g) => g.id === state.groupCreateParentId)) {
        state.groupCreateParentId = '';
        state.groupCreating = false;
      }
      ensureSidebarGroupsPanel();
      renderSidebarGroupsPanel(true);
      renderGroupMenuContent();
      if (state.pendingUnpinCascadeIds.size > 0) {
        const pendingIds = [...state.pendingUnpinCascadeIds];
        state.pendingUnpinCascadeIds.clear();
        if (!state.groupsError) {
          for (let i = 0; i < pendingIds.length; i++) {
            const cid = pendingIds[i];
            if (isConversationGrouped(cid)) {
              unpinConversationIfPinned(cid);
            }
          }
        }
      }
      if (state.convDrag?.started) {
        updateConversationDragTarget(state.convDrag.lastX, state.convDrag.lastY);
      }
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
        if (p?.closest?.('#aq-conv-groups, #aq-group-menu, #aq-conv-drag-ghost')) {
          continue;
        }
        if (p?.closest?.(CHROME_ROOT_SELECTOR)) {
          relevant = true;
          shouldFlushNow = true;
        }
        continue;
      }
      if (
        t?.nodeType === 1 &&
        t.closest?.(
          '[data-aq-turn-usage], #aq-context-chip, #aq-quota-chip, #aq-quota-tooltip, #aq-acct-quota-tooltip, #aq-turn-tooltip, #aq-conv-groups, #aq-group-menu, #aq-conv-drag-ghost'
        )
      ) {
        continue;
      }
      if (m.type === 'attributes') {
        relevant = true;
        continue;
      }
      if (m.type === 'childList') {
        const changed = [...(m.addedNodes || []), ...(m.removedNodes || [])];
        if (
          changed.length > 0 &&
          changed.every((n) => n?.nodeType === 1 && n.id === 'aq-conv-drag-ghost')
        ) {
          continue;
        }
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
  state.domObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-selected', 'data-cascade-id'],
  });

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
      if (!state.quotaData || Date.now() - state.quotaForceFetchedAt >= 10_000) {
        void fetchQuota({ force: true });
      }
      void refreshTrajectoryMetadata(false, 5_000);
    }
  };
  const onDocPointerDown = (ev) => {
    const t = ev.target;
    if (state.quotaTooltipPinned && !t?.closest?.('#aq-quota-tooltip, #aq-acct-quota-tooltip, #aq-quota-chip, #aq-context-chip')) {
      closeQuotaTooltip();
    }
    if (state.groupMenuTarget && !t?.closest?.('#aq-group-menu, [data-aq-grp-item-menu]')) {
      closeGroupMenu();
    }
    if (ev.button !== 0) return;
    const resizer = t?.closest?.('#aq-conv-groups [data-aq-grp-resizer]');
    if (resizer) {
      const panel = document.getElementById('aq-conv-groups');
      const bodyEl = panel?.querySelector('.aq-grp-body');
      if (panel && bodyEl) {
        ev.preventDefault();
        ev.stopPropagation();
        if (state.groupResizeSnapTimer) {
          clearTimeout(state.groupResizeSnapTimer);
          state.groupResizeSnapTimer = null;
        }
        bodyEl.style.transition = '';
        const startHeight = Math.round(bodyEl.getBoundingClientRect().height);
        state.groupResizeDrag = {
          panel,
          bodyEl,
          resizerEl: resizer,
          startY: ev.clientY,
          startHeight,
          currentHeight: startHeight,
          moved: false,
        };
        const badge = resizer.querySelector('[data-aq-grp-resizer-badge]');
        if (badge) badge.textContent = `上限 ${startHeight}px`;
        resizer.classList.add('is-resizing');
        document.body.classList.add('aq-resizing-groups');
      }
      return;
    }
    if (
      t?.closest?.(
        'button, input, textarea, [contenteditable="true"], [data-no-drag], #aq-group-menu, [data-aq-grp-hdr], .aq-grp-item-actions'
      )
    ) {
      return;
    }
    const grpItemEl = t?.closest?.('#aq-conv-groups [data-aq-grp-open]');
    if (grpItemEl) {
      const cid = grpItemEl.getAttribute('data-aq-grp-open') || '';
      const gid = grpItemEl.getAttribute('data-aq-grp-gid') || '';
      const grp = state.groups.find((g) => g.id === gid);
      const found = grp?.items?.find((it) => String(it.cascadeId || '') === cid);
      if (found && gid) {
        startConversationPointerDrag({
          mode: 'group-item',
          sourceGroupId: gid,
          sourceEl: grpItemEl,
          item: { cascadeId: found.cascadeId, title: found.title, project: found.project || '' },
          startX: ev.clientX,
          startY: ev.clientY,
        });
      }
      return;
    }
    if (document.querySelector('[role="menu"]')) return;
    const row = t?.closest?.('.bg-sidebar [data-testid="conversation-row-sidebar"][data-cascade-id]');
    if (row && !row.closest('[aria-hidden="true"]')) {
      const info = extractRowConversationInfo(row);
      if (info) {
        startConversationPointerDrag({
          mode: 'native-row',
          sourceGroupId: '',
          sourceEl: row,
          item: info,
          startX: ev.clientX,
          startY: ev.clientY,
        });
      }
    }
  };
  const onWinPointerMoveCapture = (ev) => {
    const r = state.groupResizeDrag;
    if (r) {
      if (ev.buttons === 0) {
        cleanupGroupResizeDrag({ commit: r.moved });
        return;
      }
      const deltaY = ev.clientY - r.startY;
      if (Math.abs(deltaY) >= 2) r.moved = true;
      const nextH = clampGroupsBodyHeight(r.startHeight + deltaY, r.panel);
      r.currentHeight = nextH;
      if (r.bodyEl?.isConnected) {
        r.bodyEl.style.transition = '';
        r.bodyEl.style.height = `${nextH}px`;
        r.bodyEl.style.maxHeight = 'none';
      }
      const badge = r.resizerEl?.querySelector?.('[data-aq-grp-resizer-badge]');
      if (badge) badge.textContent = `上限 ${nextH}px`;
      ev.preventDefault();
      return;
    }
    const d = state.convDrag;
    if (!d) return;
    if (ev.buttons === 0) {
      cleanupConversationPointerDrag();
      return;
    }
    if (!d.started) {
      if (Math.max(Math.abs(ev.clientX - d.startX), Math.abs(ev.clientY - d.startY)) < 5) {
        return;
      }
      d.started = true;
      closeGroupMenu();
      if (d.mode === 'group-item') {
        d.sourceEl?.classList?.add('is-dragging');
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'grabbing';
      }
    }
    updateConversationDragTarget(ev.clientX, ev.clientY);
  };
  const onWinPointerUpCapture = (ev) => {
    const r = state.groupResizeDrag;
    if (r) {
      cleanupGroupResizeDrag({ commit: r.moved });
      ev.preventDefault();
      return;
    }
    const d = state.convDrag;
    if (!d) return;
    if (!d.started) {
      cleanupConversationPointerDrag();
      return;
    }
    updateConversationDragTarget(ev.clientX, ev.clientY);
    const overPanel = d.overPanel;
    const targetGroupId = d.overGroupId;
    const dropOnEmptyPanel = d.overEmptyPanel;
    cleanupConversationPointerDrag();

    if (d.mode === 'native-row') {
      if (!overPanel) return;
      try {
        window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
      } catch {}
      ev.preventDefault();
      ev.stopImmediatePropagation();
      state.suppressGroupClickUntil = Date.now() + 200;
      if (targetGroupId) {
        state.groupsError = '';
        sendGroupAction({ type: 'add-item', groupId: targetGroupId, item: d.item });
      } else if (dropOnEmptyPanel) {
        state.groupsError = '';
        state.groupRenamingId = '';
        clearGroupDeleteConfirm();
        state.groupCreateParentId = '';
        state.groupCreating = true;
        state.groupCreateInitialItem = d.item;
        renderSidebarGroupsPanel(true);
      }
      return;
    }

    if (d.mode === 'group-item') {
      state.suppressGroupClickUntil = Date.now() + 200;
      ev.preventDefault();
      ev.stopPropagation();
      if (targetGroupId && targetGroupId !== d.sourceGroupId) {
        state.groupsError = '';
        sendGroupAction({
          type: 'move-item',
          fromGroupId: d.sourceGroupId,
          toGroupId: targetGroupId,
          item: d.item,
        });
      }
    }
  };
  const onWinPointerCancelCapture = () => {
    if (state.groupResizeDrag) cleanupGroupResizeDrag();
    if (state.convDrag) cleanupConversationPointerDrag();
  };
  const onWinBlur = () => {
    if (state.groupResizeDrag) cleanupGroupResizeDrag();
    if (state.convDrag) cleanupConversationPointerDrag();
  };
  const onDocKeyDown = (ev) => {
    if (ev.key === 'Escape') {
      if (state.convDrag?.started) {
        const wasGroupItem = state.convDrag.mode === 'group-item';
        cleanupConversationPointerDrag();
        if (wasGroupItem) {
          ev.preventDefault();
          ev.stopPropagation();
        }
      }
      if (state.quotaTooltipPinned) closeQuotaTooltip();
      if (state.groupMenuTarget) closeGroupMenu();
    }
  };
  window.addEventListener('popstate', onPopState);
  window.addEventListener('pointermove', onWinPointerMoveCapture, true);
  window.addEventListener('pointerup', onWinPointerUpCapture, true);
  window.addEventListener('pointercancel', onWinPointerCancelCapture, true);
  window.addEventListener('blur', onWinBlur);
  document.addEventListener('visibilitychange', onVisChange);
  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('keydown', onDocKeyDown, true);

  state.routeTimer = setInterval(checkRoute, 2000);
  state.trajStatusTimer = setInterval(() => {
    if (!document.hidden) {
      void refreshTrajectoryMetadata(false, 9_000);
    }
  }, TRAJ_STATUS_POLL_MS);
  state.quotaTimer = setInterval(() => {
    if (!document.hidden) {
      const now = Date.now();
      if (hasExpiredQuotaBucket(now) || now - state.quotaForceFetchedAt >= 120_000) {
        void fetchQuota({ force: true });
      }
      void refreshTrajectoryMetadata(false);
    }
  }, 60_000);

  window.__aqCleanup = function () {
    try {
      history.pushState = origPush;
      history.replaceState = origReplace;
    } catch {}
    window.removeEventListener('popstate', onPopState);
    window.removeEventListener('pointermove', onWinPointerMoveCapture, true);
    window.removeEventListener('pointerup', onWinPointerUpCapture, true);
    window.removeEventListener('pointercancel', onWinPointerCancelCapture, true);
    window.removeEventListener('blur', onWinBlur);
    document.removeEventListener('visibilitychange', onVisChange);
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
    cleanupGroupResizeDrag();
    cleanupConversationPointerDrag();
    closeGroupMenu();
    if (state.renderRaf) cancelAnimationFrame(state.renderRaf);
    if (state.routeTimer) clearInterval(state.routeTimer);
    if (state.trajStatusTimer) clearInterval(state.trajStatusTimer);
    if (state.quotaTimer) clearInterval(state.quotaTimer);
    if (state.quotaDebounceTimer) clearTimeout(state.quotaDebounceTimer);
    if (state.turnTooltipShowTimer) clearTimeout(state.turnTooltipShowTimer);
    if (state.turnTooltipHideTimer) clearTimeout(state.turnTooltipHideTimer);
    if (state.quotaTooltipShowTimer) clearTimeout(state.quotaTooltipShowTimer);
    if (state.quotaTooltipHideTimer) clearTimeout(state.quotaTooltipHideTimer);
    if (state.acctQuotaTooltipShowTimer) clearTimeout(state.acctQuotaTooltipShowTimer);
    if (state.acctQuotaTooltipHideTimer) clearTimeout(state.acctQuotaTooltipHideTimer);
    if (state.pendingSwitchTimer) clearTimeout(state.pendingSwitchTimer);
    if (state.groupDeleteConfirmTimer) clearTimeout(state.groupDeleteConfirmTimer);
    if (state.smartGraceTimer) clearTimeout(state.smartGraceTimer);
    if (state.groupResizeSnapTimer) clearTimeout(state.groupResizeSnapTimer);
    state.domObserver?.disconnect();
    state.footerObserver?.disconnect();
    document.getElementById('aq-codex-theme')?.remove();
    document.getElementById('aq-style')?.remove();
    document.getElementById('aq-context-chip')?.remove();
    document.getElementById('aq-quota-chip')?.remove();
    document.getElementById('aq-quota-tooltip')?.remove();
    document.getElementById('aq-acct-quota-tooltip')?.remove();
    document.getElementById('aq-turn-tooltip')?.remove();
    document.getElementById('aq-conv-groups')?.remove();
    document.getElementById('aq-group-row-btn')?.remove();
    document.getElementById('aq-group-menu')?.remove();
    document.getElementById('aq-conv-drag-ghost')?.remove();
    document.querySelectorAll('[data-aq-row-grp-btn]').forEach((el) => el.remove());
    document.querySelectorAll('[data-aq-menu-open]').forEach((el) => el.removeAttribute('data-aq-menu-open'));
    document.querySelectorAll('[data-aq-turn-usage]').forEach((el) => el.remove());
    delete window.__aqRenderTurns;
    delete window.__aqGetWatchedCascadeId;
    delete window.__aqRenderAccounts;
    delete window.__aqRenderUpdate;
    delete window.__aqRenderGroups;
    delete window.__aqHydrated;
    delete window.__aq_version;
    delete window.__aqCleanup;
  };

  window.__aqHydrated = false;
  window.__aq_version = INJECT_VERSION;
  checkRoute();
  void fetchQuota({ force: false, includeUserStatus: true }).then(() => {
    if (!document.hidden) {
      void fetchQuota({ force: true, immediate: true });
    }
  });
  void refreshTrajectoryMetadata(true);
})();
