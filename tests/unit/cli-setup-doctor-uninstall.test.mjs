import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCli } from '../../bin/uao.js';
import { resolveLang } from '../../src/cli/i18n.js';
import { redactSecrets } from '../../src/cli/env.js';

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

test('CLI i18n resolveLang handles --lang, UAO_LANG, and deterministic fallback', () => {
  assert.equal(resolveLang('zh-CN', {}), 'zh-CN');
  assert.equal(resolveLang('en', { UAO_LANG: 'zh-CN' }), 'en');
  assert.equal(resolveLang('auto', { UAO_LANG: 'zh-CN' }), 'zh-CN');
  assert.equal(resolveLang('auto', { UAO_LANG: 'en' }), 'en');
  assert.equal(resolveLang('auto', { LC_ALL: 'zh_CN.UTF-8' }), 'zh-CN');
  assert.equal(resolveLang('auto', { LC_ALL: 'en_US.UTF-8' }), 'en');
});

test('redactSecrets strips Bearer tokens, sk-* keys, and key=value secrets', () => {
  const raw = 'Authorization: Bearer secret-tok-123 sk-proj-abcdef123456 api_key=mysecret123';
  const redacted = redactSecrets(raw);
  assert.ok(!redacted.includes('secret-tok-123'));
  assert.ok(!redacted.includes('sk-proj-abcdef123456'));
  assert.ok(!redacted.includes('mysecret123'));
});

test('uao setup, doctor, and uninstall lifecycle works safely in isolated temp dir', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uao-cli-lifecycle-'));
  try {
    const configPath = path.join(tmpDir, 'config.json');
    const ledgerPath = path.join(tmpDir, 'ledger.jsonl');
    fs.writeFileSync(ledgerPath, '{"calls":1}\n', 'utf8');

    // 1. Dry-run does not create file
    const ioDry = makeIo();
    const dryRes = await runCli(['setup', '--mode', 'proxy', '--upstream', 'https://api.openai.com', '--config', configPath, '--dry-run', '--yes'], ioDry);
    assert.equal(dryRes.code, 0);
    assert.equal(fs.existsSync(configPath), false);

    // 2. Setup writes safe defaults (127.0.0.1, no secrets)
    const ioSetup = makeIo();
    const setupRes = await runCli(['setup', '--mode', 'proxy', '--upstream', 'https://api.openai.com', '--config', configPath, '--yes', '--lang', 'zh-CN'], ioSetup);
    assert.equal(setupRes.code, 0);
    assert.equal(fs.existsSync(configPath), true);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(saved.host, '127.0.0.1');
    assert.equal(saved.createdBy, 'uao-setup');
    assert.equal(saved.apiKeyEnvVar, 'OPENAI_API_KEY');
    assert.match(ioSetup.outText(), /配置成功/);

    // 3. Doctor --json reports verified status with language-neutral keys
    const ioDoc = makeIo();
    const docRes = await runCli(['doctor', '--config', configPath, '--port', '0', '--json', '--lang', 'zh-CN'], ioDoc);
    assert.equal(docRes.code, 0);
    const report = JSON.parse(ioDoc.outText());
    assert.equal(report.status, 'verified');
    assert.ok(Array.isArray(report.checks));
    assert.ok(report.checks.some((c) => c.id === 'uao.config' && c.code === 'OK'));

    // 4. Uninstall removes UAO-owned config, creates backup, and preserves ledger
    const ioUn = makeIo();
    const unRes = await runCli(['uninstall', '--config', configPath, '--yes'], ioUn);
    assert.equal(unRes.code, 0);
    assert.equal(fs.existsSync(configPath), false);
    assert.equal(fs.existsSync(ledgerPath), true);
    assert.ok(unRes.backup && fs.existsSync(unRes.backup));

    // 5. Uninstall preserves user-authored config without createdBy: 'uao-setup'
    const userCfg = path.join(tmpDir, 'user-config.json');
    fs.writeFileSync(userCfg, JSON.stringify({ custom: true }), 'utf8');
    const ioUser = makeIo();
    const unUser = await runCli(['uninstall', '--config', userCfg, '--yes'], ioUser);
    assert.equal(unUser.code, 0);
    assert.equal(fs.existsSync(userCfg), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
