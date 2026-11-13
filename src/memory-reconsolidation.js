/**
 * 记忆再巩固（Reconsolidation）与心境一致召回（Mood-Congruent Recall）。
 *
 * 依据《Denia-情绪记忆插件取舍-20261111.md》原生实现，绝不另建第三套记忆真相源：
 *   1. 再巩固系数固定为 0.15：被想起时只微调感受指纹（valence / arousal）并记录
 *      `lastRecalledEmotion` 与 `recallCount`，**绝不篡改原编码正文（text / title）**。
 *   2. 心境一致召回权重默认为 0.18（Denia 建议 0.15~0.20 区间，替代原插件过低的 0.05）。
 *   3. 独立落盘在 state/memory-reconsolidation.json（按 recordId 索引），
 *      不直接覆盖 memory-card.json，避免与 DSH surfcore 插件产生写盘并发竞争。
 */
import fs from 'node:fs';
import path from 'node:path';

export const RECONSOLIDATION_VERSION = 1;
export const RECONSOLIDATION_RATE = 0.15;
export const MOOD_CONGRUENCE_WEIGHT = 0.18;
export const RECALL_COOLDOWN_MS = 5 * 60_000;
export const MAX_RECON_ENTRIES = 5000;

const POSITIVE_CUES_RE = /(开心|高兴|快乐|喜欢|温柔|感动|期待|谢谢|感谢|夸|棒|顺利|成功|可爱|笑|放松|安心|抱抱|暖|赞|good|happy|great|thanks)/gu;
const NEGATIVE_CUES_RE = /(难过|低落|生气|烦躁|委屈|哭|失望|失败|焦虑|崩溃|抱歉|对不起|讨厌|吓|卡住|挂了|报错|出错|超时|痛|sad|fail|error|bad)/gu;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 3) => {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
};

/**
 * 纯函数：从记忆卡原记录推导初始情感基调（编码时刻的静态基准，不改原文）。
 */
export function estimateRecordEmotion(record = {}) {
  if (!record || typeof record !== 'object') {
    return { valence: 0, arousal: 0.25 };
  }
  const explicitMood = Number(record.valence);
  const explicitArousal = Number(record.arousal);
  if (Number.isFinite(explicitMood) && Number.isFinite(explicitArousal)) {
    return {
      valence: round(clamp(explicitMood, -1, 1)),
      arousal: round(clamp(explicitArousal, 0, 1)),
    };
  }
  const hay = `${record.title ?? ''} ${record.text ?? ''}`;
  const pos = (hay.match(POSITIVE_CUES_RE) ?? []).length;
  const neg = (hay.match(NEGATIVE_CUES_RE) ?? []).length;
  const rawScore = pos - neg;
  const valence = rawScore === 0 ? 0 : clamp(rawScore * 0.22, -0.9, 0.9);
  const intensityBonus = Math.min(0.65, (pos + neg) * 0.12);
  const arousal = clamp(0.25 + intensityBonus, 0.1, 0.95);
  return {
    valence: round(valence),
    arousal: round(arousal),
  };
}

/**
 * 纯函数：再巩固（系数 0.15）。
 * 保留 `encodedValence` / `encodedArousal` 与原编码记录不变，只微调当前感受指纹并记下最后想起时的心境。
 */
export function applyReconsolidation(
  prevEntry = {},
  currentEmotion = null,
  { rate = RECONSOLIDATION_RATE, now = Date.now(), baseline = null } = {},
) {
  const base = baseline || {
    valence: Number.isFinite(Number(prevEntry?.encodedValence)) ? clamp(Number(prevEntry.encodedValence), -1, 1) : 0,
    arousal: Number.isFinite(Number(prevEntry?.encodedArousal)) ? clamp(Number(prevEntry.encodedArousal), 0, 1) : 0.25,
  };
  const encodedValence = round(base.valence);
  const encodedArousal = round(base.arousal);
  const prevVal = Number.isFinite(Number(prevEntry?.valence)) ? clamp(Number(prevEntry.valence), -1, 1) : encodedValence;
  const prevAro = Number.isFinite(Number(prevEntry?.arousal)) ? clamp(Number(prevEntry.arousal), 0, 1) : encodedArousal;
  const prevCount = Math.max(0, Math.floor(Number(prevEntry?.recallCount) || 0));

  const safeRate = clamp(Number.isFinite(Number(rate)) ? Number(rate) : RECONSOLIDATION_RATE, 0.01, 0.5);
  const curValRaw = Number(currentEmotion?.valence);
  const curAroRaw = Number(currentEmotion?.arousal);
  const hasEmotion = Number.isFinite(curValRaw) && Number.isFinite(curAroRaw);

  const curVal = hasEmotion ? clamp(curValRaw, -1, 1) : prevVal;
  const curAro = hasEmotion ? clamp(curAroRaw, 0, 1) : prevAro;

  const nextVal = hasEmotion ? clamp((1 - safeRate) * prevVal + safeRate * curVal, -1, 1) : prevVal;
  const nextAro = hasEmotion ? clamp((1 - safeRate) * prevAro + safeRate * curAro, 0, 1) : prevAro;

  return {
    encodedValence,
    encodedArousal,
    valence: round(nextVal),
    arousal: round(nextAro),
    recallCount: prevCount + 1,
    lastRecalledAt: now,
    lastRecalledEmotion: hasEmotion
      ? { valence: round(curVal), arousal: round(curAro), at: now }
      : (prevEntry?.lastRecalledEmotion ?? null),
  };
}

