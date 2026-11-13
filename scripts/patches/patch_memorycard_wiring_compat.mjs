import fs from 'node:fs';

const BRIDGE_PATH = '/home/ubuntu/surfcore/src/bridge.js';
let bridge = fs.readFileSync(BRIDGE_PATH, 'utf8');

function replaceExact(src, target, replacement, label) {
  const idx = src.indexOf(target);
  if (idx === -1) throw new Error(`Target not found: ${label}`);
  if (src.indexOf(target, idx + 1) !== -1) throw new Error(`Multiple targets: ${label}`);
  return src.slice(0, idx) + replacement + src.slice(idx + target.length);
}

bridge = replaceExact(
  bridge,
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
  `  function memoryCardPromptBlock(key = '', bundleOut = null) {
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
    if (bundleOut && typeof bundleOut === 'object') {
      bundleOut.blocks = blocks;
      bundleOut.usedIds = usedIds;
      bundleOut.lineById = lineById;
    }
    return blocks;
  }`,
  'restore memoryCardPromptBlock(key, bundleOut)',
);

bridge = replaceExact(
  bridge,
  `    // 二代记忆卡按会话追踪已注入 recordId：首轮与定时刷新全量注入，同会话后续轮仅补充新唤起条目的增量。
    const mcBundle = memoryCardPromptBundle(key);
    const memoryCardFull = mcBundle.blocks ? \`\${mcBundle.blocks}\\n\\n\` : '';`,
  `    // 二代记忆卡按会话追踪已注入 recordId：首轮与定时刷新全量注入，同会话后续轮仅补充新唤起条目的增量。
    const mcBundle = { blocks: '', usedIds: [], lineById: new Map() };
    const memoryCardText = memoryCardPromptBlock(key, mcBundle);
    const memoryCardFull = memoryCardText ? \`\${memoryCardText}\\n\\n\` : '';`,
  'preserve const memoryCardText = memoryCardPromptBlock(',
);

fs.writeFileSync(BRIDGE_PATH, bridge, 'utf8');
console.log('Patched memoryCardPromptBlock wiring compatibility');
