import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { buildClientScript, maskSecretKey, readUserConfig, writeUserConfig } from '../src/daemon.mjs';
import {
  DEFAULT_AI_BRIEF_SYSTEM_PROMPT,
  DEFAULT_AI_ENDPOINT,
  DEFAULT_AI_MODEL,
  buildAiExtraRequestFields,
  compactThinkingText,
  createThinkingTranslator,
  decryptYoudaoPayload,
  encryptYoudaoPayload,
  normalizeAiEndpoint,
  normalizeThinkingTranslateSource,
  parseSseContentPayload,
  sliceThinkingForBrief,
  splitTextIntoChunks,
} from '../src/thinking-translator.mjs';

test('compactThinkingText, SSE parser, legacy source aliases, and endpoint normalizer work cleanly', () => {
  const raw = 'First thought line.\n\n\n   \nSecond thought line.\r\n\r\nThird line.  ';
  assert.equal(
    compactThinkingText(raw),
    'First thought line.\nSecond thought line.\nThird line.'
  );

  const sse = [
    'data: {"choices":[{"index":0,"delta":{"content":"<think>internal</think>正在检查 "}}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{"content":"daemon.mjs"}}]}',
    'data: [DONE]',
  ].join('\n');
  assert.equal(parseSseContentPayload(sse), '正在检查 daemon.mjs');

  const errSse = [
    'data: {"choices":[{"index":0,"delta":{"content":"API error"}}],"error":"Rate limit exceeded"}',
  ].join('\n');
  assert.throws(() => parseSseContentPayload(errSse), /Rate limit exceeded/);

  assert.equal(normalizeThinkingTranslateSource('easydict-ai-brief'), 'ai-brief');
  assert.equal(normalizeThinkingTranslateSource('easydict-builtin-ai'), 'ai-translate');
  assert.equal(normalizeThinkingTranslateSource('easydict-google'), 'google');
  assert.equal(normalizeThinkingTranslateSource('web-google'), 'google');
  assert.equal(normalizeThinkingTranslateSource('easydict-deepl'), 'deepl');
  assert.equal(normalizeThinkingTranslateSource('easydict-bing'), 'bing');
  assert.equal(normalizeThinkingTranslateSource('easydict-youdao'), 'youdao');
  assert.equal(normalizeThinkingTranslateSource('unknown-src'), 'auto');

  assert.equal(normalizeAiEndpoint(''), DEFAULT_AI_ENDPOINT);
  assert.equal(
    normalizeAiEndpoint('https://api.openai.com/v1/'),
    'https://api.openai.com/v1/chat/completions'
  );
  assert.equal(
    normalizeAiEndpoint('https://open.bigmodel.cn/api/paas/v4/chat/completions'),
    'https://open.bigmodel.cn/api/paas/v4/chat/completions'
  );

  assert.deepEqual(
    buildAiExtraRequestFields(DEFAULT_AI_ENDPOINT, 'glm-4-flash-250414'),
    {}
  );
  assert.deepEqual(
    buildAiExtraRequestFields(DEFAULT_AI_ENDPOINT, 'glm-4.5-flash'),
    { thinking: { type: 'disabled' } }
  );
  assert.deepEqual(
    buildAiExtraRequestFields('https://api.siliconflow.cn/v1/chat/completions', 'Qwen/Qwen3-8B'),
    { enable_thinking: false }
  );
  assert.deepEqual(
    buildAiExtraRequestFields('https://api.openai.com/v1/chat/completions', 'gpt-4o-mini'),
    {}
  );

  const chunks = splitTextIntoChunks(`${'A'.repeat(600)}\n${'B'.repeat(600)}`, 950);
  assert.equal(chunks.length, 2);
});

