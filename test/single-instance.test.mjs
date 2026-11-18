import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import {
  acquireSingleInstance,
  closeSingleInstance,
  compareVersions,
  readSingleInstanceStatus,
} from '../src/single-instance.mjs';

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

test('compareVersions compares semver tuples numerically', () => {
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1);
});

test('dev launch replaces running formal owner, and formal launch replaces running dev owner', async (t) => {
  const port = await getFreePort();
  let formalTakeovers = 0;
  let devTakeovers = 0;

  const formal = await acquireSingleInstance({
    port,
    mode: 'formal',
    version: '0.1.0',
    explicitStart: true,
    getStatus: () => ({ phase: 'ready' }),
    onTakeover: async () => {
      formalTakeovers += 1;
      await closeSingleInstance(formal);
    },
  });
  t.after(() => closeSingleInstance(formal));

  // Dev launch at same version automatically replaces formal
  const dev = await acquireSingleInstance({
    port,
    mode: 'dev',
    version: '0.1.0',
    explicitStart: true,
    runtimeIdentity: 'a'.repeat(64),
    getStatus: () => ({ phase: 'ready' }),
    onTakeover: async () => {
      devTakeovers += 1;
      await closeSingleInstance(dev);
    },
  });
  t.after(() => closeSingleInstance(dev));

  assert.equal(formalTakeovers, 1);
  assert.ok(dev?.listening);
  assert.equal((await readSingleInstanceStatus({ port })).mode, 'dev');

  // Same unchanged dev launch reuses existing dev owner
  let reuseCount = 0;
  const port2 = await getFreePort();
  const dev2 = await acquireSingleInstance({
    port: port2,
    mode: 'dev',
    version: '0.1.0',
    explicitStart: true,
    runtimeIdentity: 'a'.repeat(64),
    onReuse: () => {
      reuseCount += 1;
    },
    onTakeover: () => assert.fail('相同代码开发版不应触发替换'),
  });
  t.after(() => closeSingleInstance(dev2));

  assert.equal(
    await acquireSingleInstance({
      port: port2,
      mode: 'dev',
      version: '0.1.0',
      explicitStart: true,
      runtimeIdentity: 'a'.repeat(64),
    }),
    null
  );
  for (let i = 0; i < 20 && reuseCount === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(reuseCount, 1);

  // Formal launch replaces dev
  const formal2 = await acquireSingleInstance({
    port,
    mode: 'formal',
    version: '0.1.0',
    explicitStart: true,
    getStatus: () => ({ phase: 'ready' }),
  });
  t.after(() => closeSingleInstance(formal2));
  assert.equal(devTakeovers, 1);
  assert.ok(formal2?.listening);
  assert.equal((await readSingleInstanceStatus({ port })).mode, 'formal');
});

test('formal --prepare-update replaces same-version formal instance for Windows installer', async (t) => {
  const port = await getFreePort();
  let takeoverPurpose = '';
  const owner = await acquireSingleInstance({
    port,
    mode: 'formal',
    version: '0.1.0',
    explicitStart: true,
    onTakeover: async (req) => {
      takeoverPurpose = req.purpose;
      await closeSingleInstance(owner);
    },
  });
  t.after(() => closeSingleInstance(owner));

  const installer = await acquireSingleInstance({
    port,
    mode: 'formal',
    version: '0.1.0',
    explicitStart: true,
    purpose: 'install-update',
  });
  t.after(() => closeSingleInstance(installer));

  assert.ok(installer?.listening);
  assert.equal(takeoverPurpose, 'install-update');
});
