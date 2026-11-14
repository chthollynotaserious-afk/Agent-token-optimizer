/**
 * Universal Memory Extraction, Persistence & Scope-Safe Recall (Built-in Core)
 *
 * Closes the out-of-the-box gap between session lifecycle hooks and actual memory persistence:
 *   - Deterministic zero-dependency memory extractor (preferences, decisions, incidents, facts)
 *   - Optional custom `summarizeFn` hook for agents using their own LLM/domain summarizer
 *   - In-memory + optional JSONL persistence for extracted memories & archived sessions
 *   - Fail-Closed multi-tenant / multi-scope ACL recall reusing `canAccessScope` & `redactSecrets`
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canAccessScope, redactSecrets } from './context-selector.js';

const PREFERENCE_RE = /\b(?:prefer|always|never|must|don't|do not|remember)\b|偏好|习惯|记住|必须|不要|禁止|以后都/i;
const DECISION_RE = /\b(?:decided|decision|choose|chosen|switched|configured|port|endpoint|model|use)\b|决定|采用|配置|端口|方案|切换|改用/i;
const INCIDENT_RE = /\b(?:error|failed|failure|exception|bug|fix|fixed|resolved|root cause)\b|报错|失败|异常|修复|解决|排查/i;

export function extractTextContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          return part.text ?? part.content ?? (part.type === 'tool_result' ? extractTextContent(part.content) : '');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object') {
    return String(content.text ?? content.rawMessage ?? content.summary ?? content.content ?? '');
  }
  return String(content);
}

export function tokenizeKeywords(text) {
  const cleaned = String(text || '').toLowerCase();
  const tokens = new Set();

  for (const m of cleaned.matchAll(/[a-z0-9_.-]{2,}/g)) {
    tokens.add(m[0]);
  }

  // Extract CJK bigrams and full contiguous spans so Chinese queries recall accurately offline
  for (const m of cleaned.matchAll(/[\u4e00-\u9fff]+/g)) {
    const span = m[0];
    if (span.length === 1) {
      tokens.add(span);
    } else {
      if (span.length <= 6) tokens.add(span);
      for (let i = 0; i < span.length - 1; i += 1) {
        tokens.add(span.slice(i, i + 2));
      }
    }
  }

  return [...tokens];
}

function classifyMemory(text, role) {
  if (PREFERENCE_RE.test(text)) return { kind: 'preference', importance: 85 };
  if (DECISION_RE.test(text)) return { kind: 'decision', importance: 80 };
  if (INCIDENT_RE.test(text)) return { kind: 'incident', importance: 75 };
  if (role === 'user') return { kind: 'fact', importance: 65 };
  return { kind: 'fact', importance: 55 };
}

function isBoilerplateMessage(text) {
  return (
    text.startsWith('[Session Handoff Tail Window]')
    || text.startsWith('[Recall Hint]')
    || text.startsWith('[Retained Tool Output:')
  );
}

/**
 * Deterministic zero-dependency memory extraction from session messages.
 */
export function extractMemoriesFromMessages(messages = [], {
  sessionId = 'default',
  conversationKey = 'default',
  scope = null,
  tenantId = null,
  audience = 'private',
  maxItemChars = 400,
  maxItems = 25,
  now = Date.now(),
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const effectiveScope = scope || conversationKey || 'default';
  const seenHashes = new Set();
  const items = [];

  for (const msg of list) {
    if (!msg || typeof msg !== 'object') continue;
    const role = String(msg.role || (msg.sender ? 'user' : 'user')).toLowerCase();
    if (role === 'system') continue;

    const rawText = redactSecrets(extractTextContent(msg.content ?? msg.rawMessage ?? msg.text ?? '')).trim();
    if (!rawText || rawText.length < 4 || isBoilerplateMessage(rawText)) continue;

    // Skip verbose raw tool dumps; only retain compact error/outcome lines from tool outputs
    if (role === 'tool' && rawText.length > maxItemChars && !INCIDENT_RE.test(rawText)) continue;

    const clipped = rawText.length > maxItemChars ? `${rawText.slice(0, maxItemChars - 3)}...` : rawText;
    const hash = crypto.createHash('sha256').update(`${effectiveScope}:${clipped.toLowerCase()}`, 'utf8').digest('hex').slice(0, 16);
    if (seenHashes.has(hash)) continue;
    seenHashes.add(hash);

    const { kind, importance } = classifyMemory(clipped, role);
    items.push({
      id: `mem_${hash}`,
      recordType: 'memory',
      sessionId,
      conversationKey,
      tenantId: tenantId || undefined,
      scope: effectiveScope,
      audience,
      role,
      kind,
      importance,
      title: kind,
      text: clipped,
      keywords: tokenizeKeywords(clipped),
      hash,
      createdAt: Number(msg.ts) || now,
    });
  }

  // Keep highest-signal memories when capped
  items.sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt);
  return items.slice(0, maxItems);
}

