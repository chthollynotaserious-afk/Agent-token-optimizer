import fs from 'node:fs';

const BRIDGE_PATH = '/home/ubuntu/surfcore/src/bridge.js';

function backupOnce(filePath, suffix) {
  const bak = `${filePath}${suffix}`;
  if (!fs.existsSync(bak) && fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, bak);
    console.log(`Backup created: ${bak}`);
  }
}

function replaceExact(src, target, replacement, label) {
  const idx = src.indexOf(target);
  if (idx === -1) {
    throw new Error(`Target not found for [${label}]`);
  }
  if (src.indexOf(target, idx + 1) !== -1) {
    throw new Error(`Target matched multiple times for [${label}]`);
  }
  return src.slice(0, idx) + replacement + src.slice(idx + target.length);
}

backupOnce(BRIDGE_PATH, '.bak-before-opt3-expand');
let bridge = fs.readFileSync(BRIDGE_PATH, 'utf8');

// 1. Preserve stickerHash, impressionsHash, injectedMemoryIds in staticContextState loader
bridge = replaceExact(
  bridge,
  `            staticContextState: (val.staticContextState && typeof val.staticContextState === 'object' && val.staticContextState.sessionId && val.staticContextState.staticHash)
              ? {
                sessionId: String(val.staticContextState.sessionId),
                staticHash: String(val.staticContextState.staticHash),
                turnsSinceFullInject: Number(val.staticContextState.turnsSinceFullInject) || 0,
                updatedAt: Number(val.staticContextState.updatedAt) || 0,
              }
              : null`,
  `            staticContextState: (val.staticContextState && typeof val.staticContextState === 'object' && val.staticContextState.sessionId && val.staticContextState.staticHash)
              ? {
                sessionId: String(val.staticContextState.sessionId),
                staticHash: String(val.staticContextState.staticHash),
                turnsSinceFullInject: Number(val.staticContextState.turnsSinceFullInject) || 0,
                updatedAt: Number(val.staticContextState.updatedAt) || 0,
                stickerHash: typeof val.staticContextState.stickerHash === 'string' ? val.staticContextState.stickerHash : '',
                impressionsHash: typeof val.staticContextState.impressionsHash === 'string' ? val.staticContextState.impressionsHash : '',
                injectedMemoryIds: Array.isArray(val.staticContextState.injectedMemoryIds)
                  ? val.staticContextState.injectedMemoryIds.map(String).slice(-200)
                  : null,
              }
              : null`,
  'staticContextState state loader',
);
console.log('1/5 Patched staticContextState loader');

// 2. Split formatMemoryV2 into formatMemoryVolatileV2 + formatMemberImpressionsV2
bridge = replaceExact(
  bridge,
  `  function formatMemoryV2(st) {
    if (!st) return '';
    const lines = [];
    const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
    if (topics.length) {
      lines.push('【进行中的话题】');
      for (const t of topics.slice(-10)) {
        const ago = t.lastMentionAt ? Math.round((Date.now() - t.lastMentionAt) / 60000) : 0;
        const stale = t.lastMentionAt && Date.now() - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? '（已搁置）' : '';
        lines.push(\`- \${t.text}\${stale}（\${ago > 0 ? ago + '分钟前' : '刚刚'}）\${t.pendingQuestion ? \`；待追问：\${t.pendingQuestion}\` : ''}\`);
      }
    }
    const thoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || Date.now() < t.expiresAt)) : [];
    if (thoughts.length) {
      lines.push('【你想说但还没说的】');
      for (const t of thoughts.slice(-10)) {
        lines.push(\`- \${t.text}\${t.motivation ? \`（\${t.motivation}）\` : ''}\`);
      }
    }
    const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
    const names = Object.keys(impressions);
    if (names.length) {
      lines.push('【对群友的印象】');
      for (const name of names.slice(-10)) {
        const im = impressions[name] || {};
        const traits = Array.isArray(im.traits) ? im.traits : [];
        lines.push(\`- \${name}：\${traits.length ? traits.join('、') : '暂无记录'}（互动 \${Number(im.interactionCount) || 0} 次）\`);
      }
    }
    return lines.join('\\n');
  }`,
  `  function formatMemoryVolatileV2(st) {
    if (!st) return '';
    const lines = [];
    const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
    if (topics.length) {
      lines.push('【进行中的话题】');
      for (const t of topics.slice(-10)) {
        const ago = t.lastMentionAt ? Math.round((Date.now() - t.lastMentionAt) / 60000) : 0;
        const stale = t.lastMentionAt && Date.now() - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? '（已搁置）' : '';
        lines.push(\`- \${t.text}\${stale}（\${ago > 0 ? ago + '分钟前' : '刚刚'}）\${t.pendingQuestion ? \`；待追问：\${t.pendingQuestion}\` : ''}\`);
      }
    }
    const thoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || Date.now() < t.expiresAt)) : [];
    if (thoughts.length) {
      lines.push('【你想说但还没说的】');
      for (const t of thoughts.slice(-10)) {
        lines.push(\`- \${t.text}\${t.motivation ? \`（\${t.motivation}）\` : ''}\`);
      }
    }
    return lines.join('\\n');
  }

  function formatMemberImpressionsV2(st) {
    if (!st) return '';
    const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
    const names = Object.keys(impressions);
    if (!names.length) return '';
    const lines = ['【对群友的印象】'];
    for (const name of names.slice(-10)) {
      const im = impressions[name] || {};
      const traits = Array.isArray(im.traits) ? im.traits : [];
      lines.push(\`- \${name}：\${traits.length ? traits.join('、') : '暂无记录'}（互动 \${Number(im.interactionCount) || 0} 次）\`);
    }
    return lines.join('\\n');
  }

  function formatMemoryV2(st) {
    return [formatMemoryVolatileV2(st), formatMemberImpressionsV2(st)].filter(Boolean).join('\\n');
  }`,
  'formatMemoryV2 split',
);
console.log('2/5 Patched formatMemoryV2 split');

