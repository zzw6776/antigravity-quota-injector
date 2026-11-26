import { execFile } from 'node:child_process';
import { encodePowerShellCommand } from './platform.mjs';

const UUID_RE = /^[0-9a-f-]{36}$/i;
const DEFAULT_PENDING_TTL_MS = 20_000;
const DEFAULT_DEDUPE_MS = 1_500;
const DEFAULT_MAX_QUEUE = 8;

export function formatShortcutHint(platform = process.platform) {
  return platform === 'darwin' ? '⌘⇧N' : 'Ctrl+Shift+N';
}

export function createDetachedWindowCoordinator({
  nowFn = () => Date.now(),
  ttlMs = DEFAULT_PENDING_TTL_MS,
  dedupeMs = DEFAULT_DEDUPE_MS,
  maxQueue = DEFAULT_MAX_QUEUE,
} = {}) {
  let seq = 0;
  const queue = [];
  const detachedTargets = new Set();
  const effectiveTtlMs = Math.max(3_000, Number(ttlMs) || DEFAULT_PENDING_TTL_MS);
  const effectiveDedupeMs = Math.max(0, Number(dedupeMs) || 0);
  const effectiveMaxQueue = Math.max(1, Number(maxQueue) || DEFAULT_MAX_QUEUE);

  const pruneExpired = () => {
    const now = nowFn();
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (now >= queue[i].expiresAt) {
        queue.splice(i, 1);
      }
    }
  };

  return {
    arm({ cascadeId, sourceTargetId = '', title = '', bounds = null, applyPosition = true } = {}) {
      const cid = String(cascadeId || '').trim();
      if (!UUID_RE.test(cid)) return null;
      pruneExpired();
      const now = nowFn();
      const cidLower = cid.toLowerCase();
      const srcId = String(sourceTargetId || '').trim();

      if (effectiveDedupeMs > 0) {
        const dup = queue.find(
          (item) =>
            item.cascadeId.toLowerCase() === cidLower &&
            item.sourceTargetId === srcId &&
            now - item.createdAt < effectiveDedupeMs
        );
        if (dup) {
          return { duplicate: true, entry: { ...dup } };
        }
      }

      seq += 1;
      const entry = {
        requestId: `detach-${now}-${seq}`,
        cascadeId: cid,
        sourceTargetId: srcId,
        title: String(title || '').trim(),
        bounds: bounds ? { ...bounds } : null,
        applyPosition: applyPosition !== false,
        createdAt: now,
        expiresAt: now + effectiveTtlMs,
      };
      while (queue.length >= effectiveMaxQueue) {
        queue.shift();
      }
      queue.push(entry);
      return { duplicate: false, entry: { ...entry } };
    },

    hasRequest(requestId) {
      pruneExpired();
      const id = String(requestId || '').trim();
      if (!id) return false;
      return queue.some((item) => item.requestId === id);
    },

    hasActivePending() {
      pruneExpired();
      return queue.length > 0;
    },

    clearPending(requestId = '') {
      pruneExpired();
      if (queue.length === 0) return false;
      const id = String(requestId || '').trim();
      if (!id) {
        queue.length = 0;
        return true;
      }
      const idx = queue.findIndex((item) => item.requestId === id);
      if (idx < 0) return false;
      queue.splice(idx, 1);
      return true;
    },

    consumeForNewTarget(targetId) {
      pruneExpired();
      const tid = String(targetId || '').trim();
      if (!tid || queue.length === 0) return null;
      const idx = queue.findIndex((item) => !item.sourceTargetId || item.sourceTargetId !== tid);
      if (idx < 0) return null;
      const [claimed] = queue.splice(idx, 1);
      detachedTargets.add(tid);
      return { ...claimed };
    },

    isDetachedTarget(targetId) {
      const tid = String(targetId || '').trim();
      return Boolean(tid && detachedTargets.has(tid));
    },

    setDetachedTarget(targetId, enabled) {
      const tid = String(targetId || '').trim();
      if (!tid) return;
      if (enabled) {
        detachedTargets.add(tid);
      } else {
        detachedTargets.delete(tid);
      }
    },

    forgetTarget(targetId) {
      const tid = String(targetId || '').trim();
      if (!tid) return;
      detachedTargets.delete(tid);
      for (let i = 0; i < queue.length; i += 1) {
        if (queue[i].sourceTargetId === tid) {
          queue[i].sourceTargetId = '';
        }
      }
    },
  };
}

export async function triggerNativeNewWindowViaCdp(client, { platform = process.platform } = {}) {
  if (!client || typeof client.send !== 'function' || (typeof client.isOpen === 'function' && !client.isOpen())) {
    return { ok: false, reason: 'cdp-closed' };
  }
  const isMac = platform === 'darwin';
  // CDP modifiers bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8
  const modifiers = isMac ? 4 | 8 : 2 | 8;
  const nativeVirtualKeyCode = isMac ? 45 : 78;
  try {
    const downRes = await client.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      modifiers,
      windowsVirtualKeyCode: 78,
      nativeVirtualKeyCode,
      key: 'N',
      code: 'KeyN',
    });
    if (!downRes || downRes.error) {
      return {
        ok: false,
        reason: String(downRes?.error?.message || 'cdp-key-failed'),
      };
    }
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers,
      windowsVirtualKeyCode: 78,
      nativeVirtualKeyCode,
      key: 'N',
      code: 'KeyN',
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err?.message || 'cdp-key-error') };
  }
}

