import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

import { buildClientScript } from '../src/daemon.mjs';

const root = path.resolve(import.meta.dirname, '..');

async function collectJsFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsFiles(full)));
    } else if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

// 1. Validate package.json / package-lock.json version and Chinese release notes
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json version must be semver');
assert.equal(lock.version, pkg.version, 'package-lock.json top-level version mismatch');
assert.equal(lock.packages?.['']?.version, pkg.version, 'package-lock.json packages[""].version mismatch');

const notesPath = path.join(root, 'docs', 'releases', `${pkg.version}.md`);
const notes = (await fs.readFile(notesPath, 'utf8')).replace(/\r\n/g, '\n');
const [title, ...body] = notes.split('\n');
assert.equal(title, `# ${pkg.version}`, `release notes header must be "# ${pkg.version}"`);
assert.equal(
  body.some((line) => /^[-*]\s+\S/.test(line) && /\p{Script=Han}/u.test(line)),
  true,
  'release notes must contain at least one Chinese bullet item'
);

// 2. Syntax-check all JS/MJS files under src/
const srcFiles = await collectJsFiles(path.join(root, 'src'));
for (const file of srcFiles) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
}

// 3. Validate assembled client inject bundle syntax
const bundle = buildClientScript({ codexTheme: true, zhUi: true });
new vm.Script(bundle.script, { filename: 'client-inject.bundle.js' });

console.log(`check ok: v${pkg.version}, ${srcFiles.length} src files, bundle ${bundle.version}`);
