import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readdir, rm, statfs, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const MIB = 1024 * 1024;
const BLOCK_BYTES = 4096;

export async function planMacDmg(appPath) {
  let logicalBytes = 0;
  let allocatedBytes = 0;
  let copyBytes = 0;
  let entries = 0;
  async function visit(targetPath) {
    const info = await lstat(targetPath);
    entries++;
    allocatedBytes += info.blocks * 512;
    if (info.isDirectory()) {
      copyBytes += BLOCK_BYTES;
      for (const name of await readdir(targetPath)) await visit(join(targetPath, name));
    } else {
      logicalBytes += info.size;
      copyBytes += Math.max(BLOCK_BYTES, Math.ceil(info.size / BLOCK_BYTES) * BLOCK_BYTES);
    }
  }
  await visit(appPath);
  const imageMiB = Math.ceil((copyBytes + Math.max(64 * MIB, copyBytes * 0.25)) / MIB);
  return { logicalBytes, allocatedBytes, entries, imageMiB };
}

export async function createMacDmg({ appPath, dmgPath, run = execFileSync, log = console.log }) {
  const plan = await planMacDmg(appPath);
  const diskSpace = async () =>
    Promise.all(
      [dirname(dmgPath), tmpdir()].map(async (p) => {
        try {
          const info = await statfs(p);
          return { path: p, availableBytes: info.bavail * info.bsize };
        } catch (error) {
          return { path: p, error: error.message };
        }
      })
    );
  log(`[dmg] ${JSON.stringify({ ...plan, filesystem: 'HFS+', diskSpace: await diskSpace() })}`);
  let stagingDir;
  try {
    stagingDir = await mkdtemp(join(dirname(appPath), '.antigravity-dmg-stage-'));
    execFileSync('/bin/cp', ['-Rlp', appPath, join(stagingDir, basename(appPath))]);
    await symlink('/Applications', join(stagingDir, 'Applications'));
    run(
      '/usr/bin/hdiutil',
      [
        'create',
        '-volname',
        'Antigravity Quota Injector',
        '-srcfolder',
        stagingDir,
        '-fs',
        'HFS+',
        '-size',
        `${plan.imageMiB}m`,
        '-ov',
        '-format',
        'UDZO',
        dmgPath,
      ],
      { stdio: 'inherit' }
    );
    run('/usr/bin/hdiutil', ['verify', dmgPath], { stdio: 'inherit' });
  } catch (error) {
    log(`[dmg] failed; diskSpace=${JSON.stringify(await diskSpace())}`);
    throw error;
  } finally {
    if (stagingDir) await rm(stagingDir, { recursive: true, force: true });
  }
  return plan;
}
