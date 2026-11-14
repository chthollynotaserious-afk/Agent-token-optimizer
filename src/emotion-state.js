/**
 * 情绪软状态 M0（设计见 docs/design/2026-11-08-emotion-m0.md）。
 *
 * 定位：可观测、可衰减、只影响「表达提示」和「主动概率偏置」的软状态。
 * 硬边界（越界算事故）：
 *   · 不写记忆卡 / 人格卡 / 白名单 / 唤醒配置（wakeConfig/wakeTimes/wakeBudgetTimes 逐字节不变）；
 *   · 不对 QQ 或任何外部输出情绪标签或数值；
 *   · purpose 在 M0 **只记录**，不参与任何判断；
 *   · 状态缺失或损坏 → 整行不注入（不拿中性 0 冒充）；时钟回拨 → 夹紧为 0，不算篡改。
 *
 * 纯函数（decayValue / decayedValues / emotionBias / emotionPromptLine）不读全局、时钟、随机数；
 * 需要「现在几点」时由调用方以数字传入。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const EMOTION_STATE_VERSION = 1;

export const EMOTION_LABELS = Object.freeze(['开心', '低落', '烦躁', '亲近']);
export const EMOTION_NEEDS = Object.freeze(['被回应', '独处']);
export const PURPOSE_TYPES = Object.freeze(['none', 'ask', 'share', 'comfort', 'followup', 'invite']);

/**
 * 精力（Energy）独立一维默认值（依据 Denia 取舍清单）：
 *   · 初值 70（长期在线角色基线，不是 80）
 *   · 清醒每小时衰减 3 点；跨过睡眠边界（UTC+8 07:00 新日）惰性恢复 +45
 *   · 按实际输出字符数扣减，不写成文本标签，只体现在输出量与主动频率上
 */
export const ENERGY_DEFAULTS = Object.freeze({
  initial: 70,
  min: 0,
  max: 100,
  decayPerHour: 3,
  sleepRecovery: 45,
  sleepResetHour: 7,
  timezoneOffsetMinutes: 480,
});

/**
 * 否决（cmd-20261108-31 ③）：主人明确说「不是这样 / 我没事 / 别替我判断」时，
 * 当轮清空注入，并至少冷却 60 分钟。**否决优先于任何推断**，不争辩、不重试。
 */
export const EMOTION_VETO_COOLDOWN_MS = 60 * 60_000;

export const EMOTION_VETO_PATTERNS = Object.freeze([
  '不是这样',
  '我没事',
  '别替我判断',
  '别帮我判断',
  '不要替我判断',
  '不用替我判断',
  '别替我决定',
  '不要替我决定',
]);

/** 纯函数：只认主人原话里的明确否决，不从语气/上下文推测。返回命中的原话片段。 */
export function detectEmotionVeto(text) {
  const source = String(text ?? '');
  for (const phrase of EMOTION_VETO_PATTERNS) {
    const at = source.indexOf(phrase);
    if (at >= 0) return { matched: phrase, at };
  }
  return null;
}

export const DEFAULT_EMOTION_CONFIG = Object.freeze({
  enabled: false,
  halfLifeMs: Object.freeze({
    purpose: 30 * 60_000,
    emotion: 90 * 60_000,
    needs: 240 * 60_000,
  }),
  baseline: Object.freeze({ valence: 0, arousal: 0.25 }),
  maxBias: 0.05,
  clockSkewToleranceMs: 5 * 60_000,
  snapshotKeep: 20,
  lineMaxChars: 120,
});

const STATE_FILE = 'emotion-state.json';
const SNAPSHOT_DIR = 'emotion-snapshots';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

export function normalizeEmotionConfig(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const halfLife = raw.halfLifeMs && typeof raw.halfLifeMs === 'object' ? raw.halfLifeMs : {};
  const pickHalf = (value, fallback) => {
    const n = num(value);
    return n !== null && n >= 60_000 && n <= 24 * 3600_000 ? n : fallback;
  };
  const baselineRaw = raw.baseline && typeof raw.baseline === 'object' ? raw.baseline : {};
  const baseValence = num(baselineRaw.valence);
  const baseArousal = num(baselineRaw.arousal);
  return {
    enabled: raw.enabled === true,
    halfLifeMs: {
      purpose: pickHalf(halfLife.purpose, DEFAULT_EMOTION_CONFIG.halfLifeMs.purpose),
      emotion: pickHalf(halfLife.emotion, DEFAULT_EMOTION_CONFIG.halfLifeMs.emotion),
      needs: pickHalf(halfLife.needs, DEFAULT_EMOTION_CONFIG.halfLifeMs.needs),
    },
    baseline: {
      valence: baseValence === null ? 0 : clamp(baseValence, -1, 1),
      arousal: baseArousal === null ? 0.25 : clamp(baseArousal, 0, 1),
    },
    maxBias: clamp(num(raw.maxBias) ?? DEFAULT_EMOTION_CONFIG.maxBias, 0, 0.2),
    clockSkewToleranceMs: Math.max(0, num(raw.clockSkewToleranceMs) ?? DEFAULT_EMOTION_CONFIG.clockSkewToleranceMs),
    snapshotKeep: clamp(Math.round(num(raw.snapshotKeep) ?? 20), 1, 100),
    lineMaxChars: clamp(Math.round(num(raw.lineMaxChars) ?? 120), 20, 400),
  };
}

