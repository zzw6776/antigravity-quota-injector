import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { windowsInstallerArguments } from '../scripts/windows-installer-command.mjs';
import { assertSuccessfulPostject, stripWindowsAuthenticode } from '../scripts/windows-sea-support.mjs';

const root = path.resolve(import.meta.dirname, '..');

test('package.json version has matching Chinese release notes in docs/releases', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  const notes = (await fs.readFile(path.join(root, 'docs', 'releases', `${pkg.version}.md`), 'utf8')).replace(
    /\r\n/g,
    '\n'
  );
  const [title, ...body] = notes.split('\n');
  assert.equal(title, `# ${pkg.version}`);
  assert.equal(
    body.some((line) => /^[-*]\s+\S/.test(line) && /\p{Script=Han}/u.test(line)),
    true
  );
});

test('windowsInstallerArguments maps NSIS macros cleanly', () => {
  const args = windowsInstallerArguments({
    version: '0.1.0',
    inputExecutable: 'C:\\build\\Antigravity Quota Injector.exe',
    appIcon: 'C:\\assets\\AppIcon.ico',
    nodeLicense: 'C:\\build\\NODE_LICENSE.txt',
    outputExecutable: 'C:\\release\\Antigravity-Quota-Injector-0.1.0-windows-x64-Setup.exe',
    scriptPath: 'C:\\installer\\windows-installer.nsi',
  });
  assert.deepEqual(args.slice(0, 2), ['/INPUTCHARSET', 'UTF8']);
  assert.ok(args.includes('/DVERSION=0.1.0'));
  assert.ok(args.includes('/DINPUT_EXE=C:\\build\\Antigravity Quota Injector.exe'));
  assert.equal(args.at(-1), 'C:\\installer\\windows-installer.nsi');
});

test('stripWindowsAuthenticode clears certificate directory and trims trailing signature overlay', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aq-pe-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const pe = Buffer.alloc(600, 0);
  pe.write('MZ', 0, 'ascii');
  pe.writeUInt32LE(0x80, 0x3c); // peOffset
  pe.write('PE\0\0', 0x80, 'ascii');
  const optOffset = 0x80 + 24;
  pe.writeUInt16LE(0x20b, optOffset); // PE32+
  pe.writeUInt32LE(16, optOffset + 108); // numberOfRvaAndSizes
  const secDir = optOffset + 112 + 4 * 8;
  pe.writeUInt32LE(512, secDir);
  pe.writeUInt32LE(88, secDir + 4);

  const file = path.join(tmp, 'test.exe');
  await fs.writeFile(file, pe);
  await stripWindowsAuthenticode(file);

  const out = await fs.readFile(file);
  assert.equal(out.length, 512);
  assert.equal(out.readUInt32LE(secDir), 0);
  assert.equal(out.readUInt32LE(secDir + 4), 0);
});

test('assertSuccessfulPostject validates postject output', () => {
  assert.doesNotThrow(() =>
    assertSuccessfulPostject({ status: 0, stdout: 'Start injection...\nInjection done!\n', stderr: '' })
  );
  assert.throws(
    () => assertSuccessfulPostject({ status: 0, stdout: 'Relocation corrupted', stderr: '' }),
    /corrupted/
  );
});

test('AppIcon assets exist for macOS and Windows', async () => {
  for (const name of ['AppIcon.png', 'AppIcon.icns', 'AppIcon.ico']) {
    const info = await fs.stat(path.join(root, 'assets', name));
    assert.equal(info.isFile() && info.size > 0, true, `${name} should exist`);
  }
});
