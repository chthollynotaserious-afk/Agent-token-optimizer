// V2.6 任务优先级与独立预算（纯逻辑；不调用模型、不改生产配置）。
//
// P0：主人管理命令（确定性、本地）——永远不占普通聊天预算。
// P1：安全/事件管理——本地部分不占聊天预算；需要模型的安全语义复核用独立小预算，
//     预算不足转人工，不自动删除、不猜。
// P2：普通聊天/主动/B站/后台——受现有每日 Token/费用上限约束。
import fs from 'node:fs';
import path from 'node:path';

export const PRIORITIES = Object.freeze({ P0: 'P0', P1: 'P1', P2: 'P2' });

const P0_TASKS = new Set([
  'help', 'status', 'health', 'version', 'cost', 'pending', 'approve', 'reject',
  'friends', 'groups', 'blacklist', 'unblock', 'pause', 'resume', 'logs', 'review',
]);
const P1_TASKS = new Set([
  'request-register', 'friend-request', 'group-request', 'allowlist', 'denylist',
  'violation-count', 'safety-warning', 'owner-notify', 'relationship-remove', 'group-leave',
]);

export function classifyTask(task) {
  const t = String(task ?? '').trim().toLowerCase();
  if (P0_TASKS.has(t) || t.startsWith('command:')) return PRIORITIES.P0;
  if (P1_TASKS.has(t) || t.startsWith('safety:')) return PRIORITIES.P1;
  return PRIORITIES.P2;
}

export function normalizeSafetyBudget(raw = {}) {
  return {
    // 独立安全语义预算，默认很小；不随普通聊天额度增加。
    dailyCNY: Math.max(0, Math.min(5, Number(raw.dailyCNY) || 0.5)),
    enabled: raw.enabled !== false,
  };
}

export function createPriorityBudget({ usage = {}, limits = {}, evaluateBudget, stateFile, config = {}, now = () => Date.now() } = {}) {
  const safety = normalizeSafetyBudget(config.safety);
  let state = { v: 1, day: '', safetySpentCNY: 0, chatNoticeAt: 0 };
  try {
    const j = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (j?.v === 1) state = j;
  } catch {}
  const dayKey = () => {
    const d = new Date(now());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  function rollDay() {
    const d = dayKey();
    if (state.day !== d) { state.day = d; state.safetySpentCNY = 0; state.chatNoticeAt = 0; }
  }
  function save() {
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, stateFile);
    } catch {}
  }
  /**
   * @param {{task:string, local?:boolean, needsModel?:boolean, estimatedCostCNY?:number}} input
   * @returns {{allowed:boolean, priority:string, budget:string, reason:string, review?:boolean, retry?:boolean}}
   */
  function check(input = {}) {
    rollDay();
    const priority = classifyTask(input.task);
    if (priority === PRIORITIES.P0) {
      return { allowed: true, priority, budget: 'none', reason: '主人管理命令不占聊天预算', retry: false };
    }
    if (priority === PRIORITIES.P1) {
      if (input.local !== false && !input.needsModel) {
        return { allowed: true, priority, budget: 'none', reason: '本地安全/事件操作不占聊天预算', retry: false };
      }
      if (!safety.enabled) return { allowed: false, priority, budget: 'safety', reason: '安全语义预算关闭，转人工复核', review: true, retry: false };
      const cost = Math.max(0, Number(input.estimatedCostCNY) || 0);
      if (state.safetySpentCNY + cost > safety.dailyCNY) {
        return { allowed: false, priority, budget: 'safety', reason: `安全语义预算不足（${state.safetySpentCNY.toFixed(2)}/${safety.dailyCNY.toFixed(2)}），转人工`, review: true, retry: false };
      }
      state.safetySpentCNY += cost; save();
      return { allowed: true, priority, budget: 'safety', reason: '使用独立安全语义预算', review: false, retry: false };
    }
    let blocked = false;
    let reason = '普通聊天预算可用';
    try {
      const r = evaluateBudget ? evaluateBudget(usage, limits, { scopes: ['qq', 'total'] }) : { blocked: false };
      blocked = r.blocked === true;
      reason = blocked ? '普通聊天预算已耗尽' : reason;
    } catch { blocked = false; reason = '预算检查失败，按可用处理（不增加额度）'; }
    return { allowed: !blocked, priority, budget: 'chat', reason, retry: false };
  }
  function noteChatExhaustedOnce() {
    rollDay();
    if (state.chatNoticeAt) return false;
    state.chatNoticeAt = now(); save();
    return true;
  }
  function snapshot() {
    rollDay();
    return { ...state, safetyLimitCNY: safety.dailyCNY, safetyEnabled: safety.enabled };
  }
  return { check, noteChatExhaustedOnce, snapshot, classifyTask, config: safety };
}