// 3. Add memoryCardPromptBundle alongside memoryCardPromptBlock
bridge = replaceExact(
  bridge,
  `  function memoryCardPromptBlock(key = '') {
    const target = String(key ?? '').trim();
    const isOwner = !target || target === \`private:\${String(cfg.ownerQQ ?? '')}\`;
    const audience = isOwner ? 'owner' : (target.startsWith('group:') ? 'public' : 'trusted');
    const legacyBlock = legacyMemoryCardPromptBlock(target);
    const maxChars = Number(cfg.memoryCard?.injectMaxChars?.qq) || 2200;
    const currentEmotion = emotionStore?.values?.() ?? null;
    const { blocks, usedIds, usedRecords = [] } = selectContext({
      platform: 'qq',
      conversationKey: target,
      isOwner,
      ownerQQ: String(cfg.ownerQQ ?? ''),
      audience,
      allowGlobalPreview: !target && isOwner,
      cardPath: MEMORY_CARD_PATHS.json,
      biliMemoryPath: path.join(path.dirname(MEMORY_CARD_PATHS.dir), 'bili', 'bili-memory.json'),
      inboxPath: MEMORY_CARD_PATHS.inbox,
      notesDir: path.join(WORKSPACE_ROOT, 'notes'),
      legacyBlock,
      allowedGroups: allowedGroupsForKey(target, cfg.memoryCard?.sharing),
      formatRecord: (record, opts) => formatMemoryRecordLine(record, opts),
      currentEmotion,
      reconsolidation: reconStore.snapshot(),
    }, maxChars);
    if (usedRecords.length > 0) {
      try { reconStore.recordRecall(usedRecords, currentEmotion); } catch {}
    }
    if (usedIds.length > 0) {
      log(\`[context-selector] key=\${target || 'owner-default'} audience=\${audience} count=\${usedIds.length} usedIds=\${usedIds.join(',')}\`);
    }
    return blocks;
  }`,
  `  function memoryCardPromptBundle(key = '') {
    const target = String(key ?? '').trim();
    const isOwner = !target || target === \`private:\${String(cfg.ownerQQ ?? '')}\`;
    const audience = isOwner ? 'owner' : (target.startsWith('group:') ? 'public' : 'trusted');
    const legacyBlock = legacyMemoryCardPromptBlock(target);
    const maxChars = Number(cfg.memoryCard?.injectMaxChars?.qq) || 2200;
    const currentEmotion = emotionStore?.values?.() ?? null;
    const lineById = new Map();
    const { blocks, usedIds = [], usedRecords = [] } = selectContext({
      platform: 'qq',
      conversationKey: target,
      isOwner,
      ownerQQ: String(cfg.ownerQQ ?? ''),
      audience,
      allowGlobalPreview: !target && isOwner,
      cardPath: MEMORY_CARD_PATHS.json,
      biliMemoryPath: path.join(path.dirname(MEMORY_CARD_PATHS.dir), 'bili', 'bili-memory.json'),
      inboxPath: MEMORY_CARD_PATHS.inbox,
      notesDir: path.join(WORKSPACE_ROOT, 'notes'),
      legacyBlock,
      allowedGroups: allowedGroupsForKey(target, cfg.memoryCard?.sharing),
      formatRecord: (record, opts) => {
        const line = formatMemoryRecordLine(record, opts);
        if (record?.id && line) lineById.set(String(record.id), line);
        return line;
      },
      currentEmotion,
      reconsolidation: reconStore.snapshot(),
    }, maxChars);
    if (usedRecords.length > 0) {
      try { reconStore.recordRecall(usedRecords, currentEmotion); } catch {}
    }
    if (usedIds.length > 0) {
      log(\`[context-selector] key=\${target || 'owner-default'} audience=\${audience} count=\${usedIds.length} usedIds=\${usedIds.join(',')}\`);
    }
    return { blocks, usedIds, lineById };
  }

  function memoryCardPromptBlock(key = '') {
    return memoryCardPromptBundle(key).blocks;
  }`,
  'memoryCardPromptBundle',
);
console.log('3/5 Added memoryCardPromptBundle');