export function buildEarlyDetachedBootstrapExpression({
  cascadeId = '',
  isMac = process.platform === 'darwin',
} = {}) {
  const cid = String(cascadeId || '').trim();
  const safeCid = UUID_RE.test(cid) ? cid : '';
  return `(() => {
    try {
      const root = document.documentElement;
      if (root) {
        root.setAttribute('data-aq-detached-chat', '1');
        if (${Boolean(isMac)}) {
          root.setAttribute('data-aq-platform', 'mac');
        }
      }
      try { sessionStorage.setItem('aq_detached_chat_v1', '1'); } catch {}
      if (!document.getElementById('aq-style') && !document.getElementById('aq-detach-boot-style')) {
        const st = document.createElement('style');
        st.id = 'aq-detach-boot-style';
        st.textContent = [
          'html[data-aq-detached-chat="1"] [data-testid="sidebar-split"] > :has(.bg-sidebar),',
          'html[data-aq-detached-chat="1"] [data-testid="sidebar-split"] > :has(.bg-sidebar) + div,',
          'html[data-aq-detached-chat="1"] .agy-inset-shell > div.absolute.left-0.top-0:has([data-testid="sidebar-search-button"]),',
          'html[data-aq-detached-chat="1"] .agy-inset-shell > div.absolute.left-0.top-0:has([data-testid="sidebar-toggle"]) { display: none !important; }',
          'html[data-aq-detached-chat="1"][data-aq-platform="mac"] [class*="@container/titlebar"]:not([data-aq-mac-no-inset="1"]) > :first-child { padding-left: 84px !important; transition: none !important; }',
        ].join('\\n');
        (document.head || document.documentElement).appendChild(st);
      }
      const cid = ${JSON.stringify(safeCid)};
      if (cid) {
        const rootEl = document.getElementById('root') || document.body?.firstElementChild;
        const fk = rootEl && Object.keys(rootEl).find((k) => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'));
        if (fk) {
          const stack = [{ node: rootEl[fk], depth: 0 }];
          let visited = 0;
          while (stack.length > 0 && visited < 80) {
            const cur = stack.pop();
            const node = cur?.node;
            if (!node) continue;
            visited += 1;
            const mp = node.memoizedProps;
            const cand = mp && typeof mp === 'object' ? (mp.router || mp.value) : null;
            if (cand && typeof cand.navigate === 'function' && cand.history && cand.routeTree) {
              void cand.navigate({ to: '/c/$cascadeId', params: { cascadeId: cid } });
              break;
            }
            if (node.sibling) stack.push({ node: node.sibling, depth: cur.depth });
            if (node.child && cur.depth < 24) stack.push({ node: node.child, depth: cur.depth + 1 });
          }
        }
      }
    } catch {}
  })()`;
}

