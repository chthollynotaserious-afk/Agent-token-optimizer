/**
 * Opt-1 止血加固补丁：
 * 1. 追踪各 sessionId 的最新上下文体积（启动从插件遥测预热 + 实时跟随 assistant usage）；
 * 2. checkAndTriggerSessionRotation 增加 >=120k token 硬红线，同时去掉 idle_timeout 的 turns>=4 漏洞；
 * 3. slang-learner（黑话学习）每 5 批或上下文 >=80k 自动重置干净新会话。
 */
import fs from 'node:fs';

const bridgePath = '/home/ubuntu/surfcore/src/bridge.js';
let code = fs.readFileSync(bridgePath, 'utf8');
const eol = code.includes('\r\n') ? '\r\n' : '\n';

function replaceExact(target, replacement, label) {
  target = target.replace(/\r?\n/g, eol);
  replacement = replacement.replace(/\r?\n/g, eol);
  const idx = code.indexOf(target);
  if (idx === -1) throw new Error(`Target not found: ${label}`);
  if (code.indexOf(target, idx + 1) !== -1) throw new Error(`Target matched multiple times: ${label}`);
  code = code.slice(0, idx) + replacement + code.slice(idx + target.length);
  console.log(`[OK] ${label}`);
}

// 1. 导入 normalizeUsage 和 usageOfEvent
replaceExact(
  `import { resolvePriceTable } from './model-prices.js';`,
  `import { resolvePriceTable, normalizeUsage } from './model-prices.js';`,
  'import normalizeUsage'
);
replaceExact(
  `import { createTokenLedger } from './token-ledger.js';`,
  `import { createTokenLedger, usageOfEvent } from './token-ledger.js';`,
  'import usageOfEvent'
);

// 2. 初始化 sessionLastInputTokens 并从插件遥测预热历史体量
const tokenTrackerInit = `  /** sessionId -> 最近一次已知的实际模型。切换模型会让单价差好几倍，所以按会话记。 */
  const sessionModels = new Map();
  const sessionLastInputTokens = new Map(); // sessionId -> 最新已知输入上下文体积 (cacheMiss + cacheHit)
  try {
    const pluginTelPath = path.join(os.homedir(), '.dsh', 'surfcore', 'context-telemetry-plugin.jsonl');
    if (fs.existsSync(pluginTelPath)) {
      const stat = fs.statSync(pluginTelPath);
      const readSize = Math.min(stat.size, 2 * 1024 * 1024);
      const buf = Buffer.alloc(readSize);
      const fd = fs.openSync(pluginTelPath, 'r');
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      fs.closeSync(fd);
      const tailLines = buf.toString('utf8').split('\\n');
      for (const l of tailLines) {
        if (!l || !l.includes('"model_call"')) continue;
        try {
          const o = JSON.parse(l);
          if (o.kind === 'model_call' && o.sessionId && o.usage) {
            const inp = (Number(o.usage.cacheMiss) || 0) + (Number(o.usage.cacheHit) || 0);
            if (inp > 0) sessionLastInputTokens.set(o.sessionId, inp);
          }
        } catch {}
      }
      log(\`[session-rotation] 从插件遥测预热 \${sessionLastInputTokens.size} 个会话最新上下文体积\`);
    }
  } catch (e) {
    log(\`[session-rotation] 预热会话体积跳过：\${e?.message || e}\`);
  }`;

replaceExact(
  `  /** sessionId -> 最近一次已知的实际模型。切换模型会让单价差好几倍，所以按会话记。 */\n  const sessionModels = new Map();`,
  tokenTrackerInit,
  'init sessionLastInputTokens with warmup'
);

// 3. 在 recordSessionUsage 实时刷新 sessionLastInputTokens
replaceExact(
  `      const known = sessionModels.get(sessionId);\n      tokenLedger.ingestEvent({`,
  `      const evUsage = usageOfEvent(event);\n      if (evUsage) {\n        const b = normalizeUsage(evUsage);\n        const inp = (Number(b.cacheMiss) || 0) + (Number(b.cacheHit) || 0);\n        if (inp > 0) sessionLastInputTokens.set(sessionId, inp);\n      }\n      const known = sessionModels.get(sessionId);\n      tokenLedger.ingestEvent({`,
  'update sessionLastInputTokens in recordSessionUsage'
);

