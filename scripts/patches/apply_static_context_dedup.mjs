import fs from 'node:fs';

const bridgePath = '/home/ubuntu/surfcore/src/bridge.js';
const configPath = '/home/ubuntu/surfcore/config.json';

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

// 1. Add lastPendingStaticCommit next to lastWakePromptMeta and clear staticContextState in forgetConversationCaches
replaceExact(
  `  let telemetryWakeSeq = 0;\n  let lastWakePromptMeta = null;`,
  `  let telemetryWakeSeq = 0;\n  let lastWakePromptMeta = null;\n  let lastPendingStaticCommit = null;`,
  'declare lastPendingStaticCommit'
);

replaceExact(
  `    wakeConfigUpdatedKeys.delete(key);\n    markReadCalledKeys.delete(key);\n  }`,
  `    wakeConfigUpdatedKeys.delete(key);\n    markReadCalledKeys.delete(key);\n    const stForget = socialV2?.conversations?.get?.(canonicalV2Key(key));\n    if (stForget && stForget.staticContextState) stForget.staticContextState = null;\n  }`,
  'forgetConversationCaches clear staticContextState'
);

// 2. Initialize staticContextState in getSocialV2State, loadSocialV2State, saveSocialV2State
replaceExact(
  `        // V2.1 情绪连续：只存最近一轮的情绪/时间/消息指纹，跨唤醒延续，不存原文。\n        emotionState: null\n      };`,
  `        // V2.1 情绪连续：只存最近一轮的情绪/时间/消息指纹，跨唤醒延续，不存原文。\n        emotionState: null,\n        staticContextState: null\n      };`,
  'getSocialV2State.staticContextState'
);

replaceExact(
  `            lastFishGuard: (val.lastFishGuard && typeof val.lastFishGuard === 'object') ? val.lastFishGuard : undefined,\n            fishGuardLog: (Array.isArray(val.fishGuardLog) ? val.fishGuardLog : [])\n              .filter((x) => x && typeof x === 'object')\n              .slice(-30)\n          };`,
  `            lastFishGuard: (val.lastFishGuard && typeof val.lastFishGuard === 'object') ? val.lastFishGuard : undefined,\n            fishGuardLog: (Array.isArray(val.fishGuardLog) ? val.fishGuardLog : [])\n              .filter((x) => x && typeof x === 'object')\n              .slice(-30),\n            staticContextState: (val.staticContextState && typeof val.staticContextState === 'object' && val.staticContextState.sessionId && val.staticContextState.staticHash)\n              ? {\n                sessionId: String(val.staticContextState.sessionId),\n                staticHash: String(val.staticContextState.staticHash),\n                turnsSinceFullInject: Number(val.staticContextState.turnsSinceFullInject) || 0,\n                updatedAt: Number(val.staticContextState.updatedAt) || 0,\n              }\n              : null\n          };`,
  'loadSocialV2State.staticContextState'
);

replaceExact(
  `          lastFishGuard: st.lastFishGuard && typeof st.lastFishGuard === 'object' ? st.lastFishGuard : undefined,\n          fishGuardLog: Array.isArray(st.fishGuardLog) ? st.fishGuardLog.slice(-30) : [],\n          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)`,
  `          lastFishGuard: st.lastFishGuard && typeof st.lastFishGuard === 'object' ? st.lastFishGuard : undefined,\n          fishGuardLog: Array.isArray(st.fishGuardLog) ? st.fishGuardLog.slice(-30) : [],\n          staticContextState: st.staticContextState && typeof st.staticContextState === 'object' ? st.staticContextState : undefined,\n          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)`,
  'saveSocialV2State.staticContextState'
);