// 4. Persist stickerHash, impressionsHash, injectedMemoryIds in deliverPromptNow
bridge = replaceExact(
  bridge,
  `    if (opts.wakeReason && pendingStaticCommit && pendingStaticCommit.sessionId === sessionId) {
      try {
        const stCommit = getSocialV2State(key);
        const prevTurns = pendingStaticCommit.omitted ? Number(stCommit.staticContextState?.turnsSinceFullInject || 0) + 1 : 0;
        stCommit.staticContextState = {
          sessionId,
          staticHash: pendingStaticCommit.staticHash,
          turnsSinceFullInject: prevTurns,
          updatedAt: Date.now(),
        };
        saveSocialV2State();
      } catch {}
    }`,
  `    if (opts.wakeReason && pendingStaticCommit && pendingStaticCommit.sessionId === sessionId) {
      try {
        const stCommit = getSocialV2State(key);
        const prevTurns = pendingStaticCommit.omitted ? Number(stCommit.staticContextState?.turnsSinceFullInject || 0) + 1 : 0;
        stCommit.staticContextState = {
          sessionId,
          staticHash: pendingStaticCommit.staticHash,
          turnsSinceFullInject: prevTurns,
          updatedAt: Date.now(),
          stickerHash: pendingStaticCommit.stickerHash || '',
          impressionsHash: pendingStaticCommit.impressionsHash || '',
          injectedMemoryIds: Array.isArray(pendingStaticCommit.injectedMemoryIds)
            ? pendingStaticCommit.injectedMemoryIds.slice(-200)
            : [],
        };
        saveSocialV2State();
      } catch {}
    }`,
  'deliverPromptNow staticContextState commit',
);
console.log('4/5 Patched deliverPromptNow staticContextState commit');

// 5. Expand Opt-3 staticBlock + per-session delta dedup in buildWakePromptV2
bridge = replaceExact(
  bridge,
  `  function buildStaticContextAnchorV2(key, st) {
    const charName = (() => { try { return readCurrentCharacter()?.name || readRoleState()?.role || 'Denia'; } catch { return 'Denia'; } })();
    const conv = String(key).startsWith('group:') ? \`群(\${String(key).slice(6)})\` : \`私聊(\${String(key).slice(8)})\`;
    const ownerInfo = cfg.ownerQQ ? \`｜主人=\${cfg.ownerQQ}\` : '';
    return \`【会话静态锚点】角色=\${charName}｜当前会话=\${conv}\${ownerInfo}｜会话令牌=\${st.agentToken}（调用二代状态工具必带）｜完整人设、B站品味、语音状态与跨会话规则沿用本会话已注入设定。\\n\\n\`;
  }`,
  `  function buildStaticContextAnchorV2(key, st) {
    const charName = (() => { try { return readCurrentCharacter()?.name || readRoleState()?.role || 'Denia'; } catch { return 'Denia'; } })();
    const conv = String(key).startsWith('group:') ? \`群(\${String(key).slice(6)})\` : \`私聊(\${String(key).slice(8)})\`;
    const ownerInfo = cfg.ownerQQ ? \`｜主人=\${cfg.ownerQQ}\` : '';
    return \`【会话静态锚点】角色=\${charName}｜当前会话=\${conv}\${ownerInfo}｜会话令牌=\${st.agentToken}（调用二代状态工具必带）｜人设、核心记忆、记忆卡、群友印象、常用表情与安全/睡眠规则沿用本会话前文已注入设定（有新增或变更时会自动补充）。\\n\\n\`;
  }`,
  'buildStaticContextAnchorV2 copy',
);