test('writeUserConfig persists aiApiKey with 0600 permissions, preserves sibling fields, and masks secrets', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-user-cfg-test-'));
  try {
    fs.writeFileSync(
      path.join(tmpDir, 'config.json'),
      JSON.stringify({ codexTheme: false, customNote: 'keep-me' }, null, 2),
      'utf8'
    );
    const saved = writeUserConfig(tmpDir, {
      aiApiKey: 'abcd1234efgh5678ijkl9012.secretXYZ9',
      aiModel: 'glm-4-flash-250414',
    });
    assert.equal(saved.codexTheme, false);
    assert.equal(saved.aiApiKey, 'abcd1234efgh5678ijkl9012.secretXYZ9');
    assert.equal(saved.aiModel, 'glm-4-flash-250414');
    assert.equal(maskSecretKey(saved.aiApiKey), 'abcd****XYZ9');

    if (process.platform !== 'win32') {
      const mode = fs.statSync(path.join(tmpDir, 'config.json')).mode & 0o777;
      assert.equal(mode, 0o600);
    }
    const rawJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
    assert.equal(rawJson.customNote, 'keep-me');

    const cleared = writeUserConfig(tmpDir, { aiApiKey: '' });
    assert.equal(cleared.aiApiKey, '');
    assert.equal(readUserConfig(tmpDir).aiApiKey, '');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('native Google, DeepL (with App Store version refresh), Bing (token + chunk + 205 retry), and Youdao (AES-128-CBC) translate directly', async () => {
  const calls = [];
  let bingAttempt = 0;
  let deepLAttempt = 0;
  const aesKey = 'ydsecretkey12345';
  const aesIv = 'ydsecretiv123456';

  const translator = createThinkingTranslator({
    env: {},
    fetchFn: async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET', body: init.body || '' });

      // Google
      if (url.startsWith('https://translate.googleapis.com/')) {
        return new Response(JSON.stringify([[['Google 第一行。\n\n第二行。', 'Line 1']]]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // DeepL + iTunes lookup
      if (url.startsWith('https://itunes.apple.com/lookup')) {
        return new Response(
          JSON.stringify({
            resultCount: 1,
            results: [
              {
                trackId: 1552407475,
                bundleId: 'com.linguee.DeepLMobileTranslator',
                artistName: 'DeepL SE',
                version: '27.1.0',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url === 'https://oneshot-free.www.deepl.com/v1/translate') {
        deepLAttempt += 1;
        const payload = JSON.parse(init.body);
        assert.equal('source_lang' in payload, false);
        if (deepLAttempt === 1) {
          assert.equal(payload.app_information.app_version, '26.52');
          return new Response('Client outdated', { status: 426 });
        }
        assert.equal(payload.app_information.app_version, '27.1.0');
        return new Response(
          JSON.stringify({
            translations: [{ detected_source_language: 'EN', text: 'DeepL 直连译文。' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Bing
      if (url === 'https://cn.bing.com/translator') {
        const html = `
          <script>
            var _G = { IG: "IG_TOKEN_${bingAttempt + 1}" };
            var params_AbusePreventionHelper = [${Date.now()},"BING_SEC_${bingAttempt + 1}",3600000];
          </script>
          <div data-iid="translator.5029"></div>
        `;
        return new Response(html, { status: 200, headers: { 'set-cookie': 'MUID=test123; Path=/' } });
      }
      if (url.includes('/ttranslatev3')) {
        bingAttempt += 1;
        if (bingAttempt === 1) {
          return new Response(JSON.stringify({ statusCode: 205 }), { status: 200 });
        }
        const params = new URLSearchParams(init.body);
        return new Response(
          JSON.stringify([{ translations: [{ text: `Bing段(${params.get('text').length})` }] }]),
          { status: 200 }
        );
      }

      // Youdao
      if (url.startsWith('https://dict.youdao.com/webtranslate/key')) {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: 'OK',
            data: { secretKey: 'sec123', aesKey, aesIv },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url === 'https://dict.youdao.com/webtranslate') {
        const plain = JSON.stringify({
          code: 0,
          type: 'en2zh-CHS',
          translateResult: [[{ src: 'Hello', tgt: '有道直连译文。' }]],
        });
        return new Response(encryptYoudaoPayload(plain, aesKey, aesIv), { status: 200 });
      }

      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  // 1. Auto uses Google first and caches
  const gRes = await translator.translate('Line one.\n\n\nLine two.');
  assert.equal(gRes.provider, 'google');
  assert.equal(gRes.providerLabel, 'Google 翻译');
  assert.equal(gRes.translatedText, 'Google 第一行。\n第二行。');
  const prevLen = calls.length;
  await translator.translate('Line one.\n\n\nLine two.', { source: 'auto' });
  assert.equal(calls.length, prevLen);

  // 2. DeepL refreshes App Store version on 426 and succeeds
  const dRes = await translator.translate('Check DeepL oneshot.', { source: 'easydict-deepl' });
  assert.equal(dRes.provider, 'deepl');
  assert.equal(dRes.providerLabel, 'DeepL 翻译');
  assert.equal(dRes.translatedText, 'DeepL 直连译文。');

  // 3. Bing handles >950-char chunking AND auto-refreshes token on statusCode 205
  const longBingInput = `${'Check Bing chunk one. '.repeat(35)}\n${'Check Bing chunk two. '.repeat(35)}`;
  assert.ok(longBingInput.length > 1000);
  const bRes = await translator.translate(longBingInput, { source: 'bing' });
  assert.equal(bRes.provider, 'bing');
  assert.equal(bRes.providerLabel, 'Bing 翻译');
  assert.match(bRes.translatedText, /^Bing段\(\d+\)\nBing段\(\d+\)$/);

  // 4. Youdao AES-128-CBC roundtrip and direct translation
  const samplePlain = '{"code":0}';
  assert.equal(
    decryptYoudaoPayload(encryptYoudaoPayload(samplePlain, aesKey, aesIv), aesKey, aesIv),
    samplePlain
  );
  const yRes = await translator.translate('Check Youdao AES.', { source: 'youdao' });
  assert.equal(yRes.provider, 'youdao');
  assert.equal(yRes.providerLabel, '有道翻译');
  assert.equal(yRes.translatedText, '有道直连译文。');
});

test('direct AI brief and AI translate support Zhipu JSON/SSE, slice long input, hot-update prompt/key, and avoid caching unconfigured fallback', async () => {
  let apiKey = '';
  let customPrompt = '';
  let callSeq = 0;
  const aiBodies = [];

  const longInput = [
    'Initial investigation of src/launcher.mjs runtime identity calculation.',
    ...Array.from({ length: 40 }, (_, idx) => `Intermediate reasoning step ${idx + 1} checking virtual DOM edge cases.`),
    'Final conclusion: renderRunningThinkingHelper() needs insertBefore check when collapsible trigger unmounts.',
  ].join('\n\n');

  const sliced = sliceThinkingForBrief(longInput);
  assert.ok(sliced.length <= 1450);
  assert.match(sliced, /^\[早期背景\] Initial investigation/);
  assert.match(sliced, /\[当前最新想法\]/);

  const translator = createThinkingTranslator({
    env: {},
    getAiConfig: () => ({
      apiKey,
      briefPrompt: customPrompt,
    }),
    fetchFn: async (url, init = {}) => {
      if (url === DEFAULT_AI_ENDPOINT) {
        callSeq += 1;
        const body = JSON.parse(init.body);
        aiBodies.push({ auth: init.headers.Authorization, body });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: `<think>hidden</think>简述结果 #${callSeq}：正在检查 renderRunningThinkingHelper()。`,
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.startsWith('https://translate.googleapis.com/')) {
        return new Response(JSON.stringify([[['未配 Key 时的 Google 回退译文。', 'x']]]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  // 1. Without API key, ai-brief falls back to Google and does NOT lock cache; adding key changes effectiveKey immediately
  const keyBefore = translator.getEffectiveKey(longInput, { source: 'ai-brief' }).effectiveKey;
  const noKeyRes = await translator.translate(longInput, { source: 'easydict-ai-brief' });
  assert.equal(noKeyRes.provider, 'google');
  assert.equal(noKeyRes.providerLabel, 'Google 翻译（未配 AI Key 回退）');
  assert.equal(aiBodies.length, 0);

  // 2. Once user configures API key, effectiveKey updates and retrying hits Zhipu glm-4-flash-250414 directly
  apiKey = 'test_key_123.secret';
  const keyAfter = translator.getEffectiveKey(longInput, { source: 'ai-brief' }).effectiveKey;
  assert.notEqual(keyBefore, keyAfter);
  const briefRes = await translator.translate(longInput, { source: 'ai-brief' });
  assert.equal(briefRes.provider, 'ai-brief');
  assert.equal(briefRes.providerLabel, 'AI 简述');
  assert.equal(briefRes.translatedText, '简述结果 #1：正在检查 renderRunningThinkingHelper()。');
  assert.equal(briefRes.sourceText, compactThinkingText(longInput));
  assert.equal(aiBodies.length, 1);
  assert.equal(aiBodies[0].auth, 'Bearer test_key_123.secret');
  assert.equal(aiBodies[0].body.model, DEFAULT_AI_MODEL);
  assert.equal(aiBodies[0].body.messages[0].content, DEFAULT_AI_BRIEF_SYSTEM_PROMPT);
  assert.match(aiBodies[0].body.messages[1].content, /\[当前最新想法\]/);

  // 3. Updating custom prompt bypasses old cache
  customPrompt = '自定义简述要求：只输出二十字以内结论。';
  const briefCustom = await translator.translate(longInput, { source: 'ai-brief' });
  assert.equal(briefCustom.translatedText, '简述结果 #2：正在检查 renderRunningThinkingHelper()。');
  assert.equal(aiBodies[1].body.messages[0].content, customPrompt);

  // 4. Growing >12,000 chars at tail updates effectiveKey and re-summarizes
  const prefix13k = `${'Early reasoning paragraph about architecture.\n\n'.repeat(290)}`;
  const stepA = `${prefix13k}\n\nTail thought A: checking DOM anchor.`;
  const stepB = `${prefix13k}\n\nTail thought B: fixed virtual scroll detach.`;
  const resA = await translator.translate(stepA, { source: 'ai-brief' });
  const resB = await translator.translate(stepB, { source: 'ai-brief' });
  assert.notEqual(resA.effectiveKey, resB.effectiveKey);

  // 5. Full-body hang aborts cleanly and falls back to Google
  let sawAbort = false;
  const hangingTranslator = createThinkingTranslator({
    env: {},
    getAiConfig: () => ({ apiKey: 'k' }),
    fetchFn: async (url, init = {}) => {
      if (url.startsWith('https://translate.googleapis.com/')) {
        return new Response(JSON.stringify([[['超时后回退 Google 译文', 'Test']]]), { status: 200 });
      }
      init.signal.addEventListener('abort', () => {
        sawAbort = true;
      });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        text: () =>
          new Promise((_, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            );
            setTimeout(() => init.signal.dispatchEvent(new Event('abort')), 25);
          }),
      };
    },
  });
  const abortFallback = await hangingTranslator.translate('Stream body hang test.', {
    source: 'ai-translate',
  });
  assert.equal(sawAbort, true);
  assert.equal(abortFallback.translatedText, '超时后回退 Google 译文');
});

test('client thinking helper and version-row Key Settings modal work end-to-end', async () => {
  const cid = '55555555-5555-5555-5555-555555555555';
  const { script } = buildClientScript({ codexTheme: true, zhUi: true });

  function makeEl(tag = 'DIV', attrs = {}) {
    const attrMap = new Map(Object.entries(attrs));
    const listeners = new Map();
    let htmlStr = '';
    const el = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id: attrs.id || '',
      type: attrs.type || '',
      className: attrs.className || '',
      textContent: '',
      hidden: false,
      disabled: false,
      value: attrs.value || '',
      title: '',
      parentElement: null,
      children: [],
      style: { display: '', setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => '' },
      get isConnected() {
        return Boolean(el.parentElement || el.tagName === 'BODY');
      },
      get innerHTML() {
        return htmlStr;
      },
      set innerHTML(v) {
        htmlStr = String(v || '');
        el.children = [];
        // Lightweight synthetic child mounting for key interactive controls in innerHTML templates
        if (htmlStr.includes('data-aq-key-settings-open')) {
          const settingsBtn = makeEl('BUTTON', {
            className: 'aq-key-settings-btn',
            'data-aq-key-settings-open': '1',
          });
          el.appendChild(settingsBtn);
        }
        if (htmlStr.includes('data-aq-update-open')) {
          const updBtn = makeEl('BUTTON', {
            className: 'aq-update-open',
            'data-aq-update-open': '1',
          });
          el.appendChild(updBtn);
        }
        if (htmlStr.includes('data-aq-ks-key')) {
          const valMatch = htmlStr.match(/data-aq-ks-key="1"[^>]*value="([^"]*)"/);
          const phMatch = htmlStr.match(/data-aq-ks-key="1"[^>]*placeholder="([^"]*)"/);
          const keyIn = makeEl('INPUT', {
            type: 'text',
            'data-aq-ks-key': '1',
            value: valMatch ? valMatch[1] : '',
            placeholder: phMatch ? phMatch[1] : '',
          });
          const modelIn = makeEl('INPUT', { type: 'text', 'data-aq-ks-model': '1' });
          const epIn = makeEl('INPUT', { type: 'text', 'data-aq-ks-endpoint': '1' });
          const errDiv = makeEl('DIV', { 'data-aq-ks-err': '1' });
          errDiv.hidden = true;
          const saveBtn = makeEl('BUTTON', { 'data-aq-ks-save': '1' });
          el.append(keyIn, modelIn, epIn, errDiv, saveBtn);
        }
      },
      classList: {
        contains: (c) => String(el.className || '').split(/\s+/).includes(c),
        add: (c) => {
          if (!el.classList.contains(c)) el.className = `${el.className} ${c}`.trim();
        },
        remove: (c) => {
          el.className = String(el.className || '')
            .split(/\s+/)
            .filter((x) => x && x !== c)
            .join(' ');
        },
        toggle: (c, force) => {
          const shouldAdd = force === undefined ? !el.classList.contains(c) : Boolean(force);
          if (shouldAdd) el.classList.add(c);
          else el.classList.remove(c);
        },
      },
      get lastElementChild() {
        return el.children.length > 0 ? el.children[el.children.length - 1] : null;
      },
      get firstElementChild() {
        return el.children.length > 0 ? el.children[0] : null;
      },
      get nextSibling() {
        if (!el.parentElement) return null;
        const idx = el.parentElement.children.indexOf(el);
        return idx >= 0 && idx + 1 < el.parentElement.children.length ? el.parentElement.children[idx + 1] : null;
      },
      get nextElementSibling() {
        return el.nextSibling;
      },
      setAttribute(k, v) {
        if (k === 'id') el.id = String(v);
        attrMap.set(k, String(v));
      },
      getAttribute(k) {
        if (k === 'id' && el.id) return el.id;
        return attrMap.has(k) ? attrMap.get(k) : null;
      },
      hasAttribute(k) {
        return attrMap.has(k) || (k === 'id' && Boolean(el.id));
      },
      removeAttribute(k) {
        attrMap.delete(k);
      },
      appendChild(child) {
        if (!child) return child;
        if (child.parentElement) child.remove();
        child.parentElement = el;
        el.children.push(child);
        return child;
      },
      append(...nodes) {
        for (const n of nodes) el.appendChild(n);
      },
      prepend(...nodes) {
        const ref = el.firstElementChild;
        for (const n of nodes) el.insertBefore(n, ref);
      },
      insertBefore(node, refNode) {
        if (!refNode) return el.appendChild(node);
        if (node.parentElement) node.remove();
        const idx = el.parentElement.children.indexOf(refNode);
        node.parentElement = el;
        if (idx === -1) el.children.push(node);
        else el.children.splice(idx, 0, node);
        return node;
      },
      remove() {
        if (!el.parentElement) return;
        const idx = el.parentElement.children.indexOf(el);
        if (idx !== -1) el.parentElement.children.splice(idx, 1);
        el.parentElement = null;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatch(type, extra = {}) {
        const list = listeners.get(type) || [];
        const ev = {
          type,
          target: extra.target || el,
          button: 0,
          preventDefault: () => {},
          stopPropagation: () => {},
          ...extra,
        };
        for (const fn of list) fn(ev);
      },
      focus() {},
      matches(sel) {
        return sel
          .split(',')
          .map((s) => s.trim())
          .some((part) => {
            if (!part) return false;
            if (part.startsWith('#')) return el.id === part.slice(1);
            if (part.startsWith('.')) return el.classList.contains(part.slice(1));
            const mVal = part.match(/^\[([a-z0-9-]+)="([^"]+)"\]$/i);
            if (mVal) return el.getAttribute(mVal[1]) === mVal[2];
            const mTagVal = part.match(/^([a-z]+)\[([a-z0-9-]+)="([^"]+)"\]$/i);
            if (mTagVal) {
              return el.tagName === mTagVal[1].toUpperCase() && el.getAttribute(mTagVal[2]) === mTagVal[3];
            }
            const mHas = part.match(/^\[([a-z0-9-]+)\]$/i);
            if (mHas) return el.hasAttribute(mHas[1]);
            return false;
          });
      },
      closest(sel) {
        let cur = el;
        while (cur) {
          if (cur.matches?.(sel)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (node) => {
          for (const ch of node.children) {
            if (ch.matches?.(sel)) out.push(ch);
            walk(ch);
          }
        };
        walk(el);
        return out;
      },
      querySelector(sel) {
        return el.querySelectorAll(sel)[0] || null;
      },
      getBoundingClientRect: () => ({ left: 100, top: 600, width: 80, height: 24, right: 180, bottom: 624 }),
    };
    return el;
  }

  const body = makeEl('BODY');
  const quotableRoot = makeEl('DIV', { 'data-quotable-root': '1' });
  const listWrap = makeEl('DIV');
  quotableRoot.appendChild(listWrap);

  // Composer footer with model-selector-trigger so quota chip mounts
  const composerBox = makeEl('DIV', { id: 'antigravity.agentSidePanelInputBox' });
  const footerRow = makeEl('DIV', { className: 'agy-composer-footer' });
  const leftGroup = makeEl('DIV');
  const modelBtn = makeEl('BUTTON', { 'data-testid': 'model-selector-trigger' });
  leftGroup.appendChild(modelBtn);
  const rightGroup = makeEl('DIV');
  const sendBtn = makeEl('BUTTON', { 'data-testid': 'send-button' });
  rightGroup.appendChild(sendBtn);
  footerRow.append(leftGroup, rightGroup);
  composerBox.appendChild(footerRow);
  body.append(quotableRoot, composerBox);

  const turn0Row = makeEl('DIV');
  const turn0Content = makeEl('DIV', { 'data-turn-content': '1' });
  turn0Row.appendChild(turn0Content);

  const oldGroupWrap = makeEl('DIV');
  const oldTrigger = makeEl('BUTTON', { 'data-testid': 'thinking-collapsible-trigger' });
  oldGroupWrap.appendChild(oldTrigger);

  const newStreamWrap = makeEl('DIV');
  const newTrigger = makeEl('BUTTON', { 'data-testid': 'thinking-collapsible-trigger' });
  const loadingMarker = makeEl('DIV', { 'data-testid': 'agent-loading' });
  newStreamWrap.appendChild(newTrigger);

  turn0Content.append(oldGroupWrap, newStreamWrap, loadingMarker);
  listWrap.appendChild(turn0Row);

  const longOldThought = `Step 10 settled thought: ${'detailed architecture analysis '.repeat(18)}`.trim();
  const shortNewThought = 'Step 12 live stream now.';

  const turnFiber = { stateNode: turn0Row, memoizedProps: {}, return: null };
  const segmentParentFiber = {
    stateNode: null,
    memoizedProps: {
      segment: {
        steps: [
          {
            step: { case: 'plannerResponse', value: { thinking: longOldThought } },
            metadata: { sourceTrajectoryStepInfo: { stepIndex: 10 } },
          },
        ],
      },
    },
    return: turnFiber,
  };
  oldTrigger.__reactFiber$test = {
    stateNode: oldTrigger,
    memoizedProps: { thinking: longOldThought },
    return: segmentParentFiber,
  };
  newTrigger.__reactFiber$test = {
    stateNode: newTrigger,
    memoizedProps: { thinking: shortNewThought },
    return: turnFiber,
  };

  let rafCb = null;
  const intervalCbs = new Map();
  let nextTimerId = 1;
  const bgTasksPayload = [{ conversationId: cid, task: { isDaemon: false } }];
  const thinkingActions = [];
  const uiPrefsActions = [];
  const storageMap = new Map([['aq_thinking_source_v1', 'easydict-ai-brief']]);

  const win = {
    innerWidth: 1280,
    innerHeight: 800,
    location: { href: `https://127.0.0.1:63086/c/${cid}`, pathname: `/c/${cid}`, search: '' },
    history: { pushState: () => {}, replaceState: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({ backgroundColor: '#ffffff', display: 'flex', getPropertyValue: () => '' }),
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k),
    },
    fetch: async (url) => {
      if (String(url).includes('GetAllCascadeTrajectories')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            trajectorySummaries: {
              [cid]: {
                status: 'CASCADE_RUN_STATUS_IDLE',
                lastUserInputTime: '2026-11-23T00:00:00Z',
                lastModifiedTime: '2026-11-23T00:00:10Z',
              },
            },
          }),
        };
      }
      if (String(url).includes('ListBackgroundTasks')) {
        return { ok: true, status: 200, json: async () => ({ tasks: bgTasksPayload }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: (cb) => {
      rafCb = cb;
      return 1;
    },
    cancelAnimationFrame: () => {
      rafCb = null;
    },
    setInterval: (cb) => {
      const id = nextTimerId++;
      intervalCbs.set(id, cb);
      return id;
    },
    clearInterval: (id) => {
      intervalCbs.delete(id);
    },
    setTimeout: () => nextTimerId++,
    clearTimeout: () => {},
    NodeFilter: { SHOW_TEXT: 4 },
    matchMedia: () => ({ matches: false }),
    __APP_CONFIG__: { productName: 'antigravity', csrfToken: 't' },
    __aqThinkingAction: (raw) => thinkingActions.push(JSON.parse(raw)),
    __aqUiPrefsAction: (raw) => uiPrefsActions.push(JSON.parse(raw)),
    __aqAccountAction: () => {},
    __aqUpdateAction: () => {},
    __aqRequestTurns: () => {},
  };
  win.window = win;
  win.top = win;
  win.self = win;
  win.document = {
    hidden: false,
    activeElement: null,
    head: makeEl('HEAD'),
    body,
    documentElement: makeEl('HTML'),
    createElement: (tag) => makeEl(tag),
    createTreeWalker: () => ({ nextNode: () => null }),
    getElementById: (id) => body.querySelector(`#${id}`),
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const flushRaf = () => {
    if (rafCb) {
      const fn = rafCb;
      rafCb = null;
      fn();
    }
  };

  vm.runInNewContext(script, win);
  await new Promise((r) => setTimeout(r, 10));

  win.__aqRenderUpdate({
    currentVersion: '0.1.84',
    mode: 'dev',
    enabled: true,
    available: false,
    opening: false,
    status: 'idle',
  });
  win.__aqRenderUiPrefs({
    convWidthMode: 'unset',
    convMaxWidth: 0,
    thinkingTranslateSource: 'easydict-ai-brief',
    aiKeyConfigured: true,
    aiApiKey: 'existing_plain_key_123.secret',
    hasEnvAiKey: false,
    aiKeySource: 'config',
    aiEndpoint: '',
    aiModel: '',
  });
  win.__aqRenderTurns({
    cascadeId: cid,
    hasData: true,
    turns: [
      {
        turnIndex: 0,
        totalTokens: 1200,
        inputTokens: 1000,
        cachedInputTokens: 500,
        calls: 1,
        startTsMs: Date.now() - 45_000,
        wallDurationMs: 10_000,
        completed: true,
        cost: { available: true, totalCny: 0.05 },
      },
    ],
  });
  flushRaf();

  // 1. Legacy localStorage 'easydict-ai-brief' normalized to 'ai-brief' when clicking sparkle
  const sparkleBtn = body.querySelector('[data-aq-thinking-btn]');
  assert.ok(sparkleBtn);
  sparkleBtn.dispatch('click');
  assert.equal(thinkingActions.length, 1);
  assert.equal(thinkingActions[0].source, 'ai-brief');

  win.__aqResolveThinkingTranslate({
    requestId: thinkingActions[0].requestId,
    cascadeId: cid,
    ok: true,
    stepIdx: -1,
    thinkingCount: 2,
    sourcePref: 'ai-brief',
    sourceText: shortNewThought,
    translatedText: '正在输出第 12 步思考。',
    hasOriginal: true,
    provider: 'ai-brief',
    providerLabel: 'AI 简述',
  });

  const card = body.querySelector('[data-aq-thinking-card]');
  assert.ok(card);
  const origBtn = card.querySelector('[data-aq-think-act="toggle-orig"]');
  card.dispatch('click', { target: origBtn });
  assert.equal(origBtn.textContent, '看简述');

  // 2. Clicking quota chip renders version row with pure-icon button (no '设置' label or green dot) on the left of version number
  const quotaChip = body.querySelector('#aq-quota-chip');
  assert.ok(quotaChip, 'quota chip should mount');
  quotaChip.dispatch('click');

  const quotaTt = body.querySelector('#aq-quota-tooltip');
  assert.ok(quotaTt);
  assert.match(quotaTt.innerHTML, /data-aq-key-settings-open="1"/);
  assert.doesNotMatch(quotaTt.innerHTML, /aq-key-settings-dot/);
  assert.doesNotMatch(quotaTt.innerHTML, /<span>设置<\/span>/);
  assert.match(quotaTt.innerHTML, /v0\.1\.84\.dev/);
  assert.ok(
    quotaTt.innerHTML.indexOf('data-aq-key-settings-open="1"') <
      quotaTt.innerHTML.indexOf('v0.1.84.dev'),
    'Settings icon button must appear to the left of version number on the footer row'
  );

  // 3. Clicking icon button opens modal with plaintext API Key prefilled in input[type="text"], handles save error without closing, then closes on success ack
  const settingsBtn = quotaTt.querySelector('[data-aq-key-settings-open]');
  settingsBtn.dispatch('click');
  const modal = body.querySelector('#aq-key-settings-modal');
  assert.ok(modal, 'Key settings modal should open');
  assert.match(modal.innerHTML, /type="text"[^>]*data-aq-ks-key="1"/);

  const keyInput = modal.querySelector('[data-aq-ks-key]');
  assert.equal(keyInput.value, 'existing_plain_key_123.secret');
  const saveBtn = modal.querySelector('[data-aq-ks-save]');
  keyInput.value = 'new_zhipu_key_1234.secretABCD';
  modal.dispatch('click', { target: saveBtn });

  const saveAction = uiPrefsActions.find((a) => a.type === 'set-ai-config');
  assert.ok(saveAction, 'should emit set-ai-config action');
  assert.equal(saveAction.apiKey, 'new_zhipu_key_1234.secretABCD');

  // Simulate write error -> modal stays open, restores button, and displays error
  win.__aqRenderUiPrefs({
    convWidthMode: 'unset',
    convMaxWidth: 0,
    thinkingTranslateSource: 'ai-brief',
    aiKeyConfigured: true,
    aiApiKey: 'existing_plain_key_123.secret',
    hasEnvAiKey: false,
    aiKeySource: 'config',
    aiEndpoint: '',
    aiModel: '',
    aiSavedRequestId: saveAction.requestId,
    aiSaveError: '磁盘只读无法写入',
  });
  assert.ok(body.querySelector('#aq-key-settings-modal'), 'modal stays open on save error');
  assert.equal(saveBtn.disabled, false);
  assert.equal(modal.querySelector('[data-aq-ks-err]').textContent, '磁盘只读无法写入');

  // Retry save -> succeeds and closes modal
  modal.dispatch('click', { target: saveBtn });
  const retryAction = uiPrefsActions[uiPrefsActions.length - 1];
  win.__aqRenderUiPrefs({
    convWidthMode: 'unset',
    convMaxWidth: 0,
    thinkingTranslateSource: 'ai-brief',
    aiKeyConfigured: true,
    aiApiKey: 'new_zhipu_key_1234.secretABCD',
    hasEnvAiKey: false,
    aiKeySource: 'config',
    aiEndpoint: '',
    aiModel: '',
    aiSavedRequestId: retryAction.requestId,
  });
  assert.equal(body.querySelector('#aq-key-settings-modal'), null, 'modal closes after daemon ack');

  // 4. Env-only key is NOT prefilled into input value (only shown in placeholder) so editing model does not persist env key to disk
  win.__aqRenderUiPrefs({
    convWidthMode: 'unset',
    convMaxWidth: 0,
    thinkingTranslateSource: 'ai-brief',
    aiKeyConfigured: true,
    aiApiKey: '',
    hasEnvAiKey: true,
    aiKeySource: 'env',
    aiEndpoint: '',
    aiModel: '',
  });
  settingsBtn.dispatch('click');
  const envModal = body.querySelector('#aq-key-settings-modal');
  assert.equal(envModal.querySelector('[data-aq-ks-key]').value, '');
  assert.match(envModal.querySelector('[data-aq-ks-key]').getAttribute('placeholder'), /环境变量/);

  win.__aqCleanup?.();
});
