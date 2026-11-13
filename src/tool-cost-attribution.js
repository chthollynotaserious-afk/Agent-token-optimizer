/**
 * 工具级 token / 费用归因（纯函数，只读遥测，不改变桥接行为）。
 *
 * 口径（estimated，不冒充实测）：
 *   同一次会话 + 同一轮内，模型调用 A 发出工具调用，工具结果返回后产生下一次模型调用 B。
 *   把 `input(B) - input(A)` 的增量记到这批工具结果头上，按不同 callId 均分；
 *   再用 B 的模型与时间点，把这份增量按「缓存未命中输入」计价。
 *
 * 为什么这样归因：
 *   · 工具正文是进入下一次上下文的主要原因，增量是真实观测值；
 *   · 不把 B 的全部输入算给工具（那会把历史上下文重复计入）；
 *   · 压缩导致 input(B) < input(A) 时记 0，只保留「关联次数」，不编造负数收益。
 *
 * 边界：
 *   · 同一批并行工具无法区分各自贡献，只能均分，已是估算；
 *   · 没有下一次模型调用的工具结果（如被中断、纯本地动作）不归属费用；
 *   · 只读 JSONL 中的长度与 usage，不读取工具参数或消息正文。
 */
import { inputTokensOf, priceUsage, DEFAULT_PRICE_TABLE } from './model-prices.js';

function tsOf(row) {
  const n = Number(row?.ts);
  return Number.isFinite(n) ? n : 0;
}

function keyOf(row) {
  const sessionId = row?.sessionId ?? row?.session_id ?? 'unknown';
  const turn = row?.turn ?? 0;
  return `${sessionId}|${turn}`;
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

function emptyTool(tool) {
  return {
    tool,
    linkedCalls: 0,
    resultChars: 0,
    errors: 0,
    attributedInput: 0,
    attributedCost: 0,
    avgAttributedInput: 0,
  };
}

/**
 * @param {object} input
 * @param {Array<object>} [input.modelCalls] 已按 message 相过滤的 model_call 行
 * @param {Array<object>} [input.toolResults] tool_result 行
 * @param {object} [opts]
 * @param {object} [opts.table] 价目表
 * @returns {{method:string, estimated:boolean, linkedCalls:number, unattributedResults:number, tools:Array<object>}}
 */
export function buildToolAttribution({ modelCalls = [], toolResults = [] } = {}, { table = DEFAULT_PRICE_TABLE } = {}) {
  const callsByTurn = groupBy(modelCalls, keyOf);
  const resultsByTurn = groupBy(toolResults, keyOf);
  const tools = new Map();
  const getTool = (name) => {
    const key = name || 'unknown';
    let entry = tools.get(key);
    if (!entry) {
      entry = emptyTool(key);
      tools.set(key, entry);
    }
    return entry;
  };

  // 所有工具结果都计入「字符/错误」；只有被下一次模型调用承接的才计入费用。
  for (const result of toolResults) {
    const t = getTool(result.tool);
    t.resultChars += Number(result.resultChars) || 0;
    if (result.ok === false) t.errors += 1;
  }

  let linkedCalls = 0;

  for (const [key, rawCalls] of callsByTurn) {
    const calls = [...rawCalls].sort((a, b) => tsOf(a) - tsOf(b) || (Number(a.step) || 0) - (Number(b.step) || 0));
    const results = [...(resultsByTurn.get(key) ?? [])].sort((a, b) => tsOf(a) - tsOf(b));
    if (calls.length < 2 || !results.length) continue;

    const claimed = new Set();
    for (let i = 1; i < calls.length; i += 1) {
      const prev = calls[i - 1];
      const next = calls[i];
      const from = tsOf(prev);
      const to = tsOf(next);
      if (to < from) continue;

      // 同一 callId 的重复结果只算一次（重连/重放），未带 callId 的按序号独立。
      const batch = new Map();
      for (let r = 0; r < results.length; r += 1) {
        const result = results[r];
        const ts = tsOf(result);
        if (ts < from || ts > to) continue;
        const id = String(result.callId || '') || `anon:${key}:${r}`;
        if (claimed.has(id)) continue;
        if (!batch.has(id)) batch.set(id, result);
      }
      if (!batch.size) continue;

      const delta = Math.max(0, inputTokensOf(next.usage) - inputTokensOf(prev.usage));
      const share = delta / batch.size;
      const model = next.model || 'deepseek-flash';
      const cost = delta > 0
        ? priceUsage({ cacheMiss: share }, { model, at: next.ts, table }).cost.total
        : 0;

      for (const [id, result] of batch) {
        claimed.add(id);
        linkedCalls += 1;
        const t = getTool(result.tool);
        t.linkedCalls += 1;
        t.attributedInput += share;
        t.attributedCost += cost;
      }
    }

  }

  // 重复结果或没有下一次模型调用的结果都算未归属；保守口径，不把关联数当成功数。
  const unattributedResults = Math.max(0, toolResults.length - linkedCalls);

  const list = [...tools.values()].map((t) => ({
    ...t,
    attributedInput: Math.round(t.attributedInput * 100) / 100,
    attributedCost: Math.round(t.attributedCost * 1e6) / 1e6,
    avgAttributedInput: t.linkedCalls ? Math.round(t.attributedInput / t.linkedCalls) : 0,
  })).sort((a, b) => b.attributedCost - a.attributedCost || b.linkedCalls - a.linkedCalls);

  return {
    method: 'next-call-input-delta',
    estimated: true,
    linkedCalls,
    unattributedResults,
    tools: list,
  };
}
