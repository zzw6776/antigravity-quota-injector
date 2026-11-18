import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function verifyExistingDownload(asset, destination) {
  if (!asset?.sha256) return false;
  try {
    const info = await stat(destination);
    if (!info.isFile() || info.size !== asset.size) return false;
    const digest = await hashFile(destination);
    return digest === asset.sha256.toLowerCase();
  } catch {
    return false;
  }
}

export async function downloadUpdate(
  asset,
  destination,
  { fetchImpl = fetch, onProgress = () => {}, signal } = {}
) {
  if (!asset?.sha256) {
    throw new Error('发布清单缺少 SHA-256 校验值，无法安全更新');
  }
  if (await verifyExistingDownload(asset, destination)) {
    onProgress(asset.size, asset.size);
    return destination;
  }

  await mkdir(dirname(destination), { recursive: true });
  const partialPath = `${destination}.part`;
  await unlink(partialPath).catch(() => {});

  let response;
  try {
    response = await fetchImpl(asset.url, {
      headers: { 'User-Agent': 'antigravity-quota-injector' },
      signal,
    });
    if (!response.ok) {
      throw new Error(`下载更新失败（HTTP ${response.status}）`);
    }
    if (!response.body) {
      throw new Error('下载更新失败：响应流为空');
    }

    const total = Number(response.headers.get('content-length')) || asset.size;
    let received = 0;
    const hash = createHash('sha256');
    const out = createWriteStream(partialPath, { mode: 0o600 });

    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        received += value.length;
        if (received > asset.size) {
          throw new Error('下载文件大小超出发布清单声明');
        }
        hash.update(value);
        await writeChunk(out, value);
        onProgress(received, total);
      }
      await closeStream(out);
    } catch (err) {
      out.destroy();
      await reader.cancel().catch(() => {});
      throw err;
    }

    if (received !== asset.size) {
      throw new Error(`下载文件大小不匹配（期望 ${asset.size}，实际 ${received}）`);
    }
    const digest = hash.digest('hex').toLowerCase();
    if (digest !== asset.sha256.toLowerCase()) {
      throw new Error('下载文件 SHA-256 校验失败');
    }
    await rename(partialPath, destination);
    return destination;
  } catch (err) {
    await unlink(partialPath).catch(() => {});
    throw err;
  }
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex').toLowerCase();
}

function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    const ok = stream.write(chunk, (err) => {
      if (err) reject(err);
    });
    if (ok) resolve();
    else stream.once('drain', resolve);
  });
}

function closeStream(stream) {
  return new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end(() => resolve());
  });
}
