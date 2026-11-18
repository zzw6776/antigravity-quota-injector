import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const VERSION_RE = /^v?(\d+\.\d+\.\d+)$/;
const options = parseArguments(process.argv.slice(2));
const repository = required(options.repository, '--repository');
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error('Invalid GitHub repository');
}
const assetsDirectory = resolve(required(options.assets, '--assets'));
const output = resolve(required(options.output, '--output'));
const token = required(process.env.GITHUB_TOKEN, 'GITHUB_TOKEN');
const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
const version = String(packageJson.version ?? '');
if (!VERSION_RE.test(version)) throw new Error('Invalid package version');
const tag = `v${version}`;
const body = await readFile(resolve('docs', 'releases', `${version}.md`), 'utf8');
const expectedNames = [
  `Antigravity-Quota-Injector-${version}-macos-arm64.dmg`,
  `Antigravity-Quota-Injector-${version}-macos-x64.dmg`,
  `Antigravity-Quota-Injector-${version}-windows-x64-Setup.exe`,
];

const assets = [];
for (const name of expectedNames) {
  const assetPath = join(assetsDirectory, name);
  const info = await stat(assetPath);
  if (!info.isFile() || info.size <= 0 || info.size > 1024 ** 3) {
    throw new Error(`Invalid release asset: ${name}`);
  }
  const sha256 = await hashFile(assetPath);
  assets.push({
    id: Number.parseInt(sha256.slice(0, 13), 16) || 1,
    name,
    state: 'uploaded',
    size: info.size,
    digest: `sha256:${sha256}`,
    browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
  });
}

const releases = [{ tag_name: tag, draft: false, prerelease: false, body: body.trim(), assets }];
const seen = new Set([version]);
for (const release of await fetchReleases(repository, token)) {
  const candidate = VERSION_RE.exec(String(release?.tag_name ?? ''))?.[1];
  if (
    !candidate ||
    compareVersions(candidate, version) >= 0 ||
    seen.has(candidate) ||
    release.draft ||
    release.prerelease
  ) {
    continue;
  }
  seen.add(candidate);
  releases.push({
    tag_name: `v${candidate}`,
    draft: false,
    prerelease: false,
    body: typeof release.body === 'string' ? release.body : '',
    assets: [],
  });
}
releases.sort((left, right) => compareVersions(right.tag_name, left.tag_name));
await writeFile(output, `${JSON.stringify({ schemaVersion: 1, version, releases }, null, 2)}\n`);
console.log(`Created ${output} for ${tag} with ${releases.length} release notes`);

async function fetchReleases(repo, authorization) {
  const releases = [];
  let url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
  while (url) {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${authorization}`,
        'User-Agent': 'antigravity-quota-injector-release',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub release history request failed: HTTP ${response.status}`);
    }
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error('GitHub release history response is invalid');
    releases.push(...page);
    url = nextPage(response.headers.get('link'), repo);
  }
  return releases;
}

function nextPage(link, repo) {
  const part = String(link ?? '')
    .split(',')
    .find((item) => /;\s*rel="next"\s*$/.test(item));
  const href = /^\s*<([^>]+)>/.exec(part ?? '')?.[1];
  if (!href) return null;
  const url = new URL(href);
  if (url.origin !== 'https://api.github.com' || url.pathname !== `/repos/${repo}/releases`) {
    throw new Error('GitHub release history returned an invalid pagination URL');
  }
  return url.href;
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function compareVersions(left, right) {
  const a = VERSION_RE.exec(String(left))?.[1].split('.').map(Number) ?? [];
  const b = VERSION_RE.exec(String(right))?.[1].split('.').map(Number) ?? [];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function parseArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!name?.startsWith('--') || args[index + 1] == null) {
      throw new Error(`Invalid argument: ${name ?? ''}`);
    }
    result[name.slice(2)] = args[index + 1];
  }
  return result;
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
