import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { resolveContextTier } from './token-pricing.mjs';

const textDecoder = new TextDecoder('utf-8', { fatal: false });
const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * Decode a raw protobuf wire buffer into a Map<fieldNumber, Uint8Array | number | Array>.
 */
export function parseProto(buf) {
  const fields = new Map();
  if (!(buf instanceof Uint8Array) || buf.length === 0) return fields;
  let i = 0;

  const readVarint = () => {
    let val = 0n;
    let shift = 0n;
    while (i < buf.length) {
      const b = buf[i++];
      val |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        return val <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(val) : Number.MAX_SAFE_INTEGER;
      }
      shift += 7n;
      if (shift > 63n) return null;
    }
    return null;
  };

  while (i < buf.length) {
    const tag = readVarint();
    if (tag === null) break;
    const fieldNum = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNum === 0) break;

    let value;
    if (wireType === 0) {
      value = readVarint();
      if (value === null) break;
    } else if (wireType === 1) {
      if (i + 8 > buf.length) break;
      i += 8;
      continue;
    } else if (wireType === 2) {
      const len = readVarint();
      if (len === null || len < 0 || i + len > buf.length) break;
      value = buf.subarray(i, i + len);
      i += len;
    } else if (wireType === 5) {
      if (i + 4 > buf.length) break;
      i += 4;
      continue;
    } else {
      break;
    }

    fields.set(fieldNum, value);
  }
  return fields;
}

/**
 * Decode packed varint integers from a length-delimited protobuf field.
 */
export function readPackedVarints(buf) {
  if (!(buf instanceof Uint8Array) || buf.length === 0) return [];
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let val = 0;
    let shift = 0;
    while (i < buf.length) {
      const b = buf[i++];
      val |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) return out;
    }
    out.push(val);
  }
  return out;
}

function readUtf8(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (val instanceof Uint8Array) return textDecoder.decode(val);
  return '';
}

function readTimestampSec(buf) {
  if (!(buf instanceof Uint8Array)) return 0;
  const m = parseProto(buf);
  const val = Number(m.get(1) || 0) + Number(m.get(2) || 0) / 1e9;
  return Number.isFinite(val) && val > 0 ? val : 0;
}

function extractStepMaxTimestampSec(metaMap) {
  let maxTs = 0;
  for (const field of [8, 32, 7, 6, 1]) {
    const ts = readTimestampSec(metaMap.get(field));
    if (ts > maxTs) maxTs = ts;
  }
  return maxTs;
}

function extractStepCallDetails(stepIds, stepByIdx) {
  let hasVisibleText = false;
  const toolCalls = [];
  for (let i = 0; i < stepIds.length; i++) {
    const step = stepByIdx.get(stepIds[i]);
    if (!step) continue;
    if (step.step_type === 15 && step.step_payload instanceof Uint8Array) {
      const sp = parseProto(step.step_payload);
      const p20Raw = sp.get(20);
      if (p20Raw instanceof Uint8Array) {
        const p20 = parseProto(p20Raw);
        if (readUtf8(p20.get(1)).trim().length > 0) {
          hasVisibleText = true;
        }
      }
    }
    if (step.step_type === 132 && step.metadata instanceof Uint8Array) {
      const m = parseProto(step.metadata);
      const f4Raw = m.get(4);
      if (f4Raw instanceof Uint8Array) {
        const f4 = parseProto(f4Raw);
        const toolName = readUtf8(f4.get(2)).trim();
        if (toolName) {
          const startTs = readTimestampSec(m.get(7)) || readTimestampSec(m.get(6));
          const endTs = readTimestampSec(m.get(8)) || readTimestampSec(m.get(32));
          const durationMs =
            Number(step.status) !== 1 && startTs > 0 && endTs >= startTs
              ? Math.round((endTs - startTs) * 1000)
              : null;
          toolCalls.push({ toolName, durationMs });
        }
      }
    }
  }
  return { hasVisibleText, toolCalls };
}

/**
 * Parse a single gen_metadata row into usage, timing, model, and step indices.
 */