// 3. Capture pendingStaticCommit in deliverPromptNow and commit after accepted.result.ok
replaceExact(
  `    let wakeState;\n    let wakeToken;\n    let wakeSnapshot;\n    if (opts.wakeReason) {\n      if (wakeBlocked()) return skipWake();\n      // Build only after session creation: retries may rotate the token, and an\n      // offline queue may have received more messages since this wake was queued.\n      wakeState = getSocialV2State(key);\n      wakeToken = wakeState.agentToken;\n      promptText = buildWakePromptV2(key, opts.wakeReason);`,
  `    let wakeState;\n    let wakeToken;\n    let wakeSnapshot;\n    let pendingStaticCommit = null;\n    if (opts.wakeReason) {\n      if (wakeBlocked()) return skipWake();\n      // Build only after session creation: retries may rotate the token, and an\n      // offline queue may have received more messages since this wake was queued.\n      wakeState = getSocialV2State(key);\n      wakeToken = wakeState.agentToken;\n      promptText = buildWakePromptV2(key, opts.wakeReason);\n      pendingStaticCommit = lastPendingStaticCommit;`,
  'deliverPromptNow capture pendingStaticCommit'
);

replaceExact(
  `    // 唤醒已被 DSH 接受，才把她这次看到的能力更新记为已读；投递失败时下次还会再出现。\n    if (opts.wakeReason) markShownWhatsNewSeen();\n    // 版本升级提示同理：只有主人这次真的收到唤醒，才算“提过了”，不重复讲。\n    if (opts.wakeReason) markShownVersionAnnounce(key);`,
  `    // 唤醒已被 DSH 接受，才把她这次看到的能力更新记为已读；投递失败时下次还会再出现。\n    if (opts.wakeReason) markShownWhatsNewSeen();\n    // 版本升级提示同理：只有主人这次真的收到唤醒，才算“提过了”，不重复讲。\n    if (opts.wakeReason) markShownVersionAnnounce(key);\n    if (opts.wakeReason && pendingStaticCommit && pendingStaticCommit.sessionId === sessionId) {\n      try {\n        const stCommit = getSocialV2State(key);\n        const prevTurns = pendingStaticCommit.omitted ? Number(stCommit.staticContextState?.turnsSinceFullInject || 0) + 1 : 0;\n        stCommit.staticContextState = {\n          sessionId,\n          staticHash: pendingStaticCommit.staticHash,\n          turnsSinceFullInject: prevTurns,\n          updatedAt: Date.now(),\n        };\n        saveSocialV2State();\n      } catch {}\n    }`,
  'deliverPromptNow commit staticContextState'
);

// 4. Add helper functions and staticBlock deduplication in buildWakePromptV2 and buildWakeReminderPromptV2
replaceExact(
  `  function buildWakePromptV2(key, reason) {`,
  `  function isStaticContextDedupEnabledForKey(key) {\n    const sc = cfg.socialV2?.staticContext;\n    if (!sc || sc.enabled !== true) return false;\n    const allow = Array.isArray(sc.allowKeys) ? sc.allowKeys.map(String) : ['*'];\n    if (!allow.length) return false;\n    return allow.includes('*') || allow.includes(String(key));\n  }\n\n  function buildStaticContextAnchorV2(key, st) {\n    const charName = (() => { try { return readCurrentCharacter()?.name || readRoleState()?.role || 'Denia'; } catch { return 'Denia'; } })();\n    const conv = String(key).startsWith('group:') ? \`群(\${String(key).slice(6)})\` : \`私聊(\${String(key).slice(8)})\`;\n    const ownerInfo = cfg.ownerQQ ? \`｜主人=\${cfg.ownerQQ}\` : '';\n    return \`【会话静态锚点】角色=\${charName}｜当前会话=\${conv}\${ownerInfo}｜会话令牌=\${st.agentToken}（调用二代状态工具必带）｜完整人设、B站品味、语音状态与跨会话规则沿用本会话已注入设定。\\n\\n\`;\n  }\n\n  function buildWakePromptV2(key, reason) {`,
  'add staticContext helper functions'
);

