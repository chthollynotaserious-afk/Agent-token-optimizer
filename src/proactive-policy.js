/**
 * 主动检查的概率计算（M0 从 bridge.js:18281-18293 原样抽出）。
 *
 * 为什么单独成文件：设计 §1 禁止清单第 1 条要求「purpose 变化不得影响任何一次主动检查结果」，
 * 这条必须可测。把公式抽成纯函数后，测试可以绕过定时器、直接喂 20 组固定输入，
 * 对比重构前后决策序列；顺带让情绪偏置只有一个落点（②）。
 *
 * 刚性（主人 2026-11-08 追加）：
 *   · 函数体不读全局、不读 Date.now()、不取 Math.random()；
 *   · 需要「现在」和「随机数」时，由调用方先算好，作为数字传进来；
 *   · 情绪输入只有情绪状态和配置，不接收会话状态对象。
 *
 * 行为不变：`emotionState` 为空 / 关闭时，结果与抽取前逐位相同（bias 恒为 0，
 * 加 0 不改浮点位模式）。
 */
import { emotionBias } from './emotion-state.js';

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const finite = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/**
 * 纯函数：算这一次主动检查的概率。
 *
 * @param {object} facts 调用方算好的标量事实（不含时间对象、不含会话对象）
 *   probBase           配置里的基础概率
 *   pendingThoughts    未过期的待说想法条数
 *   aiRepliedWithin30Min 最近 30 分钟内是否刚由 AI 回复过
 *   hour               本地小时（0-23），由调用方从时钟取
 *   aiCountLastHour    最近 1 小时 AI 自己的发言条数
 * @param {object|null} emotionState 衰减后的情绪值；null/关闭 → 偏置 0
 * @param {object} config 情绪配置（只读 maxBias）
 * @returns {{prob:number, probBeforeBias:number, bias:number}}
 */
export function proactiveProbability(facts = {}, emotionState = null, config = {}) {
  const probBase = Number(facts.probBase);
  let prob = clamp01(Number.isFinite(probBase) ? probBase : 0.4);
  if (Number(facts.pendingThoughts) > 0) prob = Math.min(1, prob * 1.4);
  if (facts.aiRepliedWithin30Min === true) prob *= 0.5;
  const hour = finite(facts.hour, 12);
  if (hour >= 23 || hour < 8) prob *= 0.3;
  if (finite(facts.aiCountLastHour, 0) >= 5) prob *= 0.3;
  const probBeforeBias = prob;
  // M0 影响 ②：概率偏置，唯一落点。|bias| ≤ 0.05，且只看情绪主维度。
  const bias = emotionState ? emotionBias(emotionState, config) : 0;
  const after = clamp01(prob + bias);
  return { prob: after, probBeforeBias, bias: after - probBeforeBias };
}

/**
 * 纯函数：这一次主动检查到底要不要发。
 * 顺序与抽取前一致：先看空闲与冷却，再抽签，最后看会话是否忙。
 * `draw` 由调用方传入（原实现是 Math.random()），函数内不取随机数。
 */
export function proactiveDecision({ draw, prob, idleMs, idleThresholdMs, sinceProactiveMs, cooldownMs, busy } = {}) {
  return finite(idleMs, 0) >= finite(idleThresholdMs, 0)
    && finite(sinceProactiveMs, Infinity) >= finite(cooldownMs, 0)
    && finite(draw, 1) < finite(prob, 0)
    && busy !== true;
}

/** 兼容旧名字：抽取前的实现叫 computeProactiveProbability。 */
export const computeProactiveProbability = proactiveProbability;
