import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { InvocationController, PRIORITY_LEVELS } from '../../src/core/invocation-controller.js';
import { ToolResultRetentionStore } from '../../src/core/tool-output-retention.js';
import { NoopStateProvider, CompanionStateProvider } from '../../src/plugins/state-provider.js';
import { SingleCompressorCoordinator } from '../../src/plugins/compression.js';

test('InvocationController filters low-value wakes while never dropping urgent events', async () => {
  const ctrl = new InvocationController({
    config: { dedupeWindowMs: 5000, cooldownMs: 60_000, idleThresholdMs: 60_000, baseBackoffMs: 120_000 },
  });
  const t0 = 1_000_000;

  // 1. Low-priority patrol allowed once
  const first = await ctrl.evaluateWake({ conversationKey: 'c1', priority: PRIORITY_LEVELS.LOW_PROACTIVE, now: t0 });
  assert.equal(first.allow, true);
  ctrl.recordWakeOutcome('c1', { producedOutput: false, now: t0 });

  // 2. Subsequent patrol within cooldown/backoff blocked
  const second = await ctrl.evaluateWake({ conversationKey: 'c1', priority: PRIORITY_LEVELS.LOW_PROACTIVE, now: t0 + 10_000 });
  assert.equal(second.allow, false);

  // 3. Urgent event during cooldown + quiet hours MUST bypass and succeed
  const urgent = await ctrl.evaluateWake({
    conversationKey: 'c1',
    priority: PRIORITY_LEVELS.URGENT,
    activeHoursOk: false,
    now: t0 + 11_000,
  });
  assert.equal(urgent.allow, true);
  assert.equal(urgent.reason, 'urgent_bypass_channel');

  // 4. Duplicate event within dedupeWindowMs coalesced
  const d1 = await ctrl.evaluateWake({ conversationKey: 'c2', dedupeKey: 'webhook-42', now: t0 });
  const d2 = await ctrl.evaluateWake({ conversationKey: 'c2', dedupeKey: 'webhook-42', now: t0 + 500 });
  assert.equal(d1.allow, true);
  assert.equal(d2.allow, false);
  assert.equal(d2.reason, 'deduplicated');
});

test('ToolResultRetentionStore retains large output and recovers exact lines & keyword matches', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uao-retention-'));
  try {
    const store = new ToolResultRetentionStore({ dir: tmpDir, maxInlineChars: 200, headChars: 60, tailChars: 60 });
    const lines = Array.from({ length: 120 }, (_, i) => `line-${i + 1}: payload ${i === 77 ? 'CRITICAL_BUG_FOUND' : 'ok'}`);
    const raw = lines.join('\n');

    const retained = store.retain({ toolName: 'pytest', rawOutput: raw });
    assert.equal(retained.retained, true);
    assert.ok(retained.inlineText.length < raw.length);
    assert.ok(retained.inlineText.includes(retained.refId));

    const byRange = store.retrieve(retained.refId, { startLine: 77, endLine: 79 });
    assert.equal(byRange.found, true);
    assert.ok(byRange.content.includes('CRITICAL_BUG_FOUND'));

    const byQuery = store.retrieve(retained.refId, { query: 'CRITICAL_BUG' });
    assert.equal(byQuery.matches, 1);
    assert.ok(byQuery.content.includes('78: line-78'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('StateProvider works statelessly with NoopStateProvider and optionally with CompanionStateProvider', async () => {
  const noop = new NoopStateProvider();
  const s1 = await noop.getContextSignals({ conversationKey: 'any' });
  assert.equal(s1.promptHints.length, 0);
  assert.equal(s1.invocationBias, 0);

  const companion = new CompanionStateProvider({
    emotionManager: { getDecayed: () => ({ valence: 0.4, arousal: 0.5, needs: {}, purpose: 'none' }) },
  });
  const s2 = await companion.getContextSignals({ conversationKey: 'private:1' });
  assert.ok(typeof s2.invocationBias === 'number');
});

test('SingleCompressorCoordinator prevents double compression and enforces quality/cache gates', async () => {
  const calls = [];
  const coordinator = new SingleCompressorCoordinator({ minQualityScore: 72 });
  coordinator.register({
    name: 'mock-low-quality',
    supportedContentTypes: ['tool_output'],
    isAvailable: async () => true,
    compress: async ({ content }) => {
      calls.push('mock-low-quality');
      return { ok: true, content: content.slice(0, 10), qualityScore: 50 };
    },
  });
  coordinator.register({
    name: 'mock-good',
    supportedContentTypes: ['tool_output'],
    isAvailable: async () => true,
    compress: async () => {
      calls.push('mock-good');
      return { ok: true, content: 'short summary', qualityScore: 88 };
    },
  });

  // Quality below 72 triggers safe fallback to original!
  const original = 'X'.repeat(500);
  const rejected = await coordinator.compressOnce(original, { contentType: 'tool_output' });
  assert.equal(rejected.applied, false);
  assert.equal(rejected.content, original);
  assert.equal(rejected.fallbackReason, 'quality_below_72');

  // Guard blocks double compression if alreadyCompressedBy is set
  const guarded = await coordinator.compressOnce('already compressed', { alreadyCompressedBy: 'headroom' });
  assert.equal(guarded.applied, false);
  assert.equal(guarded.fallbackReason, 'already_compressed_guard');
});
