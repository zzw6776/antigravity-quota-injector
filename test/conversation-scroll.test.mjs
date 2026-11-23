import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { buildClientScript } from '../src/daemon.mjs';

const CID_A = '11111111-2222-4333-8444-555555555555';
const CID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function matchSingleCompound(el, compound) {
  let rest = compound.trim();
  if (!rest) return false;
  let neg = '';
  const notMatch = rest.match(/:not\(([^)]+)\)$/);
  if (notMatch) {
    neg = notMatch[1];
    rest = rest.slice(0, notMatch.index);
  }
  if (neg && matchSingleCompound(el, neg)) return false;

  const tagMatch = rest.match(/^[a-z0-9]+/i);
  if (tagMatch) {
    if (el.tagName !== tagMatch[0].toUpperCase()) return false;
    rest = rest.slice(tagMatch[0].length);
  }
  while (rest.length > 0) {
    if (rest.startsWith('#')) {
      const m = rest.match(/^#([a-z0-9_.-]+)/i);
      if (!m || el.id !== m[1]) return false;
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith('.')) {
      const m = rest.match(/^\.([a-z0-9_-]+)/i);
      if (!m || !el.classList.contains(m[1])) return false;
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith('[')) {
      const mVal = rest.match(/^\[([a-z0-9_-]+)="([^"]*)"\]/i);
      if (mVal) {
        if (el.getAttribute(mVal[1]) !== mVal[2]) return false;
        rest = rest.slice(mVal[0].length);
      } else {
        const mHas = rest.match(/^\[([a-z0-9_-]+)\]/i);
        if (!mHas || !el.hasAttribute(mHas[1])) return false;
        rest = rest.slice(mHas[0].length);
      }
    } else {
      return false;
    }
  }
  return true;
}

function matchesSelectorFromScope(el, rawSel, scopeEl = null) {
  return rawSel
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((branch) => {
      let s = branch;
      let anchoredToScope = false;
      if (s.startsWith(':scope')) {
        anchoredToScope = true;
        s = s.slice(6).trim();
      }
      const tokens = [];
      let buf = '';
      let bracketDepth = 0;
      let parenDepth = 0;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '[') bracketDepth++;
        else if (ch === ']') bracketDepth--;
        else if (ch === '(') parenDepth++;
        else if (ch === ')') parenDepth--;
        if (bracketDepth === 0 && parenDepth === 0 && (ch === '>' || /\s/.test(ch))) {
          if (buf) {
            tokens.push(buf);
            buf = '';
          }
          if (ch === '>') {
            if (tokens[tokens.length - 1] === ' ') tokens[tokens.length - 1] = '>';
            else tokens.push('>');
          } else if (
            tokens.length > 0 &&
            tokens[tokens.length - 1] !== '>' &&
            tokens[tokens.length - 1] !== ' '
          ) {
            tokens.push(' ');
          }
        } else {
          buf += ch;
        }
      }
      if (buf) tokens.push(buf);
      while (tokens[tokens.length - 1] === ' ') tokens.pop();

      if (anchoredToScope && tokens[0] === '>') {
        tokens.shift();
        const matchChainFrom = (idx, curEl) => {
          if (!matchSingleCompound(curEl, tokens[idx])) return false;
          if (idx === 0) return curEl.parentElement === scopeEl;
          const comb = tokens[idx - 1];
          if (comb === '>') {
            return curEl.parentElement ? matchChainFrom(idx - 2, curEl.parentElement) : false;
          }
          let anc = curEl.parentElement;
          while (anc && anc !== scopeEl) {
            if (matchChainFrom(idx - 2, anc)) return true;
            anc = anc.parentElement;
          }
          return false;
        };
        return tokens.length > 0 ? matchChainFrom(tokens.length - 1, el) : false;
      }

      const matchChain = (idx, curEl) => {
        if (!matchSingleCompound(curEl, tokens[idx])) return false;
        if (idx === 0) return true;
        const comb = tokens[idx - 1];
        if (comb === '>') {
          return curEl.parentElement ? matchChain(idx - 2, curEl.parentElement) : false;
        }
        let anc = curEl.parentElement;
        while (anc) {
          if (matchChain(idx - 2, anc)) return true;
          anc = anc.parentElement;
        }
        return false;
      };
      return tokens.length > 0 ? matchChain(tokens.length - 1, el) : false;
    });
}

