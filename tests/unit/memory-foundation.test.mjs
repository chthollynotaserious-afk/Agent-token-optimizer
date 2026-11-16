import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AuditLog,
  InMemoryMemoryProvider,
  canAccessMemoryScope,
  createMemoryRecord,
  deriveScopeKey,
} from '../../src/index.js';

test('Memory Foundation enforces strict RP & multi-tenant fail-closed scope isolation', async () => {
  const auditLog = new AuditLog();
  const provider = new InMemoryMemoryProvider({ auditLog });

  const scopeCharAChat1 = {
    tenant_id: 't1',
    runtime_instance_id: 'st-local',
    character_id: 'alice',
    chat_id: 'chat-1',
    branch_id: 'main',
  };
  const scopeCharAChat2 = { ...scopeCharAChat1, chat_id: 'chat-2' };
  const scopeCharABranch2 = { ...scopeCharAChat1, branch_id: 'alt-timeline' };
  const scopeCharB = { ...scopeCharAChat1, character_id: 'bob' };
  const scopeIncomplete = { tenant_id: 't1', character_id: 'alice' };

  const rec = await provider.writeRecord({
    id: 'ep_1',
    kind: 'episodic',
    scope: scopeCharAChat1,
    content: 'Alice met Bob at the harbor. Bearer secret-token-xyz',
    epistemic_status: 'observed',
    source_refs: ['msg_001'],
  });

  // Secret redaction on write
  assert.ok(!rec.content.includes('secret-token-xyz'));
  assert.match(rec.content, /\[REDACTED\]/);

  // Same scope succeeds
  const hit = await provider.readRecord('ep_1', scopeCharAChat1);
  assert.equal(hit?.id, 'ep_1');

  // Cross-chat, cross-branch, cross-character, and incomplete scopes all fail-closed
  assert.equal(await provider.readRecord('ep_1', scopeCharAChat2), null);
  assert.equal(await provider.readRecord('ep_1', scopeCharABranch2), null);
  assert.equal(await provider.readRecord('ep_1', scopeCharB), null);
  assert.equal(await provider.readRecord('ep_1', scopeIncomplete), null);
  assert.equal(canAccessMemoryScope(rec, {}), false);
  assert.equal(deriveScopeKey({}), null);

  // Scope-first queryBlocks cross-scope leakage even on matching keyword
  const crossHits = await provider.queryRecords({ text: 'harbor' }, scopeCharAChat2);
  assert.equal(crossHits.length, 0);
  const validHits = await provider.queryRecords({ text: 'harbor' }, scopeCharAChat1);
  assert.equal(validHits.length, 1);
});

test('Memory Foundation protects raw episodic records and versions derived updates', async () => {
  const provider = new InMemoryMemoryProvider();
  const scope = { tenant_id: 't1', character_id: 'alice', chat_id: 'chat-1' };

  await provider.writeRecord({
    id: 'ep_raw',
    kind: 'episodic',
    scope,
    content: 'User promised to return tomorrow.',
    epistemic_status: 'observed',
  });

  // Raw episodic record cannot be overwritten by derived update
  await assert.rejects(
    () => provider.updateDerivedRecord('ep_raw', { content: 'Summary overwrite', reason: 'test' }, 1, scope),
    /DerivedUpdateDenied/
  );

  // Derived record requires source_refs and preserves version history
  await assert.rejects(
    () => provider.writeRecord({ kind: 'semantic', scope, content: 'Missing source ref', epistemic_status: 'inferred' }),
    /source_ref/
  );

  const sem = await provider.writeRecord({
    id: 'sem_1',
    kind: 'semantic',
    scope,
    content: 'Alice believes the user will return tomorrow.',
    epistemic_status: 'character_belief',
    source_refs: ['ep_raw'],
  });
  assert.equal(sem.version, 1);

  const updated = await provider.updateDerivedRecord(
    'sem_1',
    { content: 'User returned as promised.', epistemic_status: 'observed', reason: 'new_evidence' },
    1,
    scope
  );
  assert.equal(updated.version, 2);
  assert.equal(updated.epistemic_status, 'observed');

  // Optimistic version conflict rejected without corrupting state
  await assert.rejects(
    () => provider.updateDerivedRecord('sem_1', { content: 'stale', reason: 'stale' }, 1, scope),
    /MemoryVersionConflict/
  );

  const history = await provider.getVersionHistory('sem_1', scope);
  assert.equal(history.length, 1);
  assert.equal(history[0].version, 1);
  assert.equal(history[0].content, 'Alice believes the user will return tomorrow.');
});

test('Memory Foundation supports auditable deletion propagation and integrity-checked backup/restore', async () => {
  const auditLog = new AuditLog();
  const provider = new InMemoryMemoryProvider({ auditLog });
  const scope = { tenant_id: 't1', character_id: 'alice', chat_id: 'chat-1' };

  await provider.writeRecord({
    id: 'ep_1',
    kind: 'episodic',
    scope,
    content: 'Private secret diary entry',
    epistemic_status: 'observed',
  });
  await provider.writeRecord({
    id: 'sum_1',
    kind: 'summary',
    scope,
    content: 'Summary referencing ep_1',
    epistemic_status: 'inferred',
    source_refs: ['ep_1'],
  });

  // Export backup before deletion
  const bundle = await provider.exportBundle(scope);
  assert.equal(bundle.count, 2);
  assert.ok(bundle.bundleHash);

  // Auditable delete propagates to derived summary and does not log private content
  const delRes = await provider.deleteRecords({ ids: ['ep_1'] }, scope, { actor: 'user', reason: 'user_request' });
  assert.equal(delRes.totalAffected, 2);
  assert.equal(await provider.readRecord('ep_1', scope), null);
  assert.equal(await provider.readRecord('sum_1', scope), null);

  const deleteAudits = auditLog.query({ category: 'memory' }).filter((e) => e.action === 'delete');
  assert.equal(deleteAudits.length, 1);
  assert.ok(!JSON.stringify(deleteAudits[0]).includes('Private secret diary entry'));

  // Tampered bundle is rejected
  const tampered = structuredClone(bundle);
  tampered.records[0].content = 'Tampered!';
  await assert.rejects(() => provider.importBundle(tampered), /MemoryImportIntegrityError/);

  // Valid bundle restores into a fresh provider
  const restoredProvider = new InMemoryMemoryProvider();
  const impRes = await restoredProvider.importBundle(bundle);
  assert.equal(impRes.imported, 2);
  assert.equal((await restoredProvider.readRecord('ep_1', scope))?.id, 'ep_1');
});