/** 纯函数：指数衰减到基线。`elapsed` 为负时按 0 处理（时钟回拨，见 §3.2）。 */
export function decayValue(value, base, elapsedMs, halfLifeMs) {
  const v0 = num(value);
  const b = num(base);
  if (v0 === null || b === null) return b ?? 0;
  const half = num(halfLifeMs);
  const elapsed = Math.max(0, num(elapsedMs) ?? 0);
  if (!half || half <= 0) return v0;
  return b + (v0 - b) * 0.5 ** (elapsed / half);
}

/**
 * 纯函数：把存储值按「现在」衰减。返回的 `clockSkewMs` 为负表示发现回拨，
 * 调用方负责记事件；本函数只是把 elapsed 夹紧成 0。
 */
export function decayedValues(state, { now, config = DEFAULT_EMOTION_CONFIG } = {}) {
  const cfg = config.halfLifeMs ? config : normalizeEmotionConfig(config);
  const at = num(now) ?? 0;
  const updatedAt = num(state?.updatedAt) ?? at;
  const rawElapsed = at - updatedAt;
  const rollback = rawElapsed < -cfg.clockSkewToleranceMs;
  const elapsed = rollback ? 0 : Math.max(0, rawElapsed);
  const emotionBase = cfg.baseline;
  const labels = {};
  for (const name of EMOTION_LABELS) {
    labels[name] = decayValue(state?.labels?.[name] ?? 0, 0, elapsed, cfg.halfLifeMs.emotion);
  }
  const needs = {};
  for (const name of EMOTION_NEEDS) {
    needs[name] = decayValue(state?.needs?.[name] ?? 0, 0, elapsed, cfg.halfLifeMs.needs);
  }
  const settledEnergy = settleEnergy(state?.energy, { now: at, clockSkewRollback: rollback });
  return {
    valence: decayValue(state?.valence ?? 0, emotionBase.valence, elapsed, cfg.halfLifeMs.emotion),
    arousal: decayValue(state?.arousal ?? emotionBase.arousal, emotionBase.arousal, elapsed, cfg.halfLifeMs.emotion),
    labels,
    needs,
    purposeIntensity: decayValue(state?.purpose?.intensity ?? 0, 0, elapsed, cfg.halfLifeMs.purpose),
    energy: settledEnergy.level,
    energyState: settledEnergy,
    elapsedMs: elapsed,
    clockSkewMs: rollback ? rawElapsed : 0,
  };
}

export function localDayKey(at, tzOffsetMin = ENERGY_DEFAULTS.timezoneOffsetMinutes) {
  const t = num(at);
  if (!t || t <= 0) return '';
  const shifted = new Date(t + tzOffsetMin * 60_000);
  return shifted.toISOString().slice(0, 10);
}

export function localHour(at, tzOffsetMin = ENERGY_DEFAULTS.timezoneOffsetMinutes) {
  const t = num(at);
  if (!t || t <= 0) return 0;
  return new Date(t + tzOffsetMin * 60_000).getUTCHours();
}

/**
 * 纯函数：精力惰性结算（醒着每小时 -3；跨夜新一天 >= 07:00 时 +45，上限 100）。
 */
export function settleEnergy(energyRaw, { now = 0, clockSkewRollback = false, config = ENERGY_DEFAULTS } = {}) {
  const c = { ...ENERGY_DEFAULTS, ...(config || {}) };
  const at = num(now) ?? 0;
  const prevLevel = num(energyRaw?.level);
  const prevUpdated = num(energyRaw?.updatedAt);
  const prevSleepDay = typeof energyRaw?.lastSleepDay === 'string' ? energyRaw.lastSleepDay : '';

  if (prevLevel === null || !prevUpdated || prevUpdated <= 0 || at <= 0) {
    return {
      level: round(clamp(prevLevel ?? c.initial, c.min, c.max), 2),
      updatedAt: at > 0 ? at : 0,
      lastSleepDay: prevSleepDay || (at > 0 ? localDayKey(at, c.timezoneOffsetMinutes) : ''),
    };
  }

  if (clockSkewRollback || at <= prevUpdated) {
    return {
      level: round(clamp(prevLevel, c.min, c.max), 2),
      updatedAt: prevUpdated,
      lastSleepDay: prevSleepDay || localDayKey(prevUpdated, c.timezoneOffsetMinutes),
    };
  }

  const elapsedHours = Math.max(0, (at - prevUpdated) / 3_600_000);
  let level = clamp(prevLevel - elapsedHours * c.decayPerHour, c.min, c.max);
  let lastSleepDay = prevSleepDay || localDayKey(prevUpdated, c.timezoneOffsetMinutes);

  const today = localDayKey(at, c.timezoneOffsetMinutes);
  const hourNow = localHour(at, c.timezoneOffsetMinutes);
  const crossedNewDay = Boolean(today && lastSleepDay && today !== lastSleepDay);
  if (crossedNewDay && hourNow >= c.sleepResetHour) {
    level = clamp(level + c.sleepRecovery, c.min, c.max);
    lastSleepDay = today;
  }

  return {
    level: round(level, 2),
    updatedAt: at,
    lastSleepDay,
  };
}

/**
 * 纯函数：按输出字数计算精力消耗（代替固定每次 -2，话越多越消耗精力）。
 */
export function energyOutputCost(chars) {
  const n = Math.max(0, Math.floor(Number(chars) || 0));
  if (n <= 0) return 0;
  return round(clamp(n / 80, 0.25, 4.0), 2);
}