export function parseGenMetadataRow(row) {
  const top = parseProto(row?.data);
  const stepIds = readPackedVarints(top.get(2));
  const chatRaw = top.get(1);
  const chat = chatRaw instanceof Uint8Array ? parseProto(chatRaw) : new Map();
  const usageRaw = chat.get(4);
  const usage = usageRaw instanceof Uint8Array ? parseProto(usageRaw) : new Map();
  const chatStartRaw = chat.get(9);
  const chatStart = chatStartRaw instanceof Uint8Array ? parseProto(chatStartRaw) : new Map();
  const ctxWinRaw = chatStart.get(10);
  const ctxWin = ctxWinRaw instanceof Uint8Array ? parseProto(ctxWinRaw) : new Map();
  const ttftRaw = chat.get(11);
  const ttftMap = ttftRaw instanceof Uint8Array ? parseProto(ttftRaw) : new Map();
  const streamRaw = chat.get(12);
  const streamMap = streamRaw instanceof Uint8Array ? parseProto(streamRaw) : new Map();

  const inTok = Number(usage.get(2) || 0);
  const outTok = Number(usage.get(3) || 0);
  const cacheRead = Number(usage.get(5) || 0);
  const thinkTok = Number(usage.get(9) || 0);
  const respTok = Number(usage.get(10) || 0);
  const ttft = Number(ttftMap.get(1) || 0) + Number(ttftMap.get(2) || 0) / 1e9;
  const stream = Number(streamMap.get(1) || 0) + Number(streamMap.get(2) || 0) / 1e9;
  const maxCtx = Number(ctxWin.get(4) || 0);
  const model = readUtf8(chat.get(19)).trim();
  const modelLabel = readUtf8(chat.get(21)).trim();

  return {
    idx: row.idx,
    stepIds,
    model,
    modelLabel,
    inTok,
    cacheRead,
    outTok,
    thinkTok,
    respTok,
    maxCtx,
    ttft: Number.isFinite(ttft) && ttft >= 0 ? ttft : 0,
    stream: Number.isFinite(stream) && stream >= 0 ? stream : 0,
  };
}

/**
 * Find the largest turn index whose startStepIdx <= stepId.
 */
