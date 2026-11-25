import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_BUILD_MARKERS = [
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
];

function parseFragmentLineCol(fragment = '') {
  const clean = String(fragment || '').replace(/^#/, '').trim();
  if (!clean) return { line: null, column: null };
  const lMatch = /^L?(\d+)(?:(?:-L?\d+)|(?::(\d+))|(?:C(\d+)))?/i.exec(clean);
  if (!lMatch) return { line: null, column: null };
  const lineNum = Number.parseInt(lMatch[1], 10);
  const colRaw = lMatch[2] || lMatch[3] || '';
  const colNum = colRaw ? Number.parseInt(colRaw, 10) : null;
  return {
    line: Number.isInteger(lineNum) && lineNum > 0 ? lineNum : null,
    column: Number.isInteger(colNum) && colNum > 0 ? colNum : null,
  };
}

/**
 * 解析并校验本地文件 URI 或绝对路径，同时提取 #L行号 与列号。
 */
export function parseLocalFileTarget(
  rawUriOrPath,
  {
    line: explicitLine = null,
    column: explicitColumn = null,
    platform = process.platform,
    statSync = fs.statSync,
  } = {}
) {
  const raw = String(rawUriOrPath || '').trim();
  if (!raw || raw.includes('\0')) {
    return { ok: false, error: '无效的文件路径' };
  }

  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  let fragment = '';
  let cleanInput = raw;
  const hashIdx = raw.indexOf('#');
  if (hashIdx >= 0) {
    fragment = raw.slice(hashIdx + 1);
    cleanInput = raw.slice(0, hashIdx);
  }

  let filePath = '';
  if (/^file:\/\//i.test(cleanInput)) {
    try {
      filePath = fileURLToPath(cleanInput, { windows: platform === 'win32' });
    } catch {
      return { ok: false, error: '无法解析本地文件链接' };
    }
  } else if (pathMod.isAbsolute(cleanInput)) {
    filePath = pathMod.normalize(cleanInput);
  } else {
    return { ok: false, error: '仅支持打开本地绝对路径文件' };
  }

  if (!filePath || filePath.includes('\0')) {
    return { ok: false, error: '无效的本地路径' };
  }

  if (platform === 'win32' && filePath.startsWith('\\\\')) {
    return { ok: false, error: '不支持直接打开网络共享路径' };
  }

  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return { ok: false, error: '本地文件不存在或已被移除' };
  }

  const fragLoc = parseFragmentLineCol(fragment);
  const parsedLine = Number.parseInt(String(explicitLine ?? ''), 10);
  const parsedCol = Number.parseInt(String(explicitColumn ?? ''), 10);
  const line = Number.isInteger(parsedLine) && parsedLine > 0 ? parsedLine : fragLoc.line;
  const column = Number.isInteger(parsedCol) && parsedCol > 0 ? parsedCol : fragLoc.column;

  return {
    ok: true,
    filePath,
    isDirectory: Boolean(stat?.isDirectory?.()),
    line: line || null,
    column: column || null,
  };
}

function normalizePathForCompare(p, platform) {
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  const clean = pathMod.resolve(String(p || '')).replace(/[\\/]+$/, '');
  return platform === 'win32' ? clean.toLowerCase() : clean;
}

/**
 * 向上查找文件所属工程根目录：优先匹配 .idea，其次 .git，最后匹配最外层构建描述文件；不把用户主目录误判为项目。
 */
