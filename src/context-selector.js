/**
 * context-selector.js
 * 阶段 0：统一上下文选择器与权限基建
 *
 * 核心原则（遵循 code_artifact.md 与 agent.md）：
 * 1. 唯一真相源：memory-card 及其背后的 JSONL 归档继续作为系统记忆与权限的唯一权威来源。
 * 2. 拒绝盲目双写：收拢 memory-card 与 sharedContext 注入链路，由 selectContext 统一预算与去重。
 * 3. 权限后置：任何进入 Prompt 的记忆碎片，都必须通过全局唯一的 visible(record, requestCtx) 校验（Fail-Closed）。
 * 4. 槽位优先：绝对优先保证 pinned / firstMet（初次相遇、主人重要约定）的槽位，剩余预算再分配给动态记忆与证据。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  MOOD_CONGRUENCE_WEIGHT,
  estimateRecordEmotion,
  moodCongruenceScore,
} from './memory-reconsolidation.js';

/**
 * 统一定义 sourceRef 数据结构
 *
 * @typedef {Object} SourceRef
 * @property {'qq'|'bili'|'pet'|'shared'|'rtm'|string} platform 来源平台
 * @property {string} conversationKey 会话标识（如 private:QQ, group:GID, pet）
 * @property {string} speaker 发言人昵称或身份标识
 * @property {'owner'|'trusted'|'public'} audience 受众等级
 * @property {string} originalTime 原始事件发生时间（ISO字符串）
 * @property {string} recordId 全局唯一记录ID
 */

function shortHash(value) {
  return crypto.createHash('sha1').update(String(value ?? '')).digest('hex').slice(0, 12);
}

/**
 * 归一化单条记录的 audience
 * @param {Object} record
 * @returns {'owner'|'trusted'|'public'}
 */
export function resolveRecordAudience(record = {}) {
  if (['owner', 'trusted', 'public'].includes(record.audience)) {
    return record.audience;
  }
  if (record.sensitive === true) {
    return 'owner';
  }
  const key = String(record.conversationKey ?? '').trim();
  const platform = String(record.platform ?? '').toLowerCase();
  const scope = String(record.scope ?? '').toLowerCase();

  // 桌宠对话专属主人私域
  if (platform === 'pet' || scope === 'pet' || key === 'pet') {
    return 'owner';
  }

  const isOwner = record.isOwner === true
    || record.source === 'qq-owner'
    || record.source === 'pet-owner'
    || (Array.isArray(record.tags) && record.tags.includes('owner'));

  if (record.private === true || key.startsWith('private:')) {
    return isOwner ? 'owner' : 'trusted';
  }
  if (key.startsWith('group:')) {
    return 'public';
  }
  if (platform === 'bili' || scope === 'bili' || scope === 'shared' || platform === 'shared') {
    return 'public';
  }
  return isOwner ? 'owner' : 'public';
}

/**
 * 1. 从记忆记录或外部证据中提取/构造标准 sourceRef
 * @param {Object} record
 * @returns {SourceRef}
 */
export function createSourceRef(record = {}) {
  const rawId = record.recordId || record.id || '';
  const recordId = String(rawId || (record.text || record.title
    ? `mem_${shortHash(`${record.platform || ''}|${record.conversationKey || ''}|${record.createdAt || record.at || ''}|${record.text || record.title}`)}`
    : ''));
  const platform = String(record.platform || record.sourcePlatform || 'shared').toLowerCase();
  const conversationKey = String(record.conversationKey || '').trim();
  const speaker = String(record.speaker || '').trim();
  const audience = resolveRecordAudience(record);
  const originalTime = String(record.originalTime || record.createdAt || record.at || new Date().toISOString());

  return {
    platform,
    conversationKey,
    speaker,
    audience,
    originalTime,
    recordId,
  };
}

/**
 * 2. 全局唯一的可见性校验函数 visible(record, requestCtx)
 * 纯函数，默认返回 false（Fail-Closed 安全设计）。
 *
 * @param {Object} record - 候选记忆或证据对象（支持内嵌 sourceRef 或裸记录）
 * @param {Object} requestCtx - 当前请求上下文
 *   @param {string} requestCtx.platform - 当前平台 ('qq', 'bili', 'pet', 'astrbot', ...)
 *   @param {string} requestCtx.conversationKey - 当前会话 Key ('private:QQ', 'group:GID', 'pet')
 *   @param {boolean} [requestCtx.isOwner] - 当前会话是否为主人本人
 *   @param {'owner'|'trusted'|'public'} [requestCtx.audience] - 当前会话受众等级
 *   @param {Set<string>|Array<string>} [requestCtx.allowedGroups] - 同圈互通群号集合
 *   @param {boolean} [requestCtx.allowGlobalPreview] - 是否允许本地无 key 预览（默认 false）
 *   @param {boolean} [requestCtx.includeSensitive] - 是否包含敏感条目（默认 false，Prompt 注入永不包含）
 * @returns {boolean} 是否允许对当前上下文可见
 */