function makeEl(tagName = 'div') {
  const attrs = new Map();
  const classes = new Set();
  const el = {
    nodeType: 1,
    tagName: String(tagName || 'div').toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    innerHTML: '',
    style: {
      overflowAnchor: '',
      setProperty() {},
      removeProperty() {},
      getPropertyValue() {
        return '';
      },
    },
    dataset: {},
    children: [],
    parentElement: null,
    scrollHeight: 800,
    clientHeight: 800,
    scrollTop: 0,
    get isConnected() {
      let cur = el;
      while (cur) {
        if (cur.tagName === 'HTML') return true;
        cur = cur.parentElement;
      }
      return false;
    },
    get firstElementChild() {
      return el.children[0] || null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 800, bottom: 800, width: 800, height: 800 };
    },
    classList: {
      add: (...names) => names.forEach((n) => n && classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      toggle: (n, force) => {
        const on = force === undefined ? !classes.has(n) : Boolean(force);
        if (on) classes.add(n);
        else classes.delete(n);
        return on;
      },
      contains: (n) => classes.has(n),
    },
    setAttribute(k, v) {
      const s = String(v);
      attrs.set(k, s);
      if (k === 'id') el.id = s;
      if (k === 'class') {
        classes.clear();
        s.split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
      }
    },
    getAttribute(k) {
      return attrs.has(k) ? attrs.get(k) : null;
    },
    hasAttribute(k) {
      return attrs.has(k);
    },
    removeAttribute(k) {
      attrs.delete(k);
    },
    appendChild(child) {
      if (child.parentElement) child.remove();
      child.parentElement = el;
      el.children.push(child);
      return child;
    },
    remove() {
      if (!el.parentElement) return;
      const idx = el.parentElement.children.indexOf(el);
      if (idx !== -1) el.parentElement.children.splice(idx, 1);
      el.parentElement = null;
    },
    addEventListener() {},
    removeEventListener() {},
    matches(sel) {
      return matchesSelectorFromScope(el, sel, null);
    },
    closest(sel) {
      let cur = el;
      while (cur) {
        if (matchesSelectorFromScope(cur, sel, null)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        for (const ch of node.children) {
          if (matchesSelectorFromScope(ch, sel, el)) out.push(ch);
          walk(ch);
        }
      };
      walk(el);
      return out;
    },
    querySelector(sel) {
      return el.querySelectorAll(sel)[0] || null;
    },
  };
  return el;
}

test('conversation switch preserves scroll position unless a new reply arrived', () => {
  const { script } = buildClientScript({ codexTheme: false, zhUi: false });

  const head = makeEl('head');
  const body = makeEl('body');
  const docEl = makeEl('html');
  docEl.appendChild(head);
  docEl.appendChild(body);

  // Sidebar with two conversation rows
  const sidebar = makeEl('div');
  sidebar.setAttribute('class', 'bg-sidebar');
  body.appendChild(sidebar);

  const rowA = makeEl('div');
  rowA.setAttribute('data-testid', 'conversation-row-sidebar');
  rowA.setAttribute('data-cascade-id', CID_A);
  rowA.setAttribute('data-selected', 'true');
  sidebar.appendChild(rowA);

  const rowB = makeEl('div');
  rowB.setAttribute('data-testid', 'conversation-row-sidebar');
  rowB.setAttribute('data-cascade-id', CID_B);
  rowB.setAttribute('data-selected', 'false');
  sidebar.appendChild(rowB);

  const convHost = makeEl('div');
  body.appendChild(convHost);

  const attachAutoScrollHandle = (vp) => {
    const calls = { stop: 0, forceBottom: 0 };
    const handle = {
      viewportRef: { current: vp },
      stopAutoScroll() {
        calls.stop += 1;
      },
      forceScrollToBottom() {
        calls.forceBottom += 1;
        vp.scrollTop = Math.max(0, vp.scrollHeight - vp.clientHeight);
      },
    };
    vp.__reactFiber$test = {
      ref: null,
      return: {
        ref: { current: handle },
        return: null,
      },
    };
    return calls;
  };

  const mountConversationView = (cid, { scrollHeight = 4000, clientHeight = 800, initialScrollTop = null } = {}) => {
    while (convHost.children.length > 0) {
      convHost.children[0].remove();
    }
    rowA.setAttribute('data-selected', cid === CID_A ? 'true' : 'false');
    rowB.setAttribute('data-selected', cid === CID_B ? 'true' : 'false');

    const view = makeEl('div');
    view.setAttribute('data-testid', 'conversation-view');
    view.setAttribute('data-cascade-id', cid);

    const vp = makeEl('div');
    vp.setAttribute('data-testid', 'autoscroll-viewport');
    vp.scrollHeight = scrollHeight;
    vp.clientHeight = clientHeight;
    vp.scrollTop = initialScrollTop !== null ? initialScrollTop : Math.max(0, scrollHeight - clientHeight);
    const handleCalls = attachAutoScrollHandle(vp);

    const contentOuter = makeEl('div');
    const contentInner = makeEl('div');
    contentOuter.appendChild(contentInner);
    vp.appendChild(contentOuter);
    view.appendChild(vp);
    convHost.appendChild(view);

    return { view, vp, contentInner, handleCalls };
  };

  // Start on Conversation A at scrollTop = 1250
  let mounted = mountConversationView(CID_A, { scrollHeight: 4000, clientHeight: 800, initialScrollTop: 1250 });

  const docListeners = new Map();
  const sessionMap = new Map();
  const observerCallbacks = [];
  const resizeCallbacks = new Set();
  const rafQueue = new Map();
  let nextRafId = 1;

  const flushRaf = () => {
    const entries = [...rafQueue.entries()];
    rafQueue.clear();
    for (const [, cb] of entries) cb();
  };

  const notifyDomChildMutation = (target, addedNode) => {
    for (const cb of observerCallbacks) {
      cb([{ type: 'childList', target, addedNodes: addedNode ? [addedNode] : [], removedNodes: [] }]);
    }
  };

  const fireDocEvent = (type, target, extra = {}) => {
    const list = docListeners.get(type) || [];
    const ev = {
      type,
      target,
      button: 0,
      preventDefault: () => {},
      stopPropagation: () => {},
      ...extra,
    };
    for (const fn of list) fn(ev);
  };

  let domQueryCalls = 0;
  const documentObj = {
    head,
    body,
    documentElement: docEl,
    hidden: false,
    createElement: (tag) => makeEl(tag),
    createTreeWalker: () => ({ nextNode: () => null }),
    getElementById: (id) => {
      domQueryCalls++;
      return docEl.querySelector(`#${id}`);
    },
    querySelector: (sel) => {
      domQueryCalls++;
      return docEl.querySelector(sel);
    },
    querySelectorAll: (sel) => {
      domQueryCalls++;
      return docEl.querySelectorAll(sel);
    },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener() {},
  };

  const windowObj = {
    document: documentObj,
    innerWidth: 1280,
    innerHeight: 900,
    location: { href: `https://antigravity.local/c/${CID_A}`, pathname: `/c/${CID_A}`, search: '' },
    history: { pushState() {}, replaceState() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    sessionStorage: {
      getItem: (k) => (sessionMap.has(k) ? sessionMap.get(k) : null),
      setItem: (k, v) => sessionMap.set(k, String(v)),
      removeItem: (k) => sessionMap.delete(k),
    },
    MutationObserver: class {
      constructor(cb) {
        observerCallbacks.push(cb);
      }
      observe() {}
      disconnect() {}
    },
    NodeFilter: { SHOW_TEXT: 4 },
    ResizeObserver: class {
      constructor(cb) {
        this.cb = cb;
        resizeCallbacks.add(cb);
      }
      observe() {}
      disconnect() {
        resizeCallbacks.delete(this.cb);
      }
    },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    requestAnimationFrame: (cb) => {
      const id = nextRafId++;
      rafQueue.set(id, cb);
      return id;
    },
    cancelAnimationFrame: (id) => rafQueue.delete(id),
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    addEventListener() {},
    removeEventListener() {},
  };
  windowObj.window = windowObj;
  windowObj.top = windowObj;
  windowObj.globalThis = windowObj;
  windowObj.__APP_CONFIG__ = { productName: 'antigravity' };

  vm.runInNewContext(script, windowObj);
  flushRaf();

  // Seed turns for Conversation A (3 completed turns)
  windowObj.__aqRenderTurns({
    cascadeId: CID_A,
    mode: 'full',
    turns: [
      { startStepIdx: 0, calls: 1, outputTokens: 200, responseTokens: 200, totalTokens: 1000, completed: true },
      { startStepIdx: 4, calls: 2, outputTokens: 500, responseTokens: 400, totalTokens: 4000, completed: true },
      { startStepIdx: 9, calls: 1, outputTokens: 300, responseTokens: 300, totalTokens: 6000, completed: true },
    ],
  });
  flushRaf();

  // High-frequency scroll events perform zero document DOM queries
  const queriesBeforeScrollBurst = domQueryCalls;
  for (let s = 1200; s >= 980; s -= 20) {
    mounted.vp.scrollTop = s;
    fireDocEvent('scroll', mounted.vp);
  }
  assert.equal(domQueryCalls, queriesBeforeScrollBurst);
  fireDocEvent('pointerdown', rowB);

  // Switch to Conversation B (first visit -> stays at native bottom = 2200)
  mounted = mountConversationView(CID_B, { scrollHeight: 3000, clientHeight: 800 });
  notifyDomChildMutation(convHost, mounted.view);
  flushRaf();
  assert.equal(mounted.vp.scrollTop, 2200);
  assert.equal(mounted.handleCalls.stop, 0);

  // User scrolls Conversation B up to 640
  mounted.vp.scrollTop = 640;
  fireDocEvent('scroll', mounted.vp);

  // 1. Switch back to Conversation A with NO new reply -> restores exact scrollTop 980 & stops native auto-scroll
  fireDocEvent('pointerdown', rowA);
  mounted = mountConversationView(CID_A, { scrollHeight: 4000, clientHeight: 800 }); // native defaults to 3200
  notifyDomChildMutation(convHost, mounted.view);
  assert.equal(mounted.handleCalls.stop >= 1, true);
  assert.equal(mounted.vp.scrollTop, 980);
  flushRaf();
  assert.equal(mounted.vp.scrollTop, 980);

  // Async layout growth before user interaction re-stabilizes to 980
  mounted.vp.scrollTop = 3200;
  for (const cb of [...resizeCallbacks]) cb();
  assert.equal(mounted.vp.scrollTop, 980);

  // User wheel interaction cancels stabilization immediately so manual scrolling is never fought
  fireDocEvent('wheel', mounted.vp);
  mounted.vp.scrollTop = 520;
  fireDocEvent('scroll', mounted.vp);
  for (const cb of [...resizeCallbacks]) cb();
  assert.equal(mounted.vp.scrollTop, 520);

  // 2. Conversation B receives an unread indicator while user is on Conversation A -> switching to B stays at bottom
  const unreadDot = makeEl('span');
  unreadDot.setAttribute('data-testid', 'status-unread-dot');
  rowB.appendChild(unreadDot);
  fireDocEvent('pointerdown', rowB);
  mounted = mountConversationView(CID_B, { scrollHeight: 3400, clientHeight: 800 }); // bottom = 2600
  notifyDomChildMutation(convHost, mounted.view);
  flushRaf();
  assert.equal(mounted.handleCalls.stop, 0);
  assert.equal(mounted.vp.scrollTop, 2600);
  unreadDot.remove();

  // 3a. Delayed 2s .pb poll catching up on the SAME already-finished 3rd turn does NOT false-jump to bottom
  fireDocEvent('pointerdown', rowA);
  mounted = mountConversationView(CID_A, { scrollHeight: 4600, clientHeight: 800 }); // bottom = 3800
  notifyDomChildMutation(convHost, mounted.view);
  assert.equal(mounted.vp.scrollTop, 520);
  windowObj.__aqRenderTurns({
    cascadeId: CID_A,
    mode: 'full',
    turns: [
      { startStepIdx: 0, calls: 1, outputTokens: 200, responseTokens: 200, totalTokens: 1000, completed: true },
      { startStepIdx: 4, calls: 2, outputTokens: 500, responseTokens: 400, totalTokens: 4000, completed: true },
      { startStepIdx: 9, calls: 2, outputTokens: 480, responseTokens: 460, totalTokens: 6900, completed: true },
    ],
  });
  assert.equal(mounted.handleCalls.forceBottom, 0);
  assert.equal(mounted.vp.scrollTop, 520);

  // 3b. Genuine NEW 4th turn arriving on disk DOES jump to bottom
  windowObj.__aqRenderTurns({
    cascadeId: CID_A,
    mode: 'full',
    turns: [
      { startStepIdx: 0, calls: 1, outputTokens: 200, responseTokens: 200, totalTokens: 1000, completed: true },
      { startStepIdx: 4, calls: 2, outputTokens: 500, responseTokens: 400, totalTokens: 4000, completed: true },
      { startStepIdx: 9, calls: 2, outputTokens: 480, responseTokens: 460, totalTokens: 6900, completed: true },
      { startStepIdx: 12, calls: 2, outputTokens: 450, responseTokens: 420, totalTokens: 9200, completed: true },
    ],
  });
  assert.equal(mounted.handleCalls.forceBottom, 1);
  assert.equal(mounted.vp.scrollTop, 3800);

  // 4. Leaving Conversation A while already at bottom (3800) keeps native bottom-follow on return
  fireDocEvent('pointerdown', rowB);
  mounted = mountConversationView(CID_B, { scrollHeight: 3400, clientHeight: 800 });
  notifyDomChildMutation(convHost, mounted.view);
  flushRaf();

  fireDocEvent('pointerdown', rowA);
  mounted = mountConversationView(CID_A, { scrollHeight: 4600, clientHeight: 800 });
  notifyDomChildMutation(convHost, mounted.view);
  flushRaf();
  assert.equal(mounted.handleCalls.stop, 0);
  assert.equal(mounted.vp.scrollTop, 3800);

  windowObj.__aqCleanup();
});