export function findProjectRootForFile(
  filePath,
  {
    isDirectory = false,
    platform = process.platform,
    homedir = os.homedir(),
    existsSync = fs.existsSync,
  } = {}
) {
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  if (!filePath) return null;
  const homeCmp = homedir ? normalizePathForCompare(homedir, platform) : '';
  const ancestors = [];
  let cur = isDirectory ? pathMod.resolve(filePath) : pathMod.dirname(pathMod.resolve(filePath));

  for (let depth = 0; depth < 40 && cur; depth++) {
    const parent = pathMod.dirname(cur);
    if (!parent || parent === cur) break;
    if (homeCmp && normalizePathForCompare(cur, platform) === homeCmp) break;
    ancestors.push(cur);
    cur = parent;
  }

  for (let i = 0; i < ancestors.length; i++) {
    const dir = ancestors[i];
    if (existsSync(pathMod.join(dir, '.idea'))) {
      return dir;
    }
  }
  for (let i = 0; i < ancestors.length; i++) {
    const dir = ancestors[i];
    if (existsSync(pathMod.join(dir, '.git'))) {
      return dir;
    }
  }
  let outermostManifestDir = null;
  for (let i = 0; i < ancestors.length; i++) {
    const dir = ancestors[i];
    for (let j = 0; j < PROJECT_BUILD_MARKERS.length; j++) {
      if (existsSync(pathMod.join(dir, PROJECT_BUILD_MARKERS[j]))) {
        outermostManifestDir = dir;
        break;
      }
    }
  }
  return outermostManifestDir;
}

function findInSystemPath(names, { platform, env, existsSync }) {
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  const sep = platform === 'win32' ? ';' : ':';
  const rawPath = String(env?.PATH || env?.Path || '');
  const dirs = rawPath.split(sep).map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < dirs.length; i++) {
    for (let j = 0; j < names.length; j++) {
      const candidate = pathMod.join(dirs[i], names[j]);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {}
    }
  }
  return '';
}

function listMatchingSubdirsDesc(parentDir, pattern, { readdirSync }) {
  try {
    const entries = readdirSync(parentDir, { withFileTypes: true });
    return entries
      .filter((e) => (typeof e?.isDirectory === 'function' ? e.isDirectory() : true) && pattern.test(e.name ?? String(e)))
      .map((e) => String(e.name ?? e))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
  } catch {
    return [];
  }
}

function classifyExec(p, platform) {
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(p)) {
    return { kind: 'cmd', path: p };
  }
  return { kind: 'binary', path: p };
}

function firstExisting(candidates, existsSync) {
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i];
    if (!p) continue;
    try {
      if (existsSync(p)) return p;
    } catch {}
  }
  return '';
}

