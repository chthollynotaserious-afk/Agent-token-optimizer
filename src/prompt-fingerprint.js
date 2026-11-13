/**
 * 唤醒提示词指纹（cmd-20261108-30 §B1）。
 *
 * 要证的事：C 模式的采集拦截点（`onebotSend` / `sendToQQ`）在提示词**构建之后**，
 * 不能改变模型看到的东西。做法不是「真发一次网络再比」，而是：
 *   · 每次唤醒在提示词定稿处记一个 sha256 —— 同一份文本必须逐字节一致；
 *   · 再记一个**归一化** sha256 —— 把本来就每次不同、且与被测对象无关的字段
 *     （时间戳、日期、时钟、epoch、相对时间、会话 id）替换成占位符，
 *     用来比较「同一份夹具输入、两次不同的运行」。
 *
 * 归一化的边界（宁可少归一，不可多归一）：
 *   · 只抹时间/标识类噪声。数字、标点、语气、每一句正文都原样保留；
 *   · 不抹位数、不抹随机 id 以外的数字 —— 「把所有数字都换成 #」会让 hash 恒等，
 *     那样等于没测。
 *
 * 为什么还要抹会话键与令牌（2026-11-08 实测 A/B 两次真实运行）：
 *   同一份夹具输入、两条全新的假号会话，479 行提示词里只有 4 行不同，全部是
 *   「哪条会话 / 哪条消息」的身份字段：`private:<号>`、快照里的 `conversationKey`/`userId`、
 *   每次会话随机生成的 agent 令牌。这些不是提示词**内容**的抖动，而是身份参数；
 *   不抹掉它们，跨会话的两次运行永远比不出「内容是否一致」。
 *   原文 hash 仍然逐字节区分一切，所以抹这些不会丢掉任何信号。
 */
import crypto from 'node:crypto';

const RULES = [
  // ISO8601（含毫秒与 Z）：2026-11-08T16:35:12.345Z
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<ISO>'],
  // 中文日期：2026/11/8
  [/\d{4}\/\d{1,2}\/\d{1,2}/g, '<DATE>'],
  // 会话 id：session-8fda6c26-...
  [/session-[0-9a-zA-Z-]{8,}/g, '<SID>'],
  // UUID
  [/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '<UUID>'],
  // 相对时间：3 分钟前 / 12 秒前 / 2 小时前
  [/\d+(?:\.\d+)?\s*(?:分钟|秒钟|秒|小时|天)前/g, '<AGO>'],
  // epoch 毫秒 / 秒（先长后短，避免 13 位被 10 位规则切一半）
  [/\b\d{13}\b/g, '<MS>'],
  [/\b\d{10}\b/g, '<SEC>'],
  // 时钟：16:35 / 16:35:12
  [/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '<CLOCK>'],
  // 会话键：private:900000000104 / group:456（身份，不是内容）
  [/\b(?:private|group):\d{5,}\b/g, '<KEY>'],
  // agent 令牌等长十六进制串（32 位以上；会话令牌 48 位）
  [/\b[0-9a-fA-F]{32,}\b/g, '<TOKEN>'],
  // 12~16 位纯数字：假号段 QQ 号（真实 QQ 号最多 11 位），出现在快照 JSON 的 userId 里
  [/\b\d{12,16}\b/g, '<ID>'],
];

/** 把时间/标识类噪声替换成占位符；其余一个字都不动。 */
export function normalizePromptForHash(text) {
  let out = String(text ?? '');
  for (const [re, mark] of RULES) out = out.replace(re, mark);
  return out;
}

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** 返回 {hash, hashNorm, chars}；hash 是原文指纹，hashNorm 是跨运行可比指纹。 */
export function fingerprintPrompt(text) {
  const value = String(text ?? '');
  return {
    chars: value.length,
    hash: sha256(value),
    hashNorm: sha256(normalizePromptForHash(value)),
  };
}

/** 首次出现差异的位置（调试用；只报位置与附近片段，不整段回显）。 */
export function firstDifference(a, b, window = 120) {
  const x = normalizePromptForHash(a);
  const y = normalizePromptForHash(b);
  if (x === y) return { same: true, at: -1 };
  const limit = Math.min(x.length, y.length);
  let i = 0;
  while (i < limit && x[i] === y[i]) i += 1;
  return {
    same: false,
    at: i,
    left: x.slice(Math.max(0, i - 20), i + window),
    right: y.slice(Math.max(0, i - 20), i + window),
  };
}