export function visible(record, requestCtx) {
  if (!record || typeof record !== 'object') return false;
  if (!requestCtx || typeof requestCtx !== 'object') return false;

  const ref = record.sourceRef || createSourceRef(record);
  const { platform: recordPlatform, conversationKey: recordConv, audience: recordAudience } = ref;
  const recordScope = String(record.scope || '').toLowerCase();

  const ctxPlatform = String(requestCtx.platform ?? '').trim().toLowerCase();
  const ctxConv = String(requestCtx.conversationKey ?? '').trim();
  const ctxIsOwner = requestCtx.isOwner === true || requestCtx.audience === 'owner';

  if (!ctxPlatform) return false;

  // 0. 已作废（被新 effectiveFrom 替换 / 过期）或未批准的 Dream 候选禁止进入注入
  if (record.superseded === true || Boolean(record.supersededBy)) {
    return false;
  }
  if (record.expiresAt) {
    const expMs = Date.parse(String(record.expiresAt));
    if (Number.isFinite(expMs) && expMs < (Number(requestCtx.now) || Date.now())) {
      return false;
    }
  }
  if (record.source === 'dream' && record.status && record.status !== 'promoted') {
    return false;
  }
  // Wish #2：血（情绪经历 / 自我印象）只留在日记与笔记按需查阅，不每轮灌入 Prompt。
  const isBlood = record.memoryTier === 'blood'
    || record.dreamKind === 'impression'
    || record.dreamKind === 'self_impression'
    || record.kind === 'impression'
    || record.kind === 'self_impression';
  if (isBlood && requestCtx.includeBlood !== true) {
    return false;
  }
  if ((record.dreamKind === 'impression' || record.dreamKind === 'self_impression')
      && (!ctxIsOwner || requestCtx.audience !== 'owner' || ctxConv.startsWith('group:') || ctxPlatform === 'bili')) {
    return false;
  }

  // 1. 敏感词与隐私保护：默认不进入 Prompt 注入
  if (record.sensitive === true && requestCtx.includeSensitive !== true) {
    return false;
  }

  // 2. 桌宠私域隔离：仅主人私聊或本地桌宠可见
  if (recordPlatform === 'pet' || recordScope === 'pet' || recordConv === 'pet') {
    if (ctxPlatform === 'bili') return false;
    if (!ctxIsOwner) return false;
    return ctxConv.startsWith('private:') || ctxConv === 'pet' || (requestCtx.allowGlobalPreview === true && !ctxConv);
  }

  // 3. 平台隔离：B 站绝对不可查 QQ 私有/群聊记忆，仅允许公开且明确共享/B站记忆
  if (ctxPlatform === 'bili') {
    if (recordAudience !== 'public') return false;
    if (recordPlatform === 'bili' || recordScope === 'bili' || recordScope === 'shared') {
      return true;
    }
    return false;
  }

  // 4. 严格校验 audience === 'owner'：requestCtx 必须证明当前是主人私聊
  if (recordAudience === 'owner') {
    if (!ctxIsOwner) return false;
    if (ctxConv.startsWith('group:')) return false; // 绝对禁止在群聊中泄漏主人私密记忆
    const inOwnerPrivate = ctxConv.startsWith('private:') || ctxConv === 'pet' || (requestCtx.allowGlobalPreview === true && !ctxConv);
    if (!inOwnerPrivate) return false;
    if (recordConv && recordConv.startsWith('private:') && ctxConv && ctxConv !== recordConv) {
      return false;
    }
    return true;
  }

  // 5. 严格校验 conversationKey：好友私聊绝对隔离
  if (recordConv.startsWith('private:')) {
    if (ctxConv.startsWith('group:')) return false; // 私聊记录绝不进群
    if (!ctxConv) return false;
    if (ctxConv !== recordConv) return false; // 好友 A 与好友 B 严格隔离
    return true;
  }

  // 6. 严格校验 conversationKey：群聊记忆不可泄漏到其他群或外部私聊
  if (recordConv.startsWith('group:')) {
    if (!ctxConv.startsWith('group:')) return false; // 群聊记忆不进私聊
    if (ctxConv === recordConv) return true;
    const allowedGroups = requestCtx.allowedGroups instanceof Set
      ? requestCtx.allowedGroups
      : new Set(Array.isArray(requestCtx.allowedGroups) ? requestCtx.allowedGroups : []);
    const recordGid = recordConv.slice('group:'.length);
    return allowedGroups.has(recordGid);
  }

  // 7. 公开共享经验 / 手动全局记忆
  if (recordAudience === 'public') {
    const isSharedOrPublic = recordPlatform === 'bili'
      || recordPlatform === 'shared'
      || recordScope === 'shared'
      || recordScope === 'bili'
      || record.manual === true
      || record.source === 'manual';
    if (isSharedOrPublic && (ctxConv.startsWith('group:') || ctxConv.startsWith('private:') || ctxConv === 'pet' || requestCtx.allowGlobalPreview === true)) {
      return true;
    }
  }

  // 默认返回 false（Fail-Closed）
  return false;
}