function resolveWinEnvDirs(env, homedir) {
  const pathMod = path.win32;
  const localAppData = env?.LOCALAPPDATA || (homedir ? pathMod.join(homedir, 'AppData', 'Local') : '');
  const progFiles = env?.ProgramFiles || 'C:\\Program Files';
  const progFilesX86 = env?.['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const sysRoot = env?.SystemRoot || env?.WINDIR || 'C:\\Windows';
  return { localAppData, progFiles, progFilesX86, sysRoot };
}

function resolveIdeaEditor({ platform, env, homedir, existsSync, readdirSync, customPath }) {
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  if (customPath) {
    const trimmed = String(customPath).trim();
    if (platform === 'darwin' && trimmed.endsWith('.app')) {
      const bin = pathMod.join(trimmed, 'Contents', 'MacOS', 'idea');
      if (existsSync(bin)) return { kind: 'binary', path: bin };
    } else if (existsSync(trimmed)) {
      return classifyExec(trimmed, platform);
    }
  }

  if (platform === 'darwin') {
    const hit = firstExisting(
      [
        '/Applications/IntelliJ IDEA.app/Contents/MacOS/idea',
        homedir ? pathMod.join(homedir, 'Applications', 'IntelliJ IDEA.app', 'Contents', 'MacOS', 'idea') : '',
        '/Applications/IntelliJ IDEA Ultimate.app/Contents/MacOS/idea',
        '/Applications/IntelliJ IDEA CE.app/Contents/MacOS/idea',
        homedir ? pathMod.join(homedir, 'Applications', 'IntelliJ IDEA CE.app', 'Contents', 'MacOS', 'idea') : '',
        homedir
          ? pathMod.join(homedir, 'Library', 'Application Support', 'JetBrains', 'Toolbox', 'scripts', 'idea')
          : '',
      ],
      existsSync
    );
    if (hit) return { kind: 'binary', path: hit };

    for (const appRoot of ['/Applications', homedir ? pathMod.join(homedir, 'Applications') : ''].filter(Boolean)) {
      const matches = listMatchingSubdirsDesc(appRoot, /^IntelliJ IDEA.*\.app$/i, { readdirSync });
      for (let j = 0; j < matches.length; j++) {
        const bin = pathMod.join(appRoot, matches[j], 'Contents', 'MacOS', 'idea');
        if (existsSync(bin)) return { kind: 'binary', path: bin };
      }
    }
    const inPath = findInSystemPath(['idea'], { platform, env, existsSync });
    return inPath ? { kind: 'binary', path: inPath } : null;
  }

  if (platform === 'win32') {
    const { localAppData, progFiles, progFilesX86 } = resolveWinEnvDirs(env, homedir);
    if (localAppData) {
      const directWin = firstExisting(
        [
          pathMod.join(localAppData, 'Programs', 'IntelliJ IDEA Ultimate', 'bin', 'idea64.exe'),
          pathMod.join(localAppData, 'Programs', 'IntelliJ IDEA Community Edition', 'bin', 'idea64.exe'),
        ],
        existsSync
      );
      if (directWin) return { kind: 'binary', path: directWin };

      const localMatches = listMatchingSubdirsDesc(
        pathMod.join(localAppData, 'Programs'),
        /^IntelliJ IDEA/i,
        { readdirSync }
      );
      for (let i = 0; i < localMatches.length; i++) {
        const exe = pathMod.join(localAppData, 'Programs', localMatches[i], 'bin', 'idea64.exe');
        if (existsSync(exe)) return { kind: 'binary', path: exe };
      }
      const tbScript = firstExisting(
        [
          pathMod.join(localAppData, 'JetBrains', 'Toolbox', 'scripts', 'idea.cmd'),
          pathMod.join(localAppData, 'JetBrains', 'Toolbox', 'scripts', 'idea.bat'),
        ],
        existsSync
      );
      if (tbScript) return { kind: 'cmd', path: tbScript };
    }

    for (const jbParent of [pathMod.join(progFiles, 'JetBrains'), pathMod.join(progFilesX86, 'JetBrains')]) {
      const matches = listMatchingSubdirsDesc(jbParent, /^IntelliJ IDEA/i, { readdirSync });
      for (let i = 0; i < matches.length; i++) {
        const exe = pathMod.join(jbParent, matches[i], 'bin', 'idea64.exe');
        if (existsSync(exe)) return { kind: 'binary', path: exe };
      }
    }
    const inPath = findInSystemPath(['idea64.exe', 'idea.cmd', 'idea.bat'], { platform, env, existsSync });
    return inPath ? classifyExec(inPath, platform) : null;
  }

  const linuxHit = findInSystemPath(['idea', 'intellij-idea-ultimate', 'intellij-idea-community'], {
    platform,
    env,
    existsSync,
  });
  return linuxHit ? { kind: 'binary', path: linuxHit } : null;
}

function resolveVsCodeLikeEditor({
  platform,
  env,
  homedir,
  existsSync,
  macBundles,
  macBinSubpath,
  winRelCandidates,
  pathNames,
}) {
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'darwin') {
    for (const appName of macBundles) {
      for (const root of ['/Applications', homedir ? pathMod.join(homedir, 'Applications') : ''].filter(Boolean)) {
        const cli = pathMod.join(root, appName, ...macBinSubpath);
        if (existsSync(cli)) return { kind: 'binary', path: cli };
      }
    }
    const inPath = findInSystemPath(pathNames, { platform, env, existsSync });
    return inPath ? { kind: 'binary', path: inPath } : null;
  }

  if (platform === 'win32') {
    const { localAppData, progFiles, progFilesX86 } = resolveWinEnvDirs(env, homedir);
    const roots = [localAppData, progFiles, progFilesX86].filter(Boolean);
    for (const r of roots) {
      for (const rel of winRelCandidates) {
        const candidate = pathMod.join(r, ...rel);
        if (existsSync(candidate)) return classifyExec(candidate, platform);
      }
    }
    const inPath = findInSystemPath(pathNames, { platform, env, existsSync });
    return inPath ? classifyExec(inPath, platform) : null;
  }

  const inPath = findInSystemPath(pathNames, { platform, env, existsSync });
  return inPath ? { kind: 'binary', path: inPath } : null;
}