// 4. 升级 checkAndTriggerSessionRotation：取消 turns>=4 漏洞并增加 120k token 硬红线
const oldRotationCond = `    const turns = Number(st.sessionTurns) || 0;
    const lastActive = Number(st.lastActionAt || st.lastAiReplyAt) || 0;
    let shouldRotate = false;
    let rotateReason = '';

    if (turns >= maxTurns) {
      shouldRotate = true;
      rotateReason = \`turns_limit_\${turns}\`;
    } else if (lastActive > 0 && (Date.now() - lastActive) > maxIdleMs && turns >= 4) {
      shouldRotate = true;
      rotateReason = \`idle_timeout_\${Math.round((Date.now() - lastActive) / 3600000)}h\`;
    }`;

const newRotationCond = `    const turns = Number(st.sessionTurns) || 0;
    const lastActive = Number(st.lastActionAt || st.lastAiReplyAt) || 0;
    const curSessionId = state.sessions[key];
    const curTokens = Number(sessionLastInputTokens.get(curSessionId)) || 0;
    const maxContextTokens = 120000;
    let shouldRotate = false;
    let rotateReason = '';

    if (curTokens >= maxContextTokens) {
      shouldRotate = true;
      rotateReason = \`tokens_limit_\${Math.round(curTokens / 1000)}k\`;
    } else if (turns >= maxTurns) {
      shouldRotate = true;
      rotateReason = \`turns_limit_\${turns}\`;
    } else if (lastActive > 0 && (Date.now() - lastActive) > maxIdleMs && (turns >= 1 || curTokens >= 70000)) {
      shouldRotate = true;
      rotateReason = \`idle_timeout_\${Math.round((Date.now() - lastActive) / 3600000)}h\`;
    }`;

replaceExact(oldRotationCond, newRotationCond, 'harden checkAndTriggerSessionRotation thresholds');

// 5. 升级 ensureSlangLearnerSession：每 5 批或 >=80k 自动重置干净会话
const oldSlangBody = `  async function ensureSlangLearnerSession() {
    const preset = resolvePresetName(cfg.slang?.learnerPreset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('黑话学习缺少已验证的安全 preset，拒绝创建或复用会话');
    const saved = readJsonSafe(SLANG_SESSION_FILE, null);
    // 旧记录没有 preset 元数据，无法证明其权限，必须重新创建。
    if (saved?.preset !== preset) invalidateSlangLearnerSession();
    if (slangLearnerSessionId) {
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    if (saved?.sessionId && saved.preset === preset) {
      // 复用前先确认 DSH 侧那个会话还在：工作区被清理、DSH 重置或归档竞态之后，
      // 这个 id 已经不存在了。以前这里只 follow + selectModel 却**不看返回值**，
      // 于是每个黑话窗口都往一个死会话里发，日志只剩 "session/not-found"，
      // 黑话学习等于永久停摆（本机实际发生过：session-a99af7de 被清掉后一直失败）。
      const candidate = String(saved.sessionId);
      const applied = await ensureChatModel(candidate);
      if (applied === 'not-found') {
        log(\`黑话学习会话 \${candidate} 在 DSH 侧已不存在，重建\`);
        invalidateSlangLearnerSession();
      } else {
        slangLearnerSessionId = candidate;
        learnerSessions.add(slangLearnerSessionId);
        api.events.follow(slangLearnerSessionId);
        return slangLearnerSessionId;
      }
    }
    const dir = path.join(STATE_DIR, 'slang-agent');
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: dir }), 'slang workspace.create');
    const workspaceTitle = cfg.slang?.workspaceTitle || 'QQ 黑话学习';
    if (wsValue.created && workspaceTitle) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle }); } catch {}
    }
    const params = { workspaceId: wsValue.workspace.workspaceId };
    params.agentPreset = preset;
    const value = unwrap(await api.sessions.create(params), 'slang session.create');
    slangLearnerSessionId = value.sessionId;
    learnerSessions.add(slangLearnerSessionId);
    api.events.follow(slangLearnerSessionId);
    await ensureChatModel(slangLearnerSessionId);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicWriteJson(SLANG_SESSION_FILE, { sessionId: slangLearnerSessionId, preset });
    log(\`黑话学习会话已创建：\${slangLearnerSessionId}\`);
    return slangLearnerSessionId;
  }`;

