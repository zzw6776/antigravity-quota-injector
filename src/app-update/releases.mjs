import { compareVersions } from '../single-instance.mjs';

export const GITHUB_REPOSITORY = 'zzw6776/antigravity-quota-injector';
export const UPDATE_MANIFEST_URL = `https://github.com/${GITHUB_REPOSITORY}/releases/latest/download/update.json`;
export const RELEASES_URL = `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases?per_page=100`;
export const RELEASES_PAGE_URL = `https://github.com/${GITHUB_REPOSITORY}/releases`;
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const VERSION_RE = /^v?(\d+\.\d+\.\d+)$/;
const DIGEST_RE = /^sha256:([a-f0-9]{64})$/i;
const RELEASES_PATH = `/repos/${GITHUB_REPOSITORY}/releases`;

export function expectedAssetSuffix(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return `macos-${arch}.dmg`;
  }
  if (platform === 'win32' && arch === 'x64') {
    return 'windows-x64-Setup.exe';
  }
  return null;
}

export function releaseUpdate(
  release,
  { version, mode = 'formal', platform = process.platform, arch = process.arch } = {},
  releases = [release]
) {
  const remote = VERSION_RE.exec(String(release?.tag_name ?? ''))?.[1];
  if (!remote || release.draft || release.prerelease) return null;
  if (compareVersions(remote, version) <= 0) return null;

  const suffix = expectedAssetSuffix(platform, arch);
  if (!suffix) return null;

  const name = `Antigravity-Quota-Injector-${remote}-${suffix}`;
  const asset = release.assets?.find((item) => item.name === name && item.state === 'uploaded');
  if (
    !asset ||
    !Number.isInteger(asset.id) ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > 1024 ** 3
  ) {
    return null;
  }

  let url;
  try {
    url = new URL(asset.browser_download_url);
  } catch {
    return null;
  }
  if (
    url.origin !== 'https://github.com' ||
    url.pathname !== `/${GITHUB_REPOSITORY}/releases/download/${release.tag_name}/${name}`
  ) {
    return null;
  }

  return {
    version: remote,
    tagName: `v${remote}`,
    assetId: asset.id,
    name,
    size: asset.size,
    url: url.href,
    releasePageUrl: `https://github.com/${GITHUB_REPOSITORY}/releases/tag/${release.tag_name}`,
    releaseNotes: combinedReleaseNotes(release, releases, version, remote),
    sha256: DIGEST_RE.exec(String(asset.digest ?? ''))?.[1]?.toLowerCase() ?? null,
    platform,
    arch,
    mode,
  };
}

export async function fetchRelease({ fetchImpl = fetch, etag = null } = {}) {
  const manifestResponse = await fetchImpl(UPDATE_MANIFEST_URL, requestOptions(etag));
  if (manifestResponse.status === 304) return { unchanged: true, etag };
  if (manifestResponse.status !== 404) {
    if (!manifestResponse.ok) {
      throw new Error(`GitHub 更新检查失败（HTTP ${manifestResponse.status}）`);
    }
    const manifest = await manifestResponse.json();
    if (
      manifest?.schemaVersion !== 1 ||
      !VERSION_RE.test(String(manifest.version ?? '')) ||
      !Array.isArray(manifest.releases)
    ) {
      throw new Error('GitHub 更新清单格式无效');
    }
    const release = manifest.releases.find(
      (item) => VERSION_RE.test(String(item?.tag_name ?? '')) && !item.draft && !item.prerelease
    );
    if (!release || VERSION_RE.exec(String(release.tag_name))?.[1] !== manifest.version) {
      throw new Error('GitHub 更新清单版本无效');
    }
    return { release, releases: manifest.releases, etag: manifestResponse.headers.get('etag') };
  }
  return fetchLegacyReleases({ fetchImpl, etag });
}

async function fetchLegacyReleases({ fetchImpl, etag }) {
  const releases = [];
  let url = RELEASES_URL;
  let first = true;
  let nextEtag = null;
  while (url) {
    const response = await fetchImpl(url, requestOptions(first ? etag : null));
    if (first && response.status === 304) return { unchanged: true, etag };
    if (!response.ok) {
      throw new Error(`GitHub 更新检查失败（HTTP ${response.status}）`);
    }
    const page = await response.json();
    if (!Array.isArray(page)) {
      throw new Error('GitHub 更新检查返回了无效的发布列表');
    }
    if (first) nextEtag = response.headers.get('etag');
    releases.push(...page);
    url = nextReleasePage(response.headers.get('link'));
    first = false;
  }
  const release = releases.find(
    (item) => VERSION_RE.test(String(item?.tag_name ?? '')) && !item.draft && !item.prerelease
  );
  return { release, releases, etag: nextEtag };
}

function requestOptions(etag) {
  return {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'antigravity-quota-injector',
      ...(etag ? { 'If-None-Match': etag } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  };
}

function combinedReleaseNotes(release, releases, currentVersion, targetVersion) {
  const seen = new Set();
  const selected = [];
  for (const item of [release, ...(Array.isArray(releases) ? releases : [])]) {
    const version = VERSION_RE.exec(String(item?.tag_name ?? ''))?.[1];
    if (!version || item.draft || item.prerelease || seen.has(version)) continue;
    if (compareVersions(version, currentVersion) <= 0 || compareVersions(version, targetVersion) > 0) {
      continue;
    }
    seen.add(version);
    selected.push({ version, body: typeof item.body === 'string' ? item.body.trim() : '' });
  }
  selected.sort((left, right) => compareVersions(right.version, left.version));
  if (selected.length === 1 && !selected[0].body) return '';
  return selected
    .map((item) => item.body || `# ${item.version}\n\n该版本暂无更新日志`)
    .join('\n\n');
}

function nextReleasePage(link) {
  const part = String(link ?? '')
    .split(',')
    .find((item) => /;\s*rel="next"\s*$/.test(item));
  const href = /^\s*<([^>]+)>/.exec(part ?? '')?.[1];
  if (!href) return null;
  const url = new URL(href);
  if (url.origin !== 'https://api.github.com' || url.pathname !== RELEASES_PATH) {
    throw new Error('GitHub 更新检查返回了无效的分页地址');
  }
  return url.href;
}