function resolveNotepadMinusEditor({ platform, env, homedir, existsSync, customPath }) {
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  if (customPath) {
    const trimmed = String(customPath).trim();
    if (platform === 'darwin' && trimmed.endsWith('.app') && existsSync(trimmed)) {
      return { kind: 'mac-app', path: trimmed };
    }
    if (existsSync(trimmed)) return classifyExec(trimmed, platform);
  }

  if (platform === 'darwin') {
    const appHit = firstExisting(
      [
        '/Applications/Notepad--.app',
        homedir ? pathMod.join(homedir, 'Applications', 'Notepad--.app') : '',
      ],
      existsSync
    );
    if (appHit) return { kind: 'mac-app', path: appHit };
    const inPath = findInSystemPath(['Notepad--', 'notepad--', 'ndd'], { platform, env, existsSync });
    return inPath ? { kind: 'binary', path: inPath } : null;
  }

  if (platform === 'win32') {
    const { localAppData, progFiles, progFilesX86 } = resolveWinEnvDirs(env, homedir);
    const hit = firstExisting(
      [
        pathMod.join(progFiles, 'Notepad--', 'Notepad--.exe'),
        pathMod.join(progFilesX86, 'Notepad--', 'Notepad--.exe'),
        localAppData ? pathMod.join(localAppData, 'Programs', 'Notepad--', 'Notepad--.exe') : '',
        localAppData ? pathMod.join(localAppData, 'Notepad--', 'Notepad--.exe') : '',
        'D:\\Program Files\\Notepad--\\Notepad--.exe',
        'C:\\Notepad--\\Notepad--.exe',
      ],
      existsSync
    );
    if (hit) return { kind: 'binary', path: hit };
    const inPath = findInSystemPath(['Notepad--.exe', 'ndd.exe'], { platform, env, existsSync });
    return inPath ? classifyExec(inPath, platform) : null;
  }

  const inPath = findInSystemPath(['Notepad--', 'notepad--', 'ndd'], { platform, env, existsSync });
  return inPath ? { kind: 'binary', path: inPath } : null;
}

function resolveNotepadPlusEditor({ platform, env, homedir, existsSync }) {
  if (platform !== 'win32') return null;
  const pathMod = path.win32;
  const { localAppData, progFiles, progFilesX86 } = resolveWinEnvDirs(env, homedir);
  const hit = firstExisting(
    [
      pathMod.join(progFiles, 'Notepad++', 'notepad++.exe'),
      pathMod.join(progFilesX86, 'Notepad++', 'notepad++.exe'),
      localAppData ? pathMod.join(localAppData, 'Programs', 'Notepad++', 'notepad++.exe') : '',
      'D:\\Program Files\\Notepad++\\notepad++.exe',
      'D:\\Notepad++\\notepad++.exe',
    ],
    existsSync
  );
  if (hit) return { kind: 'binary', path: hit };
  const inPath = findInSystemPath(['notepad++.exe'], { platform, env, existsSync });
  return inPath ? classifyExec(inPath, platform) : null;
}

