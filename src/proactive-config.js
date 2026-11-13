// Denia 2.4：主动社交的每群配置（在全局默认上做覆盖）。
//
// 只做纯配置合并，不启动定时器、不调用模型。桥接拿到 effective 配置后再决定
// 是否安排主动机会；自主引擎仍由 autonomous-social-policy 负责。
//
// 支持覆盖：
//   enabled / probability / checkIntervalMinMs / checkIntervalMaxMs /
//   idleThresholdMs / cooldownMs / activeHours {start,end} / allow / block
const DEFAULTS = Object.freeze({
  enabled: true,
  probability: 0.3,
  checkIntervalMinMs: 30 * 60_000,
  checkIntervalMaxMs: 90 * 60_000,
  idleThresholdMs: 15 * 60_000,
  cooldownMs: 0,
  activeHours: null,
});

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function parseHhMm(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? '').trim());
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null;
}

export function normalizeActiveHours(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const start = parseHhMm(raw.start);
  const end = parseHhMm(raw.end);
  if (!start || !end) return null;
  return { start: `${String(start.h).padStart(2, '0')}:${String(start.m).padStart(2, '0')}`, end: `${String(end.h).padStart(2, '0')}:${String(end.m).padStart(2, '0')}` };
}

export function normalizeProactiveConfig(raw = {}) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const min = Math.max(60_000, num(p.checkIntervalMinMs, DEFAULTS.checkIntervalMinMs));
  const max = Math.max(min, num(p.checkIntervalMaxMs, DEFAULTS.checkIntervalMaxMs));
  return {
    enabled: p.enabled !== false,
    probability: clamp(num(p.probability, DEFAULTS.probability), 0, 1),
    checkIntervalMinMs: min,
    checkIntervalMaxMs: max,
    idleThresholdMs: Math.max(0, num(p.idleThresholdMs, DEFAULTS.idleThresholdMs)),
    cooldownMs: Math.max(0, num(p.cooldownMs, DEFAULTS.cooldownMs)),
    activeHours: normalizeActiveHours(p.activeHours),
    allow: Array.isArray(p.allow) ? p.allow.map(String).filter((x) => /^\d+$/.test(x)) : [],
    block: Array.isArray(p.block) ? p.block.map(String).filter((x) => /^\d+$/.test(x)) : [],
  };
}

export function groupIdOf(key) {
  const m = /^(?:group:)?(\d+)$/.exec(String(key ?? '').trim());
  return m ? m[1] : '';
}

/**
 * 取某个会话的 effective 主动配置。
 * `cfg.socialV2.proactive.groups['<群号>']` 覆盖全局；私聊也可用 `private:<QQ>` 覆盖。
 */
export function proactiveConfigFor(cfg, key) {
  const global = normalizeProactiveConfig(cfg?.socialV2?.proactive);
  const raw = cfg?.socialV2?.proactive?.groups;
  const k = String(key ?? '').trim();
  const gid = groupIdOf(k);
  const override = raw && typeof raw === 'object'
    ? (raw[k] ?? (gid ? raw[gid] : null))
    : null;
  if (!override || typeof override !== 'object') return { ...global, key: k, overridden: false };
  const merged = normalizeProactiveConfig({
    ...global,
    ...override,
    // 数组覆盖时直接替换；未提供则沿用全局。
    allow: override.allow !== undefined ? override.allow : global.allow,
    block: override.block !== undefined ? override.block : global.block,
    activeHours: override.activeHours !== undefined ? override.activeHours : global.activeHours,
  });
  return { ...merged, key: k, overridden: true };
}

/** 事件/定时器到达时，当前时刻是否在允许主动的时段。跨午夜区间也支持。 */
export function inActiveHours(activeHours, at = new Date()) {
  if (!activeHours) return true;
  const start = parseHhMm(activeHours.start);
  const end = parseHhMm(activeHours.end);
  if (!start || !end) return true;
  const d = at instanceof Date ? at : new Date(at);
  const now = d.getHours() * 60 + d.getMinutes();
  const s = start.h * 60 + start.m;
  const e = end.h * 60 + end.m;
  if (s === e) return true;
  if (s < e) return now >= s && now < e;
  return now >= s || now < e; // 跨午夜，例如 23:00–08:00
}

/** 群号是否被 allow/block 明确拒绝；allow 非空时不在名单内即拒绝。 */
export function proactiveGroupAllowed(config, key) {
  const gid = groupIdOf(key);
  if (!gid) return true;
  const block = config?.block ?? [];
  const allow = config?.allow ?? [];
  if (block.includes(gid)) return false;
  if (allow.length && !allow.includes(gid)) return false;
  return true;
}

export const __test = { DEFAULTS, parseHhMm };