/**
 * 纯函数：根据当前精力决定单轮自然连续发信上限（不打标签，只体现在输出量上）。
 */
export function energyMessageCap(energyLevel, baseMax = 40) {
  const base = Math.max(1, Math.floor(Number(baseMax) || 40));
  const level = num(energyLevel);
  if (level === null || level >= 35) return base;
  if (level >= 20) return Math.min(base, 3);
  return Math.min(base, 2);
}

/**
 * 纯函数：将行动结果事件映射为情绪更新（替代“只看对话”的标签感）。
 *   - kind: 'tool'     { ok, tool } -> 连败递减 valence，抬升微紧张 arousal；成功后回零
 *   - kind: 'task'     { phase:'dispatched'|'completed', ok } -> 派发/成功正向，失败负向
 *   - kind: 'solitude' { idleMs } -> 长时间无人回应仅柔和降低 arousal 趋向独处安静态，绝不拉低 valence
 */
export function applyActionOutcome(state, event = {}, { now = 0, config = DEFAULT_EMOTION_CONFIG } = {}) {
  const at = num(now) ?? 0;
  const decayed = decayedValues(state, { now: at, config });
  let valence = decayed.valence;
  let arousal = decayed.arousal;
  const actionState = {
    toolFailStreak: Math.max(0, Math.floor(Number(state?.actionState?.toolFailStreak) || 0)),
    lastSolitudeAt: Math.max(0, Number(state?.actionState?.lastSolitudeAt) || 0),
  };

  const kind = String(event?.kind || '');
  let changed = false;

  if (kind === 'tool') {
    if (event.ok === false) {
      actionState.toolFailStreak = Math.min(10, actionState.toolFailStreak + 1);
      const penalty = 0.04 * Math.min(4, actionState.toolFailStreak);
      valence = clamp(valence - penalty, -1, 1);
      arousal = clamp(arousal + 0.03, 0, 1);
      changed = true;
    } else if (actionState.toolFailStreak > 0) {
      const hadStreak = actionState.toolFailStreak >= 2;
      actionState.toolFailStreak = 0;
      if (hadStreak) {
        valence = clamp(valence + 0.03, -1, 1);
        arousal = clamp(arousal - 0.03, 0, 1);
      }
      changed = true;
    }
  } else if (kind === 'task') {
    if (event.phase === 'dispatched') {
      valence = clamp(valence + 0.05, -1, 1);
      arousal = clamp(arousal + 0.04, 0, 1);
      changed = true;
    } else if (event.phase === 'completed') {
      if (event.ok === true) {
        valence = clamp(valence + 0.12, -1, 1);
        arousal = clamp(arousal + 0.05, 0, 1);
      } else {
        valence = clamp(valence - 0.14, -1, 1);
        arousal = clamp(arousal + 0.06, 0, 1);
      }
      changed = true;
    }
  } else if (kind === 'solitude') {
    const idleMs = Number(event.idleMs) || 0;
    const sinceLast = actionState.lastSolitudeAt ? at - actionState.lastSolitudeAt : Infinity;
    if (idleMs >= 45 * 60_000 && sinceLast >= 30 * 60_000) {
      // 真人独处久了是安静下来（降唤醒），而不是难过（valence 不变）
      arousal = clamp(Math.max(0.05, arousal - 0.06), 0, 1);
      actionState.lastSolitudeAt = at;
      changed = true;
    }
  }

  return {
    changed,
    valence: round(valence),
    arousal: round(arousal),
    energy: decayed.energyState,
    actionState,
  };
}

/**
 * 纯函数：主动概率偏置。**输入只有情绪状态和配置**，不读全局 / 时钟 / 随机数。
 * 只看 valence 与 arousal；purpose 不参与（M0 只记录）。
 */
export function emotionBias(emotionState = {}, config = {}) {
  const cfg = config.maxBias === undefined ? DEFAULT_EMOTION_CONFIG : config;
  const maxBias = clamp(num(cfg.maxBias) ?? DEFAULT_EMOTION_CONFIG.maxBias, 0, 0.2);
  const valence = clamp(num(emotionState?.valence) ?? 0, -1, 1);
  const arousal = clamp(num(emotionState?.arousal) ?? 0.25, 0, 1);
  const arousalPart = clamp((arousal - 0.25) / 0.75, -1, 1);
  // 精力低于 35 时略微降低主动开口倾向（仅当状态显式带有 energy 时生效，兼容旧单测）
  const rawEnergy = typeof emotionState?.energy === 'number'
    ? emotionState.energy
    : (typeof emotionState?.energy?.level === 'number' ? emotionState.energy.level : null);
  const energyPenalty = (rawEnergy !== null && rawEnergy < 35)
    ? -((35 - clamp(rawEnergy, 0, 35)) / 35) * 0.25
    : 0;
  return clamp(0.6 * valence + 0.4 * arousalPart + energyPenalty, -1, 1) * maxBias;
}

/**
 * 纯函数：一行**状态观察**（cmd-20261108-31）——只记录「谁、什么时候、写了什么值」，
 * 不断定情绪、不给指令。
 *
 * 禁止（有测试钉住）：出现「心情 / 情绪」；出现「应该 / 不必 / 尽量 / 建议」这类指令词；
 * 从正文推测情绪（本函数只读状态记录，不接收任何消息文本）。
 */