bridge = replaceExact(
  bridge,
  `    const memoryText = formatMemoryV2(st);
    const memoryLine = memoryText ? \`\${memoryText}\\n\\n\` : '';`,
  `    const memoryVolatileText = formatMemoryVolatileV2(st);
    const memoryLine = memoryVolatileText ? \`\${memoryVolatileText}\\n\\n\` : '';
    const memberImpressionsText = formatMemberImpressionsV2(st);
    const memberImpressionsRaw = memberImpressionsText ? \`\${memberImpressionsText}\\n\\n\` : '';`,
  'memoryLine split in buildWakePromptV2',
);

bridge = replaceExact(
  bridge,
  `    const stickerCfg = cfg.socialV2?.sticker ?? {};
    const stickerLine = stickerCfg.enabled !== false && stickerCfg.includeInPrompt !== false
      ? \`\${buildStickerStrategyHint()}\\n\${buildStickerContext(stickerEntriesForKey(key), stickerCfg.promptMaxStickers ?? 8, { recentlyUsedIds: stickerSessionPreferences.recentlyUsedIds(key) })}\\n\\n\`
      : '';`,
  `    const stickerCfg = cfg.socialV2?.sticker ?? {};
    const stickerRaw = stickerCfg.enabled !== false && stickerCfg.includeInPrompt !== false
      ? \`\${buildStickerStrategyHint()}\\n\${buildStickerContext(stickerEntriesForKey(key), stickerCfg.promptMaxStickers ?? 8, { recentlyUsedIds: stickerSessionPreferences.recentlyUsedIds(key) })}\\n\\n\`
      : '';`,
  'stickerRaw in buildWakePromptV2',
);

bridge = replaceExact(
  bridge,
  `    // 二代不自动注入完整角色卡，但记忆卡必须每轮都在：否则她记不起和主人的事。
    const memoryCardText = memoryCardPromptBlock(key);
    const memoryCardLine = memoryCardText ? \`\${memoryCardText}\\n\\n\` : '';
    // L1 核心记忆：只放置顶/初次相遇/高重要性的少数锚点，按会话隐私过滤。
    // 与完整记忆卡并存但限制字数；关闭 socialV2.memoryBook.enabled 即完全退回 2.3.1 行为。
    const memoryBookText = (cfg.socialV2?.memoryBook?.enabled !== false
      && cfg.socialV2?.memoryBook?.injectCore !== false)
      ? memoryBook.core({
        conversationKey: key,
        isOwner: key === \`private:\${String(cfg.ownerQQ ?? '')}\`,
        maxChars: Number(cfg.socialV2?.memoryBook?.maxCoreChars) || undefined,
      })
      : '';
    const memoryBookLine = memoryBookText ? \`【核心记忆】\\n\${memoryBookText}\\n\\n\` : '';`,
  `    // 二代记忆卡按会话追踪已注入 recordId：首轮与定时刷新全量注入，同会话后续轮仅补充新唤起条目的增量。
    const mcBundle = memoryCardPromptBundle(key);
    const memoryCardFull = mcBundle.blocks ? \`\${mcBundle.blocks}\\n\\n\` : '';
    // L1 核心记忆：只放置顶/初次相遇/高重要性的少数锚点，变化频率极低，纳入 staticBlock 哈希去重。
    const memoryBookText = (cfg.socialV2?.memoryBook?.enabled !== false
      && cfg.socialV2?.memoryBook?.injectCore !== false)
      ? memoryBook.core({
        conversationKey: key,
        isOwner: key === \`private:\${String(cfg.ownerQQ ?? '')}\`,
        maxChars: Number(cfg.socialV2?.memoryBook?.maxCoreChars) || undefined,
      })
      : '';
    const memoryBookRaw = memoryBookText ? \`【核心记忆】\\n\${memoryBookText}\\n\\n\` : '';`,
  'mcBundle & memoryBookRaw in buildWakePromptV2',
);

