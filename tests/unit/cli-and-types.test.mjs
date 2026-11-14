import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import * as uao from '../../src/index.js';
import { parseArgs, runCli } from '../../bin/uao.js';

function makeIo() {
  const stdout = [];
  const stderr = [];
  return {
    stdout: (msg) => stdout.push(String(msg)),
    stderr: (msg) => stderr.push(String(msg)),
    outText: () => stdout.join('\n'),
    errText: () => stderr.join('\n'),
  };
}

test('CLI parseArgs handles positional args, --flag=value, --flag value, and help/version', () => {
  const a = parseArgs(['proxy', '--upstream', 'http://127.0.0.1:9000', '--port=8788']);
  assert.equal(a.command, 'proxy');
  assert.equal(a.flags.upstream, 'http://127.0.0.1:9000');
  assert.equal(a.flags.port, '8788');

  const b = parseArgs(['--version']);
  assert.equal(b.command, 'version');
  assert.equal(b.flags.version, true);
});

test('CLI runCli supports --version, --help, benchmark --json, inspect-ledger, and proxy lifecycle', async () => {
  const io1 = makeIo();
  const v = await runCli(['--version'], io1);
  assert.equal(v.code, 0);
  assert.match(io1.outText(), /^2\.0\.0-alpha\.2/);

  const io2 = makeIo();
  const h = await runCli(['--help'], io2);
  assert.equal(h.code, 0);
  assert.match(io2.outText(), /uao proxy --upstream/);

  const io3 = makeIo();
  const bm = await runCli(['benchmark', '--json'], io3);
  assert.equal(bm.code, 0);
  const parsedReport = JSON.parse(io3.outText());
  assert.equal(parsedReport.dataSourceMode, 'simulated');
  assert.equal(parsedReport.scenarios.length, 10);

  // inspect-ledger with temporary JSONL
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uao-cli-test-'));
  try {
    const ledgerFile = path.join(tmpDir, 'ledger.jsonl');
    const ledger = new uao.UniversalTokenLedger({ file: ledgerFile });
    ledger.record({
      agentId: 'cli-test',
      sessionId: 's1',
      model: 'gpt-4o-mini',
      usage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 500 }, completion_tokens: 50 },
      observed: true,
    });

    const io4 = makeIo();
    const insp = await runCli(['inspect-ledger', ledgerFile, '--json'], io4);
    assert.equal(insp.code, 0);
    const summary = JSON.parse(io4.outText());
    assert.equal(summary.calls, 1);
    assert.equal(summary.buckets.cacheHit, 500);

    // proxy validation error when upstream missing
    const ioErr = makeIo();
    const badProxy = await runCli(['proxy'], ioErr);
    assert.equal(badProxy.code, 1);
    assert.match(ioErr.errText(), /--upstream/);

    // proxy starts on ephemeral port 0 and serves /health
    const io5 = makeIo();
    const started = await runCli(['proxy', '--upstream', 'http://127.0.0.1:1', '--port', '0'], io5);
    assert.equal(started.code, 0);
    try {
      const res = await fetch(`http://127.0.0.1:${started.port}/health`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
    } finally {
      started.server.closeAllConnections?.();
      await new Promise((resolve) => started.server.close(resolve));
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('UniversalAgentOptimizer.optimizeRequest and default-optimizer createProxyServer work cleanly', async () => {
  const opt = new uao.UniversalAgentOptimizer();
  const result = await opt.optimizeRequest({
    model: 'deepseek-chat',
    sessionId: 'emb-1',
    scene: 'coding',
    tools: [
      { name: 'read_file', description: 'Read file' },
      { name: 'billing_export', description: 'Export invoice' },
    ],
    messages: [{ role: 'user', content: 'Check index.js' }],
    invokeUpstream: async (payload) => {
      assert.ok(payload.tools.some((t) => t.name === 'read_file'));
      return {
        content: 'Checked.',
        usage: { prompt_tokens: 400, prompt_cache_hit_tokens: 200, completion_tokens: 20 },
      };
    },
  });

  assert.equal(result.response.content, 'Checked.');
  assert.equal(result.entry.buckets.cacheHit, 200);
  assert.equal(result.telemetry.cacheCheck.prefixIntact, true);

  // Default optimizer in createProxyServer
  const proxy = uao.createProxyServer({ upstreamBaseUrl: 'http://127.0.0.1:1' });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const port = proxy.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
  } finally {
    proxy.closeAllConnections?.();
    await new Promise((resolve) => proxy.close(resolve));
  }
});

test('TypeScript declarations in types/index.d.ts declare every runtime export of src/index.js', () => {
  const dtsPath = path.resolve(import.meta.dirname, '../../types/index.d.ts');
  const dts = fs.readFileSync(dtsPath, 'utf8');
  for (const exportName of Object.keys(uao)) {
    const pattern = new RegExp(`export\\s+(?:class|const|function)\\s+${exportName}\\b`);
    assert.match(dts, pattern, `Missing TypeScript declaration for export: ${exportName}`);
  }
});

test('All markdown docs have paired EN/ZH translations and top language switchers', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const mdFiles = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) mdFiles.push(full);
    }
  }
  walk(repoRoot);

  assert.ok(mdFiles.length >= 26);
  for (const file of mdFiles) {
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(
      content.startsWith('[English]('),
      `Missing language switcher at top of ${path.relative(repoRoot, file)}`
    );
    if (file.endsWith('.zh-CN.md')) {
      const sibling = file.replace(/\.zh-CN\.md$/, '.md');
      assert.ok(fs.existsSync(sibling), `Missing English sibling for ${file}`);
    } else if (file.endsWith('.en.md')) {
      const sibling = file.replace(/\.en\.md$/, '.md');
      assert.ok(fs.existsSync(sibling), `Missing Chinese sibling for ${file}`);
    } else {
      const hasZh = fs.existsSync(file.replace(/\.md$/, '.zh-CN.md'));
      const hasEn = fs.existsSync(file.replace(/\.md$/, '.en.md'));
      assert.ok(hasZh || hasEn, `Missing bilingual companion for ${path.relative(repoRoot, file)}`);
    }
  }
});

