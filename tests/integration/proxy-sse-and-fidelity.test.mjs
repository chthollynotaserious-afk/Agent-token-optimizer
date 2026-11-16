import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { UniversalAgentOptimizer } from '../../src/core/optimizer.js';
import { createProxyServer } from '../../src/proxy/server.js';
import { OpenAICompatibleAdapter } from '../../src/adapters/openai-compatible.js';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('Proxy supports SSE streaming with usage extraction, passthrough mode, and non-JSON error status preservation', async () => {
  let receivedBodies = [];
  const mockUpstream = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      receivedBodies.push(parsed);

      if (parsed.forceError === 429) {
        res.writeHead(429, { 'content-type': 'text/plain' });
        res.end('Rate limit exceeded');
        return;
      }

      if (parsed.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.write('data: {"id":"1","model":"deepseek-chat","choices":[{"delta":{"content":"Hi"}}]}\n\n');
        res.write('data: {"id":"1","model":"deepseek-chat","choices":[],"usage":{"prompt_tokens":120,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":40,"completion_tokens":10}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'ok',
        model: 'deepseek-chat',
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      }));
    });
  });

  const optimizer = new UniversalAgentOptimizer({ toolGovernanceConfig: { defaultAllowAll: true } });
  const proxy = createProxyServer({
    optimizer,
    upstreamBaseUrl: mockUpstream.url,
    provider: 'deepseek',
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

  try {
    // 1. SSE streaming records DeepSeek usage from final chunk
    const sseRes = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-id': 'sse-1' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        stream: true,
        messages: [
          { role: 'system', content: 'Primary rule' },
          { role: 'system', content: 'Secondary rule' },
          { role: 'user', content: 'Hello' },
        ],
      }),
    });
    assert.equal(sseRes.status, 200);
    const sseBody = await sseRes.text();
    assert.match(sseBody, /\[DONE\]/);
    assert.equal(receivedBodies[0].messages.filter((m) => m.role === 'system').length, 2);

    const summary = optimizer.ledger.summary();
    assert.equal(summary.calls, 1);
    assert.equal(summary.buckets.cacheHit, 80);
    assert.equal(summary.buckets.cacheMiss, 40);

    // 2. Passthrough header forwards body verbatim and does not record to optimizer ledger
    const rawPayload = { model: 'deepseek-chat', messages: [{ role: 'user', content: 'Verbatim' }], customField: 42 };
    const passRes = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-uao-passthrough': 'true' },
      body: JSON.stringify(rawPayload),
    });
    assert.equal(passRes.status, 200);
    assert.equal(passRes.headers.get('x-uao-passthrough'), 'true');
    assert.deepEqual(receivedBodies[1], rawPayload);
    assert.equal(optimizer.ledger.summary().calls, 1);

    // 3. Non-JSON 429 error preserves status 429 and body text
    const errRes = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', forceError: 429, messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(errRes.status, 429);
    assert.equal(await errRes.text(), 'Rate limit exceeded');
  } finally {
    proxy.closeAllConnections?.();
    await new Promise((r) => proxy.close(r));
    mockUpstream.server.close();
  }
});

test('OpenAICompatibleAdapter preserves multiple system messages in order', async () => {
  const opt = new UniversalAgentOptimizer({ toolGovernanceConfig: { defaultAllowAll: true } });
  const adapter = new OpenAICompatibleAdapter({ optimizer: opt, provider: 'deepseek' });
  const { payload } = await adapter.transformRequest({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'Sys 1' },
      { role: 'system', content: 'Sys 2' },
      { role: 'user', content: 'Hi' },
    ],
  });
  assert.deepEqual(payload.messages.map((m) => m.content), ['Sys 1', 'Sys 2', 'Hi']);
});
