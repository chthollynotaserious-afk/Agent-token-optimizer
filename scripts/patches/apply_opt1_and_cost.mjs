/**
 * 部署 Opt-1（无损会话轮转三支柱）与 /cost 高精实测口径改造
 */
import fs from 'node:fs';

const bridgePath = '/home/ubuntu/surfcore/src/bridge.js';
let code = fs.readFileSync(bridgePath, 'utf8');
const eol = code.includes('\r\n') ? '\r\n' : '\n';

function replaceExact(target, replacement, label) {
  target = target.replace(/\r?\n/g, eol);
  replacement = replacement.replace(/\r?\n/g, eol);
  const idx = code.indexOf(target);
  if (idx === -1) {
    throw new Error(`Target not found for ${label}`);
  }
  if (code.indexOf(target, idx + 1) !== -1) {
    throw new Error(`Target matched multiple times for ${label}`);
  }
  code = code.slice(0, idx) + replacement + code.slice(idx + target.length);
  console.log(`[OK] Applied patch: ${label}`);
}

// ── 1. 注入 queryRecentCostSummary 辅助函数 ────────────────────────────────
const costHelperCode = `
// ── 高精费用实测口径（供 /cost 命令实时查询上一个小时与今日计费） ───────────
function queryRecentCostSummary() {
  const telemetryFile = path.join(STATE_DIR, 'context-telemetry-bridge.jsonl');
  if (!fs.existsSync(telemetryFile)) return null;

  const now = Date.now();
  const oneHourAgo = now - 3600 * 1000;
  const startOfToday = new Date().setHours(0, 0, 0, 0);

  let h1Calls = 0, h1Miss = 0, h1Hit = 0, h1Out = 0, h1Cost = 0;
  let dayCalls = 0, dayCost = 0;

  function calcCallCost(usage, ts) {
    const d = new Date(ts);
    const hour = d.getHours();
    const isOffPeak = hour >= 0 && hour < 8;
    const rateMiss = isOffPeak ? 1.0 : 2.0;
    const rateHit = isOffPeak ? 0.25 : 0.5;
    const rateOut = isOffPeak ? 4.0 : 8.0;

    const miss = Number(usage?.cacheMiss) || 0;
    const hit = Number(usage?.cacheHit) || 0;
    const out = (Number(usage?.output) || 0) + (Number(usage?.reasoning) || 0);

    return (miss * rateMiss + hit * rateHit + out * rateOut) / 1_000_000;
  }

  try {
    const content = fs.readFileSync(telemetryFile, 'utf8');
    const lines = content.trim().split('\\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.includes('model_call')) continue;
      try {
        const item = JSON.parse(line);
        if (item.kind !== 'model_call' || !item.ts) continue;
        if (item.ts < startOfToday && item.ts < oneHourAgo) {
          if (lines.length - i > 600) break;
        }
        const cost = calcCallCost(item.usage, item.ts);
        if (item.ts >= startOfToday) {
          dayCalls++;
          dayCost += cost;
        }
        if (item.ts >= oneHourAgo) {
          h1Calls++;
          h1Cost += cost;
          h1Miss += Number(item.usage?.cacheMiss) || 0;
          h1Hit += Number(item.usage?.cacheHit) || 0;
          h1Out += (Number(item.usage?.output) || 0) + (Number(item.usage?.reasoning) || 0);
        }
      } catch {}
    }

    const hitRatio = (h1Miss + h1Hit) > 0 ? ((h1Hit / (h1Miss + h1Hit)) * 100).toFixed(1) : '0.0';
    return {
      h1: {
        calls: h1Calls,
        costCNY: h1Cost.toFixed(2),
        miss: h1Miss,
        hit: h1Hit,
        out: h1Out,
        hitRatio: \`\${hitRatio}%\`
      },
      today: {
        calls: dayCalls,
        costCNY: dayCost.toFixed(2)
      }
    };
  } catch (err) {
    log(\`[cost-query] 统计失败：\${err?.message || err}\`);
    return null;
  }
}
`;

replaceExact(
  `  function bridgeDailyUsage() {`,
  `${costHelperCode}\n  function bridgeDailyUsage() {`,
  'inject queryRecentCostSummary'
);

// ── 2. 升级 /cost 的 getCost 接口 ──────────────────────────────────────────
const oldGetCost = `      getCost: () => {
        try {
          const u = bridgeDailyUsage();
          const c = Number(u?.cost ?? u?.cny ?? 0);
          return \`今日模型费用约 ¥\${c.toFixed(2)}（预算见设置页；口径为本地账本）。\`;
        } catch { return '费用遥测暂不可用。'; }
      },`;