const newSlangBody = `  let slangLearnerBatches = 0;
  async function ensureSlangLearnerSession() {
    const preset = resolvePresetName(cfg.slang?.learnerPreset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('黑话学习缺少已验证的安全 preset，拒绝创建或复用会话');
    let saved = readJsonSafe(SLANG_SESSION_FILE, null);
    // 旧记录没有 preset 元数据，无法证明其权限，必须重新创建。
    if (saved?.preset !== preset) invalidateSlangLearnerSession();

    const activeId = slangLearnerSessionId || (saved?.preset === preset ? String(saved?.sessionId || '') : '');
    const activeTokens = activeId ? (Number(sessionLastInputTokens.get(activeId)) || 0) : 0;
    const curBatches = slangLearnerBatches || Number(saved?.batches || 0);

    if (activeId && (curBatches >= 5 || activeTokens >= 80000)) {
      log(\`[slang-rotation] 黑话学习会话 \${activeId} 已达到重置条件（batches=\${curBatches}, tokens=\${Math.round(activeTokens/1000)}k），切换干净新会话\`);
      invalidateSlangLearnerSession();
      slangLearnerBatches = 0;
      saved = null;
    }

    if (slangLearnerSessionId) {
      slangLearnerBatches += 1;
      try { atomicWriteJson(SLANG_SESSION_FILE, { sessionId: slangLearnerSessionId, preset, batches: slangLearnerBatches }); } catch {}
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    if (saved?.sessionId && saved.preset === preset) {
      const candidate = String(saved.sessionId);
      const applied = await ensureChatModel(candidate);
      if (applied === 'not-found') {
        log(\`黑话学习会话 \${candidate} 在 DSH 侧已不存在，重建\`);
        invalidateSlangLearnerSession();
      } else {
        slangLearnerSessionId = candidate;
        slangLearnerBatches = (Number(saved?.batches) || 0) + 1;
        try { atomicWriteJson(SLANG_SESSION_FILE, { sessionId: slangLearnerSessionId, preset, batches: slangLearnerBatches }); } catch {}
        learnerSessions.add(slangLearnerSessionId);
        api.events.follow(slangLearnerSessionId);
        return slangLearnerSessionId;
      }
    }
    const dir = path.join(STATE_DIR, 'slang-agent');
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: dir }), 'slang workspace.create');
    const workspaceTitle = cfg.slang?.workspaceTitle || 'QQ 黑话学习';
    if (wsValue.created && workspaceTitle) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle }); } catch {}
    }
    const params = { workspaceId: wsValue.workspace.workspaceId };
    params.agentPreset = preset;
    const value = unwrap(await api.sessions.create(params), 'slang session.create');
    slangLearnerSessionId = value.sessionId;
    slangLearnerBatches = 1;
    learnerSessions.add(slangLearnerSessionId);
    api.events.follow(slangLearnerSessionId);
    await ensureChatModel(slangLearnerSessionId);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicWriteJson(SLANG_SESSION_FILE, { sessionId: slangLearnerSessionId, preset, batches: slangLearnerBatches });
    log(\`黑话学习会话已创建：\${slangLearnerSessionId}\`);
    return slangLearnerSessionId;
  }`;

replaceExact(oldSlangBody, newSlangBody, 'rotate slang learner session every 5 batches or 80k tokens');

fs.writeFileSync(bridgePath, code, 'utf8');
console.log('[SUCCESS] Opt-1 hardening patch applied cleanly!');
