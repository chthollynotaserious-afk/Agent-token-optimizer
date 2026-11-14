import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolGovernance } from '../../src/core/tool-governance.js';
import { evaluateUniversalDedup, commitUniversalDedupState } from '../../src/core/static-context-dedup.js';
import { canAccessScope, selectUniversalContext } from '../../src/core/context-selector.js';
import { AuditLog } from '../../src/observability/audit-log.js';

test('ToolGovernance removes dead tools, isolates by scene, and detects schema jitter', () => {
  const audit = new AuditLog();
  const gov = new ToolGovernance({
    deadTools: ['legacy_onebot_dead'],
    scenePolicies: {
      chat: { allow: ['web_search', 'memory_lookup'] },
      coding: { allow: ['fs_read', 'fs_edit', 'run_tests'] },
    },
    auditLog: audit,
  });

  const allTools = [
    { name: 'fs_edit', description: 'edit' },
    { name: 'fs_read', description: 'read' },
    { name: 'legacy_onebot_dead', description: 'dead' },
    { name: 'web_search', description: 'search' },
  ];

  const r1 = gov.govern({ sessionId: 's1', scene: 'chat', tools: allTools });
  assert.deepEqual(r1.tools.map((t) => t.name), ['web_search']);
  assert.equal(r1.schemaJitter, false);

  const r2 = gov.govern({ sessionId: 's1', scene: 'coding', tools: allTools });
  assert.deepEqual(r2.tools.map((t) => t.name), ['fs_edit', 'fs_read']);
  assert.equal(r2.schemaJitter, true);
  assert.equal(audit.query({ category: 'tool_governance' }).length, 1);
});

test('evaluateUniversalDedup handles generic static/subBlocks and incremental items', () => {
  const d1 = evaluateUniversalDedup({
    sessionId: 's1',
    staticText: 'System Rules v1',
    subBlocks: { repoMap: 'src/a.js\nsrc/b.js' },
    items: [{ id: 'doc1', line: 'doc 1' }],
    prevState: null,
  });
  assert.equal(d1.canOmitStatic, false);
  assert.equal(d1.staticText, 'System Rules v1');
  const st1 = commitUniversalDedupState(null, d1.pendingCommit, 1000);

  const d2 = evaluateUniversalDedup({
    sessionId: 's1',
    staticText: 'System Rules v1',
    subBlocks: { repoMap: 'src/a.js\nsrc/b.js' },
    items: [{ id: 'doc1', line: 'doc 1' }, { id: 'doc2', line: 'doc 2' }],
    prevState: st1,
  });
  assert.equal(d2.canOmitStatic, true);
  assert.equal(d2.staticText, '');
  assert.equal(Object.keys(d2.emittedSubBlocks).length, 0);
  assert.deepEqual(d2.emittedItems.map((x) => x.id), ['doc2']);
});

test('selectUniversalContext enforces Fail-Closed multi-tenant Scope ACL and redacts secrets', () => {
  const records = [
    { id: 'r1', tenantId: 'acme', scope: 'eng', audience: 'private', text: 'API sk-secret123456789012345', importance: 80 },
    { id: 'r2', tenantId: 'acme', scope: 'hr', audience: 'private', text: 'Salary table', importance: 99 },
    { id: 'r3', tenantId: 'other', scope: 'eng', audience: 'public', text: 'Other tenant', importance: 99 },
    { id: 'r4', tenantId: 'acme', scope: 'eng', audience: 'public', text: 'Shared eng guide', pinned: true },
  ];

  const selected = selectUniversalContext({
    records,
    requestCtx: { tenantId: 'acme', scope: 'eng', isAdmin: false },
    maxChars: 500,
  });

  assert.deepEqual(selected.usedIds, ['r4', 'r1']);
  assert.ok(selected.text.includes('[REDACTED_SECRET]'));
  assert.ok(!selected.text.includes('Salary table'));
  assert.ok(!selected.text.includes('Other tenant'));
  assert.equal(canAccessScope({ tenantId: 'acme', scope: 'eng' }, null), false);
});
