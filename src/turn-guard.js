/**
 * 单轮止血：只做纯策略，不碰 DSH / QQ / 文件（续接记录除外，见 createTurnResumeStore）。
 *
 * 触发条件：
 *   · 单轮工具步数超上限（普通会话 40；主人私聊 60；unlimited 时改用硬上限）；
 *   · 同一 tool + 同一错误重复到阈值；
 *   · 每日额度在回合中间被判定为已耗尽；
 *   · unlimited 专属：硬步数上限、回合超时、同一工具同一参数连续重复（循环）。
 *
 * 真正的 cancel / 通知由 bridge 做；这里只回答“该不该停、为什么停”。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_TURN_GUARD = Object.freeze({
  maxSteps: 40,
  maxRepeatedErrors: 3,
  ownerMaxSteps: 60,
  ownerMode: 'limited',
  unlimitedHardMaxSteps: 400,
  unlimitedMaxTurnMs: 45 * 60_000,
  unlimitedMaxIdenticalCalls: 6,
})

// 预期内的业务拒绝（不是"环境坏了"）：模型重试是浪费，但**不该把整轮停掉**——
// 这类错误自带下一步（比如 qq_close_conversation 会让你先发消息），停轮只会让用户困惑。
// 2026-10-31 实测：同一会话里 qq_close_conversation 连续 3 次「收尾失败…建议 qq_send_message」
// 触发 L3 停轮；实际是模型没听建议，不是通道故障。
const EXPECTED_REJECTION_RE = /(收尾失败|不能收尾|还没到收尾|请先|不在允许|未授权|白名单|审计|令牌|参数|不能为空|格式|频率|限流|已禁用|未开启|没有配|not allowed|permission|invalid)/i;

/** 是不是「预期内的业务拒绝」：此类错误不计入重复错误止血。 */
export function isExpectedToolError(text) {
  return EXPECTED_REJECTION_RE.test(String(text ?? ''));
}

// 会产生真实副作用的工具：续接时必须告诉模型「这些已经做过，别再做一遍」。
const SIDE_EFFECT_TOOL_RE = /(qq_send_|qq_reply|qq_owner_send_message|qq_owner_schedule_message|qq_owner_task_(cancel|update)|qq_qzone_(comment|like|request_publish)|qq_memory_(append|remove|clear)|qq_set_wake_config|qq_sticker_manage|qq_close_conversation|write_diary|qzone_draft_create|workspace_create|claude_(request|nudge)|qq_report_emotion)/;
// 本来就该反复调用的等待类工具：不参与「同参数循环」判定。
const WAITING_TOOL_RE = /(qq_wait_for_messages|qq_get_unread_messages|qq_status|qq_social_state)/;

export function isSideEffectTool(name) {
  return SIDE_EFFECT_TOOL_RE.test(String(name ?? ''));
}