bridge = replaceExact(
  bridge,
  `    const staticBlock =
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
    // Opt-1 轮数累计与无损交接注入
    st.sessionTurns = (Number(st.sessionTurns) || 0) + 1;
    const handoffLine = (st.pendingHandoff && st.pendingHandoff.summary)
      ? (st.pendingHandoff.summary + '\\n\\n')
      : '';
    if (st.pendingHandoff) {
      st.pendingHandoff = null;
      log(\`[session-rotation] 会话 \${key} 新会话首轮成功注入无损交接滑窗\`);
    }

    const staticAnchorLine = canOmitStatic ? buildStaticContextAnchorV2(key, st) : '';
    const base = handoffLine + (canOmitStatic
      ? (ownerQuoteLine + commitmentLine + resumeLine + startupLine + staticAnchorLine + groupSpeechLine + versionDynamicLine + biliRecallLine + memoryCardLine + memoryBookLine + affinityLine + initialPromptLine + whatsNewLine + styleLine + emotionLine + hygieneLine + strategyLine + dynamicsLine + selfAwarenessLine + autonomousLine + ownerSleepAutonomyLine + closureLine + stickerLine + stickerMatchLine + replyLine + statusLine + wakeLine + memoryLine + participationLine + fishGuardLine + tokenGuardLine)
      : (ownerQuoteLine + commitmentLine + resumeLine + startupLine + roleLine + identityLine + conversationLine + groupSpeechLine + versionLine + provenanceLine + adminLine + biliLine + memoryCardLine + memoryBookLine + affinityLine + voiceLine + tokenLine + initialPromptLine + whatsNewLine + antiAiLine + styleLine + emotionLine + hygieneLine + strategyLine + dynamicsLine + selfAwarenessLine + proactiveLine + autonomousLine + ownerCrossSessionLine + ownerSleepAutonomyLine + closureLine + stickerLine + stickerMatchLine + replyLine + statusLine + wakeLine + memoryLine + participationLine + fishGuardLine + tokenGuardLine + preSleepLine));
    lastPendingStaticCommit = dedupEnabled
      ? { key, sessionId: currentSessionId, staticHash: currentStaticHash, omitted: canOmitStatic }
      : null;`,
  `    const staticBlock =
      roleLine +
      identityLine +
      conversationLine +
      versionBaseLine +
      provenanceLine +
      adminLine +
      biliBriefLine +
      memoryBookRaw +
      voiceLine +
      tokenLine +
      antiAiLine +
      proactiveLine +
      ownerCrossSessionLine +
      ownerSleepAutonomyLine +
      tokenGuardLine +
      preSleepLine;
    const currentSessionId = String(state.sessions?.[key] || '');
    const dedupEnabled = isStaticContextDedupEnabledForKey(key) && Boolean(currentSessionId);
    const currentStaticHash = dedupEnabled
      ? crypto.createHash('sha256').update(\`v2|\${currentSessionId}|\${staticBlock}\`).digest('hex')
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
    // 半静态区块独立追踪哈希/ID：内容未变时省略，变更时仅补充变化区块而不击穿 staticHash。
    const stickerHash = stickerRaw ? crypto.createHash('sha256').update(stickerRaw).digest('hex').slice(0, 16) : '';
    const stickerLine = (canOmitStatic && (!stickerHash || prevStatic?.stickerHash === stickerHash)) ? '' : stickerRaw;
    const impressionsHash = memberImpressionsRaw ? crypto.createHash('sha256').update(memberImpressionsRaw).digest('hex').slice(0, 16) : '';
    const memberImpressionsLine = (canOmitStatic && (!impressionsHash || prevStatic?.impressionsHash === impressionsHash)) ? '' : memberImpressionsRaw;
    let memoryCardLine = memoryCardFull;
    let nextInjectedMemoryIds = mcBundle.usedIds.slice(-200);
    if (canOmitStatic && Array.isArray(prevStatic?.injectedMemoryIds)) {
      const prevIdSet = new Set(prevStatic.injectedMemoryIds.map(String));
      const newIds = mcBundle.usedIds.filter((id) => !prevIdSet.has(String(id)));
      if (newIds.length === 0) {
        memoryCardLine = '';
      } else if (newIds.every((id) => mcBundle.lineById.has(String(id)))) {
        memoryCardLine = \`【补充回忆（本会话新唤起）】\\n\${newIds.map((id) => mcBundle.lineById.get(String(id))).join('\\n')}\\n\\n\`;
      } else {
        memoryCardLine = memoryCardFull;
      }
      nextInjectedMemoryIds = Array.from(new Set([...prevIdSet, ...mcBundle.usedIds.map(String)])).slice(-200);
    }
    const memoryBookLine = canOmitStatic ? '' : memoryBookRaw;
    // Opt-1 轮数累计与无损交接注入
    st.sessionTurns = (Number(st.sessionTurns) || 0) + 1;
    const handoffLine = (st.pendingHandoff && st.pendingHandoff.summary)
      ? (st.pendingHandoff.summary + '\\n\\n')
      : '';
    if (st.pendingHandoff) {
      st.pendingHandoff = null;
      log(\`[session-rotation] 会话 \${key} 新会话首轮成功注入无损交接滑窗\`);
    }

    const staticAnchorLine = canOmitStatic ? buildStaticContextAnchorV2(key, st) : '';
    const base = handoffLine + (canOmitStatic
      ? (ownerQuoteLine + commitmentLine + resumeLine + startupLine + staticAnchorLine + groupSpeechLine + versionDynamicLine + biliRecallLine + memoryCardLine + affinityLine + initialPromptLine + whatsNewLine + styleLine + emotionLine + hygieneLine + strategyLine + dynamicsLine + selfAwarenessLine + autonomousLine + closureLine + stickerLine + stickerMatchLine + replyLine + statusLine + wakeLine + memoryLine + memberImpressionsLine + participationLine + fishGuardLine)
      : (ownerQuoteLine + commitmentLine + resumeLine + startupLine + roleLine + identityLine + conversationLine + groupSpeechLine + versionLine + provenanceLine + adminLine + biliLine + memoryCardLine + memoryBookLine + affinityLine + voiceLine + tokenLine + initialPromptLine + whatsNewLine + antiAiLine + styleLine + emotionLine + hygieneLine + strategyLine + dynamicsLine + selfAwarenessLine + proactiveLine + autonomousLine + ownerCrossSessionLine + ownerSleepAutonomyLine + closureLine + stickerLine + stickerMatchLine + replyLine + statusLine + wakeLine + memoryLine + memberImpressionsLine + participationLine + fishGuardLine + tokenGuardLine + preSleepLine));
    const extraOmittedChars = canOmitStatic
      ? ((memoryCardFull.length - memoryCardLine.length) + (stickerRaw.length - stickerLine.length) + (memberImpressionsRaw.length - memberImpressionsLine.length))
      : 0;
    lastPendingStaticCommit = dedupEnabled
      ? {
        key,
        sessionId: currentSessionId,
        staticHash: currentStaticHash,
        omitted: canOmitStatic,
        stickerHash,
        impressionsHash,
        injectedMemoryIds: nextInjectedMemoryIds,
      }
      : null;`,
  'buildWakePromptV2 staticBlock & delta dedup',
);