export class UniversalMemoryStore {
  constructor({
    file = null,
    maxEntries = 2000,
    maxArchives = 500,
    summarizeFn = null,
    now = () => Date.now(),
  } = {}) {
    this.file = file;
    this.maxEntries = maxEntries;
    this.maxArchives = maxArchives;
    this.summarizeFn = summarizeFn;
    this.now = now;
    this.records = [];
    this.archives = [];
    this.hashesByScope = new Set();
    this.verificationTokens = new Set();
    if (this.file) this._load();
  }

  get size() {
    return this.records.length + this.archives.length;
  }

  _appendJsonl(obj) {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(obj)}\n`, 'utf8');
    } catch {}
  }

  _load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = fs.readFileSync(this.file, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (!parsed || typeof parsed !== 'object') continue;
          if (parsed.recordType === 'archive') {
            this.archives.push(parsed);
            if (parsed.verificationToken) this.verificationTokens.add(parsed.verificationToken);
          } else {
            this.records.push(parsed);
            if (parsed.hash) this.hashesByScope.add(`${parsed.scope || 'default'}:${parsed.hash}`);
          }
        } catch {}
      }
    } catch {}
  }

  addMemory(item = {}) {
    const scope = String(item.scope || item.conversationKey || 'default');
    const text = redactSecrets(String(item.text || '')).trim();
    if (!text) return null;

    const hash = item.hash
      || crypto.createHash('sha256').update(`${scope}:${text.toLowerCase()}`, 'utf8').digest('hex').slice(0, 16);
    const dedupKey = `${scope}:${hash}`;
    if (this.hashesByScope.has(dedupKey)) return null;

    const record = {
      id: item.id || `mem_${hash}`,
      recordType: 'memory',
      sessionId: item.sessionId || 'default',
      conversationKey: item.conversationKey || scope,
      ...(item.tenantId ? { tenantId: item.tenantId } : {}),
      scope,
      audience: item.audience || 'private',
      ...(Array.isArray(item.allowedScopes) ? { allowedScopes: item.allowedScopes } : {}),
      role: item.role || 'user',
      kind: item.kind || 'fact',
      importance: Number(item.importance) || 65,
      title: item.title || item.kind || 'fact',
      text,
      keywords: Array.isArray(item.keywords) && item.keywords.length > 0 ? item.keywords : tokenizeKeywords(text),
      hash,
      createdAt: Number(item.createdAt) || this.now(),
    };

    if (this.records.length >= this.maxEntries) {
      const evicted = this.records.shift();
      if (evicted?.hash) this.hashesByScope.delete(`${evicted.scope || 'default'}:${evicted.hash}`);
    }
    this.hashesByScope.add(dedupKey);
    this.records.push(record);
    this._appendJsonl(record);
    return record;
  }

  addMemories(items = []) {
    const saved = [];
    for (const item of (Array.isArray(items) ? items : [])) {
      const rec = this.addMemory(item);
      if (rec) saved.push(rec);
    }
    return saved;
  }

  /**
   * Extract & persist memories plus an archive summary for a session (on rotation or manually).
   */
  async flushSession({
    sessionId = 'default',
    conversationKey = 'default',
    scope = null,
    tenantId = null,
    audience = 'private',
    messages = [],
    reason = 'manual',
    now = this.now(),
  } = {}) {
    const effectiveScope = scope || conversationKey || 'default';
    let extracted = [];

    if (typeof this.summarizeFn === 'function') {
      const custom = await this.summarizeFn({
        sessionId,
        conversationKey,
        scope: effectiveScope,
        tenantId,
        messages,
        reason,
        now,
      });
      if (Array.isArray(custom)) {
        extracted = custom.map((entry, idx) => (typeof entry === 'string'
          ? { text: entry, kind: 'summary', importance: 80, id: `mem_${sessionId}_${idx}` }
          : entry));
      } else if (custom && typeof custom === 'object' && Array.isArray(custom.memories)) {
        extracted = custom.memories;
      }
    }

    if (extracted.length === 0) {
      extracted = extractMemoriesFromMessages(messages, {
        sessionId,
        conversationKey,
        scope: effectiveScope,
        tenantId,
        audience,
        now,
      });
    }

    const saved = this.addMemories(
      extracted.map((item) => ({
        ...item,
        sessionId: item.sessionId || sessionId,
        conversationKey: item.conversationKey || conversationKey,
        scope: item.scope || effectiveScope,
        tenantId: item.tenantId ?? tenantId,
        audience: item.audience || audience,
      }))
    );

    const verificationToken = `memok_${crypto.randomBytes(6).toString('hex')}`;
    const summaryText = saved.length > 0
      ? saved.slice(0, 5).map((r) => r.text).join(' | ')
      : extractMemoriesFromMessages(messages, { sessionId, conversationKey, scope: effectiveScope, tenantId, audience, now, maxItems: 3 })
          .map((r) => r.text)
          .join(' | ');

    const archive = {
      id: `arch_${sessionId}_${now}`,
      recordType: 'archive',
      sessionId,
      conversationKey,
      ...(tenantId ? { tenantId } : {}),
      scope: effectiveScope,
      audience,
      reason,
      turnCount: Array.isArray(messages) ? messages.length : 0,
      savedCount: saved.length,
      text: redactSecrets(summaryText || `Archived session ${sessionId} (${reason})`),
      keywords: tokenizeKeywords(summaryText),
      verificationToken,
      createdAt: now,
    };

    if (this.archives.length >= this.maxArchives) {
      this.archives.shift();
    }
    this.archives.push(archive);
    this.verificationTokens.add(verificationToken);
    this._appendJsonl(archive);

    return {
      flushed: true,
      savedCount: saved.length,
      savedIds: saved.map((s) => s.id),
      archiveId: archive.id,
      verificationToken,
    };
  }

  hasVerificationToken(token) {
    return Boolean(token && this.verificationTokens.has(token));
  }

  /**
   * Recall extracted memories & archived session summaries under Fail-Closed Scope ACL.
   */
  recall({
    query = '',
    sessionId = null,
    conversationKey = null,
    scope = null,
    tenantId = null,
    isAdmin = false,
    isOwner = false,
    includeSensitive = false,
    limit = 6,
    maxChars = 3000,
    now = this.now(),
  } = {}) {
    const requestCtx = {
      ...(tenantId ? { tenantId } : {}),
      scope: scope || conversationKey || null,
      isAdmin,
      isOwner,
      includeSensitive,
      now,
    };

    const queryTokens = tokenizeKeywords(query);
    const pool = [...this.records, ...this.archives].filter((rec) => {
      if (!canAccessScope(rec, requestCtx)) return false;
      if (sessionId && rec.sessionId !== sessionId) return false;
      return true;
    });

    const scored = pool.map((rec) => {
      const recKeywords = new Set(rec.keywords || tokenizeKeywords(rec.text));
      let overlap = 0;
      for (const qt of queryTokens) {
        if (recKeywords.has(qt) || String(rec.text || '').toLowerCase().includes(qt)) {
          overlap += 1;
        }
      }
      const queryMatchRatio = queryTokens.length > 0 ? overlap / queryTokens.length : 0;
      const baseImportance = rec.recordType === 'archive' ? 40 : (Number(rec.importance) || 60);
      const score = queryMatchRatio * 100 + baseImportance;
      return { rec, score, overlap };
    });

    const filtered = queryTokens.length > 0
      ? scored.filter((s) => s.overlap > 0 || s.rec.importance >= 85)
      : scored;

    filtered.sort((a, b) => b.score - a.score || (b.rec.createdAt || 0) - (a.rec.createdAt || 0));

    const items = [];
    const lines = [];
    let usedChars = 0;

    for (const { rec, score } of filtered) {
      if (items.length >= limit) break;
      const text = redactSecrets(rec.text).trim();
      if (!text) continue;
      const tag = rec.recordType === 'archive' ? `archive:${rec.sessionId}` : rec.kind;
      const line = `- [${tag}] ${text}`;
      if (maxChars > 0 && usedChars + line.length + 1 > maxChars && items.length > 0) continue;
      items.push({
        id: rec.id,
        recordType: rec.recordType,
        sessionId: rec.sessionId,
        kind: rec.kind || 'archive',
        importance: rec.importance || 40,
        score,
        text,
        createdAt: rec.createdAt,
      });
      lines.push(line);
      usedChars += line.length + 1;
    }

    return {
      found: items.length > 0,
      count: items.length,
      totalAccessible: pool.length,
      usedIds: items.map((i) => i.id),
      items,
      text: lines.join('\n'),
    };
  }
}