const oldBaseBlock = `    const base = commitmentLine + resumeLine + startupLine + roleLine + identityLine + conversationLine + groupSpeechLine + versionLine + provenanceLine + adminLine + biliLine + memoryCardLine + memoryBookLine + affinityLine + voiceLine + tokenLine + initialPromptLine + whatsNewLine + antiAiLine + styleLine + emotionLine + hygieneLine + strategyLine + dynamicsLine + selfAwarenessLine + proactiveLine + autonomousLine + ownerCrossSessionLine + ownerSleepAutonomyLine + closureLine + stickerLine + stickerMatchLine + replyLine + statusLine + wakeLine + memoryLine + participationLine + fishGuardLine + tokenGuardLine + preSleepLine;
    lastWakePromptMeta = {
      role: roleLine.length,
      identity: identityLine.length,
      conversation: conversationLine.length,
      groupSpeech: groupSpeechLine.length,
      version: versionLine.length,
      provenance: provenanceLine.length,
      admin: adminLine.length,
      bili: biliLine.length,
      memory: memoryCardLine.length,
      memoryBook: memoryBookLine.length,
      affinity: affinityLine.length,
      voice: voiceLine.length,
      token: tokenLine.length,
      initialPrompt: initialPromptLine.length,
      whatsNew: whatsNewLine.length,
      antiAi: antiAiLine.length,
      style: styleLine.length,
      emotion: emotionLine.length,
      hygiene: hygieneLine.length,
      strategy: strategyLine.length,
      dynamics: dynamicsLine.length,
      selfAwareness: selfAwarenessLine.length,
      proactive: proactiveLine.length,
      autonomous: autonomousLine.length,
      ownerCrossSession: ownerCrossSessionLine.length,
      ownerSleepAutonomy: ownerSleepAutonomyLine.length,
      closure: closureLine.length,
      sticker: stickerLine.length,
      stickerMatch: stickerMatchLine.length,
      reply: replyLine.length,
      status: statusLine.length,
      wake: wakeLine.length,
      memoryStatus: memoryLine.length,
      participation: participationLine.length,
      fishGuard: fishGuardLine.length,
      tokenGuard: tokenGuardLine.length,
      preSleep: preSleepLine.length,
      base: base.length,
    };`;

