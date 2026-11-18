import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';

const MAX_LOG_BYTES = 1024 * 1024;

export function getDefaultLogDir({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
} = {}) {
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Logs', 'Antigravity Quota Injector');
  }
  if (platform === 'win32') {
    const localAppData = env?.LOCALAPPDATA || path.win32.join(homedir, 'AppData', 'Local');
    return path.win32.join(localAppData, 'Antigravity Quota Injector', 'Logs');
  }
  return path.join(homedir, '.gemini', 'antigravity', 'quota-injector');
}

export function getDefaultLogPath(opts = {}) {
  const dir = getDefaultLogDir(opts);
  return (opts.platform || process.platform) === 'win32'
    ? path.win32.join(dir, 'injector.log')
    : path.join(dir, 'injector.log');
}

export function installFileLogger(logPath = getDefaultLogPath()) {
  const dir = path.dirname(logPath);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const st = fs.statSync(logPath, { throwIfNoEntry: false });
    if (st && st.size > MAX_LOG_BYTES) {
      const oldPath = `${logPath}.old`;
      try {
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      } catch {}
      fs.renameSync(logPath, oldPath);
    }
  } catch {}

  const writeLine = (level, args) => {
    const text = util.format(...args);
    const line = `[${new Date().toISOString()}] [${level}] ${text}\n`;
    try {
      fs.appendFileSync(logPath, line, 'utf8');
    } catch {}
  };

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args) => {
    writeLine('INFO', args);
    try {
      origLog(...args);
    } catch {}
  };
  console.warn = (...args) => {
    writeLine('WARN', args);
    try {
      origWarn(...args);
    } catch {}
  };
  console.error = (...args) => {
    writeLine('ERROR', args);
    try {
      origError(...args);
    } catch {}
  };

  return logPath;
}
