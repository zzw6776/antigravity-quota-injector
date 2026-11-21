import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { parseConversationTurns, parseProto, readPackedVarints } from '../src/proto-metrics.mjs';

function encodeVarint(value) {
  const bytes = [];
  let v = BigInt(value);
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function fieldVarint(fieldNum, value) {
  return Buffer.concat([encodeVarint((fieldNum << 3) | 0), encodeVarint(value)]);
}

function fieldBytes(fieldNum, buf) {
  return Buffer.concat([encodeVarint((fieldNum << 3) | 2), encodeVarint(buf.length), buf]);
}

function buildGenMetadataBlob({ stepIds, inTok, outTok, cacheRead, thinkTok, respTok, ttftSec, streamSec, model }) {
  const usage = Buffer.concat([
    fieldVarint(2, inTok),
    fieldVarint(3, outTok),
    fieldVarint(5, cacheRead),
    fieldVarint(9, thinkTok),
    fieldVarint(10, respTok),
  ]);
  const ttft = fieldVarint(1, ttftSec);
  const stream = fieldVarint(1, streamSec);
  const chat = Buffer.concat([
    fieldBytes(4, usage),
    fieldBytes(11, ttft),
    fieldBytes(12, stream),
    fieldBytes(19, Buffer.from(model, 'utf8')),
  ]);
  const packedSteps = Buffer.concat(stepIds.map((id) => encodeVarint(id)));
  return Buffer.concat([fieldBytes(1, chat), fieldBytes(2, packedSteps)]);
}

test('parseProto and readPackedVarints decode fields accurately', () => {
  const blob = buildGenMetadataBlob({
    stepIds: [1, 2, 130],
    inTok: 200,
    outTok: 150,
    cacheRead: 800,
    thinkTok: 50,
    respTok: 100,
    ttftSec: 2,
    streamSec: 3,
    model: 'gemini-3.8-flash-n',
  });
  const top = parseProto(blob);
  assert.deepEqual(readPackedVarints(top.get(2)), [1, 2, 130]);
});

test('parseConversationTurns aggregates multi-call turns and ignores unlinked rows', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-test-'));
  const dbPath = path.join(tmpDir, 'conv.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL DEFAULT 3);
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
  `);
  // Turn 0 starts at step 0; Turn 1 starts at step 5 (and has a running step)
  db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)').run(0, 14, 3);
  db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)').run(1, 15, 3);
  db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)').run(2, 15, 3);
  db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)').run(5, 14, 3);
  db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)').run(6, 15, 1);

  const insertGen = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
  insertGen.run(
    0,
    buildGenMetadataBlob({
      stepIds: [1],
      inTok: 1000,
      outTok: 300,
      cacheRead: 9000,
      thinkTok: 100,
      respTok: 200,
      ttftSec: 2,
      streamSec: 3,
      model: 'gemini-3.8-flash-n',
    })
  );
  insertGen.run(
    1,
    buildGenMetadataBlob({
      stepIds: [2],
      inTok: 500,
      outTok: 200,
      cacheRead: 9500,
      thinkTok: 50,
      respTok: 150,
      ttftSec: 4,
      streamSec: 2,
      model: 'gemini-3.8-flash-n',
    })
  );
  // Row without stepIds should be skipped
  insertGen.run(2, fieldBytes(1, fieldBytes(19, Buffer.from('ignored', 'utf8'))));
  insertGen.run(
    3,
    buildGenMetadataBlob({
      stepIds: [6],
      inTok: 2000,
      outTok: 400,
      cacheRead: 8000,
      thinkTok: 100,
      respTok: 300,
      ttftSec: 1,
      streamSec: 4,
      model: 'gemini-4-hydrogen',
    })
  );
  // Short buffered call (stream = 0s, ttft = 10s) in turn 1 should not drag down turn 1 outputSpeed
  insertGen.run(
    4,
    buildGenMetadataBlob({
      stepIds: [6],
      inTok: 500,
      outTok: 20,
      cacheRead: 1000,
      thinkTok: 0,
      respTok: 20,
      ttftSec: 10,
      streamSec: 0,
      model: 'gemini-4-hydrogen',
    })
  );
  db.close();

  const res = parseConversationTurns(dbPath, '11111111-1111-1111-1111-111111111111');
  assert.equal(res.hasData, true);
  assert.deepEqual(res.latestContext, { usedTokens: 1500, maxTokens: 256000 });
  assert.equal(res.turns.length, 2);

  const t0 = res.turns[0];
  assert.equal(t0.completed, true);
  assert.equal(t0.calls, 2);
  assert.equal(t0.inputTokens, 20000);
  assert.equal(t0.cachedInputTokens, 18500);
  assert.equal(t0.outputTokens, 500);
  assert.equal(t0.totalTokens, 20500);
  assert.equal(t0.cumulativeTotalTokens, 20500);
  assert.equal(t0.firstTokenLatencyMs, 3000);
  assert.equal(t0.outputSpeed, (299 + 199) / 5);

  const t1 = res.turns[1];
  assert.equal(t1.completed, false);
  assert.equal(t1.calls, 2);
  assert.equal(t1.totalTokens, 11920);
  assert.equal(t1.cumulativeTotalTokens, 32420);
  assert.equal(t1.outputSpeed, 399 / 4);
  assert.equal(t1.model, 'gemini-4-hydrogen');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('parseConversationTurns extracts tool call names, durations, and visible response flags', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-test-tools-'));
  const dbPath = path.join(tmpDir, 'conv.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE steps (
      idx INTEGER PRIMARY KEY,
      step_type INTEGER NOT NULL,
      status INTEGER NOT NULL DEFAULT 3,
      metadata BLOB,
      step_payload BLOB
    );
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
  `);

  const tsBlob = (sec, ns = 0) => Buffer.concat([fieldVarint(1, sec), fieldVarint(2, ns)]);
  const toolMeta = (toolName, startSec, endSec) =>
    Buffer.concat([
      fieldBytes(4, fieldBytes(2, Buffer.from(toolName, 'utf8'))),
      fieldBytes(7, tsBlob(startSec, 0)),
      fieldBytes(8, tsBlob(endSec, 250_000_000)),
    ]);
  const plannerPayload = (text) =>
    fieldBytes(20, fieldBytes(1, Buffer.from(text, 'utf8')));

  const stepTsMeta = (startSec, endSec = startSec) =>
    Buffer.concat([
      fieldBytes(1, tsBlob(startSec, 0)),
      fieldBytes(8, tsBlob(endSec, 0)),
    ]);

  db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(
    0,
    14,
    3,
    stepTsMeta(1795000100)
  );
  db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)').run(1, 15, 3);
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(
    2,
    132,
    3,
    toolMeta('read_file', 100, 100)
  );
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(
    3,
    132,
    3,
    toolMeta('read_file', 100, 101)
  );
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)').run(
    4,
    15,
    3,
    stepTsMeta(1795000150, 1795000174),
    plannerPayload('完成回复')
  );

  const insertGen = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
  insertGen.run(
    0,
    buildGenMetadataBlob({
      stepIds: [1, 2, 3],
      inTok: 1000,
      outTok: 120,
      cacheRead: 8000,
      thinkTok: 20,
      respTok: 100,
      ttftSec: 2,
      streamSec: 2,
      model: 'gemini-4-hydrogen',
    })
  );
  insertGen.run(
    1,
    buildGenMetadataBlob({
      stepIds: [4],
      inTok: 500,
      outTok: 200,
      cacheRead: 9000,
      thinkTok: 0,
      respTok: 200,
      ttftSec: 1,
      streamSec: 2,
      model: 'gemini-4-hydrogen',
    })
  );
  db.close();

  const res = parseConversationTurns(dbPath, '11111111-1111-1111-1111-111111111111');
  const details = res.turns[0].callDetails;
  assert.equal(details.length, 2);
  assert.deepEqual(details[0].toolCalls, [
    { toolName: 'read_file', durationMs: 250 },
    { toolName: 'read_file', durationMs: 1250 },
  ]);
  assert.equal(details[0].hasVisibleText, false);
  assert.equal(details[1].hasVisibleText, true);
  assert.equal(details[1].followsToolResult, true);
  assert.equal(res.turns[0].wallDurationMs, 74_000);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
