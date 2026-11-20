import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  TokenPricingManager,
  accumulateTokenCost,
  normalizePricingModel,
  resolveContextTier,
} from '../src/token-pricing.mjs';

test('normalizePricingModel maps Antigravity slugs and display labels to canonical models', () => {
  assert.equal(normalizePricingModel('gemini-4-neon', 'Gemini 4 Neon (High)'), 'gemini-4-neon');
  assert.equal(normalizePricingModel('gemini-pro-orchestrator-g1-pro', 'Orchestrator (Neon)'), 'gemini-4-neon');
  assert.equal(normalizePricingModel('', 'Orchestrator (Neon)'), 'gemini-4-neon');
  assert.equal(normalizePricingModel('gemini-4-argon-g', 'Gemini 4 Argon (High)'), 'gemini-4-argon');
  assert.equal(normalizePricingModel('gemini-4-argon-trial', ''), 'gemini-4-argon');
  assert.equal(normalizePricingModel('gemini-pro-orchestrator-g1-pro', 'Orchestrator (Argon)'), 'gemini-4-argon');
  assert.equal(normalizePricingModel('gemini-4-carbon', 'Orchestrator (Carbon)'), 'gemini-4-carbon');
  assert.equal(normalizePricingModel('gemini-flash-worker-agy', 'Gemini 4 Hydrogen (Orchestrator)'), 'gemini-4-hydrogen');
  assert.equal(normalizePricingModel('gemini-3.8-flash-n', ''), 'gemini-3.8-flash');
  assert.equal(normalizePricingModel('gemini-3.8-flash-exp-a', ''), 'gemini-3.8-flash');
  assert.equal(normalizePricingModel('gemini-3-flash-a', 'Gemini 3.5 Flash (High)'), 'gemini-3.5-flash');
  assert.equal(normalizePricingModel('gemini-default', 'Gemini 3.5 Flash (Low)'), 'gemini-3.5-flash');
  assert.equal(normalizePricingModel('gemini-pro-default', 'Gemini 3.1 Pro (High)'), 'gemini-3.1-pro');
  assert.equal(normalizePricingModel('', 'Claude Opus 5.5 (High)'), 'claude-opus-5.5');
  assert.equal(normalizePricingModel('claude-opus-4-6-thinking', ''), 'claude-opus-4.6');
  assert.equal(normalizePricingModel('', 'Claude Sonnet 4.6 (Thinking)'), 'claude-sonnet-4.6');
  assert.equal(normalizePricingModel('MODEL_OPENAI_GPT_OSS_120B_MEDIUM', 'GPT-OSS 120B (Medium)'), 'gpt-oss-120b');
});

