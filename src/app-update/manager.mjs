import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { downloadUpdate, verifyExistingDownload } from './download.mjs';
import {
  applySelfUpdateAndRelaunch,
  prepareUpdateArtifact,
  resolveInstalledAppPath,
} from './install.mjs';
import {
  RELEASES_PAGE_URL,
  UPDATE_CHECK_INTERVAL_MS,
  fetchRelease,
  releaseUpdate,
} from './releases.mjs';

export function getDefaultAppDataDir({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
} = {}) {
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', 'Antigravity Quota Injector');
  }
  if (platform === 'win32') {
    const localAppData = env?.LOCALAPPDATA || path.win32.join(homedir, 'AppData', 'Local');
    return path.win32.join(localAppData, 'Antigravity Quota Injector');
  }
  return path.join(homedir, '.gemini', 'antigravity', 'quota-injector');
}

export function openExternalUrl(url, platform = process.platform) {
  if (!/^https:\/\//i.test(String(url || ''))) return;
  if (platform === 'darwin') {
    execFile('/usr/bin/open', [url], () => {});
    return;
  }
  if (platform === 'win32') {
    const child = spawn('cmd.exe', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return;
  }
  const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

export function createUpdateManager({
  version,
  mode = 'dev',
  platform = process.platform,
  arch = process.arch,
  dataDir = getDefaultAppDataDir({ platform }),
  installedApp = resolveInstalledAppPath({ platform }),
  onBeforeExit = async () => {},
  onStateChange = () => {},
  fetchReleaseImpl = fetchRelease,
  downloadImpl = downloadUpdate,
  prepareImpl = prepareUpdateArtifact,
  applyImpl = applySelfUpdateAndRelaunch,
  checkIntervalMs = UPDATE_CHECK_INTERVAL_MS,
  initialDelayMs = 0,
} = {}) {
  const updatesDir = path.join(dataDir, 'updates');
  const canAutoUpdate = mode === 'formal' && Boolean(installedApp);

  let etag = null;
  let activeAsset = null;
  let checkPromise = null;
  let downloadPromise = null;
  let installPromise = null;
  let openPromise = null;
  let lastCheckOk = false;
  let initialTimer = null;
  let intervalTimer = null;
  let stopped = false;

  let state = {
    currentVersion: version,
    mode,
    enabled: true,
    canAutoUpdate,
    available: false,
    opening: false,
    requestId: null,
    status: 'idle',
    latestVersion: '',
    releaseNotes: '',
    releaseUrl: RELEASES_PAGE_URL,
    received: 0,
    total: 0,
    downloadedPath: '',
    checkError: '',
    error: '',
    checkedAt: '',
  };

  const publish = (patch) => {
    state = { ...state, ...patch };
    try {
      onStateChange(getSnapshot());
    } catch {}
  };

  const getSnapshot = () => ({ ...state });

  const startBackgroundDownload = async (asset) => {
    if (!asset || !canAutoUpdate) return null;
    if (downloadPromise) return downloadPromise;

    const destPath = path.join(updatesDir, asset.name);

    downloadPromise = (async () => {
      try {
        const already = await verifyExistingDownload(asset, destPath);
        if (already) {
          publish({
            status: 'ready',
            received: asset.size,
            total: asset.size,
            downloadedPath: destPath,
            error: '',
          });
          return destPath;
        }
        publish({
          status: 'downloading',
          received: 0,
          total: asset.size,
          downloadedPath: '',
          error: '',
        });
        await downloadImpl(asset, destPath, {
          onProgress: (received, total) => {
            if (state.status === 'downloading') {
              publish({ received, total });
            }
          },
        });
        publish({
          status: 'ready',
          received: asset.size,
          total: asset.size,
          downloadedPath: destPath,
          error: '',
        });
        return destPath;
      } catch (err) {
        publish({
          status: 'error',
          available: Boolean(activeAsset),
          error: String(err?.message || '下载更新失败'),
        });
        return null;
      } finally {
        downloadPromise = null;
      }
    })();

    return downloadPromise;
  };

  const checkNow = async ({ manual = false } = {}) => {
    if (stopped) return getSnapshot();
    if (state.status === 'installing') return getSnapshot();
    if (checkPromise) return checkPromise;

    checkPromise = (async () => {
      if (manual || state.status === 'idle' || state.status === 'error' || state.status === 'up-to-date') {
        publish({ status: 'checking', checkError: '', ...(manual ? { error: '' } : {}) });
      }
      try {
        const res = await fetchReleaseImpl({ etag: manual ? null : etag });
        if (stopped) return getSnapshot();
        if (res.etag) etag = res.etag;
        if (res.unchanged) {
          lastCheckOk = true;
          if (activeAsset) {
            publish({
              status: state.downloadedPath ? 'ready' : 'available',
              available: true,
              checkError: '',
              error: '',
              checkedAt: new Date().toISOString(),
            });
          } else {
            publish({
              status: 'up-to-date',
              available: false,
              checkError: '',
              error: '',
              checkedAt: new Date().toISOString(),
            });
          }
          return getSnapshot();
        }

        const candidate = res.release
          ? releaseUpdate(res.release, { version, mode, platform, arch }, res.releases)
          : null;

        lastCheckOk = true;
        if (!candidate) {
          activeAsset = null;
          publish({
            status: 'up-to-date',
            available: false,
            latestVersion: '',
            releaseNotes: '',
            releaseUrl: RELEASES_PAGE_URL,
            received: 0,
            total: 0,
            downloadedPath: '',
            checkError: '',
            error: '',
            checkedAt: new Date().toISOString(),
          });
          return getSnapshot();
        }

        const isNewAsset =
          !activeAsset ||
          activeAsset.version !== candidate.version ||
          activeAsset.assetId !== candidate.assetId;
        activeAsset = candidate;

        publish({
          status: !isNewAsset && state.downloadedPath ? 'ready' : 'available',
          available: true,
          latestVersion: candidate.version,
          releaseNotes: candidate.releaseNotes || '',
          releaseUrl: candidate.releasePageUrl || RELEASES_PAGE_URL,
          total: candidate.size,
          received: !isNewAsset && state.downloadedPath ? candidate.size : 0,
          downloadedPath: !isNewAsset ? state.downloadedPath : '',
          checkError: '',
          error: '',
          checkedAt: new Date().toISOString(),
        });

        if (canAutoUpdate && (isNewAsset || !state.downloadedPath)) {
          void startBackgroundDownload(candidate);
        }
        return getSnapshot();
      } catch (err) {
        lastCheckOk = false;
        const msg = String(err?.message || '检查更新失败');
        if (activeAsset) {
          publish({
            status: state.downloadedPath ? 'ready' : 'available',
            available: true,
            checkError: msg,
            ...(manual ? { error: msg } : {}),
            checkedAt: new Date().toISOString(),
          });
        } else {
          publish({
            status: manual ? 'error' : 'idle',
            available: false,
            checkError: msg,
            ...(manual ? { error: msg } : {}),
            checkedAt: new Date().toISOString(),
          });
        }
        return getSnapshot();
      } finally {
        checkPromise = null;
      }
    })();

    return checkPromise;
  };

  const installUpdate = async () => {
    if (stopped) return getSnapshot();
    if (installPromise) return installPromise;

    if (!canAutoUpdate) {
      openExternalUrl(state.releaseUrl || RELEASES_PAGE_URL, platform);
      return getSnapshot();
    }

    installPromise = (async () => {
      try {
        if (!activeAsset) {
          await checkNow({ manual: true });
        }
        const asset = activeAsset;
        if (!asset) {
          return getSnapshot();
        }

        let downloadPath = state.downloadedPath;
        if (!downloadPath || !(await verifyExistingDownload(asset, downloadPath))) {
          downloadPath = await startBackgroundDownload(asset);
        }
        if (!downloadPath || !fs.existsSync(downloadPath)) {
          throw new Error(state.error || '更新包下载失败');
        }

        publish({ status: 'installing', error: '' });
        const prepared = await prepareImpl({
          asset,
          downloadPath,
          installedApp,
          updatesDir,
        });
        await applyImpl({
          asset,
          installedApp,
          prepared,
          updatesDir,
          onBeforeExit,
        });
      } catch (err) {
        publish({
          status: 'error',
          available: Boolean(activeAsset),
          error: String(err?.message || '安装更新失败'),
        });
      } finally {
        installPromise = null;
      }
      return getSnapshot();
    })();

    return installPromise;
  };

  const openUpdate = async ({ requestId = null } = {}) => {
    if (stopped || state.status === 'installing') return getSnapshot();
    if (openPromise) return openPromise;

    publish({ error: '', opening: true, requestId: requestId ?? null });
    openPromise = (async () => {
      try {
        // A click must start its own live check after any earlier background check settles.
        if (checkPromise) await checkPromise;
        await checkNow({ manual: false });
        if (!lastCheckOk) {
          throw new Error(state.checkError || '无法确认远端最新版本，请重试');
        }
        if (activeAsset) {
          if (!canAutoUpdate) {
            openExternalUrl(state.releaseUrl || RELEASES_PAGE_URL, platform);
          } else {
            await installUpdate();
          }
        }
      } catch (err) {
        publish({
          error: String(err?.message || '检查更新失败'),
        });
      } finally {
        openPromise = null;
        publish({ opening: false });
      }
      return getSnapshot();
    })();

    return openPromise;
  };

  const start = () => {
    if (stopped) return;
    if (initialTimer || intervalTimer) return;
    if (initialDelayMs <= 0) {
      void checkNow({ manual: false });
    } else {
      initialTimer = setTimeout(() => {
        initialTimer = null;
        void checkNow({ manual: false });
      }, initialDelayMs);
      initialTimer.unref?.();
    }

    intervalTimer = setInterval(() => {
      void checkNow({ manual: false });
    }, checkIntervalMs);
    intervalTimer.unref?.();
  };

  const stop = () => {
    stopped = true;
    if (initialTimer) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  };

  return {
    getState: getSnapshot,
    start,
    stop,
    checkNow,
    openUpdate,
    installUpdate,
    openReleasePage: () => openExternalUrl(state.releaseUrl || RELEASES_PAGE_URL, platform),
  };
}