export function raiseAntigravityWindowByTitle({
  title = '',
  channel = 'stable',
  platform = process.platform,
  promptIfUntrusted = false,
  preferWindowMenu = false,
  execFileFn = execFile,
} = {}) {
  const exactTitle = String(title || '').trim();
  if (!exactTitle) {
    return Promise.resolve({ ok: false, reason: 'empty-title' });
  }
  if (/^Antigravity(?:\s*-\s*Insiders)?$/i.test(exactTitle)) {
    return Promise.resolve({ ok: false, reason: 'generic-title' });
  }
  const shortTitle = exactTitle.replace(/\s*-\s*Antigravity(?:\s*-\s*Insiders)?$/i, '').trim();
  if (process.env.NODE_TEST_CONTEXT) {
    return Promise.resolve({ ok: false, reason: 'test-context' });
  }

  if (platform === 'darwin') {
    const processName = channel === 'insiders' ? 'Antigravity - Insiders' : 'Antigravity';
    const bundleId = channel === 'insiders' ? 'com.google.antigravity.insiders' : 'com.google.antigravity';
    const jxaScript = `
ObjC.import("ApplicationServices");
ObjC.import("AppKit");
ObjC.import("Foundation");
function run(argv) {
  const bundleId = String(argv[0] || "");
  const procName = String(argv[1] || "");
  const exactTitle = String(argv[2] || "");
  const shortTitle = String(argv[3] || "");
  const wantPrompt = String(argv[4] || "") === "1";
  const preferMenu = String(argv[5] || "") === "1";

  const opts = $.NSDictionary.dictionaryWithObjectForKey($(wantPrompt), $("AXTrustedCheckOptionPrompt"));
  if (!$.AXIsProcessTrustedWithOptions(opts)) {
    return "untrusted";
  }

  const running = [];
  if (bundleId) {
    const byBundle = $.NSRunningApplication.runningApplicationsWithBundleIdentifier($(bundleId));
    for (let i = 0; i < byBundle.count; i++) running.push(byBundle.objectAtIndex(i));
  }
  if (running.length === 0) {
    const allApps = $.NSWorkspace.sharedWorkspace.runningApplications;
    for (let i = 0; i < allApps.count; i++) {
      const a = allApps.objectAtIndex(i);
      const name = String(ObjC.unwrap(a.localizedName) || "");
      if (name === procName) running.push(a);
    }
  }
  if (running.length === 0) return "no-process";

  const norm = (s) => String(s || "").trim().replace(/(?:\\.\\.\\.|…)+$/g, "").trim();
  const exactNorm = norm(exactTitle).toLowerCase();
  const shortNorm = norm(shortTitle).toLowerCase();

  const scoreTitle = (rawTitle) => {
    const wNorm = norm(rawTitle).toLowerCase();
    if (!wNorm) return 0;
    if (exactNorm && wNorm === exactNorm) return 100;
    if (shortNorm && wNorm === shortNorm) return 90;
    if (wNorm.length >= 4 && exactNorm && exactNorm.startsWith(wNorm)) return 80;
    if (wNorm.length >= 4 && shortNorm && shortNorm.startsWith(wNorm)) return 75;
    if (shortNorm && wNorm.startsWith(shortNorm)) return 70;
    if (shortNorm && wNorm.includes(shortNorm)) return 60;
    return 0;
  };

  const raiseViaWindowMenu = () => {
    let bestItem = null;
    let bestApp = null;
    let bestScore = -1;

    for (let i = 0; i < running.length; i++) {
      const app = running[i];
      const axApp = $.AXUIElementCreateApplication(app.processIdentifier);
      const mbRef = Ref();
      if ($.AXUIElementCopyAttributeValue(axApp, $("AXMenuBar"), mbRef) !== 0) continue;
      const mb = ObjC.castRefToObject(mbRef[0]);
      if (!mb) continue;
      const cRef = Ref();
      if ($.AXUIElementCopyAttributeValue(mb, $("AXChildren"), cRef) !== 0) continue;
      const barItems = ObjC.castRefToObject(cRef[0]);
      if (!barItems) continue;

      for (let k = 0; k < barItems.count; k++) {
        const mi = barItems.objectAtIndex(k);
        const mtRef = Ref();
        if ($.AXUIElementCopyAttributeValue(mi, $("AXTitle"), mtRef) !== 0) continue;
        const mt = String(ObjC.unwrap(ObjC.castRefToObject(mtRef[0])) || "");
        if (!/^(Window|窗口|視窗)$/i.test(mt)) continue;

        const subRef = Ref();
        if ($.AXUIElementCopyAttributeValue(mi, $("AXChildren"), subRef) !== 0) continue;
        const subs = ObjC.castRefToObject(subRef[0]);
        if (!subs || subs.count === 0) continue;
        const menu = subs.objectAtIndex(0);
        const mcRef = Ref();
        if ($.AXUIElementCopyAttributeValue(menu, $("AXChildren"), mcRef) !== 0) continue;
        const mItems = ObjC.castRefToObject(mcRef[0]);
        if (!mItems) continue;

        let startIdx = 0;
        for (let m = 0; m < mItems.count; m++) {
          const item = mItems.objectAtIndex(m);
          const stRef = Ref();
          const st = $.AXUIElementCopyAttributeValue(item, $("AXTitle"), stRef) === 0
            ? String(ObjC.unwrap(ObjC.castRefToObject(stRef[0])) || "").trim()
            : "";
          if (!st) startIdx = m + 1;
        }
        const scanFrom = startIdx < mItems.count ? startIdx : 0;

        for (let m = scanFrom; m < mItems.count; m++) {
          const item = mItems.objectAtIndex(m);
          const stRef = Ref();
          if ($.AXUIElementCopyAttributeValue(item, $("AXTitle"), stRef) !== 0) continue;
          const rawTitle = String(ObjC.unwrap(ObjC.castRefToObject(stRef[0])) || "");
          const matchScore = scoreTitle(rawTitle);
          if (matchScore <= 0) continue;

          let isMarked = false;
          try {
            const mkRef = Ref();
            if ($.AXUIElementCopyAttributeValue(item, $("AXMenuItemMarkChar"), mkRef) === 0) {
              isMarked = Boolean(String(ObjC.unwrap(ObjC.castRefToObject(mkRef[0])) || "").trim());
            }
          } catch {}
          const finalScore = matchScore + (isMarked ? 0 : 10);
          if (finalScore > bestScore) {
            bestScore = finalScore;
            bestItem = item;
            bestApp = app;
          }
        }
      }
    }

    if (!bestItem || !bestApp) return false;
    $.AXUIElementPerformAction(bestItem, $("AXPress"));
    bestApp.activateWithOptions(3);
    return true;
  };

  if (preferMenu) {
    return raiseViaWindowMenu() ? "raised-menu" : "not-found";
  }

  let bestWin = null;
  let bestApp = null;
  let bestScore = -1;
  let bestFullScreen = false;

  for (let i = 0; i < running.length; i++) {
    const app = running[i];
    const axApp = $.AXUIElementCreateApplication(app.processIdentifier);
    const ref = Ref();
    const err = $.AXUIElementCopyAttributeValue(axApp, $("AXWindows"), ref);
    if (err !== 0) continue;
    const wins = ObjC.castRefToObject(ref[0]);
    if (!wins) continue;

    for (let j = 0; j < wins.count; j++) {
      const w = wins.objectAtIndex(j);
      const tRef = Ref();
      if ($.AXUIElementCopyAttributeValue(w, $("AXTitle"), tRef) !== 0) continue;
      const rawTitle = String(ObjC.unwrap(ObjC.castRefToObject(tRef[0])) || "");
      const matchScore = scoreTitle(rawTitle);
      if (matchScore <= 0) continue;

      let isMain = false;
      try {
        const mRef = Ref();
        if ($.AXUIElementCopyAttributeValue(w, $("AXMain"), mRef) === 0) {
          isMain = Boolean(ObjC.unwrap(ObjC.castRefToObject(mRef[0])));
        }
      } catch {}
      let isFullScreen = false;
      try {
        const fsRef = Ref();
        if ($.AXUIElementCopyAttributeValue(w, $("AXFullScreen"), fsRef) === 0) {
          isFullScreen = Boolean(ObjC.unwrap(ObjC.castRefToObject(fsRef[0])));
        }
      } catch {}
      const finalScore = matchScore + (isMain ? 0 : 10);
      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestWin = w;
        bestApp = app;
        bestFullScreen = isFullScreen;
      }
    }
  }

  if (!bestWin || !bestApp || bestFullScreen) {
    if (raiseViaWindowMenu()) {
      return "raised-menu";
    }
    if (!bestWin || !bestApp) return "not-found";
  }

  try {
    const minRef = Ref();
    if ($.AXUIElementCopyAttributeValue(bestWin, $("AXMinimized"), minRef) === 0) {
      if (ObjC.unwrap(ObjC.castRefToObject(minRef[0]))) {
        $.AXUIElementSetAttributeValue(bestWin, $("AXMinimized"), $(false));
      }
    }
  } catch {}
  $.AXUIElementPerformAction(bestWin, $("AXRaise"));
  $.AXUIElementSetAttributeValue(bestWin, $("AXMain"), $(true));
  bestApp.activateWithOptions(3);
  return "raised";
}
`;

    return new Promise((resolve) => {
      try {
        execFileFn(
          'osascript',
          [
            '-l',
            'JavaScript',
            '-e',
            jxaScript,
            bundleId,
            processName,
            exactTitle,
            shortTitle,
            promptIfUntrusted ? '1' : '0',
            preferWindowMenu ? '1' : '0',
          ],
          { timeout: 2500 },
          (err, stdout, stderr) => {
            if (err) {
              const detail = String(stderr || err?.message || '').trim();
              const permissionDenied = /not allowed assistive access|not authorized|1002|-1743|-25204/i.test(detail);
              resolve({ ok: false, permissionDenied, reason: detail || 'jxa-error' });
              return;
            }
            const out = String(stdout || '').trim();
            if (out === 'raised' || out === 'raised-menu') {
              resolve({ ok: true, via: out });
              return;
            }
            resolve({
              ok: false,
              permissionDenied: out === 'untrusted',
              reason: out || 'not-raised',
            });
          }
        );
      } catch (err) {
        resolve({ ok: false, reason: String(err?.message || 'jxa-throw') });
      }
    });
  }

  if (platform === 'win32') {
    const psScript = `
Add-Type @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class AqWinFocus {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  private static string Norm(string s) {
    if (string.IsNullOrEmpty(s)) return "";
    string t = s.Trim();
    while (t.EndsWith("...", StringComparison.Ordinal) || t.EndsWith("\\u2026", StringComparison.Ordinal)) {
      t = t.EndsWith("...", StringComparison.Ordinal) ? t.Substring(0, t.Length - 3).TrimEnd() : t.Substring(0, t.Length - 1).TrimEnd();
    }
    return t.ToLowerInvariant();
  }
  public static bool RaiseByTitle(string exactTitle, string shortTitle) {
    string exactNorm = Norm(exactTitle);
    string shortNorm = Norm(shortTitle);
    if (string.IsNullOrEmpty(exactNorm) && string.IsNullOrEmpty(shortNorm)) return false;
    IntPtr fg = GetForegroundWindow();
    IntPtr bestWin = IntPtr.Zero;
    int bestScore = -1;
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      try {
        var proc = Process.GetProcessById((int)pid);
        if (!proc.ProcessName.StartsWith("Antigravity", StringComparison.OrdinalIgnoreCase)) return true;
      } catch { return true; }
      var sb = new StringBuilder(512);
      int len = GetWindowText(hWnd, sb, sb.Capacity);
      if (len <= 0) return true;
      string wNorm = Norm(sb.ToString());
      if (string.IsNullOrEmpty(wNorm)) return true;
      int matchScore = 0;
      if (!string.IsNullOrEmpty(exactNorm) && wNorm == exactNorm) {
        matchScore = 100;
      } else if (!string.IsNullOrEmpty(shortNorm) && wNorm == shortNorm) {
        matchScore = 90;
      } else if (wNorm.Length >= 4 && !string.IsNullOrEmpty(exactNorm) && exactNorm.StartsWith(wNorm, StringComparison.Ordinal)) {
        matchScore = 80;
      } else if (wNorm.Length >= 4 && !string.IsNullOrEmpty(shortNorm) && shortNorm.StartsWith(wNorm, StringComparison.Ordinal)) {
        matchScore = 75;
      } else if (!string.IsNullOrEmpty(shortNorm) && wNorm.StartsWith(shortNorm, StringComparison.Ordinal)) {
        matchScore = 70;
      } else if (!string.IsNullOrEmpty(shortNorm) && wNorm.IndexOf(shortNorm, StringComparison.Ordinal) >= 0) {
        matchScore = 60;
      }
      if (matchScore <= 0) return true;
      int finalScore = matchScore + (hWnd == fg ? 0 : 10);
      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestWin = hWnd;
      }
      return true;
    }, IntPtr.Zero);
    if (bestWin == IntPtr.Zero) return false;
    if (IsIconic(bestWin)) ShowWindow(bestWin, 9);
    uint fgPid;
    uint fgThread = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out fgPid) : 0;
    uint targetPid;
    uint targetThread = GetWindowThreadProcessId(bestWin, out targetPid);
    uint curThread = GetCurrentThreadId();
    if (fgThread != 0 && fgThread != curThread) AttachThreadInput(fgThread, curThread, true);
    if (targetThread != 0 && targetThread != curThread) AttachThreadInput(targetThread, curThread, true);
    bool ok = SetForegroundWindow(bestWin);
    if (targetThread != 0 && targetThread != curThread) AttachThreadInput(targetThread, curThread, false);
    if (fgThread != 0 && fgThread != curThread) AttachThreadInput(fgThread, curThread, false);
    return ok;
  }
}
"@
if ([AqWinFocus]::RaiseByTitle($env:AQ_EXACT_TITLE, $env:AQ_SHORT_TITLE)) { Write-Output "raised" } else { Write-Output "not-found" }
`;
    return new Promise((resolve) => {
      try {
        execFileFn(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-WindowStyle',
            'Hidden',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            encodePowerShellCommand(psScript),
          ],
          {
            timeout: 5000,
            windowsHide: true,
            env: {
              ...process.env,
              AQ_EXACT_TITLE: exactTitle,
              AQ_SHORT_TITLE: shortTitle,
            },
          },
          (err, stdout) => {
            if (err) {
              resolve({ ok: false, reason: String(err?.message || 'ps-error') });
              return;
            }
            const out = String(stdout || '').trim();
            resolve(out === 'raised' ? { ok: true } : { ok: false, reason: out || 'not-raised' });
          }
        );
      } catch (err) {
        resolve({ ok: false, reason: String(err?.message || 'ps-throw') });
      }
    });
  }

  return Promise.resolve({ ok: false, reason: 'unsupported-platform' });
}

