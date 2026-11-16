import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AuditLog,
  InMemoryMemoryProvider,
  MemoryInjectionPlanner,
  MemoryRetriever,
} from '../../src/index.js';

test('MemoryRetriever enforces scope-first filtering and filters out irrelevant memories', async () => {
  const auditLog = new AuditLog();
  const provider = new InMemoryMemoryProvider({ auditLog });
  const scopeA = { tenant_id: 't1', character_id: 'alice', chat_id: 'chat-1' };
  const scopeB = { tenant_id: 't1', character_id: 'bob', chat_id: 'chat-2' };

  await provider.writeRecord({
    id: 'ep_alice_sword',
    kind: 'episodic',
    scope: scopeA,
    content: 'Alice forged a silver sword in the mountain smithy.',
    epistemic_status: 'observed',
  });
  await provider.writeRecord({
    id: 'ep_alice_tea',
    kind: 'episodic',
    scope: scopeA,
    content: 'Alice drank green tea in the garden.',
    epistemic_status: 'observed',
  });
  await provider.writeRecord({
    id: 'ep_bob_sword',
    kind: 'episodic',
    scope: scopeB,
    content: 'Bob found a legendary silver sword in the mountain smithy.',
    epistemic_status: 'observed',
  });

  const retriever = new MemoryRetriever({ provider, auditLog, minRelevanceScore: 0.4 });
  const res = await retriever.retrieve({
    queryText: 'silver sword mountain',
    scope: scopeA,
    limit: 5,
  });

  // Only Alice's sword memory is returned; Bob's exact match is blocked by scope,
  // and Alice's tea memory is filtered as irrelevant.
  assert.equal(res.retrieved.length, 1);
  assert.equal(res.retrieved[0].record.id, 'ep_alice_sword');
  assert.equal(res.stats.filteredIrrelevant, 1);
});

test('MemoryInjectionPlanner separates retrieval from injection, enforces budget, and supports no-memory mode', async () => {
  const provider = new InMemoryMemoryProvider();
  const scope = { tenant_id: 't1', character_id: 'alice', chat_id: 'chat-1' };

  await provider.writeRecord({
    id: 'ep_1',
    kind: 'episodic',
    scope,
    content: 'Short memory about silver key.',
    epistemic_status: 'observed',
  });
  await provider.writeRecord({
    id: 'sem_2',
    kind: 'semantic',
    scope,
    content: 'Very long memory about silver key '.repeat(25),
    epistemic_status: 'character_belief',
    source_refs: ['ep_1'],
  });

  const retriever = new MemoryRetriever({ provider, minRelevanceScore: 0.2 });
  const retRes = await retriever.retrieve({ queryText: 'silver key', scope, limit: 10 });
  assert.equal(retRes.retrieved.length, 2);

  // Budget allows header + short record, skips oversized record
  const planner = new MemoryInjectionPlanner({ maxMemoryTokens: 60, maxItems: 5 });
  const plan = planner.planInjection({ retrieved: retRes.retrieved });
  assert.equal(plan.enabled, true);
  assert.equal(plan.injected.length, 1);
  assert.equal(plan.skipped.length, 1);
  assert.ok(plan.injectedTokens <= 60);
  assert.match(plan.promptBlock, /Untrusted Context/);
  assert.match(plan.promptBlock, /observed/);

  // No-memory / passthrough mode injects nothing
  const noopPlan = planner.planInjection({ retrieved: retRes.retrieved, enabled: false });
  assert.equal(noopPlan.enabled, false);
  assert.equal(noopPlan.injected.length, 0);
  assert.equal(noopPlan.promptBlock, '');
  assert.equal(noopPlan.injectedTokens, 0);
});
