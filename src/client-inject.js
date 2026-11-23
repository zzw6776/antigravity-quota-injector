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
  const INSTANCE_TOKEN = `${INJECT_VERSION}:${Math.random().toString(36).slice(2, 10)}`;
  const CODEX_THEME_CSS = __AQ_CODEX_THEME_CSS__;
  if (
    window.__aq_version === INJECT_VERSION &&
    window.__aq_active_token &&
    document.getElementById('aq-style')
  ) {
    return;
  }

  if (Array.isArray(window.__aqCleanupRegistry)) {
    while (window.__aqCleanupRegistry.length > 0) {
      const fn = window.__aqCleanupRegistry.pop();
      try {
        if (typeof fn === 'function') fn();
      } catch {}
    }
  } else {
    window.__aqCleanupRegistry = [];
  }

  if (typeof window.__aqCleanup === 'function') {
    try {
      window.__aqCleanup();
    } catch {}
  }

  window.__aq_active_token = INSTANCE_TOKEN;
  // Clean up legacy global rAF wrapper if left by an earlier injected version
  if (typeof window.__aqOrigRaf === 'function') {
    try {
      window.requestAnimationFrame = window.__aqOrigRaf;
      delete window.__aqOrigRaf;
      delete window.__aqRafGuarded;
    } catch {}
  }

  // __AQ_FORMATTING_HELPERS__
  // __AQ_I18N_HELPERS__

  const TURN_TOOLTIP_DELAY_MS = 500;
  const QUOTA_TOOLTIP_DELAY_MS = 300;
  const QUOTA_FORCE_COOLDOWN_MS = 10_000;
  const QUOTA_RUNNING_INTERVAL_MS = 30_000;
  const TRAJ_STATUS_POLL_MS = 10_000;
  const OPTIMISTIC_SEND_GRACE_MS = 8_000;
  const COMPOSER_BUSY_SELECTOR =
    '[data-testid="input-cancel-button"], [data-testid="send-button-pending"]';
  const MIN_CONV_WIDTH = 560;
  const MAX_CONV_WIDTH = 8192;
  const DEFAULT_CONV_WIDTH = 768;

  function parseConvWidthStorageValue(raw) {
    if (raw === 'full') return { mode: 'full', width: 0 };
    const v = Number(raw);
    if (raw !== null && raw !== '' && Number.isFinite(v) && v >= MIN_CONV_WIDTH) {
      return { mode: 'custom', width: Math.min(MAX_CONV_WIDTH, Math.round(v)) };
    }
    return { mode: 'unset', width: DEFAULT_CONV_WIDTH };
  }

  const initConvWidthPref = (() => {
    try {
      return parseConvWidthStorageValue(localStorage.getItem('aq_conv_max_width_v1'));
    } catch {
      return { mode: 'unset', width: DEFAULT_CONV_WIDTH };
    }
  })();

  const state = {
    disposed: false,
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
    renderDirty: {
      chip: false,
      sidebar: false,
      turns: false,
      menus: false,
      i18n: false,
      i18nSidebar: false,
    },
    quotaTimer: null,
    trajStatusTimer: null,
    lastTurnsCid: '',
    lastTurnActivitySig: '',
    lastTurnCompleted: true,
    liveTurnTimer: null,
    liveTurnKey: '',
    turnConfirmedPeakMsByKey: new Map(),
    liveTurnMainIdleSince: 0,
    wasTurnLiveRunning: false,
    nonDaemonBgTaskCids: new Set(),
    postSendTurnsTimer: null,
    routeTimer: null,
    domObserver: null,
    footerObserver: null,
    observedFooterBox: null,
    footerResizeObserver: null,
    observedResizeFooter: null,
    chipResizeRaf: 0,
    turnTooltipAnchor: null,
    turnTooltipShowTimer: null,
    turnTooltipHideTimer: null,
    ctxTooltipAnchor: null,
    ctxTooltipShowTimer: null,
    ctxTooltipHideTimer: null,
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
    pendingBatchConfirm: false,
    pendingBatchConfirmTimer: null,
    keepAliveLoaded: false,
    batchKeepAlive: null,
    batchSummary: null,
    shownBatchToastRunId: '',
    batchToastTimer: null,
    batchWakeRunningToken: '',
    batchFreshQuotaStepSeq: 0,
    batchFreshQuotaAttemptAt: 0,
    batchReadySentStepSeq: 0,
    batchReadyRetryTimer: null,
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
    foldersCollapsed: (() => {
      try {
        const raw = localStorage.getItem('aq_smart_groups_collapsed_v1');
        if (raw) {
          const parsed = JSON.parse(raw);
          return Boolean(parsed?.folders);
        }
      } catch {}
      return false;
    })(),
    recentCollapsed: (() => {
      try {
        const raw = localStorage.getItem('aq_smart_groups_collapsed_v1');
        if (raw) {
          const parsed = JSON.parse(raw);
          return Boolean(parsed?.recent);
        }
      } catch {}
      return false;
    })(),
    smartStableMap: new Map(),
    smartNextSeq: 1,
    smartGraceTimer: null,
    optimisticRunningById: new Map(),
    optimisticExpiryTimer: null,
    pendingNewChatSendAt: 0,
    postSendRefreshTimers: [],
    wasComposerBusy: false,
    clientModelConfigs: [],
    acctDrag: null,
    keepAliveState: { accountId: '', pools: {} },
    keepAliveClaims: new Map(),
    keepAliveDeadlineTimer: null,
    keepAliveRunningPools: new Set(),
    hiddenKeepAliveCids: new Set(),
    localViewedAtById: Object.create(null),
    localUserInputAtById: Object.create(null),
    sidebarTab: (() => {
      try {
        return localStorage.getItem('aq_sidebar_tab_v1') === 'projects' ? 'projects' : 'groups';
      } catch {
        return 'groups';
      }
    })(),
    cachedProjSplit: null,
    cachedNativeItemsRef: null,
    cachedNativeProjIndex: null,
    cachedGroupsRef: null,
    cachedGroupedCids: null,
    projScrollEl: null,
    onProjScroll: null,
    projScrollRaf: 0,
    convDragRaf: 0,
    historyTimers: new Set(),
    i18nTextCache: new WeakMap(),
    i18nAttrCache: new WeakMap(),
    i18nCtrlSigCache: new WeakMap(),
    turnsRenderSeq: 0,
    latestSidebarDomInfo: null,
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
    convWidthMode: initConvWidthPref.mode,
    convMaxWidth: initConvWidthPref.width,
    uiPrefsLoaded: false,
    uiPrefsMigrated: false,
    convLastCustomWidth: (() => {
      try {
        const v = Number(localStorage.getItem('aq_conv_last_custom_width_v1'));
        return Number.isFinite(v) && v >= 560 ? Math.round(v) : 768;
      } catch {
        return 768;
      }
    })(),
    convWidthDrag: null,
    convWidthDragRaf: 0,
    convWidthHoverTimer: null,
    convWidthBadgeTimer: null,
    convDrag: null,
    convDragLongPressTimer: null,
    convDragExpandTimer: null,
    convDragHoverGroupTimer: null,
    convDragHoverGroupId: '',
    autoUnpinnedCids: (() => {
      try {
        const raw = localStorage.getItem('aq_auto_unpinned_cids_v1');
        const arr = raw ? JSON.parse(raw) : [];
        return new Set(
          Array.isArray(arr)
            ? arr.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean)
            : []
        );
      } catch {
        return new Set();
      }
    })(),
    pendingUnpinCascadeIds: new Set(),
    pendingRestorePinCascadeIds: new Set(),
    suppressGroupClickUntil: 0,
    trajMetaById: Object.create(null),
    trajFetchedAt: 0,
    lastMetaSyncKey: '',
    isTranslating: false,
    lastNativeMenuConv: null,
    contextMenuPatched: false,
    contextMenuProto: null,
    contextMenuProviderFiber: null,
    thinkingReqSeq: 0,
    thinkingAutoTimer: null,
    thinkingSourcePref: (() => {
      try {
        const raw = String(localStorage.getItem('aq_thinking_source_v1') || '').trim().toLowerCase();
        const legacyMap = {
          'easydict-ai-brief': 'ai-brief',
          'easydict-builtin-ai': 'ai-translate',
          'easydict-google': 'google',
          'web-google': 'google',
          'easydict-deepl': 'deepl',
          'easydict-bing': 'bing',
          'easydict-youdao': 'youdao',
        };
        const mapped = legacyMap[raw] || raw;
        return ['auto', 'ai-brief', 'ai-translate', 'google', 'deepl', 'bing', 'youdao'].includes(mapped)
          ? mapped
          : 'auto';
      } catch {
        return 'auto';
      }
    })(),
    aiConfigMeta: {
      configured: false,
      apiKey: '',
      hasEnvKey: false,
      source: '',
      endpoint: '',
      model: '',
    },
    keySettingsOpen: false,
    keySettingsSaving: false,
    keySettingsRequestId: '',
    keySettingsTimer: null,
    thinkingTranslate: {
      cascadeId: '',
      turnKey: '',
      requestId: '',
      open: false,
      loading: false,
      switchingSource: false,
      showOriginal: false,
      stepIdx: -1,
      thinkingCount: 0,
      lastUploadedClientSig: '',
      hasOriginal: false,
      sourceText: '',
      translatedText: '',
      translatedSourceText: '',
      activeSourcePref: '',
      providerLabel: '',
      error: '',
      errorRetryAfter: 0,
      empty: false,
      btnEl: null,
      cardEl: null,
      cardParts: null,
      hostEl: null,
    },
  };

  window.__aqCleanupRegistry.push(() => {
    state.disposed = true;
    state.domObserver?.disconnect();
    state.footerObserver?.disconnect();
    state.footerResizeObserver?.disconnect();
    if (state.renderRaf) cancelAnimationFrame(state.renderRaf);
    state.renderRaf = 0;
    if (state.chipResizeRaf) cancelAnimationFrame(state.chipResizeRaf);
    state.chipResizeRaf = 0;
    if (state.projScrollRaf) cancelAnimationFrame(state.projScrollRaf);
    state.projScrollRaf = 0;
    if (state.convDragRaf) cancelAnimationFrame(state.convDragRaf);
    state.convDragRaf = 0;
    stopLiveTurnTimer();
    if (state.postSendTurnsTimer) clearTimeout(state.postSendTurnsTimer);
    if (state.routeTimer) clearInterval(state.routeTimer);
    if (state.trajStatusTimer) clearInterval(state.trajStatusTimer);
    if (state.quotaTimer) clearInterval(state.quotaTimer);
    if (state.thinkingAutoTimer) clearInterval(state.thinkingAutoTimer);
  });

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
      :root,
      html,
      body {
        --max-conversation-width: var(--aq-conv-max-width, 768px) !important;
        --max-artifact-width: var(--aq-conv-max-width, 768px) !important;
      }
      [style*="--max-conversation-width"],
      [style*="--max-artifact-width"] {
        max-width: min(100%, var(--aq-conv-max-width, 768px)) !important;
      }

      .aq-conv-width-resizer {
        position: absolute;
        top: 10px;
        bottom: 10px;
        width: 12px;
        cursor: default;
        z-index: 24;
        display: flex;
        align-items: center;
        justify-content: center;
        user-select: none;
        touch-action: none;
      }
      .aq-conv-width-resizer[data-aq-conv-resizer="left"] {
        left: -6px;
      }
      .aq-conv-width-resizer[data-aq-conv-resizer="right"] {
        right: -6px;
      }
      [data-testid="conversation-view"].aq-conv-width-armed .aq-conv-width-resizer,
      [data-testid="conversation-view"].aq-conv-width-active .aq-conv-width-resizer {
        cursor: ew-resize;
      }
      .aq-conv-width-resizer::after {
        content: "";
        position: absolute;
        bottom: -6px;
        left: 5px;
        width: 2px;
        height: 100vh;
        border-radius: 1px;
        background: transparent;
        pointer-events: none;
        transition: background-color 0.12s ease;
      }
      [data-testid="conversation-view"].aq-conv-width-armed .aq-conv-width-resizer::after,
      [data-testid="conversation-view"].aq-conv-width-active .aq-conv-width-resizer::after {
        background: rgba(37, 99, 235, 0.5);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) [data-testid="conversation-view"].aq-conv-width-armed .aq-conv-width-resizer::after,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) [data-testid="conversation-view"].aq-conv-width-active .aq-conv-width-resizer::after {
        background: rgba(96, 165, 250, 0.6);
      }
      .aq-conv-width-badge {
        position: absolute;
        bottom: calc(100% + 8px);
        padding: 2px 8px;
        border-radius: 9999px;
        background: var(--background, #ffffff);
        border: 1px solid rgba(37, 99, 235, 0.35);
        color: #2563eb;
        font-size: 10.5px;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        line-height: 16px;
        white-space: nowrap;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.12s ease;
      }
      .aq-conv-width-resizer[data-aq-conv-resizer="left"] .aq-conv-width-badge {
        left: 2px;
      }
      .aq-conv-width-resizer[data-aq-conv-resizer="right"] .aq-conv-width-badge {
        right: 2px;
      }
      .aq-conv-width-resizer.is-resizing .aq-conv-width-badge,
      .aq-conv-width-resizer.is-flash .aq-conv-width-badge {
        opacity: 1;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-conv-width-badge {
        background: #27272a;
        border-color: rgba(96, 165, 250, 0.45);
        color: #93c5fd;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.38);
      }
      body.aq-resizing-conv-width,
      body.aq-resizing-conv-width * {
        cursor: ew-resize !important;
        user-select: none !important;
      }
      body.aq-resizing-conv-width [style*="--max-conversation-width"],
      body.aq-resizing-conv-width [style*="--max-artifact-width"],
      body.aq-resizing-conv-width .aq-conv-width-resizer {
        transition: none !important;
      }

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

      @keyframes aq-think-spin {
        to {
          transform: rotate(360deg);
        }
      }
      [data-aq-thinking-host] {
        display: flex !important;
        flex-wrap: wrap !important;
        align-items: center !important;
        column-gap: 2px !important;
      }
      [data-aq-thinking-host] > button[data-testid="tool-group-collapsible"],
      [data-aq-thinking-host] > button[data-testid="thinking-collapsible-trigger"],
      [data-aq-thinking-host] > button[data-testid="worked-for-collapsible"] {
        width: auto !important;
        max-width: calc(100% - 30px) !important;
        flex: 0 1 auto !important;
      }
      [data-aq-thinking-host] > div {
        flex: 0 0 100% !important;
        width: 100% !important;
        min-width: 0 !important;
      }
      [data-aq-thinking-inline] {
        display: flex !important;
        flex-wrap: wrap !important;
        align-items: center !important;
        column-gap: 3px !important;
        white-space: normal !important;
      }
      [data-aq-thinking-inline] > :first-child {
        flex: 0 1 auto;
        max-width: calc(100% - 30px);
        min-width: 0;
        overflow: hidden;
      }
      [data-aq-thinking-btn] {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        padding: 0;
        margin: 0;
        border: none;
        background: transparent !important;
        box-shadow: none !important;
        color: var(--muted-foreground, #71717a);
        line-height: 0;
        flex-shrink: 0;
        cursor: pointer;
        user-select: none;
        opacity: 0.56;
        transition: opacity 0.14s ease, color 0.14s ease;
      }
      [data-aq-thinking-btn]:hover,
      [data-aq-thinking-btn]:focus-visible,
      [data-aq-thinking-btn][data-active="1"],
      [data-aq-thinking-btn][data-loading="1"] {
        opacity: 1;
        background: transparent !important;
        border: none;
        color: var(--foreground, #18181b);
        outline: none;
      }
      [data-aq-thinking-btn][data-loading="1"] {
        cursor: progress;
      }
      .aq-think-btn-icon {
        display: block;
        width: 14px;
        height: 14px;
        transform: translateY(1px);
        flex-shrink: 0;
      }
      .aq-think-spinner {
        display: block;
        width: 12px;
        height: 12px;
        transform: translateY(1px);
        border-radius: 9999px;
        border: 1.5px solid currentColor;
        border-right-color: transparent;
        animation: aq-think-spin 0.68s linear infinite;
        flex-shrink: 0;
      }
      .aq-think-hdr-spinner {
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 9999px;
        border: 1.5px solid #3b82f6;
        border-right-color: transparent;
        animation: aq-think-spin 0.68s linear infinite;
        flex-shrink: 0;
      }
      [data-aq-thinking-card] {
        display: block;
        flex: 0 0 100%;
        width: 100%;
        box-sizing: border-box;
        margin: 5px 0 6px 0;
        padding: 8px 10px;
        border-radius: 10px;
        border: 1px solid var(--border, rgba(24, 24, 27, 0.085));
        background: var(--muted, rgba(24, 24, 27, 0.032));
        color: var(--secondary-foreground, #27272a);
        white-space: normal;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) [data-aq-thinking-card] {
        background: rgba(255, 255, 255, 0.042);
        border-color: rgba(255, 255, 255, 0.095);
        color: #e4e4ec;
      }
      .aq-think-card-hdr {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 5px;
        font: 500 11px/16px var(--font-sans, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
        color: var(--muted-foreground, #71717a);
        user-select: none;
      }
      .aq-think-card-meta-wrap {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
        overflow: hidden;
      }
      .aq-think-live-dot {
        width: 6px;
        height: 6px;
        border-radius: 9999px;
        background: #3b82f6;
        opacity: 0.78;
        flex-shrink: 0;
      }
      .aq-think-live-dot[data-syncing="1"] {
        background: #2563eb;
        box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
      }
      .aq-think-card-meta {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .aq-think-card-actions {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
      }
      .aq-think-src-select {
        height: 20px;
        max-width: 126px;
        padding: 0 16px 0 6px;
        border-radius: 5px;
        border: 1px solid var(--border, rgba(24, 24, 27, 0.12));
        background-color: transparent;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 12 12' fill='none' stroke='%2371717a' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 4px center;
        appearance: none;
        -webkit-appearance: none;
        color: var(--muted-foreground, #71717a);
        font: 500 11px/18px var(--font-sans, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
        cursor: pointer;
        outline: none;
        transition: border-color 0.12s ease, background-color 0.12s ease, color 0.12s ease;
      }
      .aq-think-src-select:hover,
      .aq-think-src-select:focus-visible {
        background-color: var(--secondary, rgba(127, 127, 127, 0.1));
        border-color: var(--border, rgba(127, 127, 127, 0.28));
        color: var(--foreground, #18181b);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-think-src-select {
        border-color: rgba(255, 255, 255, 0.12);
        color: #a1a1aa;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-think-src-select:hover,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-think-src-select:focus-visible {
        color: #f4f4f7;
      }
      .aq-think-src-select option {
        background: var(--card, #ffffff);
        color: var(--foreground, #18181b);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-think-src-select option {
        background: #1e1e28;
        color: #f4f4f7;
      }
      .aq-think-card-act {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 20px;
        padding: 0 5px;
        border: none;
        border-radius: 5px;
        background: transparent;
        color: var(--muted-foreground, #71717a);
        font: 500 11px/1 var(--font-sans, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
        cursor: pointer;
        transition: background-color 0.12s ease, color 0.12s ease;
      }
      .aq-think-card-act:hover,
      .aq-think-card-act:focus-visible {
        background: var(--secondary, rgba(127, 127, 127, 0.12));
        color: var(--foreground, #18181b);
        outline: none;
      }
      .aq-think-card-body {
        max-height: 210px;
        overflow-y: auto;
        font: 400 13px/1.52 var(--font-sans, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
        color: var(--secondary-foreground, #27272a);
        white-space: normal;
        overflow-wrap: anywhere;
        user-select: text;
        transition: opacity 0.14s ease;
      }
      .aq-think-card-body[data-switching="1"] {
        opacity: 0.56;
      }
      .aq-think-para {
        margin: 0;
      }
      .aq-think-para + .aq-think-para {
        margin-top: 3px;
      }
      .aq-think-card-body[data-muted="1"] {
        color: var(--muted-foreground, #71717a);
        font-size: 12px;
      }
      .aq-think-card-body[data-error="1"] {
        color: #dc2626;
        font-size: 12px;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-think-card-body[data-error="1"] {
        color: #f87171;
      }
      .aq-think-code {
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 11.5px;
        padding: 1px 5px;
        border-radius: 5px;
        background: rgba(24, 24, 27, 0.06);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-think-code {
        background: rgba(255, 255, 255, 0.09);
      }

      #aq-context-chip,
      #aq-quota-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        height: 28px;
        padding: 0 9px;
        margin-right: 2px;
        border-radius: 9999px;
        border: 1px solid var(--border, rgba(127, 127, 127, 0.22));
        background: transparent;
        color: var(--secondary-foreground, var(--foreground, #3f3f46));
        font: 400 12px/1 var(--font-sans, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
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
      #aq-context-chip[data-mode="ring"],
      #aq-quota-chip[data-mode="ring"],
      #aq-quota-chip[data-mode="single"] {
        position: relative;
        width: 28px;
        min-width: 28px;
        height: 28px;
        padding: 0;
        margin-right: 2px;
        border-color: transparent;
        background: transparent;
        justify-content: center;
        gap: 0;
      }
      #aq-context-chip[data-mode="ring"]:hover,
      #aq-context-chip[data-mode="ring"]:focus-visible,
      #aq-quota-chip[data-mode="ring"]:hover,
      #aq-quota-chip[data-mode="ring"]:focus-visible,
      #aq-quota-chip[data-mode="single"]:hover,
      #aq-quota-chip[data-mode="single"]:focus-visible {
        border-color: transparent;
        background: var(--secondary, rgba(127, 127, 127, 0.1));
      }
      #aq-quota-chip[data-mode="ring"] .aq-update-dot,
      #aq-quota-chip[data-mode="single"] .aq-update-dot {
        position: absolute;
        top: 3px;
        right: 3px;
      }
      .aq-chip-ring {
        display: block;
        width: 16px;
        height: 16px;
        flex-shrink: 0;
      }
      .aq-lvl-ok {
        color: inherit;
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
      #aq-context-tooltip {
        width: auto;
        min-width: 0;
        max-width: min(280px, calc(100vw - 24px));
        padding: 6px 10px;
        border-radius: 8px;
        background: #ffffff;
        color: #18181b;
        border: 1px solid rgba(15, 23, 42, 0.085);
        box-shadow: 0 10px 24px -6px rgba(15, 23, 42, 0.14), 0 2px 8px rgba(15, 23, 42, 0.05);
        font-size: 11px;
        line-height: 16px;
        white-space: nowrap;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) #aq-context-tooltip {
        background: #191a20;
        color: #f4f4f6;
        border-color: rgba(255, 255, 255, 0.09);
        box-shadow: 0 14px 32px -8px rgba(0, 0, 0, 0.65), 0 4px 12px rgba(0, 0, 0, 0.34);
      }
      .aq-ctx-tt-row {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
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
      .aq-tt-cum + .aq-tt-cum {
        padding-top: 3px;
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

      #aq-quota-tooltip {
        width: 344px;
        min-width: 308px;
        max-width: min(356px, calc(100vw - 24px));
        padding: 13px 14px;
        border-radius: 12px;
        background: #ffffff;
        color: #18181b;
        border: 1px solid rgba(15, 23, 42, 0.085);
        box-shadow: 0 18px 40px -8px rgba(15, 23, 42, 0.14), 0 3px 10px rgba(15, 23, 42, 0.05);
      }
      #aq-acct-quota-tooltip {
        width: 294px;
        min-width: 260px;
        max-width: min(308px, calc(100vw - 24px));
        padding: 12px 13px;
        border-radius: 12px;
        background: #ffffff;
        color: #18181b;
        border: 1px solid rgba(15, 23, 42, 0.085);
        box-shadow: 0 18px 38px -8px rgba(15, 23, 42, 0.14), 0 3px 10px rgba(15, 23, 42, 0.05);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) #aq-quota-tooltip,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) #aq-acct-quota-tooltip {
        background: #191a20;
        color: #f4f4f6;
        border-color: rgba(255, 255, 255, 0.09);
        box-shadow: 0 22px 48px -10px rgba(0, 0, 0, 0.65), 0 4px 14px rgba(0, 0, 0, 0.34);
      }

      .aq-qp-hdr {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 0 2px;
        margin-bottom: 8px;
      }
      .aq-qp-title-wrap {
        display: inline-flex;
        align-items: baseline;
        gap: 6px;
        min-width: 0;
        flex: 1;
      }
      .aq-qp-title {
        font-size: 12px;
        font-weight: 600;
        letter-spacing: -0.01em;
        color: inherit;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .aq-qp-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 14px;
        font-size: 9px;
        font-weight: 500;
        line-height: 1;
        padding: 0 5px;
        border-radius: 9999px;
        background: rgba(15, 23, 42, 0.045);
        color: #71717a;
        flex-shrink: 0;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-badge {
        background: rgba(255, 255, 255, 0.065);
        color: #9697a3;
      }
      .aq-qp-status {
        font-size: 10px;
        font-weight: 450;
        color: #71717a;
        flex-shrink: 0;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-status {
        color: #9697a3;
      }

      .aq-qp-ctx {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
        padding: 0 2px 7px;
        margin-bottom: 0;
        font-size: 10.5px;
      }
      .aq-qp-ctx-lbl {
        color: #71717a;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-ctx-lbl {
        color: #9697a3;
      }
      .aq-qp-ctx-val {
        font-variant-numeric: tabular-nums;
        color: #27272a;
        white-space: nowrap;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-ctx-val {
        color: #e4e4e7;
      }
      .aq-qp-ctx-strong {
        font-weight: 400;
        color: inherit;
      }
      .aq-qp-ctx-strong.aq-lvl-muted {
        color: #71717a;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-ctx-strong.aq-lvl-muted {
        color: #9697a3;
      }
      .aq-qp-ctx-strong.aq-lvl-warn {
        color: #c27803;
      }
      .aq-qp-ctx-strong.aq-lvl-crit {
        color: #dc2626;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-ctx-strong.aq-lvl-warn {
        color: #fbbf24;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-ctx-strong.aq-lvl-crit {
        color: #f87171;
      }

      .aq-qp-groups {
        display: grid;
        gap: 0;
        border-top: 1px solid rgba(127, 127, 127, 0.12);
      }
      .aq-qp-card {
        padding: 7.5px 2px;
        margin: 0;
        border: 0;
        border-radius: 0;
        background: transparent;
      }
      .aq-qp-card + .aq-qp-card {
        border-top: 1px dotted rgba(127, 127, 127, 0.25);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-card + .aq-qp-card {
        border-top-color: rgba(255, 255, 255, 0.13);
      }
      .aq-qp-card-hdr {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 4px;
      }
      .aq-qp-card-title {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        font-size: 11px;
        font-weight: 600;
        line-height: 1.3;
      }
      .aq-qp-card-title > span:last-child {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .aq-qp-active-dot {
        width: 5.5px;
        height: 5.5px;
        border-radius: 9999px;
        flex-shrink: 0;
        transform: translateY(0.5px);
        background: #3b82f6;
        box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.16);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-active-dot {
        background: #60a5fa;
        box-shadow: 0 0 0 2px rgba(96, 165, 250, 0.2);
      }

      /* Mini toggle switch for silent keep-alive: label stays neutral gray (never colored) */
      .aq-qp-ka-switch {
        appearance: none;
        border: 0;
        background: transparent;
        padding: 1px 0 1px 4px;
        margin: -1px 0;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font: inherit;
        cursor: pointer;
        flex-shrink: 0;
        color: #8a8a93;
        transition: color 0.14s ease, opacity 0.14s ease;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-ka-switch {
        color: #8c8c96;
      }
      .aq-qp-ka-lbl {
        font-size: 10px;
        font-weight: 450;
        line-height: 1;
        color: #8a8a93;
        transition: color 0.14s ease;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-ka-lbl {
        color: #8c8c96;
      }
      .aq-qp-ka-switch:hover .aq-qp-ka-lbl {
        color: #52525b;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-ka-switch:hover .aq-qp-ka-lbl {
        color: #d4d4d8;
      }
      .aq-qp-ka-track {
        position: relative;
        width: 22px;
        height: 12px;
        border-radius: 9999px;
        background: rgba(127, 127, 127, 0.18);
        transition: background-color 0.16s ease, box-shadow 0.16s ease;
        flex-shrink: 0;
      }
      .aq-qp-ka-switch:hover .aq-qp-ka-track {
        background: rgba(127, 127, 127, 0.26);
      }
      .aq-qp-ka-switch.is-on .aq-qp-ka-track {
        background: #3b82f6;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-ka-switch.is-on .aq-qp-ka-track {
        background: #3b82f6;
      }
      .aq-qp-ka-switch.is-on:hover .aq-qp-ka-track {
        background: #2563eb;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-ka-switch.is-on:hover .aq-qp-ka-track {
        background: #60a5fa;
      }
      .aq-qp-ka-switch.is-running .aq-qp-ka-track {
        box-shadow: 0 0 0 2.5px rgba(59, 130, 246, 0.24);
      }
      .aq-qp-ka-thumb {
        position: absolute;
        top: 1.5px;
        left: 1.5px;
        width: 9px;
        height: 9px;
        border-radius: 9999px;
        background: #ffffff;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
        transition: transform 0.16s cubic-bezier(0.22, 1, 0.36, 1);
      }
      .aq-qp-ka-switch.is-on .aq-qp-ka-thumb {
        transform: translateX(10px);
      }

      .aq-qp-buckets {
        display: grid;
        gap: 3.5px;
      }
      .aq-qp-bkt-row {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        font-size: 10.5px;
        line-height: 1.38;
      }
      .aq-qp-bkt-win {
        color: #71717a;
        font-size: 10.5px;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-bkt-win {
        color: #9697a3;
      }
      .aq-qp-bkt-val {
        display: inline-flex;
        align-items: baseline;
        gap: 4px;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .aq-qp-bkt-val.is-grid {
        display: grid;
        grid-template-columns: 31px auto auto auto;
        column-gap: 4px;
        align-items: baseline;
      }
      .aq-qp-bkt-val.is-grid .aq-qp-bkt-pct {
        text-align: right;
      }
      .aq-qp-bkt-val.is-grid .aq-qp-bkt-sep {
        text-align: center;
      }
      .aq-qp-bkt-pct {
        font-weight: 550;
        font-size: 11px;
        color: #059669;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-bkt-pct {
        color: #34d399;
      }
      .aq-qp-bkt-pct.is-muted {
        color: #71717a;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-bkt-pct.is-muted {
        color: #9697a3;
      }
      .aq-qp-bkt-pct.is-warn {
        color: #c27803;
      }
      .aq-qp-bkt-pct.is-crit {
        color: #dc2626;
      }
      .aq-qp-bkt-pct.is-reset {
        color: #059669;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-bkt-pct.is-warn {
        color: #fbbf24;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-bkt-pct.is-crit {
        color: #f87171;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-bkt-pct.is-reset {
        color: #34d399;
      }
      .aq-qp-bkt-sep {
        font-size: 10.5px;
        color: #a1a1aa;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-bkt-sep {
        color: #5c5d69;
      }
      .aq-qp-bkt-dur,
      .aq-qp-bkt-date,
      .aq-qp-bkt-reset {
        font-size: 10.5px;
        color: #71717a;
        white-space: nowrap;
      }
      .aq-qp-bkt-dur,
      .aq-qp-bkt-date {
        text-align: right;
      }
      .aq-qp-bkt-dur {
        font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
        font-size: 10.3px;
        letter-spacing: 0.01em;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-bkt-dur,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-bkt-date,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-bkt-reset {
        color: #9697a3;
      }

      /* Unified classic account switcher (Scheme 1 refined, no scrollbar) */
      .aq-q-accounts {
        margin-top: 2px;
        padding-top: 8px;
        border-top: 1px solid rgba(127, 127, 127, 0.14);
        display: grid;
        gap: 6px;
      }
      .aq-q-acct-hdr {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 0 2px;
        font-size: 10.5px;
        font-weight: 600;
        color: #71717a;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-hdr {
        color: #9697a3;
      }
      .aq-q-acct-hdr-actions {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
      }
      .aq-q-acct-hdr-actions .aq-qp-add-btn {
        margin: -1px 0;
      }
      .aq-q-acct-hdr-actions .aq-qp-add-btn:last-child {
        margin-right: 0;
      }
      .aq-qp-add-btn {
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        height: 19px;
        border: 1px solid rgba(15, 23, 42, 0.14);
        background: #ffffff;
        color: #3f3f46;
        border-radius: 5px;
        padding: 0 7px;
        margin: -1px 0;
        font: inherit;
        font-size: 10px;
        font-weight: 500;
        line-height: 1;
        cursor: pointer;
        white-space: nowrap;
        transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease, opacity 0.12s ease;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-add-btn {
        background: rgba(255, 255, 255, 0.06);
        border-color: rgba(255, 255, 255, 0.13);
        color: #e4e4e7;
      }
      .aq-qp-add-btn:hover:not(:disabled) {
        border-color: rgba(15, 23, 42, 0.28);
        color: #18181b;
        background: #fafafa;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-add-btn:hover:not(:disabled) {
        border-color: rgba(255, 255, 255, 0.25);
        color: #f4f4f5;
        background: rgba(255, 255, 255, 0.1);
      }
      .aq-qp-add-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .aq-qp-add-btn.is-warn,
      .aq-qp-add-btn.is-warn:hover:not(:disabled) {
        background: rgba(245, 158, 11, 0.15);
        border-color: rgba(245, 158, 11, 0.35);
        color: #b45309;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-add-btn.is-warn,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-qp-add-btn.is-warn:hover:not(:disabled) {
        background: rgba(251, 191, 36, 0.16);
        border-color: rgba(251, 191, 36, 0.35);
        color: #fbbf24;
      }
      .aq-q-acct-list {
        display: grid;
        gap: 4.5px;
      }
      .aq-q-acct-row {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-height: 36px;
        padding: 5px 7px;
        margin: 0 -6px;
        border-radius: 7.5px;
        font-size: 11px;
        background: rgba(15, 23, 42, 0.028);
        border: 1px solid transparent;
        transition: background-color 0.12s ease, border-color 0.12s ease, opacity 0.12s ease;
      }
      .aq-q-acct-meta,
      .aq-q-acct-email,
      .aq-q-acct-sub,
      .aq-acct-tt-email {
        user-select: text;
        -webkit-user-select: text;
        cursor: text;
      }
      .aq-q-acct-list.is-reordering,
      .aq-q-acct-list.is-reordering * {
        user-select: none !important;
        -webkit-user-select: none !important;
        cursor: grabbing !important;
      }
      .aq-q-acct-list.is-reordering .aq-q-acct-row:not(.is-dragging) {
        transition: transform 150ms cubic-bezier(0.2, 0, 0, 1), background-color 0.12s ease, border-color 0.12s ease;
      }
      .aq-q-acct-row.is-dragging {
        z-index: 6;
        opacity: 0.97;
        cursor: grabbing;
        background: #ffffff;
        border-color: rgba(59, 130, 246, 0.38);
        box-shadow: 0 8px 20px -4px rgba(15, 23, 42, 0.16), 0 2px 6px -1px rgba(15, 23, 42, 0.08);
        transition: box-shadow 0.12s ease, border-color 0.12s ease;
        will-change: transform;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-row.is-dragging {
        background: #25272d;
        border-color: rgba(96, 165, 250, 0.42);
        box-shadow: 0 10px 24px -4px rgba(0, 0, 0, 0.55), 0 2px 8px -1px rgba(0, 0, 0, 0.35);
      }
      .aq-q-acct-row.is-current.is-dragging {
        background: #f2f7ff;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-row.is-current.is-dragging {
        background: #222b3a;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-row {
        background: rgba(255, 255, 255, 0.032);
      }
      .aq-q-acct-row.is-current {
        background: rgba(59, 130, 246, 0.06);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-row.is-current {
        background: rgba(59, 130, 246, 0.1);
      }
      .aq-q-acct-row:hover {
        background: rgba(15, 23, 42, 0.055);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-row:hover {
        background: rgba(255, 255, 255, 0.065);
      }
      .aq-q-acct-row.is-current:hover {
        background: rgba(59, 130, 246, 0.085);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-row.is-current:hover {
        background: rgba(59, 130, 246, 0.13);
      }
      .aq-q-acct-info {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 6.5px;
      }
      .aq-q-acct-meta {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .aq-q-acct-right {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .aq-q-acct-gem {
        display: inline-block;
        width: 5.5px;
        height: 5.5px;
        border-radius: 9999px;
        flex-shrink: 0;
        transition: opacity 0.12s ease, background-color 0.12s ease;
      }
      .aq-q-acct-gem.is-available {
        background: #059669;
      }
      .aq-q-acct-gem.is-depleted {
        background: #dc2626;
      }
      .aq-q-acct-gem.is-unknown {
        background: rgba(127, 127, 127, 0.28);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-gem.is-available {
        background: #34d399;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-gem.is-depleted {
        background: #f87171;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-gem.is-unknown {
        background: rgba(161, 161, 170, 0.28);
      }
      .aq-q-acct-email {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        line-height: 1.3;
        color: #3f3f46;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-email {
        color: #d4d4d8;
      }
      .aq-q-acct-row.is-current .aq-q-acct-email {
        font-weight: 600;
        color: #18181b;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-row.is-current .aq-q-acct-email {
        color: #fafafa;
      }
      .aq-q-acct-sub {
        display: flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
        font-size: 10px;
        line-height: 1.25;
        font-variant-numeric: tabular-nums;
        color: #8a8a93;
      }
      .aq-q-acct-sub-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
      .aq-q-acct-unstarted-dot {
        display: inline-block;
        width: 5px;
        height: 5px;
        border-radius: 9999px;
        flex-shrink: 0;
        background: #f59e0b;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-unstarted-dot {
        background: #fbbf24;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-sub {
        color: #8c8c96;
      }
      .aq-q-acct-sub.is-depleted {
        color: #c27803;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-sub.is-depleted {
        color: #fbbf24;
      }
      .aq-q-acct-plan {
        font-size: 10px;
        color: #8e8e98;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .aq-q-active-tag {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 38px;
        height: 19px;
        padding: 0 7px;
        border-radius: 5px;
        font-size: 10px;
        font-weight: 500;
        background: rgba(59, 130, 246, 0.12);
        color: #2563eb;
        user-select: none;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-active-tag {
        background: rgba(96, 165, 250, 0.16);
        color: #93c5fd;
      }
      .aq-q-btn {
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 38px;
        height: 19px;
        padding: 0 7px;
        border-radius: 5px;
        border: 1px solid rgba(15, 23, 42, 0.14);
        background: #ffffff;
        color: #3f3f46;
        font: inherit;
        font-size: 10px;
        font-weight: 500;
        line-height: 1;
        cursor: pointer;
        white-space: nowrap;
        transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease, opacity 0.12s ease;
      }
      .aq-q-btn:hover:not(:disabled) {
        border-color: #3b82f6;
        color: #2563eb;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-btn {
        background: rgba(255, 255, 255, 0.06);
        border-color: rgba(255, 255, 255, 0.13);
        color: #e4e4e7;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-btn:hover:not(:disabled) {
        border-color: #60a5fa;
        color: #93c5fd;
      }
      .aq-q-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .aq-q-btn-warn,
      .aq-q-btn-warn:hover:not(:disabled) {
        background: rgba(245, 158, 11, 0.14);
        border-color: rgba(245, 158, 11, 0.36);
        color: #b45309;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-btn-warn,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-btn-warn:hover:not(:disabled) {
        background: rgba(251, 191, 36, 0.16);
        border-color: rgba(245, 158, 11, 0.38);
        color: #fbbf24;
      }
      .aq-q-btn-del {
        appearance: none;
        border: 0;
        background: transparent;
        color: #a1a1aa;
        width: 18px;
        height: 18px;
        padding: 0;
        margin-right: -3px;
        border-radius: 5px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        opacity: 0.34;
        transition: opacity 0.12s ease, background-color 0.12s ease, color 0.12s ease;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-btn-del {
        color: #71717a;
      }
      .aq-q-acct-row:hover .aq-q-btn-del {
        opacity: 0.78;
      }
      .aq-q-btn-del:hover:not(:disabled) {
        opacity: 1;
        background: rgba(239, 68, 68, 0.13);
        color: #dc2626;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-btn-del:hover:not(:disabled) {
        background: rgba(248, 113, 113, 0.16);
        color: #f87171;
      }
      .aq-q-btn-del:disabled {
        opacity: 0.2;
        cursor: not-allowed;
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
        font-size: 11.5px;
        font-weight: 600;
      }
      .aq-acct-tt-foot {
        margin-top: 8px;
        padding-top: 6px;
        border-top: 1px solid rgba(127, 127, 127, 0.12);
        font-size: 9.5px;
        color: #71717a;
        line-height: 1.4;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-acct-tt-foot {
        color: #8e8e98;
      }
      .aq-acct-tt-empty {
        padding: 4px 0 2px;
        font-size: 10.5px;
        color: #71717a;
        line-height: 1.5;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-acct-tt-empty {
        color: #8e8e98;
      }
      .aq-q-acct-note {
        font-size: 10px;
        color: #71717a;
        padding: 1px 0 0;
      }
      .aq-q-acct-note.is-success {
        color: #059669;
      }
      .aq-q-acct-err {
        font-size: 10px;
        color: #dc2626;
        padding: 1px 0 0;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-note {
        color: #8e8e98;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-note.is-success {
        color: #34d399;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-q-acct-err {
        color: #f87171;
      }
      .aq-update-dot {
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 9999px;
        background: #059669;
        margin-left: 2px;
        flex-shrink: 0;
      }
      .aq-q-update {
        margin-top: 5px;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 4px 10px;
        font-size: 10px;
      }
      .aq-key-settings-btn {
        appearance: none;
        border: 0;
        padding: 2px 3px;
        margin-right: auto;
        border-radius: 4px;
        background: transparent;
        color: #a1a1aa;
        line-height: 1;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: color 0.14s ease, background-color 0.14s ease;
      }
      .aq-key-settings-btn:hover {
        color: #52525b;
        background: rgba(0, 0, 0, 0.045);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-key-settings-btn {
        color: #52525b;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-key-settings-btn:hover {
        color: #a1a1aa;
        background: rgba(255, 255, 255, 0.06);
      }
      .aq-key-settings-ico {
        width: 11px;
        height: 11px;
        flex-shrink: 0;
      }
      #aq-key-settings-modal {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        background: rgba(0, 0, 0, 0.32);
        backdrop-filter: blur(2px);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
      }
      .aq-ks-dialog {
        width: min(372px, calc(100vw - 32px));
        border-radius: 12px;
        padding: 14px 15px;
        background: #ffffff;
        color: #18181b;
        border: 1px solid rgba(0, 0, 0, 0.1);
        box-shadow: 0 18px 42px rgba(0, 0, 0, 0.18);
        display: flex;
        flex-direction: column;
        gap: 10px;
        font-size: 12px;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-ks-dialog {
        background: #1c1c1f;
        color: #f4f4f5;
        border-color: rgba(255, 255, 255, 0.12);
        box-shadow: 0 18px 42px rgba(0, 0, 0, 0.48);
      }
      .aq-ks-hdr {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .aq-ks-title-wrap {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      .aq-ks-title {
        font-size: 13px;
        font-weight: 600;
      }
      .aq-ks-close {
        appearance: none;
        border: 0;
        background: transparent;
        color: #71717a;
        font-size: 16px;
        line-height: 1;
        padding: 2px 5px;
        border-radius: 5px;
        cursor: pointer;
      }
      .aq-ks-close:hover {
        background: rgba(0, 0, 0, 0.06);
        color: #18181b;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-ks-close:hover {
        background: rgba(255, 255, 255, 0.08);
        color: #f4f4f5;
      }
      .aq-ks-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .aq-ks-row2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .aq-ks-lbl {
        font-size: 11px;
        font-weight: 500;
        color: #52525b;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-ks-lbl {
        color: #a1a1aa;
      }
      .aq-ks-input {
        width: 100%;
        min-width: 0;
        box-sizing: border-box;
        padding: 6px 8px;
        border-radius: 7px;
        border: 1px solid rgba(0, 0, 0, 0.14);
        background: #fafafa;
        color: inherit;
        font: inherit;
        font-size: 11.5px;
        outline: none;
      }
      .aq-ks-input:focus {
        border-color: #10b981;
        background: #ffffff;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-ks-input {
        border-color: rgba(255, 255, 255, 0.14);
        background: #27272a;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-ks-input:focus {
        border-color: #34d399;
        background: #222226;
      }
      .aq-ks-note {
        font-size: 10.5px;
        line-height: 1.45;
        color: #71717a;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-ks-note {
        color: #8e8e98;
      }
      .aq-ks-err {
        font-size: 11px;
        line-height: 1.4;
        color: #dc2626;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-ks-err {
        color: #f87171;
      }
      .aq-ks-ftr {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-top: 2px;
      }
      .aq-ks-ftr-right {
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .aq-ks-btn {
        appearance: none;
        border: 1px solid rgba(0, 0, 0, 0.12);
        background: transparent;
        color: inherit;
        border-radius: 7px;
        padding: 4.5px 11px;
        font: inherit;
        font-size: 11.5px;
        font-weight: 500;
        cursor: pointer;
      }
      .aq-ks-btn:hover:not(:disabled) {
        background: rgba(0, 0, 0, 0.045);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-ks-btn {
        border-color: rgba(255, 255, 255, 0.14);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-ks-btn:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.07);
      }
      .aq-ks-btn.is-primary {
        border-color: transparent;
        background: #10b981;
        color: #ffffff;
      }
      .aq-ks-btn.is-primary:hover:not(:disabled) {
        background: #059669;
      }
      .aq-ks-btn:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .aq-update-open {
        appearance: none;
        border: 0;
        padding: 1px 7px;
        margin-left: auto;
        border-radius: 9999px;
        background: rgba(16, 185, 129, 0.12);
        color: #059669;
        font: inherit;
        font-size: 9.5px;
        font-weight: 500;
        line-height: 15px;
        cursor: pointer;
        white-space: nowrap;
        transition: background-color 0.14s ease, color 0.14s ease;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-update-open {
        background: rgba(52, 211, 153, 0.14);
        color: #34d399;
      }
      .aq-update-open:hover:not(:disabled) {
        background: rgba(16, 185, 129, 0.2);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-update-open:hover:not(:disabled) {
        background: rgba(52, 211, 153, 0.22);
      }
      .aq-update-open:disabled {
        cursor: default;
        opacity: 0.72;
      }
      .aq-panel-version-text,
      .aq-update-open.aq-panel-version-text {
        margin-left: auto;
        padding: 1px 2px;
        background: transparent !important;
        color: #a1a1aa;
        font-weight: 450;
        white-space: nowrap;
        font-size: 9.5px;
      }
      .aq-update-open.aq-panel-version-text:hover:not(:disabled) {
        color: #52525b;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-panel-version-text,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-update-open.aq-panel-version-text {
        color: #52525b;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-update-open.aq-panel-version-text:hover:not(:disabled) {
        color: #a1a1aa;
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

      /* Batch account switch + keep-alive floating progress panel */
      #aq-batch-wake-panel {
        position: fixed;
        right: 16px;
        bottom: 58px;
        z-index: 2147483646;
        width: 288px;
        max-width: calc(100vw - 24px);
        padding: 10px 12px;
        border-radius: 12px;
        background: #ffffff;
        color: #18181b;
        border: 1px solid rgba(15, 23, 42, 0.09);
        box-shadow: 0 18px 40px -8px rgba(15, 23, 42, 0.16), 0 3px 10px rgba(15, 23, 42, 0.06);
        font: 400 11px/1.45 var(--font-sans, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
        font-variant-numeric: tabular-nums;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) #aq-batch-wake-panel {
        background: #191a20;
        color: #f4f4f6;
        border-color: rgba(255, 255, 255, 0.09);
        box-shadow: 0 22px 48px -10px rgba(0, 0, 0, 0.65), 0 4px 14px rgba(0, 0, 0, 0.34);
      }
      #aq-batch-wake-panel.is-done {
        border-color: rgba(5, 150, 105, 0.3);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) #aq-batch-wake-panel.is-done {
        border-color: rgba(52, 211, 153, 0.3);
      }
      #aq-batch-wake-panel.is-failed {
        border-color: rgba(220, 38, 38, 0.3);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) #aq-batch-wake-panel.is-failed {
        border-color: rgba(248, 113, 113, 0.3);
      }
      .aq-bw-check {
        width: 12px;
        height: 12px;
        color: #059669;
        flex-shrink: 0;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-bw-check {
        color: #34d399;
      }
      #aq-batch-toast {
        position: fixed;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        max-width: min(560px, calc(100vw - 32px));
        padding: 8px 12px;
        border-radius: 9999px;
        background: #ffffff;
        color: #18181b;
        border: 1px solid rgba(5, 150, 105, 0.28);
        box-shadow: 0 14px 34px -8px rgba(15, 23, 42, 0.2), 0 3px 10px rgba(15, 23, 42, 0.08);
        font: 500 11.5px/1.35 var(--font-sans, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
        font-variant-numeric: tabular-nums;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) #aq-batch-toast {
        background: #191a20;
        color: #f4f4f6;
        border-color: rgba(52, 211, 153, 0.32);
        box-shadow: 0 18px 42px -10px rgba(0, 0, 0, 0.72), 0 4px 14px rgba(0, 0, 0, 0.4);
      }
      #aq-batch-toast.is-failed {
        border-color: rgba(220, 38, 38, 0.34);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) #aq-batch-toast.is-failed {
        border-color: rgba(248, 113, 113, 0.34);
      }
      .aq-bt-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
      .aq-bt-close {
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        padding: 0;
        border: 0;
        border-radius: 9999px;
        background: transparent;
        color: #71717a;
        cursor: pointer;
        flex-shrink: 0;
      }
      .aq-bt-close:hover {
        background: rgba(15, 23, 42, 0.06);
        color: #18181b;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-bt-close {
        color: #9a9aa6;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-bt-close:hover {
        background: rgba(255, 255, 255, 0.08);
        color: #f4f4f6;
      }
      .aq-bw-hdr {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .aq-bw-title-wrap {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        font-weight: 600;
        font-size: 11.5px;
      }
      .aq-bw-pulse {
        width: 5.5px;
        height: 5.5px;
        border-radius: 9999px;
        background: #2563eb;
        flex-shrink: 0;
        animation: aq-ka-pulse 1.1s ease-in-out infinite;
      }
      .aq-bw-pulse.is-done {
        background: #059669;
        animation: none;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-bw-pulse.is-done {
        background: #34d399;
      }
      .aq-bw-pulse.is-cancelled {
        background: #f59e0b;
        animation: none;
      }
      .aq-bw-pulse.is-failed {
        background: #dc2626;
        animation: none;
      }
      .aq-bw-action {
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        height: 19px;
        border: 1px solid rgba(15, 23, 42, 0.14);
        background: transparent;
        color: #3f3f46;
        border-radius: 5px;
        padding: 0 7px;
        font: inherit;
        font-size: 10px;
        font-weight: 500;
        line-height: 1;
        cursor: pointer;
        flex-shrink: 0;
      }
      .aq-bw-action:hover {
        background: rgba(15, 23, 42, 0.05);
        color: #18181b;
      }
      .aq-bw-action.is-stop {
        border-color: rgba(245, 158, 11, 0.4);
        color: #b45309;
        background: rgba(245, 158, 11, 0.08);
      }
      .aq-bw-action.is-stop:hover {
        background: rgba(245, 158, 11, 0.16);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-bw-action {
        border-color: rgba(255, 255, 255, 0.13);
        color: #e4e4e7;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-bw-action:hover {
        background: rgba(255, 255, 255, 0.08);
        color: #f4f4f6;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-bw-action.is-stop {
        border-color: rgba(251, 191, 36, 0.35);
        color: #fbbf24;
        background: rgba(251, 191, 36, 0.12);
      }
      .aq-bw-status {
        margin-top: 4px;
        font-size: 10px;
        color: #71717a;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .aq-bw-status.is-finished {
        white-space: normal;
        overflow-wrap: anywhere;
        line-height: 1.4;
      }
      .aq-bw-status.is-done {
        color: #059669;
        font-weight: 500;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-bw-status {
        color: #9a9aa6;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-bw-status.is-done {
        color: #34d399;
      }
      .aq-bw-list {
        margin-top: 7px;
        display: grid;
        gap: 4px;
        max-height: 156px;
        overflow-y: auto;
      }
      .aq-bw-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 3.5px 6px;
        border-radius: 6px;
        background: rgba(15, 23, 42, 0.03);
        font-size: 10px;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-bw-row {
        background: rgba(255, 255, 255, 0.04);
      }
      .aq-bw-row-left {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
        flex: 1;
      }
      .aq-bw-dot {
        width: 5px;
        height: 5px;
        border-radius: 9999px;
        flex-shrink: 0;
        background: #a1a1aa;
      }
      .aq-bw-dot.is-running {
        background: #2563eb;
        animation: aq-ka-pulse 1.1s ease-in-out infinite;
      }
      .aq-bw-dot.is-done {
        background: #059669;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-bw-dot.is-done {
        background: #34d399;
      }
      .aq-bw-dot.is-failed {
        background: #dc2626;
      }
      .aq-bw-dot.is-cancelled {
        background: #f59e0b;
      }
      .aq-bw-email {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .aq-bw-detail {
        flex-shrink: 0;
        max-width: 112px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: #71717a;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-bw-detail {
        color: #9a9aa6;
      }

      /* Sidebar custom conversation groups */
      #aq-conv-groups {
        position: relative;
        flex: 1 1 0%;
        min-height: 0;
        min-width: 0;
        margin-top: 0;
        padding: 2px 8px 6px;
        display: flex;
        flex-direction: column;
        font-size: 13px;
        line-height: 1.35;
        letter-spacing: -0.006em;
        user-select: none;
        overflow: hidden;
      }
      .aq-grp-active-sec,
      .aq-grp-top-wrap,
      .aq-grp-recent-sec,
      .aq-proj-card {
        border-radius: 10px;
        background: var(--background, #ffffff);
        border: 1px solid rgba(24, 24, 27, 0.075);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.025);
      }
      .bg-sidebar [data-testid="sidebar-navigation-items"] {
        gap: 2px !important;
      }
      .bg-sidebar > .px-2 + div.h-px,
      .bg-sidebar > div.h-px:has(+ div > [data-testid="settings-button"]) {
        background-color: rgba(24, 24, 27, 0.068) !important;
      }
      .bg-sidebar > .px-2 + div.h-px {
        margin: 8px 10px 0 !important;
      }
      .bg-sidebar > div.h-px:has(+ div > [data-testid="settings-button"]) {
        margin: 6px 10px 2px !important;
      }
      .bg-sidebar > div:has(> [data-testid="settings-button"]) {
        margin: 2px 0 0 !important;
        padding: 4px 8px 0 !important;
      }
      .bg-sidebar [data-testid="conversation-list-sidebar"] {
        padding: 0 !important;
        --sidebar: var(--background, #ffffff);
        --color-sidebar: var(--background, #ffffff);
      }
      .bg-sidebar [data-testid="conversation-list-sidebar"] > div > div[data-index] {
        padding-left: 4px !important;
        padding-right: 4px !important;
        box-sizing: border-box !important;
        z-index: 1;
      }
      .agy-sidebar-row .flex-col > span:first-child {
        font-size: 13px !important;
        line-height: 18px !important;
      }
      .agy-sidebar-row .flex-col > span.text-muted-foreground,
      .agy-sidebar-row .flex-col > span.text-muted-foreground > span {
        font-size: 11px !important;
        line-height: 14px !important;
        font-weight: 400 !important;
        color: var(--muted-foreground, #71717a) !important;
      }
      .agy-sidebar-row .flex-col > span.text-muted-foreground {
        gap: 3px !important;
        opacity: 0.9;
      }
      .agy-sidebar-row .flex-col > span.text-muted-foreground svg {
        width: 11px !important;
        height: 11px !important;
        opacity: 0.78;
      }
      .agy-sidebar-row:not([class~="pl-[30px]"]):not([class~="pl-2.5"]),
      .bg-sidebar [data-sidebar-section-id="all"] .agy-sidebar-row,
      .bg-sidebar [data-sidebar-section-id^="status-"] .agy-sidebar-row,
      .bg-sidebar [data-sidebar-section-id^="location-"] .agy-sidebar-row,
      .bg-sidebar [data-sidebar-section-id^="convgroup:"] .agy-sidebar-row,
      .bg-sidebar [data-sidebar-section-id="standalone"] .agy-sidebar-row {
        height: 42px !important;
        min-height: 42px !important;
        padding-top: 5px !important;
        padding-bottom: 5px !important;
        align-items: center !important;
        box-sizing: border-box !important;
      }
      .agy-sidebar-row > [class~="h-[1lh]"] {
        height: 100% !important;
      }
      .agy-sidebar-row > [class~="h-[1lh]"] > div {
        height: 100%;
      }
      :is(
        .agy-sidebar-row:not([class~="pl-[30px]"]):not([class~="pl-2.5"]),
        .bg-sidebar [data-sidebar-section-id="all"] .agy-sidebar-row,
        .bg-sidebar [data-sidebar-section-id^="status-"] .agy-sidebar-row,
        .bg-sidebar [data-sidebar-section-id^="location-"] .agy-sidebar-row,
        .bg-sidebar [data-sidebar-section-id^="convgroup:"] .agy-sidebar-row,
        .bg-sidebar [data-sidebar-section-id="standalone"] .agy-sidebar-row
      )[data-subtext=""][data-aq-no-project] .flex-col::after {
        content: "无项目";
        display: inline-flex;
        align-items: center;
        font-size: 11px;
        line-height: 14px;
        font-weight: 400;
        color: var(--muted-foreground, #71717a);
        opacity: 0.52;
        padding-left: 14px;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 -960 960 960' fill='%2371717a'%3E%3Cpath d='M100-100v-667.69Q100-798 121-819t51.31-21h615.38Q818-840 839-819t21 51.31v455.38Q860-282 839-261t-51.31 21H240L100-100Zm115-200h572.69q5.39 0 8.85-3.46t3.46-8.85v-455.38q0-5.39-3.46-8.85T787.69-780H172.31q-5.39 0-8.85 3.46T160-767.69V-245l55-55Z'/%3E%3C/svg%3E");
        background-size: 11px 11px;
        background-repeat: no-repeat;
        background-position: 0 center;
        white-space: nowrap;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) :is(
        .agy-sidebar-row:not([class~="pl-[30px]"]):not([class~="pl-2.5"]),
        .bg-sidebar [data-sidebar-section-id="all"] .agy-sidebar-row,
        .bg-sidebar [data-sidebar-section-id^="status-"] .agy-sidebar-row,
        .bg-sidebar [data-sidebar-section-id^="location-"] .agy-sidebar-row,
        .bg-sidebar [data-sidebar-section-id^="convgroup:"] .agy-sidebar-row,
        .bg-sidebar [data-sidebar-section-id="standalone"] .agy-sidebar-row
      )[data-subtext=""][data-aq-no-project] .flex-col::after {
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 -960 960 960' fill='%239a9aa6'%3E%3Cpath d='M100-100v-667.69Q100-798 121-819t51.31-21h615.38Q818-840 839-819t21 51.31v455.38Q860-282 839-261t-51.31 21H240L100-100Zm115-200h572.69q5.39 0 8.85-3.46t3.46-8.85v-455.38q0-5.39-3.46-8.85T787.69-780H172.31q-5.39 0-8.85 3.46T160-767.69V-245l55-55Z'/%3E%3C/svg%3E");
      }
      .aq-proj-card {
        position: absolute;
        left: 0;
        right: 0;
        z-index: 0;
        pointer-events: none;
        box-sizing: border-box;
      }
      body:not(.dark):not(.theme-dark) .bg-sidebar [data-testid="conversation-list-sidebar"] .bg-sidebar {
        background-color: transparent !important;
      }
      body:not(.dark):not(.theme-dark) .bg-sidebar [data-testid="conversation-list-sidebar"].aq-proj-scrolled [data-sidebar-section-drop-id="pinned"][style*="sticky"],
      body:not(.dark):not(.theme-dark) .bg-sidebar [data-testid="conversation-list-sidebar"].aq-proj-scrolled [data-sidebar-section-drop-id="main-section-header"][style*="sticky"] {
        background-color: var(--background, #ffffff) !important;
        border-radius: 10px 10px 0 0 !important;
        clip-path: inset(1px 1px 0 1px round 9px 9px 0 0);
      }
      .aq-grp-active-sec,
      .aq-grp-top-wrap,
      .aq-grp-recent-sec {
        padding: 4px 4px 5px;
      }
      .aq-grp-active-sec {
        flex-shrink: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        margin-bottom: 8px;
      }
      .aq-grp-active-sec.is-empty {
        padding: 4px;
      }
      .aq-grp-active-dot {
        width: 6px;
        height: 6px;
        border-radius: 9999px;
        flex-shrink: 0;
        background: #3b82f6;
        box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.16);
        transition: background-color 160ms ease, box-shadow 160ms ease;
      }
      .aq-grp-active-sec.is-empty .aq-grp-active-dot {
        background: rgba(113, 113, 122, 0.42);
        box-shadow: none;
      }
      .aq-grp-active-sec .aq-smart-list {
        max-height: clamp(86px, 24vh, 214px);
        overflow-y: auto;
      }
      .aq-grp-top-wrap {
        position: relative;
        flex: 0 1 auto;
        min-width: 0;
        padding: 4px 4px 5px;
        margin-bottom: 8px;
        display: flex;
        flex-direction: column;
      }
      .aq-grp-root-add-btn {
        appearance: none;
        width: 100%;
        display: flex;
        align-items: center;
        gap: 6px;
        height: 28px;
        margin-top: 3px;
        padding: 0 8px;
        box-sizing: border-box;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: var(--muted-foreground, #71717a);
        font: inherit;
        font-size: 12.5px;
        font-weight: 400;
        cursor: pointer;
        text-align: left;
        transition: background-color 0.12s ease, color 0.12s ease;
      }
      .aq-grp-root-add-btn:hover {
        background: var(--sidebar-muted, rgba(24, 24, 27, 0.04));
        color: var(--foreground, #18181b);
      }
      .aq-grp-empty-cta {
        appearance: none;
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 7px 10px;
        margin: 2px 0;
        border-radius: 8px;
        border: 1px dashed rgba(24, 24, 27, 0.14);
        background: rgba(24, 24, 27, 0.02);
        color: var(--muted-foreground, #71717a);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
        transition: border-color 0.14s ease, color 0.14s ease, background-color 0.14s ease;
      }
      .aq-grp-empty-cta:hover {
        border-color: rgba(24, 24, 27, 0.28);
        background: rgba(24, 24, 27, 0.04);
        color: var(--foreground, #18181b);
      }
      .aq-grp-recent-sec {
        flex: 1 1 0%;
        min-height: 72px;
        min-width: 0;
        margin-top: 0;
        padding: 4px 4px 5px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .aq-grp-recent-sec:has(> .aq-smart-children.is-collapsed) {
        flex: 0 0 auto;
        min-height: 0;
      }
      .aq-grp-recent-sec > .aq-grp-hdr {
        flex-shrink: 0;
      }
      .aq-grp-recent-sec > .aq-smart-children {
        flex: 1 1 0%;
        min-height: 0;
        overflow: hidden;
      }
      .aq-grp-recent-sec > .aq-smart-children:not(.is-collapsed) > .aq-smart-children-inner {
        overflow-x: hidden;
        overflow-y: auto;
      }
      .aq-grp-recent-sec > .aq-smart-children.is-collapsed {
        flex: 0 0 auto;
        overflow: hidden;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .bg-sidebar > .px-2 + div.h-px,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .bg-sidebar > div.h-px:has(+ div > [data-testid="settings-button"]) {
        background-color: rgba(255, 255, 255, 0.09) !important;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) :is(
        .aq-grp-active-sec,
        .aq-grp-top-wrap,
        .aq-grp-recent-sec,
        .aq-proj-card
      ) {
        background: #19191f;
        border-color: rgba(255, 255, 255, 0.085);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .bg-sidebar [data-testid="conversation-list-sidebar"],
      body:is(.dark, .theme-dark) .bg-sidebar [data-testid="conversation-list-sidebar"] {
        --sidebar: #19191f;
        --color-sidebar: #19191f;
      }
      body:is(.dark, .theme-dark) .bg-sidebar [data-testid="conversation-list-sidebar"] .bg-sidebar,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .bg-sidebar [data-testid="conversation-list-sidebar"] .bg-sidebar {
        background-color: transparent !important;
      }
      body:is(.dark, .theme-dark) .bg-sidebar [data-testid="conversation-list-sidebar"].aq-proj-scrolled [data-sidebar-section-drop-id="pinned"][style*="sticky"],
      body:is(.dark, .theme-dark) .bg-sidebar [data-testid="conversation-list-sidebar"].aq-proj-scrolled [data-sidebar-section-drop-id="main-section-header"][style*="sticky"],
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .bg-sidebar [data-testid="conversation-list-sidebar"].aq-proj-scrolled [data-sidebar-section-drop-id="pinned"][style*="sticky"],
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .bg-sidebar [data-testid="conversation-list-sidebar"].aq-proj-scrolled [data-sidebar-section-drop-id="main-section-header"][style*="sticky"] {
        background-color: #19191f !important;
        border-radius: 10px 10px 0 0 !important;
        clip-path: inset(1px 1px 0 1px round 9px 9px 0 0);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-active-dot {
        background: #60a5fa;
        box-shadow: 0 0 0 2px rgba(96, 165, 250, 0.2);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-active-sec.is-empty .aq-grp-active-dot {
        background: rgba(161, 161, 170, 0.42);
        box-shadow: none;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-root-add-btn:hover {
        background: rgba(255, 255, 255, 0.055);
        color: #f4f4f7;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-empty-cta {
        border-color: rgba(255, 255, 255, 0.14);
        background: rgba(255, 255, 255, 0.025);
        color: #9a9aa6;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-empty-cta:hover {
        border-color: rgba(255, 255, 255, 0.28);
        background: rgba(255, 255, 255, 0.055);
        color: #f4f4f7;
      }
      .aq-grp-resizer {
        position: absolute;
        left: 8px;
        right: 8px;
        bottom: -9px;
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
        max-height: clamp(180px, 44vh, 400px);
        overflow-y: auto;
        min-width: 0;
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
      .aq-grp-sec-hdr.aq-grp-drag-root,
      .aq-grp-hdr.is-smart.aq-grp-drag-root {
        background: rgba(37, 99, 235, 0.1);
        box-shadow: inset 0 0 0 1.5px rgba(37, 99, 235, 0.45);
        border-radius: 8px;
        color: #2563eb;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-sec-hdr.aq-grp-drag-root,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-hdr.is-smart.aq-grp-drag-root {
        background: rgba(96, 165, 250, 0.14);
        box-shadow: inset 0 0 0 1.5px rgba(96, 165, 250, 0.5);
        color: #93c5fd;
      }
      .aq-grp-block {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 1px;
        min-width: 0;
        border-radius: 8px;
      }
      .aq-grp-block.is-dragging > .aq-grp-hdr {
        opacity: 0.45;
      }
      .aq-grp-block.aq-grp-drag-before::before,
      .aq-grp-block.aq-grp-drag-after::after {
        content: '';
        position: absolute;
        left: 6px;
        right: 6px;
        height: 2px;
        border-radius: 999px;
        background: #2563eb;
        pointer-events: none;
        z-index: 3;
      }
      .aq-grp-block.aq-grp-drag-before::before {
        top: 0;
      }
      .aq-grp-block.aq-grp-drag-after::after {
        bottom: 0;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-block.aq-grp-drag-before::before,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-block.aq-grp-drag-after::after {
        background: #60a5fa;
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
        gap: 6px;
        height: 28px;
        padding: 0 8px;
        box-sizing: border-box;
        border-radius: 8px;
        cursor: pointer;
        color: var(--foreground, #0f172a);
        font-size: 13px;
        font-weight: 500;
        letter-spacing: -0.006em;
      }
      .aq-grp-hdr.is-smart {
        height: 26px;
        font-size: 11.5px;
        font-weight: 600;
        letter-spacing: 0.01em;
        color: var(--muted-foreground, #64748b);
      }
      .aq-grp-hdr:hover {
        background: var(--sidebar-muted, rgba(15, 23, 42, 0.048));
        color: var(--foreground, #0f172a);
      }
      .aq-grp-chev {
        width: 12px;
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--muted-foreground, #64748b);
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
        color: var(--muted-foreground, #64748b);
      }
      .aq-grp-folder-ico svg {
        width: 13px;
        height: 13px;
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
      .aq-grp-fold-hint {
        font-size: 11px;
        font-weight: 400;
        color: var(--muted-foreground, #71717a);
        flex-shrink: 0;
      }
      .aq-grp-fold-hint.is-highlight {
        color: #2563eb;
        font-weight: 500;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-fold-hint.is-highlight {
        color: #60a5fa;
      }
      .aq-grp-actions {
        display: none;
        align-items: center;
        gap: 1px;
        flex-shrink: 0;
      }
      body:not(.aq-conv-dragging) .aq-grp-hdr:hover .aq-grp-actions,
      .aq-grp-hdr.has-confirm .aq-grp-actions,
      .aq-grp-actions.is-always {
        display: inline-flex;
      }
      body:not(.aq-conv-dragging) .aq-grp-hdr:hover .aq-grp-count,
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
        margin: 4px 6px;
        background: rgba(15, 23, 42, 0.055);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-smart-sep {
        background: rgba(226, 232, 240, 0.07);
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
        min-width: 0;
        margin-left: 12px;
        padding-left: 2px;
      }
      .aq-grp-active-sec .aq-grp-children,
      .aq-grp-recent-sec .aq-grp-children {
        margin-left: 0;
        padding-left: 0;
      }
      .aq-gm-tree-branch {
        color: var(--muted-foreground, #64748b);
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
        padding: 5px 8px;
        height: 42px;
        min-height: 42px;
        box-sizing: border-box;
        border-radius: 8px;
        cursor: pointer;
        color: var(--secondary-foreground, #334155);
        font-weight: 400;
        min-width: 0;
      }
      .aq-grp-item.is-dragging {
        opacity: 0.45;
      }
      .aq-grp-item.aq-grp-item-drag-before::before,
      .aq-grp-item.aq-grp-item-drag-after::after {
        content: '';
        position: absolute;
        left: 8px;
        right: 8px;
        height: 2px;
        border-radius: 999px;
        background: #2563eb;
        pointer-events: none;
        z-index: 3;
      }
      .aq-grp-item.aq-grp-item-drag-before::before {
        top: 0;
      }
      .aq-grp-item.aq-grp-item-drag-after::after {
        bottom: 0;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-item.aq-grp-item-drag-before::before,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-item.aq-grp-item-drag-after::after {
        background: #60a5fa;
      }
      .aq-grp-item:hover {
        background: var(--sidebar-muted, rgba(15, 23, 42, 0.048));
        color: var(--foreground, #0f172a);
      }
      .aq-grp-item.is-active {
        background: var(--sidebar-secondary, rgba(15, 23, 42, 0.088));
        color: var(--foreground, #0f172a);
        font-weight: 400;
      }
      .aq-grp-item-main {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 0;
      }
      .aq-grp-item-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
        line-height: 18px;
        letter-spacing: -0.006em;
        font-weight: 400;
      }
      .aq-grp-item.is-active .aq-grp-item-title {
        font-weight: 500;
        color: var(--foreground, #0f172a);
      }
      .aq-grp-item-sub {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        font-size: 11px;
        line-height: 14px;
        font-weight: 400 !important;
        color: var(--muted-foreground, #64748b);
        opacity: 0.9;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .aq-grp-item-sub svg {
        width: 11px;
        height: 11px;
        flex-shrink: 0;
        opacity: 0.78;
      }
      .aq-grp-item-sub.is-no-project {
        opacity: 0.52;
      }
      .aq-grp-item-sub.is-no-project svg {
        opacity: 0.85;
      }
      .aq-grp-item-sub > span {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .aq-grp-item-status {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        flex-shrink: 0;
        color: var(--muted-foreground, #71717a);
      }
      body:not(.aq-conv-dragging) .aq-grp-item:has(> .aq-grp-item-actions):hover > .aq-grp-item-status {
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
        place-items: center;
        width: 12px;
        height: 12px;
        margin: auto;
        grid-template-columns: repeat(2, 3px);
        grid-template-rows: repeat(2, 3px);
        gap: 2px;
        opacity: 0.78;
        color: #3b82f6;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-status-spinner {
        color: #60a5fa;
      }
      .aq-grp-status-spinner > span {
        width: 3px;
        height: 3px;
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
        width: 12px;
        height: 12px;
      }
      .aq-grp-status-unread-halo {
        display: none;
      }
      .aq-grp-status-unread-core {
        width: 5.5px;
        height: 5.5px;
        border-radius: 9999px;
        background: #3b82f6;
        opacity: 0.82;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-status-unread-core {
        background: #60a5fa;
      }
      @keyframes aqWaitingPulse {
        0%, 100% {
          opacity: 0.5;
        }
        50% {
          opacity: 1;
        }
      }
      .aq-grp-status-waiting {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 12px;
        height: 12px;
      }
      .aq-grp-status-waiting-halo {
        display: none;
      }
      .aq-grp-status-waiting-core {
        width: 5.5px;
        height: 5.5px;
        border-radius: 9999px;
        background: #d97706;
        animation: 1.6s ease-in-out infinite aqWaitingPulse;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-grp-status-waiting-core {
        background: #fbbf24;
      }
      .aq-grp-item-actions {
        display: none;
        align-items: center;
        gap: 1px;
        flex-shrink: 0;
      }
      body:not(.aq-conv-dragging) .aq-grp-item:hover .aq-grp-item-actions {
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
        max-width: 112px;
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

      #aq-grp-ctx-menu {
        position: fixed;
        z-index: 999999;
        min-width: 152px;
        max-width: 220px;
        padding: 4px;
        border-radius: 10px;
        background: var(--glass, #ffffff);
        border: 1px solid var(--border, rgba(24, 24, 27, 0.1));
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12), 0 1px 4px rgba(15, 23, 42, 0.06);
        font-size: 12.5px;
        color: var(--foreground, #18181b);
        display: none;
        user-select: none;
      }
      #aq-grp-ctx-menu.is-visible {
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) #aq-grp-ctx-menu {
        background: #1c1c22;
        border-color: rgba(255, 255, 255, 0.12);
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
        color: #f4f4f7;
      }
      .aq-ctx-item {
        appearance: none;
        width: 100%;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 12.5px;
        line-height: 1.3;
        padding: 6px 8px;
        border-radius: 6px;
        display: flex;
        align-items: center;
        gap: 7px;
        cursor: pointer;
        text-align: left;
      }
      .aq-ctx-item:hover {
        background: var(--sidebar-muted, rgba(24, 24, 27, 0.055));
      }
      .aq-ctx-item.is-danger {
        color: #dc2626;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-ctx-item.is-danger {
        color: #f87171;
      }
      .aq-ctx-sep {
        height: 1px;
        margin: 3px 6px;
        background: rgba(24, 24, 27, 0.075);
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-ctx-sep {
        background: rgba(255, 255, 255, 0.09);
      }

      /* Injected folder actions inside Antigravity native [role="menu"] */
      .aq-native-folder-entry {
        position: relative;
      }
      .aq-native-folder-entry .aq-nmf-count {
        font-size: 10.5px;
        font-weight: 600;
        padding: 0 5px;
        height: 16px;
        line-height: 16px;
        border-radius: 9999px;
        background: rgba(37, 99, 235, 0.12);
        color: #2563eb;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-native-folder-entry .aq-nmf-count {
        background: rgba(96, 165, 250, 0.2);
        color: #93c5fd;
      }
      .aq-native-folder-sub {
        position: absolute;
        left: calc(100% + 6px);
        top: -4px;
        z-index: 30;
        display: none;
        width: 224px;
        padding: 8px;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.98);
        color: #18181b;
        border: 1px solid rgba(0, 0, 0, 0.12);
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16);
        backdrop-filter: blur(20px) saturate(1.6);
        font-size: 12px;
        line-height: 1.4;
      }
      .aq-native-folder-sub.is-open {
        display: block;
      }
      .aq-native-folder-sub.is-left {
        left: auto;
        right: calc(100% + 6px);
      }
      .aq-native-folder-sub::before {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: -10px;
        width: 10px;
      }
      .aq-native-folder-sub.is-left::before {
        left: auto;
        right: -10px;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-native-folder-sub {
        background: rgba(24, 24, 27, 0.98);
        color: #f4f4f5;
        border-color: rgba(255, 255, 255, 0.14);
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
      }

      /* Sidebar 2-tab switcher (分组 | 项目) — borderless track with sliding white card pill */
      #aq-sidebar-tabs {
        position: relative;
        display: flex;
        align-items: center;
        flex-shrink: 0;
        margin: 6px 8px;
        padding: 0;
        height: 28px;
        background: transparent;
        user-select: none;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) #aq-sidebar-tabs {
        background: transparent;
      }
      .aq-row-grp-btn {
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
        transition: background-color 0.12s ease, color 0.12s ease;
      }
      .aq-row-grp-btn:hover,
      .aq-row-grp-btn[data-aq-menu-open="1"] {
        background: rgba(24, 24, 27, 0.08);
        color: var(--foreground, #18181b);
      }
      .aq-row-grp-btn.is-grouped {
        color: #2563eb;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-row-grp-btn:hover,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-row-grp-btn[data-aq-menu-open="1"] {
        background: rgba(255, 255, 255, 0.11);
        color: #f4f4f7;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-row-grp-btn.is-grouped {
        color: #60a5fa;
      }
      .agy-sidebar-row:has([data-aq-menu-open="1"]) .agy-row-actions {
        opacity: 1 !important;
      }
      #aq-sidebar-tabs::before {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 50%;
        box-sizing: border-box;
        border-radius: 8px;
        background: var(--background, #ffffff);
        border: 1px solid rgba(24, 24, 27, 0.075);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.025);
        transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
        pointer-events: none;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) #aq-sidebar-tabs::before {
        background: #19191f;
        border-color: rgba(255, 255, 255, 0.085);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
      }
      .bg-sidebar[data-aq-tab="projects"] #aq-sidebar-tabs::before {
        transform: translateX(100%);
      }
      .aq-st-tab {
        position: relative;
        z-index: 1;
        flex: 1;
        appearance: none;
        border: 0;
        background: transparent !important;
        box-shadow: none !important;
        color: var(--muted-foreground, #71717a);
        font: inherit;
        font-size: 12.5px;
        font-weight: 400;
        letter-spacing: -0.006em;
        height: 24px;
        border-radius: 6px;
        cursor: pointer;
        transition: color 160ms ease;
      }
      .aq-st-tab:hover {
        color: var(--foreground, #18181b);
      }
      .aq-st-tab.is-active {
        color: var(--foreground, #18181b);
        font-weight: 500;
      }
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-st-tab:hover,
      :is(body.dark, body.theme-dark, html.dark, html[data-theme="dark"], html[data-ag-theme-mode="dark"]) .aq-st-tab.is-active {
        color: #ffffff;
      }
      .bg-sidebar[data-aq-tab="groups"] #aq-conv-groups {
        flex: 1 1 0%;
        min-height: 0;
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
        transition: opacity 170ms cubic-bezier(0.22, 1, 0.36, 1), transform 170ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      .bg-sidebar[data-aq-tab="projects"] #aq-conv-groups {
        flex: 0 0 0px !important;
        height: 0 !important;
        min-height: 0 !important;
        max-height: 0 !important;
        padding-top: 0 !important;
        padding-bottom: 0 !important;
        margin: 0 !important;
        overflow: hidden !important;
        opacity: 0;
        transform: translateY(-4px);
        pointer-events: none;
        transition: opacity 140ms ease, transform 140ms ease;
      }
      .bg-sidebar[data-aq-tab="projects"] #aq-conv-groups + div {
        flex: 1 1 0% !important;
        min-height: 0 !important;
        padding: 2px 8px 6px !important;
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
        transition: opacity 170ms cubic-bezier(0.22, 1, 0.36, 1), transform 170ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      .bg-sidebar[data-aq-tab="groups"] #aq-conv-groups + div {
        flex: 0 0 0px !important;
        height: 0 !important;
        min-height: 0 !important;
        max-height: 0 !important;
        padding-top: 0 !important;
        padding-bottom: 0 !important;
        margin: 0 !important;
        overflow: hidden !important;
        opacity: 0;
        transform: translateY(4px);
        pointer-events: none;
        transition: opacity 140ms ease, transform 140ms ease;
      }
      .aq-pinned-add-folder-btn {
        margin-left: 4px;
        margin-right: auto;
        width: 20px;
        height: 20px;
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
      if (id === 'aq-acct-quota-tooltip') {
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
    const isLiveRunning = lineEl?.getAttribute('data-aq-turn-live') === '1';
    const totalLabel = turn.completed && !isLiveRunning ? cost.label || '本轮费用' : '实时估算';
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
          const title = formatCallDetailTitle(c, idx === 0 && Boolean(turn.completed) && !isLiveRunning);
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
        <span>累计 Token</span>
        <span class="aq-tt-val">${escapeHtml(formatTokenCount(turn.cumulativeTotalTokens))}</span>
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

  function resolveTurnUsageHost(turnEl) {
    if (!turnEl) return null;
    if (turnEl.matches?.('[data-turn-content]')) return turnEl;
    const turnContent = turnEl.querySelector?.('[data-turn-content]');
    if (turnContent) return turnContent;
    const contentAnchor =
      turnEl.querySelector?.('[data-testid="agent-response"]') ||
      turnEl.querySelector?.('[data-testid="user-message"]') ||
      turnEl.querySelector?.('[data-testid="agent-loading"]');
    if (contentAnchor?.parentElement && contentAnchor.parentElement !== turnEl) {
      return contentAnchor.parentElement;
    }
    const toolbar = turnEl.querySelector?.('[data-testid="cascade-system-message-toolbar"]');
    const toolbarContainer =
      toolbar?.parentElement && toolbar.parentElement !== turnEl ? toolbar.parentElement : toolbar;
    return toolbarContainer?.parentElement || contentAnchor || turnEl;
  }

  function resolveTurnToolbarChild(host) {
    const toolbar = host?.querySelector?.('[data-testid="cascade-system-message-toolbar"]');
    if (!toolbar) return null;
    let cur = toolbar;
    while (cur && cur.parentElement !== host) {
      cur = cur.parentElement;
    }
    return cur && cur.parentElement === host ? cur : null;
  }

  function isTurnLineAtExpectedSlot(host, line) {
    if (!host || !line || line.parentElement !== host) return false;
    const toolbarChild = resolveTurnToolbarChild(host);
    if (toolbarChild && toolbarChild === host.lastElementChild) {
      return line.nextElementSibling === toolbarChild;
    }
    return line === host.lastElementChild;
  }

  const ASYNC_CHILD_TOOL_NAMES = new Set([
    'invoke_subagent',
    'send_message',
    'swarm',
    'schedule',
    'run_workflow',
    'run_command',
  ]);

  function hasTurnAsyncChildCall(turnData) {
    const details = Array.isArray(turnData?.callDetails) ? turnData.callDetails : [];
    for (let i = 0; i < details.length; i++) {
      const calls = Array.isArray(details[i]?.toolCalls) ? details[i].toolCalls : [];
      for (let j = 0; j < calls.length; j++) {
        if (ASYNC_CHILD_TOOL_NAMES.has(String(calls[j]?.toolName || '').trim())) {
          return true;
        }
      }
    }
    return false;
  }

  function hasActiveConversationAsyncWork(cidLower) {
    if (!cidLower) return false;
    if (state.nonDaemonBgTaskCids.has(cidLower)) return true;
    const meta = state.trajMetaById[cidLower];
    return Boolean(
      meta &&
        !meta.killed &&
        (meta.subagentRunning || meta.subagentWaiting || meta.waiting || meta.bgTaskRunning)
    );
  }

  function getTurnConfirmedPeakMs(cidLower, turnIndex) {
    if (!cidLower || !Number.isInteger(turnIndex) || turnIndex < 0) return 0;
    return state.turnConfirmedPeakMsByKey.get(`${cidLower}:${turnIndex}`) || 0;
  }

  function recordTurnConfirmedPeakMs(cidLower, turnIndex, elapsedMs) {
    if (!cidLower || !Number.isInteger(turnIndex) || turnIndex < 0 || !(elapsedMs > 0)) return 0;
    const key = `${cidLower}:${turnIndex}`;
    const prev = state.turnConfirmedPeakMsByKey.get(key) || 0;
    const next = Math.max(prev, Math.round(elapsedMs));
    if (next !== prev) {
      if (!state.turnConfirmedPeakMsByKey.has(key) && state.turnConfirmedPeakMsByKey.size >= 32) {
        const oldestKey = state.turnConfirmedPeakMsByKey.keys().next().value;
        if (oldestKey) state.turnConfirmedPeakMsByKey.delete(oldestKey);
      }
      state.turnConfirmedPeakMsByKey.set(key, next);
    }
    return next;
  }

  function evaluateConversationLiveTurnContext(cid, turnEls, now = Date.now()) {
    const cleanCid = String(cid || '').trim();
    if (!cleanCid) {
      return {
        running: false,
        confirmed: false,
        waitingAsyncOnly: false,
        mountedTurnEl: null,
        lastTurnData: null,
      };
    }
    const cidLower = cleanCid.toLowerCase();
    const payload = state.turnsPayload;
    const hasSyncedTurns = Boolean(
      payload && payload.cascadeId === cleanCid && Array.isArray(payload.turns) && payload.turns.length > 0
    );
    const turns = hasSyncedTurns ? payload.turns : [];
    const lastTurnData = turns.length > 0 ? turns[turns.length - 1] : null;
    const turnKey = lastTurnData ? `${cidLower}:${lastTurnData.turnIndex}` : `${cidLower}:pending`;
    if (state.liveTurnKey !== turnKey) {
      state.liveTurnKey = turnKey;
      state.liveTurnMainIdleSince = 0;
      state.wasTurnLiveRunning = false;
    }

    const composerBusy = isActiveComposerBusy();
    const opt = state.optimisticRunningById.get(cidLower);
    const hasOptimistic = Boolean(opt && !opt.sawBackendRunning && now < opt.until);

    let mountedTurnEl = null;
    let hasLiveTurnDom = false;
    let hasToolbar = false;
    if (Array.isArray(turnEls) && turnEls.length > 0) {
      const candidateEl = turnEls[turnEls.length - 1];
      if (candidateEl) {
        const liveDom = Boolean(
          candidateEl.querySelector(
            '[data-testid="agent-loading"], [data-testid="ephemeral-tool-status"], [data-testid="tool-group-elapsed"]'
          )
        );
        const toolbar = Boolean(
          candidateEl.querySelector('[data-testid="cascade-system-message-toolbar"]')
        );
        const usageNode = candidateEl.querySelector('[data-aq-turn-usage]');
        const renderedIdx = usageNode
          ? Number.parseInt(usageNode.getAttribute('data-aq-turn-usage') || '', 10)
          : -1;
        let isStaleOrOffscreenDom = false;
        if (!liveDom) {
          if (toolbar && (!lastTurnData || Number(lastTurnData.calls || 0) === 0)) {
            isStaleOrOffscreenDom = true;
          } else if (hasSyncedTurns) {
            const offset = computeTurnPairingOffset(turnEls.length, turns.length);
            if (offset + turnEls.length - 1 !== turns.length - 1) {
              isStaleOrOffscreenDom = true;
            } else if (
              Number.isInteger(renderedIdx) &&
              renderedIdx >= 0 &&
              renderedIdx < Number(lastTurnData.turnIndex)
            ) {
              isStaleOrOffscreenDom = true;
            }
          }
        }
        if (!isStaleOrOffscreenDom) {
          mountedTurnEl = candidateEl;
          hasLiveTurnDom = liveDom;
          hasToolbar = toolbar;
        }
      }
    }

    const lastRecordedEndMs =
      lastTurnData && Number(lastTurnData.startTsMs) > 0
        ? Number(lastTurnData.startTsMs) + (Number(lastTurnData.wallDurationMs) || 0)
        : 0;
    const dbStepActive = Boolean(
      lastTurnData &&
        !lastTurnData.completed &&
        (!hasToolbar || (lastRecordedEndMs > 0 && now - lastRecordedEndMs < 120_000))
    );

    if (
      hasLiveTurnDom ||
      (!hasToolbar && (composerBusy || hasOptimistic)) ||
      dbStepActive
    ) {
      state.liveTurnMainIdleSince = 0;
      return {
        running: true,
        confirmed: true,
        waitingAsyncOnly: false,
        mountedTurnEl,
        lastTurnData,
      };
    }

    if (hasActiveConversationAsyncWork(cidLower)) {
      return {
        running: true,
        confirmed: true,
        waitingAsyncOnly: true,
        mountedTurnEl,
        lastTurnData,
      };
    }

    if (lastTurnData && hasTurnAsyncChildCall(lastTurnData)) {
      if (!state.liveTurnMainIdleSince) {
        if (state.wasTurnLiveRunning || (lastRecordedEndMs > 0 && now - lastRecordedEndMs < 5_000)) {
          state.liveTurnMainIdleSince = now;
          if (!document.hidden) {
            void refreshTrajectoryMetadata(false, 150);
          }
        }
      }
      if (
        state.liveTurnMainIdleSince > 0 &&
        state.trajFetchedAt < state.liveTurnMainIdleSince &&
        now - state.liveTurnMainIdleSince < 2_500
      ) {
        return {
          running: true,
          confirmed: false,
          waitingAsyncOnly: true,
          mountedTurnEl,
          lastTurnData,
        };
      }
    }

    return {
      running: false,
      confirmed: false,
      waitingAsyncOnly: false,
      mountedTurnEl,
      lastTurnData,
    };
  }

  function stopLiveTurnTimer() {
    if (state.liveTurnTimer) {
      clearInterval(state.liveTurnTimer);
      state.liveTurnTimer = null;
    }
  }

  function tickLiveTurnUsageLine() {
    const cid = extractCascadeId();
    const payload = state.turnsPayload;
    const turns = Array.isArray(payload?.turns) ? payload.turns : [];
    if (!cid || !payload || payload.cascadeId !== cid || turns.length === 0) {
      stopLiveTurnTimer();
      return;
    }
    const turnEls = findTurnRows();
    const now = Date.now();
    const liveCtx = evaluateConversationLiveTurnContext(cid, turnEls, now);
    if (liveCtx.waitingAsyncOnly && !document.hidden && now - state.trajFetchedAt >= 4_000) {
      void refreshTrajectoryMetadata(false, 3_500);
    }
    if (!liveCtx.running) {
      stopLiveTurnTimer();
      scheduleRender({ turns: true });
      return;
    }
    const cidLower = cid.toLowerCase();
    const lastTurnData = liveCtx.lastTurnData;
    let peakMs = lastTurnData ? getTurnConfirmedPeakMs(cidLower, lastTurnData.turnIndex) : 0;
    if (
      liveCtx.confirmed &&
      lastTurnData &&
      Number(lastTurnData.startTsMs) > 0 &&
      now > Number(lastTurnData.startTsMs)
    ) {
      peakMs = recordTurnConfirmedPeakMs(
        cidLower,
        lastTurnData.turnIndex,
        now - Number(lastTurnData.startTsMs)
      );
    }
    if (!liveCtx.mountedTurnEl || !lastTurnData) {
      stopLiveTurnTimer();
      return;
    }
    const line = liveCtx.mountedTurnEl.querySelector('[data-aq-turn-usage]');
    if (!line) {
      scheduleRender({ turns: true });
      return;
    }
    if (line.getAttribute('data-aq-turn-live') !== '1') {
      line.setAttribute('data-aq-turn-live', '1');
    }
    const summary = formatTurnSummary(lastTurnData, {
      liveRunning: true,
      nowMs: now,
      minWallDurationMs: peakMs,
    });
    if (line.textContent !== summary) {
      line.textContent = summary;
    }
  }

  function syncLiveTurnTimer(shouldRun) {
    if (!shouldRun || document.hidden || state.disposed) {
      stopLiveTurnTimer();
      return;
    }
    if (state.liveTurnTimer) return;
    state.liveTurnTimer = setInterval(() => {
      if (state.disposed || document.hidden) {
        stopLiveTurnTimer();
        return;
      }
      tickLiveTurnUsageLine();
    }, 1000);
  }

  function mountTurnLine(
    turnEl,
    turnData,
    { liveRunning = false, nowMs = 0, minWallDurationMs = 0 } = {}
  ) {
    const host = resolveTurnUsageHost(turnEl);
    if (!host) return null;

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
    const wasLive = line.getAttribute('data-aq-turn-live') === '1';
    if (liveRunning) {
      if (!wasLive) line.setAttribute('data-aq-turn-live', '1');
    } else if (wasLive) {
      line.removeAttribute('data-aq-turn-live');
    }

    const toolbarChild = resolveTurnToolbarChild(host);
    if (toolbarChild && toolbarChild === host.lastElementChild) {
      if (line.parentElement !== host || line.nextElementSibling !== toolbarChild) {
        host.insertBefore(line, toolbarChild);
      }
    } else if (line.parentElement !== host || line !== host.lastElementChild) {
      // Keep the live metrics row at the bottom below any active Working indicator until the toolbar mounts last
      host.appendChild(line);
    }

    line.__aqTurnData = turnData;
    line.__aqRenderedTurnRef = turnData;
    const summary = formatTurnSummary(turnData, {
      liveRunning,
      nowMs,
      minWallDurationMs,
    });
    if (line.textContent !== summary) {
      line.textContent = summary;
    }
    if (
      wasLive !== liveRunning &&
      state.turnTooltipAnchor === line &&
      document.getElementById('aq-turn-tooltip')?.getAttribute('data-visible') === '1'
    ) {
      showTurnTooltip(line);
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

  function renderTurnUsageLines(sharedCid, sharedTurnEls, sharedLiveCtx) {
    const payload = state.turnsPayload;
    const currentId = sharedCid !== undefined ? sharedCid : extractCascadeId();
    const turns = Array.isArray(payload?.turns) ? payload.turns : [];
    if (!currentId || !payload || payload.cascadeId !== currentId || turns.length === 0) {
      stopLiveTurnTimer();
      document.querySelectorAll('[data-aq-turn-usage]').forEach((el) => el.remove());
      return;
    }

    const turnEls = Array.isArray(sharedTurnEls) ? sharedTurnEls : findTurnRows();
    if (turnEls.length === 0) {
      stopLiveTurnTimer();
      return;
    }

    const now = Date.now();
    const cidLower = currentId.toLowerCase();
    const liveCtx = sharedLiveCtx || evaluateConversationLiveTurnContext(currentId, turnEls, now);
    if (
      liveCtx.running &&
      liveCtx.confirmed &&
      liveCtx.lastTurnData &&
      Number(liveCtx.lastTurnData.startTsMs) > 0 &&
      now > Number(liveCtx.lastTurnData.startTsMs)
    ) {
      recordTurnConfirmedPeakMs(
        cidLower,
        liveCtx.lastTurnData.turnIndex,
        now - Number(liveCtx.lastTurnData.startTsMs)
      );
    }
    if (state.wasTurnLiveRunning && !liveCtx.running && !document.hidden) {
      scheduleQuotaForceRefresh(1500);
    }
    state.wasTurnLiveRunning = liveCtx.running;

    const offset = computeTurnPairingOffset(turnEls.length, turns.length);
    const activeLines = new Set();
    let mountedLatestLive = false;

    for (let i = 0; i < turnEls.length; i++) {
      const turnEl = turnEls[i];
      const turnData = turns[offset + i] || null;
      const isLatestTurn =
        i === turnEls.length - 1 &&
        offset + i === turns.length - 1 &&
        turnEl === liveCtx.mountedTurnEl;
      const liveRunning = Boolean(isLatestTurn && turnData && liveCtx.running);
      if (liveRunning) mountedLatestLive = true;
      const minWallDurationMs = turnData ? getTurnConfirmedPeakMs(cidLower, turnData.turnIndex) : 0;

      const effectiveCompleted = liveRunning ? false : Boolean(turnData?.completed);
      if (turnData && (turnData.totalTokens > 0 || !effectiveCompleted || payload.hasData)) {
        if (!payload.hasData && effectiveCompleted && turnData.totalTokens <= 0) {
          turnEl.querySelectorAll('[data-aq-turn-usage]').forEach((el) => el.remove());
          continue;
        }
        const fastExisting = turnEl.querySelector('[data-aq-turn-usage]');
        const fastHost = resolveTurnUsageHost(turnEl);
        if (
          effectiveCompleted &&
          minWallDurationMs <= (Number(turnData.wallDurationMs) || 0) &&
          fastExisting &&
          fastExisting.getAttribute('data-aq-turn-live') !== '1' &&
          fastExisting.__aqRenderedTurnRef === turnData &&
          fastExisting.getAttribute('data-aq-turn-usage') === String(turnData.turnIndex) &&
          fastHost &&
          isTurnLineAtExpectedSlot(fastHost, fastExisting)
        ) {
          activeLines.add(fastExisting);
          continue;
        }
        activeLines.add(
          mountTurnLine(turnEl, turnData, {
            liveRunning,
            nowMs: now,
            minWallDurationMs,
          })
        );
      } else {
        turnEl.querySelectorAll('[data-aq-turn-usage]').forEach((el) => el.remove());
      }
    }
    document.querySelectorAll('[data-aq-turn-usage]').forEach((el) => {
      if (!activeLines.has(el)) el.remove();
    });
    syncLiveTurnTimer(mountedLatestLive);
  }

  const THINKING_SOURCE_OPTIONS = [
    { id: 'auto', label: 'auto' },
    { id: 'ai-brief', label: 'AI 简述' },
    { id: 'ai-translate', label: 'AI 翻译' },
    { id: 'google', label: 'Google 翻译' },
    { id: 'deepl', label: 'DeepL 翻译' },
    { id: 'bing', label: 'Bing 翻译' },
    { id: 'youdao', label: '有道翻译' },
  ];
  const LEGACY_CLIENT_THINKING_SOURCES = {
    'easydict-ai-brief': 'ai-brief',
    'easydict-builtin-ai': 'ai-translate',
    'easydict-google': 'google',
    'web-google': 'google',
    'easydict-deepl': 'deepl',
    'easydict-bing': 'bing',
    'easydict-youdao': 'youdao',
  };
  const THINKING_SOURCE_IDS = new Set(THINKING_SOURCE_OPTIONS.map((o) => o.id));

  function sanitizeClientThinkingSource(raw) {
    const clean = String(raw || '').trim().toLowerCase();
    const mapped = LEGACY_CLIENT_THINKING_SOURCES[clean] || clean;
    return THINKING_SOURCE_IDS.has(mapped) ? mapped : 'auto';
  }

  // ---- Running Turn Native Thinking Translate Button & Card ----

  const THINKING_AUTO_POLL_MS = 2200;

  function fastTextSig(str) {
    let h1 = 0x811c9dc5;
    let h2 = 5381;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = (Math.imul(h2, 33) ^ c) | 0;
    }
    return `${str.length}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
  }

  function saveClientThinkingSourcePref(nextSource, { notifyDaemon = true } = {}) {
    const clean = sanitizeClientThinkingSource(nextSource);
    state.thinkingSourcePref = clean;
    try {
      if (clean === 'auto') {
        localStorage.removeItem('aq_thinking_source_v1');
      } else {
        localStorage.setItem('aq_thinking_source_v1', clean);
      }
    } catch {}
    if (notifyDaemon) {
      sendUiPrefsAction({ type: 'set-thinking-source', source: clean });
    }
    return clean;
  }

  function stopThinkingAutoTimers() {
    if (state.thinkingAutoTimer) {
      clearInterval(state.thinkingAutoTimer);
      state.thinkingAutoTimer = null;
    }
  }

  function clearHostMarkOnElement(el) {
    if (!el) return;
    el.removeAttribute('data-aq-thinking-host');
    el.removeAttribute('data-aq-thinking-inline');
  }

  function closeThinkingTranslateCard({ notifyDaemon = true } = {}) {
    const ts = state.thinkingTranslate;
    stopThinkingAutoTimers();
    ts.open = false;
    ts.loading = false;
    ts.switchingSource = false;
    ts.showOriginal = false;
    ts.requestId = '';
    ts.lastUploadedClientSig = '';
    ts.hasOriginal = false;
    ts.sourceText = '';
    ts.translatedText = '';
    ts.translatedSourceText = '';
    ts.activeSourcePref = '';
    ts.providerLabel = '';
    ts.error = '';
    ts.errorRetryAfter = 0;
    ts.empty = false;
    if (ts.cardEl) {
      ts.cardEl.remove();
      ts.cardEl = null;
    }
    ts.cardParts = null;
    if (notifyDaemon && typeof window.__aqThinkingAction === 'function') {
      try {
        window.__aqThinkingAction(JSON.stringify({ type: 'close' }));
      } catch {}
    }
    syncThinkingHelperDomContent();
  }

  function detachThinkingHelperDom() {
    const ts = state.thinkingTranslate;
    if (ts.btnEl) ts.btnEl.remove();
    if (ts.cardEl) ts.cardEl.remove();
    clearHostMarkOnElement(ts.hostEl);
    ts.hostEl = null;
  }

  function resetThinkingTranslateState() {
    const ts = state.thinkingTranslate;
    const wasOpen = ts.open;
    stopThinkingAutoTimers();
    if (ts.btnEl) {
      ts.btnEl.remove();
      ts.btnEl = null;
    }
    if (ts.cardEl) {
      ts.cardEl.remove();
      ts.cardEl = null;
    }
    clearHostMarkOnElement(ts.hostEl);
    ts.cardParts = null;
    ts.hostEl = null;
    ts.cascadeId = '';
    ts.turnKey = '';
    ts.requestId = '';
    ts.open = false;
    ts.loading = false;
    ts.switchingSource = false;
    ts.showOriginal = false;
    ts.stepIdx = -1;
    ts.thinkingCount = 0;
    ts.lastUploadedClientSig = '';
    ts.hasOriginal = false;
    ts.sourceText = '';
    ts.translatedText = '';
    ts.translatedSourceText = '';
    ts.activeSourcePref = '';
    ts.providerLabel = '';
    ts.error = '';
    ts.errorRetryAfter = 0;
    ts.empty = false;
    if (wasOpen && typeof window.__aqThinkingAction === 'function') {
      try {
        window.__aqThinkingAction(JSON.stringify({ type: 'close' }));
      } catch {}
    }
    document.querySelectorAll('[data-aq-thinking-btn], [data-aq-thinking-card]').forEach((el) => el.remove());
    document
      .querySelectorAll('[data-aq-thinking-host], [data-aq-thinking-inline]')
      .forEach((el) => clearHostMarkOnElement(el));
  }

  function isCompactThinkingDiv(el) {
    if (!el || el.tagName !== 'DIV' || el.hasAttribute('data-testid') || el.hasAttribute('data-step-index')) {
      return false;
    }
    if (el.parentElement && !el.parentElement.hasAttribute('data-step-rows')) return false;
    if (el.querySelector('button:not([data-aq-thinking-btn]):not(.aq-think-card-act)')) return false;
    const cls = String(el.className || '');
    if (!cls.includes('tabular-nums') || !cls.includes('select-none')) return false;
    const firstChild = el.firstElementChild;
    const text = String((firstChild && !firstChild.hasAttribute('data-aq-thinking-btn') ? firstChild.textContent : el.textContent) || '').trim();
    return /^(?:Thinking|思考)/i.test(text);
  }

  function resolveButtonAnchor(btn) {
    const parent = btn?.parentElement;
    if (!parent) return null;
    const pCls = String(parent.className || '');
    if (pCls.includes('flex') && !pCls.includes('flex-col')) {
      return { mode: 'inline', host: parent, triggerBtn: null };
    }
    return { mode: 'collapsible', host: parent, triggerBtn: btn };
  }

  function findRunningThinkingAnchor(turnEl) {
    if (!turnEl) return null;
    const candidates = turnEl.querySelectorAll(
      'button[data-testid="thinking-collapsible-trigger"], button[data-testid="tool-group-collapsible"], [data-testid="ephemeral-tool-status"], [data-step-rows] > div'
    );
    let picked = null;
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (el.tagName === 'BUTTON') {
        if (el.classList.contains('hidden')) continue;
        const resolved = resolveButtonAnchor(el);
        if (resolved) picked = resolved;
      } else if (el.getAttribute('data-testid') === 'ephemeral-tool-status' || isCompactThinkingDiv(el)) {
        picked = { mode: 'inline', host: el, triggerBtn: null };
      }
    }
    if (picked) return picked;

    const workedBtns = turnEl.querySelectorAll('button[data-testid="worked-for-collapsible"]');
    for (let i = workedBtns.length - 1; i >= 0; i--) {
      const btn = workedBtns[i];
      if (!btn.classList.contains('hidden')) {
        const resolved = resolveButtonAnchor(btn);
        if (resolved) return resolved;
      }
    }

    const loadingEl = turnEl.querySelector('[data-testid="agent-loading"]');
    if (loadingEl) {
      return { mode: 'inline', host: loadingEl, triggerBtn: null };
    }
    return null;
  }

  function extractLiveTurnThinkingFromPage(turnEl) {
    if (!turnEl) return null;
    let latestText = '';
    let latestStepIdx = -1;
    const seenSteps = new Set();
    const stepTexts = new Set();
    const seenStepArrays = new Set();
    const standaloneFibers = new Set();

    const inspectStep = (s) => {
      if (s?.step?.case !== 'plannerResponse') return;
      const val = s.step.value;
      const txt = String(val?.rawThinking || val?.thinking || '').trim();
      if (!txt) return;
      stepTexts.add(txt);
      const rawIdx = Number(s?.metadata?.sourceTrajectoryStepInfo?.stepIndex);
      const hasIdx = Number.isInteger(rawIdx) && rawIdx >= 0;
      seenSteps.add(hasIdx ? `i:${rawIdx}` : s);
      if (hasIdx) {
        if (rawIdx >= latestStepIdx) {
          latestStepIdx = rawIdx;
          latestText = txt;
        }
      } else {
        latestText = txt;
        latestStepIdx = -1;
      }
    };

    try {
      const probeNodes = turnEl.querySelectorAll(
        '[data-step-rows], [data-testid="thinking-collapsible-trigger"], [data-testid="tool-group-collapsible"], [data-testid="worked-for-collapsible"], [data-testid="ephemeral-tool-status"]'
      );

      for (let i = 0; i < probeNodes.length; i++) {
        let cur = getReactFiberFromElement(probeNodes[i]);
        let guard = 0;
        let belongsToStepArray = false;
        let standaloneMatch = null;

        while (cur && guard++ < 28) {
          if (cur.stateNode === turnEl) break;
          const props = cur.memoizedProps;
          if (props && typeof props === 'object') {
            const stepArr = Array.isArray(props.segment?.steps)
              ? props.segment.steps
              : Array.isArray(props.steps)
                ? props.steps
                : null;
            if (stepArr) {
              belongsToStepArray = true;
              if (!seenStepArrays.has(stepArr)) {
                seenStepArrays.add(stepArr);
                for (let j = 0; j < stepArr.length; j++) inspectStep(stepArr[j]);
              }
            } else if (!standaloneMatch && typeof props.thinking === 'string' && props.thinking.trim()) {
              const rawIdx = Number(props.metadata?.sourceTrajectoryStepInfo?.stepIndex);
              standaloneMatch = {
                fiber: cur,
                text: props.thinking.trim(),
                stepIdx: Number.isInteger(rawIdx) && rawIdx >= 0 ? rawIdx : -1,
              };
            }
          }
          cur = cur.return;
        }

        if (standaloneMatch && (!belongsToStepArray || !stepTexts.has(standaloneMatch.text))) {
          if (standaloneMatch.stepIdx >= 0) {
            seenSteps.add(`i:${standaloneMatch.stepIdx}`);
            if (standaloneMatch.stepIdx >= latestStepIdx) {
              latestStepIdx = standaloneMatch.stepIdx;
              latestText = standaloneMatch.text;
            }
          } else {
            standaloneFibers.add(standaloneMatch.fiber);
            latestText = standaloneMatch.text;
            latestStepIdx = -1;
          }
        }
      }
    } catch {}

    let totalCount = seenSteps.size + standaloneFibers.size;
    if (!latestText) {
      const domEditors = turnEl.querySelectorAll(
        '[data-testid="thinking-collapsible-trigger"] ~ div .cursor-edit'
      );
      if (domEditors.length > 0) {
        const txt = String(domEditors[domEditors.length - 1].textContent || '').trim();
        if (txt) {
          latestText = txt;
          latestStepIdx = -1;
          totalCount = Math.max(totalCount, domEditors.length);
        }
      }
    }

    if (!latestText) return null;
    return {
      text: latestText,
      thinkingCount: Math.max(1, totalCount),
      stepIdx: latestStepIdx,
    };
  }

  function formatThinkingDisplayHtml(raw) {
    const paragraphs = String(raw || '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (paragraphs.length === 0) return '';
    return paragraphs
      .map((para) => {
        const escaped = escapeHtml(para).replace(
          /`([^`\n]{1,120})`/g,
          '<code class="aq-think-code">$1</code>'
        );
        return `<div class="aq-think-para">${escaped}</div>`;
      })
      .join('');
  }

  function ensureThinkingCardParts() {
    const ts = state.thinkingTranslate;
    if (ts.cardEl && ts.cardParts) return ts.cardParts;

    const card = document.createElement('div');
    card.setAttribute('data-aq-thinking-card', '1');

    const hdr = document.createElement('div');
    hdr.className = 'aq-think-card-hdr';

    const metaWrap = document.createElement('span');
    metaWrap.className = 'aq-think-card-meta-wrap';
    const liveDot = document.createElement('span');
    liveDot.className = 'aq-think-live-dot';
    liveDot.title = '展开期间自动同步最新思维链';
    const hdrSpinner = document.createElement('span');
    hdrSpinner.className = 'aq-think-hdr-spinner';
    hdrSpinner.setAttribute('aria-hidden', 'true');
    hdrSpinner.hidden = true;
    const metaText = document.createElement('span');
    metaText.className = 'aq-think-card-meta';
    metaWrap.append(liveDot, hdrSpinner, metaText);

    const actions = document.createElement('span');
    actions.className = 'aq-think-card-actions';

    const selectEl = document.createElement('select');
    selectEl.className = 'aq-think-src-select';
    selectEl.setAttribute('data-aq-think-src', '1');
    selectEl.title = '选择翻译来源';
    selectEl.setAttribute('aria-label', '选择翻译来源');
    for (let i = 0; i < THINKING_SOURCE_OPTIONS.length; i++) {
      const opt = document.createElement('option');
      opt.value = THINKING_SOURCE_OPTIONS[i].id;
      opt.textContent = THINKING_SOURCE_OPTIONS[i].label;
      selectEl.appendChild(opt);
    }
    selectEl.addEventListener('click', (ev) => ev.stopPropagation());
    selectEl.addEventListener('change', (ev) => {
      ev.stopPropagation();
      const nextSrc = saveClientThinkingSourcePref(selectEl.value, { notifyDaemon: true });
      ts.showOriginal = false;
      ts.translatedSourceText = '';
      ts.switchingSource = true;
      triggerLatestThinkingTranslate({ force: true, explicitSource: nextSrc });
    });

    const origBtn = document.createElement('button');
    origBtn.type = 'button';
    origBtn.className = 'aq-think-card-act';
    origBtn.setAttribute('data-aq-think-act', 'toggle-orig');

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'aq-think-card-act';
    closeBtn.setAttribute('data-aq-think-act', 'close');
    closeBtn.title = '收起';
    closeBtn.setAttribute('aria-label', '收起');
    closeBtn.textContent = '×';

    actions.append(selectEl, origBtn, closeBtn);
    hdr.append(metaWrap, actions);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'aq-think-card-body';

    card.append(hdr, bodyEl);
    card.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const actBtn = ev.target?.closest?.('[data-aq-think-act]');
      if (!actBtn) return;
      ev.preventDefault();
      const act = actBtn.getAttribute('data-aq-think-act');
      if (act === 'close') {
        closeThinkingTranslateCard();
      } else if (act === 'toggle-orig') {
        ts.showOriginal = !ts.showOriginal;
        if (ts.showOriginal) {
          if (!ts.sourceText) {
            triggerLatestThinkingTranslate({ force: true });
          } else {
            syncThinkingHelperDomContent();
          }
        } else {
          const curPref = sanitizeClientThinkingSource(state.thinkingSourcePref);
          const needsRetranslate =
            !ts.translatedText ||
            ts.translatedSourceText !== ts.sourceText ||
            ts.activeSourcePref !== curPref;
          if (needsRetranslate) {
            if (ts.translatedText) ts.switchingSource = true;
            triggerLatestThinkingTranslate({ force: true });
          } else {
            syncThinkingHelperDomContent();
          }
        }
      }
    });

    ts.cardEl = card;
    ts.cardParts = { card, liveDot, hdrSpinner, metaText, selectEl, origBtn, bodyEl };
    return ts.cardParts;
  }

  function syncThinkingHelperDomContent() {
    const ts = state.thinkingTranslate;
    const btn = ts.btnEl;
    const showPrimarySpinner =
      ts.loading && (ts.showOriginal ? !ts.sourceText : !ts.translatedText || ts.switchingSource);
    if (btn) {
      if (showPrimarySpinner) {
        btn.setAttribute('data-loading', '1');
      } else {
        btn.removeAttribute('data-loading');
      }
      if (ts.open) {
        btn.setAttribute('data-active', '1');
      } else {
        btn.removeAttribute('data-active');
      }
      const tipLabel = ts.open ? '收起实时思维链' : '查看实时思维链';
      btn.title = tipLabel;
      btn.setAttribute('aria-label', tipLabel);
      const nextBtnHtml = showPrimarySpinner
        ? '<span class="aq-think-spinner" aria-hidden="true"></span>'
        : '<svg class="aq-think-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.1 3.8l1.15 3.35 3.35 1.15-3.35 1.15L7.1 12.8 5.95 9.45 2.6 8.3l3.35-1.15L7.1 3.8Z"/><path d="M12.5 2.9l.45 1.35 1.35.45-1.35.45-.45 1.35-.45-1.35-1.35-.45 1.35-.45.45-1.35Z"/></svg>';
      if (btn.__aqHtml !== nextBtnHtml) {
        btn.innerHTML = nextBtnHtml;
        btn.__aqHtml = nextBtnHtml;
      }
    }

    if (!ts.open) {
      if (ts.cardEl) {
        ts.cardEl.remove();
      }
      return;
    }

    const parts = ensureThinkingCardParts();
    const curSource = sanitizeClientThinkingSource(state.thinkingSourcePref);
    if (document.activeElement !== parts.selectEl && parts.selectEl.value !== curSource) {
      parts.selectEl.value = curSource;
    }

    const showHdrSpinner = showPrimarySpinner;
    parts.liveDot.hidden = showHdrSpinner;
    parts.hdrSpinner.hidden = !showHdrSpinner;
    if (ts.loading && !showHdrSpinner) {
      parts.liveDot.setAttribute('data-syncing', '1');
    } else {
      parts.liveDot.removeAttribute('data-syncing');
    }

    const metaParts = ['实时思维链'];
    if (ts.thinkingCount > 0) metaParts.push(`第 ${ts.thinkingCount} 条`);
    if (ts.switchingSource && ts.loading) {
      metaParts.push('切换翻译中…');
    } else if (ts.showOriginal) {
      metaParts.push('原文');
    } else if (ts.error && !ts.empty) {
      metaParts.push('请求异常');
    } else if (ts.providerLabel) {
      metaParts.push(ts.providerLabel);
    } else if (ts.loading) {
      metaParts.push('同步中…');
    }
    const nextMeta = metaParts.join(' · ');
    if (parts.metaText.textContent !== nextMeta) {
      parts.metaText.textContent = nextMeta;
    }

    const canToggleOrig = Boolean(
      ts.hasOriginal ||
        (ts.sourceText && ts.sourceText !== ts.translatedText) ||
        (ts.showOriginal && ts.sourceText)
    );
    parts.origBtn.hidden = !canToggleOrig;
    if (canToggleOrig) {
      const isBrief =
        String(ts.providerLabel || '').startsWith('AI 简述') || curSource === 'ai-brief';
      const nextOrigLabel = ts.showOriginal ? (isBrief ? '看简述' : '看译文') : '看原文';
      if (parts.origBtn.textContent !== nextOrigLabel) {
        parts.origBtn.textContent = nextOrigLabel;
      }
    }

    let bodyText = '';
    let isMuted = false;
    let isError = false;
    if (ts.showOriginal) {
      bodyText = ts.sourceText || '正在获取实时思考原文…';
      isMuted = !ts.sourceText;
    } else if (ts.error && !ts.empty) {
      bodyText = ts.error;
      isError = true;
    } else if (ts.translatedText) {
      bodyText = ts.translatedText;
    } else if (ts.empty) {
      bodyText = ts.error || '当前轮次暂未生成思考内容，生成后将自动刷新显示';
      isMuted = true;
    } else {
      bodyText = '正在获取实时思维链…';
      isMuted = true;
    }

    if (isMuted) parts.bodyEl.setAttribute('data-muted', '1');
    else parts.bodyEl.removeAttribute('data-muted');
    if (isError) parts.bodyEl.setAttribute('data-error', '1');
    else parts.bodyEl.removeAttribute('data-error');
    if (ts.switchingSource && ts.loading) parts.bodyEl.setAttribute('data-switching', '1');
    else parts.bodyEl.removeAttribute('data-switching');

    const rawBodyKey = `${isMuted ? 1 : 0}|${isError ? 1 : 0}|${bodyText}`;
    if (parts.bodyEl.__aqRawKey !== rawBodyKey) {
      parts.bodyEl.__aqRawKey = rawBodyKey;
      parts.bodyEl.innerHTML = formatThinkingDisplayHtml(bodyText);
    }
  }

  function ensureThinkingAutoRefreshTimer() {
    if (state.thinkingAutoTimer || state.disposed) return;
    state.thinkingAutoTimer = setInterval(() => {
      if (state.disposed || !state.thinkingTranslate.open) {
        stopThinkingAutoTimers();
        return;
      }
      if (!document.hidden) {
        triggerLatestThinkingTranslate({ force: false });
      }
    }, THINKING_AUTO_POLL_MS);
  }

  function resolveActiveRunningTurnKey(cid) {
    const payload = state.turnsPayload;
    if (payload && payload.cascadeId === cid && Array.isArray(payload.turns) && payload.turns.length > 0) {
      const last = payload.turns[payload.turns.length - 1];
      return `${cid}:t${Number(last?.turnIndex ?? payload.turns.length - 1)}`;
    }
    return '';
  }

  function triggerLatestThinkingTranslate({ force = false, explicitSource = '' } = {}) {
    const cid = extractCascadeId();
    const turnEls = findTurnRows();
    const liveCtx = evaluateConversationLiveTurnContext(cid, turnEls);
    const mountedTurnEl = liveCtx.mountedTurnEl;
    const ts = state.thinkingTranslate;
    if (!liveCtx.running || (ts.cascadeId && ts.cascadeId !== cid)) {
      if (ts.cascadeId && ts.cascadeId !== cid) {
        resetThinkingTranslateState();
      }
      if (!liveCtx.running) {
        resetThinkingTranslateState();
        return;
      }
    }
    if (!mountedTurnEl && !ts.open && !force) return;
    if (typeof window.__aqThinkingAction !== 'function') return;
    if (ts.loading && !force) return;
    const onlyOriginal = Boolean(ts.showOriginal && !explicitSource);
    if (!force && !onlyOriginal && ts.error && !ts.empty && Date.now() < ts.errorRetryAfter) return;

    const sourcePref = sanitizeClientThinkingSource(explicitSource || state.thinkingSourcePref);
    ts.cascadeId = cid;
    ts.open = true;
    ensureThinkingAutoRefreshTimer();

    let clientPayload = null;
    if (mountedTurnEl) {
      const liveThinking = extractLiveTurnThinkingFromPage(mountedTurnEl);
      if (liveThinking && liveThinking.text) {
        const sig = fastTextSig(liveThinking.text);
        if (sig === ts.lastUploadedClientSig) {
          clientPayload = {
            sameSig: sig,
            stepIdx: liveThinking.stepIdx,
            thinkingCount: liveThinking.thinkingCount,
          };
        } else {
          ts.lastUploadedClientSig = sig;
          clientPayload = {
            sig,
            text: liveThinking.text,
            stepIdx: liveThinking.stepIdx,
            thinkingCount: liveThinking.thinkingCount,
          };
        }
      }
    }

    state.thinkingReqSeq += 1;
    const reqId = `th-${Date.now()}-${state.thinkingReqSeq}`;
    ts.requestId = reqId;
    ts.loading = true;
    if (force) {
      ts.error = '';
    }

    renderRunningThinkingHelper(cid, turnEls, liveCtx);

    try {
      window.__aqThinkingAction(
        JSON.stringify({
          type: 'translate',
          requestId: reqId,
          cascadeId: cid,
          source: sourcePref,
          force: Boolean(force),
          onlyOriginal,
          clientThinking: clientPayload,
        })
      );
    } catch (err) {
      ts.loading = false;
      ts.switchingSource = false;
      ts.error = String(err?.message || '发送翻译请求失败');
      syncThinkingHelperDomContent();
    }
  }

  function renderRunningThinkingHelper(sharedCid, sharedTurnEls, sharedLiveCtx) {
    const ts = state.thinkingTranslate;
    const cid = sharedCid !== undefined ? sharedCid : extractCascadeId();
    if (!cid) {
      if (ts.btnEl || ts.cardEl || ts.open || ts.hostEl) {
        resetThinkingTranslateState();
      }
      return;
    }

    if (ts.cascadeId && ts.cascadeId !== cid) {
      resetThinkingTranslateState();
    }

    const turnEls = Array.isArray(sharedTurnEls) ? sharedTurnEls : findTurnRows();
    const liveCtx = sharedLiveCtx || evaluateConversationLiveTurnContext(cid, turnEls);
    const mountedTurnEl = liveCtx.mountedTurnEl;
    if (!liveCtx.running) {
      if (ts.btnEl || ts.cardEl || ts.open || ts.hostEl) {
        resetThinkingTranslateState();
      }
      return;
    }

    const nextTurnKey = resolveActiveRunningTurnKey(cid);
    if (ts.turnKey && nextTurnKey && ts.turnKey !== nextTurnKey) {
      resetThinkingTranslateState();
    }
    ts.cascadeId = cid;
    if (nextTurnKey) ts.turnKey = nextTurnKey;

    if (!mountedTurnEl) {
      if (ts.hostEl || ts.btnEl?.parentElement || ts.cardEl?.parentElement) {
        detachThinkingHelperDom();
      }
      return;
    }

    const anchor = findRunningThinkingAnchor(mountedTurnEl);
    if (!anchor || !anchor.host) {
      if (ts.hostEl || ts.btnEl?.parentElement || ts.cardEl?.parentElement) {
        detachThinkingHelperDom();
      }
      return;
    }

    const { mode, host, triggerBtn } = anchor;
    const wasCardDetached = Boolean(ts.open && (!ts.cardEl || !ts.cardEl.parentElement));
    if (ts.hostEl && ts.hostEl !== host) {
      clearHostMarkOnElement(ts.hostEl);
    }
    if (mode === 'collapsible') {
      host.removeAttribute('data-aq-thinking-inline');
      if (host.getAttribute('data-aq-thinking-host') !== '1') {
        host.setAttribute('data-aq-thinking-host', '1');
      }
    } else {
      host.removeAttribute('data-aq-thinking-host');
      if (host.getAttribute('data-aq-thinking-inline') !== '1') {
        host.setAttribute('data-aq-thinking-inline', '1');
      }
    }
    ts.hostEl = host;

    let btn = ts.btnEl;
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-aq-thinking-btn', '1');
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (state.thinkingTranslate.open) {
          closeThinkingTranslateCard();
        } else {
          triggerLatestThinkingTranslate({ force: true });
        }
      });
      ts.btnEl = btn;
    }

    syncThinkingHelperDomContent();

    if (mode === 'collapsible' && triggerBtn && triggerBtn.parentElement === host) {
      if (btn.parentElement !== host || triggerBtn.nextSibling !== btn) {
        host.insertBefore(btn, triggerBtn.nextSibling);
      }
      if (ts.open && ts.cardEl) {
        if (ts.cardEl.parentElement !== host || btn.nextSibling !== ts.cardEl) {
          host.insertBefore(ts.cardEl, btn.nextSibling);
        }
      }
    } else {
      const targetAfterBtn = ts.open && ts.cardEl ? ts.cardEl : null;
      if (btn.parentElement !== host || (targetAfterBtn ? btn.nextSibling !== targetAfterBtn : btn !== host.lastElementChild)) {
        host.appendChild(btn);
      }
      if (ts.open && ts.cardEl) {
        if (ts.cardEl.parentElement !== host || ts.cardEl !== host.lastElementChild) {
          host.appendChild(ts.cardEl);
        }
      }
    }

    if (wasCardDetached && !ts.loading && ts.translatedText) {
      triggerLatestThinkingTranslate({ force: false });
    }
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

  function resolveActiveAccountEmail() {
    const fromProfile = String(state.userProfile?.email || '').trim();
    if (fromProfile) return fromProfile;
    const activeAcct = Array.isArray(state.accounts) ? state.accounts.find((a) => a?.active && a?.email) : null;
    if (activeAcct?.email) return String(activeAcct.email).trim();
    const fromKa = String(state.keepAliveState?.accountId || '').trim();
    if (fromKa && fromKa !== 'default') return fromKa;
    return '';
  }

  function buildKeepAliveToggleTitle(group, kaPlan, poolCfg, kaEnabled, kaRunning) {
    if (!kaPlan) return '';
    if (!kaEnabled) return '点击开启：周期重置满额后静默发一次轻请求开启倒计时';
    const pickedModel = pickKeepAliveModelForGroup(group, state.clientModelConfigs, poolCfg?.preferredModel || '');
    const modelNote = pickedModel?.label ? ` · ${pickedModel.label}` : '';
    const stateNote = kaRunning
      ? '唤醒中…'
      : poolCfg?.lastError
        ? poolCfg.lastError
        : !isQuotaBucketUnstarted(kaPlan.targetBucket, kaPlan.cadence, Date.now())
          ? kaPlan.cadence === 'weekly'
            ? '本周计时中'
            : '计时中'
          : '待触发';
    return `已开启自动唤醒（${stateNote}${modelNote}），点击关闭`;
  }

  function syncQuotaTooltipKeepAliveInPlace() {
    const tt = document.getElementById('aq-quota-tooltip');
    if (!tt || tt.getAttribute('data-visible') !== '1') return;
    const btns = tt.querySelectorAll('[data-aq-ka-toggle]');
    if (!btns.length) return;
    const groups = Array.isArray(state.quotaData?.groups) ? state.quotaData.groups : [];
    const byPoolKey = new Map();
    for (let i = 0; i < groups.length; i++) {
      const kaPlan = classifyQuotaGroupKeepAlive(groups[i]);
      if (kaPlan?.poolKey) byPoolKey.set(kaPlan.poolKey, { group: groups[i], plan: kaPlan });
    }
    let changed = false;
    for (let i = 0; i < btns.length; i++) {
      const btn = btns[i];
      const poolKey = btn.getAttribute('data-aq-ka-toggle') || '';
      if (!poolKey) continue;
      const poolCfg = state.keepAliveState?.pools?.[poolKey] || null;
      const kaEnabled = Boolean(poolCfg?.enabled);
      const kaRunning = Boolean(state.keepAliveRunningPools.has(poolKey) || poolCfg?.inFlight);
      if (btn.classList.contains('is-on') !== kaEnabled) {
        btn.classList.toggle('is-on', kaEnabled);
        changed = true;
      }
      if (btn.classList.contains('is-running') !== kaRunning) {
        btn.classList.toggle('is-running', kaRunning);
        changed = true;
      }
      const nextPressed = kaEnabled ? 'true' : 'false';
      if (btn.getAttribute('aria-pressed') !== nextPressed) {
        btn.setAttribute('aria-pressed', nextPressed);
        changed = true;
      }
      const info = byPoolKey.get(poolKey);
      if (info) {
        const nextTitle = buildKeepAliveToggleTitle(info.group, info.plan, poolCfg, kaEnabled, kaRunning);
        if (btn.getAttribute('title') !== nextTitle) {
          btn.setAttribute('title', nextTitle);
          changed = true;
        }
      }
    }
    if (changed) {
      tt.__aqLastHtml = '';
    }
  }

  function clampRatio(val) {
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 0) return 0;
    if (n >= 1) return 1;
    return n;
  }

  function renderRingArcGroup({ r, strokeWidth, ratio, colorClass, minVisible = false }) {
    const c = 2 * Math.PI * r;
    const raw = clampRatio(ratio);
    const effective = minVisible && raw > 0 && raw < 0.04 ? 0.04 : raw;
    const filled = (effective * c).toFixed(2);
    const circ = c.toFixed(2);
    const track = `<circle cx="9" cy="9" r="${r}" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" opacity="0.16" />`;
    const arc =
      effective > 0
        ? `<circle class="${colorClass || ''}" cx="9" cy="9" r="${r}" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-dasharray="${filled} ${circ}" transform="rotate(-90 9 9)" />`
        : '';
    return `${track}${arc}`;
  }

  function buildProgressRingSvg(rings) {
    const list = Array.isArray(rings) ? rings.filter(Boolean) : [];
    const inner =
      list.length >= 2
        ? [
            renderRingArcGroup({ r: 6.8, strokeWidth: 2.0, ...list[0] }),
            renderRingArcGroup({ r: 3.7, strokeWidth: 1.9, ...list[1] }),
          ].join('')
        : renderRingArcGroup({ r: 6.2, strokeWidth: 2.1, ...(list[0] || { ratio: 0, colorClass: 'aq-lvl-muted' }) });
    return `<svg class="aq-chip-ring" viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">${inner}</svg>`;
  }

  function computeComposerChipMode(parts) {
    const footer = parts?.footer;
    if (!footer) return 'pill';
    const footerWidth = footer.clientWidth || footer.getBoundingClientRect?.().width || 0;
    if (footerWidth <= 0) return 'pill';
    let nativeRightWidth = 0;
    const rightGroup = parts.rightGroup;
    if (rightGroup) {
      const children = rightGroup.children || [];
      let nativeCount = 0;
      for (let i = 0; i < children.length; i++) {
        const ch = children[i];
        if (ch.id === 'aq-context-chip' || ch.id === 'aq-quota-chip') continue;
        const w = ch.getBoundingClientRect?.().width || 0;
        if (w > 0) {
          nativeRightWidth += w;
          nativeCount += 1;
        }
      }
      if (nativeCount > 1) nativeRightWidth += (nativeCount - 1) * 2;
    }
    return resolveComposerChipMode({
      footerWidth,
      nativeRightWidth,
      hasContextChip: Boolean(extractCascadeId()),
    });
  }

  function renderContextChipContent(chipMode = 'pill') {
    const ctxChip = document.getElementById('aq-context-chip');
    if (!ctxChip) return;
    const cid = extractCascadeId();
    if (!cid || chipMode === 'single') {
      if (ctxChip.style.display !== 'none') ctxChip.style.display = 'none';
      refreshContextTooltipIfVisible();
      return;
    }
    if (ctxChip.style.display !== 'inline-flex') ctxChip.style.display = 'inline-flex';
    if (ctxChip.getAttribute('data-mode') !== 'ring') {
      ctxChip.setAttribute('data-mode', 'ring');
    }
    const ctx = getActiveContext();
    const nextHtml = buildProgressRingSvg([
      ctx
        ? {
            ratio: ctx.usedTokens / ctx.maxTokens,
            colorClass: contextLevelClass(ctx.usedTokens, ctx.maxTokens),
            minVisible: true,
          }
        : { ratio: 0, colorClass: 'aq-lvl-muted' },
    ]);
    if (ctxChip.__aqLastHtml !== nextHtml) {
      ctxChip.__aqLastHtml = nextHtml;
      ctxChip.innerHTML = nextHtml;
    }
    refreshContextTooltipIfVisible();
  }

  function renderQuotaChipContent(partsArg = null) {
    const parts = partsArg || findComposerParts();
    const chipMode = computeComposerChipMode(parts);
    renderContextChipContent(chipMode);
    const chip = document.getElementById('aq-quota-chip');
    if (!chip) return;
    const nextModeAttr = chipMode === 'single' ? 'single' : chipMode === 'rings' ? 'ring' : 'pill';
    if (chip.getAttribute('data-mode') !== nextModeAttr) {
      chip.setAttribute('data-mode', nextModeAttr);
    }
    const loadVal = state.quotaFetching ? '1' : '0';
    if (chip.getAttribute('data-loading') !== loadVal) {
      chip.setAttribute('data-loading', loadVal);
    }

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
    const activeGroup = groups.length > 0 ? matchQuotaGroup(groups, state.selectedModelLabel) : null;
    const { fiveHour, weekly } = activeGroup ? extractQuotaBuckets(activeGroup) : { fiveHour: null, weekly: null };
    const ctx = getActiveContext();

    let nextHtml;
    if (nextModeAttr === 'pill') {
      if (groups.length === 0) {
        nextHtml =
          (state.quotaError ? '<span class="aq-lvl-muted">--</span>' : '<span class="aq-lvl-muted">…</span>') +
          updateDotHtml;
      } else {
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
        nextHtml = quotaParts.join('<span class="aq-chip-sep">/</span>') + updateDotHtml;
      }
    } else {
      const toQuotaRing = (b) =>
        b
          ? {
              ratio: b.remainingFraction,
              colorClass: quotaLevelClass(b.remainingFraction),
              minVisible: true,
            }
          : null;
      const primaryRing = toQuotaRing(fiveHour || weekly);
      if (nextModeAttr === 'single' && ctx) {
        const ctxRing = {
          ratio: ctx.usedTokens / ctx.maxTokens,
          colorClass: contextLevelClass(ctx.usedTokens, ctx.maxTokens),
          minVisible: true,
        };
        nextHtml = buildProgressRingSvg(primaryRing ? [ctxRing, primaryRing] : [ctxRing]) + updateDotHtml;
      } else {
        nextHtml = buildProgressRingSvg(primaryRing ? [primaryRing] : []) + updateDotHtml;
      }
    }
    if (chip.__aqLastHtml !== nextHtml) {
      chip.__aqLastHtml = nextHtml;
      chip.innerHTML = nextHtml;
    }
  }

  function renderQuotaBucketRow(b, { markExpired = false, nowMs = Date.now() } = {}) {
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
    if (markExpired && Number.isFinite(resetTs) && resetTs <= nowMs) {
      const origNote = Number(b.remainingFraction) < 0.995 ? `原 ${pct}` : '';
      return `
        <div class="aq-qp-bkt-row">
          <span class="aq-qp-bkt-win">${label}</span>
          <span class="aq-qp-bkt-val">
            <span class="aq-qp-bkt-pct is-reset">已重置</span>
            ${origNote ? `<span class="aq-qp-bkt-sep">·</span><span class="aq-qp-bkt-reset">${escapeHtml(origNote)}</span>` : ''}
          </span>
        </div>
      `;
    }
    const toneCls =
      lvl === 'aq-lvl-crit'
        ? ' is-crit'
        : lvl === 'aq-lvl-warn'
          ? ' is-warn'
          : lvl === 'aq-lvl-muted'
            ? ' is-muted'
            : '';
    const reset = formatResetCountdownParts(b.resetTime, nowMs, { includeDate: true });
    const useGrid = Boolean(reset.countdown && reset.targetStr);
    return `
      <div class="aq-qp-bkt-row">
        <span class="aq-qp-bkt-win">${label}</span>
        <span class="aq-qp-bkt-val${useGrid ? ' is-grid' : ''}">
          <span class="aq-qp-bkt-pct${toneCls}">${pct}</span>
          ${
            useGrid
              ? `<span class="aq-qp-bkt-sep">·</span><span class="aq-qp-bkt-dur">${escapeHtml(reset.countdown)}</span><span class="aq-qp-bkt-date">(${escapeHtml(reset.targetStr)})</span>`
              : reset.text
                ? `<span class="aq-qp-bkt-sep">·</span><span class="aq-qp-bkt-reset">${escapeHtml(reset.text)}</span>`
                : ''
          }
        </span>
      </div>
    `;
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
          const pct = Math.min(100, Math.max(0, Math.round((ctx.usedTokens / ctx.maxTokens) * 100)));
          const lvl = contextLevelClass(ctx.usedTokens, ctx.maxTokens);
          return `
            <div class="aq-qp-ctx">
              <span class="aq-qp-ctx-lbl">上下文窗口</span>
              <span class="aq-qp-ctx-val"><span class="aq-qp-ctx-strong ${lvl}">${formatContextK(ctx.usedTokens)}</span> / ${formatContextK(ctx.maxTokens)} · ${pct}%</span>
            </div>
          `;
        })()
      : '';

    const curEmail = resolveActiveAccountEmail();
    const curPlanName = state.userProfile?.planName || '';
    const accountsSupported = state.accountsSupported !== false;
    const unsupportedReason = state.accountsUnsupportedReason || '当前系统暂不支持账号快照与一键切换';
    const closeSvg =
      '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6"/></svg>';
    const acctList = Array.isArray(state.accounts) ? state.accounts : [];
    const canDragAcct = accountsSupported && acctList.length > 1 && !state.accountsBusy;
    const nowMs = Date.now();
    const acctRows = accountsSupported
      ? acctList
          .map((acct) => {
            const isCur = Boolean(acct.active || (curEmail && acct.email?.toLowerCase() === curEmail.toLowerCase()));
            const planLabel = (isCur && state.userProfile?.planName) || acct.planName || '';
            const gemQuotaSource = isCur && state.quotaData?.groups?.length ? state.quotaData : acct.quotaSnapshot;
            const gemStatus = resolveGeminiQuotaAvailability(gemQuotaSource, { isCurrent: isCur, nowMs });
            const confirming = state.pendingSwitchConfirmId === acct.id;
            const switchBtn = isCur
              ? '<span class="aq-q-active-tag">当前</span>'
              : `<button type="button" class="aq-q-btn${confirming ? ' aq-q-btn-warn' : ''}" data-aq-acct-switch="${escapeHtml(acct.id)}" title="${confirming ? '再次点击确认重启并切换账号' : '切换至此账号'}" ${state.accountsBusy ? 'disabled' : ''}>${confirming ? '确认重启' : '切换'}</button>`;
            const unstartedTitle = '刷新倒计时未开始（需使用一次才会开始计时）';
            const unstartedDotHtml = gemStatus.unstarted
              ? `<span class="aq-q-acct-unstarted-dot" data-aq-acct-unstarted="1" title="${unstartedTitle}" aria-label="${unstartedTitle}"></span>`
              : '';
            const subText = gemStatus.countdownText || gemStatus.label;
            return `
              <div class="aq-q-acct-row${isCur ? ' is-current' : ''}${canDragAcct ? ' is-draggable' : ''}" data-aq-acct-id="${escapeHtml(acct.id)}">
                <div class="aq-q-acct-info">
                  <span class="aq-q-acct-gem is-${escapeHtml(gemStatus.state)}" data-aq-acct-gem="${escapeHtml(gemStatus.state)}" title="${escapeHtml(gemStatus.label)}" aria-label="${escapeHtml(gemStatus.label)}"></span>
                  <div class="aq-q-acct-meta">
                    <span class="aq-q-acct-email" title="${escapeHtml(acct.email)}">${escapeHtml(acct.email)}</span>
                    <span class="aq-q-acct-sub is-${escapeHtml(gemStatus.state)}" title="${escapeHtml(gemStatus.unstarted ? `${gemStatus.label} · ${unstartedTitle}` : gemStatus.label)}"><span class="aq-q-acct-sub-text">${escapeHtml(subText)}</span>${unstartedDotHtml}</span>
                  </div>
                </div>
                <div class="aq-q-acct-right">
                  ${planLabel ? `<span class="aq-q-acct-plan">${escapeHtml(planLabel)}</span>` : ''}
                  ${switchBtn}
                  <button type="button" class="aq-q-btn-del" data-aq-acct-del="${escapeHtml(acct.id)}" title="删除快照" aria-label="删除快照" ${state.accountsBusy ? 'disabled' : ''}>${closeSvg}</button>
                </div>
              </div>
            `;
          })
          .join('')
      : '';
    const batchFinishNote =
      !state.accountsError &&
      state.batchKeepAlive?.visible &&
      !state.batchKeepAlive?.active &&
      (state.batchKeepAlive.phase === 'done' || state.batchKeepAlive.phase === 'failed')
        ? state.batchKeepAlive.statusText || ''
        : '';
    const statusHtml = !accountsSupported
      ? ''
      : state.accountsError
        ? `<div class="aq-q-acct-err">${escapeHtml(state.accountsError)}</div>`
        : batchFinishNote
          ? `<div class="${state.batchKeepAlive.phase === 'failed' ? 'aq-q-acct-err' : 'aq-q-acct-note is-success'}">${escapeHtml(batchFinishNote)}</div>`
          : state.accountsStatus
            ? `<div class="aq-q-acct-note">${escapeHtml(state.accountsStatus)}</div>`
            : '';
    const accountsBodyHtml = !accountsSupported
      ? `<div class="aq-q-acct-note">${escapeHtml(unsupportedReason)}</div>`
      : acctRows
        ? `<div class="aq-q-acct-list">${acctRows}</div>`
        : '<div class="aq-q-acct-note">暂无已保存快照，登录后会自动保存</div>';
    const addConfirming = state.pendingSwitchConfirmId === '__add__';
    const batchActive = Boolean(state.batchKeepAlive?.active);
    const batchConfirming = Boolean(!batchActive && state.pendingBatchConfirm);
    const batchEligibleCount = Number(state.batchSummary?.eligibleCount || 0);
    const batchBtnDisabled = !accountsSupported || (!batchActive && (state.accountsBusy || batchEligibleCount <= 0));
    const batchBtnLabel = batchActive
      ? '停止唤醒'
      : batchConfirming
        ? `确认唤醒 (${batchEligibleCount})`
        : '一键唤醒';
    const batchBtnTitle = batchActive
      ? '点击立即停止批量切换唤醒，保留在当前账号'
      : batchEligibleCount > 0
        ? String(state.batchSummary?.note || '依次切换全部已订阅账号唤醒已开启开关的模型池')
        : String(state.batchSummary?.note || '暂无可唤醒的已订阅账号');
    const disabledTipAttr = !accountsSupported ? ` title="${escapeHtml(unsupportedReason)}"` : '';
    const accountsHtml = `
      <div class="aq-q-accounts">
        <div class="aq-q-acct-hdr">
          <span>账号切换</span>
          <div class="aq-q-acct-hdr-actions">
            <button type="button" class="aq-qp-add-btn${batchActive || batchConfirming ? ' is-warn' : ''}" data-aq-batch-wake="1" title="${escapeHtml(batchBtnTitle)}" ${batchBtnDisabled ? 'disabled' : ''}>${batchBtnLabel}</button>
            <button type="button" class="aq-qp-add-btn${addConfirming ? ' is-warn' : ''}" data-aq-acct-add="1" ${!accountsSupported || state.accountsBusy ? 'disabled' : ''}${disabledTipAttr}>${addConfirming ? '确认重启' : '+ 登录新号'}</button>
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

    const settingsBtnHtml = '<button type="button" class="aq-key-settings-btn" data-aq-key-settings-open="1" title="AI 简述 / 翻译设置" aria-label="AI 简述 / 翻译设置"><svg class="aq-key-settings-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2.2"/><path d="M13.2 8a5.2 5.2 0 0 0-.08-.88l1.42-1.1-1.35-2.34-1.72.66a5.2 5.2 0 0 0-1.52-.88L9.68 1.6H6.32l-.27 1.86c-.55.21-1.06.51-1.52.88l-1.72-.66L1.46 6.02l1.42 1.1a5.3 5.3 0 0 0 0 1.76l-1.42 1.1 1.35 2.34 1.72-.66c.46.37.97.67 1.52.88l.27 1.86h3.36l.27-1.86c.55-.21 1.06-.51 1.52-.88l1.72.66 1.35-2.34-1.42-1.1c.05-.29.08-.58.08-.88Z"/></svg></button>';

    const updateHtml = `
      <div class="aq-q-update">
        ${settingsBtnHtml}
        ${upd.currentVersion ? versionControlHtml : ''}
        ${upd.error ? `<div class="aq-update-error" role="alert">${escapeHtml(upd.error)}</div>` : ''}
      </div>
    `;

    const planBadgeHtml = curPlanName ? `<span class="aq-qp-badge">${escapeHtml(curPlanName)}</span>` : '';

    let nextHtml;
    if (groups.length === 0) {
      nextHtml = `
        <div class="aq-qp-hdr">
          <span class="aq-qp-title-wrap">
            <span class="aq-qp-title">模型配额</span>
            ${planBadgeHtml}
          </span>
          <span class="aq-qp-status">${state.quotaError ? escapeHtml(state.quotaError) : '加载中…'}</span>
        </div>
        ${ctxSectionHtml}
        ${accountsHtml}
        ${updateHtml}
      `;
    } else {
      const blocks = groups.map((g) => {
        const isMatched = Boolean(activeGroup && g.displayName === activeGroup.displayName);
        const buckets = orderQuotaBuckets(g.buckets);
        const kaPlan = classifyQuotaGroupKeepAlive(g);
        const poolKey = kaPlan?.poolKey || '';
        const poolCfg = poolKey ? state.keepAliveState?.pools?.[poolKey] || null : null;
        const kaEnabled = Boolean(poolCfg?.enabled);
        const kaRunning = Boolean(poolKey && (state.keepAliveRunningPools.has(poolKey) || poolCfg?.inFlight));
        const bucketHtml = buckets.map((b) => renderQuotaBucketRow(b, { nowMs: Date.now() })).join('');

        const kaTitle = buildKeepAliveToggleTitle(g, kaPlan, poolCfg, kaEnabled, kaRunning);
        const kaToggleHtml = kaPlan
          ? `<button type="button" class="aq-qp-ka-switch ${kaEnabled ? 'is-on' : ''}${kaRunning ? ' is-running' : ''}" data-aq-ka-toggle="${escapeHtml(poolKey)}" aria-pressed="${kaEnabled ? 'true' : 'false'}" title="${escapeHtml(kaTitle)}"><span class="aq-qp-ka-lbl">${escapeHtml(kaPlan.cadenceLabel)}</span><span class="aq-qp-ka-track" aria-hidden="true"><span class="aq-qp-ka-thumb"></span></span></button>`
          : '';

        return `
          <div class="aq-qp-card${isMatched ? ' is-active' : ''}">
            <div class="aq-qp-card-hdr">
              <span class="aq-qp-card-title">
                <span>${escapeHtml(g.displayName || '模型分组')}</span>
                ${isMatched ? '<span class="aq-qp-active-dot" title="当前选中模型分组"></span>' : ''}
              </span>
              ${kaToggleHtml}
            </div>
            <div class="aq-qp-buckets">${bucketHtml || '<div class="aq-qp-status">暂无配额</div>'}</div>
          </div>
        `;
      });

      const headerStatusHtml = state.quotaError
        ? `<span class="aq-qp-status">${escapeHtml(state.quotaError)}</span>`
        : '';

      nextHtml = `
        <div class="aq-qp-hdr">
          <span class="aq-qp-title-wrap">
            <span class="aq-qp-title">模型配额</span>
            ${planBadgeHtml}
          </span>
          ${headerStatusHtml}
        </div>
        ${ctxSectionHtml}
        <div class="aq-qp-groups">${blocks.join('')}</div>
        ${accountsHtml}
        ${updateHtml}
      `;
    }

    if (tt.__aqLastHtml !== nextHtml) {
      tt.__aqLastHtml = nextHtml;
      tt.innerHTML = nextHtml;
      bindQuotaTooltipActions(tt);
    }
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

  function sendUiPrefsAction(payload) {
    if (typeof window.__aqUiPrefsAction !== 'function') return false;
    try {
      window.__aqUiPrefsAction(JSON.stringify(payload || {}));
      return true;
    } catch {
      return false;
    }
  }

  function sendKeepAliveAction(payload) {
    if (typeof window.__aqKeepAliveAction !== 'function') return;
    try {
      window.__aqKeepAliveAction(
        JSON.stringify({
          ...(payload || {}),
          accountEmail: resolveActiveAccountEmail(),
        })
      );
    } catch {}
  }

  function sendBatchKeepAliveAction(payload) {
    if (typeof window.__aqBatchKeepAliveAction !== 'function') return false;
    try {
      window.__aqBatchKeepAliveAction(JSON.stringify(payload || {}));
      return true;
    } catch {
      return false;
    }
  }

  function claimKeepAliveFromDaemon({ poolKey, manual = false }) {
    if (typeof window.__aqKeepAliveAction !== 'function') {
      return Promise.resolve({ allowed: false, reason: 'unavailable' });
    }
    const requestId = `ka-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        state.keepAliveClaims.delete(requestId);
        resolve({ allowed: false, reason: 'timeout' });
      }, 5000);
      state.keepAliveClaims.set(requestId, (res) => {
        clearTimeout(timer);
        resolve(res || { allowed: false, reason: 'empty' });
      });
      sendKeepAliveAction({ type: 'claim', requestId, poolKey, manual });
    });
  }

  function collectEnabledKeepAliveResetTimes(nowMs = Date.now()) {
    const groups = state.quotaData?.groups;
    if (!Array.isArray(groups) || groups.length === 0) return [];
    const results = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const plan = classifyQuotaGroupKeepAlive(g);
      if (!plan) continue;
      const poolCfg = state.keepAliveState?.pools?.[plan.poolKey];
      if (!poolCfg?.enabled) continue;
      if (poolCfg.backoffUntil && nowMs < Number(poolCfg.backoffUntil)) continue;
      if (poolCfg.lastTriggeredAt && nowMs - Number(poolCfg.lastTriggeredAt) < KEEP_ALIVE_COOLDOWN_MS) continue;
      if (plan.guardWeeklyBucket && Number(plan.guardWeeklyBucket.remainingFraction) < 0.02) continue;

      const resetTs = Date.parse(String(plan.targetBucket?.resetTime || ''));
      if (Number.isFinite(resetTs)) {
        results.push(resetTs);
      }
    }
    return results;
  }

  function hasExpiredEnabledKeepAlive(nowMs = Date.now()) {
    const resetTimes = collectEnabledKeepAliveResetTimes(nowMs);
    for (let i = 0; i < resetTimes.length; i++) {
      if (nowMs >= resetTimes[i] + 3000) return true;
    }
    return false;
  }

  function scheduleKeepAliveDeadlineTimer() {
    if (state.keepAliveDeadlineTimer) {
      clearTimeout(state.keepAliveDeadlineTimer);
      state.keepAliveDeadlineTimer = null;
    }
    const nowMs = Date.now();
    const resetTimes = collectEnabledKeepAliveResetTimes(nowMs);
    let earliestResetTs = 0;
    for (let i = 0; i < resetTimes.length; i++) {
      const resetTs = resetTimes[i];
      if (resetTs > nowMs && (!earliestResetTs || resetTs < earliestResetTs)) {
        earliestResetTs = resetTs;
      }
    }

    if (earliestResetTs > nowMs) {
      // Exact reset deadline timer (+3s safety margin) so we fire promptly without relying on polling intervals.
      const delayMs = Math.max(1000, Math.min(earliestResetTs - nowMs + 3000, 2_147_483_647));
      state.keepAliveDeadlineTimer = setTimeout(() => {
        state.keepAliveDeadlineTimer = null;
        void fetchQuota({ force: true, immediate: true, includeUserStatus: true });
      }, delayMs);
    }
  }

  async function runKeepAliveForGroup(group, { manual = false, skipPostRefresh = false } = {}) {
    const plan = classifyQuotaGroupKeepAlive(group);
    if (!plan) return { ok: false, error: '' };
    const poolKey = plan.poolKey;
    if (state.keepAliveRunningPools.has(poolKey)) return { ok: false, error: '该分组正在唤醒中' };

    const poolCfg = state.keepAliveState?.pools?.[poolKey] || {};
    if (!manual && !poolCfg.enabled) return { ok: false, error: '' };

    let model = pickKeepAliveModelForGroup(group, state.clientModelConfigs, poolCfg.preferredModel || '');
    if (!model) {
      sendKeepAliveAction({
        type: 'complete',
        poolKey,
        ok: false,
        error: '未匹配到该分组的模型',
      });
      return { ok: false, error: '未匹配到该分组的模型' };
    }

    const claim = await claimKeepAliveFromDaemon({ poolKey, manual });
    if (!claim?.allowed) return { ok: false, error: claim?.reason || '唤醒未获准' };

    const runId = String(claim.runId || '');
    const cascadeId =
      typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2).padEnd(12, '0').slice(0, 12)}`;
    const cidLower = cascadeId.toLowerCase();
    state.keepAliveRunningPools.add(poolKey);
    state.hiddenKeepAliveCids.add(cidLower);
    refreshQuotaTooltipIfVisible();

    const csrf = window.__APP_CONFIG__?.csrfToken || '';
    const headers = {
      'Content-Type': 'application/json',
      ...(csrf ? { 'x-codeium-csrf-token': csrf } : {}),
    };

    let ok = false;
    let errMsg = '';
    try {
      const startRes = await fetch('/exa.language_server_pb.LanguageServerService/StartCascade', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          cascadeId,
          source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
        }),
      });
      if (!startRes.ok) {
        throw new Error(`创建会话失败 (${startRes.status})`);
      }

      const sendRes = await fetch('/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          cascadeId,
          items: [{ text: 'hi' }],
          cascadeConfig: {
            plannerConfig: {
              planModel: model.modelId,
              toolConfig: {
                forceDisableToolCalling: true,
                autoInteractionBehavior: 'AUTO_INTERACTION_BEHAVIOR_DENY_ALL',
              },
            },
            executorConfig: {
              useCoreDirect: true,
            },
          },
        }),
      });
      if (!sendRes.ok) {
        throw new Error(`发送失败 (${sendRes.status})`);
      }

      let settledStatus = '';
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !state.disposed) {
        await new Promise((r) => setTimeout(r, 1200));
        if (state.disposed) break;
        try {
          const checkRes = await fetch('/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories', {
            method: 'POST',
            headers,
            body: '{}',
          });
          if (checkRes.ok) {
            const checkJson = await checkRes.json().catch(() => null);
            const entry = checkJson?.trajectorySummaries?.[cascadeId];
            const st = String(entry?.status || '');
            if (
              entry &&
              st &&
              st !== 'CASCADE_RUN_STATUS_RUNNING' &&
              st !== 'CASCADE_RUN_STATUS_BUSY' &&
              !entry.notFullyIdle
            ) {
              settledStatus = st;
              break;
            }
          }
        } catch {}
      }
      if (!settledStatus && !state.disposed) {
        try {
          await fetch('/exa.language_server_pb.LanguageServerService/CancelCascadeInvocation', {
            method: 'POST',
            headers,
            body: JSON.stringify({ cascadeId }),
          });
        } catch {}
      } else if (settledStatus === '' && state.disposed) {
        try {
          await fetch('/exa.language_server_pb.LanguageServerService/CancelCascadeInvocation', {
            method: 'POST',
            headers,
            body: JSON.stringify({ cascadeId }),
          });
        } catch {}
      }
      if (!settledStatus) {
        throw new Error('唤醒响应超时');
      }
      if (/ERROR|FAIL|ABORT|CANCEL/i.test(settledStatus)) {
        throw new Error(`唤醒执行异常 (${settledStatus})`);
      }
      ok = true;
    } catch (err) {
      errMsg = String(err?.message || '唤醒失败');
    } finally {
      try {
        await fetch('/exa.language_server_pb.LanguageServerService/DeleteCascadeTrajectory', {
          method: 'POST',
          headers,
          body: JSON.stringify({ cascadeId }),
        });
      } catch {}
      state.keepAliveRunningPools.delete(poolKey);
      sendKeepAliveAction({
        type: 'complete',
        poolKey,
        runId,
        ok,
        modelLabel: model.label,
        error: errMsg,
      });
      if (!state.disposed) {
        setTimeout(() => {
          state.hiddenKeepAliveCids.delete(cidLower);
        }, 30_000);
        if (!skipPostRefresh) {
          await fetchQuota({ force: true, immediate: true, includeUserStatus: true });
          refreshQuotaTooltipIfVisible();
        }
      }
    }
    return { ok, error: errMsg };
  }

  function dismissBatchCompletionToast() {
    if (state.batchToastTimer) {
      clearTimeout(state.batchToastTimer);
      state.batchToastTimer = null;
    }
    document.getElementById('aq-batch-toast')?.remove();
  }

  function maybeShowBatchCompletionToast(b) {
    if (typeof document === 'undefined' || !document.body) return;
    if (!b || !b.visible || b.active || (b.phase !== 'done' && b.phase !== 'failed')) return;
    const runId = String(b.runId || '');
    if (!runId || state.shownBatchToastRunId === runId) return;
    try {
      if (localStorage.getItem('aq_batch_done_toast_run_id_v1') === runId) {
        state.shownBatchToastRunId = runId;
        return;
      }
      localStorage.setItem('aq_batch_done_toast_run_id_v1', runId);
    } catch {}
    state.shownBatchToastRunId = runId;

    dismissBatchCompletionToast();
    const toast = document.createElement('div');
    toast.id = 'aq-batch-toast';
    if (b.phase === 'failed') {
      toast.className = 'is-failed';
    }
    const leadIcon =
      b.phase === 'done'
        ? '<svg class="aq-bw-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M5.2 8.2l1.9 1.9 3.7-3.9"/></svg>'
        : '<span class="aq-bw-pulse is-failed" aria-hidden="true"></span>';
    const summarySeg = b.summaryText ? `（${b.summaryText}）` : '';
    const originSeg = b.originEmail ? `，已切回 ${b.originEmail}` : b.statusText ? ` · ${b.statusText}` : '';
    const msg =
      b.phase === 'done'
        ? `${b.allSucceeded !== false ? '一键唤醒全部完成' : '一键唤醒已完成'}${summarySeg}${originSeg}`
        : b.statusText || '一键唤醒结束，切回原账号失败';
    toast.innerHTML = `
      ${leadIcon}
      <span class="aq-bt-text" title="${escapeHtml(msg)}">${escapeHtml(msg)}</span>
      <button type="button" class="aq-bt-close" aria-label="关闭提示" title="关闭提示">
        <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6"/></svg>
      </button>
    `;
    toast.addEventListener('click', (ev) => {
      if (ev.target?.closest?.('.aq-bt-close')) {
        ev.preventDefault();
        ev.stopPropagation();
        dismissBatchCompletionToast();
      }
    });
    document.body.appendChild(toast);
    state.batchToastTimer = setTimeout(() => {
      state.batchToastTimer = null;
      document.getElementById('aq-batch-toast')?.remove();
    }, 9000);
  }

  function renderBatchWakePanel() {
    if (typeof document === 'undefined' || !document.body) return;
    const b = state.batchKeepAlive;
    let panel = document.getElementById('aq-batch-wake-panel');
    if (!b || !b.visible || b.phase === 'idle') {
      panel?.remove();
      return;
    }
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'aq-batch-wake-panel';
      panel.addEventListener('click', (ev) => {
        const stopBtn = ev.target?.closest?.('[data-aq-bw-stop]');
        if (stopBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          sendBatchKeepAliveAction({ type: 'cancel' });
          return;
        }
        const closeBtn = ev.target?.closest?.('[data-aq-bw-close]');
        if (closeBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          dismissBatchCompletionToast();
          sendBatchKeepAliveAction({ type: 'dismiss' });
        }
      });
      document.body.appendChild(panel);
    }

    panel.classList.toggle('is-done', !b.active && b.phase === 'done');
    panel.classList.toggle('is-failed', !b.active && b.phase === 'failed');

    const items = Array.isArray(b.items) ? b.items : [];
    const total = items.length;
    const stepText = b.active
      ? b.phase === 'returning'
        ? '切回起始号'
        : total > 0 && b.currentIndex >= 0
          ? `${Math.min(b.currentIndex + 1, total)}/${total}`
          : ''
      : total > 0
        ? `${total}/${total}`
        : '';
    const titleLabel = b.active
      ? `批量唤醒${stepText ? ` · ${escapeHtml(stepText)}` : ''}`
      : b.phase === 'done'
        ? `${b.allSucceeded !== false ? '一键唤醒已完成' : '一键唤醒已结束'}${stepText ? ` · ${escapeHtml(stepText)}` : ''}`
        : b.phase === 'cancelled'
          ? '一键唤醒已停止'
          : '一键唤醒结束（异常）';
    const leadBadgeHtml =
      !b.active && b.phase === 'done'
        ? '<svg class="aq-bw-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M5.2 8.2l1.9 1.9 3.7-3.9"/></svg>'
        : `<span class="aq-bw-pulse${
            b.active
              ? ''
              : b.phase === 'cancelled'
                ? ' is-cancelled'
                : ' is-failed'
          }" aria-hidden="true"></span>`;
    const actionBtnHtml = b.active
      ? '<button type="button" class="aq-bw-action is-stop" data-aq-bw-stop="1" title="停止批量唤醒并保留在当前账号">停止</button>'
      : '<button type="button" class="aq-bw-action" data-aq-bw-close="1" title="关闭完成提示面板">关闭</button>';
    const rowsHtml = items
      .map((it) => {
        const dotCls =
          it.status === 'switching' || it.status === 'waiting_ready' || it.status === 'waking'
            ? ' is-running'
            : it.status === 'done'
              ? ' is-done'
              : it.status === 'failed'
                ? ' is-failed'
                : it.status === 'cancelled'
                  ? ' is-cancelled'
                  : '';
        return `
          <div class="aq-bw-row">
            <span class="aq-bw-row-left">
              <span class="aq-bw-dot${dotCls}"></span>
              <span class="aq-bw-email" title="${escapeHtml(it.email)}">${escapeHtml(it.email)}</span>
            </span>
            <span class="aq-bw-detail" title="${escapeHtml(it.detail || '')}">${escapeHtml(it.detail || '')}</span>
          </div>
        `;
      })
      .join('');
    const subText = b.active
      ? b.statusText
      : [b.statusText, b.summaryText].filter(Boolean).join(' · ');
    const statusCls = [
      'aq-bw-status',
      !b.active ? 'is-finished' : '',
      !b.active && b.phase === 'done' ? 'is-done' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const nextHtml = `
      <div class="aq-bw-hdr">
        <span class="aq-bw-title-wrap">
          ${leadBadgeHtml}
          <span>${titleLabel}</span>
        </span>
        ${actionBtnHtml}
      </div>
      <div class="${statusCls}" title="${escapeHtml(subText || '')}">${escapeHtml(subText || '')}</div>
      ${rowsHtml ? `<div class="aq-bw-list">${rowsHtml}</div>` : ''}
    `;
    if (panel.__aqLastHtml !== nextHtml) {
      panel.__aqLastHtml = nextHtml;
      panel.innerHTML = nextHtml;
    }
    maybeShowBatchCompletionToast(b);
  }

  function scheduleBatchReadyRetry() {
    if (state.batchReadyRetryTimer || state.disposed) return;
    state.batchReadyRetryTimer = setTimeout(() => {
      state.batchReadyRetryTimer = null;
      void maybeExecuteBatchWakeStep();
    }, 1500);
  }

  async function maybeExecuteBatchWakeStep() {
    const b = state.batchKeepAlive;
    if (state.disposed || !b || !b.active || b.cancelRequested) return;

    if (b.phase === 'waiting_ready') {
      const nowMs = Date.now();
      const targetEmail = String(b.currentTargetEmail || '').trim().toLowerCase();
      const curEmail = String(state.userProfile?.email || '').trim().toLowerCase();
      const needFreshQuota =
        state.batchFreshQuotaStepSeq !== b.stepSeq ||
        ((!curEmail || curEmail !== targetEmail || !state.quotaData?.groups?.length || state.clientModelConfigs.length === 0) &&
          !state.quotaFetching &&
          nowMs - state.batchFreshQuotaAttemptAt >= 1500);
      if (needFreshQuota) {
        state.batchFreshQuotaStepSeq = b.stepSeq;
        state.batchFreshQuotaAttemptAt = nowMs;
        await fetchQuota({ force: true, immediate: true, includeUserStatus: true });
      }
      const latest = state.batchKeepAlive;
      if (state.disposed || !latest || !latest.active || latest.phase !== 'waiting_ready' || latest.stepSeq !== b.stepSeq) {
        return;
      }
      const liveEmail = String(state.userProfile?.email || '').trim().toLowerCase();
      const latestTargetEmail = String(latest.currentTargetEmail || '').trim().toLowerCase();
      if (
        !liveEmail ||
        !latestTargetEmail ||
        liveEmail !== latestTargetEmail ||
        !state.accountsMetaLoaded ||
        !state.keepAliveLoaded
      ) {
        scheduleBatchReadyRetry();
        return;
      }
      if (String(state.keepAliveState?.accountId || '').trim().toLowerCase() !== latestTargetEmail) {
        sendKeepAliveAction({ type: 'get' });
        scheduleBatchReadyRetry();
        return;
      }
      if (!Array.isArray(state.quotaData?.groups) || state.quotaData.groups.length === 0 || state.clientModelConfigs.length === 0) {
        scheduleBatchReadyRetry();
        return;
      }
      if (state.batchReadyRetryTimer) {
        clearTimeout(state.batchReadyRetryTimer);
        state.batchReadyRetryTimer = null;
      }
      if (state.batchReadySentStepSeq === latest.stepSeq) return;
      state.batchReadySentStepSeq = latest.stepSeq;
      sendBatchKeepAliveAction({
        type: 'step-ready',
        stepSeq: latest.stepSeq,
        email: state.userProfile.email,
      });
      return;
    }

    if (b.phase === 'waking' && b.isAssignedExecutor && b.assignedStepToken) {
      const runToken = b.assignedStepToken;
      if (state.batchWakeRunningToken === runToken) return;
      state.batchWakeRunningToken = runToken;

      const groups = Array.isArray(state.quotaData?.groups) ? state.quotaData.groups : [];
      const enabledGroups = [];
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const plan = classifyQuotaGroupKeepAlive(g);
        if (!plan) continue;
        const poolCfg = state.keepAliveState?.pools?.[plan.poolKey];
        if (poolCfg?.enabled) {
          enabledGroups.push({ group: g, plan, poolCfg });
        }
      }

      let wokenCount = 0;
      const errors = [];
      let skippedReason = '';

      if (enabledGroups.length === 0) {
        skippedReason = '未开启唤醒开关';
      } else {
        let alreadyActiveCount = 0;
        let weeklyDepletedCount = 0;
        for (let i = 0; i < enabledGroups.length; i++) {
          const activeBatch = state.batchKeepAlive;
          if (state.disposed || !activeBatch?.active || activeBatch.assignedStepToken !== runToken || activeBatch.cancelRequested) {
            return;
          }
          const { group, plan, poolCfg } = enabledGroups[i];
          const evalRes = evaluateQuotaPoolKeepAlive({
            group,
            enabled: true,
            poolState: {
              ...poolCfg,
              lastTriggeredAt: 0,
              backoffUntil: 0,
              inFlight: Boolean(state.keepAliveRunningPools.has(plan.poolKey)),
            },
            nowMs: Date.now(),
          });
          if (!evalRes.eligible) {
            if (evalRes.reason === 'weekly_depleted') weeklyDepletedCount += 1;
            else alreadyActiveCount += 1;
            continue;
          }
          sendBatchKeepAliveAction({
            type: 'step-progress',
            stepSeq: b.stepSeq,
            runToken,
            poolLabel: group.displayName || plan.poolKey,
          });
          const res = await runKeepAliveForGroup(group, { manual: true, skipPostRefresh: true });
          if (res?.ok) {
            wokenCount += 1;
          } else if (res?.error) {
            errors.push(res.error);
          }
        }
        if (wokenCount === 0 && errors.length === 0) {
          skippedReason = weeklyDepletedCount > 0 && alreadyActiveCount === 0 ? '周额度不足' : '已在计时中';
        }
      }

      const activeAfter = state.batchKeepAlive;
      if (state.disposed || !activeAfter?.active || activeAfter.assignedStepToken !== runToken || activeAfter.cancelRequested) {
        return;
      }
      if (wokenCount > 0) {
        await fetchQuota({ force: true, immediate: true, includeUserStatus: true });
      }
      if (state.disposed || !state.batchKeepAlive?.active || state.batchKeepAlive?.assignedStepToken !== runToken) {
        return;
      }
      sendBatchKeepAliveAction({
        type: 'step-complete',
        stepSeq: b.stepSeq,
        runToken,
        wokenCount,
        skippedReason,
        errors,
        quota: buildCurrentQuotaSnapshot(),
        profile: state.userProfile,
      });
    }
  }

  async function maybeRunKeepAlives() {
    if (state.batchKeepAlive?.active) return;
    const groups = state.quotaData?.groups;
    if (!Array.isArray(groups) || groups.length === 0) {
      scheduleKeepAliveDeadlineTimer();
      return;
    }
    const acctId = resolveActiveAccountEmail().toLowerCase();
    if (!acctId) return;
    if (String(state.keepAliveState?.accountId || '').toLowerCase() !== acctId) return;
    if (state.clientModelConfigs.length === 0) return;

    const nowMs = Date.now();
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const plan = classifyQuotaGroupKeepAlive(g);
      if (!plan) continue;
      const poolCfg = state.keepAliveState?.pools?.[plan.poolKey];
      const evalRes = evaluateQuotaPoolKeepAlive({
        group: g,
        enabled: Boolean(poolCfg?.enabled),
        poolState: {
          ...poolCfg,
          inFlight: Boolean(poolCfg?.inFlight || state.keepAliveRunningPools.has(plan.poolKey)),
        },
        nowMs,
      });
      if (evalRes.eligible) {
        await runKeepAliveForGroup(g, { manual: false });
      }
    }
    scheduleKeepAliveDeadlineTimer();
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
        <div class="aq-qp-hdr">
          <span class="aq-acct-tt-hdr-left">
            <span class="aq-acct-tt-email" title="${escapeHtml(acct.email)}">${escapeHtml(acct.email)}</span>
            ${planLabel ? `<span class="aq-qp-badge">${escapeHtml(planLabel)}</span>` : ''}
          </span>
          <span class="aq-qp-status">${escapeHtml(subLabel)}</span>
        </div>
        <div class="aq-acct-tt-empty">${
          isCur ? '正在加载当前账号配额…' : '尚未记录该账号的额度快照，切换登录一次后将自动记录。'
        }</div>
      `;
    } else {
      const blocks = groups.map((g) => {
        const buckets = orderQuotaBuckets(g.buckets);
        const bucketHtml = buckets
          .map((b) => renderQuotaBucketRow(b, { markExpired: !isCur, nowMs }))
          .join('');

        return `
          <div class="aq-qp-card">
            <div class="aq-qp-card-hdr">
              <span class="aq-qp-card-title"><span>${escapeHtml(g.displayName || '模型分组')}</span></span>
            </div>
            <div class="aq-qp-buckets">${bucketHtml || '<div class="aq-qp-status">暂无配额</div>'}</div>
          </div>
        `;
      });

      const footHtml = isCur
        ? ''
        : '<div class="aq-acct-tt-foot">基于本地记录与重置时间推算 · 若在其他设备消耗过请切换后刷新</div>';

      subTt.innerHTML = `
        <div class="aq-qp-hdr">
          <span class="aq-acct-tt-hdr-left">
            <span class="aq-acct-tt-email" title="${escapeHtml(acct.email)}">${escapeHtml(acct.email)}</span>
            ${planLabel ? `<span class="aq-qp-badge">${escapeHtml(planLabel)}</span>` : ''}
          </span>
          <span class="aq-qp-status">${escapeHtml(subLabel)}</span>
        </div>
        <div class="aq-qp-groups">${blocks.join('')}</div>
        ${footHtml}
      `;
    }

    positionAccountQuotaTooltip(subTt, anchorRow);
    subTt.setAttribute('data-visible', '1');
  }

  function cleanupAccountDrag() {
    const d = state.acctDrag;
    if (!d) return;
    state.acctDrag = null;
    if (d.timer) {
      clearTimeout(d.timer);
      d.timer = null;
    }
    if (d.started) {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
    const tt = document.getElementById('aq-quota-tooltip');
    if (tt) {
      tt.querySelector('.aq-q-acct-list')?.classList?.remove('is-reordering');
      tt.querySelectorAll('.aq-q-acct-row').forEach((el) => {
        el.classList.remove('is-dragging');
        el.style.transform = '';
      });
    }
  }

  function startAccountDragSession(d) {
    const tt = document.getElementById('aq-quota-tooltip');
    const listEl = tt?.querySelector?.('.aq-q-acct-list') || null;
    const rows = listEl ? [...listEl.querySelectorAll('.aq-q-acct-row[data-aq-acct-id]')] : [];
    const fromIdx = rows.findIndex((r) => r.getAttribute('data-aq-acct-id') === d.sourceId);
    if (fromIdx < 0 || rows.length <= 1) return false;
    const rects = rows.map((r) => r.getBoundingClientRect());
    const gap = rows.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 4.5;
    d.started = true;
    d.listEl = listEl;
    d.rows = rows;
    d.rects = rects;
    d.fromIdx = fromIdx;
    d.toIdx = fromIdx;
    d.rowEl = rows[fromIdx];
    d.shiftPx = (rects[fromIdx]?.height || 38) + gap;
    state.quotaTooltipPinned = true;
    hideAccountQuotaTooltip();
    listEl?.classList?.add('is-reordering');
    d.rowEl?.classList?.add('is-dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
    return true;
  }

  function updateAccountDragTarget(clientY) {
    const d = state.acctDrag;
    if (!d || !d.started || !Array.isArray(d.rects) || d.fromIdx < 0) return;
    const dragRect = d.rects[d.fromIdx];
    if (!dragRect) return;
    const firstRect = d.rects[0];
    const lastRect = d.rects[d.rects.length - 1];
    const minDeltaY = firstRect.top - dragRect.top - 6;
    const maxDeltaY = lastRect.bottom - dragRect.bottom + 6;
    const rawDeltaY = clientY - d.startY;
    const clampedDeltaY = Math.max(minDeltaY, Math.min(maxDeltaY, rawDeltaY));

    if (d.rowEl?.isConnected) {
      d.rowEl.style.transform = `translate3d(0, ${Math.round(clampedDeltaY * 10) / 10}px, 0) scale(1.01)`;
    }

    const dragCenterY = dragRect.top + dragRect.height / 2 + clampedDeltaY;
    let toIdx = d.fromIdx;
    if (clampedDeltaY > 0) {
      for (let i = d.fromIdx + 1; i < d.rects.length; i++) {
        const r = d.rects[i];
        if (dragCenterY > r.top + r.height / 2) {
          toIdx = i;
        }
      }
    } else if (clampedDeltaY < 0) {
      for (let i = d.fromIdx - 1; i >= 0; i--) {
        const r = d.rects[i];
        if (dragCenterY < r.top + r.height / 2) {
          toIdx = i;
        }
      }
    }
    d.toIdx = toIdx;

    for (let i = 0; i < d.rows.length; i++) {
      if (i === d.fromIdx) continue;
      let offset = 0;
      if (d.fromIdx < toIdx && i > d.fromIdx && i <= toIdx) {
        offset = -d.shiftPx;
      } else if (d.fromIdx > toIdx && i >= toIdx && i < d.fromIdx) {
        offset = d.shiftPx;
      }
      d.rows[i].style.transform = offset ? `translate3d(0, ${Math.round(offset * 10) / 10}px, 0)` : '';
    }
  }

  function commitAccountDrag() {
    const d = state.acctDrag;
    if (!d) return;
    const { started, sourceId, toIdx } = d;
    cleanupAccountDrag();
    if (!started || !sourceId || !Number.isInteger(toIdx) || toIdx < 0) return;
    const list = Array.isArray(state.accounts) ? state.accounts.slice() : [];
    const fromIdx = list.findIndex((a) => a.id === sourceId);
    if (fromIdx < 0 || fromIdx === toIdx) return;
    const [moved] = list.splice(fromIdx, 1);
    const boundedToIdx = Math.max(0, Math.min(list.length, toIdx));
    list.splice(boundedToIdx, 0, moved);
    const orderedIds = list.map((a) => a.id);
    const prevIds = (Array.isArray(state.accounts) ? state.accounts : []).map((a) => a.id);
    if (orderedIds.length === prevIds.length && orderedIds.every((id, idx) => id === prevIds[idx])) {
      return;
    }
    state.accounts = list;
    const tt = document.getElementById('aq-quota-tooltip');
    if (tt) tt.__aqLastHtml = '';
    refreshQuotaTooltipIfVisible();
    sendAccountAction({ type: 'reorder', orderedIds });
  }

  function refreshQuotaTooltipIfVisible() {
    if (state.acctDrag) return;
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

  function syncAccountConfirmButtonsInPlace(tt) {
    if (!tt) return;
    tt.__aqLastHtml = '';
    const batchBtn = tt.querySelector('[data-aq-batch-wake]');
    if (batchBtn && !state.batchKeepAlive?.active) {
      const eligibleCount = Number(state.batchSummary?.eligibleCount || 0);
      batchBtn.classList.toggle('is-warn', Boolean(state.pendingBatchConfirm));
      batchBtn.textContent = state.pendingBatchConfirm ? `确认唤醒 (${eligibleCount})` : '一键唤醒';
    }
    const addBtn = tt.querySelector('[data-aq-acct-add]');
    if (addBtn) {
      const addConfirm = state.pendingSwitchConfirmId === '__add__';
      addBtn.classList.toggle('is-warn', addConfirm);
      addBtn.textContent = addConfirm ? '确认重启' : '+ 登录新号';
    }
    const switchBtns = tt.querySelectorAll('[data-aq-acct-switch]');
    for (let i = 0; i < switchBtns.length; i++) {
      const btn = switchBtns[i];
      const id = btn.getAttribute('data-aq-acct-switch') || '';
      const confirming = Boolean(id && state.pendingSwitchConfirmId === id);
      btn.classList.toggle('aq-q-btn-warn', confirming);
      btn.textContent = confirming ? '确认重启' : '切换';
      btn.setAttribute('title', confirming ? '再次点击确认重启并切换账号' : '切换至此账号');
    }
  }

  function bindQuotaTooltipActions(tt) {
    const batchBtn = tt.querySelector('[data-aq-batch-wake]');
    if (batchBtn) {
      batchBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!state.accountsSupported) return;
        state.quotaTooltipPinned = true;
        if (state.batchKeepAlive?.active) {
          state.pendingBatchConfirm = false;
          if (state.pendingBatchConfirmTimer) {
            clearTimeout(state.pendingBatchConfirmTimer);
            state.pendingBatchConfirmTimer = null;
          }
          sendBatchKeepAliveAction({ type: 'cancel' });
          return;
        }
        const eligibleCount = Number(state.batchSummary?.eligibleCount || 0);
        if (state.accountsBusy || eligibleCount <= 0) return;
        if (!state.pendingBatchConfirm) {
          state.pendingBatchConfirm = true;
          if (state.pendingBatchConfirmTimer) clearTimeout(state.pendingBatchConfirmTimer);
          state.pendingBatchConfirmTimer = setTimeout(() => {
            state.pendingBatchConfirmTimer = null;
            if (state.pendingBatchConfirm) {
              state.pendingBatchConfirm = false;
              syncAccountConfirmButtonsInPlace(document.getElementById('aq-quota-tooltip'));
            }
          }, 3000);
          syncAccountConfirmButtonsInPlace(tt);
          return;
        }
        state.pendingBatchConfirm = false;
        if (state.pendingBatchConfirmTimer) {
          clearTimeout(state.pendingBatchConfirmTimer);
          state.pendingBatchConfirmTimer = null;
        }
        state.accountsError = '';
        sendBatchKeepAliveAction({
          type: 'start',
          profile: state.userProfile,
          quota: buildCurrentQuotaSnapshot(),
        });
      });
    }
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
              syncAccountConfirmButtonsInPlace(document.getElementById('aq-quota-tooltip'));
            }
          }, 3000);
          syncAccountConfirmButtonsInPlace(tt);
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
              syncAccountConfirmButtonsInPlace(document.getElementById('aq-quota-tooltip'));
            }
          }, 3000);
          syncAccountConfirmButtonsInPlace(tt);
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
      row.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0 || state.accountsBusy || !row.classList.contains('is-draggable')) return;
        if (ev.target?.closest?.('button, a, input')) return;
        cleanupAccountDrag();
        const d = {
          sourceId: acctId,
          rowEl: row,
          startX: ev.clientX,
          startY: ev.clientY,
          lastY: ev.clientY,
          started: false,
          timer: null,
        };
        d.timer = setTimeout(() => {
          d.timer = null;
          if (state.acctDrag !== d || d.started) return;
          try {
            window.getSelection?.()?.removeAllRanges?.();
          } catch {}
          if (!startAccountDragSession(d)) {
            cleanupAccountDrag();
            return;
          }
          updateAccountDragTarget(d.lastY);
        }, 240);
        state.acctDrag = d;
      });
      row.addEventListener('pointerenter', () => {
        if (state.acctDrag?.started) return;
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
          if (!row.isConnected || state.acctDrag?.started) return;
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
    const kaToggleBtns = tt.querySelectorAll('[data-aq-ka-toggle]');
    for (let i = 0; i < kaToggleBtns.length; i++) {
      kaToggleBtns[i].addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const poolKey = kaToggleBtns[i].getAttribute('data-aq-ka-toggle') || '';
        if (!poolKey) return;
        state.quotaTooltipPinned = true;
        const prev = Boolean(state.keepAliveState?.pools?.[poolKey]?.enabled);
        const nextEnabled = !prev;
        if (!state.keepAliveState.pools) state.keepAliveState.pools = {};
        const activeEmail = resolveActiveAccountEmail();
        if (activeEmail) {
          state.keepAliveState.accountId = activeEmail.toLowerCase();
        }
        state.keepAliveState.pools[poolKey] = {
          ...(state.keepAliveState.pools[poolKey] || {}),
          enabled: nextEnabled,
          lastError: nextEnabled ? '' : state.keepAliveState.pools[poolKey]?.lastError || '',
          backoffUntil: nextEnabled ? 0 : state.keepAliveState.pools[poolKey]?.backoffUntil || 0,
        };
        sendKeepAliveAction({ type: 'toggle', poolKey, enabled: nextEnabled });
        syncQuotaTooltipKeepAliveInPlace();
        if (nextEnabled) {
          void maybeRunKeepAlives();
        } else {
          scheduleKeepAliveDeadlineTimer();
        }
      });
    }
    const openSettingsBtn = tt.querySelector('[data-aq-key-settings-open]');
    if (openSettingsBtn) {
      openSettingsBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        closeQuotaTooltip();
        openKeySettingsModal();
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

  function closeKeySettingsModal() {
    if (state.keySettingsTimer) {
      clearTimeout(state.keySettingsTimer);
      state.keySettingsTimer = null;
    }
    state.keySettingsOpen = false;
    state.keySettingsSaving = false;
    state.keySettingsRequestId = '';
    document.getElementById('aq-key-settings-modal')?.remove();
  }

  function openKeySettingsModal() {
    closeKeySettingsModal();
    state.keySettingsOpen = true;
    sendUiPrefsAction({ type: 'get' });

    const aiCfg = state.aiConfigMeta || {};
    const overlay = document.createElement('div');
    overlay.id = 'aq-key-settings-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'AI Key 设置');

    const keyPlaceholder =
      !aiCfg.apiKey && aiCfg.hasEnvKey
        ? '当前正使用环境变量 Key，填写后优先使用此处配置'
        : '粘贴智谱 BigModel 或 OpenAI 兼容 API Key';

    overlay.innerHTML = `
      <div class="aq-ks-dialog">
        <div class="aq-ks-hdr">
          <span class="aq-ks-title-wrap">
            <span class="aq-ks-title">AI 简述 / 翻译设置</span>
          </span>
          <button type="button" class="aq-ks-close" data-aq-ks-close="1" title="关闭" aria-label="关闭">×</button>
        </div>
        <div class="aq-ks-field">
          <label class="aq-ks-lbl">API Key（默认免费支持智谱 glm-4-flash-250414）</label>
          <input type="text" class="aq-ks-input" data-aq-ks-key="1" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(keyPlaceholder)}" value="${escapeHtml(aiCfg.apiKey || '')}" />
        </div>
        <div class="aq-ks-row2">
          <div class="aq-ks-field">
            <label class="aq-ks-lbl">模型名称（可选）</label>
            <input type="text" class="aq-ks-input" data-aq-ks-model="1" autocomplete="off" spellcheck="false" placeholder="glm-4-flash-250414" value="${escapeHtml(aiCfg.model || '')}" />
          </div>
          <div class="aq-ks-field">
            <label class="aq-ks-lbl">接口地址（可选）</label>
            <input type="text" class="aq-ks-input" data-aq-ks-endpoint="1" autocomplete="off" spellcheck="false" placeholder="默认智谱官方接口" value="${escapeHtml(aiCfg.endpoint || '')}" />
          </div>
        </div>
        <div class="aq-ks-note">密钥仅以 600 权限保存在本机 ~/.gemini/antigravity/quota-injector/config.json，不进入 Git 仓库。</div>
        <div class="aq-ks-err" data-aq-ks-err="1" hidden></div>
        <div class="aq-ks-ftr">
          <div class="aq-ks-ftr-right">
            <button type="button" class="aq-ks-btn" data-aq-ks-cancel="1">取消</button>
            <button type="button" class="aq-ks-btn is-primary" data-aq-ks-save="1">保存</button>
          </div>
        </div>
      </div>
    `;

    const keyInput = overlay.querySelector('[data-aq-ks-key]');
    const modelInput = overlay.querySelector('[data-aq-ks-model]');
    const endpointInput = overlay.querySelector('[data-aq-ks-endpoint]');
    const errEl = overlay.querySelector('[data-aq-ks-err]');
    const saveBtn = overlay.querySelector('[data-aq-ks-save]');
    let keyEdited = false;

    const showModalError = (msg) => {
      if (!errEl) return;
      const clean = String(msg || '').trim();
      errEl.textContent = clean;
      errEl.hidden = !clean;
    };

    const resetSavingButton = () => {
      state.keySettingsSaving = false;
      state.keySettingsRequestId = '';
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = '保存';
      }
    };

    keyInput?.addEventListener?.('input', () => {
      keyEdited = true;
      keyInput.setAttribute('data-aq-dirty', '1');
    });
    modelInput?.addEventListener?.('input', () => {
      modelInput.setAttribute('data-aq-dirty', '1');
    });
    endpointInput?.addEventListener?.('input', () => {
      endpointInput.setAttribute('data-aq-dirty', '1');
    });

    const submitConfig = () => {
      if (state.keySettingsSaving) return;
      showModalError('');
      const rawKey = String(keyInput?.value || '').trim();
      const rawModel = String(modelInput?.value || '').trim();
      const rawEndpoint = String(endpointInput?.value || '').trim();
      const reqId = `ks-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      state.keySettingsSaving = true;
      state.keySettingsRequestId = reqId;
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中…';
      }
      const sent = sendUiPrefsAction({
        type: 'set-ai-config',
        requestId: reqId,
        apiKey: rawKey,
        model: rawModel,
        endpoint: rawEndpoint,
      });
      if (!sent) {
        resetSavingButton();
        showModalError('后台守护进程未连接，请重启注入器后重试');
        return;
      }
      if (state.keySettingsTimer) clearTimeout(state.keySettingsTimer);
      state.keySettingsTimer = setTimeout(() => {
        state.keySettingsTimer = null;
        if (state.keySettingsOpen && state.keySettingsRequestId === reqId) {
          resetSavingButton();
          showModalError('保存响应超时，请确认注入器后台正在运行');
        }
      }, 4000);
    };

    overlay.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
    });
    overlay.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (ev.target === overlay || ev.target?.closest?.('[data-aq-ks-close], [data-aq-ks-cancel]')) {
        closeKeySettingsModal();
        return;
      }
      if (ev.target?.closest?.('[data-aq-ks-save]')) {
        submitConfig();
      }
    });
    overlay.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeKeySettingsModal();
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        submitConfig();
      }
    });

    document.body.appendChild(overlay);
    setTimeout(() => {
      try {
        if (!keyEdited) keyInput?.focus?.();
      } catch {}
    }, 0);
  }

  function closeQuotaTooltip() {
    cleanupAccountDrag();
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

  function showContextTooltip(chipEl) {
    if (state.ctxTooltipShowTimer) {
      clearTimeout(state.ctxTooltipShowTimer);
      state.ctxTooltipShowTimer = null;
    }
    if (state.ctxTooltipHideTimer) {
      clearTimeout(state.ctxTooltipHideTimer);
      state.ctxTooltipHideTimer = null;
    }
    state.ctxTooltipAnchor = chipEl;
    const tt = ensureTooltipEl('aq-context-tooltip');
    const ctx = getActiveContext();
    const nextHtml = ctx
      ? (() => {
          const pct = Math.min(100, Math.max(0, Math.round((ctx.usedTokens / ctx.maxTokens) * 100)));
          const lvl = contextLevelClass(ctx.usedTokens, ctx.maxTokens);
          return `<div class="aq-ctx-tt-row"><span class="aq-qp-ctx-val"><span class="aq-qp-ctx-strong ${lvl}">${formatContextK(ctx.usedTokens)}</span> / ${formatContextK(ctx.maxTokens)} · ${pct}%</span></div>`;
        })()
      : '<div class="aq-ctx-tt-row"><span class="aq-qp-ctx-val">暂无数据</span></div>';

    if (tt.__aqLastHtml !== nextHtml) {
      tt.__aqLastHtml = nextHtml;
      tt.innerHTML = nextHtml;
    }
    const rect = chipEl.getBoundingClientRect();
    const ttW = tt.offsetWidth || 160;
    const ttH = tt.offsetHeight || 28;
    const left = Math.max(10, Math.min(rect.left + rect.width / 2 - ttW / 2, window.innerWidth - ttW - 12));
    const preferTop = rect.top - ttH - 8;
    const top = preferTop >= 10 ? preferTop : Math.min(window.innerHeight - ttH - 10, rect.bottom + 8);
    tt.style.left = `${Math.round(left)}px`;
    tt.style.top = `${Math.round(Math.max(8, top))}px`;
    tt.setAttribute('data-visible', '1');
  }

  function scheduleHideContextTooltip() {
    if (state.ctxTooltipHideTimer) clearTimeout(state.ctxTooltipHideTimer);
    state.ctxTooltipHideTimer = setTimeout(() => {
      state.ctxTooltipHideTimer = null;
      if (document.querySelector('#aq-context-tooltip:hover')) return;
      const tt = document.getElementById('aq-context-tooltip');
      if (tt) tt.removeAttribute('data-visible');
      state.ctxTooltipAnchor = null;
    }, 140);
  }

  function refreshContextTooltipIfVisible() {
    const tt = document.getElementById('aq-context-tooltip');
    if (!tt || tt.getAttribute('data-visible') !== '1') return;
    const anchor = state.ctxTooltipAnchor?.isConnected
      ? state.ctxTooltipAnchor
      : document.getElementById('aq-context-chip');
    if (!anchor || anchor.style.display === 'none') {
      tt.removeAttribute('data-visible');
      state.ctxTooltipAnchor = null;
      return;
    }
    showContextTooltip(anchor);
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
      ctxChip.setAttribute('role', 'status');
      ctxChip.setAttribute('tabindex', '0');
      ctxChip.setAttribute('aria-label', '当前会话上下文占用');
      bindTooltipTrigger(ctxChip, {
        tooltipId: 'aq-context-tooltip',
        delayMs: QUOTA_TOOLTIP_DELAY_MS,
        showTimerKey: 'ctxTooltipShowTimer',
        hideTimerKey: 'ctxTooltipHideTimer',
        anchorKey: 'ctxTooltipAnchor',
        showFn: showContextTooltip,
        hideFn: scheduleHideContextTooltip,
      });
      ctxChip.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        showContextTooltip(ctxChip);
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
      if (ctxChip.parentElement !== parts.rightGroup || ctxChip.nextElementSibling !== parts.turboBtn) {
        parts.rightGroup.insertBefore(ctxChip, parts.turboBtn);
      }
      if (chip.parentElement !== parts.rightGroup || chip.nextElementSibling !== ctxChip) {
        parts.rightGroup.insertBefore(chip, ctxChip);
      }
    } else {
      if (ctxChip.parentElement !== parts.rightGroup) {
        parts.rightGroup.prepend(ctxChip);
      }
      if (chip.parentElement !== parts.rightGroup || chip.nextElementSibling !== ctxChip) {
        parts.rightGroup.insertBefore(chip, ctxChip);
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
        scheduleRender({ chip: true });
      });
      state.footerObserver.observe(parts.leftGroup, { childList: true, subtree: true, characterData: true });
    }

    if (typeof ResizeObserver === 'function' && parts.footer && state.observedResizeFooter !== parts.footer) {
      if (state.footerResizeObserver) {
        try {
          state.footerResizeObserver.disconnect();
        } catch {}
      }
      state.observedResizeFooter = parts.footer;
      state.footerResizeObserver = new ResizeObserver(() => {
        if (state.chipResizeRaf) return;
        state.chipResizeRaf = requestAnimationFrame(() => {
          state.chipResizeRaf = 0;
          if (!state.disposed) renderQuotaChipContent();
        });
      });
      state.footerResizeObserver.observe(parts.footer);
    }

    renderQuotaChipContent(parts);
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
    try {
      const csrf = window.__APP_CONFIG__?.csrfToken || '';
      const headers = {
        'Content-Type': 'application/json',
        ...(csrf ? { 'x-codeium-csrf-token': csrf } : {}),
      };
      const needUserStatus =
        !state.userProfile ||
        state.clientModelConfigs.length === 0 ||
        includeUserStatus ||
        now - state.userStatusFetchedAt >= 300_000;
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
        if (Array.isArray(us?.cascadeModelConfigData?.clientModelConfigs)) {
          state.clientModelConfigs = us.cascadeModelConfigData.clientModelConfigs;
        }
        const email = String(us?.email || '').trim();
        if (email) {
          state.userStatusFetchedAt = Date.now();
          const planName = resolveUserPlanLabel(us);
          const profileChanged = !state.userProfile || state.userProfile.email?.toLowerCase() !== email.toLowerCase();
          state.userProfile = {
            email,
            name: String(us?.name || '').trim(),
            planName,
          };
          if (
            profileChanged ||
            String(state.keepAliveState?.accountId || '').toLowerCase() !== email.toLowerCase()
          ) {
            sendKeepAliveAction({ type: 'get' });
          }
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
        void maybeRunKeepAlives();
      }
    } catch (err) {
      state.quotaError = String(err?.message || '获取失败');
    } finally {
      state.quotaFetching = false;
      renderQuotaChipContent();
      refreshQuotaTooltipIfVisible();
      void maybeExecuteBatchWakeStep();
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
    '[data-markdown-root], [data-testid="user-message"], [data-testid="user-message-content"], [data-lexical-editor], [data-testid="model-selector-trigger"], [data-aq-turn-usage], [data-aq-thinking-btn], [data-aq-thinking-card], [data-aq-native-menu-ext], .aq-conv-width-resizer, #aq-turn-tooltip, #aq-context-tooltip, #aq-quota-tooltip, #aq-acct-quota-tooltip, #aq-key-settings-modal, #aq-batch-wake-panel, #aq-batch-toast, #aq-context-chip, #aq-quota-chip, #aq-conv-groups, #aq-group-menu, #aq-grp-ctx-menu, #aq-conv-drag-ghost, code, pre, script, style, .codicon, .google-symbols, .agy-sidebar-row';

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

  const TURN_CHROME_SELECTOR = [
    '[data-testid="worked-for-collapsible"]',
    '[data-testid="changed-files-card-header"]',
    '[data-testid="changed-files-card-review"]',
    '[data-testid="cascade-system-message-toolbar"]',
    '[data-testid="user-message-actions"]',
    '[data-testid="turn-cards-container"] button',
  ].join(', ');

  function isProjectFolderNode(el) {
    const span = el?.closest?.('span');
    return Boolean(span && span.querySelector(':scope > [data-project-glyph="folder"]'));
  }

  function translateTextInRoot(root, allowRules = true) {
    const textCache = state.i18nTextCache;
    const attrCache = state.i18nAttrCache;
    if (!root || state.disposed || !textCache || !attrCache || typeof translateUiText !== 'function') return;
    if (root.nodeType === 1 && (root.matches?.(TRANSLATE_SKIP_SELECTOR) || isProjectFolderNode(root))) {
      return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === 1) {
          if (node.matches?.(TRANSLATE_SKIP_SELECTOR) || isProjectFolderNode(node)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      const val = node.nodeValue;
      if (!val) continue;
      const cached = textCache.get(node);
      if (cached && cached.raw === val && (cached.rules || !allowRules)) continue;
      if (!/[A-Za-z]/.test(val)) {
        textCache.set(node, { raw: val, rules: true });
        continue;
      }
      const next = translateUiText(val, allowRules);
      if (next && next !== val) {
        node.nodeValue = next;
        textCache.set(node, { raw: next, rules: true });
      } else {
        textCache.set(node, { raw: val, rules: Boolean(cached?.rules || allowRules) });
      }
    }
    const translateAttrs = (el) => {
      if (!el || el.nodeType !== 1) return;
      let skipChecked = false;
      let elAttrs = attrCache.get(el);
      for (const attr of ['placeholder', 'aria-label', 'title']) {
        const val = el.getAttribute(attr);
        if (!val) continue;
        if (elAttrs && elAttrs[attr] === val) continue;
        if (!elAttrs) {
          elAttrs = Object.create(null);
          attrCache.set(el, elAttrs);
        }
        if (!/[A-Za-z]/.test(val)) {
          elAttrs[attr] = val;
          continue;
        }
        if (!skipChecked) {
          if (el.closest(TRANSLATE_SKIP_SELECTOR) || isProjectFolderNode(el)) {
            elAttrs[attr] = val;
            return;
          }
          skipChecked = true;
        }
        const nextVal = translateUiText(val, false);
        if (nextVal && nextVal !== val) {
          el.setAttribute(attr, nextVal);
          elAttrs[attr] = nextVal;
        } else {
          elAttrs[attr] = val;
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

  function applyUiTranslations({ includeSidebar = true } = {}) {
    const ctrlCache = state.i18nCtrlSigCache;
    if (state.disposed || state.isTranslating || !ctrlCache || typeof translateUiText !== 'function') return;
    state.isTranslating = true;
    try {
      const chromeRoots = document.querySelectorAll(CHROME_ROOT_SELECTOR);
      for (let i = 0; i < chromeRoots.length; i++) {
        const root = chromeRoots[i];
        if (!includeSidebar && root.classList?.contains('bg-sidebar') && root.getAttribute('data-testid') !== 'title-menu-bar') {
          continue;
        }
        translateTextInRoot(root, true);
      }

      const composerBox = document.getElementById('antigravity.agentSidePanelInputBox');
      if (composerBox) {
        const footerContainer = composerBox.parentElement?.parentElement || composerBox.parentElement || composerBox;
        translateTextInRoot(footerContainer, true);
      }

      const turnChrome = document.querySelectorAll(TURN_CHROME_SELECTOR);
      for (let i = 0; i < turnChrome.length; i++) {
        translateTextInRoot(turnChrome[i], true);
      }

      const chromeControls = document.querySelectorAll('button, [role="tab"], [data-testid="title-menu-bar"] *');
      for (let i = 0; i < chromeControls.length; i++) {
        const ctrl = chromeControls[i];
        if (ctrl.closest?.('#aq-conv-groups, #aq-sidebar-tabs, #aq-quota-chip, #aq-context-chip')) continue;
        const txt = ctrl.textContent;
        const aria = ctrl.getAttribute('aria-label');
        const title = ctrl.getAttribute('title');
        const sig = `${txt || ''}\u0000${aria || ''}\u0000${title || ''}`;
        if (ctrlCache.get(ctrl) === sig) continue;
        if (ctrl.closest(TRANSLATE_SKIP_SELECTOR) || isProjectFolderNode(ctrl)) {
          ctrlCache.set(ctrl, sig);
          continue;
        }
        if (
          ctrl.closest('[data-turn-content]') &&
          !ctrl.closest('[data-testid="turn-cards-container"], [data-testid="changed-files-card"], [data-testid="worked-for-collapsible"]')
        ) {
          ctrlCache.set(ctrl, sig);
          continue;
        }
        if ((txt && txt.length <= 60 && /[A-Za-z]/.test(txt)) || (aria && /[A-Za-z]/.test(aria)) || (title && /[A-Za-z]/.test(title))) {
          translateTextInRoot(ctrl, false);
          ctrlCache.set(
            ctrl,
            `${ctrl.textContent || ''}\u0000${ctrl.getAttribute('aria-label') || ''}\u0000${ctrl.getAttribute('title') || ''}`
          );
        } else {
          ctrlCache.set(ctrl, sig);
        }
      }
    } finally {
      state.isTranslating = false;
    }
  }

  function getReactFiberFromElement(el) {
    if (!el || typeof el !== 'object') return null;
    const keys = Object.keys(el);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$')) {
        return el[k];
      }
    }
    return null;
  }

  function isContextMenuFeatureProvider(fiber) {
    const v = fiber?.memoizedProps?.value;
    if (!v || typeof v !== 'object' || typeof v.get !== 'function' || !(v.getCache instanceof Map)) {
      return false;
    }
    try {
      const cms = v.get('contextMenuSystem');
      return Boolean(cms && typeof cms === 'object');
    } catch {
      return false;
    }
  }

  function findSidebarRoot() {
    const convList = document.querySelector('[data-testid="conversation-list-sidebar"]');
    if (convList) {
      const sb = convList.closest('.bg-sidebar');
      if (sb) return sb;
    }
    const navItems = document.querySelector('[data-testid="sidebar-navigation-items"]');
    if (navItems) {
      const sb = navItems.closest('.bg-sidebar');
      if (sb) return sb;
    }
    return document.querySelector('.bg-sidebar:not([data-testid="title-menu-bar"])');
  }

  function findContextMenuFeatureProvider() {
    const startNodes = [
      document.querySelector('[data-testid="conversation-row-sidebar"]'),
      findSidebarRoot(),
    ];
    for (let i = 0; i < startNodes.length; i++) {
      let fib = getReactFiberFromElement(startNodes[i]);
      while (fib) {
        if (isContextMenuFeatureProvider(fib)) return fib;
        fib = fib.return;
      }
    }
    const rootFib = getReactFiberFromElement(document.getElementById('root'));
    if (!rootFib) return null;
    const queue = [rootFib];
    for (let seen = 0; queue.length > 0 && seen < 120; seen++) {
      const cur = queue.shift();
      if (!cur) continue;
      if (isContextMenuFeatureProvider(cur)) return cur;
      if (cur.child) queue.push(cur.child);
      if (cur.sibling) queue.push(cur.sibling);
    }
    return null;
  }

  function bumpContextMenuProvider(provFiber) {
    const val = provFiber?.memoizedProps?.value;
    try {
      val?.getCache?.delete('contextMenuSystem');
    } catch {}
    let ms = provFiber?.return?.memoizedState;
    while (ms) {
      if (typeof ms.memoizedState === 'number' && typeof ms.queue?.dispatch === 'function') {
        try {
          ms.queue.dispatch((prev) => (typeof prev === 'number' ? prev + 1 : 1));
          return true;
        } catch {
          return false;
        }
      }
      ms = ms.next;
    }
    return false;
  }

  /**
   * 禁用 Electron 原生 NSMenu 右键，切回页面 DOM ContextMenu 以便完整汉化菜单与子菜单。
   */
  function ensureWebContextMenuMode() {
    if (state.contextMenuPatched) return true;
    const provFiber = findContextMenuFeatureProvider();
    const val = provFiber?.memoizedProps?.value;
    if (!val) return false;
    const proto = Object.getPrototypeOf(val);
    if (!proto || typeof proto.get !== 'function') return false;
    if (!proto.__aqOrigGet) {
      const origGet = proto.get;
      proto.__aqOrigGet = origGet;
      proto.get = function (name) {
        const res = origGet.call(this, name);
        if (name === 'contextMenuSystem' && res && typeof res === 'object' && res.enabled && res.useNativeMenu) {
          return { ...res, useNativeMenu: false };
        }
        return res;
      };
    }
    state.contextMenuProto = proto;
    state.contextMenuProviderFiber = provFiber;
    bumpContextMenuProvider(provFiber);
    state.contextMenuPatched = true;
    return true;
  }

  const SVG_FOLDER =
    '<svg viewBox="0 -960 960 960" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M172.31-180Q142-180 121-201t-21-51.31V-707.69Q100-738 121-759t51.31-21H391.92l80 80H787.69Q818-700 839-679t21 51.31v375.38Q860-222 839-201t-51.31 21H172.31Zm0-60H787.69q5.39 0 8.85-3.46t3.46-8.85V-627.69q0-5.39-3.46-8.85T787.69-640H447.38l-80-80H172.31q-5.39 0-8.85 3.46T160-707.69v455.38q0 5.39 3.46 8.85t8.85 3.46Z"/></svg>';
  const SVG_CHAT_BUBBLE =
    '<svg viewBox="0 -960 960 960" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M100-100v-667.69Q100-798 121-819t51.31-21h615.38Q818-840 839-819t21 51.31v455.38Q860-282 839-261t-51.31 21H240L100-100Zm115-200h572.69q5.39 0 8.85-3.46t3.46-8.85v-455.38q0-5.39-3.46-8.85T787.69-780H172.31q-5.39 0-8.85 3.46T160-767.69V-245l55-55Z"/></svg>';
  const SVG_FOLDER_OPEN =
    '<svg viewBox="0 -960 960 960" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M172.31-180Q142-180 121-201t-21-51.31V-707.69Q100-738 121-759t51.31-21H391.92l80 80H787.69Q818-700 839-679t21 51.31v50h-60v-50q0-5.39-3.46-8.85T787.69-640H447.38l-80-80H172.31q-5.39 0-8.85 3.46T160-707.69v353.84l58.46-184.61q7.69-24.16 28.15-39.85T292.31-594H860q34.62 0 56.15 27.69t11.77 61.54L843.31-235.38q-7.69 24.15-28.15 39.77Q794.69-180 769.23-180H172.31Zm18.46-60H769.23q6.15 0 11.15-3.85t7-10.38L872.31-518q2.3-6.54-1.73-11.27T860-534H292.31q-6.16 0-11.16 3.85t-7 10.38L190.77-240Z"/></svg>';
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

  function saveAutoUnpinnedCids() {
    try {
      localStorage.setItem('aq_auto_unpinned_cids_v1', JSON.stringify([...state.autoUnpinnedCids]));
    } catch {}
  }

  function markAutoUnpinned(cidLower) {
    if (!cidLower || state.autoUnpinnedCids.has(cidLower)) return;
    state.autoUnpinnedCids.add(cidLower);
    saveAutoUnpinnedCids();
  }

  function unmarkAutoUnpinned(cidLower) {
    if (!cidLower || !state.autoUnpinnedCids.has(cidLower)) return;
    state.autoUnpinnedCids.delete(cidLower);
    saveAutoUnpinnedCids();
  }

  async function updateConversationAnnotationPinnedRpc(cascadeId, pinned) {
    try {
      const csrf = window.__APP_CONFIG__?.csrfToken || '';
      const res = await fetch('/exa.language_server_pb.LanguageServerService/UpdateConversationAnnotations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'x-codeium-csrf-token': csrf } : {}),
        },
        body: JSON.stringify({
          cascadeIds: [cascadeId],
          annotations: { pinned: Boolean(pinned) },
          mergeAnnotations: true,
        }),
      });
      if (res.ok) {
        const meta = state.trajMetaById[String(cascadeId || '').toLowerCase()];
        if (meta) meta.pinned = Boolean(pinned);
        return true;
      }
    } catch {}
    return false;
  }

  function findConversationSidebarRow(cidLower) {
    const rows = document.querySelectorAll(
      '.bg-sidebar [data-testid="conversation-row-sidebar"][data-cascade-id]'
    );
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.closest('[aria-hidden="true"]')) continue;
      if (String(row.getAttribute('data-cascade-id') || '').trim().toLowerCase() === cidLower) {
        return row;
      }
    }
    return null;
  }

  function unpinConversationIfPinned(cascadeId) {
    const cid = String(cascadeId || '').trim();
    const cidLower = cid.toLowerCase();
    if (!/^[0-9a-f-]{36}$/i.test(cidLower)) return false;
    const row = findConversationSidebarRow(cidLower);
    if (row && row.getAttribute('data-pinned') === 'true') {
      const pinBtn = row.querySelector('[data-testid="conversation-pin-button"]');
      if (pinBtn && typeof pinBtn.click === 'function') {
        pinBtn.click();
        return true;
      }
    }
    const meta = state.trajMetaById[cidLower];
    if (meta?.pinned) {
      void updateConversationAnnotationPinnedRpc(meta.cascadeId || cid, false);
      return true;
    }
    return false;
  }

  function restorePinConversation(cascadeId) {
    const cid = String(cascadeId || '').trim();
    const cidLower = cid.toLowerCase();
    if (!/^[0-9a-f-]{36}$/i.test(cidLower)) return false;
    const row = findConversationSidebarRow(cidLower);
    if (row) {
      if (row.getAttribute('data-pinned') === 'true') return true;
      const pinBtn = row.querySelector('[data-testid="conversation-pin-button"]');
      if (pinBtn && typeof pinBtn.click === 'function') {
        pinBtn.click();
        return true;
      }
    }
    const meta = state.trajMetaById[cidLower];
    void updateConversationAnnotationPinnedRpc(meta?.cascadeId || cid, true);
    return true;
  }

  function collectSubtreeItemCids(rootGroupId) {
    const out = [];
    const queue = [String(rootGroupId || '').trim()];
    const seen = new Set();
    while (queue.length > 0) {
      const gid = queue.shift();
      if (!gid || seen.has(gid)) continue;
      seen.add(gid);
      const grp = state.groups.find((g) => g.id === gid);
      if (grp && Array.isArray(grp.items)) {
        for (let i = 0; i < grp.items.length; i++) {
          const cid = String(grp.items[i]?.cascadeId || '').trim().toLowerCase();
          if (/^[0-9a-f-]{36}$/i.test(cid)) out.push(cid);
        }
      }
      for (let i = 0; i < state.groups.length; i++) {
        if (state.groups[i]?.parentId === gid) {
          queue.push(state.groups[i].id);
        }
      }
    }
    return out;
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
      if (type === 'remove-item') {
        const rmCid = String(payload?.cascadeId || '').trim().toLowerCase();
        if (/^[0-9a-f-]{36}$/i.test(rmCid)) {
          state.pendingRestorePinCascadeIds.add(rmCid);
        }
      } else if (type === 'delete') {
        const delCids = collectSubtreeItemCids(payload?.groupId);
        for (let i = 0; i < delCids.length; i++) {
          state.pendingRestorePinCascadeIds.add(delCids[i]);
        }
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
      const unionCids = new Set();
      for (let i = 0; i < kids.length; i++) {
        const g = kids[i];
        if (visited.has(g.id)) continue;
        visited.add(g.id);
        depthById.set(g.id, depth);
        const directItems = Array.isArray(g.items) ? g.items : [];
        const ownCids = new Set();
        for (let j = 0; j < directItems.length; j++) {
          const cidKey = String(directItems[j]?.cascadeId || '').trim().toLowerCase();
          if (cidKey) ownCids.add(cidKey);
        }
        const entry = {
          group: g,
          depth,
          hasChildren: (childrenByParent.get(g.id) || []).length > 0,
          totalCount: ownCids.size,
        };
        orderedFlat.push(entry);
        const subCids = walk(g.id, depth + 1);
        for (const k of subCids) ownCids.add(k);
        const total = ownCids.size;
        entry.totalCount = total;
        totalCountById.set(g.id, total);
        for (const k of ownCids) unionCids.add(k);
      }
      return unionCids;
    };

    walk('', 0);
    return { byId, childrenByParent, depthById, totalCountById, orderedFlat };
  }

  function getNormalizedGroupChildTokens(group, childGroups = []) {
    const items = Array.isArray(group?.items) ? group.items : [];
    const subIds = childGroups.map((cg) => cg.id);
    const subIdSet = new Set(subIds);
    const itemKeys = items
      .map((it) => String(it?.cascadeId || '').trim().toLowerCase())
      .filter(Boolean);
    const itemKeySet = new Set(itemKeys);
    const rawOrder = Array.isArray(group?.childOrder) ? group.childOrder : [];
    const out = [];
    const seen = new Set();
    for (let i = 0; i < rawOrder.length; i++) {
      const tok = String(rawOrder[i] || '').trim();
      if (tok.startsWith('g:')) {
        const sid = tok.slice(2);
        if (subIdSet.has(sid) && !seen.has(tok)) {
          seen.add(tok);
          out.push(tok);
        }
      } else if (tok.startsWith('c:')) {
        const ckey = tok.slice(2).toLowerCase();
        const canon = `c:${ckey}`;
        if (itemKeySet.has(ckey) && !seen.has(canon)) {
          seen.add(canon);
          out.push(canon);
        }
      }
    }
    for (let i = 0; i < subIds.length; i++) {
      const tok = `g:${subIds[i]}`;
      if (!seen.has(tok)) {
        seen.add(tok);
        out.push(tok);
      }
    }
    for (let i = 0; i < itemKeys.length; i++) {
      const tok = `c:${itemKeys[i]}`;
      if (!seen.has(tok)) {
        seen.add(tok);
        out.push(tok);
      }
    }
    return out;
  }

  function getDirectPeerDescriptors(blockEl) {
    if (!blockEl) return [];
    const nodes = blockEl.querySelectorAll(
      ':scope > .aq-grp-children > [data-aq-grp-block], :scope > .aq-grp-children > .aq-grp-item[data-aq-grp-gid]'
    );
    const out = [];
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (el.hasAttribute('data-aq-grp-block')) {
        const gid = el.getAttribute('data-aq-grp-block') || '';
        if (gid) out.push({ kind: 'group', id: gid, token: `g:${gid}`, el });
      } else {
        const cid = el.getAttribute('data-aq-grp-open') || '';
        if (cid) out.push({ kind: 'item', id: cid, token: `c:${cid.toLowerCase()}`, el });
      }
    }
    return out;
  }

  function applyOptimisticChildReorder(groupId, movingToken, anchorToken, mode) {
    const grpIdx = state.groups.findIndex((g) => g.id === groupId);
    if (grpIdx < 0 || !movingToken || !anchorToken || movingToken === anchorToken) return;
    const grp = state.groups[grpIdx];
    const childGroups = state.groups.filter((g) => g.parentId === groupId);
    const curOrder = getNormalizedGroupChildTokens(grp, childGroups);
    if (!curOrder.includes(movingToken) || !curOrder.includes(anchorToken)) return;
    const without = curOrder.filter((tok) => tok !== movingToken);
    const tIdx = without.indexOf(anchorToken);
    if (tIdx < 0) return;
    without.splice(mode === 'before' ? tIdx : tIdx + 1, 0, movingToken);
    if (without.every((tok, idx) => tok === curOrder[idx])) return;

    const itemByKey = new Map(
      (Array.isArray(grp.items) ? grp.items : []).map((it) => [
        String(it.cascadeId || '').toLowerCase(),
        it,
      ])
    );
    const nextItems = without
      .filter((tok) => tok.startsWith('c:'))
      .map((tok) => itemByKey.get(tok.slice(2)))
      .filter(Boolean);
    const orderedSubIds = without.filter((tok) => tok.startsWith('g:')).map((tok) => tok.slice(2));
    const subById = new Map(childGroups.map((cg) => [cg.id, cg]));
    let subCursor = 0;
    const nextGroups = state.groups.map((g, idx) => {
      if (idx === grpIdx) {
        return { ...grp, items: nextItems, childOrder: without };
      }
      if (orderedSubIds.length >= 2 && g.parentId === groupId) {
        return subById.get(orderedSubIds[subCursor++]) || g;
      }
      return g;
    });
    state.groups = nextGroups;
    state.cachedGroupsRef = null;
    state.cachedGroupedCids = null;
    renderSidebarGroupsPanel(false);
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

  function getGroupedCidSet() {
    if (state.cachedGroupedCids && state.cachedGroupsRef === state.groups) {
      return state.cachedGroupedCids;
    }
    const set = new Set();
    for (let i = 0; i < state.groups.length; i++) {
      const items = state.groups[i]?.items || [];
      for (let j = 0; j < items.length; j++) {
        const itemCid = String(items[j]?.cascadeId || '').trim().toLowerCase();
        if (itemCid) set.add(itemCid);
      }
    }
    state.cachedGroupsRef = state.groups;
    state.cachedGroupedCids = set;
    return set;
  }

  function isConversationGrouped(cascadeId) {
    const cid = String(cascadeId || '').trim().toLowerCase();
    if (!cid) return false;
    return getGroupedCidSet().has(cid);
  }

  function isNonProjectSectionId(secId) {
    if (!secId) return true;
    return (
      secId === 'pinned' ||
      secId === 'standalone' ||
      secId === 'all' ||
      secId === 'main-section-header' ||
      secId === 'section-coordinator' ||
      secId.startsWith('convgroup:') ||
      secId.startsWith('status-') ||
      secId.startsWith('location-')
    );
  }

  function readNativeSidebarProjectIndex(sidebar) {
    try {
      const root = sidebar || findSidebarRoot();
      const convList = root?.querySelector?.('[data-testid="conversation-list-sidebar"]');
      if (!convList) {
        return state.cachedNativeProjIndex || { hasFiberItems: false, projectByCid: new Map(), standaloneCids: new Set() };
      }
      let fib = getReactFiberFromElement(convList);
      let items = null;
      for (let i = 0; fib && i < 18; i++, fib = fib.return) {
        if (Array.isArray(fib.memoizedProps?.items)) {
          items = fib.memoizedProps.items;
          break;
        }
      }
      if (!items) {
        return state.cachedNativeProjIndex || { hasFiberItems: false, projectByCid: new Map(), standaloneCids: new Set() };
      }
      if (items === state.cachedNativeItemsRef && state.cachedNativeProjIndex) {
        return state.cachedNativeProjIndex;
      }
      const headerLabelByGroup = new Map();
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it?.type === 'header' && typeof it.id === 'string' && it.label) {
          const gid = it.id.startsWith('header-') ? it.id.slice(7) : it.id;
          if (!isNonProjectSectionId(gid)) {
            headerLabelByGroup.set(gid, String(it.label).trim());
          }
        }
      }
      const projectByCid = new Map();
      const standaloneCids = new Set();
      let currentSectionHeaderLabel = '';
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it?.type === 'header' && typeof it.id === 'string') {
          const gid = it.id.startsWith('header-') ? it.id.slice(7) : it.id;
          currentSectionHeaderLabel = isNonProjectSectionId(gid) ? '' : String(it.label || '').trim();
          continue;
        }
        if (it?.type !== 'row' || !it.cascadeId) continue;
        const cidLower = String(it.cascadeId).trim().toLowerCase();
        const gid = String(it.groupId || it.folderId || '').trim();
        if (gid === 'standalone') {
          standaloneCids.add(cidLower);
        } else if (gid && headerLabelByGroup.has(gid)) {
          projectByCid.set(cidLower, headerLabelByGroup.get(gid));
          standaloneCids.delete(cidLower);
        } else if (!isNonProjectSectionId(gid) && currentSectionHeaderLabel) {
          projectByCid.set(cidLower, currentSectionHeaderLabel);
          standaloneCids.delete(cidLower);
        } else if (!projectByCid.has(cidLower)) {
          standaloneCids.add(cidLower);
        }
      }
      const next = { hasFiberItems: true, projectByCid, standaloneCids };
      state.cachedNativeItemsRef = items;
      state.cachedNativeProjIndex = next;
      return next;
    } catch {
      return state.cachedNativeProjIndex || { hasFiberItems: false, projectByCid: new Map(), standaloneCids: new Set() };
    }
  }

  function findNearestProjectHeaderAbove(row) {
    try {
      const sidebar = row?.closest?.('.bg-sidebar');
      if (!sidebar) return '';
      const secId = row.closest('[data-sidebar-section-id]')?.getAttribute('data-sidebar-section-id') || '';
      if (secId === 'standalone') return '';
      if (secId && !isNonProjectSectionId(secId)) {
        const hdrBtn = sidebar.querySelector(
          `[data-sidebar-section-drop-id="${CSS.escape(secId)}"] [data-project-label]`
        );
        const hdrLabel = String(hdrBtn?.getAttribute('data-project-label') || '').trim();
        if (hdrLabel) return hdrLabel;
      }
      const cidLower = String(row.getAttribute('data-cascade-id') || '').trim().toLowerCase();
      if (cidLower) {
        const idx = readNativeSidebarProjectIndex(sidebar);
        if (idx.standaloneCids.has(cidLower)) return '';
        const mapped = idx.projectByCid.get(cidLower);
        if (mapped) return mapped;
        if (idx.hasFiberItems) return '';
      }
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

  function syncGroupedConversationMetadata(domInfo = null) {
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

    if (domInfo && typeof domInfo === 'object') {
      for (const [key, info] of Object.entries(domInfo)) {
        if (!info) continue;
        const prev = state.trajMetaById[key] || {};
        state.trajMetaById[key] = {
          ...prev,
          title: info.title || prev.title || '',
          project: info.project || prev.project || '',
        };
      }
    } else {
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
      localStorage.setItem(
        'aq_smart_groups_collapsed_v1',
        JSON.stringify({
          active: state.smartActiveCollapsed,
          folders: state.foldersCollapsed,
          recent: state.recentCollapsed,
        })
      );
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

  function applyConversationMaxWidthVar(widthPx = state.convMaxWidth) {
    const val = widthPx > 0 ? `${Math.round(widthPx)}px` : '100%';
    if (document.documentElement.style.getPropertyValue('--aq-conv-max-width') !== val) {
      document.documentElement.style.setProperty('--aq-conv-max-width', val);
    }
  }

  function syncConvWidthLocalCache(widthPx) {
    try {
      localStorage.setItem('aq_conv_max_width_v1', widthPx > 0 ? String(widthPx) : 'full');
      if (widthPx > 0) {
        state.convLastCustomWidth = widthPx;
        localStorage.setItem('aq_conv_last_custom_width_v1', String(widthPx));
      }
    } catch {}
  }

  function saveConversationMaxWidth(widthPx) {
    const clean = widthPx > 0 ? Math.min(MAX_CONV_WIDTH, Math.max(MIN_CONV_WIDTH, Math.round(widthPx))) : 0;
    const mode = clean > 0 ? 'custom' : 'full';
    state.convWidthMode = mode;
    state.convMaxWidth = clean;
    state.uiPrefsMigrated = true;
    applyConversationMaxWidthVar(clean);
    syncConvWidthLocalCache(clean);
    sendUiPrefsAction({ type: 'set-conv-width', mode, width: clean });
  }

  function formatConversationWidthLabel(widthPx) {
    if (!widthPx || widthPx <= 0) return '自适应 100%';
    if (Math.round(widthPx) === DEFAULT_CONV_WIDTH) return `${DEFAULT_CONV_WIDTH}px · 默认`;
    return `${Math.round(widthPx)}px`;
  }

  function findConversationComposerBox(viewEl) {
    if (!viewEl) return null;
    return viewEl.querySelector('#antigravity\\.agentSidePanelInputBox, .surface-composer');
  }

  function findActiveConversationColumn(viewEl) {
    if (!viewEl) return null;
    const composer = findConversationComposerBox(viewEl);
    if (composer) {
      const col = composer.closest('[style*="--max-conversation-width"]');
      if (col) return col;
    }
    const candidates = viewEl.querySelectorAll('[style*="--max-conversation-width"]');
    let best = null;
    let bestArea = 0;
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
    return best;
  }

  function computeConversationAvailBounds(viewEl, colEl) {
    const viewRect = viewEl.getBoundingClientRect();
    const parent = colEl?.parentElement || viewEl;
    const parentRect = parent.getBoundingClientRect();
    const pcs = getComputedStyle(parent);
    const padL = parseFloat(pcs.paddingLeft) || 0;
    const padR = parseFloat(pcs.paddingRight) || 0;
    const availLeft = parentRect.left + padL;
    const availWidth = Math.max(MIN_CONV_WIDTH, Math.round(parentRect.width - padL - padR));
    const centerX = availLeft + availWidth / 2;
    return { viewRect, availLeft, availWidth, centerX };
  }

  function flashConversationWidthBadge(resizerEl, text) {
    if (!resizerEl) return;
    const badge = resizerEl.querySelector('[data-aq-conv-width-badge]');
    if (!badge) return;
    badge.textContent = text;
    resizerEl.classList.add('is-flash');
    if (state.convWidthBadgeTimer) clearTimeout(state.convWidthBadgeTimer);
    state.convWidthBadgeTimer = setTimeout(() => {
      state.convWidthBadgeTimer = null;
      resizerEl.classList.remove('is-flash');
      if (!resizerEl.classList.contains('is-resizing')) {
        badge.textContent = '';
      }
    }, 900);
  }

  function ensureConversationWidthResizers() {
    applyConversationMaxWidthVar(state.convMaxWidth);
    const views = document.querySelectorAll('[data-testid="conversation-view"]');
    for (let i = 0; i < views.length; i++) {
      const viewEl = views[i];
      const composerBox = findConversationComposerBox(viewEl);
      if (!composerBox) continue;
      for (const side of ['left', 'right']) {
        let handle = composerBox.querySelector(`:scope > .aq-conv-width-resizer[data-aq-conv-resizer="${side}"]`);
        if (handle && handle.dataset.aqOwner !== INSTANCE_TOKEN) {
          handle.remove();
          handle = null;
        }
        if (!handle) {
          handle = document.createElement('div');
          handle.className = 'aq-conv-width-resizer';
          handle.dataset.aqOwner = INSTANCE_TOKEN;
          handle.setAttribute('data-aq-conv-resizer', side);
          handle.innerHTML = '<span class="aq-conv-width-badge" data-aq-conv-width-badge="1"></span>';
          handle.addEventListener('pointerenter', () => {
            if (state.convWidthHoverTimer) {
              clearTimeout(state.convWidthHoverTimer);
              state.convWidthHoverTimer = null;
            }
            if (viewEl.classList.contains('aq-conv-width-armed') || state.convWidthDrag) return;
            state.convWidthHoverTimer = setTimeout(() => {
              state.convWidthHoverTimer = null;
              if (handle.isConnected && viewEl.isConnected) {
                viewEl.classList.add('aq-conv-width-armed');
                handle.setAttribute('title', '左右拖动调整会话宽度（拉到边缘自动铺满，双击切换默认/铺满）');
              }
            }, 300);
          });
          handle.addEventListener('pointerleave', () => {
            if (state.convWidthHoverTimer) {
              clearTimeout(state.convWidthHoverTimer);
              state.convWidthHoverTimer = null;
            }
            handle.removeAttribute('title');
            if (!state.convWidthDrag) {
              viewEl.classList.remove('aq-conv-width-armed');
            }
          });
          handle.addEventListener('dblclick', (ev) => {
            if (!viewEl.classList.contains('aq-conv-width-armed')) return;
            ev.preventDefault();
            ev.stopPropagation();
            cleanupConversationWidthDrag();
            const nextW = state.convMaxWidth === DEFAULT_CONV_WIDTH ? 0 : DEFAULT_CONV_WIDTH;
            saveConversationMaxWidth(nextW);
            if (!handle.matches(':hover')) {
              viewEl.classList.remove('aq-conv-width-armed');
            }
            flashConversationWidthBadge(handle, formatConversationWidthLabel(nextW));
          });
          composerBox.appendChild(handle);
        }
      }
    }
  }

  function cleanupConversationWidthDrag({ commit = false } = {}) {
    const drag = state.convWidthDrag;
    if (!drag) return;
    state.convWidthDrag = null;
    if (state.convWidthDragRaf) {
      cancelAnimationFrame(state.convWidthDragRaf);
      state.convWidthDragRaf = 0;
    }
    document.body.classList.remove('aq-resizing-conv-width');
    drag.viewEl?.classList?.remove('aq-conv-width-active');
    if (drag.resizerEl?.isConnected) {
      drag.resizerEl.classList.remove('is-resizing');
      const badge = drag.resizerEl.querySelector('[data-aq-conv-width-badge]');
      if (badge) badge.textContent = '';
    }
    if (Array.isArray(drag.targetCols)) {
      for (let i = 0; i < drag.targetCols.length; i++) {
        const entry = drag.targetCols[i];
        if (entry?.el?.isConnected) {
          entry.el.style.setProperty('max-width', entry.origMaxWidth);
        }
      }
    }
    if (commit && drag.moved) {
      saveConversationMaxWidth(drag.currentWidth);
    } else {
      applyConversationMaxWidthVar(state.convMaxWidth);
    }
    if (drag.moved && !drag.resizerEl?.matches?.(':hover')) {
      drag.viewEl?.classList?.remove('aq-conv-width-armed');
    }
  }

  function isActiveComposerBusy() {
    const box = document.getElementById('antigravity.agentSidePanelInputBox');
    return Boolean(box && box.querySelector(COMPOSER_BUSY_SELECTOR));
  }

  function clearPostSendRefreshTimers() {
    for (let i = 0; i < state.postSendRefreshTimers.length; i++) {
      clearTimeout(state.postSendRefreshTimers[i]);
    }
    state.postSendRefreshTimers.length = 0;
  }

  function schedulePostSendTrajectoryRefreshes(delays) {
    clearPostSendRefreshTimers();
    for (let i = 0; i < delays.length; i++) {
      const delay = delays[i];
      const timer = setTimeout(() => {
        const idx = state.postSendRefreshTimers.indexOf(timer);
        if (idx !== -1) state.postSendRefreshTimers.splice(idx, 1);
        if (!document.hidden) {
          void refreshTrajectoryMetadata(false, 400);
        }
      }, delay);
      state.postSendRefreshTimers.push(timer);
    }
  }

  function scheduleOptimisticExpiry() {
    if (state.optimisticExpiryTimer) {
      clearTimeout(state.optimisticExpiryTimer);
      state.optimisticExpiryTimer = null;
    }
    const now = Date.now();
    let minRemain = 0;
    for (const [key, opt] of state.optimisticRunningById.entries()) {
      if (opt.sawBackendRunning) continue;
      if (now >= opt.until) {
        if (!isActiveComposerBusy() || extractCascadeId().toLowerCase() !== key) {
          state.optimisticRunningById.delete(key);
        }
        continue;
      }
      const remain = opt.until - now + 30;
      if (!minRemain || remain < minRemain) {
        minRemain = remain;
      }
    }
    if (minRemain > 0) {
      state.optimisticExpiryTimer = setTimeout(() => {
        state.optimisticExpiryTimer = null;
        scheduleOptimisticExpiry();
        renderSidebarGroupsPanel();
      }, minRemain);
    }
  }

  function markConversationSendStarted(cid) {
    const now = Date.now();
    const rawCid = String(cid || '').trim();
    const cidLower = rawCid.toLowerCase();
    if (!cidLower) {
      state.pendingNewChatSendAt = now;
      schedulePostSendTrajectoryRefreshes([600, 2000]);
      return;
    }
    state.pendingNewChatSendAt = 0;
    state.optimisticRunningById.set(cidLower, {
      cascadeId: rawCid,
      startedAt: now,
      until: now + OPTIMISTIC_SEND_GRACE_MS,
      sawBackendRunning: false,
    });
    state.localUserInputAtById[cidLower] = now;
    const meta = state.trajMetaById[cidLower];
    if (meta) {
      meta.lastUserInputMs = Math.max(meta.lastUserInputMs || 0, now);
    }
    scheduleOptimisticExpiry();
    schedulePostSendTrajectoryRefreshes([600, 2000]);
    if (state.postSendTurnsTimer) clearTimeout(state.postSendTurnsTimer);
    state.postSendTurnsTimer = setTimeout(() => {
      state.postSendTurnsTimer = null;
      if (state.disposed) return;
      if (typeof window.__aqRequestTurns === 'function' && extractCascadeId().toLowerCase() === cidLower) {
        try {
          window.__aqRequestTurns(rawCid);
        } catch {}
      }
      scheduleRender({ turns: true });
    }, 350);
    renderSidebarGroupsPanel();
  }

  function markConversationSendCanceled(cid) {
    const cidLower = String(cid || '').trim().toLowerCase();
    if (cidLower) {
      state.optimisticRunningById.delete(cidLower);
    }
    state.pendingNewChatSendAt = 0;
    scheduleOptimisticExpiry();
    schedulePostSendTrajectoryRefreshes([300, 1200]);
    renderSidebarGroupsPanel();
  }

  function collectAllConversationStates(activeCid) {
    const domStatus = Object.create(null);
    const domInfo = Object.create(null);
    const domOrder = Object.create(null);
    const rank = { idle: 0, unread: 1, running: 2, waiting: 3 };
    const rows = document.querySelectorAll('.bg-sidebar [data-testid="conversation-row-sidebar"][data-cascade-id]');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.closest('[aria-hidden="true"]')) continue;
      const cid = String(row.getAttribute('data-cascade-id') || '').toLowerCase();
      if (!cid) continue;
      if (!(cid in domOrder)) domOrder[cid] = i;
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

    const now = Date.now();
    const composerBusy = Boolean(activeCid && isActiveComposerBusy());
    if (composerBusy !== state.wasComposerBusy) {
      const ended = state.wasComposerBusy && !composerBusy;
      state.wasComposerBusy = composerBusy;
      if (ended && !document.hidden) {
        schedulePostSendTrajectoryRefreshes([250]);
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
        if (cid) {
          allPrimaryCids.add(cid);
        }
      }
    }
    for (const [cid, opt] of state.optimisticRunningById.entries()) {
      if (!opt.sawBackendRunning && now >= opt.until && !(composerBusy && cid === activeCid)) {
        state.optimisticRunningById.delete(cid);
        continue;
      }
      const meta = state.trajMetaById[cid];
      if (meta && (meta.archived || !meta.isPrimary)) continue;
      allPrimaryCids.add(cid);
    }
    if (composerBusy && activeCid) {
      const activeMeta = state.trajMetaById[activeCid];
      if (!activeMeta || (!activeMeta.archived && activeMeta.isPrimary)) {
        allPrimaryCids.add(activeCid);
      }
    }

    const nativeProjIdx = readNativeSidebarProjectIndex(findSidebarRoot());
    const activeItems = [];
    const recentCandidates = [];
    for (const cid of allPrimaryCids) {
      if (state.hiddenKeepAliveCids.has(cid)) continue;
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

      const opt = state.optimisticRunningById.get(cid) || null;
      const hasOptimistic = Boolean(opt && !opt.sawBackendRunning && now < opt.until);
      const hasLiveComposer = Boolean(composerBusy && cid === activeCid);
      if ((hasLiveComposer || hasOptimistic) && status !== 'waiting') {
        status = 'running';
      }
      if (status) {
        statusById[cid] = status;
      }

      // Only list primary / sidebar-visible conversations inside smart & recent groups
      const canShowUnindexed = Boolean((hasLiveComposer || hasOptimistic) && (!meta || meta.isPrimary) && !meta?.archived);
      if (!(cid in domStatus) && !(meta?.isPrimary && !meta?.archived) && !canShowUnindexed) continue;

      const dInfo = domInfo[cid];
      const title =
        (dInfo?.title && dInfo.title !== '未命名对话' ? dInfo.title : '') ||
        meta?.title ||
        dInfo?.title ||
        (canShowUnindexed ? '新对话' : '未命名对话');
      const project = nativeProjIdx.standaloneCids.has(cid)
        ? ''
        : dInfo?.project || nativeProjIdx.projectByCid.get(cid) || meta?.project || '';
      const localInputAt = state.localUserInputAtById[cid] || 0;
      const freshLocalInputMs =
        localInputAt && now - localInputAt < 300_000 ? localInputAt : 0;
      const lastUserInputMs = Math.max(
        meta?.lastUserInputMs || 0,
        opt?.startedAt || 0,
        freshLocalInputMs
      );
      const resolvedItem = {
        cascadeId: dInfo?.cascadeId || meta?.cascadeId || opt?.cascadeId || cid,
        title,
        project,
        status,
        lastModifiedMs: Math.max(meta?.lastModifiedMs || 0, opt?.startedAt || 0),
        lastUserInputMs,
        domIndex: cid in domOrder ? domOrder[cid] : 99999,
      };
      if (status) {
        activeItems.push(resolvedItem);
      }
      recentCandidates.push(resolvedItem);
    }

    const orderPriority = { waiting: 3, unread: 2, running: 1 };
    activeItems.sort((a, b) => {
      const pa = orderPriority[a.status] || 0;
      const pb = orderPriority[b.status] || 0;
      if (pa !== pb) return pb - pa;
      return (b.lastModifiedMs || 0) - (a.lastModifiedMs || 0);
    });

    recentCandidates.sort((a, b) => {
      if ((b.lastUserInputMs || 0) !== (a.lastUserInputMs || 0)) {
        return (b.lastUserInputMs || 0) - (a.lastUserInputMs || 0);
      }
      return a.domIndex - b.domIndex;
    });
    const recentItems = recentCandidates.slice(0, 10);
    state.latestSidebarDomInfo = domInfo;

    return { statusById, activeItems, recentItems };
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
      const [res, bgRes] = await Promise.all([
        fetch('/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories', {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
        }),
        fetch('/exa.language_server_pb.LanguageServerService/ListBackgroundTasks', {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
        }).catch(() => null),
      ]);
      if (!res.ok) return;
      const [json, bgJson] = await Promise.all([
        res.json().catch(() => null),
        bgRes && bgRes.ok ? bgRes.json().catch(() => null) : Promise.resolve(null),
      ]);
      const bgTasks = Array.isArray(bgJson?.tasks) ? bgJson.tasks : [];
      const nonDaemonTaskCids = new Set();
      for (let i = 0; i < bgTasks.length; i++) {
        const entryTask = bgTasks[i];
        const taskCid = String(entryTask?.conversationId || '').trim().toLowerCase();
        if (!taskCid || !entryTask?.task) continue;
        if (entryTask.task.isDaemon === true) continue;
        nonDaemonTaskCids.add(taskCid);
      }
      const map = json?.trajectorySummaries || {};
      const nextById = Object.create(null);
      for (const [cid, entry] of Object.entries(map)) {
        if (!/^[0-9a-f-]{36}$/i.test(cid) || !entry || typeof entry !== 'object') continue;
        const key = cid.toLowerCase();
        if (state.hiddenKeepAliveCids.has(key)) continue;
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
        const pinned = Boolean(entry.annotations?.pinned);
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
        const serverUserInputMs =
          Date.parse(entry.lastUserInputTime || '') ||
          Date.parse(entry.createdTime || '') ||
          0;
        let lastUserViewMs = Date.parse(entry.annotations?.lastUserViewTime || '') || 0;
        let markedAsUnread = Boolean(entry.annotations?.markedAsUnread);
        const localViewedAt = state.localViewedAtById[key] || 0;
        if (localViewedAt && Date.now() - localViewedAt < 60_000) {
          if (localViewedAt > lastUserViewMs) lastUserViewMs = localViewedAt;
          if (lastModifiedMs <= localViewedAt) markedAsUnread = false;
        }
        const prev = state.trajMetaById[key] || {};
        const localInputAt = state.localUserInputAtById[key] || 0;
        if (localInputAt && serverUserInputMs >= localInputAt) {
          delete state.localUserInputAtById[key];
        }
        const lastUserInputMs =
          localInputAt && Date.now() - localInputAt < 300_000
            ? Math.max(serverUserInputMs, localInputAt)
            : serverUserInputMs;
        nextById[key] = {
          cascadeId: cid,
          title: title || prev.title || '',
          project: project || prev.project || '',
          archived,
          pinned,
          killed,
          isPrimary,
          parentId,
          waiting,
          running,
          bgTaskRunning: !killed && nonDaemonTaskCids.has(key),
          subagentWaiting: false,
          subagentRunning: false,
          markedAsUnread,
          lastModifiedMs,
          lastUserInputMs,
          lastUserViewMs,
        };
      }
      // Bubble subagent waiting/running/non-daemon background task state up to root parent conversation
      for (const item of Object.values(nextById)) {
        if (!item.parentId || item.killed || (!item.waiting && !item.running && !item.bgTaskRunning)) continue;
        let curParentId = item.parentId;
        const visited = new Set();
        while (curParentId && !visited.has(curParentId)) {
          visited.add(curParentId);
          const parent = nextById[curParentId];
          if (!parent) break;
          if (item.waiting) parent.subagentWaiting = true;
          if (item.running || item.bgTaskRunning) parent.subagentRunning = true;
          curParentId = parent.parentId;
        }
      }
      state.trajMetaById = nextById;
      state.nonDaemonBgTaskCids = nonDaemonTaskCids;
      const nowMeta = Date.now();
      for (const [key, opt] of state.optimisticRunningById.entries()) {
        const meta = nextById[key];
        if (meta) {
          if (
            meta.running ||
            meta.waiting ||
            meta.subagentRunning ||
            meta.subagentWaiting ||
            meta.bgTaskRunning
          ) {
            opt.sawBackendRunning = true;
          } else if (opt.sawBackendRunning || nowMeta >= opt.until) {
            state.optimisticRunningById.delete(key);
          }
        } else if (nowMeta >= opt.until) {
          state.optimisticRunningById.delete(key);
        }
      }
      scheduleOptimisticExpiry();
      syncGroupedConversationMetadata();
      renderSidebarGroupsPanel();
      const watchedCidLower = extractCascadeId().toLowerCase();
      if (
        watchedCidLower &&
        (state.liveTurnTimer !== null ||
          state.liveTurnMainIdleSince > 0 ||
          hasActiveConversationAsyncWork(watchedCidLower))
      ) {
        scheduleRender({ turns: true });
      }
    } catch {}
  }

  function clearGroupDeleteConfirm() {
    state.groupDeleteConfirmId = '';
    if (state.groupDeleteConfirmTimer) {
      clearTimeout(state.groupDeleteConfirmTimer);
      state.groupDeleteConfirmTimer = null;
    }
  }

  function buildConversationInfoById(cascadeId, anchorEl = null) {
    const cidLower = String(cascadeId || '').trim().toLowerCase();
    const row = findConversationSidebarRow(cidLower);
    const meta = state.trajMetaById[cidLower];
    if (row) {
      const info = extractRowConversationInfo(row);
      if (info) return info;
    }
    return {
      cascadeId: meta?.cascadeId || String(cascadeId || '').trim(),
      title:
        meta?.title ||
        anchorEl?.querySelector?.('.aq-grp-item-title')?.textContent?.trim() ||
        '未命名对话',
      project: meta?.project || anchorEl?.getAttribute?.('data-aq-project') || '',
    };
  }

  function openNativeConversationContextMenu(cascadeId, clientX, clientY) {
    const cidLower = String(cascadeId || '').trim().toLowerCase();
    if (!cidLower) return false;
    const row = findConversationSidebarRow(cidLower);
    const kebab = row?.querySelector?.('[data-testid="conversation-kebab"]');
    if (!kebab || typeof kebab.click !== 'function') {
      return false;
    }
    state.lastNativeMenuConv = {
      ...buildConversationInfoById(cidLower),
      at: Date.now(),
    };
    kebab.click();
    let tries = 0;
    const positionMenu = () => {
      const menu = document.querySelector('[role="menu"]');
      if (menu) {
        const posEl = menu.closest('[style*="transform"]') || menu.parentElement;
        if (posEl) {
          const mr = menu.getBoundingClientRect();
          const mw = mr.width || 180;
          const mh = mr.height || 220;
          const left = Math.max(8, Math.min(Math.round(clientX), window.innerWidth - mw - 8));
          const top = Math.max(8, Math.min(Math.round(clientY), window.innerHeight - mh - 8));
          posEl.style.left = '0px';
          posEl.style.top = '0px';
          posEl.style.transform = `translate(${left}px, ${top}px)`;
        }
        syncNativeConversationMenus();
        applyUiTranslations();
        return;
      }
      if (tries++ < 5) {
        requestAnimationFrame(positionMenu);
      }
    };
    requestAnimationFrame(positionMenu);
    return true;
  }

  function closeGroupCtxMenu() {
    const el = document.getElementById('aq-grp-ctx-menu');
    if (el) el.classList.remove('is-visible');
  }

  function openGroupCtxMenu(clientX, clientY, { groupId = '', depth = 0, item = null, itemGroupId = '' } = {}) {
    closeGroupMenu();
    let menu = document.getElementById('aq-grp-ctx-menu');
    if (menu && menu.dataset.aqOwner !== INSTANCE_TOKEN) {
      menu.remove();
      menu = null;
    }
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'aq-grp-ctx-menu';
      menu.dataset.aqOwner = INSTANCE_TOKEN;
      document.body.appendChild(menu);
      menu.addEventListener('click', (ev) => {
        const btn = ev.target?.closest?.('[data-aq-ctx-act]');
        if (!btn) return;
        ev.preventDefault();
        ev.stopPropagation();
        const act = btn.getAttribute('data-aq-ctx-act') || '';
        const gid = btn.getAttribute('data-aq-ctx-gid') || '';
        const cid = btn.getAttribute('data-aq-ctx-cid') || '';
        closeGroupCtxMenu();
        if (act === 'new-root') {
          triggerNewTopFolder();
        } else if (act === 'new-child' && gid) {
          state.groupsError = '';
          state.groupRenamingId = '';
          clearGroupDeleteConfirm();
          state.groupCreateInitialItem = null;
          state.groupCreateParentId = gid;
          state.groupCreating = true;
          renderSidebarGroupsPanel(true);
        } else if (act === 'rename' && gid) {
          state.groupsError = '';
          state.groupCreating = false;
          state.groupCreateParentId = '';
          state.groupCreateInitialItem = null;
          clearGroupDeleteConfirm();
          state.groupRenamingId = gid;
          renderSidebarGroupsPanel(true);
        } else if (act === 'delete' && gid) {
          state.groupsError = '';
          sendGroupAction({ type: 'delete', groupId: gid });
        } else if (act === 'remove-from-group' && gid && cid) {
          state.groupsError = '';
          sendGroupAction({ type: 'remove-item', groupId: gid, cascadeId: cid });
        } else if (act === 'item-menu' && cid) {
          const anchor = document.querySelector(`#aq-conv-groups [data-aq-grp-open="${cid}"]`);
          const info = buildConversationInfoById(cid, anchor);
          if (anchor) {
            openGroupMenu(anchor, info);
          }
        }
      });
    }

    const actionsHtml = [];
    if (groupId) {
      if (depth < MAX_GROUP_DEPTH - 1) {
        actionsHtml.push(
          `<button type="button" class="aq-ctx-item" data-aq-ctx-act="new-child" data-aq-ctx-gid="${escapeHtml(groupId)}">${SVG_FOLDER_PLUS}<span>新建子文件夹</span></button>`
        );
      }
      actionsHtml.push(
        `<button type="button" class="aq-ctx-item" data-aq-ctx-act="new-root">${SVG_PLUS}<span>新建根文件夹</span></button>`,
        '<div class="aq-ctx-sep"></div>',
        `<button type="button" class="aq-ctx-item" data-aq-ctx-act="rename" data-aq-ctx-gid="${escapeHtml(groupId)}">${SVG_EDIT}<span>重命名</span></button>`,
        `<button type="button" class="aq-ctx-item is-danger" data-aq-ctx-act="delete" data-aq-ctx-gid="${escapeHtml(groupId)}">${SVG_CLOSE}<span>删除文件夹</span></button>`
      );
    } else {
      if (item?.cascadeId) {
        actionsHtml.push(
          `<button type="button" class="aq-ctx-item" data-aq-ctx-act="item-menu" data-aq-ctx-cid="${escapeHtml(item.cascadeId)}">${SVG_FOLDER_PLUS}<span>加入文件夹</span></button>`
        );
        if (itemGroupId) {
          actionsHtml.push(
            `<button type="button" class="aq-ctx-item" data-aq-ctx-act="remove-from-group" data-aq-ctx-cid="${escapeHtml(item.cascadeId)}" data-aq-ctx-gid="${escapeHtml(itemGroupId)}">${SVG_CLOSE}<span>移出此文件夹</span></button>`
          );
        }
        actionsHtml.push('<div class="aq-ctx-sep"></div>');
      }
      actionsHtml.push(
        `<button type="button" class="aq-ctx-item" data-aq-ctx-act="new-root">${SVG_FOLDER_PLUS}<span>新建根文件夹</span></button>`
      );
    }

    menu.innerHTML = actionsHtml.join('');
    menu.classList.add('is-visible');
    const mRect = menu.getBoundingClientRect();
    const mw = mRect.width || 160;
    const mh = mRect.height || 100;
    const left = Math.max(8, Math.min(clientX, window.innerWidth - mw - 8));
    const top = Math.max(8, Math.min(clientY, window.innerHeight - mh - 8));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function closeGroupMenu() {
    state.groupMenuTarget = null;
    document.querySelectorAll('[data-aq-menu-open]').forEach((el) => el.removeAttribute('data-aq-menu-open'));
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

  function getConversationAssignedGroups(cascadeId) {
    const cidLower = String(cascadeId || '').trim().toLowerCase();
    if (!cidLower) return [];
    const tree = buildGroupTreeIndex(state.groups);
    const matched = [];
    for (let i = 0; i < tree.orderedFlat.length; i++) {
      const g = tree.orderedFlat[i]?.group;
      const items = Array.isArray(g?.items) ? g.items : [];
      if (items.some((it) => String(it?.cascadeId || '').toLowerCase() === cidLower)) {
        matched.push(g);
      }
    }
    return matched;
  }

  function buildFolderPickerBodyHtml(
    cascadeId,
    headerText,
    preservedValue,
    { toggleAttr, inputAttr, btnAttr }
  ) {
    const cidLower = String(cascadeId || '').trim().toLowerCase();
    const tree = buildGroupTreeIndex(state.groups);
    const listHtml = tree.orderedFlat.length
      ? tree.orderedFlat
          .map(({ group: g, depth }) => {
            const items = Array.isArray(g.items) ? g.items : [];
            const checked = items.some((it) => String(it?.cascadeId || '').toLowerCase() === cidLower);
            const indentPx = 6 + depth * 14;
            const branchHtml = depth > 0 ? '<span class="aq-gm-tree-branch">↳</span>' : '';
            return `
              <button type="button" class="aq-gm-opt ${checked ? 'is-checked' : ''}" ${toggleAttr}="${escapeHtml(g.id)}" style="padding-left:${indentPx}px">
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
    return `
      <div class="aq-gm-hdr" title="${escapeHtml(headerText)}">${escapeHtml(headerText)}</div>
      <div class="aq-gm-list">${listHtml}</div>
      ${errHtml}
      <div class="aq-gm-create">
        <input type="text" class="aq-grp-input" ${inputAttr}="1" maxlength="48" placeholder="新分组名，回车创建" value="${escapeHtml(preservedValue)}" />
        <button type="button" class="aq-grp-mini-btn is-primary" ${btnAttr}="1">新建</button>
      </div>
    `;
  }

  function renderGroupMenuContent() {
    const menu = document.getElementById('aq-group-menu');
    const target = state.groupMenuTarget;
    if (!menu || !target || !menu.classList.contains('is-visible')) return;
    const prevInput = menu.querySelector('input[data-aq-gm-input]');
    const preservedValue = prevInput ? prevInput.value : '';
    const hadFocus = Boolean(prevInput && document.activeElement === prevInput);
    menu.innerHTML = buildFolderPickerBodyHtml(
      target.cascadeId,
      `归组：${target.title}`,
      preservedValue,
      {
        toggleAttr: 'data-aq-gm-toggle',
        inputAttr: 'data-aq-gm-input',
        btnAttr: 'data-aq-gm-create-btn',
      }
    );
    if (hadFocus) {
      const nextInput = menu.querySelector('input[data-aq-gm-input]');
      if (nextInput) {
        nextInput.focus();
        nextInput.setSelectionRange(nextInput.value.length, nextInput.value.length);
      }
    }
  }

  function resolveNativeMenuConversation() {
    const expandedKebab = document.querySelector(
      '.bg-sidebar [data-testid="conversation-kebab"][aria-expanded="true"], .bg-sidebar [data-testid="conversation-kebab"][data-popup-open]'
    );
    const expandedRow = expandedKebab?.closest?.('[data-testid="conversation-row-sidebar"][data-cascade-id]');
    if (expandedRow) {
      const info = extractRowConversationInfo(expandedRow);
      if (info?.cascadeId) return info;
    }
    if (state.lastNativeMenuConv?.cascadeId && Date.now() - (state.lastNativeMenuConv.at || 0) < 8000) {
      return {
        cascadeId: state.lastNativeMenuConv.cascadeId,
        title: state.lastNativeMenuConv.title || '未命名对话',
        project: state.lastNativeMenuConv.project || '',
      };
    }
    return null;
  }

  function closeNativeBaseUiMenu(menu) {
    try {
      const portal = menu?.closest?.('[data-base-ui-portal]');
      const backdrop = portal?.querySelector?.('[data-base-ui-inert]');
      if (backdrop) {
        backdrop.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
        backdrop.click?.();
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    } catch {}
  }

  function positionNativeFolderSubmenu(entryEl, subEl) {
    if (!entryEl || !subEl) return;
    subEl.classList.remove('is-left');
    subEl.style.top = '-4px';
    const rect = entryEl.getBoundingClientRect();
    const sRect = subEl.getBoundingClientRect();
    const sw = sRect.width || 224;
    const sh = sRect.height || 180;
    if (rect.right + 6 + sw > window.innerWidth - 8 && rect.left - 6 - sw >= 8) {
      subEl.classList.add('is-left');
    }
    if (rect.top - 4 + sh > window.innerHeight - 8) {
      const shift = Math.max(-rect.top + 8, window.innerHeight - 8 - (rect.top + sh));
      subEl.style.top = `${Math.round(shift)}px`;
    }
  }

  function renderNativeFolderEntryContent(entryEl, rmEl, convInfo) {
    if (!entryEl || !convInfo?.cascadeId) return;
    const assigned = getConversationAssignedGroups(convInfo.cascadeId);
    const labelText = assigned.length > 0 ? '管理文件夹' : '加入文件夹';
    const countBadge = assigned.length > 0 ? `<span class="aq-nmf-count">${assigned.length}</span>` : '';
    const subEl = entryEl.querySelector('.aq-native-folder-sub');
    const wasOpen = Boolean(subEl?.classList.contains('is-open'));
    const prevInput = subEl?.querySelector('input[data-aq-nmf-input]');
    const preservedValue = prevInput ? prevInput.value : '';
    const hadFocus = Boolean(prevInput && document.activeElement === prevInput);

    const lblSpan = entryEl.querySelector('.aq-nmf-label');
    if (lblSpan) lblSpan.textContent = labelText;
    const badgeSlot = entryEl.querySelector('.aq-nmf-badge-slot');
    if (badgeSlot) badgeSlot.innerHTML = countBadge;

    if (subEl) {
      subEl.innerHTML = buildFolderPickerBodyHtml(
        convInfo.cascadeId,
        `归组：${convInfo.title || '未命名对话'}`,
        preservedValue,
        {
          toggleAttr: 'data-aq-nmf-toggle',
          inputAttr: 'data-aq-nmf-input',
          btnAttr: 'data-aq-nmf-create',
        }
      );
      if (wasOpen) {
        subEl.classList.add('is-open');
        positionNativeFolderSubmenu(entryEl, subEl);
      }
      if (hadFocus) {
        const nextInp = subEl.querySelector('input[data-aq-nmf-input]');
        if (nextInp) {
          nextInp.focus();
          nextInp.setSelectionRange(nextInp.value.length, nextInp.value.length);
        }
      }
    }

    if (rmEl) {
      if (assigned.length > 0) {
        rmEl.style.display = '';
        rmEl.removeAttribute('aria-hidden');
        rmEl.setAttribute('role', 'menuitem');
        const rmTxt =
          assigned.length === 1
            ? `移出「${assigned[0].name}」`
            : `移出全部文件夹 (${assigned.length})`;
        const rmSpan = rmEl.querySelector('.aq-nmf-rm-label');
        if (rmSpan) rmSpan.textContent = rmTxt;
      } else {
        rmEl.style.display = 'none';
        rmEl.setAttribute('aria-hidden', 'true');
        rmEl.removeAttribute('role');
      }
    }
  }

  function refreshOpenNativeMenuFolders() {
    const menus = document.querySelectorAll('[role="menu"]');
    for (let i = 0; i < menus.length; i++) {
      const menu = menus[i];
      const entryEl = menu.querySelector('.aq-native-folder-entry');
      if (!entryEl) continue;
      const cid = entryEl.getAttribute('data-aq-nmf-cid') || '';
      if (!cid) continue;
      const convInfo = buildConversationInfoById(cid);
      const rmEl = menu.querySelector('.aq-native-folder-rm-btn');
      renderNativeFolderEntryContent(entryEl, rmEl, convInfo);
    }
  }

  function syncNativeConversationMenus() {
    const menus = document.querySelectorAll('[data-base-ui-portal] [role="menu"]');
    for (let i = 0; i < menus.length; i++) {
      const menu = menus[i];
      if (menu.matches('[data-testid="context-menu-submenu-popup"]')) continue;
      if (menu.querySelector('[data-aq-native-menu-ext]')) continue;
      const isConvMenu = Boolean(
        menu.querySelector(
          '[data-testid="conversation-rename-menu-item"], [data-testid="conversation-pin-menu-item"], [data-testid="conversation-delete-menu-item"]'
        )
      );
      if (!isConvMenu) continue;
      const convInfo = resolveNativeMenuConversation();
      if (!convInfo?.cascadeId) continue;

      const sep = document.createElement('div');
      sep.setAttribute('data-orientation', 'horizontal');
      sep.setAttribute('role', 'separator');
      sep.setAttribute('aria-orientation', 'horizontal');
      sep.setAttribute('data-aq-native-menu-ext', '1');
      sep.className = 'h-px bg-border my-1 -mx-1';

      const entryEl = document.createElement('div');
      entryEl.setAttribute('role', 'menuitem');
      entryEl.setAttribute('tabindex', '-1');
      entryEl.setAttribute('data-aq-native-menu-ext', '1');
      entryEl.setAttribute('data-aq-nmf-cid', convInfo.cascadeId);
      entryEl.className =
        'agy-overlay-item group w-full pr-2 pl-1.5 text-left text-compact cursor-pointer outline-none no-focus-ring transition-colors select-none flex items-center rounded-md py-1 gap-1.5 hover:bg-secondary hover:text-foreground text-secondary-foreground justify-between aq-native-folder-entry';
      entryEl.innerHTML = `
        <span class="flex items-center gap-1.5 min-w-0 flex-1 truncate">${SVG_FOLDER_PLUS}<span class="truncate aq-nmf-label">加入文件夹</span></span>
        <span class="flex items-center gap-1 shrink-0 pl-1"><span class="aq-nmf-badge-slot"></span><span class="opacity-50 flex items-center">${SVG_CHEVRON}</span></span>
        <div class="aq-native-folder-sub" data-aq-native-folder-sub="1"></div>
      `;

      const rmEl = document.createElement('div');
      rmEl.setAttribute('role', 'menuitem');
      rmEl.setAttribute('tabindex', '-1');
      rmEl.setAttribute('data-aq-native-menu-ext', '1');
      rmEl.className =
        'agy-overlay-item group w-full pr-2 pl-1.5 text-left text-compact cursor-pointer outline-none no-focus-ring transition-colors select-none flex items-center rounded-md py-1 gap-1.5 hover:bg-secondary hover:text-foreground text-secondary-foreground aq-native-folder-rm-btn';
      rmEl.innerHTML = `${SVG_CLOSE}<span class="truncate aq-nmf-rm-label">移出文件夹</span>`;

      renderNativeFolderEntryContent(entryEl, rmEl, convInfo);

      const subEl = entryEl.querySelector('.aq-native-folder-sub');
      let hoverCloseTimer = null;
      const openSub = () => {
        if (hoverCloseTimer) {
          clearTimeout(hoverCloseTimer);
          hoverCloseTimer = null;
        }
        if (!subEl) return;
        subEl.classList.add('is-open');
        positionNativeFolderSubmenu(entryEl, subEl);
      };
      const scheduleCloseSub = () => {
        if (hoverCloseTimer) clearTimeout(hoverCloseTimer);
        hoverCloseTimer = setTimeout(() => {
          subEl?.classList.remove('is-open');
        }, 120);
      };

      entryEl.addEventListener('pointerenter', openSub);
      entryEl.addEventListener('pointerleave', scheduleCloseSub);
      entryEl.addEventListener('click', (ev) => {
        if (ev.target?.closest?.('.aq-native-folder-sub')) return;
        ev.preventDefault();
        ev.stopPropagation();
        openSub();
        if (!state.groups.length) {
          subEl?.querySelector('input[data-aq-nmf-input]')?.focus();
        }
      });

      if (subEl) {
        for (const evtName of ['pointerdown', 'mousedown', 'click', 'keydown', 'keyup', 'keypress']) {
          subEl.addEventListener(evtName, (ev) => {
            if (evtName === 'keydown' && ev.key === 'Escape') {
              return;
            }
            ev.stopPropagation();
          });
        }
        subEl.addEventListener('click', (ev) => {
          const opt = ev.target?.closest?.('[data-aq-nmf-toggle]');
          if (opt) {
            ev.preventDefault();
            const groupId = opt.getAttribute('data-aq-nmf-toggle') || '';
            if (!groupId) return;
            const latestConv = buildConversationInfoById(convInfo.cascadeId);
            if (opt.classList.contains('is-checked')) {
              sendGroupAction({ type: 'remove-item', groupId, cascadeId: latestConv.cascadeId });
            } else {
              sendGroupAction({ type: 'add-item', groupId, item: latestConv });
            }
            return;
          }
          const createBtn = ev.target?.closest?.('[data-aq-nmf-create]');
          if (createBtn) {
            ev.preventDefault();
            const inp = subEl.querySelector('input[data-aq-nmf-input]');
            const name = String(inp?.value || '').trim();
            if (!name) {
              inp?.focus();
              return;
            }
            sendGroupAction({ type: 'create', name, item: buildConversationInfoById(convInfo.cascadeId) });
            if (inp) inp.value = '';
          }
        });
        subEl.addEventListener('keydown', (ev) => {
          const inp = ev.target?.closest?.('input[data-aq-nmf-input]');
          if (!inp) return;
          if (ev.key === 'Enter') {
            ev.preventDefault();
            const name = String(inp.value || '').trim();
            if (!name) return;
            sendGroupAction({ type: 'create', name, item: buildConversationInfoById(convInfo.cascadeId) });
            inp.value = '';
          }
        });
      }

      rmEl.addEventListener('pointerenter', () => subEl?.classList.remove('is-open'));
      rmEl.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const assigned = getConversationAssignedGroups(convInfo.cascadeId);
        for (let j = 0; j < assigned.length; j++) {
          sendGroupAction({ type: 'remove-item', groupId: assigned[j].id, cascadeId: convInfo.cascadeId });
        }
        closeNativeBaseUiMenu(menu);
      });

      const firstSep = menu.querySelector(':scope > [role="separator"]');
      if (firstSep) {
        menu.insertBefore(sep, firstSep);
        menu.insertBefore(entryEl, firstSep);
        menu.insertBefore(rmEl, firstSep);
      } else {
        menu.appendChild(sep);
        menu.appendChild(entryEl);
        menu.appendChild(rmEl);
      }

      menu.addEventListener('pointerover', (ev) => {
        const otherItem = ev.target?.closest?.('[role="menuitem"]:not([data-aq-native-menu-ext])');
        if (otherItem) {
          subEl?.classList.remove('is-open');
        }
      });
    }
  }

  function openGroupMenu(anchorEl, conversationInfo) {
    if (!anchorEl || !conversationInfo?.cascadeId) return;
    document.querySelectorAll('[data-aq-menu-open]').forEach((el) => el.removeAttribute('data-aq-menu-open'));
    anchorEl.setAttribute('data-aq-menu-open', '1');
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
    if (state.convDragLongPressTimer) {
      clearTimeout(state.convDragLongPressTimer);
      state.convDragLongPressTimer = null;
    }
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

  function cleanupConversationPointerDrag(opts = {}) {
    clearConvDragExpandTimer();
    if (state.convDragRaf) {
      cancelAnimationFrame(state.convDragRaf);
      state.convDragRaf = 0;
    }
    const d = state.convDrag;
    state.convDrag = null;
    if (d?.started) {
      d.sourceEl?.classList?.remove('is-dragging');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
    document.body.classList.remove('aq-conv-dragging', 'aq-dragging-to-group');
    const panel = document.getElementById('aq-conv-groups');
    if (panel) {
      panel.classList.remove('aq-grp-panel-drop-target');
      panel
        .querySelectorAll(
          '.aq-grp-drop-target, .aq-grp-drag-before, .aq-grp-drag-after, .aq-grp-drag-inside, .aq-grp-drag-root, .aq-grp-item-drag-before, .aq-grp-item-drag-after'
        )
        .forEach((el) =>
          el.classList.remove(
            'aq-grp-drop-target',
            'aq-grp-drag-before',
            'aq-grp-drag-after',
            'aq-grp-drag-inside',
            'aq-grp-drag-root',
            'aq-grp-item-drag-before',
            'aq-grp-item-drag-after'
          )
        );
    }
    const ghost = document.getElementById('aq-conv-drag-ghost');
    if (ghost) ghost.classList.remove('is-visible');
    if (d?.switchedFromProjects && !opts.keepTab) {
      state.sidebarTab = 'projects';
      const sidebar = findSidebarRoot();
      if (sidebar) syncSidebarTabState(sidebar);
    }
  }

  function activateConversationPointerDrag(d) {
    if (!d || d.started || state.convDrag !== d) return;
    if (state.convDragLongPressTimer) {
      clearTimeout(state.convDragLongPressTimer);
      state.convDragLongPressTimer = null;
    }
    d.started = true;
    closeGroupMenu();
    closeGroupCtxMenu();
    document.body.classList.add('aq-conv-dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
    if (d.mode === 'native-row' && state.sidebarTab === 'projects') {
      d.switchedFromProjects = true;
      state.sidebarTab = 'groups';
      const sidebar = findSidebarRoot();
      if (sidebar) syncSidebarTabState(sidebar);
      if (state.groupsCollapsedSection) {
        state.groupsCollapsedSection = false;
        renderSidebarGroupsPanel(true);
      }
    } else if (
      d.mode === 'group-item' ||
      d.mode === 'group-folder' ||
      d.sourceEl?.closest?.('#aq-conv-groups')
    ) {
      d.sourceEl?.classList?.add('is-dragging');
    }
  }

  function startConversationPointerDrag({ mode, sourceGroupId = '', sourceEl = null, item, startX, startY }) {
    if (!item?.cascadeId) return;
    cleanupConversationPointerDrag({ keepTab: true });
    const d = {
      mode,
      sourceGroupId,
      sourceEl,
      item,
      startX,
      startY,
      lastX: startX,
      lastY: startY,
      started: false,
      switchedFromProjects: false,
      overPanel: false,
      overGroupId: '',
      overEmptyPanel: false,
      folderDragMode: '',
      folderTargetId: '',
      folderTargetCid: '',
      itemDropMode: '',
      itemTargetCid: '',
      itemTargetGroupId: '',
    };
    state.convDrag = d;
    if (mode === 'native-row' && state.sidebarTab === 'projects') {
      state.convDragLongPressTimer = setTimeout(() => {
        state.convDragLongPressTimer = null;
        if (state.convDrag !== d || d.started) return;
        activateConversationPointerDrag(d);
        updateConversationDragTarget(d.lastX, d.lastY);
      }, 260);
    }
  }

  function autoScrollGroupsBodyOnDrag(panel, clientY) {
    const bodyEl = panel?.querySelector?.('.aq-grp-body');
    if (!bodyEl || bodyEl.scrollHeight <= bodyEl.clientHeight + 2) return false;
    const rect = bodyEl.getBoundingClientRect();
    if (rect.height <= 0) return false;
    const prevTop = bodyEl.scrollTop;
    const edgePx = Math.min(26, Math.floor(rect.height * 0.22));
    if (clientY >= rect.top - 8 && clientY < rect.top + edgePx && prevTop > 0) {
      const ratio = Math.min(1, (rect.top + edgePx - clientY) / Math.max(1, edgePx));
      bodyEl.scrollTop = Math.max(0, prevTop - Math.ceil(2 + ratio * 6));
    } else if (
      clientY > rect.bottom - edgePx &&
      clientY <= rect.bottom + 8 &&
      prevTop + bodyEl.clientHeight < bodyEl.scrollHeight
    ) {
      const ratio = Math.min(1, (clientY - (rect.bottom - edgePx)) / Math.max(1, edgePx));
      bodyEl.scrollTop = Math.min(
        bodyEl.scrollHeight - bodyEl.clientHeight,
        prevTop + Math.ceil(2 + ratio * 6)
      );
    }
    return bodyEl.scrollTop !== prevTop;
  }

  function scheduleConvDragAutoScrollTick() {
    if (!state.convDragRaf && !state.disposed && state.convDrag?.started) {
      state.convDragRaf = requestAnimationFrame(() => {
        state.convDragRaf = 0;
        const active = state.convDrag;
        if (!state.disposed && active?.started) {
          updateConversationDragTarget(active.lastX, active.lastY);
        }
      });
    }
  }

  function resolvePeerInsertHit(peers, fromIdx, clientY) {
    if (!Array.isArray(peers) || peers.length < 2 || fromIdx < 0) return null;
    const rects = peers.map((p) => p.el.getBoundingClientRect());
    const fRect = rects[0];
    const lRect = rects[rects.length - 1];
    if (fRect.height > 0 && clientY < fRect.top) {
      return fromIdx > 0 ? { peer: peers[0], mode: 'before' } : null;
    }
    if (lRect.height > 0 && clientY > lRect.bottom) {
      return fromIdx < peers.length - 1 ? { peer: peers[peers.length - 1], mode: 'after' } : null;
    }
    let hitIdx = -1;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (r.height > 0 && clientY >= r.top - 1 && clientY <= r.bottom + 1) {
        hitIdx = i;
        break;
      }
    }
    if (hitIdx < 0 || hitIdx === fromIdx) return null;
    const r = rects[hitIdx];
    if (hitIdx === fromIdx + 1) {
      return clientY >= r.top + r.height * 0.2 ? { peer: peers[hitIdx], mode: 'after' } : null;
    }
    if (hitIdx === fromIdx - 1) {
      return clientY <= r.bottom - r.height * 0.2 ? { peer: peers[hitIdx], mode: 'before' } : null;
    }
    return {
      peer: peers[hitIdx],
      mode: clientY <= r.top + r.height / 2 ? 'before' : 'after',
    };
  }

  function updateFolderDragTarget(d, panel, clientX, clientY) {
    const dragId = d.sourceGroupId;
    const dragGrp = state.groups.find((g) => g.id === dragId);
    const ghost = ensureConvDragGhostEl();
    if (!dragGrp || !panel || !panel.isConnected) {
      if (panel) {
        panel
          .querySelectorAll(
            '.aq-grp-drag-before, .aq-grp-drag-after, .aq-grp-drag-inside, .aq-grp-drag-root, .aq-grp-item-drag-before, .aq-grp-item-drag-after'
          )
          .forEach((el) =>
            el.classList.remove(
              'aq-grp-drag-before',
              'aq-grp-drag-after',
              'aq-grp-drag-inside',
              'aq-grp-drag-root',
              'aq-grp-item-drag-before',
              'aq-grp-item-drag-after'
            )
          );
      }
      d.folderDragMode = '';
      d.folderTargetId = '';
      d.folderTargetCid = '';
      ghost.classList.remove('is-visible');
      return;
    }

    // 1. Scroll & read layout bounds BEFORE mutating classes to avoid forced synchronous reflow
    const didScroll = autoScrollGroupsBodyOnDrag(panel, clientY);
    let nextMode = '';
    let nextTargetId = '';
    let nextTargetCid = '';
    let highlightEl = null;
    let highlightClass = '';

    const smartHdr = panel.querySelector('[data-aq-smart-hdr]');
    if (smartHdr && dragGrp.parentId) {
      const sRect = smartHdr.getBoundingClientRect();
      if (
        sRect.height > 0 &&
        clientY >= sRect.top - 4 &&
        clientY <= sRect.bottom + 4 &&
        clientX >= sRect.left - 8 &&
        clientX <= sRect.right + 8
      ) {
        nextMode = 'root';
        highlightEl = smartHdr;
        highlightClass = 'aq-grp-drag-root';
      }
    }

    if (!nextMode) {
      const tree = buildGroupTreeIndex(state.groups);
      const dragHeight = getGroupSubtreeHeight(tree.childrenByParent, dragId);
      const bodyEl = panel.querySelector('.aq-grp-body');
      const bodyRect = bodyEl?.getBoundingClientRect?.();
      const topWrap = panel.querySelector('.aq-grp-top-wrap') || panel;
      const tRect = topWrap.getBoundingClientRect();
      const inHoriz =
        tRect.width > 0 && clientX >= tRect.left - 8 && clientX <= tRect.right + 8;
      const inBodyVert =
        !bodyRect || bodyRect.height <= 0
          ? true
          : clientY >= bodyRect.top - 2 && clientY <= bodyRect.bottom + 2;

      let bestBlock = null;
      let bestDepth = -1;
      if (inHoriz && inBodyVert) {
        const blocks = panel.querySelectorAll('[data-aq-grp-block]');
        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i];
          const bRect = b.getBoundingClientRect();
          if (bRect.height <= 0) continue;
          if (
            clientY >= bRect.top - 1 &&
            clientY <= bRect.bottom + 1 &&
            clientX >= bRect.left - 8 &&
            clientX <= bRect.right + 8
          ) {
            const depth = Number.parseInt(b.getAttribute('data-aq-grp-depth') || '0', 10) || 0;
            if (depth >= bestDepth) {
              bestDepth = depth;
              bestBlock = b;
            }
          }
        }
      }

      if (bestBlock) {
        const targetId = bestBlock.getAttribute('data-aq-grp-block') || '';
        if (targetId && targetId === (dragGrp.parentId || '')) {
          // Pointer is inside the dragged subfolder's own expanded parent folder:
          // allow mixed sorting with sibling conversations/subfolders without ejecting out to outer level
          const ownPeers = getDirectPeerDescriptors(bestBlock);
          const fromPeerIdx = ownPeers.findIndex((p) => p.token === `g:${dragId}`);
          const parentHdr = bestBlock.querySelector(':scope > [data-aq-grp-hdr]');
          const phRect = parentHdr?.getBoundingClientRect?.();
          if (phRect && phRect.height > 0 && clientY <= phRect.bottom) {
            const rel = (clientY - phRect.top) / phRect.height;
            const ownParentGrp = tree.byId.get(targetId);
            const outerParentId = ownParentGrp?.parentId || '';
            const outerParentDepth = outerParentId ? (tree.depthById.get(outerParentId) ?? 0) : -1;
            const canPullBeforeParent = outerParentDepth + 1 + dragHeight < MAX_GROUP_DEPTH;
            if (rel <= 0.5 && canPullBeforeParent) {
              nextMode = 'before';
              nextTargetId = targetId;
              highlightEl = bestBlock;
              highlightClass = 'aq-grp-drag-before';
            } else if (rel > 0.5 && ownPeers.length >= 2 && fromPeerIdx > 0) {
              const firstPeer = ownPeers[0];
              nextMode = 'before';
              highlightEl = firstPeer.el;
              if (firstPeer.kind === 'group') {
                nextTargetId = firstPeer.id;
                highlightClass = 'aq-grp-drag-before';
              } else {
                nextTargetCid = firstPeer.id;
                highlightClass = 'aq-grp-item-drag-before';
              }
            }
          } else {
            const peerHit = resolvePeerInsertHit(ownPeers, fromPeerIdx, clientY);
            if (peerHit) {
              nextMode = peerHit.mode;
              highlightEl = peerHit.peer.el;
              if (peerHit.peer.kind === 'group') {
                nextTargetId = peerHit.peer.id;
                highlightClass =
                  peerHit.mode === 'before' ? 'aq-grp-drag-before' : 'aq-grp-drag-after';
              } else {
                nextTargetCid = peerHit.peer.id;
                highlightClass =
                  peerHit.mode === 'before' ? 'aq-grp-item-drag-before' : 'aq-grp-item-drag-after';
              }
            }
          }
        } else if (targetId && targetId !== dragId && !isGroupDescendant(state.groups, dragId, targetId)) {
          const targetDepth = tree.depthById.get(targetId) ?? 0;
          const canNestInside =
            (dragGrp.parentId || '') !== targetId && targetDepth + 1 + dragHeight < MAX_GROUP_DEPTH;
          const targetGrp = tree.byId.get(targetId);
          const targetParentId = targetGrp?.parentId || '';
          const targetParentDepth = targetParentId ? (tree.depthById.get(targetParentId) ?? 0) : -1;
          const canBeSibling = targetParentDepth + 1 + dragHeight < MAX_GROUP_DEPTH;
          const sameParent = (dragGrp.parentId || '') === targetParentId;
          let fromSibIdx = -1;
          let toSibIdx = -1;
          if (sameParent) {
            if (targetParentId) {
              const parentGrp = tree.byId.get(targetParentId);
              const peerTokens = getNormalizedGroupChildTokens(
                parentGrp,
                tree.childrenByParent.get(targetParentId) || []
              );
              fromSibIdx = peerTokens.indexOf(`g:${dragId}`);
              toSibIdx = peerTokens.indexOf(`g:${targetId}`);
            } else {
              const rootSiblings = tree.childrenByParent.get('') || [];
              fromSibIdx = rootSiblings.findIndex((g) => g.id === dragId);
              toSibIdx = rootSiblings.findIndex((g) => g.id === targetId);
            }
          }
          const isBeforeNoop = sameParent && fromSibIdx >= 0 && toSibIdx === fromSibIdx + 1;
          const isAfterNoop = sameParent && fromSibIdx >= 0 && toSibIdx === fromSibIdx - 1;

          const hdr = bestBlock.querySelector(':scope > [data-aq-grp-hdr]');
          const hRect = hdr?.getBoundingClientRect?.();
          let mode = '';
          if (hRect && hRect.height > 0 && clientY <= hRect.bottom) {
            const rel = (clientY - hRect.top) / hRect.height;
            if (!canNestInside) {
              if (isBeforeNoop) {
                mode = rel >= 0.22 ? 'after' : '';
              } else if (isAfterNoop) {
                mode = rel <= 0.78 ? 'before' : '';
              } else {
                mode = rel <= 0.5 ? 'before' : 'after';
              }
            } else if (isBeforeNoop) {
              if (rel >= 0.55) mode = 'after';
              else if (rel >= 0.18) mode = 'inside';
            } else if (isAfterNoop) {
              if (rel <= 0.45) mode = 'before';
              else if (rel <= 0.82) mode = 'inside';
            } else if (rel <= 0.32) {
              mode = 'before';
            } else if (rel < 0.68) {
              mode = 'inside';
            } else {
              mode = 'after';
            }
          } else if (!isAfterNoop) {
            mode = 'after';
          }

          if ((mode === 'before' || mode === 'after') && !canBeSibling) {
            mode = canNestInside ? 'inside' : '';
          }
          if (mode) {
            nextMode = mode;
            nextTargetId = targetId;
            highlightEl = bestBlock;
            highlightClass =
              mode === 'inside'
                ? 'aq-grp-drag-inside'
                : mode === 'before'
                  ? 'aq-grp-drag-before'
                  : 'aq-grp-drag-after';
          }
        }
      } else if (
        inHoriz &&
        tRect.height > 0 &&
        clientY >= tRect.top - 6 &&
        clientY <= tRect.bottom + 8 &&
        dragHeight < MAX_GROUP_DEPTH
      ) {
        const topBlocks = bodyEl ? [...bodyEl.querySelectorAll(':scope > [data-aq-grp-block]')] : [];
        if (topBlocks.length > 0) {
          const firstBlock = topBlocks[0];
          const firstId = firstBlock.getAttribute('data-aq-grp-block') || '';
          const fRect = firstBlock.getBoundingClientRect();
          const lastBlock = topBlocks[topBlocks.length - 1];
          const lastId = lastBlock.getAttribute('data-aq-grp-block') || '';
          const lRect = lastBlock.getBoundingClientRect();
          if (fRect.height > 0 && clientY < fRect.top && firstId && firstId !== dragId) {
            nextMode = 'before';
            nextTargetId = firstId;
            highlightEl = firstBlock;
            highlightClass = 'aq-grp-drag-before';
          } else if (lRect.height > 0 && clientY > lRect.bottom && lastId && lastId !== dragId) {
            nextMode = 'after';
            nextTargetId = lastId;
            highlightEl = lastBlock;
            highlightClass = 'aq-grp-drag-after';
          }
        }
      }
    }

    // 2. Write DOM classes in one batch
    panel
      .querySelectorAll(
        '.aq-grp-drag-before, .aq-grp-drag-after, .aq-grp-drag-inside, .aq-grp-drag-root, .aq-grp-item-drag-before, .aq-grp-item-drag-after'
      )
      .forEach((el) =>
        el.classList.remove(
          'aq-grp-drag-before',
          'aq-grp-drag-after',
          'aq-grp-drag-inside',
          'aq-grp-drag-root',
          'aq-grp-item-drag-before',
          'aq-grp-item-drag-after'
        )
      );
    if (highlightEl && highlightClass) {
      highlightEl.classList.add(highlightClass);
    }

    d.folderDragMode = nextMode;
    d.folderTargetId = nextTargetId;
    d.folderTargetCid = nextTargetCid;

    let badgeText = '';
    if (nextMode === 'root') {
      badgeText = '移至顶层';
    } else if (nextTargetCid && dragGrp.parentId) {
      const pGrp = state.groups.find((g) => g.id === dragGrp.parentId);
      const tItem = pGrp?.items?.find(
        (it) => String(it.cascadeId || '').toLowerCase() === nextTargetCid.toLowerCase()
      );
      const rawTitle = String(tItem?.title || '').trim();
      const shortTitle = rawTitle.length > 5 ? `${rawTitle.slice(0, 4)}…` : rawTitle;
      badgeText = shortTitle
        ? `移到 ${shortTitle} ${nextMode === 'before' ? '前' : '后'}`
        : nextMode === 'before'
          ? '移至上方'
          : '移至下方';
    } else if (nextTargetId) {
      const tGrp = state.groups.find((g) => g.id === nextTargetId);
      if (tGrp?.name) {
        const shortName = tGrp.name.length > 6 ? `${tGrp.name.slice(0, 5)}…` : tGrp.name;
        badgeText =
          nextMode === 'inside'
            ? `放入 ${shortName}`
            : nextMode === 'before'
              ? `移到 ${shortName} 前`
              : `移到 ${shortName} 后`;
      }
    }

    const ghostSig = `folder|${d.item.title}|${badgeText}`;
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
    if (didScroll) scheduleConvDragAutoScrollTick();
  }

  function updateConversationDragTarget(clientX, clientY) {
    const d = state.convDrag;
    if (!d || !d.started) return;
    d.lastX = clientX;
    d.lastY = clientY;
    const panel = document.getElementById('aq-conv-groups');
    if (d.mode === 'group-folder') {
      updateFolderDragTarget(d, panel, clientX, clientY);
      return;
    }
    if (!panel || !panel.isConnected) {
      d.overPanel = false;
      d.overGroupId = '';
      d.overEmptyPanel = false;
      d.itemDropMode = '';
      d.itemTargetCid = '';
      d.itemTargetGroupId = '';
      document.body.classList.remove('aq-dragging-to-group');
      const ghost = document.getElementById('aq-conv-drag-ghost');
      if (ghost) ghost.classList.remove('is-visible');
      return;
    }

    // 1. Read layout bounds BEFORE mutating classes to avoid forced synchronous reflow
    const pRect = panel.getBoundingClientRect();
    const inPanel =
      pRect.width > 0 &&
      pRect.height > 0 &&
      clientX >= pRect.left - 8 &&
      clientX <= pRect.right + 8 &&
      clientY >= pRect.top - 4 &&
      clientY <= pRect.bottom + 4;

    const didScroll = inPanel ? autoScrollGroupsBodyOnDrag(panel, clientY) : false;

    const topWrap = panel.querySelector('.aq-grp-top-wrap') || panel;
    const tRect = topWrap.getBoundingClientRect();
    const inTopArea =
      tRect.width > 0 &&
      tRect.height > 0 &&
      clientX >= tRect.left - 8 &&
      clientX <= tRect.right + 8 &&
      clientY >= tRect.top - 4 &&
      clientY <= tRect.bottom + 4;

    const bodyEl = panel.querySelector('.aq-grp-body');
    const bodyRect = bodyEl?.getBoundingClientRect?.();
    const inGroupsBody =
      inTopArea &&
      (!bodyRect || bodyRect.height <= 0 || (clientY >= bodyRect.top - 2 && clientY <= bodyRect.bottom + 2));

    const allBlocks = panel.querySelectorAll('[data-aq-grp-block]');
    let rawHitGroupId = '';
    if (inGroupsBody) {
      let bestDepth = -1;
      for (let i = 0; i < allBlocks.length; i++) {
        const b = allBlocks[i];
        const bRect = b.getBoundingClientRect();
        if (bRect.height <= 0) continue;
        if (clientY >= bRect.top - 1 && clientY <= bRect.bottom + 1) {
          const depth = Number.parseInt(b.getAttribute('data-aq-grp-depth') || '0', 10) || 0;
          if (depth >= bestDepth) {
            bestDepth = depth;
            rawHitGroupId = b.getAttribute('data-aq-grp-block') || '';
          }
        }
      }
    }

    let hitGroupId = rawHitGroupId;
    let nextItemDropMode = '';
    let nextItemTargetCid = '';
    let nextItemTargetGroupId = '';
    let pickedEl = null;
    let pickedClass = '';

    if (d.mode === 'group-item' && d.sourceGroupId && inGroupsBody) {
      let sourceBlock = null;
      for (let i = 0; i < allBlocks.length; i++) {
        if (allBlocks[i].getAttribute('data-aq-grp-block') === d.sourceGroupId) {
          sourceBlock = allBlocks[i];
          break;
        }
      }
      const ownPeers = getDirectPeerDescriptors(sourceBlock);
      const dragCidLower = String(d.item?.cascadeId || '').toLowerCase();
      const fromPeerIdx = ownPeers.findIndex((p) => p.token === `c:${dragCidLower}`);

      if (rawHitGroupId === d.sourceGroupId) {
        hitGroupId = '';
        const peerHit = resolvePeerInsertHit(ownPeers, fromPeerIdx, clientY);
        if (peerHit) {
          nextItemDropMode = peerHit.mode;
          pickedEl = peerHit.peer.el;
          if (peerHit.peer.kind === 'group') {
            nextItemTargetGroupId = peerHit.peer.id;
            pickedClass =
              peerHit.mode === 'before' ? 'aq-grp-drag-before' : 'aq-grp-drag-after';
          } else {
            nextItemTargetCid = peerHit.peer.id;
            pickedClass =
              peerHit.mode === 'before' ? 'aq-grp-item-drag-before' : 'aq-grp-item-drag-after';
          }
        }
      } else if (rawHitGroupId) {
        const subPeerIdx = ownPeers.findIndex(
          (p) => p.kind === 'group' && p.id === rawHitGroupId
        );
        if (subPeerIdx >= 0) {
          const subBlock = ownPeers[subPeerIdx].el;
          const subHdr = subBlock.querySelector(':scope > [data-aq-grp-hdr]');
          const shRect = subHdr?.getBoundingClientRect?.();
          const sbRect = subBlock.getBoundingClientRect();
          const isBeforeNoop = fromPeerIdx >= 0 && subPeerIdx === fromPeerIdx + 1;
          const isAfterNoop = fromPeerIdx >= 0 && subPeerIdx === fromPeerIdx - 1;
          let subMode = 'inside';

          if (shRect && shRect.height > 0 && clientY <= shRect.bottom) {
            const rel = (clientY - shRect.top) / shRect.height;
            if (isBeforeNoop) {
              if (rel >= 0.62) subMode = 'after';
              else if (rel >= 0.18) subMode = 'inside';
              else subMode = '';
            } else if (isAfterNoop) {
              if (rel <= 0.38) subMode = 'before';
              else if (rel <= 0.82) subMode = 'inside';
              else subMode = '';
            } else if (rel <= 0.3) {
              subMode = 'before';
            } else if (rel < 0.7) {
              subMode = 'inside';
            } else {
              subMode = 'after';
            }
          } else if (!isAfterNoop && sbRect.height > 0 && clientY >= sbRect.bottom - 8) {
            subMode = 'after';
          }

          if (subMode === 'before' || subMode === 'after') {
            hitGroupId = '';
            nextItemDropMode = subMode;
            nextItemTargetGroupId = rawHitGroupId;
            pickedEl = subBlock;
            pickedClass = subMode === 'before' ? 'aq-grp-drag-before' : 'aq-grp-drag-after';
          } else if (subMode !== 'inside') {
            hitGroupId = '';
          }
        }
      }
    }

    // Hovering over any collapsed target folder auto-expands it so users can inspect or drop inside
    const hitGrp = hitGroupId ? state.groups.find((g) => g.id === hitGroupId) : null;
    if (inGroupsBody && hitGrp && hitGrp.collapsed) {
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
        }, 350);
      }
    } else if (state.convDragHoverGroupTimer) {
      clearTimeout(state.convDragHoverGroupTimer);
      state.convDragHoverGroupTimer = null;
      state.convDragHoverGroupId = '';
    } else {
      state.convDragHoverGroupId = '';
    }

    // 2. Write DOM classes in one batch
    if (d.mode === 'native-row' && document.body.classList.contains('aq-dragging-to-group') !== inPanel) {
      document.body.classList.toggle('aq-dragging-to-group', inPanel);
    }
    panel
      .querySelectorAll(
        '.aq-grp-drag-before, .aq-grp-drag-after, .aq-grp-item-drag-before, .aq-grp-item-drag-after'
      )
      .forEach((el) =>
        el.classList.remove(
          'aq-grp-drag-before',
          'aq-grp-drag-after',
          'aq-grp-item-drag-before',
          'aq-grp-item-drag-after'
        )
      );
    if (pickedEl && pickedClass) {
      pickedEl.classList.add(pickedClass);
    }
    for (let i = 0; i < allBlocks.length; i++) {
      const b = allBlocks[i];
      const gid = b.getAttribute('data-aq-grp-block') || '';
      b.classList.toggle('aq-grp-drop-target', Boolean(hitGroupId && gid === hitGroupId));
    }

    const overEmptyPanel = Boolean(inTopArea && state.groups.length === 0 && !state.groupCreating);
    panel.classList.toggle('aq-grp-panel-drop-target', overEmptyPanel);

    d.overPanel = inPanel;
    d.overGroupId = hitGroupId;
    d.overEmptyPanel = overEmptyPanel;
    d.itemDropMode = nextItemDropMode;
    d.itemTargetCid = nextItemTargetCid;
    d.itemTargetGroupId = nextItemTargetGroupId;

    const showGhost = Boolean(d.switchedFromProjects || d.mode === 'group-item' || inPanel);
    const ghost = ensureConvDragGhostEl();
    if (!showGhost) {
      ghost.classList.remove('is-visible');
      if (didScroll) scheduleConvDragAutoScrollTick();
      return;
    }

    let badgeText = '';
    if (nextItemDropMode && nextItemTargetGroupId) {
      const tGrp = state.groups.find((g) => g.id === nextItemTargetGroupId);
      const rawName = String(tGrp?.name || '').trim();
      const shortName = rawName.length > 6 ? `${rawName.slice(0, 5)}…` : rawName;
      badgeText = shortName
        ? `移到 ${shortName} ${nextItemDropMode === 'before' ? '前' : '后'}`
        : nextItemDropMode === 'before'
          ? '移至上方'
          : '移至下方';
    } else if (nextItemDropMode && nextItemTargetCid) {
      const sourceGrp = state.groups.find((g) => g.id === d.sourceGroupId);
      const tItem = sourceGrp?.items?.find(
        (it) => String(it.cascadeId || '').toLowerCase() === nextItemTargetCid.toLowerCase()
      );
      const rawTitle = String(tItem?.title || '').trim();
      const shortTitle = rawTitle.length > 5 ? `${rawTitle.slice(0, 4)}…` : rawTitle;
      badgeText = shortTitle
        ? `移到 ${shortTitle} ${nextItemDropMode === 'before' ? '前' : '后'}`
        : nextItemDropMode === 'before'
          ? '移至上方'
          : '移至下方';
    } else if (hitGroupId) {
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
    if (didScroll) scheduleConvDragAutoScrollTick();
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
    const brandNew = [];
    for (let i = 0; i < rawItems.length; i++) {
      const it = rawItems[i];
      const key = String(it.cascadeId || '').toLowerCase();
      if (!key) continue;
      freshByCid.set(key, it);
      const prev = state.smartStableMap.get(key);
      if (prev) {
        prev.item = it;
        prev.missingSince = 0;
        prev.retainedWhileActive = false;
      } else {
        brandNew.push({ key, item: it });
      }
    }
    if (brandNew.length > 0) {
      brandNew.sort((a, b) => (b.item.lastModifiedMs || 0) - (a.item.lastModifiedMs || 0));
      for (let i = 0; i < brandNew.length; i++) {
        const { key, item } = brandNew[i];
        state.smartStableMap.set(key, {
          item,
          missingSince: 0,
          retainedWhileActive: false,
          seq: state.smartNextSeq++,
        });
      }
    }

    let nextWakeInMs = 0;
    for (const [key, entry] of state.smartStableMap.entries()) {
      if (freshByCid.has(key)) continue;
      const meta = state.trajMetaById[key] || null;
      if (meta?.archived) {
        state.smartStableMap.delete(key);
        continue;
      }
      const isCurrentPage = Boolean(activeCid && key === activeCid);
      if (isCurrentPage) {
        // Keep the active page in "进行中" while the user is still viewing it;
        // clear unread immediately on open, or clear running/waiting after brief grace to prevent flicker.
        if (entry.retainedWhileActive || entry.item?.status === 'unread') {
          entry.retainedWhileActive = true;
          entry.missingSince = 0;
          const nextTitle = meta?.title || entry.item?.title || '';
          const nextProject = meta?.project ?? entry.item?.project ?? '';
          if (entry.item?.status || entry.item?.title !== nextTitle || entry.item?.project !== nextProject) {
            entry.item = { ...entry.item, title: nextTitle, project: nextProject, status: '' };
          }
          continue;
        }
        if (!entry.missingSince) {
          entry.missingSince = now;
        }
        const elapsed = now - entry.missingSince;
        if (elapsed >= SMART_EXIT_GRACE_MS) {
          entry.retainedWhileActive = true;
          entry.missingSince = 0;
          const nextTitle = meta?.title || entry.item?.title || '';
          const nextProject = meta?.project ?? entry.item?.project ?? '';
          entry.item = { ...entry.item, title: nextTitle, project: nextProject, status: '' };
        } else {
          const remain = SMART_EXIT_GRACE_MS - elapsed + 40;
          if (!nextWakeInMs || remain < nextWakeInMs) {
            nextWakeInMs = remain;
          }
        }
        continue;
      }

      if (entry.retainedWhileActive) {
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

    // Lock relative order by first-seen sequence so running/waiting transitions never reshuffle items
    const entries = [...state.smartStableMap.values()];
    entries.sort((a, b) => a.seq - b.seq);
    return entries.map((e) => e.item);
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

  function renderConvProjectSubHtml(project) {
    if (project) {
      return `<span class="aq-grp-item-sub">${SVG_FOLDER}<span>${escapeHtml(project)}</span></span>`;
    }
    return `<span class="aq-grp-item-sub is-no-project">${SVG_CHAT_BUBBLE}<span>无项目</span></span>`;
  }

  function syncConvProjectSubEl(mainEl, nextProj) {
    if (!mainEl) return;
    const existingSub = mainEl.querySelector(':scope > .aq-grp-item-sub');
    const wantEmpty = !nextProj;
    if (!existingSub) {
      mainEl.insertAdjacentHTML('beforeend', renderConvProjectSubHtml(nextProj));
      return;
    }
    const isCurrentlyEmpty = existingSub.classList.contains('is-no-project');
    if (wantEmpty !== isCurrentlyEmpty) {
      existingSub.outerHTML = renderConvProjectSubHtml(nextProj);
      return;
    }
    if (!wantEmpty) {
      const sp = existingSub.querySelector('span');
      if (sp && sp.textContent !== nextProj) sp.textContent = nextProj;
    }
  }

  function createSmartSlotEl(it, activeCid, animateEnter) {
    const cid = String(it.cascadeId || '');
    const cidLower = cid.toLowerCase();
    const isActive = Boolean(activeCid && cidLower === activeCid);
    const tipText = it.project ? `${it.title} · ${it.project}` : it.title;
    const slot = document.createElement('div');
    slot.className = animateEnter ? 'aq-smart-slot is-entering' : 'aq-smart-slot';
    slot.setAttribute('data-aq-smart-cid', cidLower);
    slot.innerHTML = `
      <div class="aq-smart-slot-inner">
        <div class="aq-grp-item ${isActive ? 'is-active' : ''}" data-aq-grp-open="${escapeHtml(cid)}" data-aq-smart-item="active" data-aq-status="${escapeHtml(it.status || '')}" data-aq-project="${escapeHtml(it.project || '')}" title="${escapeHtml(tipText)}">
          <div class="aq-grp-item-main">
            <span class="aq-grp-item-title">${escapeHtml(it.title)}</span>
            ${renderConvProjectSubHtml(it.project)}
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
    const tipText = it.project ? `${it.title} · ${it.project}` : it.title;
    if (itemEl.getAttribute('title') !== tipText) {
      itemEl.setAttribute('title', tipText);
    }
    const prevProj = itemEl.getAttribute('data-aq-project') || '';
    const nextProj = it.project || '';
    if (prevProj !== nextProj) {
      itemEl.setAttribute('data-aq-project', nextProj);
    }
    const mainEl = itemEl.querySelector('.aq-grp-item-main');
    const titleEl = mainEl?.querySelector('.aq-grp-item-title');
    if (titleEl && titleEl.textContent !== it.title) {
      titleEl.textContent = it.title;
    }
    syncConvProjectSubEl(mainEl, nextProj);
    patchItemStatusBadgeInPlace(itemEl, it.status);
  }

  function patchSidebarGroupsDynamicState(panel, activeCid, convStatuses, stableActiveItems, recentItems = []) {
    // Read layout measurement BEFORE mutating DOM to avoid forced synchronous reflow in step 3
    const bodyElForHeight =
      !state.groupResizeDrag && !state.groupResizeSnapTimer ? panel.querySelector('.aq-grp-body') : null;
    const expectedMaxH = bodyElForHeight
      ? state.groupsBodyHeight > 0
        ? `${clampGroupsBodyHeight(state.groupsBodyHeight, panel)}px`
        : ''
      : null;

    // 1. Update smart group header, collapse state, count, empty placeholder, and keyed list
    const activeBlockEl = panel.querySelector('[data-aq-smart-block="active"]');
    const smartFoldHintEl = panel.querySelector('[data-aq-smart-fold-hint]');
    const countEl = panel.querySelector('[data-aq-smart-count]');
    const childrenEl = panel.querySelector('[data-aq-smart-children]');
    const listEl = panel.querySelector('[data-aq-smart-list]');
    const emptyEl = panel.querySelector('[data-aq-smart-empty]');

    const smartExpanded = !state.smartActiveCollapsed;
    const count = stableActiveItems.length;
    if (activeBlockEl) activeBlockEl.classList.toggle('is-empty', count === 0);
    if (smartFoldHintEl) {
      const hintText = !smartExpanded ? '已收起' : '';
      if (smartFoldHintEl.textContent !== hintText) smartFoldHintEl.textContent = hintText;
      smartFoldHintEl.classList.toggle('is-highlight', !smartExpanded && count > 0);
    }
    if (countEl) {
      const countText = String(count);
      if (countEl.textContent !== countText) countEl.textContent = countText;
      countEl.classList.toggle('is-highlight', count > 0);
    }
    if (childrenEl) childrenEl.classList.toggle('is-collapsed', !smartExpanded || count === 0);
    if (emptyEl) emptyEl.classList.toggle('is-hidden', true);

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

    // 2b. Patch recent 10 conversations section at the bottom of Groups tab in-place
    const recentFoldHintEl = panel.querySelector('[data-aq-recent-fold-hint]');
    const recentChildrenEl = panel.querySelector('[data-aq-recent-children]');
    const recentListEl = panel.querySelector('[data-aq-recent-list]');
    const recentExpanded = !state.recentCollapsed;
    if (recentFoldHintEl) {
      const rHint = !recentExpanded ? '已收起' : '';
      if (recentFoldHintEl.textContent !== rHint) recentFoldHintEl.textContent = rHint;
    }
    if (recentChildrenEl) recentChildrenEl.classList.toggle('is-collapsed', !recentExpanded);
    if (recentListEl && Array.isArray(recentItems)) {
      const existingRecentByCid = new Map();
      const curRecentNodes = [...recentListEl.querySelectorAll(':scope > .aq-grp-item[data-aq-recent-cid]')];
      for (let i = 0; i < curRecentNodes.length; i++) {
        const el = curRecentNodes[i];
        const k = el.getAttribute('data-aq-recent-cid') || '';
        if (k) existingRecentByCid.set(k, el);
      }
      const desiredRecentKeys = new Set();
      let rCursor = null;
      for (let i = 0; i < recentItems.length; i++) {
        const it = recentItems[i];
        const cid = String(it.cascadeId || '');
        const key = cid.toLowerCase();
        if (state.hiddenKeepAliveCids.has(key)) continue;
        if (!key) continue;
        desiredRecentKeys.add(key);
        const isActive = Boolean(activeCid && key === activeCid);
        const tipText = it.project ? `${it.title} · ${it.project}` : it.title;
        let itemEl = existingRecentByCid.get(key);
        if (itemEl) {
          itemEl.classList.toggle('is-active', isActive);
          if (itemEl.getAttribute('title') !== tipText) itemEl.setAttribute('title', tipText);
          const nextProj = it.project || '';
          if ((itemEl.getAttribute('data-aq-project') || '') !== nextProj) {
            itemEl.setAttribute('data-aq-project', nextProj);
          }
          const mainEl = itemEl.querySelector('.aq-grp-item-main');
          const titleEl = mainEl?.querySelector('.aq-grp-item-title');
          if (titleEl && titleEl.textContent !== it.title) titleEl.textContent = it.title;
          syncConvProjectSubEl(mainEl, nextProj);
          patchItemStatusBadgeInPlace(itemEl, it.status);
        } else {
          itemEl = document.createElement('div');
          itemEl.className = `aq-grp-item ${isActive ? 'is-active' : ''}`;
          itemEl.setAttribute('data-aq-grp-open', cid);
          itemEl.setAttribute('data-aq-recent-cid', key);
          itemEl.setAttribute('data-aq-status', it.status || '');
          itemEl.setAttribute('data-aq-project', it.project || '');
          itemEl.setAttribute('title', tipText);
          itemEl.innerHTML = `
            <div class="aq-grp-item-main">
              <span class="aq-grp-item-title">${escapeHtml(it.title)}</span>
              ${renderConvProjectSubHtml(it.project)}
            </div>
            ${renderConvStatusBadgeHtml(it.status)}
            <span class="aq-grp-item-actions">
              <button type="button" class="aq-grp-icon-btn" data-aq-grp-item-menu="${escapeHtml(cid)}" title="管理所属分组">${SVG_FOLDER_PLUS}</button>
            </span>
          `;
        }
        const expectedNext = rCursor ? rCursor.nextElementSibling : recentListEl.firstElementChild;
        if (itemEl !== expectedNext) {
          recentListEl.insertBefore(itemEl, expectedNext || null);
        }
        rCursor = itemEl;
      }
      for (const [k, el] of existingRecentByCid.entries()) {
        if (!desiredRecentKeys.has(k)) el.remove();
      }
      let recentEmpty = recentListEl.querySelector(':scope > .aq-grp-item-empty[data-aq-recent-empty]');
      if (desiredRecentKeys.size === 0) {
        if (!recentEmpty) {
          recentEmpty = document.createElement('div');
          recentEmpty.className = 'aq-grp-item-empty';
          recentEmpty.setAttribute('data-aq-recent-empty', '1');
          recentEmpty.textContent = '暂无未归档会话';
          recentListEl.appendChild(recentEmpty);
        }
      } else if (recentEmpty) {
        recentEmpty.remove();
      }
    }

    // 3. Keep max-height ceiling synced without disturbing active drag or spring-back animation
    if (bodyElForHeight) {
      if (expectedMaxH !== null && bodyElForHeight.style.maxHeight !== expectedMaxH) {
        bodyElForHeight.style.maxHeight = expectedMaxH;
      }
      if (bodyElForHeight.style.height && bodyElForHeight.style.height !== 'auto') {
        bodyElForHeight.style.height = 'auto';
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
    const { statusById: convStatuses, activeItems, recentItems } = collectAllConversationStates(activeCid);
    const stableActiveItems = stabilizeSmartActiveItems(activeItems, activeCid);

    // Only structural changes rebuild panel.innerHTML; status/active/smart-list updates patch in-place!
    const structureKey = JSON.stringify({
      g: state.groups,
      err: state.groupsError,
      cr: state.groupCreating,
      cp: state.groupCreateParentId,
      ci: Boolean(state.groupCreateInitialItem),
      rn: state.groupRenamingId,
      dc: state.groupDeleteConfirmId,
    });

    const needRebuild = force || structureKey !== state.groupRenderKey || !panel.querySelector('.aq-grp-body');
    if (!needRebuild) {
      patchSidebarGroupsDynamicState(panel, activeCid, convStatuses, stableActiveItems, recentItems);
      return;
    }

    const prevScrollTop = panel.querySelector('.aq-grp-body')?.scrollTop || 0;
    state.groupRenderKey = structureKey;

    const smartExpanded = !state.smartActiveCollapsed;
    const smartGroupsHtml = `
      <div class="aq-grp-active-sec ${stableActiveItems.length === 0 ? 'is-empty' : ''}" data-aq-smart-block="active">
        <div class="aq-grp-hdr is-smart" data-aq-smart-hdr="active" title="进行中：正在运行、待确认或未读会话（点击可收起/展开）">
          <span class="aq-grp-active-dot" aria-hidden="true"></span>
          <span class="aq-grp-name">进行中</span>
          <span class="aq-grp-fold-hint" data-aq-smart-fold-hint="1"></span>
        </div>
        <div class="aq-smart-children ${smartExpanded && stableActiveItems.length > 0 ? '' : 'is-collapsed'}" data-aq-smart-children="1">
          <div class="aq-smart-children-inner">
            <div class="aq-grp-children">
              <div class="aq-smart-list" data-aq-smart-list="1"></div>
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

      const totalCount = tree.totalCountById.get(g.id) ?? items.length;
      const collapsedCountHtml = !isExpanded
        ? `<span class="aq-grp-count" data-aq-grp-count="${escapeHtml(g.id)}" title="共 ${totalCount} 个会话">${totalCount}</span>`
        : '';

      const hdrHtml = isRenaming
        ? `
          <div class="aq-grp-inline-form" data-aq-grp-rename-form="${escapeHtml(g.id)}">
            <input type="text" class="aq-grp-input" data-aq-grp-rename-input="${escapeHtml(g.id)}" maxlength="48" value="${escapeHtml(g.name)}" />
            <button type="button" class="aq-grp-mini-btn is-primary" data-aq-grp-rename-ok="${escapeHtml(g.id)}">保存</button>
            <button type="button" class="aq-grp-mini-btn" data-aq-grp-rename-cancel="1">取消</button>
          </div>
        `
        : `
          <div class="aq-grp-hdr ${isDeleteConfirm ? 'has-confirm' : ''}" data-aq-grp-hdr="${escapeHtml(g.id)}" title="${escapeHtml(g.name)}">
            <span class="aq-grp-folder-ico ${isExpanded ? 'is-open' : ''}">${isExpanded ? SVG_FOLDER_OPEN : SVG_FOLDER}</span>
            <span class="aq-grp-name">${escapeHtml(g.name)}</span>
            ${collapsedCountHtml}
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
        const renderItemRow = (it) => {
          const cidLower = String(it.cascadeId || '').toLowerCase();
          const isActive = activeCid && cidLower === activeCid;
          const status = convStatuses[cidLower] || '';
          const statusHtml = renderConvStatusBadgeHtml(status);
          const tipText = it.project ? `${it.title} · ${it.project}` : it.title;
          return `
            <div class="aq-grp-item ${isActive ? 'is-active' : ''}" data-aq-grp-open="${escapeHtml(it.cascadeId)}" data-aq-grp-gid="${escapeHtml(g.id)}" data-aq-status="${escapeHtml(status)}" data-aq-project="${escapeHtml(it.project || '')}" title="${escapeHtml(tipText)}">
              <div class="aq-grp-item-main">
                <span class="aq-grp-item-title">${escapeHtml(it.title)}</span>
                ${renderConvProjectSubHtml(it.project)}
              </div>
              ${statusHtml}
              <span class="aq-grp-item-actions">
                <button type="button" class="aq-grp-icon-btn" data-aq-grp-item-rm="${escapeHtml(it.cascadeId)}" data-aq-grp-gid="${escapeHtml(g.id)}" title="移出此分组">${SVG_CLOSE}</button>
              </span>
            </div>
          `;
        };
        const subById = new Map(childGroups.map((cg) => [cg.id, cg]));
        const itemByKey = new Map(
          items.map((it) => [String(it.cascadeId || '').toLowerCase(), it])
        );
        const childTokens = getNormalizedGroupChildTokens(g, childGroups);
        const mixedChildrenHtml = childTokens
          .map((tok) => {
            if (tok.startsWith('g:')) {
              const sg = subById.get(tok.slice(2));
              return sg ? renderGroupBlock(sg, depth + 1) : '';
            }
            if (tok.startsWith('c:')) {
              const it = itemByKey.get(tok.slice(2));
              return it ? renderItemRow(it) : '';
            }
            return '';
          })
          .join('');
        const emptyHtml =
          !isCreatingChildHere && childGroups.length === 0 && items.length === 0
            ? '<div class="aq-grp-item-empty">暂无对话</div>'
            : '';
        childrenHtml = `<div class="aq-grp-children">${childCreateHtml}${mixedChildrenHtml}${emptyHtml}</div>`;
      }

      return `<div class="aq-grp-block" data-aq-grp-block="${escapeHtml(g.id)}" data-aq-grp-depth="${depth}">${hdrHtml}${childrenHtml}</div>`;
    };

    const topGroups = tree.childrenByParent.get('') || [];
    const groupsHtml = topGroups.map((g) => renderGroupBlock(g, 0)).join('');

    const recentExpanded = !state.recentCollapsed;
    const errHtml = state.groupsError
      ? `<div class="aq-grp-error">${escapeHtml(state.groupsError)}</div>`
      : '';
    const bodyHeightStyle =
      state.groupsBodyHeight > 0
        ? ` style="max-height:${clampGroupsBodyHeight(state.groupsBodyHeight, panel)}px"`
        : '';
    const resizerHtml =
      '<div class="aq-grp-resizer" data-aq-grp-resizer="1" title="上下拖动设置分组最大高度，双击恢复默认"><span class="aq-grp-resizer-badge" data-aq-grp-resizer-badge="1"></span></div>';
    const recentSectionHtml = `
      <div class="aq-grp-recent-sec" data-aq-recent-sec="1">
        <div class="aq-grp-hdr is-smart" data-aq-recent-hdr="1" title="最近会话（按最后发消息时间排序，最多 10 条，点击可收起/展开）">
          <span class="aq-grp-name">最近会话</span>
          <span class="aq-grp-fold-hint" data-aq-recent-fold-hint="1"></span>
        </div>
        <div class="aq-smart-children ${recentExpanded ? '' : 'is-collapsed'}" data-aq-recent-children="1">
          <div class="aq-smart-children-inner">
            <div class="aq-grp-children" data-aq-recent-list="1"></div>
          </div>
        </div>
      </div>
    `;
    const rootAddRowHtml = creatingTop
      ? topCreateFormHtml
      : totalGroups === 0
        ? `<button type="button" class="aq-grp-empty-cta" data-aq-grp-new="1">${SVG_FOLDER_PLUS}<span>新建根文件夹，或拖入下方会话</span></button>`
        : '';
    const bodyHtml = `
      ${smartGroupsHtml}
      <div class="aq-grp-top-wrap">
        ${errHtml}
        <div class="aq-grp-body"${bodyHeightStyle}>
          ${groupsHtml}
          ${rootAddRowHtml}
        </div>
        ${resizerHtml}
      </div>
      ${recentSectionHtml}
    `;

    panel.innerHTML = bodyHtml;

    patchSidebarGroupsDynamicState(panel, activeCid, convStatuses, stableActiveItems, recentItems);

    if (prevScrollTop > 0) {
      const nextBody = panel.querySelector('.aq-grp-body');
      if (nextBody) nextBody.scrollTop = prevScrollTop;
    }

    if (state.convDrag?.started) {
      const d = state.convDrag;
      if (d.mode === 'group-folder' && d.sourceGroupId) {
        const allBlocks = panel.querySelectorAll('[data-aq-grp-block]');
        for (let i = 0; i < allBlocks.length; i++) {
          if (allBlocks[i].getAttribute('data-aq-grp-block') === d.sourceGroupId) {
            d.sourceEl = allBlocks[i];
            d.sourceEl.classList.add('is-dragging');
            break;
          }
        }
      } else if (d.mode === 'group-item' && d.sourceGroupId && d.item?.cascadeId) {
        const cidLower = String(d.item.cascadeId).toLowerCase();
        const allItems = panel.querySelectorAll('.aq-grp-item[data-aq-grp-gid]');
        for (let i = 0; i < allItems.length; i++) {
          if (
            allItems[i].getAttribute('data-aq-grp-gid') === d.sourceGroupId &&
            String(allItems[i].getAttribute('data-aq-grp-open') || '').toLowerCase() === cidLower
          ) {
            d.sourceEl = allItems[i];
            d.sourceEl.classList.add('is-dragging');
            break;
          }
        }
      } else if (d.mode === 'native-row' && !d.switchedFromProjects && d.item?.cascadeId) {
        const cidLower = String(d.item.cascadeId).toLowerCase();
        const smartAndRecent = panel.querySelectorAll('[data-aq-grp-open]:not([data-aq-grp-gid])');
        for (let i = 0; i < smartAndRecent.length; i++) {
          if (
            String(smartAndRecent[i].getAttribute('data-aq-grp-open') || '').toLowerCase() ===
            cidLower
          ) {
            d.sourceEl = smartAndRecent[i];
            d.sourceEl.classList.add('is-dragging');
            break;
          }
        }
      }
      updateConversationDragTarget(d.lastX, d.lastY);
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

      const foldersHdr = target?.closest?.('[data-aq-folders-hdr]');
      if (foldersHdr) {
        ev.preventDefault();
        ev.stopPropagation();
        state.foldersCollapsed = !state.foldersCollapsed;
        saveSmartGroupCollapsed();
        renderSidebarGroupsPanel(false);
        return;
      }

      const recentHdr = target?.closest?.('[data-aq-recent-hdr]');
      if (recentHdr) {
        ev.preventDefault();
        ev.stopPropagation();
        state.recentCollapsed = !state.recentCollapsed;
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
            rowEl?.getAttribute('data-aq-project') ||
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

    panel.addEventListener('contextmenu', (ev) => {
      if (ev.target?.closest?.('input, textarea')) return;
      ev.preventDefault();
      ev.stopPropagation();
      const hdr = ev.target?.closest?.('[data-aq-grp-hdr]');
      if (hdr) {
        const gid = hdr.getAttribute('data-aq-grp-hdr') || '';
        const block = hdr.closest('[data-aq-grp-block]');
        const depth = Number.parseInt(block?.getAttribute('data-aq-grp-depth') || '0', 10) || 0;
        openGroupCtxMenu(ev.clientX, ev.clientY, { groupId: gid, depth });
        return;
      }
      const activeOrRecent = ev.target?.closest?.('[data-aq-recent-cid], [data-aq-smart-item="active"]');
      if (activeOrRecent) {
        const cid =
          activeOrRecent.getAttribute('data-aq-grp-open') ||
          activeOrRecent.getAttribute('data-aq-recent-cid') ||
          '';
        closeGroupCtxMenu();
        if (openNativeConversationContextMenu(cid, ev.clientX, ev.clientY)) {
          return;
        }
        openGroupCtxMenu(ev.clientX, ev.clientY, { item: cid ? { cascadeId: cid } : null });
        return;
      }
      const rowEl = ev.target?.closest?.('[data-aq-grp-open]');
      const cid = rowEl?.getAttribute?.('data-aq-grp-open') || '';
      const itemGroupId = rowEl?.getAttribute?.('data-aq-grp-gid') || '';
      openGroupCtxMenu(ev.clientX, ev.clientY, {
        item: cid ? { cascadeId: cid } : null,
        itemGroupId,
      });
    });
  }

  function saveSidebarTab(tab) {
    try {
      localStorage.setItem('aq_sidebar_tab_v1', tab === 'projects' ? 'projects' : 'groups');
    } catch {}
  }

  function parseTranslateYPx(el) {
    if (!el) return null;
    const tf = el.style?.transform || '';
    const m = tf.match(/translateY\(([-\d.]+)px\)/i);
    if (!m) return null;
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : null;
  }

  function triggerNewTopFolder() {
    state.sidebarTab = 'groups';
    saveSidebarTab('groups');
    state.groupsError = '';
    state.groupRenamingId = '';
    clearGroupDeleteConfirm();
    state.groupCreateParentId = '';
    state.groupCreateInitialItem = null;
    state.groupCreating = true;
    state.groupsCollapsedSection = false;
    const sb = findSidebarRoot();
    if (sb) syncSidebarTabState(sb);
    renderSidebarGroupsPanel(true);
  }

  function syncPinnedNewFolderButton(sidebar) {
    const pinnedHdr = sidebar?.querySelector?.('[data-testid="pinned-section-header"]');
    if (!pinnedHdr) return;
    let btn = pinnedHdr.querySelector('[data-aq-pinned-new-grp="1"]');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'aq-grp-icon-btn aq-pinned-add-folder-btn';
      btn.setAttribute('data-aq-pinned-new-grp', '1');
      btn.setAttribute('title', '新建文件夹');
      btn.setAttribute('aria-label', '新建文件夹');
      btn.innerHTML = SVG_PLUS;
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        triggerNewTopFolder();
      });
      const anchor = pinnedHdr.querySelector('h2') || pinnedHdr.firstElementChild;
      if (anchor) {
        anchor.insertAdjacentElement('afterend', btn);
      } else {
        pinnedHdr.appendChild(btn);
      }
    }
  }

  function syncProjectRowGroupButtons(sidebar) {
    if (!sidebar) return;
    const nativeProjIdx = readNativeSidebarProjectIndex(sidebar);
    const rows = sidebar.querySelectorAll('[data-testid="conversation-row-sidebar"][data-cascade-id]');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.closest('[aria-hidden="true"]')) continue;
      const cid = String(row.getAttribute('data-cascade-id') || '').trim();
      if (!cid) continue;
      const cidLower = cid.toLowerCase();
      const secId = row.closest('[data-sidebar-section-id]')?.getAttribute('data-sidebar-section-id') || '';
      const hasProject = nativeProjIdx.standaloneCids.has(cidLower)
        ? false
        : Boolean(
            row.getAttribute('data-subtext') ||
              nativeProjIdx.projectByCid.get(cidLower) ||
              state.trajMetaById[cidLower]?.project ||
              (secId && !isNonProjectSectionId(secId))
          );
      const wantNoProj = !hasProject;
      if (row.hasAttribute('data-aq-no-project') !== wantNoProj) {
        row.toggleAttribute('data-aq-no-project', wantNoProj);
      }
      const actionsEl = row.querySelector('.agy-row-actions');
      if (!actionsEl) continue;

      let btn = actionsEl.querySelector('[data-aq-row-grp-btn]');
      if (!btn || btn.dataset.aqOwner !== INSTANCE_TOKEN) {
        if (btn) btn.remove();
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'aq-row-grp-btn';
        btn.dataset.aqOwner = INSTANCE_TOKEN;
        btn.setAttribute('data-aq-row-grp-btn', cid);
        btn.innerHTML = SVG_FOLDER_PLUS;
        btn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const curRow = btn.closest('[data-testid="conversation-row-sidebar"][data-cascade-id]');
          const curCid = String(btn.getAttribute('data-aq-row-grp-btn') || '').trim();
          const info = (curRow && extractRowConversationInfo(curRow)) || {
            cascadeId: curCid,
            title: state.trajMetaById[curCid.toLowerCase()]?.title || '未命名对话',
            project: state.trajMetaById[curCid.toLowerCase()]?.project || '',
          };
          if (info?.cascadeId) {
            openGroupMenu(btn, info);
          }
        });
        actionsEl.insertBefore(btn, actionsEl.firstElementChild);
      } else if (btn.getAttribute('data-aq-row-grp-btn') !== cid) {
        btn.setAttribute('data-aq-row-grp-btn', cid);
      }

      const grouped = isConversationGrouped(cid);
      btn.classList.toggle('is-grouped', grouped);
      const label = grouped ? '管理所属分组' : '加入文件夹';
      if (btn.getAttribute('title') !== label) {
        btn.setAttribute('title', label);
        btn.setAttribute('aria-label', label);
      }
    }
  }

  function syncProjectSplitCards(sidebar) {
    const convList = sidebar?.querySelector?.('[data-testid="conversation-list-sidebar"]');
    const inner = convList?.firstElementChild;
    if (!convList || !inner) return;

    if (state.projScrollEl !== convList) {
      if (state.projScrollEl) {
        state.projScrollEl.classList.remove('aq-proj-scrolled');
        if (state.onProjScroll) {
          state.projScrollEl.removeEventListener('scroll', state.onProjScroll);
        }
      }
      state.onProjScroll = () => {
        if (state.projScrollRaf || state.disposed) return;
        state.projScrollRaf = requestAnimationFrame(() => {
          state.projScrollRaf = 0;
          if (!state.disposed) syncProjectSplitCards(findSidebarRoot());
        });
      };
      convList.addEventListener('scroll', state.onProjScroll, { passive: true });
      state.projScrollEl = convList;
    }
    convList.classList.toggle('aq-proj-scrolled', convList.scrollTop > 1);

    let pinnedCard = inner.querySelector('[data-aq-proj-card="pinned"]');
    if (pinnedCard && pinnedCard.dataset.aqOwner !== INSTANCE_TOKEN) {
      pinnedCard.remove();
      pinnedCard = null;
    }
    if (!pinnedCard) {
      pinnedCard = document.createElement('div');
      pinnedCard.className = 'aq-proj-card';
      pinnedCard.dataset.aqOwner = INSTANCE_TOKEN;
      pinnedCard.setAttribute('data-aq-proj-card', 'pinned');
      pinnedCard.setAttribute('aria-hidden', 'true');
      inner.insertBefore(pinnedCard, inner.firstElementChild);
    }

    let projectsCard = inner.querySelector('[data-aq-proj-card="projects"]');
    if (projectsCard && projectsCard.dataset.aqOwner !== INSTANCE_TOKEN) {
      projectsCard.remove();
      projectsCard = null;
    }
    if (!projectsCard) {
      projectsCard = document.createElement('div');
      projectsCard.className = 'aq-proj-card';
      projectsCard.dataset.aqOwner = INSTANCE_TOKEN;
      projectsCard.setAttribute('data-aq-proj-card', 'projects');
      projectsCard.setAttribute('aria-hidden', 'true');
      inner.insertBefore(projectsCard, pinnedCard.nextSibling || inner.firstElementChild);
    }

    let pinnedLastBottom = 0;
    let mainHdrTop = null;
    const children = inner.children;
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (!c.hasAttribute('data-index')) continue;
      const dropId = c.getAttribute('data-sidebar-section-drop-id');
      const secId = c.getAttribute('data-sidebar-section-id');
      if (dropId === 'pinned') {
        const y = parseTranslateYPx(c);
        if (y !== null) {
          pinnedLastBottom = Math.max(pinnedLastBottom, y + (c.offsetHeight || 28));
        } else if (c.style.position === 'sticky' && convList.scrollTop < 4) {
          pinnedLastBottom = Math.max(pinnedLastBottom, c.offsetHeight || 28);
        }
      } else if (secId === 'pinned') {
        const y = parseTranslateYPx(c);
        if (y !== null) {
          pinnedLastBottom = Math.max(pinnedLastBottom, y + (c.offsetHeight || 43));
        }
      } else if (dropId === 'main-section-header') {
        const y = parseTranslateYPx(c);
        if (y !== null) {
          mainHdrTop = y;
        }
      }
    }

    let split = state.cachedProjSplit;
    if (mainHdrTop !== null) {
      split =
        mainHdrTop >= 16
          ? { pinnedCardH: Math.max(28, mainHdrTop - 12), projectsTop: mainHdrTop - 4 }
          : { pinnedCardH: 0, projectsTop: 0 };
      state.cachedProjSplit = split;
    } else if (pinnedLastBottom > 0) {
      split = { pinnedCardH: pinnedLastBottom + 4, projectsTop: pinnedLastBottom + 12 };
      state.cachedProjSplit = split;
    } else if (!split) {
      split = { pinnedCardH: 0, projectsTop: 0 };
    }

    if (split.pinnedCardH > 0) {
      pinnedCard.style.display = 'block';
      pinnedCard.style.top = '0px';
      pinnedCard.style.height = `${Math.round(split.pinnedCardH)}px`;
    } else {
      pinnedCard.style.display = 'none';
    }
    projectsCard.style.display = 'block';
    projectsCard.style.top = `${Math.round(split.projectsTop)}px`;
    projectsCard.style.bottom = '0px';
  }

  function syncSidebarTabState(sidebar) {
    if (!sidebar) return;
    const activeTab = state.sidebarTab === 'projects' ? 'projects' : 'groups';
    if (sidebar.getAttribute('data-aq-tab') !== activeTab) {
      sidebar.setAttribute('data-aq-tab', activeTab);
    }
    const tabBar = document.getElementById('aq-sidebar-tabs');
    if (tabBar) {
      tabBar.querySelectorAll('[data-aq-sidebar-tab]').forEach((btn) => {
        const isOn = btn.getAttribute('data-aq-sidebar-tab') === activeTab;
        btn.classList.toggle('is-active', isOn);
        btn.setAttribute('aria-selected', isOn ? 'true' : 'false');
      });
    }
    syncPinnedNewFolderButton(sidebar);
    syncProjectRowGroupButtons(sidebar);
    syncProjectSplitCards(sidebar);
  }

  function ensureSidebarGroupsPanel() {
    const sidebar = findSidebarRoot();
    if (!sidebar) return;
    const convList = sidebar.querySelector('[data-testid="conversation-list-sidebar"]');
    if (!convList) return;

    let scrollWrap = convList;
    while (scrollWrap && scrollWrap.parentElement && scrollWrap.parentElement !== sidebar) {
      scrollWrap = scrollWrap.parentElement;
    }
    if (!scrollWrap || scrollWrap.parentElement !== sidebar) return;

    document.getElementById('aq-sidebar-tabs-row')?.remove();
    let tabBar = document.getElementById('aq-sidebar-tabs');
    if (tabBar && tabBar.dataset.aqOwner !== INSTANCE_TOKEN) {
      tabBar.remove();
      tabBar = null;
    }
    if (!tabBar) {
      tabBar = document.createElement('div');
      tabBar.id = 'aq-sidebar-tabs';
      tabBar.dataset.aqOwner = INSTANCE_TOKEN;
      tabBar.setAttribute('role', 'tablist');
      tabBar.setAttribute('aria-label', '侧栏视图切换');
      tabBar.innerHTML =
        '<button type="button" class="aq-st-tab" role="tab" data-aq-sidebar-tab="groups" aria-selected="true">分组</button>' +
        '<button type="button" class="aq-st-tab" role="tab" data-aq-sidebar-tab="projects" aria-selected="false">项目</button>';
      tabBar.addEventListener('click', (ev) => {
        const btn = ev.target?.closest?.('[data-aq-sidebar-tab]');
        if (!btn) return;
        const nextTab = btn.getAttribute('data-aq-sidebar-tab') === 'projects' ? 'projects' : 'groups';
        if (nextTab === state.sidebarTab) return;
        state.sidebarTab = nextTab;
        saveSidebarTab(nextTab);
        const sb = findSidebarRoot();
        if (sb) syncSidebarTabState(sb);
        if (nextTab === 'groups') {
          renderSidebarGroupsPanel(false);
        } else {
          requestAnimationFrame(() => syncProjectSplitCards(findSidebarRoot()));
        }
      });
    }

    let panel = document.getElementById('aq-conv-groups');
    if (panel && panel.dataset.aqOwner !== INSTANCE_TOKEN) {
      panel.remove();
      panel = null;
    }
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'aq-conv-groups';
      panel.dataset.aqOwner = INSTANCE_TOKEN;
      bindSidebarGroupsEvents(panel);
    }
    if (tabBar.parentElement !== sidebar || tabBar.nextElementSibling !== panel) {
      sidebar.insertBefore(tabBar, panel.parentElement === sidebar ? panel : scrollWrap);
    }
    if (panel.parentElement !== sidebar || panel.nextElementSibling !== scrollWrap) {
      sidebar.insertBefore(panel, scrollWrap);
      state.groupRenderKey = '';
    }
    syncSidebarTabState(sidebar);
    state.latestSidebarDomInfo = null;
    renderSidebarGroupsPanel(false);
    syncGroupedConversationMetadata(state.latestSidebarDomInfo);
    state.latestSidebarDomInfo = null;
  }

  function syncCascadeRoute() {
    const cid = extractCascadeId();
    if (cid !== state.cascadeId) {
      state.cascadeId = cid;
      stopLiveTurnTimer();
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
        if (
          state.pendingNewChatSendAt > 0 &&
          now - state.pendingNewChatSendAt < 4_000 &&
          (!meta || isActiveComposerBusy())
        ) {
          markConversationSendStarted(cid);
        }
      }
      return true;
    }
    return false;
  }

  const renderAllRafCallback = () => {
    state.renderRaf = 0;
    if (state.disposed || window.__aq_active_token !== INSTANCE_TOKEN) return;
    const dirty = state.renderDirty;
    let runChip = dirty.chip;
    let runSidebar = dirty.sidebar;
    let runTurns = dirty.turns;
    let runMenus = dirty.menus;
    let runI18n = dirty.i18n;
    let runI18nSidebar = dirty.i18nSidebar;
    dirty.chip = false;
    dirty.sidebar = false;
    dirty.turns = false;
    dirty.menus = false;
    dirty.i18n = false;
    dirty.i18nSidebar = false;

    ensureWebContextMenuMode();
    if (syncCascadeRoute()) {
      runChip = true;
      runSidebar = true;
      runTurns = true;
      runI18n = true;
      runI18nSidebar = true;
    }
    if (runChip) {
      ensureQuotaChip();
      ensureConversationWidthResizers();
    }
    if (runSidebar) {
      ensureSidebarGroupsPanel();
    }
    if (runTurns || runChip) {
      const sharedCid = extractCascadeId();
      const ts = state.thinkingTranslate;
      const needTurnRows =
        runTurns ||
        Boolean(
          ts.open ||
            ts.btnEl ||
            ts.hostEl ||
            isActiveComposerBusy() ||
            (sharedCid && hasActiveConversationAsyncWork(sharedCid.toLowerCase()))
        );
      const sharedTurnEls = needTurnRows ? findTurnRows() : [];
      const sharedLiveCtx = needTurnRows
        ? evaluateConversationLiveTurnContext(sharedCid, sharedTurnEls)
        : null;
      if (runTurns) {
        renderTurnUsageLines(sharedCid, sharedTurnEls, sharedLiveCtx);
      }
      if (needTurnRows) {
        renderRunningThinkingHelper(sharedCid, sharedTurnEls, sharedLiveCtx);
      }
    }
    if (runMenus) {
      syncNativeConversationMenus();
    }
    if (runI18n) {
      applyUiTranslations({ includeSidebar: runI18nSidebar || runSidebar });
    }
  };
  renderAllRafCallback.__aqToken = INSTANCE_TOKEN;

  function scheduleRender(flags) {
    if (state.disposed) return;
    const d = state.renderDirty;
    if (flags) {
      if (flags.chip) d.chip = true;
      if (flags.sidebar) d.sidebar = true;
      if (flags.turns) d.turns = true;
      if (flags.menus) d.menus = true;
      if (flags.i18n) d.i18n = true;
      if (flags.i18nSidebar) d.i18nSidebar = true;
    } else {
      d.chip = true;
      d.sidebar = true;
      d.turns = true;
      d.menus = true;
      d.i18n = true;
      d.i18nSidebar = true;
    }
    if (!state.renderRaf) {
      state.renderRaf = requestAnimationFrame(renderAllRafCallback);
    }
  }

  function scheduleRenderAll() {
    scheduleRender(null);
  }

  function checkRoute() {
    if (state.disposed) return;
    const routeChanged = syncCascadeRoute();
    if (
      routeChanged ||
      (!document.hidden && (!document.getElementById('aq-quota-chip') || !document.getElementById('aq-conv-groups')))
    ) {
      scheduleRenderAll();
    }
  }

  // Expose receiver called by Node daemon
  window.__aqRenderTurns = function (payload) {
    try {
      if (state.disposed) return;
      const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
      const sameChat = Boolean(cid && cid === state.lastTurnsCid);
      let nextPayload = payload;
      if (
        payload?.mode === 'tail' &&
        sameChat &&
        Array.isArray(state.turnsPayload?.turns) &&
        Number.isInteger(payload.tailStartIndex) &&
        payload.tailStartIndex >= 0 &&
        payload.tailStartIndex <= state.turnsPayload.turns.length
      ) {
        const tailTurns = Array.isArray(payload.turns) ? payload.turns : [];
        nextPayload = {
          ...payload,
          mode: 'full',
          turns: state.turnsPayload.turns.slice(0, payload.tailStartIndex).concat(tailTurns),
        };
      }
      const turns = Array.isArray(nextPayload?.turns) ? nextPayload.turns : [];
      let totalTokens = 0;
      let totalCalls = 0;
      for (let i = 0; i < turns.length; i++) {
        totalTokens += Number(turns[i]?.totalTokens || 0);
        totalCalls += Number(turns[i]?.calls || 0);
      }
      const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
      const lastCompleted = lastTurn ? Boolean(lastTurn.completed) : true;
      const prevCompleted = state.lastTurnCompleted;
      const prevTurnCount =
        sameChat && Array.isArray(state.turnsPayload?.turns) ? state.turnsPayload.turns.length : 0;
      const activitySig = `${cid}|${turns.length}|${totalTokens}|${totalCalls}`;
      const activityChanged = Boolean(sameChat && activitySig !== state.lastTurnActivitySig);
      state.lastTurnsCid = cid;
      state.lastTurnActivitySig = activitySig;
      state.lastTurnCompleted = lastCompleted;
      state.turnsPayload = nextPayload;
      state.turnsRenderSeq += 1;
      let newTurnAdded = false;
      if (cid && activityChanged) {
        const cidLower = cid.toLowerCase();
        const now = Date.now();
        if (prevTurnCount > 0 && turns.length > prevTurnCount) {
          newTurnAdded = true;
          state.localUserInputAtById[cidLower] = Math.max(
            state.localUserInputAtById[cidLower] || 0,
            now
          );
          schedulePostSendTrajectoryRefreshes([500]);
        }
        const meta = state.trajMetaById[cidLower];
        if (meta) {
          meta.lastModifiedMs = Math.max(meta.lastModifiedMs || 0, now);
          if (newTurnAdded) {
            meta.lastUserInputMs = Math.max(meta.lastUserInputMs || 0, now);
          }
        }
      }
      scheduleRender({ turns: true, chip: true, sidebar: newTurnAdded });
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
      if (payload?.batchSummary && typeof payload.batchSummary === 'object') {
        state.batchSummary = payload.batchSummary;
      }
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
      void maybeExecuteBatchWakeStep();
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

  window.__aqRenderKeepAlive = function (payload) {
    try {
      const incomingAcct = String(payload?.accountId || '').trim();
      const knownEmail = resolveActiveAccountEmail().toLowerCase();
      if (incomingAcct === 'default' && knownEmail) {
        return;
      }
      state.keepAliveState =
        payload && typeof payload === 'object'
          ? { accountId: incomingAcct, pools: payload.pools || {} }
          : { accountId: '', pools: {} };
      state.keepAliveLoaded = true;
      scheduleKeepAliveDeadlineTimer();
      syncQuotaTooltipKeepAliveInPlace();
      if (state.keepAliveRunningPools.size === 0) {
        void maybeRunKeepAlives();
      }
      void maybeExecuteBatchWakeStep();
    } catch {}
  };

  window.__aqRenderBatchKeepAlive = function (payload) {
    try {
      state.batchKeepAlive = payload && typeof payload === 'object' ? payload : null;
      renderBatchWakePanel();
      refreshQuotaTooltipIfVisible();
      void maybeExecuteBatchWakeStep();
    } catch {}
  };

  window.__aqResolveKeepAliveClaim = function (payload) {
    try {
      const reqId = String(payload?.requestId || '');
      const resolver = state.keepAliveClaims.get(reqId);
      if (resolver) {
        state.keepAliveClaims.delete(reqId);
        resolver(payload);
      }
    } catch {}
  };

  window.__aqResolveThinkingTranslate = function (payload) {
    try {
      if (state.disposed) return;
      const ts = state.thinkingTranslate;
      if (payload?.resetClientSig) {
        ts.lastUploadedClientSig = '';
      }
      const cid = String(payload?.cascadeId || '');
      const activeCid = extractCascadeId();
      if (!cid || cid !== activeCid || !ts.open) return;

      const reqId = String(payload?.requestId || '');
      if (!reqId || reqId !== ts.requestId) return;

      const turnEls = findTurnRows();
      const liveCtx = evaluateConversationLiveTurnContext(cid, turnEls);
      if (!liveCtx.running) {
        resetThinkingTranslateState();
        return;
      }

      const prevStepIdx = ts.stepIdx;
      const prevCount = ts.thinkingCount;
      ts.loading = false;
      ts.switchingSource = false;

      if (payload?.unchanged) {
        if (Number.isInteger(payload.stepIdx) && payload.stepIdx >= 0) ts.stepIdx = payload.stepIdx;
        if (Number(payload.thinkingCount) > 0) ts.thinkingCount = Number(payload.thinkingCount);
      } else if (payload?.ok && payload?.onlyOriginal) {
        ts.empty = false;
        ts.stepIdx = Number.isInteger(payload.stepIdx) ? payload.stepIdx : -1;
        ts.thinkingCount = Number(payload.thinkingCount || 0);
        ts.hasOriginal = true;
        if (typeof payload.sourceText === 'string') {
          ts.sourceText = payload.sourceText;
        }
      } else if (payload?.ok) {
        ts.error = '';
        ts.errorRetryAfter = 0;
        ts.empty = false;
        ts.stepIdx = Number.isInteger(payload.stepIdx) ? payload.stepIdx : -1;
        ts.thinkingCount = Number(payload.thinkingCount || 0);
        ts.activeSourcePref = sanitizeClientThinkingSource(payload.sourcePref || state.thinkingSourcePref);
        ts.hasOriginal = Boolean(payload.hasOriginal);
        ts.sourceText = String(payload.sourceText || '');
        ts.translatedText = String(payload.translatedText || '');
        ts.translatedSourceText = ts.sourceText;
        ts.providerLabel = String(payload.providerLabel || '');
      } else {
        ts.empty = Boolean(payload?.empty);
        ts.error = String(payload?.error || '翻译失败');
        ts.errorRetryAfter = ts.empty ? 0 : Date.now() + 8000;
        ts.hasOriginal = Boolean(payload?.hasOriginal);
        if (typeof payload?.sourceText === 'string' && payload.sourceText) {
          ts.sourceText = payload.sourceText;
        }
        if (Number(payload?.thinkingCount) > 0) {
          ts.thinkingCount = Number(payload.thinkingCount);
        }
      }

      renderRunningThinkingHelper(cid, turnEls, liveCtx);
      if (
        !payload?.unchanged &&
        payload?.ok &&
        ts.cardParts?.bodyEl &&
        ((ts.stepIdx >= 0 && ts.stepIdx !== prevStepIdx) || ts.thinkingCount !== prevCount)
      ) {
        ts.cardParts.bodyEl.scrollTop = 0;
      }
    } catch {}
  };

  window.__aqRenderUiPrefs = function (payload) {
    try {
      if (payload && typeof payload === 'object' && 'aiKeyConfigured' in payload) {
        const prevConfigured = Boolean(state.aiConfigMeta?.configured);
        const prevKey = state.aiConfigMeta?.apiKey || '';
        const prevModel = state.aiConfigMeta?.model || '';
        const prevEndpoint = state.aiConfigMeta?.endpoint || '';
        state.aiConfigMeta = {
          configured: Boolean(payload.aiKeyConfigured),
          apiKey: String(payload.aiApiKey || ''),
          hasEnvKey: Boolean(payload.hasEnvAiKey),
          source: String(payload.aiKeySource || ''),
          endpoint: String(payload.aiEndpoint || ''),
          model: String(payload.aiModel || ''),
        };
        if (
          payload.aiSavedRequestId &&
          payload.aiSavedRequestId === state.keySettingsRequestId
        ) {
          if (state.keySettingsTimer) {
            clearTimeout(state.keySettingsTimer);
            state.keySettingsTimer = null;
          }
          if (payload.aiSaveError) {
            state.keySettingsSaving = false;
            state.keySettingsRequestId = '';
            const modalEl = document.getElementById('aq-key-settings-modal');
            const saveBtn = modalEl?.querySelector?.('[data-aq-ks-save]');
            if (saveBtn) {
              saveBtn.disabled = false;
              saveBtn.textContent = '保存';
            }
            const errEl = modalEl?.querySelector?.('[data-aq-ks-err]');
            if (errEl) {
              errEl.textContent = String(payload.aiSaveError);
              errEl.hidden = false;
            }
          } else {
            closeKeySettingsModal();
          }
        } else if (state.keySettingsOpen) {
          const modalEl = document.getElementById('aq-key-settings-modal');
          const keyIn = modalEl?.querySelector?.('[data-aq-ks-key]');
          if (keyIn && !keyIn.getAttribute('data-aq-dirty')) {
            keyIn.value = state.aiConfigMeta.apiKey;
            keyIn.setAttribute(
              'placeholder',
              !state.aiConfigMeta.apiKey && state.aiConfigMeta.hasEnvKey
                ? '当前正使用环境变量 Key，填写后优先使用此处配置'
                : '粘贴智谱 BigModel 或 OpenAI 兼容 API Key'
            );
          }
          const modelIn = modalEl?.querySelector?.('[data-aq-ks-model]');
          if (modelIn && !modelIn.getAttribute('data-aq-dirty')) {
            modelIn.value = state.aiConfigMeta.model;
          }
          const epIn = modalEl?.querySelector?.('[data-aq-ks-endpoint]');
          if (epIn && !epIn.getAttribute('data-aq-dirty')) {
            epIn.value = state.aiConfigMeta.endpoint;
          }
        }
        const aiChanged =
          prevConfigured !== state.aiConfigMeta.configured ||
          prevKey !== state.aiConfigMeta.apiKey ||
          prevModel !== state.aiConfigMeta.model ||
          prevEndpoint !== state.aiConfigMeta.endpoint;
        if (aiChanged && state.thinkingTranslate.open && !state.thinkingTranslate.showOriginal) {
          state.thinkingTranslate.switchingSource = true;
          triggerLatestThinkingTranslate({ force: true });
        }
      }
      if (payload && typeof payload.thinkingTranslateSource === 'string') {
        const nextThinkingSrc = sanitizeClientThinkingSource(payload.thinkingTranslateSource);
        if (nextThinkingSrc !== state.thinkingSourcePref) {
          saveClientThinkingSourcePref(nextThinkingSrc, { notifyDaemon: false });
          if (state.thinkingTranslate.open) {
            if (!state.thinkingTranslate.showOriginal) {
              state.thinkingTranslate.switchingSource = true;
              triggerLatestThinkingTranslate({ force: true, explicitSource: nextThinkingSrc });
            } else {
              syncThinkingHelperDomContent();
            }
          }
        }
      }
      const mode =
        payload?.convWidthMode === 'full'
          ? 'full'
          : payload?.convWidthMode === 'custom'
            ? 'custom'
            : 'unset';
      if (mode === 'unset') {
        if (!state.uiPrefsMigrated) {
          state.uiPrefsMigrated = true;
          let legacy = { mode: 'unset', width: DEFAULT_CONV_WIDTH };
          try {
            legacy = parseConvWidthStorageValue(localStorage.getItem('aq_conv_max_width_v1'));
          } catch {}
          if (legacy.mode === 'custom' || legacy.mode === 'full') {
            state.convWidthMode = legacy.mode;
            state.convMaxWidth = legacy.width;
            if (!state.convWidthDrag) {
              applyConversationMaxWidthVar(legacy.width);
            }
            sendUiPrefsAction({ type: 'set-conv-width', mode: legacy.mode, width: legacy.width });
            state.uiPrefsLoaded = true;
            return;
          }
        }
        state.convWidthMode = 'unset';
        state.convMaxWidth = DEFAULT_CONV_WIDTH;
        if (!state.convWidthDrag) {
          applyConversationMaxWidthVar(DEFAULT_CONV_WIDTH);
        }
      } else {
        const nextW =
          mode === 'full'
            ? 0
            : Math.min(MAX_CONV_WIDTH, Math.max(MIN_CONV_WIDTH, Math.round(Number(payload?.convMaxWidth) || DEFAULT_CONV_WIDTH)));
        state.convWidthMode = mode;
        state.convMaxWidth = nextW;
        syncConvWidthLocalCache(nextW);
        if (!state.convWidthDrag) {
          applyConversationMaxWidthVar(nextW);
        }
      }
      state.uiPrefsLoaded = true;
    } catch {}
  };

  window.__aqRenderGroups = function (payload) {
    try {
      state.groupsLoaded = true;
      state.groupsCollapsedSection = Boolean(payload?.collapsedSection);
      if (Array.isArray(payload?.groups)) {
        state.groups = payload.groups;
        state.cachedGroupsRef = null;
        state.cachedGroupedCids = null;
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
      if (state.groupsError) {
        renderSidebarGroupsPanel(true);
      }
      renderGroupMenuContent();
      refreshOpenNativeMenuFolders();
      if (state.pendingUnpinCascadeIds.size > 0) {
        const pendingIds = [...state.pendingUnpinCascadeIds];
        state.pendingUnpinCascadeIds.clear();
        if (!state.groupsError) {
          for (let i = 0; i < pendingIds.length; i++) {
            const cid = pendingIds[i];
            if (isConversationGrouped(cid)) {
              if (unpinConversationIfPinned(cid)) {
                markAutoUnpinned(cid);
              }
            }
          }
        }
      }
      if (state.pendingRestorePinCascadeIds.size > 0) {
        const restoreIds = [...state.pendingRestorePinCascadeIds];
        state.pendingRestorePinCascadeIds.clear();
        if (!state.groupsError) {
          for (let i = 0; i < restoreIds.length; i++) {
            const cid = restoreIds[i];
            if (!isConversationGrouped(cid) && state.autoUnpinnedCids.has(cid)) {
              unmarkAutoUnpinned(cid);
              restorePinConversation(cid);
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
    ['aq-context-tooltip', scheduleHideContextTooltip],
    ['aq-quota-tooltip', scheduleHideQuotaTooltip],
  ]) {
    const tt = ensureTooltipEl(ttId);
    tt.addEventListener('pointerenter', () => {
      if (ttId === 'aq-turn-tooltip' && state.turnTooltipHideTimer) {
        clearTimeout(state.turnTooltipHideTimer);
        state.turnTooltipHideTimer = null;
      }
      if (ttId === 'aq-context-tooltip' && state.ctxTooltipHideTimer) {
        clearTimeout(state.ctxTooltipHideTimer);
        state.ctxTooltipHideTimer = null;
      }
      if (ttId === 'aq-quota-tooltip' && state.quotaTooltipHideTimer) {
        clearTimeout(state.quotaTooltipHideTimer);
        state.quotaTooltipHideTimer = null;
      }
    });
    tt.addEventListener('pointerleave', hideFn);
  }

  injectStyles();

  const SELF_MUTATION_IGNORE_SELECTOR =
    '[data-aq-turn-usage], [data-aq-thinking-btn], [data-aq-thinking-card], [data-aq-native-menu-ext], [data-aq-proj-card], [data-aq-row-grp-btn], .aq-conv-width-resizer, #aq-context-chip, #aq-quota-chip, #aq-context-tooltip, #aq-quota-tooltip, #aq-acct-quota-tooltip, #aq-key-settings-modal, #aq-batch-wake-panel, #aq-batch-toast, #aq-turn-tooltip, #aq-sidebar-tabs, #aq-conv-groups, #aq-group-menu, #aq-grp-ctx-menu, #aq-conv-drag-ghost';

  const POPUP_CHROME_SELECTOR = [
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
  ].join(', ');

  // Watch DOM changes in chat, chrome & composer
  state.domObserver = new MutationObserver((mutations) => {
    if (state.disposed || state.isTranslating) return;
    let shouldFlushNow = false;
    let dirtyChip = false;
    let dirtySidebar = false;
    let dirtyTurns = false;
    let dirtyMenus = false;
    let dirtyI18n = false;
    let dirtyI18nSidebar = false;

    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      const t = m.target;
      const el = t?.nodeType === 1 ? t : t?.parentElement;
      if (!el || el.closest?.(SELF_MUTATION_IGNORE_SELECTOR)) {
        continue;
      }
      // Ignore high-frequency typing in Lexical input and token-by-token AI Markdown streaming
      if (el.closest?.('[data-lexical-editor], [data-markdown-root]')) {
        continue;
      }
      if (m.type === 'characterData') {
        if (el.closest?.(POPUP_CHROME_SELECTOR)) {
          shouldFlushNow = true;
          dirtyMenus = true;
          dirtyI18n = true;
        } else if (el.closest?.('.bg-sidebar:not([data-testid="title-menu-bar"])')) {
          dirtySidebar = true;
          dirtyI18n = true;
          dirtyI18nSidebar = true;
        } else if (el.closest?.(TURN_CHROME_SELECTOR)) {
          dirtyI18n = true;
        }
        continue;
      }
      if (m.type === 'attributes') {
        if (el.closest?.('.bg-sidebar:not([data-testid="title-menu-bar"])')) {
          dirtySidebar = true;
        } else {
          dirtyChip = true;
          dirtySidebar = true;
          dirtyTurns = true;
        }
        continue;
      }
      if (m.type === 'childList') {
        const changed = [...(m.addedNodes || []), ...(m.removedNodes || [])];
        if (
          changed.length > 0 &&
          changed.every((n) => n?.nodeType === 1 && n.matches?.(SELF_MUTATION_IGNORE_SELECTOR))
        ) {
          continue;
        }
        if (el.closest?.(POPUP_CHROME_SELECTOR)) {
          shouldFlushNow = true;
          dirtyMenus = true;
          dirtyI18n = true;
          continue;
        }
        if (m.addedNodes?.length) {
          let hitPopup = false;
          for (let j = 0; j < m.addedNodes.length; j++) {
            const n = m.addedNodes[j];
            if (n?.nodeType === 1 && (n.matches?.(POPUP_CHROME_SELECTOR) || n.querySelector?.(POPUP_CHROME_SELECTOR))) {
              hitPopup = true;
              break;
            }
          }
          if (hitPopup) {
            shouldFlushNow = true;
            dirtyMenus = true;
            dirtyI18n = true;
          }
        }
        if (el.closest?.('.bg-sidebar:not([data-testid="title-menu-bar"])')) {
          dirtySidebar = true;
          dirtyI18n = true;
          dirtyI18nSidebar = true;
        } else if (el.closest?.('#antigravity\\.agentSidePanelInputBox')) {
          dirtyChip = true;
          dirtyTurns = true;
          dirtyI18n = true;
        } else if (el.closest?.('[data-testid="conversation-view"]')) {
          dirtyTurns = true;
          dirtyChip = true;
          dirtyI18n = true;
        } else {
          dirtyChip = true;
          dirtySidebar = true;
          dirtyTurns = true;
          dirtyMenus = true;
          dirtyI18n = true;
          dirtyI18nSidebar = true;
        }
      }
    }
    if (shouldFlushNow) {
      syncNativeConversationMenus();
    }
    if (dirtyChip || dirtySidebar || dirtyTurns || dirtyMenus || dirtyI18n) {
      scheduleRender({
        chip: dirtyChip,
        sidebar: dirtySidebar,
        turns: dirtyTurns,
        menus: dirtyMenus,
        i18n: dirtyI18n,
        i18nSidebar: dirtyI18nSidebar,
      });
    }
  });
  state.domObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-selected', 'data-cascade-id'],
  });

  function scheduleHistoryRouteCheck(delayMs) {
    const id = setTimeout(() => {
      state.historyTimers.delete(id);
      if (!state.disposed) checkRoute();
    }, delayMs);
    state.historyTimers.add(id);
  }

  // Hook history API
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function (...args) {
    const r = origPush.apply(this, args);
    scheduleHistoryRouteCheck(0);
    scheduleHistoryRouteCheck(120);
    return r;
  };
  history.replaceState = function (...args) {
    const r = origReplace.apply(this, args);
    scheduleHistoryRouteCheck(0);
    return r;
  };
  const onPopState = () => checkRoute();
  const onVisChange = () => {
    if (document.hidden) {
      stopLiveTurnTimer();
      return;
    }
    checkRoute();
    scheduleRender({ turns: true });
    if (!state.quotaData || Date.now() - state.quotaForceFetchedAt >= 10_000) {
      void fetchQuota({ force: true });
    }
    void refreshTrajectoryMetadata(false, 5_000);
  };
  const recordNativeMenuTargetFromEvent = (ev) => {
    const row = ev.target?.closest?.('[data-testid="conversation-row-sidebar"][data-cascade-id]');
    if (row && !row.closest('[aria-hidden="true"]')) {
      const info = extractRowConversationInfo(row);
      if (info?.cascadeId) {
        state.lastNativeMenuConv = { ...info, at: Date.now() };
      }
    }
  };
  const onDocContextMenuCapture = (ev) => {
    recordNativeMenuTargetFromEvent(ev);
  };
  const onDocPointerDown = (ev) => {
    recordNativeMenuTargetFromEvent(ev);
    const t = ev.target;
    if (state.quotaTooltipPinned && !t?.closest?.('#aq-quota-tooltip, #aq-acct-quota-tooltip, #aq-quota-chip')) {
      closeQuotaTooltip();
    }
    if (state.groupMenuTarget && !t?.closest?.('#aq-group-menu, [data-aq-grp-item-menu], [data-aq-row-grp-btn]')) {
      closeGroupMenu();
    }
    if (!t?.closest?.('#aq-grp-ctx-menu')) {
      closeGroupCtxMenu();
    }
    if (ev.button !== 0) return;
    const convResizer = t?.closest?.('[data-aq-conv-resizer]');
    if (convResizer) {
      const viewEl = convResizer.closest('[data-testid="conversation-view"]');
      if (!viewEl || !viewEl.classList.contains('aq-conv-width-armed')) return;
      const colEl = findActiveConversationColumn(viewEl);
      if (viewEl && colEl) {
        ev.preventDefault();
        ev.stopPropagation();
        if (state.convWidthBadgeTimer) {
          clearTimeout(state.convWidthBadgeTimer);
          state.convWidthBadgeTimer = null;
        }
        convResizer.classList.remove('is-flash');
        const { viewRect, availWidth, centerX } = computeConversationAvailBounds(viewEl, colEl);
        const startW = state.convMaxWidth > 0 ? Math.min(availWidth, state.convMaxWidth) : 0;
        const leftHandle = viewEl.querySelector(':scope > .aq-conv-width-resizer[data-aq-conv-resizer="left"]');
        const rightHandle = viewEl.querySelector(':scope > .aq-conv-width-resizer[data-aq-conv-resizer="right"]');
        const badgeEl = convResizer.querySelector('[data-aq-conv-width-badge]');
        const targetCols = [
          ...viewEl.querySelectorAll('[style*="--max-conversation-width"], [style*="--max-artifact-width"]'),
        ].map((el) => ({
          el,
          origMaxWidth: el.style.getPropertyValue('max-width') || 'max(30vw, var(--max-conversation-width, 48rem))',
        }));
        state.convWidthDrag = {
          viewEl,
          resizerEl: convResizer,
          leftHandle,
          rightHandle,
          badgeEl,
          targetCols,
          viewLeft: viewRect.left,
          viewWidth: viewRect.width,
          centerX,
          maxAvailW: availWidth,
          startX: ev.clientX,
          currentWidth: startW,
          moved: false,
        };
        if (badgeEl) badgeEl.textContent = formatConversationWidthLabel(startW);
        convResizer.classList.add('is-resizing');
        viewEl.classList.add('aq-conv-width-active');
        document.body.classList.add('aq-resizing-conv-width');
      }
      return;
    }
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
        'button, input, textarea, [contenteditable="true"], [data-no-drag], #aq-group-menu, #aq-grp-ctx-menu, .aq-grp-item-actions, .aq-grp-actions'
      )
    ) {
      return;
    }
    const grpHdrEl = t?.closest?.('#aq-conv-groups [data-aq-grp-hdr]');
    if (grpHdrEl) {
      const gid = grpHdrEl.getAttribute('data-aq-grp-hdr') || '';
      const grp = state.groups.find((g) => g.id === gid);
      const blockEl = grpHdrEl.closest('[data-aq-grp-block]');
      if (grp && blockEl && !state.groupRenamingId && !state.groupCreating) {
        startConversationPointerDrag({
          mode: 'group-folder',
          sourceGroupId: gid,
          sourceEl: blockEl,
          item: { cascadeId: gid, title: grp.name },
          startX: ev.clientX,
          startY: ev.clientY,
        });
      }
      return;
    }
    const grpItemEl = t?.closest?.('#aq-conv-groups [data-aq-grp-open]');
    if (grpItemEl) {
      const cid = grpItemEl.getAttribute('data-aq-grp-open') || '';
      const gid = grpItemEl.getAttribute('data-aq-grp-gid') || '';
      if (gid) {
        const grp = state.groups.find((g) => g.id === gid);
        const found = grp?.items?.find((it) => String(it.cascadeId || '') === cid);
        if (found) {
          startConversationPointerDrag({
            mode: 'group-item',
            sourceGroupId: gid,
            sourceEl: grpItemEl,
            item: { cascadeId: found.cascadeId, title: found.title, project: found.project || '' },
            startX: ev.clientX,
            startY: ev.clientY,
          });
        }
      } else if (cid) {
        const meta = state.trajMetaById[cid.toLowerCase()];
        const title =
          grpItemEl.querySelector('.aq-grp-item-title')?.textContent?.trim() ||
          meta?.title ||
          '未命名对话';
        const project = grpItemEl.getAttribute('data-aq-project') || meta?.project || '';
        startConversationPointerDrag({
          mode: 'native-row',
          sourceGroupId: '',
          sourceEl: grpItemEl,
          item: { cascadeId: cid, title, project },
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
    const cw = state.convWidthDrag;
    if (cw) {
      if (ev.buttons === 0) {
        cleanupConversationWidthDrag({ commit: cw.moved });
        return;
      }
      if (Math.abs(ev.clientX - cw.startX) >= 2) cw.moved = true;
      const rawW = Math.round(Math.abs(ev.clientX - cw.centerX) * 2);
      let nextW = 0;
      if (rawW >= cw.maxAvailW - 28) {
        nextW = 0;
      } else if (
        Math.abs(rawW - DEFAULT_CONV_WIDTH) <= 12 &&
        cw.maxAvailW > DEFAULT_CONV_WIDTH + 40
      ) {
        nextW = DEFAULT_CONV_WIDTH;
      } else {
        nextW = Math.max(MIN_CONV_WIDTH, Math.min(cw.maxAvailW, rawW));
      }
      cw.currentWidth = nextW;
      if (!state.convWidthDragRaf) {
        state.convWidthDragRaf = requestAnimationFrame(() => {
          state.convWidthDragRaf = 0;
          const active = state.convWidthDrag;
          if (!active) return;
          const w = active.currentWidth;
          const maxWExpr = w > 0 ? `min(100%, ${Math.round(w)}px)` : '100%';
          for (let i = 0; i < active.targetCols.length; i++) {
            active.targetCols[i].el.style.setProperty('max-width', maxWExpr, 'important');
          }
          if (active.badgeEl) {
            const label = formatConversationWidthLabel(w);
            if (active.badgeEl.textContent !== label) {
              active.badgeEl.textContent = label;
            }
          }
        });
      }
      ev.preventDefault();
      return;
    }
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
    const ad = state.acctDrag;
    if (ad) {
      if (ev.buttons === 0) {
        cleanupAccountDrag();
        return;
      }
      ad.lastY = ev.clientY;
      if (!ad.started) {
        if (Math.max(Math.abs(ev.clientX - ad.startX), Math.abs(ev.clientY - ad.startY)) > 5) {
          cleanupAccountDrag();
        }
        return;
      }
      updateAccountDragTarget(ev.clientY);
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
      d.lastX = ev.clientX;
      d.lastY = ev.clientY;
      if (Math.max(Math.abs(ev.clientX - d.startX), Math.abs(ev.clientY - d.startY)) < 5) {
        return;
      }
      activateConversationPointerDrag(d);
    }
    d.lastX = ev.clientX;
    d.lastY = ev.clientY;
    if (!state.convDragRaf) {
      state.convDragRaf = requestAnimationFrame(() => {
        state.convDragRaf = 0;
        const active = state.convDrag;
        if (!state.disposed && active?.started) {
          updateConversationDragTarget(active.lastX, active.lastY);
        }
      });
    }
  };
  const onWinPointerUpCapture = (ev) => {
    const cw = state.convWidthDrag;
    if (cw) {
      cleanupConversationWidthDrag({ commit: cw.moved });
      ev.preventDefault();
      return;
    }
    const r = state.groupResizeDrag;
    if (r) {
      cleanupGroupResizeDrag({ commit: r.moved });
      ev.preventDefault();
      return;
    }
    const ad = state.acctDrag;
    if (ad) {
      if (ad.started) {
        updateAccountDragTarget(ev.clientY);
        commitAccountDrag();
        ev.preventDefault();
        ev.stopPropagation();
      } else {
        cleanupAccountDrag();
      }
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
    const folderMode = d.folderDragMode;
    const folderTargetId = d.folderTargetId;
    const folderTargetCid = d.folderTargetCid;
    const itemDropMode = d.itemDropMode;
    const itemTargetCid = d.itemTargetCid;
    const itemTargetGroupId = d.itemTargetGroupId;
    const droppedInGroupTarget = Boolean(
      targetGroupId ||
        dropOnEmptyPanel ||
        (itemDropMode && (itemTargetCid || itemTargetGroupId)) ||
        (folderMode && (folderTargetId || folderTargetCid || folderMode === 'root'))
    );
    if (d.switchedFromProjects && droppedInGroupTarget) {
      saveSidebarTab('groups');
    }
    cleanupConversationPointerDrag({ keepTab: droppedInGroupTarget });

    if (d.mode === 'group-folder') {
      state.suppressGroupClickUntil = Date.now() + 200;
      ev.preventDefault();
      ev.stopPropagation();
      if (folderMode === 'root') {
        state.groupsError = '';
        sendGroupAction({ type: 'move-group', groupId: d.sourceGroupId, parentId: '' });
      } else if ((folderMode === 'before' || folderMode === 'after') && folderTargetCid) {
        const srcGrp = state.groups.find((g) => g.id === d.sourceGroupId);
        const parentId = srcGrp?.parentId || '';
        if (parentId) {
          state.groupsError = '';
          applyOptimisticChildReorder(
            parentId,
            `g:${d.sourceGroupId}`,
            `c:${folderTargetCid.toLowerCase()}`,
            folderMode
          );
          sendGroupAction({
            type: 'move-group',
            groupId: d.sourceGroupId,
            parentId,
            ...(folderMode === 'before'
              ? { beforeCascadeId: folderTargetCid }
              : { afterCascadeId: folderTargetCid }),
          });
        }
      } else if (
        folderTargetId &&
        folderTargetId !== d.sourceGroupId &&
        !isGroupDescendant(state.groups, d.sourceGroupId, folderTargetId)
      ) {
        state.groupsError = '';
        if (folderMode === 'inside') {
          sendGroupAction({ type: 'move-group', groupId: d.sourceGroupId, parentId: folderTargetId });
        } else if (folderMode === 'before' || folderMode === 'after') {
          const srcGrp = state.groups.find((g) => g.id === d.sourceGroupId);
          const targetGrp = state.groups.find((g) => g.id === folderTargetId);
          const nextParentId = targetGrp?.parentId || '';
          if (nextParentId && (srcGrp?.parentId || '') === nextParentId) {
            applyOptimisticChildReorder(
              nextParentId,
              `g:${d.sourceGroupId}`,
              `g:${folderTargetId}`,
              folderMode
            );
          } else if (!nextParentId && !(srcGrp?.parentId || '')) {
            const fromIdx = state.groups.findIndex((g) => g.id === d.sourceGroupId);
            if (fromIdx >= 0) {
              const moving = state.groups[fromIdx];
              const without = state.groups.filter((_, idx) => idx !== fromIdx);
              const tIdx = without.findIndex((g) => g.id === folderTargetId);
              if (tIdx >= 0) {
                without.splice(folderMode === 'before' ? tIdx : tIdx + 1, 0, moving);
                if (without.some((g, idx) => g.id !== state.groups[idx]?.id)) {
                  state.groups = without;
                  state.cachedGroupsRef = null;
                  state.cachedGroupedCids = null;
                  renderSidebarGroupsPanel(false);
                }
              }
            }
          }
          sendGroupAction({
            type: 'move-group',
            groupId: d.sourceGroupId,
            parentId: nextParentId,
            ...(folderMode === 'before'
              ? { beforeGroupId: folderTargetId }
              : { afterGroupId: folderTargetId }),
          });
        }
      }
      return;
    }

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
      if (itemDropMode && (itemTargetCid || itemTargetGroupId) && d.sourceGroupId) {
        state.groupsError = '';
        const dragLower = String(d.item?.cascadeId || '').toLowerCase();
        const anchorToken = itemTargetGroupId
          ? `g:${itemTargetGroupId}`
          : `c:${itemTargetCid.toLowerCase()}`;
        applyOptimisticChildReorder(
          d.sourceGroupId,
          `c:${dragLower}`,
          anchorToken,
          itemDropMode
        );
        sendGroupAction({
          type: 'reorder-items',
          groupId: d.sourceGroupId,
          cascadeId: d.item.cascadeId,
          ...(itemTargetGroupId
            ? itemDropMode === 'before'
              ? { beforeGroupId: itemTargetGroupId }
              : { afterGroupId: itemTargetGroupId }
            : itemDropMode === 'before'
              ? { beforeCascadeId: itemTargetCid }
              : { afterCascadeId: itemTargetCid }),
        });
      } else if (targetGroupId && targetGroupId !== d.sourceGroupId) {
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
    if (state.acctDrag) cleanupAccountDrag();
    if (state.convWidthDrag) cleanupConversationWidthDrag();
    if (state.groupResizeDrag) cleanupGroupResizeDrag();
    if (state.convDrag) cleanupConversationPointerDrag();
  };
  const onWinBlur = () => {
    closeGroupCtxMenu();
    if (state.acctDrag) cleanupAccountDrag();
    if (state.convWidthDrag) cleanupConversationWidthDrag();
    if (state.groupResizeDrag) cleanupGroupResizeDrag();
    if (state.convDrag) cleanupConversationPointerDrag();
  };
  const onDocClickCapture = (ev) => {
    const composerBox = ev.target?.closest?.('#antigravity\\.agentSidePanelInputBox');
    if (!composerBox) return;
    const sendBtn = ev.target?.closest?.('[data-testid="send-button"]');
    if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true') {
      markConversationSendStarted(extractCascadeId());
      return;
    }
    if (ev.target?.closest?.('[data-testid="input-cancel-button"]')) {
      markConversationSendCanceled(extractCascadeId());
    }
  };
  const onDocKeyDown = (ev) => {
    if (
      ev.key === 'Enter' &&
      !ev.isComposing &&
      ev.keyCode !== 229 &&
      !ev.shiftKey &&
      !ev.altKey &&
      !ev.ctrlKey &&
      !ev.metaKey
    ) {
      const editor = ev.target?.closest?.('#antigravity\\.agentSidePanelInputBox [data-lexical-editor="true"]');
      const hasOpenComposerPopup = Boolean(document.querySelector('[data-mention-menu], [role="listbox"], [role="menu"]'));
      if (editor && editor.getAttribute('aria-expanded') !== 'true' && !hasOpenComposerPopup) {
        const composerBox = document.getElementById('antigravity.agentSidePanelInputBox');
        const sendBtn = composerBox?.querySelector?.('[data-testid="send-button"]');
        if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true') {
          markConversationSendStarted(extractCascadeId());
        }
      }
    }
    if (ev.key === 'Escape') {
      closeGroupCtxMenu();
      if (state.acctDrag) {
        cleanupAccountDrag();
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      if (state.convWidthDrag) {
        cleanupConversationWidthDrag({ commit: false });
        ev.preventDefault();
        ev.stopPropagation();
      }
      if (state.convDrag?.started) {
        const wasGroupDrag =
          state.convDrag.mode === 'group-item' || state.convDrag.mode === 'group-folder';
        cleanupConversationPointerDrag();
        if (wasGroupDrag) {
          ev.preventDefault();
          ev.stopPropagation();
        }
      }
      if (state.keySettingsOpen) closeKeySettingsModal();
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
  document.addEventListener('contextmenu', onDocContextMenuCapture, true);
  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('click', onDocClickCapture, true);
  document.addEventListener('keydown', onDocKeyDown, true);

  state.routeTimer = setInterval(checkRoute, 2000);
  state.trajStatusTimer = setInterval(() => {
    if (!document.hidden) {
      void refreshTrajectoryMetadata(false, 9_000);
    }
  }, TRAJ_STATUS_POLL_MS);
  state.quotaTimer = setInterval(() => {
    const now = Date.now();
    if (!document.hidden) {
      if (hasExpiredQuotaBucket(now) || now - state.quotaForceFetchedAt >= 120_000) {
        void fetchQuota({ force: true });
      }
      if (!state.acctDrag && !state.pendingSwitchConfirmId) {
        refreshQuotaTooltipIfVisible();
      }
      void refreshTrajectoryMetadata(false);
    } else if (hasExpiredEnabledKeepAlive(now)) {
      void fetchQuota({ force: true, immediate: true, includeUserStatus: true });
    }
  }, 60_000);

  const cleanupInstance = function () {
    if (state.disposed) return;
    state.disposed = true;
    state.domObserver?.disconnect();
    state.footerObserver?.disconnect();
    state.footerResizeObserver?.disconnect();
    state.domObserver = null;
    state.footerObserver = null;
    state.footerResizeObserver = null;
    if (state.renderRaf) cancelAnimationFrame(state.renderRaf);
    state.renderRaf = 0;
    if (state.chipResizeRaf) cancelAnimationFrame(state.chipResizeRaf);
    state.chipResizeRaf = 0;
    if (state.projScrollRaf) cancelAnimationFrame(state.projScrollRaf);
    state.projScrollRaf = 0;
    if (state.convDragRaf) cancelAnimationFrame(state.convDragRaf);
    state.convDragRaf = 0;
    for (const tid of state.historyTimers) clearTimeout(tid);
    state.historyTimers.clear();
    stopLiveTurnTimer();
    if (state.postSendTurnsTimer) clearTimeout(state.postSendTurnsTimer);
    if (state.routeTimer) clearInterval(state.routeTimer);
    if (state.trajStatusTimer) clearInterval(state.trajStatusTimer);
    if (state.quotaTimer) clearInterval(state.quotaTimer);
    if (state.quotaDebounceTimer) clearTimeout(state.quotaDebounceTimer);
    if (state.turnTooltipShowTimer) clearTimeout(state.turnTooltipShowTimer);
    if (state.turnTooltipHideTimer) clearTimeout(state.turnTooltipHideTimer);
    if (state.ctxTooltipShowTimer) clearTimeout(state.ctxTooltipShowTimer);
    if (state.ctxTooltipHideTimer) clearTimeout(state.ctxTooltipHideTimer);
    if (state.quotaTooltipShowTimer) clearTimeout(state.quotaTooltipShowTimer);
    if (state.quotaTooltipHideTimer) clearTimeout(state.quotaTooltipHideTimer);
    if (state.acctQuotaTooltipShowTimer) clearTimeout(state.acctQuotaTooltipShowTimer);
    if (state.acctQuotaTooltipHideTimer) clearTimeout(state.acctQuotaTooltipHideTimer);
    if (state.pendingSwitchTimer) clearTimeout(state.pendingSwitchTimer);
    if (state.pendingBatchConfirmTimer) clearTimeout(state.pendingBatchConfirmTimer);
    if (state.batchReadyRetryTimer) clearTimeout(state.batchReadyRetryTimer);
    if (state.batchToastTimer) clearTimeout(state.batchToastTimer);
    if (state.groupDeleteConfirmTimer) clearTimeout(state.groupDeleteConfirmTimer);
    if (state.smartGraceTimer) clearTimeout(state.smartGraceTimer);
    if (state.groupResizeSnapTimer) clearTimeout(state.groupResizeSnapTimer);
    if (state.convWidthBadgeTimer) clearTimeout(state.convWidthBadgeTimer);
    if (state.convWidthHoverTimer) clearTimeout(state.convWidthHoverTimer);
    if (state.convWidthDragRaf) cancelAnimationFrame(state.convWidthDragRaf);
    if (state.optimisticExpiryTimer) clearTimeout(state.optimisticExpiryTimer);
    if (state.keepAliveDeadlineTimer) clearTimeout(state.keepAliveDeadlineTimer);
    if (state.keySettingsTimer) clearTimeout(state.keySettingsTimer);
    try {
      clearPostSendRefreshTimers();
    } catch {}
    try {
      if (state.contextMenuProto?.__aqOrigGet) {
        state.contextMenuProto.get = state.contextMenuProto.__aqOrigGet;
        delete state.contextMenuProto.__aqOrigGet;
        if (state.contextMenuProviderFiber) {
          bumpContextMenuProvider(state.contextMenuProviderFiber);
        }
      }
    } catch {}
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
    document.removeEventListener('contextmenu', onDocContextMenuCapture, true);
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('click', onDocClickCapture, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
    try {
      cleanupAccountDrag();
    } catch {}
    try {
      cleanupConversationWidthDrag();
    } catch {}
    try {
      cleanupGroupResizeDrag();
    } catch {}
    try {
      cleanupConversationPointerDrag();
    } catch {}
    try {
      closeGroupMenu();
      closeGroupCtxMenu();
    } catch {}
    document.documentElement.style.removeProperty('--aq-conv-max-width');
    document.querySelectorAll('[data-testid="conversation-view"].aq-conv-width-armed').forEach((el) => {
      el.classList.remove('aq-conv-width-armed');
    });
    document.querySelectorAll('.aq-conv-width-resizer').forEach((el) => el.remove());
    state.optimisticRunningById.clear();
    state.turnConfirmedPeakMsByKey.clear();
    state.nonDaemonBgTaskCids.clear();
    state.keepAliveClaims.clear();
    state.keepAliveRunningPools.clear();
    state.hiddenKeepAliveCids.clear();
    state.smartStableMap.clear();
    state.trajMetaById = Object.create(null);
    state.localViewedAtById = Object.create(null);
    state.localUserInputAtById = Object.create(null);
    state.groups = [];
    state.accounts = [];
    state.turnsPayload = null;
    state.latestSidebarDomInfo = null;
    state.contextMenuProviderFiber = null;
    state.contextMenuProto = null;
    state.observedFooterBox = null;
    state.observedResizeFooter = null;
    state.turnTooltipAnchor = null;
    state.ctxTooltipAnchor = null;
    state.quotaTooltipAnchor = null;
    state.i18nTextCache = null;
    state.i18nAttrCache = null;
    state.i18nCtrlSigCache = null;
    document.getElementById('aq-codex-theme')?.remove();
    document.getElementById('aq-style')?.remove();
    document.getElementById('aq-context-chip')?.remove();
    document.getElementById('aq-quota-chip')?.remove();
    document.getElementById('aq-context-tooltip')?.remove();
    document.getElementById('aq-quota-tooltip')?.remove();
    closeKeySettingsModal();
    document.getElementById('aq-acct-quota-tooltip')?.remove();
    document.getElementById('aq-batch-wake-panel')?.remove();
    document.getElementById('aq-batch-toast')?.remove();
    document.getElementById('aq-turn-tooltip')?.remove();
    document.getElementById('aq-sidebar-tabs-row')?.remove();
    document.getElementById('aq-sidebar-tabs')?.remove();
    document.getElementById('aq-conv-groups')?.remove();
    document.getElementById('aq-group-row-btn')?.remove();
    document.getElementById('aq-group-menu')?.remove();
    document.getElementById('aq-grp-ctx-menu')?.remove();
    document.getElementById('aq-conv-drag-ghost')?.remove();
    if (state.projScrollEl) {
      state.projScrollEl.classList.remove('aq-proj-scrolled');
      if (state.onProjScroll) {
        state.projScrollEl.removeEventListener('scroll', state.onProjScroll);
      }
      state.projScrollEl = null;
      state.onProjScroll = null;
    }
    document.querySelectorAll('[data-aq-pinned-new-grp]').forEach((el) => el.remove());
    document.querySelectorAll('[data-aq-proj-card]').forEach((el) => el.remove());
    document.querySelectorAll('.bg-sidebar[data-aq-tab]').forEach((el) => {
      el.removeAttribute('data-aq-tab');
      el.style.removeProperty('--aq-pinned-height');
      el.style.removeProperty('--aq-pinned-offset');
    });
    document.querySelectorAll('[data-aq-row-grp-btn]').forEach((el) => el.remove());
    document.querySelectorAll('[data-aq-no-project]').forEach((el) => el.removeAttribute('data-aq-no-project'));
    document.querySelectorAll('[data-aq-native-menu-ext]').forEach((el) => el.remove());
    document.querySelectorAll('[data-aq-menu-open]').forEach((el) => el.removeAttribute('data-aq-menu-open'));
    document.querySelectorAll('[data-aq-turn-usage]').forEach((el) => el.remove());
    resetThinkingTranslateState();
    if (window.__aq_active_token === INSTANCE_TOKEN) {
      delete window.__aq_active_token;
      delete window.__aqRenderTurns;
      delete window.__aqGetWatchedCascadeId;
      delete window.__aqRenderAccounts;
      delete window.__aqRenderUpdate;
      delete window.__aqRenderKeepAlive;
      delete window.__aqResolveKeepAliveClaim;
      delete window.__aqResolveThinkingTranslate;
      delete window.__aqRenderBatchKeepAlive;
      delete window.__aqRenderUiPrefs;
      delete window.__aqRenderGroups;
      delete window.__aqHydrated;
      delete window.__aq_version;
      delete window.__aqCleanup;
    }
  };
  window.__aqCleanupRegistry.push(cleanupInstance);
  window.__aqCleanup = cleanupInstance;

  window.__aqHydrated = false;
  window.__aq_version = INJECT_VERSION;
  ensureWebContextMenuMode();
  checkRoute();
  void fetchQuota({ force: false, includeUserStatus: true }).then(() => {
    if (!document.hidden) {
      void fetchQuota({ force: true, immediate: true });
    }
  });
  void refreshTrajectoryMetadata(true);
})();
