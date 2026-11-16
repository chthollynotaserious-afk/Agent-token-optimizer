import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import dshPlugin, {
  apply as applyDshPlugin,
  createUaoDshService,
  resolveDshConfig,
} from '../../packages/dsh-bundle/src/index.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const DSH_BUNDLE_DIR = path.join(REPO_ROOT, 'packages', 'dsh-bundle');

function findLocalDshForTest() {
  const candidates = [
    process.env.UAO_DSH_BIN,
    'E:\\AI\\deepseek\\node_modules\\.bin\\dsh.cmd',
    process.platform === 'win32' ? 'dsh.cmd' : 'dsh',
  ].filter(Boolean);

  for (const bin of candidates) {
    const isWinBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    const res = spawnSync(bin, ['--version'], {
      encoding: 'utf8',
      shell: isWinBatch,
      windowsHide: true,
      timeout: 8000,
    });
    if (res.status === 0 && res.stdout.trim()) {
      return { bin, version: res.stdout.trim().split(/\r?\n/)[0] };
    }
  }
  return null;
}

test('DSH bundle manifest, cordis.patch.yml, and Cordis plugin entry contract are valid', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(DSH_BUNDLE_DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'universal-agent-optimizer-dsh');
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.ok(pkg.engines?.dsh);

  const patchPath = path.join(DSH_BUNDLE_DIR, pkg.dsh.bundle.patch);
  assert.equal(fs.existsSync(patchPath), true);
  const patchText = fs.readFileSync(patchPath, 'utf8');
  assert.match(patchText, /id:\s*uao-optimizer/);
  assert.match(patchText, /name:\s*['"]?universal-agent-optimizer-dsh['"]?/);

  // Plugin entry contract & Cordis lifecycle mock
  assert.equal(dshPlugin.name, 'uao-optimizer');
  assert.deepEqual(dshPlugin.inject, []);

  const resolved = resolveDshConfig({ mode: 'govern', defaultProvider: 'deepseek' });
  assert.equal(resolved.mode, 'govern');
  assert.equal(resolved.defaultProvider, 'deepseek');

  const events = new Map();
  const provided = new Map();
  const mockCtx = {
    tokenMeter: {},
    provide(key, val) { provided.set(key, val); },
    on(event, fn) { events.set(event, fn); },
  };
  const service = applyDshPlugin(mockCtx, { mode: 'observe' });
  assert.equal(provided.get('uao'), service);
  assert.equal(service.getStatus().dshServices.tokenMeter, true);
  assert.equal(service.isDisposed(), false);

  const prep = await service.prepareRequest({
    model: 'deepseek-chat',
    sessionId: 'dsh-unit-1',
    messages: [{ role: 'user', content: 'ping' }],
  });
  assert.equal(prep.cacheCheck.prefixIntact, true);

  events.get('dispose')?.();
  assert.equal(service.isDisposed(), true);
});

test('Disposable DSH profile add -> dump-config -> boot -> smoke test -> remove lifecycle succeeds', async (t) => {
  const dsh = findLocalDshForTest();
  if (!dsh) {
    t.skip('DSH CLI not installed in this environment');
    return;
  }

  const tmpDsh = fs.mkdtempSync(path.join(os.tmpdir(), 'uao-dsh-int-'));
  const tmpPkg = fs.mkdtempSync(path.join(os.tmpdir(), 'uao-pkg-int-'));
  const isWinBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(dsh.bin);
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  try {
    const packRoot = spawnSync(npmBin, ['pack', '--pack-destination', tmpPkg], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    assert.equal(packRoot.status, 0, packRoot.stderr);
    const rootTgz = path.join(tmpPkg, packRoot.stdout.trim().split(/\r?\n/).pop().trim());

    const packDsh = spawnSync(npmBin, ['pack', './packages/dsh-bundle', '--pack-destination', tmpPkg], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    assert.equal(packDsh.status, 0, packDsh.stderr);
    const dshTgz = path.join(tmpPkg, packDsh.stdout.trim().split(/\r?\n/).pop().trim());

    const dshEnv = { ...process.env, DSH_HOME: tmpDsh };

    // Initialize disposable profile uao-test and override unpublished core package with local tarball
    spawnSync(dsh.bin, ['plugin', '--profile', 'uao-test', 'version-exemptions'], {
      env: dshEnv,
      encoding: 'utf8',
      shell: isWinBatch,
      windowsHide: true,
    });

    const wsYamlPath = path.join(tmpDsh, 'profiles', 'uao-test', 'pnpm-workspace.yaml');
    fs.appendFileSync(
      wsYamlPath,
      `\noverrides:\n  universal-agent-optimizer: file:${rootTgz.replace(/\\/g, '/')}\n`,
      'utf8'
    );

    const addRes = spawnSync(dsh.bin, ['plugin', '--profile', 'uao-test', 'add', dshTgz], {
      env: dshEnv,
      encoding: 'utf8',
      shell: isWinBatch,
      windowsHide: true,
      timeout: 60000,
    });
    assert.equal(addRes.status, 0, addRes.stderr || addRes.stdout);

    const profPkg = JSON.parse(fs.readFileSync(path.join(tmpDsh, 'profiles', 'uao-test', 'package.json'), 'utf8'));
    assert.ok(profPkg.dsh?.profile?.bundles?.includes('universal-agent-optimizer-dsh'));

    const dumpRes = spawnSync(dsh.bin, ['--profile', 'uao-test', '--dump-config'], {
      env: dshEnv,
      encoding: 'utf8',
      shell: isWinBatch,
      windowsHide: true,
    });
    assert.equal(dumpRes.status, 0, dumpRes.stderr);
    assert.match(dumpRes.stdout, /id:\s*uao-optimizer/);
    assert.match(dumpRes.stdout, /name:\s*universal-agent-optimizer-dsh/);

    // Boot disposable profile and smoke-test ctx.uao if @deepseek-ai/dsh-app-boot is alongside dsh.bin
    const dshAppBootPath = path.resolve(path.dirname(dsh.bin), '..', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
    const dshPkgAnchor = path.resolve(path.dirname(dsh.bin), '..', '@deepseek-ai', 'dsh', 'package.json');
    if (fs.existsSync(dshAppBootPath) && fs.existsSync(dshPkgAnchor)) {
      const { pathToFileURL } = await import('node:url');
      const appBoot = await import(pathToFileURL(dshAppBootPath).href);
      const prevDshHome = process.env.DSH_HOME;
      process.env.DSH_HOME = tmpDsh;
      try {
        const profile = appBoot.loadProfile('dsh', 'uao-test', dshPkgAnchor);
        assert.ok(profile.layers.some((l) => l.packageName === 'universal-agent-optimizer-dsh'));
        const resolution = await appBoot.createRuntimeResolution({ installAnchor: dshPkgAnchor, profile });
        const profileContext = {
          name: 'uao-test',
          dir: profile.dir,
          home: tmpDsh,
          patchPath: path.join(profile.dir, 'cordis.patch.yml'),
          overlays: [],
          installAnchor: dshPkgAnchor,
        };
        const patches = appBoot.readProfilePatches('dsh', profileContext, profile);
        const rootConfig = path.join(profile.dir, 'cordis.root.yml');
        fs.writeFileSync(rootConfig, '[]\n', 'utf8');
        const app = await appBoot.boot('dsh', rootConfig, patches, async (hostCtx) => {
          hostCtx.provide('profileContext', profileContext);
          await hostCtx.plugin(appBoot.PluginPackages, { resolution });
        }, resolution.bareModuleBaseUrl);
        const uaoService = app.get('uao');
        assert.ok(uaoService, 'Expected ctx.uao service to be registered on DSH boot');
        assert.equal(uaoService.getStatus().plugin, 'uao-optimizer');
        const prep = await uaoService.prepareRequest({
          model: 'deepseek-chat',
          sessionId: 'dsh-boot-smoke',
          messages: [{ role: 'user', content: 'hello' }],
        });
        assert.equal(prep.cacheCheck.prefixIntact, true);
        await app.fiber.dispose();
        assert.equal(uaoService.isDisposed(), true);
      } finally {
        if (prevDshHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prevDshHome;
      }
    }

    const removeRes = spawnSync(dsh.bin, ['plugin', '--profile', 'uao-test', 'remove', 'universal-agent-optimizer-dsh'], {
      env: dshEnv,
      encoding: 'utf8',
      shell: isWinBatch,
      windowsHide: true,
      timeout: 60000,
    });
    assert.equal(removeRes.status, 0, removeRes.stderr || removeRes.stdout);

    const profPkgAfter = JSON.parse(fs.readFileSync(path.join(tmpDsh, 'profiles', 'uao-test', 'package.json'), 'utf8'));
    assert.ok(!profPkgAfter.dsh?.profile?.bundles?.includes('universal-agent-optimizer-dsh'));
    assert.ok(profPkgAfter.dsh?.profile?.bundles?.includes('@deepseek-ai/dsh-base'));
  } finally {
    fs.rmSync(tmpDsh, { recursive: true, force: true });
    fs.rmSync(tmpPkg, { recursive: true, force: true });
  }
});
