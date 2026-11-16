import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AuditLog,
  InMemoryMemoryProvider,
  MemoryPolicyEngine,
  RPMemoryAdapter,
} from '../../src/index.js';

test('RPMemoryAdapter isolates separate chats, duplicate cards, group chats, and branches, and preserves host messages', async () => {
  const provider = new InMemoryMemoryProvider();
  const auditLog = new AuditLog();
  const rp = new RPMemoryAdapter({ provider, auditLog, memoryEnabled: true });

  const chat1 = { runtimeInstanceId: 'st-1', characterId: 'alice', chatId: 'chat-1', branchId: 'main' };
  const chat2SameCard = { runtimeInstanceId: 'st-1', characterId: 'alice', chatId: 'chat-2', branchId: 'main' };
  const duplicateCardOtherHost = { runtimeInstanceId: 'st-2', characterId: 'alice', chatId: 'chat-1', branchId: 'main' };
  const altBranch = { runtimeInstanceId: 'st-1', characterId: 'alice', chatId: 'chat-1', branchId: 'branch-b' };

  await provider.writeRecord({
    id: 'ep_chat1',
    kind: 'episodic',
    scope: rp.deriveRpScope(chat1),
    content: 'Alice gave the silver locket to the traveler.',
    epistemic_status: 'observed',
  });

  // Upsert versioned narrative state in chat1
  const state1 = await rp.upsertNarrativeState(chat1, {
    location: 'Harbor Pier',
    participants: ['Alice', 'Traveler'],
    open_threads: ['Deliver silver locket'],
  }, { sourceRefs: ['ep_chat1'] });
  assert.equal(state1.version, 1);

  const originalMessages = [
    { role: 'system', content: 'Character Card: Alice' },
    { role: 'user', content: 'Where is the silver locket?' },
  ];

  // Authorized chat1 retrieves relevant memory while preserving original message order
  const turn1 = await rp.prepareTurn({
    hostCtx: chat1,
    messages: originalMessages,
    queryText: 'silver locket',
  });
  assert.equal(turn1.mode, 'orchestrated');
  assert.deepEqual(turn1.messages, originalMessages);
  assert.ok(turn1.retrievedCount >= 1);
  assert.match(turn1.memoryBlock, /silver locket/);

  // Separate chat, duplicate card in another runtime, and alternate branch all see 0 records
  for (const isolatedCtx of [chat2SameCard, duplicateCardOtherHost, altBranch]) {
    const isolatedTurn = await rp.prepareTurn({
      hostCtx: isolatedCtx,
      messages: originalMessages,
      queryText: 'silver locket',
    });
    assert.equal(isolatedTurn.retrievedCount, 0);
    assert.equal(isolatedTurn.memoryBlock, '');
  }

  // No-memory / passthrough mode
  const passthrough = await rp.prepareTurn({
    hostCtx: chat1,
    messages: originalMessages,
    queryText: 'silver locket',
    memoryEnabled: false,
  });
  assert.equal(passthrough.mode, 'passthrough');
  assert.equal(passthrough.memoryBlock, '');
  assert.equal(passthrough.injectedTokens, 0);
});

test('RPMemoryAdapter falls back safely on provider outage and MemoryPolicyEngine enforces opt-in & archival forgetting', async () => {
  const brokenProvider = {
    async queryRecords() {
      throw new Error('storage_offline');
    },
  };
  const auditLog = new AuditLog();
  const rpBroken = new RPMemoryAdapter({ provider: brokenProvider, auditLog, memoryEnabled: true });
  const msgs = [{ role: 'user', content: 'Hello' }];

  const fallback = await rpBroken.prepareTurn({
    hostCtx: { characterId: 'alice', chatId: 'chat-1' },
    messages: msgs,
    queryText: 'Hello',
  });
  assert.equal(fallback.mode, 'passthrough');
  assert.equal(fallback.fallbackReason, 'provider_error');
  assert.deepEqual(fallback.messages, msgs);

  // MemoryPolicyEngine opt-in default & archival forgetting (never deletes raw episodic)
  const provider = new InMemoryMemoryProvider();
  const policyDisabled = new MemoryPolicyEngine({ provider }); // default enabled: false
  const skipEncode = await policyDisabled.encodeEpisodic({
    content: 'Should not be stored when disabled',
    scope: { tenant_id: 't1', chat_id: 'c1' },
  });
  assert.equal(skipEncode.stored, false);
  assert.equal(skipEncode.reason, 'disabled');

  const policy = new MemoryPolicyEngine({ provider, enabled: true });
  const scope = { tenant_id: 't1', chat_id: 'c1' };
  const ep = await policy.encodeEpisodic({ content: 'Important raw event', scope });
  assert.equal(ep.stored, true);

  // Forgetting policy refuses to archive/delete raw episodic records
  const archEp = await policy.archiveDerivedRecord(ep.record.id, scope);
  assert.equal(archEp.archived, false);

  // Derived summary can be archived without deleting raw episodic
  const sum = await provider.writeRecord({
    id: 'sum_1',
    kind: 'summary',
    scope,
    content: 'Derived summary of raw event',
    epistemic_status: 'inferred',
    source_refs: [ep.record.id],
  });
  const archSum = await policy.archiveDerivedRecord(sum.id, scope);
  assert.equal(archSum.archived, true);
  assert.equal(archSum.record.status, 'archived');
  assert.ok(await provider.readRecord(ep.record.id, scope));
});
