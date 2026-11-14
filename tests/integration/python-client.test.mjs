import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { UniversalAgentOptimizer, createProxyServer } from '../../src/index.js';

function resolvePythonCommand() {
  for (const cmd of ['python', 'python3', 'py']) {
    const res = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
    if (res.status === 0) return cmd;
  }
  return null;
}

function runCommandAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('Python UaoProxyClient interacts end-to-end with local UAO HTTP proxy', async (t) => {
  const pythonCmd = resolvePythonCommand();
  if (!pythonCmd) {
    t.skip('Python interpreter not installed in environment');
    return;
  }

  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/v1/messages') {
        res.end(JSON.stringify({
          id: 'msg_py_1',
          model: 'claude-sonnet-4',
          content: [{ type: 'text', text: 'Anthropic via Python OK' }],
          usage: {
            input_tokens: 500,
            cache_read_input_tokens: 1500,
            cache_creation_input_tokens: 100,
            output_tokens: 35,
          },
        }));
      } else {
        res.end(JSON.stringify({
          id: 'chatcmpl_py_1',
          model: 'gpt-4o-mini',
          choices: [{ message: { role: 'assistant', content: 'OpenAI via Python OK' } }],
          usage: {
            prompt_tokens: 1200,
            prompt_tokens_details: { cached_tokens: 800 },
            completion_tokens: 25,
          },
        }));
      }
    });
  });

  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;

  const optimizer = new UniversalAgentOptimizer();
  const proxy = createProxyServer({
    optimizer,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    provider: 'openai',
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxy.address().port;

  try {
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const pyScript = `
import json
import sys
sys.path.insert(0, ${JSON.stringify(repoRoot)})
from python.uao_client import UaoProxyClient

client = UaoProxyClient("http://127.0.0.1:${proxyPort}", session_id="py-sess-1", scene="coding", api_key="test-key")
health = client.health()
chat = client.chat_completions(model="gpt-4o-mini", messages=[{"role": "user", "content": "hi"}])
msg = client.messages(model="claude-sonnet-4", system="Be brief.", messages=[{"role": "user", "content": "hi"}])
metrics = client.metrics()
print(json.dumps({
    "health_ok": health["ok"],
    "chat_text": chat["data"]["choices"][0]["message"]["content"],
    "msg_text": msg["data"]["content"][0]["text"],
    "calls": metrics["metrics"]["ledger"]["calls"],
    "cache_hit": metrics["metrics"]["ledger"]["buckets"]["cacheHit"],
}))
`;
    const run = await runCommandAsync(pythonCmd, ['-B', '-c', pyScript]);
    assert.equal(run.status, 0, `Python failed: ${run.stderr}`);
    const out = JSON.parse(run.stdout.trim());
    assert.equal(out.health_ok, true);
    assert.equal(out.chat_text, 'OpenAI via Python OK');
    assert.equal(out.msg_text, 'Anthropic via Python OK');
    assert.equal(out.calls, 2);
    assert.equal(out.cache_hit, 2300);
  } finally {
    proxy.closeAllConnections?.();
    upstream.closeAllConnections?.();
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});
