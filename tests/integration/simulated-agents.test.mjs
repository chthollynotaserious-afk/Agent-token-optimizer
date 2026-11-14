import assert from 'node:assert/strict';
import test from 'node:test';
import { UniversalAgentOptimizer } from '../../src/core/optimizer.js';
import { OpenAICompatibleAdapter } from '../../src/adapters/openai-compatible.js';
import { AnthropicAdapter } from '../../src/adapters/anthropic.js';
import { CustomAgentAdapter, MCPToolAdapter, LangGraphAdapter } from '../../src/adapters/custom-agent.js';
import { PRIORITY_LEVELS } from '../../src/core/invocation-controller.js';

test('Simulated Chat Agent & Coding Agent work end-to-end via OpenAI & Anthropic adapters', async () => {
  const optimizer = new UniversalAgentOptimizer({
    retention: { maxInlineChars: 300, headChars: 80, tailChars: 80 },
    toolGovernanceConfig: {
      deadTools: ['deprecated_noop'],
      scenePolicies: {
        coding: { allow: ['fs_read', 'run_tests'] },
      },
    },
  });

  // 1. Chat Agent (OpenAI-compatible)
  const chatAdapter = new OpenAICompatibleAdapter({ optimizer, provider: 'openai' });
  const chatReq = await chatAdapter.transformRequest(
    {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a concise assistant.' },
        { role: 'user', content: 'Hello!' },
      ],
    },
    { agentId: 'chat-bot', sessionId: 'chat-1', conversationKey: 'chat:1' }
  );
  assert.equal(chatReq.payload.messages[0].role, 'system');
  await chatAdapter.recordResponse(
    { agentId: 'chat-bot', sessionId: 'chat-1', conversationKey: 'chat:1', model: 'gpt-4o-mini' },
    { usage: { prompt_tokens: 120, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } } },
    chatReq.prepared
  );

  // 2. Coding Agent (Anthropic + cache_control + oversized tool output retention & recovery)
  const claudeAdapter = new AnthropicAdapter({ optimizer });
  const hugeTestLog = Array.from({ length: 40 }, (_, i) => `test_${i + 1}: ${i === 24 ? 'FAIL assertion at line 42' : 'PASS'}`).join('\n');
  const codeReq = await claudeAdapter.transformRequest(
    {
      model: 'claude-sonnet-4',
      system: [{ type: 'text', text: 'You are a coding agent.', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'fs_read' }, { name: 'run_tests' }, { name: 'deprecated_noop' }, { name: 'billing_admin' }],
      messages: [
        { role: 'user', content: 'Run tests' },
        { role: 'tool', content: hugeTestLog },
      ],
    },
    { agentId: 'coder', sessionId: 'code-1', conversationKey: 'repo:uao', scene: 'coding' }
  );

  assert.deepEqual(codeReq.payload.tools.map((t) => t.name), ['fs_read', 'run_tests']);
  assert.equal(codeReq.payload.system[0].cache_control.type, 'ephemeral');
  const retainedToolMsg = codeReq.payload.messages[1].content;
  assert.ok(retainedToolMsg.includes('Retained Tool Output'));
  const refMatch = /refId=(tr_[a-f0-9]+)/.exec(retainedToolMsg);
  assert.ok(refMatch);
  const recovered = optimizer.retrieveToolResult(refMatch[1], { query: 'FAIL assertion' });
  assert.equal(recovered.matches, 1);
  assert.ok(recovered.content.includes('FAIL assertion at line 42'));

  await claudeAdapter.recordResponse(
    { agentId: 'coder', sessionId: 'code-1', conversationKey: 'repo:uao', model: 'claude-sonnet-4' },
    { usage: { input_tokens: 200, cache_read_input_tokens: 1000, output_tokens: 80 } },
    codeReq.prepared
  );

  const metrics = optimizer.getMetrics();
  assert.equal(metrics.ledger.calls, 2);
  assert.ok(metrics.ledger.totalCost > 0);
});

test('Simulated Tool-calling, Long-running, and Multi-agent Workflow operate cleanly without Denia', async () => {
  const optimizer = new UniversalAgentOptimizer({
    lifecycleLimits: { defaultMaxTurns: 2 },
    invocationConfig: { cooldownMs: 60_000, idleThresholdMs: 0 },
    retention: { maxInlineChars: 150, headChars: 40, tailChars: 40 },
  });

  // 3. Tool-calling via MCPToolAdapter
  const mcp = new MCPToolAdapter({ optimizer });
  const toolRes = await mcp.wrapToolCall('search_logs', { q: 'err' }, async () => 'LOG_LINE\n'.repeat(50));
  assert.ok(toolRes.retainedRefId);
  assert.ok(toolRes.content.includes(toolRes.retainedRefId));

  // 4. Long-running Agent via CustomAgentAdapter (triggers Opt-4 skip + Opt-1 rotation)
  const custom = new CustomAgentAdapter({ optimizer, agentId: 'patrol-agent' });
  const now = 5_000_000;
  const run1 = await custom.runTurn(
    {
      conversationKey: 'worker:1',
      sessionId: 'w-s1',
      model: 'deepseek-chat',
      now,
      triggerEvent: { conversationKey: 'worker:1', priority: PRIORITY_LEVELS.NORMAL, now },
      messages: [{ role: 'user', content: 'Check build status' }],
    },
    async () => ({ usage: { prompt_tokens: 500, completion_tokens: 50 } })
  );
  assert.equal(run1.skipped, false);

  // Duplicate patrol within cooldown skipped by Opt-4
  const runSkip = await custom.runTurn(
    {
      conversationKey: 'worker:1',
      now: now + 5000,
      triggerEvent: { conversationKey: 'worker:1', priority: PRIORITY_LEVELS.LOW_PROACTIVE, now: now + 5000 },
      messages: [],
    },
    async () => { throw new Error('Should not invoke LLM on skipped wake'); }
  );
  assert.equal(runSkip.skipped, true);

  // Second real user turn reaches defaultMaxTurns=2 on turn 3 -> triggers rotation
  await custom.runTurn(
    {
      conversationKey: 'worker:1',
      model: 'deepseek-chat',
      now: now + 10_000,
      triggerEvent: { conversationKey: 'worker:1', priority: PRIORITY_LEVELS.USER_DIRECT, userMessage: true, now: now + 10_000 },
      messages: [{ role: 'user', content: 'Deploy release v2' }],
    },
    async () => ({ usage: { prompt_tokens: 600, completion_tokens: 60 } })
  );
  const run3 = await custom.runTurn(
    {
      conversationKey: 'worker:1',
      model: 'deepseek-chat',
      now: now + 20_000,
      messages: [{ role: 'user', content: 'Confirm release v2 status' }],
    },
    async (prepared) => {
      assert.equal(prepared.rotated, true);
      assert.ok(prepared.handoffText.includes('Deploy release v2'));
      return { usage: { prompt_tokens: 300, completion_tokens: 40 } };
    }
  );
  assert.equal(run3.skipped, false);

  // 5. Multi-agent Workflow via LangGraphAdapter
  const lg = new LangGraphAdapter({ optimizer, agentId: 'planner-node' });
  const stateAfterPre = await lg.preModelNode({
    threadId: 'wf-99',
    model: 'gpt-4o-mini',
    systemPrompt: 'Coordinate worker agents.',
    messages: [{ role: 'user', content: 'Plan sprint' }],
  });
  assert.ok(stateAfterPre._uaoPrepared);
  await lg.postModelNode(stateAfterPre, { usage: { prompt_tokens: 400, completion_tokens: 100 } });
});