function resolveSublimeEditor({ platform, env, homedir, existsSync }) {
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'darwin') {
    const sublCli = firstExisting(
      [
        '/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl',
        homedir
          ? pathMod.join(homedir, 'Applications', 'Sublime Text.app', 'Contents', 'SharedSupport', 'bin', 'subl')
          : '',
      ],
      existsSync
    );
    if (sublCli) return { kind: 'binary', path: sublCli };
    const inPath = findInSystemPath(['subl'], { platform, env, existsSync });
    if (inPath) return { kind: 'binary', path: inPath };
    const appHit = firstExisting(
      [
        '/Applications/Sublime Text.app',
        homedir ? pathMod.join(homedir, 'Applications', 'Sublime Text.app') : '',
      ],
      existsSync
    );
    return appHit ? { kind: 'mac-app', path: appHit } : null;
  }

  if (platform === 'win32') {
    const { localAppData, progFiles, progFilesX86 } = resolveWinEnvDirs(env, homedir);
    const hit = firstExisting(
      [
        pathMod.join(progFiles, 'Sublime Text', 'subl.exe'),
        pathMod.join(progFiles, 'Sublime Text', 'sublime_text.exe'),
        pathMod.join(progFiles, 'Sublime Text 3', 'subl.exe'),
        pathMod.join(progFilesX86, 'Sublime Text', 'subl.exe'),
        localAppData ? pathMod.join(localAppData, 'Programs', 'Sublime Text', 'subl.exe') : '',
      ],
      existsSync
    );
    if (hit) return { kind: 'binary', path: hit };
    const inPath = findInSystemPath(['subl.exe', 'sublime_text.exe'], { platform, env, existsSync });
    return inPath ? classifyExec(inPath, platform) : null;
  }

  const inPath = findInSystemPath(['subl', 'sublime_text'], { platform, env, existsSync });
  return inPath ? { kind: 'binary', path: inPath } : null;
}

function resolveZedEditor({ platform, env, homedir, existsSync }) {
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'darwin') {
    const cli = firstExisting(
      [
        '/Applications/Zed.app/Contents/MacOS/cli',
        homedir ? pathMod.join(homedir, 'Applications', 'Zed.app', 'Contents', 'MacOS', 'cli') : '',
      ],
      existsSync
    );
    if (cli) return { kind: 'binary', path: cli };
    const inPath = findInSystemPath(['zed'], { platform, env, existsSync });
    if (inPath) return { kind: 'binary', path: inPath };
    const appHit = firstExisting(
      ['/Applications/Zed.app', homedir ? pathMod.join(homedir, 'Applications', 'Zed.app') : ''],
      existsSync
    );
    return appHit ? { kind: 'mac-app', path: appHit } : null;
  }

  if (platform === 'win32') {
    const { localAppData, progFiles } = resolveWinEnvDirs(env, homedir);
    const hit = firstExisting(
      [
        localAppData ? pathMod.join(localAppData, 'Programs', 'Zed', 'bin', 'zed.exe') : '',
        localAppData ? pathMod.join(localAppData, 'Programs', 'Zed', 'Zed.exe') : '',
        pathMod.join(progFiles, 'Zed', 'bin', 'zed.exe'),
      ],
      existsSync
    );
    if (hit) return { kind: 'binary', path: hit };
    const inPath = findInSystemPath(['zed.exe'], { platform, env, existsSync });
    return inPath ? classifyExec(inPath, platform) : null;
  }

  const inPath = findInSystemPath(['zed', 'zeditor'], { platform, env, existsSync });
  return inPath ? { kind: 'binary', path: inPath } : null;
}

function resolveSystemBuiltinTextEditor({ platform, env, homedir, existsSync }) {
  if (platform === 'win32') {
    const { sysRoot } = resolveWinEnvDirs(env, homedir);
    const notepadExe = path.win32.join(sysRoot, 'System32', 'notepad.exe');
    return {
      kind: 'binary',
      path: existsSync(notepadExe) ? notepadExe : 'notepad.exe',
      label: '记事本',
      menuLabel: '在记事本中打开',
    };
  }
  if (platform === 'darwin') {
    const textEdit = firstExisting(
      ['/System/Applications/TextEdit.app', '/Applications/TextEdit.app'],
      existsSync
    );
    if (textEdit) {
      return {
        kind: 'mac-app',
        path: textEdit,
        label: '文本编辑',
        menuLabel: '在文本编辑中打开',
      };
    }
    return null;
  }
  const linuxEditor = findInSystemPath(['gedit', 'kate', 'mousepad', 'xed'], {
    platform,
    env,
    existsSync,
  });
  return linuxEditor
    ? { kind: 'binary', path: linuxEditor, label: '文本编辑器', menuLabel: '在文本编辑器中打开' }
    : null;
}