function normalizeError(text) {
  return String(text ?? '')
    .replace(/\b\d+(?:\.\d+)?\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

function fingerprintOf(args) {
  let text = '';
  try { text = typeof args === 'string' ? args : JSON.stringify(args ?? null); } catch { text = String(args); }
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

const positiveInt = (value, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
};

export function createTurnGuard(options = {}) {
  const cfg = { ...DEFAULT_TURN_GUARD, ...(options && typeof options === 'object' ? options : {}) };
  const maxSteps = positiveInt(cfg.maxSteps, DEFAULT_TURN_GUARD.maxSteps);
  const maxRepeatedErrors = positiveInt(cfg.maxRepeatedErrors, DEFAULT_TURN_GUARD.maxRepeatedErrors);
  const ownerMaxSteps = positiveInt(cfg.ownerMaxSteps, DEFAULT_TURN_GUARD.ownerMaxSteps);
  const ownerMode = cfg.ownerMode === 'unlimited' ? 'unlimited' : 'limited';
  const hardMaxSteps = positiveInt(cfg.unlimitedHardMaxSteps, DEFAULT_TURN_GUARD.unlimitedHardMaxSteps);
  const maxTurnMs = positiveInt(cfg.unlimitedMaxTurnMs, DEFAULT_TURN_GUARD.unlimitedMaxTurnMs);
  const maxIdenticalCalls = positiveInt(cfg.unlimitedMaxIdenticalCalls, DEFAULT_TURN_GUARD.unlimitedMaxIdenticalCalls);
  const turns = new Map();

  /**
   * owner 只能由调用方根据「QQ 原始事件里的 user_id」得出，**不能**来自聊天内容。
   * 普通会话永远走 maxSteps；owner=true 才可能得到 60 或 unlimited。
   */
  function begin(sessionId, key = '', now = Date.now(), { owner = false } = {}) {
    const unlimited = owner === true && ownerMode === 'unlimited';
    const state = {
      sessionId,
      key,
      startedAt: now,
      steps: 0,
      owner: owner === true,
      mode: unlimited ? 'unlimited' : 'limited',
      limit: unlimited ? hardMaxSteps : (owner === true ? ownerMaxSteps : maxSteps),
      errors: new Map(),
      calls: new Map(),
      effects: [],
      lastCall: { tool: '', fp: '', n: 0 },
      stopped: false,
      stopReason: null,
    };
    turns.set(sessionId, state);
    return state;
  }

  function get(sessionId) {
    return turns.get(sessionId) ?? null;
  }

  function stop(state, code, reason, evidence = {}) {
    if (!state || state.stopped) return null;
    state.stopped = true;
    state.stopReason = { code, reason, evidence };
    return state.stopReason;
  }

  /** 一次 assistant step 算一步；达到上限就停（同一步多个 tool call 不重复计）。call 可选：{callId, tool, args}。 */
  function noteStep(sessionId, call = null, now = Date.now()) {
    const state = turns.get(sessionId);
    if (!state || state.stopped) return null;
    state.steps += 1;
    if (call && call.tool) {
      const fp = fingerprintOf(call.args);
      if (call.callId != null) state.calls.set(String(call.callId), { tool: String(call.tool), fp });
      if (state.mode === 'unlimited' && !WAITING_TOOL_RE.test(String(call.tool))) {
        if (state.lastCall.tool === call.tool && state.lastCall.fp === fp) state.lastCall.n += 1;
        else state.lastCall = { tool: String(call.tool), fp, n: 1 };
        if (state.lastCall.n >= maxIdenticalCalls) {
          return stop(state, 'TURN_LOOP_DETECTED', `同一工具同一参数连续调用 ${state.lastCall.n} 次`, {
            tool: state.lastCall.tool, count: state.lastCall.n, maxIdenticalCalls,
          });
        }
      }
    }
    if (state.mode === 'unlimited' && now - state.startedAt > maxTurnMs) {
      return stop(state, 'TURN_TIMEOUT', `单轮运行超过 ${Math.round(maxTurnMs / 60_000)} 分钟`, {
        elapsedMs: now - state.startedAt, maxTurnMs,
      });
    }
    if (state.steps > state.limit) {
      return stop(state, 'TURN_STEPS_EXCEEDED', `单轮工具步数超过 ${state.limit}`, {
        steps: state.steps,
        maxSteps: state.limit,
        mode: state.mode,
        owner: state.owner,
      });
    }
    return null;
  }

  /** 工具结果：成功的副作用调用记入 effects（续接时据此防止重复）。 */
  function noteToolResult(sessionId, { callId, ok, at = Date.now() } = {}) {
    const state = turns.get(sessionId);
    if (!state || callId == null) return;
    const call = state.calls.get(String(callId));
    if (!call || ok !== true || !isSideEffectTool(call.tool)) return;
    if (state.effects.length < 60) state.effects.push({ tool: call.tool, fp: call.fp, at });
  }

  /** 工具错误：同一个 tool + 归一化错误重复到阈值就停。 */
  function noteToolError(sessionId, tool, error) {
    const state = turns.get(sessionId);
    if (!state || state.stopped) return null;
    // 业务拒绝：不计数（否则模型一次没听劝就停整轮，用户看到的是"莫名其妙被中断"）。
    if (isExpectedToolError(error)) return null;
    const fingerprint = `${String(tool ?? '')}:${normalizeError(error)}`;
    const count = (state.errors.get(fingerprint) ?? 0) + 1;
    state.errors.set(fingerprint, count);
    if (count >= maxRepeatedErrors) {
      return stop(state, 'TURN_REPEATED_TOOL_ERROR', `同一工具错误连续出现 ${count} 次`, {
        tool: String(tool ?? ''),
        fingerprint,
        count,
        maxRepeatedErrors,
      });
    }
    return null;
  }

  /** 回合内每日额度已耗尽。 */
  function noteBudgetExhausted(sessionId, hits = []) {
    const state = turns.get(sessionId);
    if (!state || state.stopped) return null;
    return stop(state, 'TURN_BUDGET_EXHAUSTED', '回合进行中每日额度已耗尽', { hits });
  }

  /** 停轮时给续接记录用的快照：只有工具名、次数、时间，没有参数原文。 */
  function snapshot(sessionId) {
    const state = turns.get(sessionId);
    if (!state) return null;
    const effects = {};
    for (const effect of state.effects) effects[effect.tool] = (effects[effect.tool] ?? 0) + 1;
    return {
      sessionId: state.sessionId,
      key: state.key,
      startedAt: state.startedAt,
      steps: state.steps,
      limit: state.limit,
      mode: state.mode,
      stopCode: state.stopReason?.code ?? '',
      effects,
      effectCount: state.effects.length,
    };
  }

  function end(sessionId) {
    turns.delete(sessionId);
  }

  return {
    begin, get, noteStep, noteToolResult, noteToolError, noteBudgetExhausted, snapshot, end,
    config: { maxSteps, maxRepeatedErrors, ownerMaxSteps, ownerMode, hardMaxSteps, maxTurnMs, maxIdenticalCalls },
  };
}

/**
 * 续接记录：回合被止血后，把「做到哪了、哪些副作用已经成功」存盘，
 * 主人回复「继续」时由下一次唤醒提示带给模型。
 *   · 只存工具名与次数、时间、会话 key；不存参数原文、不存令牌；
 *   · 只有 owner 会话写入、读取；TTL 内一次性消费；
 *   · 不创建新会话、不绕过任何额度/权限：续接只是同一会话里的下一个普通回合。
 */
export const TURN_RESUME_TTL_MS = 2 * 60 * 60_000;

export function createTurnResumeStore({ file, now = () => Date.now(), ttlMs = TURN_RESUME_TTL_MS } = {}) {
  if (!file) throw new Error('createTurnResumeStore: file 不能为空');
  const readAll = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return raw && typeof raw === 'object' && raw.items && typeof raw.items === 'object' ? raw : { version: 1, items: {} };
    } catch { return { version: 1, items: {} }; }
  };
  const writeAll = (state) => {
    const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, file);
      return true;
    } catch {
      try { fs.rmSync(temp, { force: true }); } catch {}
      return false;
    }
  };
  return {
    record(key, snap) {
      if (!key || !snap) return false;
      const state = readAll();
      state.items[key] = {
        at: now(), steps: snap.steps, limit: snap.limit, stopCode: snap.stopCode,
        effects: snap.effects ?? {}, effectCount: snap.effectCount ?? 0, consumed: false,
      };
      return writeAll(state);
    },
    peek(key) {
      const item = readAll().items[key];
      if (!item || item.consumed || now() - item.at > ttlMs) return null;
      return { ...item };
    },
    take(key) {
      const state = readAll();
      const item = state.items[key];
      if (!item || item.consumed || now() - item.at > ttlMs) return null;
      item.consumed = true;
      item.consumedAt = now();
      writeAll(state);
      return { ...item };
    },
  };
}

/** 续接提示：一段话，给下一次唤醒用。 */
export function resumePromptLine(item) {
  if (!item) return '';
  const minutes = Math.max(1, Math.round((Date.now() - item.at) / 60_000));
  const done = Object.entries(item.effects ?? {}).map(([tool, n]) => `${tool.replace(/^mcp__[^_]+__/, '')}×${n}`).join('、');
  return `【上一轮被中断】${minutes} 分钟前，上一轮因「${item.stopCode || '止血'}」在第 ${item.steps} 步停下。`
    + (done ? `停下前已经成功执行过这些有副作用的操作：${done}。` : '停下前没有成功的副作用操作。')
    + '只有主人这次表示要继续时才接着做；接着做之前先回看本会话已有的工具结果，已经成功的操作不要再做一遍，没做完的再补。\n\n';
}