const newBaseBlock = `    const versionBaseLine = buildVersionStatusLine(deniaVersionRuntime.info);
    const versionDynamicLine = versionLine.startsWith(versionBaseLine)
      ? versionLine.slice(versionBaseLine.length)
      : versionLine;
    const biliBriefLine = biliBrief ? \`\${biliBrief}\\n\` : '';
    const biliRecallLine = biliRecall ? \`\${biliRecall}\\n\\n\` : '';
    const staticBlock =
      roleLine +
      identityLine +
      conversationLine +
      versionBaseLine +
      provenanceLine +
      adminLine +
      biliBriefLine +
      voiceLine +
      tokenLine +
      antiAiLine +
      proactiveLine +
      ownerCrossSessionLine +
      preSleepLine;
    const currentSessionId = String(state.sessions?.[key] || '');
    const dedupEnabled = isStaticContextDedupEnabledForKey(key) && Boolean(currentSessionId);
    const currentStaticHash = dedupEnabled
      ? crypto.createHash('sha256').update(\`v1|\${currentSessionId}|\${staticBlock}\`).digest('hex')
      : '';
    const prevStatic = st.staticContextState;
    const isGroupKey = String(key).startsWith('group:');
    const maxRefreshTurns = Math.max(
      1,
      Number(
        isGroupKey
          ? (cfg.socialV2?.staticContext?.groupRefreshEveryTurns ?? cfg.socialV2?.staticContext?.refreshEveryTurns ?? 12)
          : (cfg.socialV2?.staticContext?.privateRefreshEveryTurns ?? cfg.socialV2?.staticContext?.refreshEveryTurns ?? 25)
      ) || (isGroupKey ? 12 : 25)
    );
    const canOmitStatic = Boolean(
      dedupEnabled &&
      prevStatic &&
      prevStatic.sessionId === currentSessionId &&
      prevStatic.staticHash === currentStaticHash &&
      Number(prevStatic.turnsSinceFullInject || 0) < maxRefreshTurns &&
      reason !== 'bootstrap'
    );
    const staticAnchorLine = canOmitStatic ? buildStaticContextAnchorV2(key, st) : '';
    const base = canOmitStatic
      ? (commitmentLine + resumeLine + startupLine + staticAnchorLine + groupSpeechLine + versionDynamicLine + biliRecallLine + memoryCardLine + memoryBookLine + affinityLine + initialPromptLine + whatsNewLine + styleLine + emotionLine + hygieneLine + strategyLine + dynamicsLine + selfAwarenessLine + autonomousLine + ownerSleepAutonomyLine + closureLine + stickerLine + stickerMatchLine + replyLine + statusLine + wakeLine + memoryLine + participationLine + fishGuardLine + tokenGuardLine)
      : (commitmentLine + resumeLine + startupLine + roleLine + identityLine + conversationLine + groupSpeechLine + versionLine + provenanceLine + adminLine + biliLine + memoryCardLine + memoryBookLine + affinityLine + voiceLine + tokenLine + initialPromptLine + whatsNewLine + antiAiLine + styleLine + emotionLine + hygieneLine + strategyLine + dynamicsLine + selfAwarenessLine + proactiveLine + autonomousLine + ownerCrossSessionLine + ownerSleepAutonomyLine + closureLine + stickerLine + stickerMatchLine + replyLine + statusLine + wakeLine + memoryLine + participationLine + fishGuardLine + tokenGuardLine + preSleepLine);
    lastPendingStaticCommit = dedupEnabled
      ? { key, sessionId: currentSessionId, staticHash: currentStaticHash, omitted: canOmitStatic }
      : null;
    lastWakePromptMeta = {
      role: canOmitStatic ? 0 : roleLine.length,
      identity: canOmitStatic ? 0 : identityLine.length,
      conversation: canOmitStatic ? 0 : conversationLine.length,
      groupSpeech: groupSpeechLine.length,
      version: canOmitStatic ? versionDynamicLine.length : versionLine.length,
      provenance: canOmitStatic ? 0 : provenanceLine.length,
      admin: canOmitStatic ? 0 : adminLine.length,
      bili: canOmitStatic ? biliRecallLine.length : biliLine.length,
      memory: memoryCardLine.length,
      memoryBook: memoryBookLine.length,
      affinity: affinityLine.length,
      voice: canOmitStatic ? 0 : voiceLine.length,
      token: canOmitStatic ? 0 : tokenLine.length,
      initialPrompt: initialPromptLine.length,
      whatsNew: whatsNewLine.length,
      antiAi: canOmitStatic ? 0 : antiAiLine.length,
      style: styleLine.length,
      emotion: emotionLine.length,
      hygiene: hygieneLine.length,
      strategy: strategyLine.length,
      dynamics: dynamicsLine.length,
      selfAwareness: selfAwarenessLine.length,
      proactive: canOmitStatic ? 0 : proactiveLine.length,
      autonomous: autonomousLine.length,
      ownerCrossSession: canOmitStatic ? 0 : ownerCrossSessionLine.length,
      ownerSleepAutonomy: ownerSleepAutonomyLine.length,
      closure: closureLine.length,
      sticker: stickerLine.length,
      stickerMatch: stickerMatchLine.length,
      reply: replyLine.length,
      status: statusLine.length,
      wake: wakeLine.length,
      memoryStatus: memoryLine.length,
      participation: participationLine.length,
      fishGuard: fishGuardLine.length,
      tokenGuard: tokenGuardLine.length,
      preSleep: canOmitStatic ? 0 : preSleepLine.length,
      staticAnchor: staticAnchorLine.length,
      staticOmitted: canOmitStatic ? 1 : 0,
      staticSavedChars: canOmitStatic ? Math.max(0, staticBlock.length - staticAnchorLine.length) : 0,
      staticHash: currentStaticHash ? currentStaticHash.slice(0, 16) : '',
      base: base.length,
    };`;

replaceExact(oldBaseBlock, newBaseBlock, 'buildWakePromptV2 staticBlock deduplication');

// 5. Update buildWakeReminderPromptV2 to also omit static roleLine when staticContextState is active
const oldReminder = `  function buildWakeReminderPromptV2(key) {
    const roleLine = personaWakeBlockV2(key);
    const identityLine = selfIdentityTextV2();
    const st = getSocialV2State(key);
    const tokenLine = \`【会话令牌】\${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\\n\\n\`;
    const speechRule = groupSpeechRule(key);
    const groupSpeechLine = speechRule ? \`【主人给本群的发言规则】\${speechRule.mode === 'mention_only' ? '只有被真实 @ 才可发言。' : speechRule.instruction}\\n\\n\`
      : key.startsWith('group:') ? '【主人给本群的发言规则】当前没有额外群级规则；先前的群级指引若已撤销，不再沿用。\\n\\n' : '';
    return \`\${roleLine}\${identityLine}\${conversationIdentityLineV2(key)}\${groupSpeechLine}\${tokenLine}【提醒】本轮还没有提交下一次状态。如果这段已经聊完、不想再补，直接 qq_close_conversation 就是自然结束，不用为了收尾再补客套话；如果只是看过不接，qq_mark_read；如果还想继续被叫醒，qq_set_wake_config（潜水前按需完成沉睡前观察）。\`;
  }`;