/**
 * 动态探测本机已安装的文本/代码编辑器，并在末尾附上系统自带记事本/文本编辑保底项。
 */
export function detectExternalEditors({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
  customIdeaPath = '',
  customNotepadPath = '',
} = {}) {
  const byMode = Object.create(null);
  const options = [];
  const registerMode = (entry) => {
    byMode[entry.id] = entry;
    options.push({
      id: entry.id,
      label: entry.label,
      menuLabel: entry.menuLabel,
      supportsLine: Boolean(entry.supportsLine),
      supportsDirectory: Boolean(entry.supportsDirectory),
    });
  };

  const idea = resolveIdeaEditor({
    platform,
    env,
    homedir,
    existsSync,
    readdirSync,
    customPath: customIdeaPath,
  });
  if (idea) {
    registerMode({
      id: 'idea-project',
      label: 'IDEA（项目）',
      menuLabel: '在 IDEA 项目中打开',
      supportsLine: true,
      supportsDirectory: true,
      argStyle: 'idea-project',
      ...idea,
    });
    registerMode({
      id: 'idea-light',
      label: 'IDEA（轻量框）',
      menuLabel: '在 IDEA 轻量框打开',
      // IDEA LightEdit (-e) 官方实现直接调用 LightEditService.openFile(virtualFile)，不支持 --line 跳转
      supportsLine: false,
      supportsDirectory: false,
      argStyle: 'idea-light',
      ...idea,
    });
  }

  const vscode = resolveVsCodeLikeEditor({
    platform,
    env,
    homedir,
    existsSync,
    macBundles: ['Visual Studio Code.app', 'Visual Studio Code - Insiders.app'],
    macBinSubpath: ['Contents', 'Resources', 'app', 'bin', 'code'],
    winRelCandidates: [
      ['Programs', 'Microsoft VS Code', 'Code.exe'],
      ['Microsoft VS Code', 'Code.exe'],
      ['Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'],
    ],
    pathNames: platform === 'win32' ? ['Code.exe', 'code.cmd', 'code.bat'] : ['code', 'code-insiders'],
  });
  if (vscode) {
    registerMode({
      id: 'vscode',
      label: 'VS Code',
      menuLabel: '在 VS Code 中打开',
      supportsLine: true,
      supportsDirectory: true,
      argStyle: 'vscode-goto',
      ...vscode,
    });
  }

  const cursor = resolveVsCodeLikeEditor({
    platform,
    env,
    homedir,
    existsSync,
    macBundles: ['Cursor.app'],
    macBinSubpath: ['Contents', 'Resources', 'app', 'bin', 'cursor'],
    winRelCandidates: [
      ['Programs', 'cursor', 'Cursor.exe'],
      ['Programs', 'Cursor', 'Cursor.exe'],
      ['Cursor', 'Cursor.exe'],
    ],
    pathNames: platform === 'win32' ? ['Cursor.exe', 'cursor.cmd', 'cursor.bat'] : ['cursor'],
  });
  if (cursor) {
    registerMode({
      id: 'cursor',
      label: 'Cursor',
      menuLabel: '在 Cursor 中打开',
      supportsLine: true,
      supportsDirectory: true,
      argStyle: 'vscode-goto',
      ...cursor,
    });
  }

  const notepadMinus = resolveNotepadMinusEditor({
    platform,
    env,
    homedir,
    existsSync,
    customPath: customNotepadPath,
  });
  if (notepadMinus) {
    registerMode({
      id: 'notepad--',
      label: 'Notepad--',
      menuLabel: '在 Notepad-- 中打开',
      supportsLine: false,
      supportsDirectory: false,
      argStyle: 'plain',
      ...notepadMinus,
    });
  }

  const notepadPlus = resolveNotepadPlusEditor({ platform, env, homedir, existsSync });
  if (notepadPlus) {
    registerMode({
      id: 'notepad++',
      label: 'Notepad++',
      menuLabel: '在 Notepad++ 中打开',
      supportsLine: true,
      supportsDirectory: false,
      argStyle: 'npp',
      ...notepadPlus,
    });
  }

  const sublime = resolveSublimeEditor({ platform, env, homedir, existsSync });
  if (sublime) {
    registerMode({
      id: 'sublime',
      label: 'Sublime Text',
      menuLabel: '在 Sublime Text 中打开',
      supportsLine: sublime.kind !== 'mac-app',
      supportsDirectory: true,
      argStyle: 'colon-loc',
      ...sublime,
    });
  }

  const zed = resolveZedEditor({ platform, env, homedir, existsSync });
  if (zed) {
    registerMode({
      id: 'zed',
      label: 'Zed',
      menuLabel: '在 Zed 中打开',
      supportsLine: zed.kind !== 'mac-app',
      supportsDirectory: true,
      argStyle: 'colon-loc',
      ...zed,
    });
  }

  const systemText = resolveSystemBuiltinTextEditor({ platform, env, homedir, existsSync });
  if (systemText) {
    registerMode({
      id: 'system-text',
      label: systemText.label,
      menuLabel: systemText.menuLabel,
      supportsLine: false,
      supportsDirectory: false,
      argStyle: 'plain',
      kind: systemText.kind,
      path: systemText.path,
    });
  }

  return {
    platform,
    byMode,
    options,
  };
}