export function setAntigravityWindowBounds({
  title = '',
  curBounds = null,
  bounds = null,
  applyPosition = true,
  channel = 'stable',
  platform = process.platform,
  execFileFn = execFile,
} = {}) {
  if (!bounds || typeof bounds !== 'object') {
    return Promise.resolve({ ok: false, reason: 'missing-bounds' });
  }
  const targetX = Math.round(Number(bounds.x));
  const targetY = Math.round(Number(bounds.y));
  const targetW = Math.round(Number(bounds.width));
  const targetH = Math.round(Number(bounds.height));
  if (
    !Number.isFinite(targetW) ||
    !Number.isFinite(targetH) ||
    targetW < 360 ||
    targetH < 280
  ) {
    return Promise.resolve({ ok: false, reason: 'invalid-bounds' });
  }
  if (process.env.NODE_TEST_CONTEXT) {
    return Promise.resolve({ ok: false, reason: 'test-context' });
  }

  const exactTitle = String(title || '').trim();
  const isGenericTitle = !exactTitle || /^Antigravity(?:\s*-\s*Insiders)?$/i.test(exactTitle);
  const shortTitle = isGenericTitle
    ? ''
    : exactTitle.replace(/\s*-\s*Antigravity(?:\s*-\s*Insiders)?$/i, '').trim();
  const curJson =
    curBounds &&
    Number.isFinite(Number(curBounds.x)) &&
    Number.isFinite(Number(curBounds.y)) &&
    Number.isFinite(Number(curBounds.width)) &&
    Number.isFinite(Number(curBounds.height))
      ? JSON.stringify({
          x: Math.round(Number(curBounds.x)),
          y: Math.round(Number(curBounds.y)),
          w: Math.round(Number(curBounds.width)),
          h: Math.round(Number(curBounds.height)),
        })
      : '';
  const targetJson = JSON.stringify({
    x: Number.isFinite(targetX) ? targetX : 0,
    y: Number.isFinite(targetY) ? targetY : 0,
    w: targetW,
    h: targetH,
    applyPos: Boolean(applyPosition && Number.isFinite(targetX) && Number.isFinite(targetY)),
  });

  if (platform === 'darwin') {
    const processName = channel === 'insiders' ? 'Antigravity - Insiders' : 'Antigravity';
    const bundleId = channel === 'insiders' ? 'com.google.antigravity.insiders' : 'com.google.antigravity';
    const jxaScript = `
ObjC.import("ApplicationServices");
ObjC.import("AppKit");
ObjC.import("Foundation");
function run(argv) {
  const bundleId = String(argv[0] || "");
  const procName = String(argv[1] || "");
  const exactTitle = String(argv[2] || "");
  const shortTitle = String(argv[3] || "");
  const cur = argv[4] ? JSON.parse(String(argv[4])) : null;
  const target = JSON.parse(String(argv[5] || "{}"));

  if (!$.AXIsProcessTrusted()) return "untrusted";

  const running = [];
  if (bundleId) {
    const byBundle = $.NSRunningApplication.runningApplicationsWithBundleIdentifier($(bundleId));
    for (let i = 0; i < byBundle.count; i++) running.push(byBundle.objectAtIndex(i));
  }
  if (running.length === 0) {
    const allApps = $.NSWorkspace.sharedWorkspace.runningApplications;
    for (let i = 0; i < allApps.count; i++) {
      const a = allApps.objectAtIndex(i);
      const name = String(ObjC.unwrap(a.localizedName) || "");
      if (name === procName) running.push(a);
    }
  }
  if (running.length === 0) return "no-process";

  const getAxPoint = (win) => {
    const ref = Ref();
    if ($.AXUIElementCopyAttributeValue(win, $("AXPosition"), ref) !== 0) return null;
    const outBuf = $.NSMutableData.dataWithLength(16);
    if (!$.AXValueGetValue(ObjC.castRefToObject(ref[0]), 1, outBuf.mutableBytes)) return null;
    const pt = $.NSValue.valueWithBytesObjCType(outBuf.bytes, "{CGPoint=dd}").pointValue;
    return { x: pt.x, y: pt.y };
  };
  const getAxSize = (win) => {
    const ref = Ref();
    if ($.AXUIElementCopyAttributeValue(win, $("AXSize"), ref) !== 0) return null;
    const outBuf = $.NSMutableData.dataWithLength(16);
    if (!$.AXValueGetValue(ObjC.castRefToObject(ref[0]), 2, outBuf.mutableBytes)) return null;
    const sz = $.NSValue.valueWithBytesObjCType(outBuf.bytes, "{CGSize=dd}").sizeValue;
    return { w: sz.width, h: sz.height };
  };
  const setAxPoint = (win, x, y) => {
    const buf = $.NSMutableData.dataWithLength(16);
    $.NSValue.valueWithPoint($.NSMakePoint(x, y)).getValue(buf.mutableBytes);
    const val = $.AXValueCreate(1, buf.bytes);
    return $.AXUIElementSetAttributeValue(win, $("AXPosition"), ObjC.castRefToObject(val)) === 0;
  };
  const setAxSize = (win, w, h) => {
    const buf = $.NSMutableData.dataWithLength(16);
    $.NSValue.valueWithSize($.NSMakeSize(w, h)).getValue(buf.mutableBytes);
    const val = $.AXValueCreate(2, buf.bytes);
    return $.AXUIElementSetAttributeValue(win, $("AXSize"), ObjC.castRefToObject(val)) === 0;
  };

  const norm = (s) => String(s || "").trim().replace(/(?:\\.\\.\\.|…)+$/g, "").trim();
  const exactNorm = norm(exactTitle).toLowerCase();
  const shortNorm = norm(shortTitle).toLowerCase();
  const scoreTitle = (rawTitle) => {
    if (!shortNorm) return 0;
    const wNorm = norm(rawTitle).toLowerCase();
    if (!wNorm) return 0;
    if (exactNorm && wNorm === exactNorm) return 100;
    if (wNorm === shortNorm) return 90;
    if (wNorm.length >= 4 && exactNorm && exactNorm.startsWith(wNorm)) return 80;
    if (wNorm.length >= 4 && shortNorm.startsWith(wNorm)) return 75;
    if (wNorm.startsWith(shortNorm)) return 70;
    if (wNorm.includes(shortNorm)) return 60;
    return 0;
  };

  let bestWin = null;
  let bestScore = 0;

  for (let i = 0; i < running.length; i++) {
    const app = running[i];
    const axApp = $.AXUIElementCreateApplication(app.processIdentifier);
    const ref = Ref();
    if ($.AXUIElementCopyAttributeValue(axApp, $("AXWindows"), ref) !== 0) continue;
    const wins = ObjC.castRefToObject(ref[0]);
    if (!wins) continue;

    for (let j = 0; j < wins.count; j++) {
      const w = wins.objectAtIndex(j);
      let isMain = false;
      try {
        const mRef = Ref();
        if ($.AXUIElementCopyAttributeValue(w, $("AXMain"), mRef) === 0) {
          isMain = Boolean(ObjC.unwrap(ObjC.castRefToObject(mRef[0])));
        }
      } catch {}

      let score = 0;
      if (cur) {
        const pos = getAxPoint(w);
        const sz = getAxSize(w);
        if (
          pos && sz &&
          Math.abs(pos.x - cur.x) <= 8 &&
          Math.abs(pos.y - cur.y) <= 8 &&
          Math.abs(sz.w - cur.w) <= 8 &&
          Math.abs(sz.h - cur.h) <= 8
        ) {
          score = 1000 + (isMain ? 10 : 0);
        }
      }
      if (score === 0 && shortNorm) {
        const tRef = Ref();
        if ($.AXUIElementCopyAttributeValue(w, $("AXTitle"), tRef) === 0) {
          const rawTitle = String(ObjC.unwrap(ObjC.castRefToObject(tRef[0])) || "");
          const tScore = scoreTitle(rawTitle);
          if (tScore > 0) score = tScore + (isMain ? 10 : 0);
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestWin = w;
      }
    }
  }

  if (!bestWin) return "not-found";
  try {
    const fsRef = Ref();
    if ($.AXUIElementCopyAttributeValue(bestWin, $("AXFullScreen"), fsRef) === 0) {
      if (ObjC.unwrap(ObjC.castRefToObject(fsRef[0]))) return "fullscreen-skip";
    }
  } catch {}

  const screens = $.NSScreen.screens;
  const visibleRects = [];
  if (screens && screens.count > 0) {
    const primaryH = screens.objectAtIndex(0).frame.size.height;
    for (let i = 0; i < screens.count; i++) {
      const vf = screens.objectAtIndex(i).visibleFrame;
      visibleRects.push({
        left: vf.origin.x,
        top: primaryH - (vf.origin.y + vf.size.height),
        width: vf.size.width,
        height: vf.size.height,
      });
    }
  }

  let canMove = Boolean(target.applyPos);
  let chosenScreen = visibleRects[0] || null;
  if (canMove && visibleRects.length > 0) {
    let matchedScreen = null;
    for (let i = 0; i < visibleRects.length; i++) {
      const s = visibleRects[i];
      const ix = Math.max(0, Math.min(target.x + target.w, s.left + s.width) - Math.max(target.x, s.left));
      const iy = Math.max(0, Math.min(target.y + target.h, s.top + s.height) - Math.max(target.y, s.top));
      if (ix >= 80 && iy >= 60) {
        matchedScreen = s;
        break;
      }
    }
    if (matchedScreen) {
      chosenScreen = matchedScreen;
    } else {
      canMove = false;
    }
  }

  const finalW = chosenScreen ? Math.min(target.w, Math.round(chosenScreen.width)) : target.w;
  const finalH = chosenScreen ? Math.min(target.h, Math.round(chosenScreen.height)) : target.h;
  let ok = false;
  if (canMove) {
    const p1 = setAxPoint(bestWin, target.x, target.y);
    const s1 = setAxSize(bestWin, finalW, finalH);
    const p2 = setAxPoint(bestWin, target.x, target.y);
    ok = p1 || s1 || p2;
  } else {
    ok = setAxSize(bestWin, finalW, finalH);
  }
  return ok ? "applied" : "set-failed";
}
`;

    return new Promise((resolve) => {
      try {
        execFileFn(
          'osascript',
          [
            '-l',
            'JavaScript',
            '-e',
            jxaScript,
            bundleId,
            processName,
            exactTitle,
            shortTitle,
            curJson,
            targetJson,
          ],
          { timeout: 2500 },
          (err, stdout) => {
            if (err) {
              resolve({ ok: false, reason: String(err?.message || 'jxa-error') });
              return;
            }
            const out = String(stdout || '').trim();
            resolve(out === 'applied' ? { ok: true } : { ok: false, reason: out || 'not-applied' });
          }
        );
      } catch (err) {
        resolve({ ok: false, reason: String(err?.message || 'jxa-throw') });
      }
    });
  }

  if (platform === 'win32') {
    const psScript = `
Add-Type @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class AqWinBounds {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromRect(ref RECT lprc, uint dwFlags);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  private static string Norm(string s) {
    if (string.IsNullOrEmpty(s)) return "";
    string t = s.Trim();
    while (t.EndsWith("...", StringComparison.Ordinal) || t.EndsWith("\\u2026", StringComparison.Ordinal)) {
      t = t.EndsWith("...", StringComparison.Ordinal) ? t.Substring(0, t.Length - 3).TrimEnd() : t.Substring(0, t.Length - 1).TrimEnd();
    }
    return t.ToLowerInvariant();
  }
  public static bool Apply(string exactTitle, string shortTitle, int hasCur, int curX, int curY, int curW, int curH, int tx, int ty, int tw, int th, int applyPos) {
    string exactNorm = Norm(exactTitle);
    string shortNorm = Norm(shortTitle);
    IntPtr fg = GetForegroundWindow();
    IntPtr bestWin = IntPtr.Zero;
    int bestScore = 0;
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      try {
        var proc = Process.GetProcessById((int)pid);
        if (!proc.ProcessName.StartsWith("Antigravity", StringComparison.OrdinalIgnoreCase)) return true;
      } catch { return true; }
      int score = 0;
      RECT r;
      if (hasCur != 0 && GetWindowRect(hWnd, out r)) {
        int rw = r.Right - r.Left;
        int rh = r.Bottom - r.Top;
        if (Math.Abs(r.Left - curX) <= 20 && Math.Abs(r.Top - curY) <= 20 && Math.Abs(rw - curW) <= 24 && Math.Abs(rh - curH) <= 24) {
          score = 1000 + (hWnd == fg ? 10 : 0);
        }
      }
      if (score == 0 && !string.IsNullOrEmpty(shortNorm)) {
        var sb = new StringBuilder(512);
        int len = GetWindowText(hWnd, sb, sb.Capacity);
        if (len > 0) {
          string wNorm = Norm(sb.ToString());
          if (!string.IsNullOrEmpty(exactNorm) && wNorm == exactNorm) score = 100;
          else if (wNorm == shortNorm) score = 90;
          else if (wNorm.Length >= 4 && !string.IsNullOrEmpty(exactNorm) && exactNorm.StartsWith(wNorm, StringComparison.Ordinal)) score = 80;
          else if (wNorm.Length >= 4 && shortNorm.StartsWith(wNorm, StringComparison.Ordinal)) score = 75;
          else if (wNorm.StartsWith(shortNorm, StringComparison.Ordinal)) score = 70;
          else if (wNorm.IndexOf(shortNorm, StringComparison.Ordinal) >= 0) score = 60;
          if (score > 0 && hWnd == fg) score += 10;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestWin = hWnd;
      }
      return true;
    }, IntPtr.Zero);
    if (bestWin == IntPtr.Zero) return false;
    uint flags = 0x0004 | 0x0010; // SWP_NOZORDER | SWP_NOACTIVATE
    bool canMove = applyPos != 0;
    if (canMove) {
      RECT tr = new RECT { Left = tx, Top = ty, Right = tx + tw, Bottom = ty + th };
      if (MonitorFromRect(ref tr, 0) == IntPtr.Zero) canMove = false;
    }
    if (!canMove) flags |= 0x0002; // SWP_NOMOVE
    return SetWindowPos(bestWin, IntPtr.Zero, tx, ty, tw, th, flags);
  }
}
"@
$cur = if ($env:AQ_CUR_BOUNDS) { $env:AQ_CUR_BOUNDS | ConvertFrom-Json } else { $null }
$tgt = $env:AQ_TARGET_BOUNDS | ConvertFrom-Json
$hasCur = if ($cur) { 1 } else { 0 }
$cx = if ($cur) { [int]$cur.x } else { 0 }
$cy = if ($cur) { [int]$cur.y } else { 0 }
$cw = if ($cur) { [int]$cur.w } else { 0 }
$ch = if ($cur) { [int]$cur.h } else { 0 }
$ap = if ($tgt.applyPos) { 1 } else { 0 }
if ([AqWinBounds]::Apply($env:AQ_EXACT_TITLE, $env:AQ_SHORT_TITLE, $hasCur, $cx, $cy, $cw, $ch, [int]$tgt.x, [int]$tgt.y, [int]$tgt.w, [int]$tgt.h, $ap)) { Write-Output "applied" } else { Write-Output "not-found" }
`;
    return new Promise((resolve) => {
      try {
        execFileFn(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-WindowStyle',
            'Hidden',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            encodePowerShellCommand(psScript),
          ],
          {
            timeout: 5000,
            windowsHide: true,
            env: {
              ...process.env,
              AQ_EXACT_TITLE: exactTitle,
              AQ_SHORT_TITLE: shortTitle,
              AQ_CUR_BOUNDS: curJson,
              AQ_TARGET_BOUNDS: targetJson,
            },
          },
          (err, stdout) => {
            if (err) {
              resolve({ ok: false, reason: String(err?.message || 'ps-error') });
              return;
            }
            const out = String(stdout || '').trim();
            resolve(out === 'applied' ? { ok: true } : { ok: false, reason: out || 'not-applied' });
          }
        );
      } catch (err) {
        resolve({ ok: false, reason: String(err?.message || 'ps-throw') });
      }
    });
  }

  return Promise.resolve({ ok: false, reason: 'unsupported-platform' });
}

export function openMacAccessibilitySettings({
  platform = process.platform,
  execFileFn = execFile,
} = {}) {
  if (platform !== 'darwin' || process.env.NODE_TEST_CONTEXT) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    try {
      execFileFn(
        'open',
        ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'],
        { timeout: 2500 },
        (err) => resolve(!err)
      );
    } catch {
      resolve(false);
    }
  });
}