/**
 * 纯函数：心境一致召回分 [-0.5, 1.0]。
 * 当当前心境明显（|valence| >= 0.08）时，与当前心境同向/相近的记忆获得正向召回加权。
 */
export function moodCongruenceScore(recordEmotion = null, currentEmotion = null) {
  if (!recordEmotion || !currentEmotion) return 0;
  const curVal = Number(currentEmotion.valence);
  if (!Number.isFinite(curVal) || Math.abs(curVal) < 0.08) return 0;
  const recVal = Number(recordEmotion.valence);
  if (!Number.isFinite(recVal) || Math.abs(recVal) < 0.05) return 0;

  const sameSign = (curVal > 0 && recVal > 0) || (curVal < 0 && recVal < 0);
  const strength = clamp((Math.abs(curVal) + Math.abs(recVal)) / 2, 0, 1);
  if (sameSign) {
    const closeness = 1 - Math.min(1, Math.abs(curVal - recVal));
    return round(clamp(0.45 * strength + 0.55 * closeness * strength, 0, 1));
  }
  return round(-clamp(Math.abs(curVal * recVal) * 0.5, 0, 0.5));
}

/**
 * 状态存储管理器：按 recordId 持久化记忆的再巩固感受轨迹。
 */
export function createReconsolidationStore({
  file,
  rate = RECONSOLIDATION_RATE,
  cooldownMs = RECALL_COOLDOWN_MS,
  now = Date.now,
  log = () => {},
} = {}) {
  let state = { version: RECONSOLIDATION_VERSION, entries: {} };

  function load() {
    if (!file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
        state = { version: RECONSOLIDATION_VERSION, entries: { ...parsed.entries } };
      }
    } catch {}
  }

  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const keys = Object.keys(state.entries);
      if (keys.length > MAX_RECON_ENTRIES) {
        keys.sort((a, b) => (Number(state.entries[a]?.lastRecalledAt) || 0) - (Number(state.entries[b]?.lastRecalledAt) || 0));
        for (const k of keys.slice(0, keys.length - MAX_RECON_ENTRIES)) {
          delete state.entries[k];
        }
      }
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (error) {
      log(`[reconsolidation] 写盘失败：${error?.message ?? error}`);
    }
  }

  load();

  function getEntry(recordId) {
    return state.entries[String(recordId)] || null;
  }

  function snapshot() {
    return { ...state.entries };
  }

  /**
   * 对本次被实际选入上下文的记忆执行 0.15 再巩固（带每条记忆 5 分钟防刷冷却）。
   */
  function recordRecall(items = [], currentEmotion = null) {
    if (!Array.isArray(items) || items.length === 0) return 0;
    const t = now();
    let updated = 0;
    for (const raw of items) {
      const id = String(raw?.id || raw?.recordId || '').trim();
      if (!id) continue;
      const prev = state.entries[id];
      if (prev && prev.lastRecalledAt && t - Number(prev.lastRecalledAt) < cooldownMs) {
        continue;
      }
      const baseline = prev
        ? { valence: prev.encodedValence, arousal: prev.encodedArousal }
        : estimateRecordEmotion(raw);
      state.entries[id] = applyReconsolidation(prev, currentEmotion, { rate, now: t, baseline });
      updated += 1;
    }
    if (updated > 0) save();
    return updated;
  }

  return { getEntry, snapshot, recordRecall };
}