const newReminder = `  function buildWakeReminderPromptV2(key) {
    const st = getSocialV2State(key);
    const speechRule = groupSpeechRule(key);
    const groupSpeechLine = speechRule ? \`【主人给本群的发言规则】\${speechRule.mode === 'mention_only' ? '只有被真实 @ 才可发言。' : speechRule.instruction}\\n\\n\`
      : key.startsWith('group:') ? '【主人给本群的发言规则】当前没有额外群级规则；先前的群级指引若已撤销，不再沿用。\\n\\n' : '';
    const currentSessionId = String(state.sessions?.[key] || '');
    if (isStaticContextDedupEnabledForKey(key) && currentSessionId && st.staticContextState?.sessionId === currentSessionId && st.staticContextState?.staticHash) {
      return \`\${buildStaticContextAnchorV2(key, st)}\${groupSpeechLine}【提醒】本轮还没有提交下一次状态。如果这段已经聊完、不想再补，直接 qq_close_conversation 就是自然结束，不用为了收尾再补客套话；如果只是看过不接，qq_mark_read；如果还想继续被叫醒，qq_set_wake_config（潜水前按需完成沉睡前观察）。\`;
    }
    const roleLine = personaWakeBlockV2(key);
    const identityLine = selfIdentityTextV2();
    const tokenLine = \`【会话令牌】\${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\\n\\n\`;
    return \`\${roleLine}\${identityLine}\${conversationIdentityLineV2(key)}\${groupSpeechLine}\${tokenLine}【提醒】本轮还没有提交下一次状态。如果这段已经聊完、不想再补，直接 qq_close_conversation 就是自然结束，不用为了收尾再补客套话；如果只是看过不接，qq_mark_read；如果还想继续被叫醒，qq_set_wake_config（潜水前按需完成沉睡前观察）。\`;
  }`;

replaceExact(oldReminder, newReminder, 'buildWakeReminderPromptV2 static anchor');

// 6. Reset staticContextState on DSH compaction/* events in pumpMux
replaceExact(
  `                contextTelemetry.ingestEvent({ id: frame.sessionId }, frame.event, { wakeId, key, characterId });\n                if (frame.event.type === 'turn/end') {\n                  sessionCharacterIds.delete(frame.sessionId);\n                }`,
  `                contextTelemetry.ingestEvent({ id: frame.sessionId }, frame.event, { wakeId, key, characterId });\n                if (frame.event.type === 'compaction/end' || frame.event.type === 'compaction/summary' || frame.event.type === 'compaction/start') {\n                  const stComp = socialV2.conversations.get(canonicalV2Key(key));\n                  if (stComp && stComp.staticContextState) {\n                    stComp.staticContextState = null;\n                    saveSocialV2State();\n                    log(\`[static-context] 会话 \${key} (\${frame.sessionId}) 触发 \${frame.event.type}，已重置静态上下文哈希，下一轮将自动补发完整静态块\`);\n                  }\n                }\n                if (frame.event.type === 'turn/end') {\n                  sessionCharacterIds.delete(frame.sessionId);\n                }`,
  'pumpMux compaction reset'
);

fs.writeFileSync(bridgePath, code, 'utf8');

// 7. Update config.json with socialV2.staticContext
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
cfg.socialV2 = cfg.socialV2 || {};
cfg.socialV2.staticContext = {
  enabled: true,
  allowKeys: ['*'],
  privateRefreshEveryTurns: 25,
  groupRefreshEveryTurns: 12,
};
fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
console.log('[OK] Updated config.json with socialV2.staticContext');