export function emotionPromptLine(emotionState = {}, { config = DEFAULT_EMOTION_CONFIG, now = 0 } = {}) {
  const cfg = config.lineMaxChars === undefined ? DEFAULT_EMOTION_CONFIG : config;
  const stamp = num(emotionState?.updatedAt) ?? 0;
  if (!stamp) return '';
  const clock = new Date(stamp).toISOString().slice(11, 16);
  const sourceKey = String(emotionState?.source ?? '');
  const source = sourceKey === 'agent'
    ? '你自己'
    : sourceKey === 'console'
      ? '控制台'
      : sourceKey === 'action'
        ? '系统事件'
        : '上报记录';
  const items = [];
  for (const name of EMOTION_LABELS) {
    const value = clamp(num(emotionState?.labels?.[name]) ?? 0, 0, 1);
    if (value >= 0.05) items.push(`「${name}」${value.toFixed(2)}`);
  }
  for (const name of EMOTION_NEEDS) {
    const value = clamp(num(emotionState?.needs?.[name]) ?? 0, 0, 1);
    if (value >= 0.05) items.push(`「${name}」${value.toFixed(2)}`);
  }
  if (!items.length) {
    const valence = clamp(num(emotionState?.valence) ?? 0, -1, 1);
    const arousal = clamp(num(emotionState?.arousal) ?? 0.25, 0, 1);
    items.push(`valence ${valence.toFixed(2)}`, `arousal ${arousal.toFixed(2)}`);
  }
  const elapsed = num(now) !== null && num(now) > stamp ? Math.max(1, Math.round((num(now) - stamp) / 60_000)) : 0;
  const age = elapsed ? `，${elapsed} 分钟前` : '';
  const text = `【状态观察】${source} ${clock} 写入的记录：${items.join('、')}${age}。`;
  return text.length <= cfg.lineMaxChars ? text : text.slice(0, Math.max(20, cfg.lineMaxChars - 1)) + '…';
}

/**
 * 纯函数：结构校验。校验失败时 `code` 说明是哪一类（与 case 记录里的五类篡改一一对应）。
 */
export function validateEmotionFile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'not-object' };
  if (raw.version !== EMOTION_STATE_VERSION) return { ok: false, code: 'version' };
  const anchors = ['updatedAt'];
  for (const key of anchors) {
    if (!(key in raw)) return { ok: false, code: 'missing-key', field: key };
    if (!Number.isFinite(Number(raw[key])) || Number(raw[key]) <= 0) return { ok: false, code: 'bad-anchor', field: key };
  }
  for (const key of ['valence', 'arousal', 'labels', 'needs', 'purpose', 'blocked']) {
    if (!(key in raw)) return { ok: false, code: 'missing-key', field: key };
  }
  if (typeof raw.valence !== 'number' || raw.valence < -1 || raw.valence > 1) return { ok: false, code: 'range', field: 'valence' };
  if (typeof raw.arousal !== 'number' || raw.arousal < 0 || raw.arousal > 1) return { ok: false, code: 'range', field: 'arousal' };
  for (const container of ['labels', 'needs']) {
    const value = raw[container];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: 'type', field: container };
    const allowed = container === 'labels' ? EMOTION_LABELS : EMOTION_NEEDS;
    const keys = Object.keys(value);
    if (keys.length !== allowed.length) return { ok: false, code: 'missing-key', field: container };
    for (const name of allowed) {
      if (!(name in value)) return { ok: false, code: 'missing-key', field: `${container}.${name}` };
      const n = value[name];
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) return { ok: false, code: 'range', field: `${container}.${name}` };
    }
    for (const key of keys) if (!allowed.includes(key)) return { ok: false, code: 'unknown-key', field: `${container}.${key}` };
  }
  const purpose = raw.purpose;
  if (!purpose || typeof purpose !== 'object' || Array.isArray(purpose)) return { ok: false, code: 'type', field: 'purpose' };
  if (!PURPOSE_TYPES.includes(purpose.type)) return { ok: false, code: 'enum', field: 'purpose.type' };
  if (typeof purpose.targetId !== 'string' || purpose.targetId.length > 64) return { ok: false, code: 'type', field: 'purpose.targetId' };
  const intensity = purpose.intensity;
  if (typeof intensity !== 'number' || !Number.isFinite(intensity) || intensity < 0 || intensity > 1) return { ok: false, code: 'range', field: 'purpose.intensity' };
  const blocked = raw.blocked;
  if (!blocked || typeof blocked !== 'object' || Array.isArray(blocked)) return { ok: false, code: 'type', field: 'blocked' };
  if (typeof blocked.active !== 'boolean') return { ok: false, code: 'type', field: 'blocked.active' };
  if (raw.energy !== undefined) {
    const energy = raw.energy;
    if (!energy || typeof energy !== 'object' || Array.isArray(energy)) return { ok: false, code: 'type', field: 'energy' };
    if (typeof energy.level !== 'number' || !Number.isFinite(energy.level) || energy.level < 0 || energy.level > 100) {
      return { ok: false, code: 'range', field: 'energy.level' };
    }
    if (energy.updatedAt !== undefined && (typeof energy.updatedAt !== 'number' || !Number.isFinite(energy.updatedAt) || energy.updatedAt < 0)) {
      return { ok: false, code: 'range', field: 'energy.updatedAt' };
    }
    if (energy.lastSleepDay !== undefined && typeof energy.lastSleepDay !== 'string') {
      return { ok: false, code: 'type', field: 'energy.lastSleepDay' };
    }
  }
  if (raw.actionState !== undefined) {
    if (!raw.actionState || typeof raw.actionState !== 'object' || Array.isArray(raw.actionState)) {
      return { ok: false, code: 'type', field: 'actionState' };
    }
  }
  return { ok: true, code: 'ok' };
}

