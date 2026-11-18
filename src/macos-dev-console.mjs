import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function endDevConsoleOnFormalTakeover({
  mode,
  requestMode,
  logRoot,
  platform = process.platform,
}) {
  if (platform !== 'darwin' || mode !== 'dev' || requestMode !== 'formal') return false;
  const targetPath = join(logRoot, 'active-dev-console');
  try {
    await readFile(targetPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const temporary = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `formal-${randomUUID()}`, { mode: 0o600 });
    await rename(temporary, targetPath);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}