const newGetCost = `      getCost: () => {
        try {
          const summary = queryRecentCostSummary();
          if (!summary) {
            const u = bridgeDailyUsage();
            const c = Number(u?.cost ?? u?.cny ?? 0);
            return \`今日模型费用约 ¥\${c.toFixed(2)}（预算见设置页；口径为本地账本）。\`;
          }
          return \`📊 模型计费实测消耗：\\n\` +
            \`• 上一个小时（过去60m）：约 ¥\${summary.h1.costCNY}（\${summary.h1.calls}次调用，命中率 \${summary.h1.hitRatio}，未命中 \${Math.round(summary.h1.miss/1000)}k / 命中 \${(summary.h1.hit/1000000).toFixed(2)}M / 输出 \${Math.round(summary.h1.out/1000)}k）\\n\` +
            \`• 今日累计总计费：约 ¥\${summary.today.costCNY}（\${summary.today.calls}次调用，含主人与群聊全量）\`;
        } catch { return '费用遥测暂不可用。'; }
      },`;

replaceExact(oldGetCost, newGetCost, 'upgrade getCost in bridge.js');

// ── 3. 注入 Opt-1 会话轮转与交接逻辑 ──────────────────────────────────────
const sessionRotationCode = `
  // ── Opt-1 无损会话轮转三支柱机制 ───────────────────────────────────────
  function checkAndTriggerSessionRotation(key, st) {
    if (!st || !state.sessions[key]) return false;
    const isPrivate = key.startsWith('private:');
    const maxTurns = isPrivate ? 30 : 25;
    const maxIdleMs = 4 * 3600 * 1000; // 4小时闲置触发轮转

    const turns = Number(st.sessionTurns) || 0;
    const lastActive = Number(st.lastActionAt || st.lastAiReplyAt) || 0;
    let shouldRotate = false;
    let rotateReason = '';

    if (turns >= maxTurns) {
      shouldRotate = true;
      rotateReason = \`turns_limit_\${turns}\`;
    } else if (lastActive > 0 && (Date.now() - lastActive) > maxIdleMs && turns >= 4) {
      shouldRotate = true;
      rotateReason = \`idle_timeout_\${Math.round((Date.now() - lastActive) / 3600000)}h\`;
    }

    if (!shouldRotate) return false;

    const oldSessionId = state.sessions[key];
    log(\`[session-rotation] 会话 \${key} 达到轮转条件（\${rotateReason}），启动无损交接...\`);

    // 支柱一：截取尾部 4~6 条真实原文作为 Tail Buffer（自然承接语气与代词指代）
    const rawRecent = (Array.isArray(st.recentMessages) ? st.recentMessages : []).slice(-6);
    const tailLines = rawRecent.map((m) => {
      const sender = m.sender || (m.userId === cfg.selfId ? '达妮娅' : '对方');
      const text = String(m.rawMessage || m.text || '').slice(0, 150).trim();
      return text ? \`[\${sender}]: \${text}\` : null;
    }).filter(Boolean);

    let handoffSummary = '';
    if (tailLines.length > 0) {
      handoffSummary = '【无损交接滑窗】上轮会话末尾真实切片（保持话题与指代连续）：\\n' + tailLines.join('\\n');
    }
    // 支柱三：早前历史按需调阅提示（解决“不知道早上聊过什么”）
    handoffSummary += '\\n【早前历史调阅提示】若对方提及今天更早或之前的话题，你可以主动调用历史检索工具查询，无需凭空猜测。';

    st.pendingHandoff = {
      summary: handoffSummary,
      fromSessionId: oldSessionId,
      rotatedAt: Date.now()
    };

    // 回滚保障点 2：物理保留旧会话指针，绝不调用 delete/archive
    if (!state.sessionHistory) state.sessionHistory = {};
    if (!state.sessionHistory[key]) state.sessionHistory[key] = [];
    state.sessionHistory[key].push({
      sessionId: oldSessionId,
      rotatedAt: Date.now(),
      turns,
      reason: rotateReason
    });
    if (state.sessionHistory[key].length > 20) state.sessionHistory[key].shift();

    // 重置轮数与静态注入标记
    st.sessionTurns = 0;
    st.staticContextState = null;
    delete state.sessions[key];
    saveState();
    saveSocialV2State();
    log(\`[session-rotation] 会话 \${key} 旧会话 \${oldSessionId} 已安全归档（物理保留），新会话将在下一轮自动挂载\`);
    return true;
  }
`;

replaceExact(
  `  async function ensureSession(key) {`,
  `${sessionRotationCode}\n  async function ensureSession(key) {`,
  'inject checkAndTriggerSessionRotation'
);

