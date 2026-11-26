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
    arm({ cascadeId, sourceTargetId = '', title = '' } = {}) {
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

  let bestWin = null;
  let bestApp = null;
  let bestScore = -1;

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
      const wNorm = norm(rawTitle).toLowerCase();
      if (!wNorm) continue;

      let matchScore = 0;
      if (exactNorm && wNorm === exactNorm) {
        matchScore = 100;
      } else if (shortNorm && wNorm === shortNorm) {
        matchScore = 90;
      } else if (wNorm.length >= 4 && exactNorm && exactNorm.startsWith(wNorm)) {
        matchScore = 80;
      } else if (wNorm.length >= 4 && shortNorm && shortNorm.startsWith(wNorm)) {
        matchScore = 75;
      } else if (shortNorm && wNorm.startsWith(shortNorm)) {
        matchScore = 70;
      } else if (shortNorm && wNorm.includes(shortNorm)) {
        matchScore = 60;
      }
      if (matchScore <= 0) continue;

      // Prefer non-main window when multiple windows share a similar title
      let isMain = false;
      try {
        const mRef = Ref();
        if ($.AXUIElementCopyAttributeValue(w, $("AXMain"), mRef) === 0) {
          isMain = Boolean(ObjC.unwrap(ObjC.castRefToObject(mRef[0])));
        }
      } catch {}
      const finalScore = matchScore + (isMain ? 0 : 10);
      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestWin = w;
        bestApp = app;
      }
    }
  }

  if (!bestWin || !bestApp) return "not-found";
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
            if (out === 'raised') {
              resolve({ ok: true });
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