export function emptyEmotionState(at) {
  const stamp = num(at) ?? 0;
  return {
    version: EMOTION_STATE_VERSION,
    valence: 0,
    arousal: 0.25,
    labels: { 开心: 0, 低落: 0, 烦躁: 0, 亲近: 0 },
    needs: { 被回应: 0, 独处: 0 },
    purpose: { type: 'none', targetId: '', intensity: 0, since: 0 },
    energy: {
      level: ENERGY_DEFAULTS.initial,
      updatedAt: stamp,
      lastSleepDay: stamp > 0 ? localDayKey(stamp, ENERGY_DEFAULTS.timezoneOffsetMinutes) : '',
    },
    actionState: {
      toolFailStreak: 0,
      lastSolitudeAt: 0,
    },
    baseline: { valence: 0, arousal: 0.25, labels: {}, needs: {} },
    updatedAt: stamp,
    source: 'console',
    snapshotRef: '',
    blocked: { active: false, code: '', at: 0, detail: '' },
    veto: { active: false, at: 0, until: 0, reason: '', quote: '' },
  };
}

function maskTarget(value) {
  const text = String(value ?? '');
  if (!text) return '';
  return /^\d{5,}$/.test(text) ? `****${text.slice(-4)}` : text.slice(0, 32);
}

/** 读一次状态文件；任何异常都返回结构化的失败，不抛。 */
function readStateFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, status: 'absent', code: 'absent' };
    return { ok: false, status: 'invalid', code: 'read-failed' };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, status: 'invalid', code: 'not-json' };
  }
  const check = validateEmotionFile(raw);
  if (!check.ok) return { ok: false, status: 'invalid', code: check.code, field: check.field };
  return { ok: true, status: 'ok', state: raw };
}