/**
 * 内部隐私脱敏与默认行格式化（当未传入外部 formatRecord 时使用）
 */
function defaultFormatLine(item, { audience = 'owner' } = {}) {
  const title = item.title ? `「${item.title}」` : '';
  let text = String(item.text || '').replace(/\s+/g, ' ').trim();
  // 基础脱敏防护：防止密钥/长 token/URL 意外渲染
  text = text
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|ghp_[a-zA-Z0-9]{16,}|Bearer\s+[a-zA-Z0-9._-]+)\b/gi, '[已隐藏密钥]')
    .replace(/https?:\/\/\S+/gi, '[链接]');
  if (!text && !title) return '';
  if (text.length > 220) text = `${text.slice(0, 219)}…`;
  const body = title && !text.includes(item.title) ? `${title} ${text}` : (text || title);
  const speaker = item.sourceRef?.speaker ? `${item.sourceRef.speaker}：` : '';
  const tag = item.kind === 'pinned' ? '[重要] ' : (item.kind === 'evidence' ? '[线索] ' : '');
  const datePart = item.createdAt && /^\d{4}-\d{2}-\d{2}/.test(String(item.createdAt))
    ? `${String(item.createdAt).slice(0, 10)} `
    : '';
  if (audience === 'public' && speaker) {
    return `- ${datePart}${tag}${body}`.trim();
  }
  return `- ${datePart}${tag}${speaker}${body}`.trim();
}