// ── 4. 在 ensureSession 开头调用轮转检查 ──────────────────────────────────
replaceExact(
  `  async function ensureSession(key) {
    const epoch = sessionEpoch;
    const policy = sessionPolicy(key);
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(\`当前模式不允许会话 \${key}\`);
    const existing = state.sessions[key];`,
  `  async function ensureSession(key) {
    const epoch = sessionEpoch;
    const policy = sessionPolicy(key);
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(\`当前模式不允许会话 \${key}\`);
    const stRotation = socialV2?.conversations?.get?.(canonicalV2Key(key));
    if (stRotation) checkAndTriggerSessionRotation(key, stRotation);
    const existing = state.sessions[key];`,
  'hook rotation into ensureSession'
);

// ── 5. 在 buildWakePromptV2 注入交接滑窗并递增轮数 ────────────────────────
replaceExact(
  `    const staticAnchorLine = canOmitStatic ? buildStaticContextAnchorV2(key, st) : '';
    const base = canOmitStatic`,
  `    // Opt-1 轮数累计与无损交接注入
    st.sessionTurns = (Number(st.sessionTurns) || 0) + 1;
    const handoffLine = (st.pendingHandoff && st.pendingHandoff.summary)
      ? (st.pendingHandoff.summary + '\\n\\n')
      : '';
    if (st.pendingHandoff) {
      st.pendingHandoff = null;
      log(\`[session-rotation] 会话 \${key} 新会话首轮成功注入无损交接滑窗\`);
    }

    const staticAnchorLine = canOmitStatic ? buildStaticContextAnchorV2(key, st) : '';
    const base = handoffLine + (canOmitStatic`,
  'handle sessionTurns and handoffLine in buildWakePromptV2'
);

// 修复闭合括号
replaceExact(
  `: (commitmentLine + resumeLine + startupLine + roleLine + identityLine + conversationLine + groupSpeechLine + versionLine + provenanceLine + adminLine + biliLine + memoryCardLine + memoryBookLine + affinityLine + voiceLine + tokenLine + initialPromptLine + whatsNewLine + antiAiLine + styleLine + emotionLine + hygieneLine + strategyLine + dynamicsLine + selfAwarenessLine + proactiveLine + autonomousLine + ownerCrossSessionLine + ownerSleepAutonomyLine + closureLine + stickerLine + stickerMatchLine + replyLine + statusLine + wakeLine + memoryLine + participationLine + fishGuardLine + tokenGuardLine + preSleepLine);`,
  `: (commitmentLine + resumeLine + startupLine + roleLine + identityLine + conversationLine + groupSpeechLine + versionLine + provenanceLine + adminLine + biliLine + memoryCardLine + memoryBookLine + affinityLine + voiceLine + tokenLine + initialPromptLine + whatsNewLine + antiAiLine + styleLine + emotionLine + hygieneLine + strategyLine + dynamicsLine + selfAwarenessLine + proactiveLine + autonomousLine + ownerCrossSessionLine + ownerSleepAutonomyLine + closureLine + stickerLine + stickerMatchLine + replyLine + statusLine + wakeLine + memoryLine + participationLine + fishGuardLine + tokenGuardLine + preSleepLine));`,
  'close base parenthesis with handoffLine'
);

// ── 6. 维护 loadSocialV2State / saveSocialV2State 里的 sessionTurns ─────────
replaceExact(
  `        staticContextState: null\n      };`,
  `        staticContextState: null,\n        sessionTurns: 0,\n        pendingHandoff: null\n      };`,
  'init sessionTurns in getSocialV2State'
);

replaceExact(
  `            staticContextState: (val.staticContextState && typeof val.staticContextState === 'object' && val.staticContextState.sessionId && val.staticContextState.staticHash)`,
  `            sessionTurns: Number(val.sessionTurns) || 0,\n            pendingHandoff: (val.pendingHandoff && typeof val.pendingHandoff === 'object') ? val.pendingHandoff : null,\n            staticContextState: (val.staticContextState && typeof val.staticContextState === 'object' && val.staticContextState.sessionId && val.staticContextState.staticHash)`,
  'loadSocialV2State sessionTurns'
);

replaceExact(
  `          staticContextState: st.staticContextState && typeof st.staticContextState === 'object' ? st.staticContextState : undefined,`,
  `          sessionTurns: Number(st.sessionTurns) || 0,\n          pendingHandoff: st.pendingHandoff && typeof st.pendingHandoff === 'object' ? st.pendingHandoff : undefined,\n          staticContextState: st.staticContextState && typeof st.staticContextState === 'object' ? st.staticContextState : undefined,`,
  'saveSocialV2State sessionTurns'
);

fs.writeFileSync(bridgePath, code, 'utf8');
console.log('[SUCCESS] Successfully applied Opt-1 and /cost upgrade!');