function quoteWinCmdArg(arg) {
  const str = String(arg ?? '');
  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * 构造不同外部编辑器模式的纯参数启动描述，杜绝 Shell 注入风险。
 */
export function buildEditorLaunchSpec({
  mode,
  editorInfo,
  target,
  projectRoot = null,
  platform = process.platform,
  comSpec = process.env.ComSpec || 'cmd.exe',
} = {}) {
  if (!editorInfo?.path || !target?.filePath) return null;

  if (editorInfo.kind === 'mac-app') {
    return {
      command: '/usr/bin/open',
      args: ['-a', editorInfo.path, target.filePath],
      windowsVerbatimArguments: false,
      windowsHide: false,
    };
  }

  const hasLine = !target.isDirectory && Number.isInteger(target.line) && target.line > 0;
  const hasCol = hasLine && Number.isInteger(target.column) && target.column > 0;
  const style =
    editorInfo.argStyle ||
    (mode === 'idea-project'
      ? 'idea-project'
      : mode === 'idea-light'
        ? 'idea-light'
        : mode === 'vscode' || mode === 'cursor'
          ? 'vscode-goto'
          : mode === 'notepad++'
            ? 'npp'
            : mode === 'sublime' || mode === 'zed'
              ? 'colon-loc'
              : 'plain');

  let rawArgs = [];
  if (style === 'idea-project') {
    const lineArgs = hasLine
      ? ['--line', String(target.line), ...(hasCol ? ['--column', String(target.column)] : [])]
      : [];
    if (target.isDirectory) {
      rawArgs = [target.filePath];
    } else if (projectRoot) {
      rawArgs = [projectRoot, ...lineArgs, target.filePath];
    } else {
      rawArgs = [...lineArgs, target.filePath];
    }
  } else if (style === 'idea-light') {
    rawArgs = target.isDirectory ? [target.filePath] : ['-e', target.filePath];
  } else if (style === 'vscode-goto') {
    if (hasLine) {
      rawArgs = ['-g', `${target.filePath}:${target.line}${hasCol ? `:${target.column}` : ''}`];
    } else {
      rawArgs = [target.filePath];
    }
  } else if (style === 'npp') {
    if (hasLine) {
      rawArgs = [`-n${target.line}`, ...(hasCol ? [`-c${target.column}`] : []), target.filePath];
    } else {
      rawArgs = [target.filePath];
    }
  } else if (style === 'colon-loc') {
    if (hasLine) {
      rawArgs = [`${target.filePath}:${target.line}${hasCol ? `:${target.column}` : ''}`];
    } else {
      rawArgs = [target.filePath];
    }
  } else {
    rawArgs = [target.filePath];
  }

  if (platform === 'win32' && editorInfo.kind === 'cmd') {
    const inner = [quoteWinCmdArg(editorInfo.path), ...rawArgs.map(quoteWinCmdArg)].join(' ');
    return {
      command: comSpec,
      args: ['/d', '/s', '/c', `"${inner}"`],
      windowsVerbatimArguments: true,
      windowsHide: true,
    };
  }

  return {
    command: editorInfo.path,
    args: rawArgs,
    windowsVerbatimArguments: false,
    windowsHide: false,
  };
}

/**
 * 构造在系统文件管理器（Finder / Explorer）中定位文件的启动描述。
 */
export function buildRevealInFileManagerSpec(filePath, platform = process.platform) {
  if (!filePath) return null;
  if (platform === 'darwin') {
    return { command: '/usr/bin/open', args: ['-R', filePath] };
  }
  if (platform === 'win32') {
    return { command: 'explorer.exe', args: [`/select,${filePath}`] };
  }
  return { command: 'xdg-open', args: [path.posix.dirname(filePath)] };
}

function spawnDetachedSpec(spec, spawnFn = spawn) {
  return new Promise((resolve) => {
    try {
      const child = spawnFn(spec.command, spec.args, {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: Boolean(spec.windowsVerbatimArguments),
        windowsHide: Boolean(spec.windowsHide),
      });
      let settled = false;
      child.once('error', (err) => {
        if (!settled) {
          settled = true;
          resolve({ ok: false, error: err?.message || String(err) });
        }
      });
      child.once('spawn', () => {
        try {
          child.unref?.();
        } catch {}
        if (!settled) {
          settled = true;
          resolve({ ok: true });
        }
      });
      setImmediate(() => {
        if (!settled) {
          try {
            child.unref?.();
          } catch {}
          settled = true;
          resolve({ ok: true });
        }
      });
    } catch (err) {
      resolve({ ok: false, error: err?.message || String(err) });
    }
  });
}

/**
 * 执行本地文件外部打开或系统文件管理器定位动作。
 */
export async function executeExternalFileAction(
  {
    action = 'open',
    mode = 'idea-project',
    uri = '',
    line = null,
    column = null,
    customIdeaPath = '',
    customNotepadPath = '',
  } = {},
  deps = {}
) {
  const platform = deps.platform || process.platform;
  const parsed = parseLocalFileTarget(uri, {
    line,
    column,
    platform,
    statSync: deps.statSync,
  });
  if (!parsed.ok) {
    return parsed;
  }

  if (action === 'reveal') {
    const spec = buildRevealInFileManagerSpec(parsed.filePath, platform);
    if (!spec) return { ok: false, error: '当前系统不支持定位文件' };
    return spawnDetachedSpec(spec, deps.spawnFn);
  }

  const editors =
    deps.editors ||
    detectExternalEditors({
      platform,
      env: deps.env,
      homedir: deps.homedir,
      existsSync: deps.existsSync,
      readdirSync: deps.readdirSync,
      customIdeaPath,
      customNotepadPath,
    });

  const cleanMode = String(mode || '').trim().toLowerCase();
  const editorInfo = editors?.byMode?.[cleanMode] || null;
  if (!editorInfo) {
    return { ok: false, error: '未在本机检测到所选软件' };
  }
  if (parsed.isDirectory && !editorInfo.supportsDirectory) {
    return { ok: false, error: `${editorInfo.label} 不支持直接打开文件夹` };
  }

  const projectRoot =
    cleanMode === 'idea-project' && !parsed.isDirectory
      ? findProjectRootForFile(parsed.filePath, {
          isDirectory: parsed.isDirectory,
          platform,
          homedir: deps.homedir,
          existsSync: deps.existsSync,
        })
      : null;

  const spec = buildEditorLaunchSpec({
    mode: cleanMode,
    editorInfo,
    target: parsed,
    projectRoot,
    platform,
  });
  if (!spec) {
    return { ok: false, error: '不支持的打开方式' };
  }

  return spawnDetachedSpec(spec, deps.spawnFn);
}