function normalizeSnippetForDedupe(text) {
  return String(text ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^- \d{4}-\d{2}-\d{2}\s+\[[^\]]+\]\s*/gm, '')
    .replace(/^【[^】]+】/gm, '')
    .replace(/^(?:主人|Denia|[^：:\n]{1,20})(?:（[^）]{1,12}）)?[：:]\s*/g, '')
    .replace(/[\s，。！？、,.!?;；:："'「」『』()（）~～…—-]/g, '')
    .toLowerCase()
    .slice(0, 72);
}

function extractTopicTokens(queryText) {
  const raw = String(queryText || '').trim();
  const tokens = new Set();
  if (!raw) return { queryLower: '', tokens };
  const cleaned = raw.replace(/https?:\/\/\S+/gi, ' ').replace(/\[(?:图片|表情|拍一拍|引用)[^\]]*\]/g, ' ');
  for (const part of cleaned.split(/[\s,，。.!！?？;；:：、/|()（）「」『』\[\]<>《》"']+/)) {
    if (!part) continue;
    if (/^[\u4e00-\u9fff]+$/.test(part)) {
      if (part.length === 2) tokens.add(part);
      else if (part.length > 2) {
        for (let i = 0; i < part.length - 1; i += 1) tokens.add(part.slice(i, i + 2));
      }
    } else if (part.length >= 2) {
      tokens.add(part.toLowerCase());
    }
  }
  return { queryLower: cleaned.toLowerCase(), tokens };
}

function isCuratedMemoryRecord(record = {}) {
  return Boolean(
    record.key
    || record.memoryTier === 'bone'
    || record.memoryTier === 'flesh'
    || record.source === 'dream'
    || record.source === 'manual'
    || record.dreamKind === 'structured_fact'
    || record.dreamKind === 'fact'
    || record.dreamKind === 'directive'
    || record.pinned === true
    || record.firstMet === true
    || record.anchor === true,
  );
}

function isRawChatLogRecord(record = {}) {
  return Boolean(
    ['qq-owner', 'qq-private', 'qq-group', 'qq-self', 'pet-owner', 'pet-self'].includes(record?.source)
    && !isCuratedMemoryRecord(record),
  );
}

function scoreTopicMatch(item, queryLower, tokens) {
  if (!tokens || tokens.size === 0) return 0;
  const raw = item.rawRecord || {};
  const title = String(item.title || raw.title || '').toLowerCase();
  const text = String(item.text || raw.text || '').toLowerCase();
  const tags = (Array.isArray(raw.tags) ? raw.tags.join(' ') : '').toLowerCase();
  const keyStr = String(raw.key || '').toLowerCase();
  const speaker = String(raw.speaker || '').toLowerCase();
  let score = 0;
  for (const tk of tokens) {
    if (keyStr && keyStr.includes(tk)) score += 6;
    if (title && title.includes(tk)) score += 4;
    if (tags && tags.includes(tk)) score += 3;
    if (speaker && speaker.includes(tk)) score += 2;
    if (text && text.includes(tk)) score += 2;
  }
  if (queryLower && queryLower.length >= 3 && queryLower.length <= 24 && text.includes(queryLower)) {
    score += 4;
  }
  return score;
}

/**
 * 从 sharedContext 相关存储中提取结构化候选（不读取 memory-card.json 以避免双写重复）
 */
function collectSharedSourceItems({
  biliMemoryPath = '',
  inboxPath = '',
  notesDir = '',
  conversationKey = '',
  isOwner = false,
  platform = 'qq',
  includeSharedNotes = false,
} = {}) {
  const items = [];
  const ownerConv = isOwner && conversationKey.startsWith('private:') ? conversationKey : '';

  // A. B站近期可共享经历 (bili-memory.json)
  if (biliMemoryPath) {
    try {
      const raw = fs.readFileSync(biliMemoryPath, 'utf8').replace(/^\uFEFF/, '');
      const entries = (JSON.parse(raw).entries || []).filter((e) => e && e.shareable === true && !e.sensitive);
      entries.sort((a, b) => Date.parse(b.at || b.date || 0) - Date.parse(a.at || a.date || 0));
      for (const e of entries.slice(0, 2)) {
        const text = [e.title, e.anecdote || e.reason || e.text].filter(Boolean).join('：');
        if (!text) continue;
        const id = `bili_${String(e.id || shortHash(text))}`;
        items.push({
          id,
          recordId: id,
          platform: 'bili',
          scope: 'shared',
          audience: 'public',
          conversationKey: '',
          text,
          createdAt: String(e.at || e.date || new Date().toISOString()),
          importance: 22,
          section: 'shared',
        });
      }
    } catch {}
  }

  // B. QQ 主人最新「共同记忆：」未合并的 inbox 声明
  if (isOwner && ownerConv && inboxPath) {
    try {
      if (fs.existsSync(inboxPath)) {
        const fd = fs.openSync(inboxPath, 'r');
        try {
          const size = fs.fstatSync(fd).size;
          const len = Math.min(size, 65536);
          const buf = Buffer.alloc(len);
          const readBytes = fs.readSync(fd, buf, 0, len, size - len);
          const lines = buf.subarray(0, readBytes).toString('utf8').split('\n').reverse();
          let count = 0;
          for (const line of lines) {
            if (!line.trim()) continue;
            let row;
            try { row = JSON.parse(line); } catch { continue; }
            if (row.isOwner !== true || row.conversationKey !== ownerConv || row.sensitive) continue;
            const match = /^共同记忆\s*[：:]\s*(.+)/s.exec(row.text || '');
            if (!match) continue;
            const text = match[1].trim();
            const id = `inbox_shared_${shortHash(`${row.at || ''}|${text}`)}`;
            items.push({
              id,
              recordId: id,
              platform: 'qq',
              conversationKey: ownerConv,
              speaker: '主人',
              isOwner: true,
              private: true,
              audience: 'owner',
              text,
              createdAt: String(row.at || new Date().toISOString()),
              importance: 45,
              section: 'shared',
            });
            if (++count >= 3) break;
          }
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch {}
  }

  // C. 共享便签目录 (NOTES_DIR) —— Wish #2/#4：不再每轮无条件灌入旧「四端共享/主人共享/三端共享」便签，仅显式传 includeSharedNotes=true 时加载。
  if (includeSharedNotes && notesDir && isOwner) {
    try {
      if (fs.existsSync(notesDir)) {
        const stampOf = (name) => name.slice(name.indexOf('-') + 1);
        const noteNames = fs.readdirSync(notesDir).sort((a, b) => stampOf(b).localeCompare(stampOf(a)));
        const candidates = [
          ...noteNames.filter((n) => /^四端共享-.*\.md$/.test(n)).slice(0, 12),
          ...noteNames.filter((n) => /^(主人共享|三端共享)-.*\.md$/.test(n)).slice(0, 24),
        ];
        let picked = 0;
        for (const name of candidates) {
          if (picked >= 8) break;
          if (/^dream[-_.]/i.test(name) || name.toLowerCase().includes('dream/')) continue;
          const file = path.join(notesDir, name);
          try {
            if (fs.statSync(file).size > 16384) continue;
            const content = fs.readFileSync(file, 'utf8');
            if (content.includes('[SYSTEM_EVENT:')) continue;
            const clean = content.replace(/^#\s+[^\n]+\n+/, '').replace(/\s+/g, ' ').trim();
            if (!clean) continue;
            const isPublicNote = name.startsWith('四端共享-');
            const id = `note_${shortHash(name)}`;
            items.push({
              id,
              recordId: id,
              platform: isPublicNote ? 'shared' : platform,
              scope: isPublicNote ? 'shared' : 'qq',
              audience: isPublicNote ? 'public' : 'owner',
              conversationKey: isPublicNote ? '' : ownerConv,
              isOwner: !isPublicNote,
              text: clean.slice(0, 260),
              createdAt: new Date(fs.statSync(file).mtimeMs).toISOString(),
              importance: 24,
              section: 'shared',
            });
            picked++;
          } catch {}
        }
      }
    } catch {}
  }

  return items;
}

/**
 * 3. 重构 Prompt 上下文选择器 selectContext(ctx, budget)
 *
 * 职责：
 * 1. 统一接收当前会话上下文与预算，统筹 memory-card、sharedContext 以及未来 RTM 证据槽位
 * 2. 全面调用 visible(record, requestCtx) 严格过滤
 * 3. 按照 recordId 去重，绝不在同一轮 Prompt 出现重复 ID
 * 4. 优先保证 pinned（初次相遇、永久锚点）的槽位，再将剩余预算分配给动态证据
 * 5. 返回渲染文本块 blocks 以及本次注入包含的 usedIds 数组
 *
 * @param {Object} ctx - 环境上下文
 * @param {number|Object} budget - 字数预算（如 2200）或预算配置对象
 * @returns {{ blocks: string, usedIds: string[] }}
 */
export function selectContext(ctx = {}, budget = 2200) {
  const maxChars = typeof budget === 'number'
    ? budget
    : Number(budget?.maxChars ?? 2200);
  const now = Number.isFinite(Number(ctx.now)) ? Number(ctx.now) : Date.now();
  const platform = String(ctx.platform || 'qq').toLowerCase();
  const conversationKey = String(ctx.conversationKey || '').trim();
  const isOwner = ctx.isOwner === true
    || (Boolean(ctx.ownerQQ) && conversationKey === `private:${String(ctx.ownerQQ)}`);
  const audience = ['owner', 'trusted', 'public'].includes(ctx.audience)
    ? ctx.audience
    : (isOwner ? 'owner' : (conversationKey.startsWith('group:') ? 'public' : 'trusted'));

  const requestCtx = {
    platform,
    conversationKey,
    isOwner,
    audience,
    allowedGroups: ctx.allowedGroups,
    allowGlobalPreview: ctx.allowGlobalPreview === true,
    includeSensitive: ctx.includeSensitive === true,
    includeBlood: ctx.includeBlood === true,
    now,
  };
  const { queryLower, tokens: topicTokens } = extractTopicTokens(ctx.queryText || '');
  const hasTopicQuery = topicTokens.size > 0;

  const usedIds = new Set();
  const usedRecords = [];
  const seenContent = new Set();
  const pinnedItems = [];
  const dynamicItems = [];

  // --- 1. 收集 memory-card 来源候选 ---
  let records = [];
  let loadedStructuredCard = false;
  if (Array.isArray(ctx.records)) {
    records = ctx.records;
    loadedStructuredCard = true;
  } else if (ctx.memoryCard && Array.isArray(ctx.memoryCard.records)) {
    records = ctx.memoryCard.records;
    loadedStructuredCard = true;
  } else if (ctx.cardPath) {
    try {
      const card = JSON.parse(fs.readFileSync(ctx.cardPath, 'utf8').replace(/^\uFEFF/, ''));
      if (Array.isArray(card.records)) {
        records = card.records;
        loadedStructuredCard = true;
      }
    } catch {}
  }

  for (const record of records) {
    if (!visible(record, requestCtx)) continue;
    const ref = record.sourceRef || createSourceRef(record);
    const id = ref.recordId;
    if (!id) continue;
    const isPinned = record.pinned === true || record.firstMet === true || record.anchor === true;
    const item = {
      id,
      sourceRef: ref,
      sourceType: 'memory-card',
      kind: isPinned ? 'pinned' : 'memory',
      firstMet: record.firstMet === true,
      title: record.title || '',
      text: record.text || '',
      clarity: record.clarity || 'clear',
      importance: Number(record.importance) || 20,
      createdAt: record.createdAt || ref.originalTime,
      rawRecord: record,
    };
    if (isPinned) pinnedItems.push(item);
    else dynamicItems.push(item);
  }

  // --- 2. 收集 sharedContext 来源候选 ---
  const sharedItems = Array.isArray(ctx.sharedRecords)
    ? ctx.sharedRecords
    : collectSharedSourceItems({
      biliMemoryPath: ctx.biliMemoryPath,
      inboxPath: ctx.inboxPath,
      notesDir: ctx.notesDir,
      conversationKey,
      isOwner,
      platform,
      includeSharedNotes: ctx.includeSharedNotes === true,
    });

  for (const sItem of sharedItems) {
    if (!visible(sItem, requestCtx)) continue;
    const ref = sItem.sourceRef || createSourceRef(sItem);
    const id = ref.recordId;
    if (!id) continue;
    dynamicItems.push({
      id,
      sourceRef: ref,
      sourceType: 'shared',
      kind: sItem.pinned ? 'pinned' : 'shared',
      firstMet: false,
      title: sItem.title || '',
      text: sItem.text || '',
      importance: Number(sItem.importance) || 22,
      createdAt: sItem.createdAt || ref.originalTime,
      rawRecord: sItem,
    });
  }

  // 兼容直接传入的旧 sharedText 字符串（仅当未传 structured sharedRecords 且确实有增量文本时去重抽取）
  if (typeof ctx.sharedText === 'string' && ctx.sharedText.trim() && !ctx.notesDir && !ctx.biliMemoryPath) {
    const lines = ctx.sharedText.split(/\r?\n/).map((l) => l.trim()).filter((l) => (
      l && !l.startsWith('以下是历史资料') && !l.startsWith('【桌宠 / AstrBot')
    ));
    for (const line of lines) {
      const id = `shared_${shortHash(line)}`;
      const candidate = {
        id,
        recordId: id,
        platform,
        conversationKey,
        isOwner,
        audience,
        text: line,
      };
      if (!visible(candidate, requestCtx)) continue;
      dynamicItems.push({
        id,
        sourceRef: createSourceRef(candidate),
        sourceType: 'shared',
        kind: 'shared',
        firstMet: false,
        title: '',
        text: line,
        importance: 18,
        createdAt: new Date(now).toISOString(),
        rawRecord: candidate,
      });
    }
  }

  // --- 3. 收集外部证据来源候选（未来 RTM 证据槽位） ---
  if (Array.isArray(ctx.evidence)) {
    for (const ev of ctx.evidence) {
      if (!visible(ev, requestCtx)) continue;
      const ref = ev.sourceRef || createSourceRef(ev);
      const id = ref.recordId;
      if (!id) continue;
      dynamicItems.push({
        id,
        sourceRef: ref,
        sourceType: 'rtm-evidence',
        kind: 'evidence',
        firstMet: false,
        title: ev.title || '',
        text: ev.text || '',
        importance: Number(ev.importance) || 25,
        createdAt: ev.createdAt || ref.originalTime,
        rawRecord: ev,
      });
    }
  }

  // --- 4. 当结构化卡不存在时，使用 legacyBlock 作为测试夹具或纯文本降级兜底 ---
  if (!loadedStructuredCard && pinnedItems.length === 0 && dynamicItems.length === 0 && typeof ctx.legacyBlock === 'string' && ctx.legacyBlock.trim()) {
    const rawLegacy = ctx.legacyBlock.trim();
    const id = `legacy_${shortHash(`${conversationKey}|${rawLegacy}`)}`;
    const outText = maxChars > 0 && rawLegacy.length > maxChars
      ? `${rawLegacy.slice(0, Math.max(0, maxChars - 1))}…`
      : rawLegacy;
    return {
      blocks: outText,
      usedIds: [id],
    };
  }

  // --- 5. 槽位优先排序、1事实1卡 key 去重与话题按需检索（Wish #2/#4） ---
  // Pinned：初次相遇（firstMet）排最前，其余锚点按重要度与最近时间排，上限紧凑。
  pinnedItems.sort((a, b) => (b.firstMet ? 1 : 0) - (a.firstMet ? 1 : 0) || b.importance - a.importance);

  // 同 key 仅保留最新 effectiveFrom / createdAt 的一条（1 事实 1 卡）
  const bestByKey = new Map();
  for (const item of [...pinnedItems, ...dynamicItems]) {
    const k = String(item.rawRecord?.key || '').trim();
    if (!k) continue;
    const eff = String(item.rawRecord?.effectiveFrom || '');
    const ts = Date.parse(item.createdAt || 0) || 0;
    const prev = bestByKey.get(k);
    if (!prev || eff > prev.eff || (eff === prev.eff && ts > prev.ts)) {
      bestByKey.set(k, { item, eff, ts });
    }
  }
  const filterKeyWinner = (item) => {
    const k = String(item.rawRecord?.key || '').trim();
    if (!k) return true;
    return bestByKey.get(k)?.item === item;
  };

  const largeCardMode = records.length > 15 && ctx.includeRawChatFallback !== true;
  const maxPinnedItems = Number.isFinite(Number(ctx.maxPinnedItems)) ? Math.max(1, Number(ctx.maxPinnedItems)) : 5;
  const maxDynamicItems = Number.isFinite(Number(ctx.maxDynamicItems))
    ? Math.max(0, Number(ctx.maxDynamicItems))
    : ((hasTopicQuery || largeCardMode) ? 6 : 999);

  for (const item of dynamicItems) {
    item.topicHits = hasTopicQuery ? scoreTopicMatch(item, queryLower, topicTokens) : 0;
  }

  const filteredDynamic = dynamicItems.filter((item) => {
    if (!filterKeyWinner(item)) return false;
    if (item.sourceType === 'rtm-evidence') return true;
    const raw = item.rawRecord || {};
    if (hasTopicQuery) {
      // 有当前话题词时：旧原始聊天记录必须有较高话题重合（>=3，防止“早上好”捞出泛问候旧水话），shared 至少 >0
      if (item.sourceType === 'shared') return item.topicHits > 0;
      if (isRawChatLogRecord(raw)) return item.topicHits >= 3;
      return true;
    }
    if (largeCardMode && isRawChatLogRecord(raw)) {
      return false;
    }
    return true;
  });

  // Dynamic：优先话题命中分，其次心境一致或重要度 + 创建时间降序。
  const currentEmotion = ctx.currentEmotion && typeof ctx.currentEmotion === 'object' ? ctx.currentEmotion : null;
  const moodActive = Boolean(currentEmotion && Number.isFinite(Number(currentEmotion.valence)) && Math.abs(Number(currentEmotion.valence)) >= 0.08);
  const rawWeight = Number(ctx.moodCongruenceWeight);
  const moodWeight = moodActive
    ? Math.min(0.2, Math.max(0.15, Number.isFinite(rawWeight) ? rawWeight : MOOD_CONGRUENCE_WEIGHT))
    : 0;
  const reconMap = ctx.reconsolidation && typeof ctx.reconsolidation === 'object' ? ctx.reconsolidation : null;

  function dynamicRankScore(item) {
    if (!moodActive) return 0;
    const normImp = Math.min(1, Math.max(0, (Number(item.importance) || 20) / 100));
    const recon = reconMap?.[item.id];
    const recEmotion = recon && Number.isFinite(Number(recon.valence))
      ? { valence: Number(recon.valence), arousal: Number(recon.arousal ?? 0.25) }
      : estimateRecordEmotion(item.rawRecord || item);
    const congruence = moodCongruenceScore(recEmotion, currentEmotion);
    return normImp * (1 - moodWeight) + congruence * moodWeight;
  }

  filteredDynamic.sort((a, b) => {
    if (hasTopicQuery && b.topicHits !== a.topicHits) return b.topicHits - a.topicHits;
    if (moodActive) {
      const diff = dynamicRankScore(b) - dynamicRankScore(a);
      if (Math.abs(diff) > 1e-6) return diff;
    }
    return b.importance - a.importance || Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0);
  });

  const headerLines = [
    `<!-- memory-audience: ${audience}; export-version: 3 -->`,
    '【记忆卡 · 零散线索（非台词）】',
    '（只是脑后留着的一点背景线索：自然聊到才用，没记清就直说“记不清了”，绝不硬背或装作全都记得。）',
  ];
  const header = headerLines.join('\n');
  const footer = platform === 'bili'
    ? '（这些只是你自己的公开经历；不要在 B 站公开提到 QQ 群、QQ 号或群昵称。）'
    : '（这些是线索与经历，不是必背台词；说话用你自己的语气。）';

  const overheadChars = header.length + footer.length + 4;
  let currentChars = overheadChars;

  const pinnedLines = [];
  const memoryLines = [];
  const sharedLines = [];
  const seenPrefixes = new Set();

  function renderCandidateLine(item) {
    if (item.sourceType === 'memory-card' && typeof ctx.formatRecord === 'function') {
      return ctx.formatRecord(item.rawRecord, { platform, full: false, audience, now }) || '';
    }
    return defaultFormatLine(item, { audience });
  }

  function tryAddItem(item, bucket) {
    if (!item.id || usedIds.has(item.id)) return false; // 严格按 recordId 去重
    const line = renderCandidateLine(item);
    if (!line) return false;

    const dedupeKey = normalizeSnippetForDedupe(item.text || line);
    const prefixKey = dedupeKey.length >= 20 ? dedupeKey.slice(0, 20) : '';
    if (dedupeKey && seenContent.has(dedupeKey)) {
      return false; // Wish #4：跨 memory-card 与 shared 去重，1 事实 1 卡
    }
    if (prefixKey && seenPrefixes.has(prefixKey) && !item.rawRecord?.key) {
      return false;
    }

    if (maxChars > 0 && currentChars + line.length + 1 > maxChars) {
      // 预算不足时：非置顶动态内容直接裁剪跳过；置顶内容优先保障槽位
      if (item.kind !== 'pinned') return false;
    }

    usedIds.add(item.id);
    if (item.sourceType === 'memory-card') {
      usedRecords.push({
        id: item.id,
        title: item.title,
        text: item.text,
      });
    }
    if (dedupeKey) seenContent.add(dedupeKey);
    if (prefixKey) seenPrefixes.add(prefixKey);
    bucket.push(line);
    currentChars += line.length + 1;
    return true;
  }

  // A. 先保核心常驻 pinned 槽位
  for (const item of pinnedItems) {
    if (!filterKeyWinner(item)) continue;
    if (pinnedLines.length >= maxPinnedItems) break;
    tryAddItem(item, pinnedLines);
  }

  // B. 剩余预算分配给与当前话题最相关的动态记忆与证据
  let dynamicAdded = 0;
  let ambientNonMatchCount = 0;
  for (const item of filteredDynamic) {
    if (dynamicAdded >= maxDynamicItems) break;
    if (maxChars > 0 && currentChars >= maxChars) break;
    // 若当前对话已有话题词，未命中话题的骨/肉卡最多补 2 条在后，避免全量灌输
    if (hasTopicQuery && item.topicHits === 0 && item.sourceType !== 'rtm-evidence') {
      if (ambientNonMatchCount >= 2) continue;
    }
    const bucket = item.sourceType === 'memory-card' ? memoryLines : sharedLines;
    if (tryAddItem(item, bucket)) {
      dynamicAdded += 1;
      if (hasTopicQuery && item.topicHits === 0 && item.sourceType !== 'rtm-evidence') {
        ambientNonMatchCount += 1;
      }
    }
  }

  if (pinnedLines.length === 0 && memoryLines.length === 0 && sharedLines.length === 0) {
    return {
      blocks: '',
      usedIds: [],
    };
  }

  const sections = [header];
  if (pinnedLines.length) {
    sections.push(`## 初次相遇与核心约定\n${pinnedLines.join('\n')}`);
  }
  if (memoryLines.length) {
    sections.push(`## 记忆与经历\n${memoryLines.join('\n')}`);
  }
  if (sharedLines.length) {
    sections.push(`## 共享经历与线索\n${sharedLines.join('\n')}`);
  }
  sections.push(footer);

  let blocks = sections.join('\n\n');
  if (maxChars > 0 && blocks.length > maxChars && pinnedLines.length === 0) {
    blocks = `${blocks.slice(0, Math.max(0, maxChars - 1))}…`;
  }

  return {
    blocks,
    usedIds: Array.from(usedIds),
    usedRecords,
  };
}
