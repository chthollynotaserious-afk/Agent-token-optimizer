import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  UniversalAgentOptimizer,
  UniversalMemoryStore,
  OpenAICompatibleAdapter,
  AnthropicAdapter,
  MCPToolAdapter,
  createProxyServer,
  BUILTIN_TOOL_NAMES,
} from '../../src/index.js';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('UniversalMemoryStore extracts EN/ZH preferences & decisions, persists JSONL, redacts secrets, and isolates scopes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uao-mem-'));
  const memFile = path.join(tmpDir, 'memories.jsonl');
  try {
    const store = new UniversalMemoryStore({ file: memFile });
    const flushRes = await store.flushSession({
      sessionId: 's-1',
      conversationKey: 'user:alice',
      scope: 'user:alice',
      messages: [
        { role: 'user', content: 'Remember: I always prefer dark mode and PostgreSQL on port 5432.' },
        { role: 'user', content: '以后都请用简体中文回复，我偏好简短的总结。' },
        { role: 'assistant', content: 'Configured database endpoint with token sk-secret1234567890abcdef' },
      ],
    });

    assert.equal(flushRes.flushed, true);
    assert.equal(flushRes.savedCount, 3);
    assert.equal(store.hasVerificationToken(flushRes.verificationToken), true);

    // Reload from JSONL disk persistence
    const reloaded = new UniversalMemoryStore({ file: memFile });
    const recallEn = reloaded.recall({ query: 'PostgreSQL port preference', conversationKey: 'user:alice' });
    assert.equal(recallEn.found, true);
    assert.ok(recallEn.text.includes('5432'));

    const recallZh = reloaded.recall({ query: '简体中文 偏好', conversationKey: 'user:alice' });
    assert.equal(recallZh.found, true);
    assert.ok(recallZh.text.includes('简体中文'));

    const recallSecret = reloaded.recall({ query: 'database endpoint', conversationKey: 'user:alice' });
    assert.ok(!recallSecret.text.includes('sk-secret1234567890abcdef'));
    assert.ok(recallSecret.text.includes('[REDACTED_SECRET]'));

    // Fail-Closed ACL: another user/scope must NOT see Alice's private memories
    const blocked = reloaded.recall({ query: 'PostgreSQL', conversationKey: 'user:bob', scope: 'user:bob' });
    assert.equal(blocked.found, false);
    assert.equal(blocked.count, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('UniversalAgentOptimizer auto-extracts & archives memories on rotation and supports custom summarizeFn', async () => {
  const autoOpt = new UniversalAgentOptimizer({
    lifecycleLimits: { defaultMaxTurns: 2 },
  });

  // Turn 1 -> 2 -> 3 triggers rotation without any manual onBeforeRotate hook
  await autoOpt.optimizeRequest({
    conversationKey: 'proj:1',
    sessionId: 'p-s1',
    messages: [{ role: 'user', content: 'We decided to deploy Redis on port 6379 for caching.' }],
    invokeUpstream: async () => ({
      choices: [{ message: { role: 'assistant', content: 'Noted Redis port 6379.' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }),
  });
  await autoOpt.optimizeRequest({
    conversationKey: 'proj:1',
    messages: [{ role: 'user', content: 'Also remember our staging branch is release/v2.' }],
    invokeUpstream: async () => ({
      choices: [{ message: { role: 'assistant', content: 'Saved staging branch release/v2.' } }],
      usage: { prompt_tokens: 120, completion_tokens: 20 },
    }),
  });
  const rotatedTurn = await autoOpt.optimizeRequest({
    conversationKey: 'proj:1',
    autoRecallMemory: true,
    messages: [{ role: 'user', content: 'What port did we choose for Redis?' }],
    invokeUpstream: async () => ({
      choices: [{ message: { role: 'assistant', content: 'Redis uses port 6379.' } }],
      usage: { prompt_tokens: 90, completion_tokens: 15 },
    }),
  });

  assert.equal(rotatedTurn.prepared.rotated, true);
  assert.ok(autoOpt.memoryStore.records.length >= 2);
  assert.equal(rotatedTurn.prepared.recalledMemories.found, true);
  assert.ok(rotatedTurn.prepared.recalledMemories.text.includes('6379'));
  assert.ok(rotatedTurn.prepared.tools.some((t) => (t.function?.name || t.name) === BUILTIN_TOOL_NAMES.RECALL_MEMORY));

  // Custom host extractor plugs cleanly into memoryExtractor
  const customOpt = new UniversalAgentOptimizer({
    memoryExtractor: async () => [{ kind: 'decision', importance: 95, text: 'Host LLM summary: use Bun runtime' }],
  });
  const saved = await customOpt.extractAndSaveMemory({
    conversationKey: 'proj:2',
    messages: [{ role: 'user', content: 'Lets try Bun' }],
  });
  assert.equal(saved.savedCount, 1);
  assert.ok(customOpt.recallMemory({ query: 'Bun', conversationKey: 'proj:2' }).text.includes('Host LLM summary'));
});

test('Adapters, optimizeRequest, and MCPToolAdapter auto-wire retrieval & recall tool loops cleanly', async () => {
  const opt = new UniversalAgentOptimizer({
    retention: { maxInlineChars: 120, headChars: 30, tailChars: 30 },
  });
  await opt.extractAndSaveMemory({
    conversationKey: 'conv:wire',
    messages: [{ role: 'user', content: 'Preference: always format SQL keywords in uppercase.' }],
  });

  const hugeLog = Array.from({ length: 30 }, (_, i) => `row-${i + 1}: ${i === 17 ? 'NEEDLE_TOKEN_FOUND' : 'ok'}`).join('\n');

  // 1. OpenAICompatibleAdapter.runWithTools auto-executes uao_retrieve_tool_output
  const openai = new OpenAICompatibleAdapter({ optimizer: opt });
  let openaiCalls = 0;
  const oaRes = await openai.runWithTools(
    {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'tool', tool_call_id: 'call_ext', content: hugeLog },
        { role: 'user', content: 'Find the needle in the log' },
      ],
    },
    async (payload) => {
      openaiCalls += 1;
      if (openaiCalls === 1) {
        const names = payload.tools.map((t) => t.function.name);
        assert.ok(names.includes(BUILTIN_TOOL_NAMES.RETRIEVE_TOOL_OUTPUT));
        assert.ok(names.includes(BUILTIN_TOOL_NAMES.RECALL_MEMORY));
        const match = /refId=(tr_[a-f0-9]+)/.exec(payload.messages[1].content);
        assert.ok(match);
        return {
          choices: [{
            message: {
              role: 'assistant',
              tool_calls: [{
                id: 'tc_ret_1',
                type: 'function',
                function: {
                  name: BUILTIN_TOOL_NAMES.RETRIEVE_TOOL_OUTPUT,
                  arguments: JSON.stringify({ refId: match[1], query: 'NEEDLE_TOKEN' }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 150, completion_tokens: 25 },
        };
      }
      const toolReply = payload.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'tc_ret_1');
      assert.ok(toolReply && toolReply.content.includes('NEEDLE_TOKEN_FOUND'));
      return {
        choices: [{ message: { role: 'assistant', content: 'Found NEEDLE_TOKEN_FOUND at row 18.' } }],
        usage: { prompt_tokens: 200, completion_tokens: 20 },
      };
    },
    { conversationKey: 'conv:wire' }
  );
  assert.equal(oaRes.rounds, 1);
  assert.equal(openaiCalls, 2);
  assert.equal(oaRes.response.choices[0].message.content, 'Found NEEDLE_TOKEN_FOUND at row 18.');

  // 2. MCPToolAdapter exposes bindable built-in tools & executes ACL-safe recall
  const mcp = new MCPToolAdapter({ optimizer: opt });
  const mcpTools = mcp.getBuiltinTools({ defaultCtx: { conversationKey: 'conv:wire', scope: 'conv:wire' } });
  assert.equal(mcpTools.length, 2);
  const recallTool = mcpTools.find((t) => t.name === BUILTIN_TOOL_NAMES.RECALL_MEMORY);
  const mcpRecallOut = await recallTool.execute({ query: 'SQL uppercase', scope: 'attacker:other' });
  // Must stay pinned to trusted defaultCtx scope rather than attacker-supplied scope
  assert.equal(mcpRecallOut.found, true);
  assert.ok(mcpRecallOut.text.includes('uppercase'));
});

test('Local HTTP Proxy automatically injects & executes built-in retrieval and memory-recall tool loops', async () => {
  const opt = new UniversalAgentOptimizer({
    retention: { maxInlineChars: 120, headChars: 30, tailChars: 30 },
  });
  await opt.extractAndSaveMemory({
    conversationKey: 'px-mem',
    scope: 'px-mem',
    messages: [{ role: 'user', content: 'Important decision: production bucket name is prod-uao-logs.' }],
  });

  const upstreamRequests = [];
  const mockUpstream = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      upstreamRequests.push({ path: req.url, body: parsed });
      res.writeHead(200, { 'content-type': 'application/json' });

      if (req.url === '/v1/messages') {
        const hasToolResult = parsed.messages.some(
          (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')
        );
        if (!hasToolResult) {
          res.end(JSON.stringify({
            id: 'msg_tool_1',
            model: 'claude-sonnet-4',
            content: [{
              type: 'tool_use',
              id: 'toolu_mem_1',
              name: BUILTIN_TOOL_NAMES.RECALL_MEMORY,
              input: { query: 'production bucket' },
            }],
            usage: { input_tokens: 100, output_tokens: 20 },
          }));
          return;
        }
        res.end(JSON.stringify({
          id: 'msg_final',
          model: 'claude-sonnet-4',
          content: [{ type: 'text', text: 'Bucket is prod-uao-logs.' }],
          usage: { input_tokens: 130, cache_read_input_tokens: 80, output_tokens: 15 },
        }));
        return;
      }

      // OpenAI /v1/chat/completions round 0 asks for uao_retrieve_tool_output
      const hasToolReply = parsed.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_proxy_ret');
      if (!hasToolReply) {
        const retainedMsg = parsed.messages.find((m) => typeof m.content === 'string' && m.content.includes('refId='));
        const refId = /refId=(tr_[a-f0-9]+)/.exec(retainedMsg.content)[1];
        res.end(JSON.stringify({
          id: 'cmpl_round0',
          model: 'gpt-4o-mini',
          choices: [{
            message: {
              role: 'assistant',
              tool_calls: [{
                id: 'call_proxy_ret',
                type: 'function',
                function: {
                  name: BUILTIN_TOOL_NAMES.RETRIEVE_TOOL_OUTPUT,
                  arguments: JSON.stringify({ refId, query: 'CRITICAL_TOKEN_BUG' }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 140, completion_tokens: 20 },
        }));
        return;
      }

      res.end(JSON.stringify({
        id: 'cmpl_round1',
        model: 'gpt-4o-mini',
        choices: [{ message: { role: 'assistant', content: 'Verified CRITICAL_TOKEN_BUG on line 22.' } }],
        usage: { prompt_tokens: 180, completion_tokens: 15, prompt_tokens_details: { cached_tokens: 100 } },
      }));
    });
  });

  const proxy = createProxyServer({ optimizer: opt, upstreamBaseUrl: mockUpstream.url, provider: 'openai' });
  const proxyUrl = await new Promise((resolve) => {
    proxy.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${proxy.address().port}`));
  });

  try {
    const hugeToolOutput = Array.from({ length: 30 }, (_, i) => `L${i + 1}: ${i === 21 ? 'CRITICAL_TOKEN_BUG' : 'ok'}`).join('\n');
    const rOpenAI = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-id': 'px-ret', 'x-uao-auto-tools': 'true' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'user', content: 'Inspect the huge log' },
          { role: 'tool', tool_call_id: 'orig_1', content: hugeToolOutput },
        ],
      }),
    });
    assert.equal(rOpenAI.status, 200);
    assert.equal(rOpenAI.headers.get('x-uao-builtin-tool-rounds'), '1');
    const jOpenAI = await rOpenAI.json();
    assert.equal(jOpenAI.choices[0].message.content, 'Verified CRITICAL_TOKEN_BUG on line 22.');
    assert.ok(upstreamRequests[1].body.messages.some((m) => m.role === 'tool' && m.content.includes('CRITICAL_TOKEN_BUG')));

    // Anthropic proxy auto-executes uao_recall_memory tool_use round-trip
    const rAnthropic = await fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-id': 'px-mem' },
      body: JSON.stringify({
        model: 'claude-sonnet-4',
        system: 'Be accurate.',
        messages: [{ role: 'user', content: 'What is our production bucket name?' }],
      }),
    });
    assert.equal(rAnthropic.status, 200);
    assert.equal(rAnthropic.headers.get('x-uao-builtin-tool-rounds'), '1');
    const jAnthropic = await rAnthropic.json();
    assert.equal(jAnthropic.content[0].text, 'Bucket is prod-uao-logs.');
  } finally {
    proxy.closeAllConnections?.();
    proxy.close();
    mockUpstream.server.closeAllConnections?.();
    mockUpstream.server.close();
  }
});
