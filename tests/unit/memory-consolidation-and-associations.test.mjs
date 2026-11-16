import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AuditLog,
  InMemoryMemoryProvider,
  MemoryAssociationIndex,
  MemoryConsolidator,
  UniversalTokenLedger,
} from '../../src/index.js';

test('MemoryConsolidator runs zero-LLM consolidation, preserves raw episodic records, and builds scoped associations', async () => {
  const provider = new InMemoryMemoryProvider();
  const associationIndex = new MemoryAssociationIndex();
  const auditLog = new AuditLog();
  const scopeA = { tenant_id: 't1', character_id: 'alice', chat_id: 'chat-1' };
  const scopeB = { tenant_id: 't1', character_id: 'bob', chat_id: 'chat-2' };

  await provider.writeRecord({
    id: 'ep_1',
    kind: 'episodic',
    scope: scopeA,
    content: 'Alice visited the northern library.',
    epistemic_status: 'observed',
  });

  const consolidator = new MemoryConsolidator({ provider, associationIndex, auditLog });
  const res = await consolidator.consolidateScope({ scope: scopeA, claimKey: 'visit' });
  assert.equal(res.ok, true);
  assert.equal(res.created, 1);

  // Raw episodic record remains intact
  const raw = await provider.readRecord('ep_1', scopeA);
  assert.equal(raw.content, 'Alice visited the northern library.');

  // Association edge exists in scopeA and is invisible in scopeB
  const edgesA = associationIndex.queryNeighbors('ep_1', scopeA);
  assert.equal(edgesA.length, 1);
  assert.equal(edgesA[0].relation, 'derived_from');
  assert.equal(associationIndex.queryNeighbors('ep_1', scopeB).length, 0);

  // Deletion propagation removes association edges
  const removed = associationIndex.removeEdgesForRecords(['ep_1'], scopeA);
  assert.equal(removed, 1);
  assert.equal(associationIndex.queryNeighbors('ep_1', scopeA).length, 0);
});

test('MemoryConsolidator preserves conflicts, meters optional model extractor, and recovers cleanly on failure', async () => {
  const provider = new InMemoryMemoryProvider();
  const ledger = new UniversalTokenLedger();
  const auditLog = new AuditLog();
  const scope = { tenant_id: 't1', character_id: 'alice', chat_id: 'chat-1' };

  await provider.writeRecord({
    id: 'ep_obs',
    kind: 'episodic',
    scope,
    content: 'Alice prefers black coffee.',
    epistemic_status: 'observed',
  });

  const consolidator = new MemoryConsolidator({ provider, ledger, auditLog, maxRetries: 1 });

  // 1. Metered model-assisted extraction succeeds
  const res1 = await consolidator.consolidateScope({
    scope,
    model: 'gpt-4o-mini',
    extractor: async () => ({
      model: 'gpt-4o-mini',
      observed: true,
      usage: { prompt_tokens: 200, completion_tokens: 40 },
      claims: [
        {
          key: 'coffee_pref',
          kind: 'semantic',
          content: 'Alice prefers black coffee.',
          epistemic_status: 'observed',
          source_refs: ['ep_obs'],
        },
      ],
    }),
  });
  assert.equal(res1.ok, true);
  assert.equal(res1.created, 1);
  assert.equal(ledger.summary().calls, 1);

  // 2. Conflicting evidence preserves both and marks disputed
  const res2 = await consolidator.consolidateScope({
    scope,
    extractor: async () => ({
      claims: [
        {
          key: 'coffee_pref',
          kind: 'semantic',
          content: 'Alice only drinks herbal tea.',
          epistemic_status: 'inferred',
          source_refs: ['ep_obs'],
        },
      ],
    }),
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.disputed, 1);
  const derivedList = await provider.queryRecords({ kind: 'semantic' }, scope);
  assert.equal(derivedList[0].epistemic_status, 'disputed');
  assert.match(derivedList[0].content, /Conflicting evidence/);

  // 3. Failing extractor retries and leaves last known-good state intact
  let attempts = 0;
  const res3 = await consolidator.consolidateScope({
    scope,
    extractor: async () => {
      attempts += 1;
      throw new Error('upstream_timeout');
    },
  });
  assert.equal(attempts, 2);
  assert.equal(res3.ok, false);
  assert.equal(res3.preservedLastKnownGood, true);
  const afterFail = await provider.queryRecords({ kind: 'semantic' }, scope);
  assert.equal(afterFail[0].version, 2);

  // 4. Background queue runs off critical path
  const queued = consolidator.enqueueConsolidation({ scope, claimKey: 'bg_summary' });
  assert.equal(queued.queued, true);
  const bgResult = await queued.promise;
  assert.equal(bgResult.ok, true);
});