bridge = replaceExact(
  bridge,
  `      memoryBook: memoryBookLine.length,`,
  `      memoryBook: memoryBookLine.length,`,
  'check memoryBook field',
);
bridge = replaceExact(
  bridge,
  `      ownerSleepAutonomy: ownerSleepAutonomyLine.length,`,
  `      ownerSleepAutonomy: canOmitStatic ? 0 : ownerSleepAutonomyLine.length,`,
  'lastWakePromptMeta ownerSleepAutonomy',
);
bridge = replaceExact(
  bridge,
  `      memoryStatus: memoryLine.length,
      participation: participationLine.length,
      fishGuard: fishGuardLine.length,
      tokenGuard: tokenGuardLine.length,
      preSleep: canOmitStatic ? 0 : preSleepLine.length,
      staticAnchor: staticAnchorLine.length,
      staticOmitted: canOmitStatic ? 1 : 0,
      staticSavedChars: canOmitStatic ? Math.max(0, staticBlock.length - staticAnchorLine.length) : 0,`,
  `      memoryStatus: memoryLine.length + memberImpressionsLine.length,
      participation: participationLine.length,
      fishGuard: fishGuardLine.length,
      tokenGuard: canOmitStatic ? 0 : tokenGuardLine.length,
      preSleep: canOmitStatic ? 0 : preSleepLine.length,
      staticAnchor: staticAnchorLine.length,
      staticOmitted: canOmitStatic ? 1 : 0,
      staticSavedChars: canOmitStatic ? Math.max(0, staticBlock.length + extraOmittedChars - staticAnchorLine.length) : 0,`,
  'lastWakePromptMeta staticSavedChars & tokenGuard',
);
console.log('5/5 Patched buildWakePromptV2 Opt-3 expansion');

fs.writeFileSync(BRIDGE_PATH, bridge, 'utf8');
console.log('Done deploying Opt-3 expansion');