test('TokenPricingManager calculates single-model, long-context, multi-model, and cumulative CNY costs', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-pricing-'));
  const sampleHtml = `
    <table>
      <tr class="first">
        <td>2026-11-18</td>
        <td>671.18</td>
      </tr>
    </table>
  `;
  const pm = new TokenPricingManager({
    stateDir: tmpDir,
    refreshOnInitialize: false,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => sampleHtml,
    }),
  });
  await pm.initialize();
  await pm.refreshExchangeRate({ force: true });
  assert.equal(pm.exchangeRate.fallback, false);
  assert.equal(pm.exchangeRate.date, '2026-11-18');
  assert.ok(Math.abs(pm.exchangeRate.rate - 6.7118) < 1e-6);

  // Verify Gemini 3.1 Pro context tiering (> 200k => long)
  assert.equal(resolveContextTier('gemini-pro-default', 150_000, 'Gemini 3.1 Pro (High)'), 'short');
  assert.equal(resolveContextTier('gemini-pro-default', 250_000, 'Gemini 3.1 Pro (High)'), 'long');
  assert.equal(resolveContextTier('gemini-4-argon-g', 350_000, 'Gemini 4 Argon (High)'), 'standard');

  const payload = pm.enrichConversationPayload({
    cascadeId: 'test',
    hasData: true,
    turns: [
      // Turn 0: cancelled before any LLM call -> should not mark subsequent turns pending
      {
        turnIndex: 0,
        completed: true,
        totalTokens: 0,
        segments: [],
      },
      // Turn 1: multi-model Orchestrator Argon + Worker Hydrogen
      {
        turnIndex: 1,
        completed: true,
        model: 'gemini-4-hydrogen',
        modelLabel: 'Gemini 4 Hydrogen (Orchestrator)',
        inputTokens: 2_000_000,
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 200_000,
        thinkingTokens: 100_000,
        responseTokens: 100_000,
        totalTokens: 2_200_000,
        segments: [
          {
            model: 'gemini-pro-orchestrator-g1-pro',
            modelLabel: 'Orchestrator (Argon)',
            contextTier: 'standard',
            usage: {
              inputTokens: 1_000_000,
              uncachedInputTokens: 500_000, // 0.5M * $2.0 = $1.00
              cachedInputTokens: 500_000, // 0.5M * $0.1 = $0.05
              outputTokens: 100_000, // 0.1M * $10.0 = $1.00 => $2.05
              thinkingTokens: 50_000,
              responseTokens: 50_000,
              totalTokens: 1_100_000,
            },
          },
          {
            model: 'gemini-flash-worker-agy',
            modelLabel: 'Gemini 4 Hydrogen (Orchestrator)',
            contextTier: 'standard',
            usage: {
              inputTokens: 1_000_000,
              uncachedInputTokens: 500_000, // 0.5M * $1.5 = $0.75
              cachedInputTokens: 500_000, // 0.5M * $0.075 = $0.0375
              outputTokens: 100_000, // 0.1M * $7.5 = $0.75 => $1.5375
              thinkingTokens: 50_000,
              responseTokens: 50_000,
              totalTokens: 1_100_000,
            },
          },
        ],
      },
      // Turn 2: Claude Opus 4.6
      {
        turnIndex: 2,
        completed: true,
        model: 'claude-opus-4-6-thinking',
        modelLabel: 'Claude Opus 4.6 (Thinking)',
        inputTokens: 1_000_000,
        uncachedInputTokens: 200_000, // 0.2M * $5.0 = $1.00
        cachedInputTokens: 800_000, // 0.8M * $0.5 = $0.40
        outputTokens: 40_000, // 0.04M * $25.0 = $1.00 => $2.40
        thinkingTokens: 20_000,
        responseTokens: 20_000,
        totalTokens: 1_040_000,
        segments: [
          {
            model: 'claude-opus-4-6-thinking',
            modelLabel: 'Claude Opus 4.6 (Thinking)',
            contextTier: 'standard',
            usage: {
              inputTokens: 1_000_000,
              uncachedInputTokens: 200_000,
              cachedInputTokens: 800_000,
              outputTokens: 40_000,
              thinkingTokens: 20_000,
              responseTokens: 20_000,
              totalTokens: 1_040_000,
            },
          },
        ],
      },
    ],
  });

  const c1 = payload.turns[1].cost;
  assert.equal(c1.available, true);
  assert.equal(c1.normalizedModel, 'multiple');
  assert.equal(c1.tiers.length, 2);
  assert.ok(Math.abs(c1.total - 3.5875) < 1e-9);
  assert.ok(Math.abs(c1.totalCny - 3.5875 * 6.7118) < 1e-6);
  assert.equal(c1.cumulativeAvailable, true);

  const c2 = payload.turns[2].cost;
  assert.equal(c2.available, true);
  assert.equal(c2.normalizedModel, 'claude-opus-4.6');
  assert.ok(Math.abs(c2.total - 2.4) < 1e-9);
  assert.equal(c2.cumulativeAvailable, true);
  assert.ok(Math.abs(c2.cumulativeCny - (3.5875 + 2.4) * 6.7118) < 1e-6);

  // Unknown segment poisons turn aggregate rather than returning partial cost
  const poisoned = accumulateTokenCost(c2, { available: false, requestedModel: 'mystery-model', reason: '未知模型' });
  assert.equal(poisoned.available, false);

  // Verify Gemini 4 Neon pricing ($3.00 input / $0.15 cache read / $15.00 output)
  const neonCost = pm.calculate(
    'gemini-4-neon',
    { inputTokens: 1_500_000, uncachedInputTokens: 500_000, cachedInputTokens: 1_000_000, outputTokens: 100_000 },
    { modelLabel: 'Gemini 4 Neon (High)' }
  );
  assert.equal(neonCost.available, true);
  assert.equal(neonCost.normalizedModel, 'gemini-4-neon');
  assert.ok(Math.abs(neonCost.total - (1.5 + 0.15 + 1.5)) < 1e-9);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