function findTurnIndex(userStepIndices, stepId) {
  let lo = 0;
  let hi = userStepIndices.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (userStepIndices[mid] <= stepId) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Compute database mtime+size signature including WAL file if present.
 */
export function getDbSignature(dbPath) {
  try {
    const st = fs.statSync(dbPath, { throwIfNoEntry: false });
    if (!st) return null;
    const wst = fs.statSync(`${dbPath}-wal`, { throwIfNoEntry: false });
    const walSig = wst ? `${wst.mtimeMs}:${wst.size}` : '0:0';
    return `${st.mtimeMs}:${st.size}|${walSig}`;
  } catch {
    return null;
  }
}

/**
 * Parse per-turn usage metrics from an Antigravity conversation SQLite database.
 */
export function parseConversationTurns(dbPath, cascadeId = '') {
  if (!dbPath || !fs.existsSync(dbPath)) {
    return { cascadeId, hasData: false, turns: [] };
  }
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 200 });
    const stepCols = new Set(db.prepare('PRAGMA table_info(steps)').all().map((c) => c.name));
    const selectCols = [
      'idx',
      'step_type',
      'status',
      ...(stepCols.has('metadata') ? ['metadata'] : []),
      ...(stepCols.has('step_payload')
        ? ['CASE WHEN step_type = 15 THEN step_payload ELSE NULL END AS step_payload']
        : []),
    ];
    const allSteps = db
      .prepare(
        `SELECT ${selectCols.join(', ')} FROM steps WHERE step_type IN (14, 15, 132) OR status = 1 ORDER BY idx ASC`
      )
      .all();
    const stepByIdx = new Map();
    const userStepIndices = [];
    for (let i = 0; i < allSteps.length; i++) {
      const s = allSteps[i];
      const idx = Number(s.idx);
      stepByIdx.set(idx, s);
      if (Number(s.step_type) === 14) {
        userStepIndices.push(idx);
      }
    }

    if (userStepIndices.length === 0) {
      return { cascadeId, hasData: false, turns: [] };
    }

    const lastUserIdx = userStepIndices[userStepIndices.length - 1];
    const lastTurnRunning = allSteps.some(
      (s) => Number(s.idx) >= lastUserIdx && Number(s.status) === 1
    );

    const buckets = userStepIndices.map((startStepIdx, turnIndex) => ({
      turnIndex,
      startStepIdx,
      calls: 0,
      callDetails: [],
      segments: [],
      model: '',
      modelLabel: '',
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      responseTokens: 0,
      totalTokens: 0,
      cumulativeTotalTokens: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      ttftTotalMs: 0,
      ttftSamples: 0,
      streamDurationMs: 0,
      streamTokens: 0,
      totalDurationMs: 0,
      wallDurationMs: null,
      firstTokenLatencyMs: null,
      outputSpeed: null,
      completed: turnIndex < userStepIndices.length - 1 ? true : !lastTurnRunning,
    }));

    const turnWallBounds = userStepIndices.map(() => ({ startTsSec: 0, endTsSec: 0 }));
    for (let i = 0; i < allSteps.length; i++) {
      const s = allSteps[i];
      if (!(s.metadata instanceof Uint8Array)) continue;
      const idx = Number(s.idx);
      const turnIdx = findTurnIndex(userStepIndices, idx);
      if (turnIdx < 0 || turnIdx >= turnWallBounds.length) continue;
      const m = parseProto(s.metadata);
      const bounds = turnWallBounds[turnIdx];
      if (Number(s.step_type) === 14 && bounds.startTsSec === 0) {
        bounds.startTsSec = readTimestampSec(m.get(1)) || readTimestampSec(m.get(6)) || 0;
      }
      const stepMaxTs = extractStepMaxTimestampSec(m);
      if (stepMaxTs > bounds.endTsSec) {
        bounds.endTsSec = stepMaxTs;
      }
    }

    const genRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    for (let i = 0; i < genRows.length; i++) {
      const parsed = parseGenMetadataRow(genRows[i]);
      if (parsed.stepIds.length === 0) continue;
      const totalCallTokens = parsed.inTok + parsed.cacheRead + parsed.outTok;
      if (totalCallTokens <= 0) continue;

      const anchorStep = Math.max(...parsed.stepIds);
      const turnIdx = findTurnIndex(userStepIndices, anchorStep);
      if (turnIdx < 0 || turnIdx >= buckets.length) continue;

      const turn = buckets[turnIdx];
      turn.calls += 1;
      if (parsed.model) {
        turn.model = parsed.model;
      } else if (!turn.model && parsed.modelLabel) {
        turn.model = parsed.modelLabel;
      }
      if (parsed.modelLabel) turn.modelLabel = parsed.modelLabel;
      turn.uncachedInputTokens += parsed.inTok;
      turn.cachedInputTokens += parsed.cacheRead;
      const callInput = parsed.inTok + parsed.cacheRead;
      turn.inputTokens += callInput;
      turn.outputTokens += parsed.outTok;
      turn.thinkingTokens += parsed.thinkTok;
      turn.responseTokens += parsed.respTok;
      turn.totalTokens += callInput + parsed.outTok;
      turn.contextTokens = callInput;
      if (parsed.maxCtx > 0) turn.maxContextTokens = parsed.maxCtx;

      const segModel = parsed.model || '';
      const segLabel = parsed.modelLabel || '';
      const contextTier = resolveContextTier(segModel || turn.model, callInput, segLabel || turn.modelLabel);
      const lastSeg = turn.segments.at(-1);
      if (lastSeg && lastSeg.model === segModel && lastSeg.modelLabel === segLabel && lastSeg.contextTier === contextTier) {
        lastSeg.usage.inputTokens += callInput;
        lastSeg.usage.uncachedInputTokens += parsed.inTok;
        lastSeg.usage.cachedInputTokens += parsed.cacheRead;
        lastSeg.usage.outputTokens += parsed.outTok;
        lastSeg.usage.thinkingTokens += parsed.thinkTok;
        lastSeg.usage.responseTokens += parsed.respTok;
        lastSeg.usage.totalTokens += callInput + parsed.outTok;
      } else {
        turn.segments.push({
          model: segModel,
          modelLabel: segLabel,
          contextTier,
          usage: {
            inputTokens: callInput,
            uncachedInputTokens: parsed.inTok,
            cachedInputTokens: parsed.cacheRead,
            outputTokens: parsed.outTok,
            thinkingTokens: parsed.thinkTok,
            responseTokens: parsed.respTok,
            totalTokens: callInput + parsed.outTok,
          },
        });
      }

      if (parsed.ttft > 0) {
        turn.ttftTotalMs += parsed.ttft * 1000;
        turn.ttftSamples += 1;
      }
      const totDur = parsed.ttft + parsed.stream;
      turn.totalDurationMs += totDur * 1000;

      // Only aggregate measurable streaming windows; exclude short buffered bursts
      // and pre-first-token queueing/prefill (TTFT) from generation throughput.
      const rawStreamTps = parsed.stream >= 0.5 ? parsed.outTok / parsed.stream : 0;
      const streamRatio = totDur > 0 ? parsed.stream / totDur : 0;
      const isMeasurableStream =
        parsed.stream >= 0.5 &&
        parsed.outTok > 1 &&
        rawStreamTps > 0 &&
        rawStreamTps <= 600 &&
        (streamRatio >= 0.15 || (parsed.stream >= 2.0 && rawStreamTps <= 250));
      if (isMeasurableStream) {
        turn.streamDurationMs += parsed.stream * 1000;
        turn.streamTokens += parsed.outTok - 1;
      }
      const { hasVisibleText, toolCalls } = extractStepCallDetails(parsed.stepIds, stepByIdx);
      const followsToolResult = turn.callDetails.some(
        (prev) => Array.isArray(prev.toolCalls) && prev.toolCalls.length > 0
      );
      turn.callDetails.push({
        callIndex: turn.calls,
        model: parsed.model || parsed.modelLabel || '',
        modelLabel: parsed.modelLabel || '',
        ttftMs: Math.round(parsed.ttft * 1000),
        streamMs: Math.round(parsed.stream * 1000),
        outTok: parsed.outTok,
        speed: isMeasurableStream ? Number(((parsed.outTok - 1) / parsed.stream).toFixed(1)) : null,
        hasVisibleText,
        followsToolResult,
        toolCalls,
      });
    }

    let runningCumulative = 0;
    let hasAnyUsage = false;
    let latestContext = null;
    for (let i = 0; i < buckets.length; i++) {
      const turn = buckets[i];
      runningCumulative += turn.totalTokens;
      turn.cumulativeTotalTokens = runningCumulative;
      if (turn.totalTokens > 0) hasAnyUsage = true;
      if (turn.contextTokens > 0) {
        latestContext = {
          usedTokens: turn.contextTokens,
          maxTokens: turn.maxContextTokens > 0 ? turn.maxContextTokens : 256000,
        };
      }
      if (turn.ttftSamples > 0) {
        turn.firstTokenLatencyMs = turn.ttftTotalMs / turn.ttftSamples;
      }
      if (turn.streamDurationMs > 0 && turn.streamTokens > 0) {
        turn.outputSpeed = turn.streamTokens / (turn.streamDurationMs / 1000);
      }
      const bounds = turnWallBounds[i];
      if (bounds.startTsSec > 0 && bounds.endTsSec >= bounds.startTsSec) {
        turn.wallDurationMs = Math.round((bounds.endTsSec - bounds.startTsSec) * 1000);
      }
    }

    return {
      cascadeId,
      hasData: hasAnyUsage,
      latestContext,
      turns: buckets,
    };
  } catch (err) {
    const msg = String(err?.message || '');
    if (/locked|busy/i.test(msg)) {
      return { cascadeId, transientError: true, turns: [] };
    }
    return { cascadeId, hasData: false, turns: [], error: msg };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export function resolveConversationDbPath(cascadeId, conversationsDir) {
  if (!cascadeId || !UUID_RE.test(cascadeId) || !conversationsDir) return '';
  return path.join(conversationsDir, `${cascadeId}.db`);
}
