import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { buildClientScript } from '../src/daemon.mjs';
import {
  DEFAULT_CONV_WIDTH,
  MIN_CONV_WIDTH,
  readUiPrefsStore,
  sanitizeConvWidthPref,
  updateConversationWidthPref,
} from '../src/ui-prefs.mjs';

test('ui-prefs store persists unset, custom, and full conversation widths with bounds', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-ui-prefs-test-'));
  const filePath = path.join(tmpDir, 'ui-prefs.json');

  try {
    assert.deepEqual(readUiPrefsStore(filePath), {
      version: 1,
      convWidthMode: 'unset',
      convMaxWidth: 0,
    });

    const custom = updateConversationWidthPref(filePath, { mode: 'custom', width: 985.4 });
    assert.deepEqual(custom, {
      version: 1,
      convWidthMode: 'custom',
      convMaxWidth: 985,
    });
    assert.deepEqual(readUiPrefsStore(filePath), custom);

    const tooSmall = sanitizeConvWidthPref({ mode: 'custom', width: 320 });
    assert.deepEqual(tooSmall, { convWidthMode: 'unset', convMaxWidth: 0 });

    const tooLarge = sanitizeConvWidthPref({ mode: 'custom', width: 20000 });
    assert.deepEqual(tooLarge, { convWidthMode: 'custom', convMaxWidth: 8192 });

    const full = updateConversationWidthPref(filePath, { mode: 'full', width: 0 });
    assert.deepEqual(full, {
      version: 1,
      convWidthMode: 'full',
      convMaxWidth: 0,
    });

    fs.writeFileSync(filePath, '{corrupted json', 'utf8');
    assert.deepEqual(readUiPrefsStore(filePath), {
      version: 1,
      convWidthMode: 'unset',
      convMaxWidth: 0,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function createFakeClientDom(initialStorage = {}) {
  const storage = new Map(Object.entries(initialStorage));
  const styleProps = new Map();
  const rootEl = {
    style: {
      getPropertyValue: (k) => styleProps.get(k) || '',
      setProperty: (k, v) => {
        styleProps.set(k, String(v));
      },
      removeProperty: (k) => {
        styleProps.delete(k);
      },
    },
    appendChild: () => {},
  };
  const win = {
    innerWidth: 1280,
    innerHeight: 800,
    location: { href: 'https://127.0.0.1:63086/', pathname: '/', search: '' },
    history: { pushState: () => {}, replaceState: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({
      backgroundColor: '#ffffff',
      getPropertyValue: () => '',
    }),
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => {
        storage.set(k, String(v));
      },
      removeItem: (k) => {
        storage.delete(k);
      },
    },
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    matchMedia: () => ({ matches: false }),
    __APP_CONFIG__: { productName: 'antigravity' },
  };
  win.window = win;
  win.top = win;
  win.self = win;
  win.document = {
    hidden: true,
    head: rootEl,
    body: {
      classList: { contains: () => false, add: () => {}, remove: () => {} },
      appendChild: () => {},
    },
    documentElement: rootEl,
    createElement: () => ({
      id: '',
      className: '',
      style: { setProperty: () => {}, removeProperty: () => {} },
      classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
      setAttribute: () => {},
      removeAttribute: () => {},
      appendChild: () => {},
      addEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      remove: () => {},
    }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { win, storage, styleProps };
}

test('client CSS fallback is 768px instead of 100% and unset storage does not widen to full width', () => {
  for (const codexTheme of [true, false]) {
    const { script } = buildClientScript({ codexTheme, zhUi: true });
    assert.doesNotMatch(script, /var\(--aq-conv-max-width,\s*100%\)/);
    assert.match(script, /var\(--aq-conv-max-width,\s*768px\)/);
  }

  const { script } = buildClientScript({ codexTheme: true, zhUi: true });

  // Empty localStorage on a new localhost port must default to 768px and sync from daemon prefs
  const fresh = createFakeClientDom({});
  const sentActions = [];
  fresh.win.__aqUiPrefsAction = (raw) => sentActions.push(JSON.parse(raw));
  vm.runInNewContext(script, fresh.win);
  assert.equal(typeof fresh.win.__aqRenderUiPrefs, 'function');

  fresh.win.__aqRenderUiPrefs({ convWidthMode: 'unset', convMaxWidth: 0 });
  assert.equal(fresh.styleProps.get('--aq-conv-max-width'), `${DEFAULT_CONV_WIDTH}px`);
  assert.equal(fresh.storage.has('aq_conv_max_width_v1'), false);
  assert.deepEqual(sentActions, []);

  fresh.win.__aqRenderUiPrefs({ convWidthMode: 'custom', convMaxWidth: 985 });
  assert.equal(fresh.styleProps.get('--aq-conv-max-width'), '985px');
  assert.equal(fresh.storage.get('aq_conv_max_width_v1'), '985');

  fresh.win.__aqRenderUiPrefs({ convWidthMode: 'full', convMaxWidth: 0 });
  assert.equal(fresh.styleProps.get('--aq-conv-max-width'), '100%');
  assert.equal(fresh.storage.get('aq_conv_max_width_v1'), 'full');

  // Legacy localStorage value is migrated once when daemon store is still unset
  const legacy = createFakeClientDom({ aq_conv_max_width_v1: '960' });
  const migratedActions = [];
  legacy.win.__aqUiPrefsAction = (raw) => migratedActions.push(JSON.parse(raw));
  vm.runInNewContext(script, legacy.win);
  legacy.win.__aqRenderUiPrefs({ convWidthMode: 'unset', convMaxWidth: 0 });
  assert.equal(legacy.styleProps.get('--aq-conv-max-width'), '960px');
  assert.deepEqual(migratedActions, [{ type: 'set-conv-width', mode: 'custom', width: 960 }]);

  // Values below MIN_CONV_WIDTH in corrupt localStorage stay unset (768px)
  const invalid = createFakeClientDom({ aq_conv_max_width_v1: String(MIN_CONV_WIDTH - 10) });
  invalid.win.__aqUiPrefsAction = () => {};
  vm.runInNewContext(script, invalid.win);
  invalid.win.__aqRenderUiPrefs({ convWidthMode: 'unset', convMaxWidth: 0 });
  assert.equal(invalid.styleProps.get('--aq-conv-max-width'), `${DEFAULT_CONV_WIDTH}px`);

  // Legacy global rAF wrapper is restored on reload and tail delta turns merge cleanly
  const legacyRaf = createFakeClientDom({});
  const origRafFn = () => 1;
  legacyRaf.win.requestAnimationFrame = () => 99;
  legacyRaf.win.__aqOrigRaf = origRafFn;
  legacyRaf.win.__aqRafGuarded = true;
  vm.runInNewContext(script, legacyRaf.win);
  assert.equal(legacyRaf.win.requestAnimationFrame, origRafFn);
  assert.equal('__aqOrigRaf' in legacyRaf.win, false);
  assert.equal('__aqRafGuarded' in legacyRaf.win, false);

  legacyRaf.win.__aqRenderTurns({
    cascadeId: '33333333-3333-3333-3333-333333333333',
    hasData: true,
    turns: [
      { turnIndex: 0, totalTokens: 100, calls: 1, completed: true },
      { turnIndex: 1, totalTokens: 50, calls: 1, completed: false },
    ],
  });
  legacyRaf.win.__aqRenderTurns({
    mode: 'tail',
    cascadeId: '33333333-3333-3333-3333-333333333333',
    hasData: true,
    tailStartIndex: 1,
    turns: [
      { turnIndex: 1, totalTokens: 200, calls: 2, completed: true },
      { turnIndex: 2, totalTokens: 80, calls: 1, completed: false },
    ],
  });
  legacyRaf.win.__aqCleanup?.();
});