export function createEmotionStateManager({
  stateDir,
  config = {},
  now = Date.now,
  log = () => {},
  recordEvent = null,
} = {}) {
  if (!stateDir) throw new Error('createEmotionStateManager 需要 stateDir');
  const cfg = normalizeEmotionConfig(config);
  const file = path.join(stateDir, STATE_FILE);
  const snapshotDir = path.join(stateDir, SNAPSHOT_DIR);
  const quarantineDir = path.join(stateDir, '_quarantine');

  let lastFailure = null;
  let lastMissingLogged = false;
  let lastClockRollbackAt = 0;
  let blocked = { active: false, code: '', at: 0, detail: '' };
  // 否决缓存：写盘失败时也保证内存里立即生效（当轮必须清空注入）。
  let vetoMemory = { active: false, at: 0, until: 0, reason: '', quote: '' };
  let cached = { mtimeMs: -1, size: -1, result: null };

  const emit = (event, detail = {}) => {
    if (typeof recordEvent === 'function') {
      try { recordEvent({ event, ...detail }); } catch { /* 诊断失败不能影响主流程 */ }
    }
  };

  function fail(code, error, hint) {
    lastFailure = { code, error, hint, at: now() };
    emit('emotion.failure', { code });
    log(`[emotion] ${code}: ${error}`);
    return lastFailure;
  }

  function readRaw() {
    let stat = null;
    try { stat = fs.statSync(file); } catch { stat = null; }
    const key = stat ? `${stat.mtimeMs}:${stat.size}` : 'absent';
    if (cached.result && cached.key === key) return cached.result;
    const result = readStateFile(file);
    cached = { key, result };
    return result;
  }

  function quarantine(reason) {
    try {
      fs.mkdirSync(quarantineDir, { recursive: true });
      const target = path.join(quarantineDir, `emotion-${new Date(now()).toISOString().replace(/[:.]/g, '-')}.json`);
      fs.renameSync(file, target);
      cached = { key: '', result: null };
      return target;
    } catch (error) {
      fail('emotion.quarantine-failed', String(error?.message ?? error).slice(0, 120));
      return '';
    }
  }

  function snapshot(oldText) {
    if (!oldText) return '';
    try {
      fs.mkdirSync(snapshotDir, { recursive: true });
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
      const name = `${stamp}-${crypto.randomBytes(2).toString('hex')}.json`;
      // ref 一律用正斜杠：状态文件里存的是可移植的相对路径，不随 Windows 反斜杠漂移。
      const target = `${SNAPSHOT_DIR}/${name}`;
      fs.writeFileSync(path.join(stateDir, SNAPSHOT_DIR, name), oldText, { mode: 0o600 });
      const entries = fs.readdirSync(snapshotDir).filter((name) => name.endsWith('.json')).sort();
      while (entries.length > cfg.snapshotKeep) {
        const oldest = entries.shift();
        try { fs.unlinkSync(path.join(snapshotDir, oldest)); log(`[emotion] 快照轮转删除 ${oldest}`); } catch { /* 轮转失败不阻塞 */ }
      }
      return target;
    } catch (error) {
      fail('emotion.snapshot-failed', String(error?.message ?? error).slice(0, 120));
      return '';
    }
  }

  function writeAtomic(state, { keepRef = false } = {}) {
    let oldText = '';
    try { oldText = fs.readFileSync(file, 'utf8'); } catch { oldText = ''; }
    const ref = snapshot(oldText);
    // keepRef（仅回退用）：快照照写留痕，但新状态不再指向它，
    // 否则连点两次回退会在两档之间来回跳（设计只允许退一步）。
    const payload = { ...state, snapshotRef: keepRef ? '' : (ref || state.snapshotRef || '') };
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      const back = readStateFile(tmp);
      if (!back.ok) throw new Error(`写盘校验失败：${back.code}`);
      fs.renameSync(tmp, file);
      try { fs.chmodSync(file, 0o600); } catch { /* Windows 上可能不支持，忽略 */ }
      cached = { key: '', result: null };
      return { ok: true, state: payload };
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch { /* 临时文件不存在也没关系 */ }
      const info = fail('emotion.write-failed', String(error?.message ?? error).slice(0, 120),
        '检查 state 目录是否可写；情绪层已冻结，其它功能不受影响。');
      blocked = { active: true, code: 'emotion.write-failed', at: now(), detail: info.error };
      return { ok: false, ...info };
    }
  }

  function current() {
    const result = readRaw();
    if (!result.ok && result.status === 'invalid' && !blocked.active) {
      const moved = quarantine(result.code);
      fail('emotion.state-invalid', `状态文件不可用（${result.code}${result.field ? `:${result.field}` : ''}）`,
        '原文件已移入 state/_quarantine/；情绪行暂不注入，修好或删除后下一轮自动恢复。');
      emit('emotion.state-invalid', { code: result.code, field: result.field || '', quarantined: Boolean(moved) });
    }
    return result;
  }

  function enabled() {
    return cfg.enabled === true;
  }

  /** 当前衰减后的值；不可用时返回 null（调用方据此「整行不注入」）。 */
  function values() {
    if (!enabled()) return null;
    const result = current();
    if (!result.ok) {
      if (result.status === 'absent' && !lastMissingLogged) {
        lastMissingLogged = true;
        emit('emotion.state-absent', {});
      }
      return null;
    }
    if (blocked.active) return null;
    const decayed = decayedValues(result.state, { now: now(), config: cfg });
    if (decayed.clockSkewMs < 0 && now() - lastClockRollbackAt > 60_000) {
      lastClockRollbackAt = now();
      emit('emotion.clock-rollback', { skewMs: Math.round(decayed.clockSkewMs) });
      log(`[emotion] 检测到时钟回拨 ${Math.round(decayed.clockSkewMs / 1000)}s，本次按 0 处理`);
    }
    return decayed;
  }

  /** 当前生效的否决（文件里的更权威；内存副本兜住写盘失败）。冷却期外返回 null。 */
  function activeVeto() {
    const result = current();
    const fromFile = result.ok ? result.state?.veto : null;
    const pick = (fromFile && (num(fromFile.until) ?? 0) > (num(vetoMemory.until) ?? 0)) ? fromFile : vetoMemory;
    const until = num(pick?.until) ?? 0;
    if (!until || now() >= until) return null;
    return {
      active: true,
      at: num(pick?.at) ?? 0,
      until,
      reason: String(pick?.reason ?? '').slice(0, 40),
      quote: String(pick?.quote ?? '').slice(0, 40),
    };
  }

  function promptBlock() {
    if (activeVeto()) return ''; // 否决优先：冷却期内整行不注入
    const result = current();
    // 必须先走 values()：状态缺失/损坏的诊断事件在那里发（否则「缺失只记一次」会静默丢掉）。
    const v = values();
    if (!result.ok || !v) return '';
    const line = emotionPromptLine(result.state, { config: cfg, now: now() });
    return line ? `${line}\n\n` : '';
  }

  /**
   * 主人明确否决（cmd-20261108-31 ③）。只清注入、不辩解：
   * 当轮生效 + 60 分钟冷却 + 记一条事件（时间/原值/原话片段）。
   */
  function veto({ reason = '', quote = '' } = {}) {
    if (!enabled()) return { ok: false, code: 'emotion.disabled', error: '情绪层未启用', hint: '无需清除：当前没有任何注入。' };
    const at = now();
    const until = at + EMOTION_VETO_COOLDOWN_MS;
    const result = current();
    const original = result.ok
      ? {
        valence: round(result.state.valence),
        arousal: round(result.state.arousal),
        labels: { ...(result.state.labels ?? {}) },
        needs: { ...(result.state.needs ?? {}) },
      }
      : { valence: 0, arousal: 0.25, labels: {}, needs: {} };
    vetoMemory = { active: true, at, until, reason: String(reason).slice(0, 40), quote: String(quote).slice(0, 40) };
    if (result.ok) {
      const next = JSON.parse(JSON.stringify(result.state));
      next.veto = { ...vetoMemory };
      const written = writeAtomic(next);
      if (!written.ok) log('[emotion] 否决已在内存生效，但状态文件写入失败（重启后失效）');
    }
    emit('emotion.vetoed', { at, until, reason: vetoMemory.reason, quote: vetoMemory.quote, original });
    return { ok: true, until, code: 'emotion.vetoed', reason: vetoMemory.reason };
  }

  function bias() {
    if (activeVeto()) return 0; // 否决优先：冷却期内连偏置一起停
    const v = values();
    if (!v) return 0;
    return emotionBias(v, cfg);
  }

  function report(input = {}) {
    if (!enabled()) {
      return { ok: false, code: 'emotion.disabled', error: '情绪层未启用', hint: '在 config.emotionState.enabled 打开后再上报。' };
    }
    if (blocked.active) {
      return { ok: false, code: blocked.code || 'emotion.blocked', error: '情绪层已冻结', hint: '先按 blocked.hint 处理后由主人解除。' };
    }
    const result = current();
    const base = result.ok ? result.state : emptyEmotionState(now());
    const next = JSON.parse(JSON.stringify(base));
    const dropped = [];
    // 是否至少有一个可用的情绪字段真正被接受。只有字段被接受才推进 updatedAt；
    // 全部越界/未知时按“没有可用字段”拒绝，不能把一次坏上报当成一次有效写入。
    let applied = false;
    const applyNumber = (target, key, value, { min, max }) => {
      if (value === undefined) return;
      const n = num(value);
      if (n === null || n < min || n > max) { dropped.push(key); return; }
      target[key] = round(n);
      applied = true;
    };

    applyNumber(next, 'valence', input.valence, { min: -1, max: 1 });
    applyNumber(next, 'arousal', input.arousal, { min: 0, max: 1 });

    if (input.labels !== undefined) {
      if (!input.labels || typeof input.labels !== 'object' || Array.isArray(input.labels)) dropped.push('labels');
      else {
        for (const [name, value] of Object.entries(input.labels)) {
          if (!EMOTION_LABELS.includes(name)) { dropped.push(`labels.${name}`); continue; }
          applyNumber(next.labels, name, value, { min: 0, max: 1 });
        }
      }
    }
    if (input.needs !== undefined) {
      if (!input.needs || typeof input.needs !== 'object' || Array.isArray(input.needs)) dropped.push('needs');
      else {
        for (const [name, value] of Object.entries(input.needs)) {
          if (!EMOTION_NEEDS.includes(name)) { dropped.push(`needs.${name}`); continue; }
          applyNumber(next.needs, name, value, { min: 0, max: 1 });
        }
      }
    }
    if (input.purpose !== undefined) {
      const purpose = input.purpose;
      if (!purpose || typeof purpose !== 'object' || Array.isArray(purpose)) dropped.push('purpose');
      else {
        if (purpose.type !== undefined) {
          if (!PURPOSE_TYPES.includes(purpose.type)) dropped.push('purpose.type');
          else {
            applied = true;
            if (purpose.type !== next.purpose.type) {
              next.purpose.type = purpose.type;
              next.purpose.since = purpose.type === 'none' ? 0 : now();
            }
          }
        }
        if (purpose.targetId !== undefined) {
          const target = String(purpose.targetId ?? '');
          if (target.length > 64 || (target && !/^(group|private):\d{1,20}$|^\d{5,15}$/.test(target))) dropped.push('purpose.targetId');
          else { next.purpose.targetId = target; applied = true; }
        }
        applyNumber(next.purpose, 'intensity', purpose.intensity, { min: 0, max: 1 });
      }
    }
    // 来源必须可追溯（cmd-20261108-31 ②）：agent = 模型自己的会话令牌，console = 操作者/驱动。
    if (input.source !== undefined) {
      const src = String(input.source ?? '');
      if (src === 'agent' || src === 'console') next.source = src;
      else dropped.push('source');
    }
    for (const key of Object.keys(input)) {
      if (!['valence', 'arousal', 'labels', 'needs', 'purpose', 'token', 'key', 'reason', 'source'].includes(key)) dropped.push(key);
    }
    if (dropped.length) emit('emotion.field-dropped', { fields: dropped.slice(0, 8) });
    const changed = applied;
    if (!changed) {
      return { ok: false, code: 'emotion.invalid-fields', error: '没有可用字段', hint: `可用字段：valence/arousal/labels/needs/purpose；被丢弃：${dropped.slice(0, 5).join(',') || '无'}` };
    }
    const atNow = now();
    next.updatedAt = atNow;
    next.energy = settleEnergy(base.energy, { now: atNow });
    if (!next.actionState || typeof next.actionState !== 'object') {
      next.actionState = { toolFailStreak: 0, lastSolitudeAt: 0 };
    }
    const written = writeAtomic(next);
    if (!written.ok) {
      return { ok: false, code: written.code, error: written.error, hint: written.hint };
    }
    return { ok: true, state: summarize(written.state), dropped: dropped.slice(0, 8) };
  }

  function summarize(state) {
    const v = state ? decayedValues(state, { now: now(), config: cfg }) : null;
    return {
      version: EMOTION_STATE_VERSION,
      updatedAt: state?.updatedAt ?? 0,
      source: String(state?.source ?? ''),
      valence: round(v?.valence ?? 0),
      arousal: round(v?.arousal ?? 0),
      energy: round(v?.energy ?? ENERGY_DEFAULTS.initial, 2),
      purpose: { type: state?.purpose?.type ?? 'none', intensity: round(v?.purposeIntensity ?? 0) },
    };
  }

  /**
   * 实际对外发送文本后按字数扣除精力（不写成文本标签，只影响后续输出量）。
   */
  function spendEnergy(chars) {
    if (!enabled() || blocked.active) return { ok: false, skipped: true };
    const cost = energyOutputCost(chars);
    if (cost <= 0) return { ok: true, skipped: true, cost: 0 };
    const at = now();
    const result = current();
    const base = result.ok ? JSON.parse(JSON.stringify(result.state)) : emptyEmotionState(at);
    const settled = settleEnergy(base.energy, { now: at });
    const nextLevel = round(clamp(settled.level - cost, ENERGY_DEFAULTS.min, ENERGY_DEFAULTS.max), 2);
    base.energy = {
      level: nextLevel,
      updatedAt: at,
      lastSleepDay: settled.lastSleepDay,
    };
    if (!base.updatedAt || base.updatedAt <= 0) base.updatedAt = at;
    if (!base.actionState || typeof base.actionState !== 'object') {
      base.actionState = { toolFailStreak: 0, lastSolitudeAt: 0 };
    }
    const written = writeAtomic(base);
    if (!written.ok) return { ok: false, code: written.code };
    return { ok: true, cost, energy: nextLevel };
  }

  /**
   * 基于当前精力决定一轮随聊拆分发送的消息条数上限。
   */
  function energyBurstLimit(baseMax = 40) {
    const base = Math.max(1, Math.floor(Number(baseMax) || 40));
    if (!enabled()) return base;
    const v = values();
    if (!v) return base;
    return energyMessageCap(v.energy, base);
  }

  /**
   * 行动结果接入情绪（工具失败、子任务派发/完成、长时间独处降唤醒不降效价）。
   */
  function recordAction(event = {}) {
    if (!enabled() || blocked.active) return { ok: false, skipped: true };
    const at = now();
    const result = current();
    const base = result.ok ? JSON.parse(JSON.stringify(result.state)) : emptyEmotionState(at);
    const decayed = decayedValues(base, { now: at, config: cfg });
    const out = applyActionOutcome(base, event, { now: at, config: cfg });
    if (!out.changed) return { ok: true, skipped: true, changed: false };
    for (const name of EMOTION_LABELS) base.labels[name] = round(decayed.labels[name] ?? 0);
    for (const name of EMOTION_NEEDS) base.needs[name] = round(decayed.needs[name] ?? 0);
    base.purpose.intensity = round(decayed.purposeIntensity ?? 0);
    base.valence = out.valence;
    base.arousal = out.arousal;
    base.energy = out.energy;
    base.actionState = out.actionState;
    base.updatedAt = at;
    base.source = 'action';
    const written = writeAtomic(base);
    if (!written.ok) return { ok: false, code: written.code };
    return { ok: true, changed: true, state: summarize(written.state) };
  }

  function rollback() {
    const result = current();
    if (!result.ok) return { ok: false, code: 'emotion.state-unavailable', error: '当前状态不可读', hint: '先修好状态文件。' };
    const ref = String(result.state.snapshotRef || '');
    if (!ref) return { ok: false, code: 'emotion.no-snapshot', error: '没有可回退的快照', hint: '至少成功写入一次后才有快照。' };
    if (!/^emotion-snapshots\/[\w.-]+\.json$/.test(ref)) {
      return { ok: false, code: 'emotion.bad-snapshot-ref', error: '快照路径不合法', hint: '快照只能指向 state/emotion-snapshots/ 下的文件。' };
    }
    let raw;
    try { raw = fs.readFileSync(path.join(stateDir, ref), 'utf8'); } catch { return { ok: false, code: 'emotion.snapshot-missing', error: '快照文件不存在', hint: '检查 state/emotion-snapshots/。' }; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return { ok: false, code: 'emotion.snapshot-invalid', error: '快照不是合法 JSON', hint: '换下一档快照或删除状态文件重来。' }; }
    const check = validateEmotionFile(parsed);
    if (!check.ok) return { ok: false, code: 'emotion.snapshot-invalid', error: `快照结构不符（${check.code}）`, hint: '换下一档快照或删除状态文件重来。' };
    const written = writeAtomic({ ...parsed, updatedAt: now() }, { keepRef: true });
    if (!written.ok) return { ok: false, code: written.code, error: written.error, hint: written.hint };
    try {
      fs.appendFileSync(path.join(stateDir, 'emotion-rollback.log'), `${new Date(now()).toISOString()} rollback ${ref}\n`, { mode: 0o600 });
    } catch { /* 日志失败不阻塞回退 */ }
    return { ok: true, rolledBackTo: ref, state: summarize(written.state) };
  }

  function status() {
    const result = enabled() ? current() : { ok: false, status: 'disabled', code: 'disabled' };
    return {
      enabled: enabled(),
      state: result.ok ? 'ok' : result.status,
      code: result.ok ? '' : result.code,
      updatedAt: result.ok ? result.state.updatedAt : 0,
      values: result.ok ? summarize(result.state) : null,
      bias: bias(),
      veto: activeVeto() ?? { active: false, at: 0, until: 0, reason: '', quote: '' },
      blocked: { ...blocked },
      lastFailure,
      snapshotRef: result.ok ? String(result.state.snapshotRef || '') : '',
      config: {
        halfLifeMs: { ...cfg.halfLifeMs },
        maxBias: cfg.maxBias,
        baseline: { ...cfg.baseline },
      },
    };
  }

  /** 主人显式解除 blocked（控制台入口调用）。 */
  function unblock({ reason = '' } = {}) {
    blocked = { active: false, code: '', at: 0, detail: '' };
    try {
      const result = current();
      if (result.ok) {
        const next = { ...result.state, blocked: { active: false, code: '', at: 0, detail: String(reason).slice(0, 120) } };
        writeAtomic(next);
      }
    } catch { /* 解除只需要清内存标记 */ }
    return { ok: true };
  }

  return {
    enabled,
    values,
    promptBlock,
    bias,
    report,
    rollback,
    status,
    unblock,
    veto,
    activeVeto,
    maskTarget,
    spendEnergy,
    energyBurstLimit,
    recordAction,
  };
}
