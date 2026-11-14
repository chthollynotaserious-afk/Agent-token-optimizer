import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { UniversalAgentOptimizer } from '../../src/core/optimizer.js';
import { SingleCompressorCoordinator } from '../../src/plugins/compression.js';
import {
  CircuitBreaker,
  HeadroomPlugin,
  ContextCompressPlugin,
  RTKPlugin,
} from '../../src/plugins/external-optimizer.js';
import { createProxyServer } from '../../src/proxy/server.js';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('External optimizer plugins compress via mock service and fall back cleanly on outage', async () => {
  const mockHeadroom = await startServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        compressed: `[headroom-compressed] ${parsed.content.slice(0, 30)}`,
        ref_id: 'hr_123',
        quality_score: 90,
      }));
    });
  });

  try {
    const plugin = new HeadroomPlugin({ baseUrl: mockHeadroom.url });
    const ccPlugin = new ContextCompressPlugin({
      invokeMcpTool: async (_tool, args) => ({ summary: `[cc] ${args.content.slice(0, 20)}`, refId: 'cc_1', qualityScore: 88 }),
    });
    const rtkPlugin = new RTKPlugin({ runFilter: async (c) => `[rtk] ${c.slice(0, 15)}` });

    const coord = new SingleCompressorCoordinator({ plugins: [plugin, ccPlugin, rtkPlugin] });
    const raw = 'VERBOSE_OUTPUT '.repeat(40);

    // Compresses once with first matching available plugin (Headroom)
    const okRes = await coord.compressOnce(raw, { contentType: 'tool_output' });
    assert.equal(okRes.applied, true);
    assert.equal(okRes.compressedBy, 'headroom');
    assert.equal(okRes.originalRefId, 'hr_123');

    // Close mock server to simulate outage -> safe fallback to original without throwing
    await new Promise((r) => mockHeadroom.server.close(r));
    const downRes = await plugin.compress({ content: raw, contentType: 'tool_output' });
    assert.equal(downRes.ok, false);
    assert.equal(downRes.content, raw);

    // Circuit breaker opens after threshold failures
    const breaker = new CircuitBreaker({ failureThreshold: 2 });
    breaker.recordFailure();
    assert.equal(breaker.isOpen(), false);
    breaker.recordFailure();
    assert.equal(breaker.isOpen(), true);
  } finally {
    mockHeadroom.server.close();
  }
});

test('Local HTTP Proxy intercepts OpenAI & Anthropic requests and records UniversalTokenLedger', async () => {
  let lastUpstreamBody = null;
  const mockUpstream = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastUpstreamBody = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/v1/messages') {
        res.end(JSON.stringify({
          id: 'msg_1',
          model: 'claude-sonnet-4',
          usage: { input_tokens: 100, cache_read_input_tokens: 500, output_tokens: 40 },
        }));
      } else {
        res.end(JSON.stringify({
          id: 'chatcmpl_1',
          model: 'gpt-4o-mini',
          usage: { prompt_tokens: 200, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 100 } },
        }));
      }
    });
  });

  const optimizer = new UniversalAgentOptimizer({
    toolGovernanceConfig: { deadTools: ['dead_tool'] },
  });
  const proxy = createProxyServer({ optimizer, upstreamBaseUrl: mockUpstream.url, provider: 'openai' });
  const proxyUrl = await new Promise((resolve) => {
    proxy.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${proxy.address().port}`));
  });

  try {
    const r1 = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-id': 'px-1' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        tools: [{ name: 'search' }, { name: 'dead_tool' }],
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    assert.equal(r1.status, 200);
    assert.equal(lastUpstreamBody.tools.length, 1);
    assert.equal(lastUpstreamBody.tools[0].name, 'search');

    const r2 = await fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-id': 'px-2' },
      body: JSON.stringify({
        model: 'claude-sonnet-4',
        system: 'Be helpful.',
        messages: [{ role: 'user', content: 'Ping' }],
      }),
    });
    assert.equal(r2.status, 200);

    const metricsRes = await fetch(`${proxyUrl}/metrics`);
    const metricsJson = await metricsRes.json();
    assert.equal(metricsJson.ok, true);
    assert.equal(metricsJson.metrics.ledger.calls, 2);
  } finally {
    proxy.close();
    mockUpstream.server.close();
  }
});
