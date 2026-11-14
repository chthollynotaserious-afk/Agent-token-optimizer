/**
 * Built-in Retrieval & Memory-Recall Tool Wiring (P1/P2 Auto-Wiring Bridge)
 *
 * Bridges the gap between retention/memory hints and real LLM tool-calling loops:
 *   - Canonical schemas in OpenAI, Anthropic, and MCP formats
 *   - Safe argument parsing & Fail-Closed ACL pinning from trusted runtime context
 *   - Automatic multi-round dispatch loop for `uao_retrieve_tool_output` & `uao_recall_memory`
 */

export const BUILTIN_TOOL_NAMES = Object.freeze({
  RETRIEVE_TOOL_OUTPUT: 'uao_retrieve_tool_output',
  RECALL_MEMORY: 'uao_recall_memory',
});

const RETRIEVE_ALIASES = new Set(['uao_retrieve_tool_output', 'retrieveToolResult', 'retrieve_tool_output']);
const RECALL_ALIASES = new Set(['uao_recall_memory', 'recallMemory', 'recall_memory']);

const TOOL_SPECS = {
  [BUILTIN_TOOL_NAMES.RETRIEVE_TOOL_OUTPUT]: {
    name: BUILTIN_TOOL_NAMES.RETRIEVE_TOOL_OUTPUT,
    description: 'Inspect omitted lines or search keyword matches inside an oversized retained tool output by refId.',
    parameters: {
      type: 'object',
      properties: {
        refId: { type: 'string', description: 'Retention reference ID (e.g. tr_a1b2c3d4e5f6).' },
        startLine: { type: 'integer', description: '1-based inclusive start line.' },
        endLine: { type: 'integer', description: '1-based inclusive end line.' },
        query: { type: 'string', description: 'Optional case-insensitive substring/keyword filter.' },
        contextLines: { type: 'integer', description: 'Context lines around each match (default 2).' },
        maxChars: { type: 'integer', description: 'Maximum returned characters (default 6000).' },
      },
      required: ['refId'],
    },
  },
  [BUILTIN_TOOL_NAMES.RECALL_MEMORY]: {
    name: BUILTIN_TOOL_NAMES.RECALL_MEMORY,
    description: 'Search and recall extracted memories or archived session summaries from earlier turns within this conversation scope.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords or question describing what prior context to recall.' },
        sessionId: { type: 'string', description: 'Optional specific archived sessionId to filter by.' },
        limit: { type: 'integer', description: 'Maximum number of memory entries to return (default 6).' },
        maxChars: { type: 'integer', description: 'Maximum characters in recall output (default 3000).' },
      },
    },
  },
};

export function getBuiltinToolSpecs({ includeRetrieve = true, includeRecall = true } = {}) {
  const specs = [];
  if (includeRetrieve) specs.push(TOOL_SPECS[BUILTIN_TOOL_NAMES.RETRIEVE_TOOL_OUTPUT]);
  if (includeRecall) specs.push(TOOL_SPECS[BUILTIN_TOOL_NAMES.RECALL_MEMORY]);
  return specs;
}

export function formatBuiltinTools(specs = [], format = 'openai') {
  return (Array.isArray(specs) ? specs : []).map((spec) => {
    if (format === 'anthropic') {
      return {
        name: spec.name,
        description: spec.description,
        input_schema: spec.parameters,
      };
    }
    if (format === 'mcp') {
      return {
        name: spec.name,
        description: spec.description,
        inputSchema: spec.parameters,
      };
    }
    return {
      type: 'function',
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
      },
    };
  });
}

export function toolNameOf(tool) {
  return String(tool?.function?.name || tool?.name || '').trim();
}

export function mergeToolsWithoutDuplicates(existingTools = [], extraTools = []) {
  const out = [];
  const seen = new Set();
  for (const t of [...(Array.isArray(existingTools) ? existingTools : []), ...(Array.isArray(extraTools) ? extraTools : [])]) {
    const name = toolNameOf(t);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(t);
  }
  return out;
}

export function isBuiltinToolName(name) {
  const clean = String(name || '').trim();
  return RETRIEVE_ALIASES.has(clean) || RECALL_ALIASES.has(clean);
}

function parseArgs(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === 'object') return rawArgs;
  if (typeof rawArgs === 'string') {
    try {
      const parsed = JSON.parse(rawArgs);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function extractToolCalls(response) {
  if (!response || typeof response !== 'object') return null;

  // OpenAI Chat Completions format
  const openaiMsg = response?.choices?.[0]?.message;
  if (openaiMsg && Array.isArray(openaiMsg.tool_calls) && openaiMsg.tool_calls.length > 0) {
    return {
      format: 'openai',
      assistantMessage: openaiMsg,
      calls: openaiMsg.tool_calls.map((tc) => ({
        id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        name: String(tc?.function?.name || tc?.name || '').trim(),
        args: parseArgs(tc?.function?.arguments ?? tc?.arguments),
        raw: tc,
      })),
    };
  }

  // Anthropic Messages format
  if (Array.isArray(response.content)) {
    const toolUses = response.content.filter((b) => b && b.type === 'tool_use');
    if (toolUses.length > 0) {
      return {
        format: 'anthropic',
        assistantMessage: { role: 'assistant', content: response.content },
        calls: toolUses.map((b) => ({
          id: b.id || `toolu_${Math.random().toString(36).slice(2, 10)}`,
          name: String(b.name || '').trim(),
          args: parseArgs(b.input),
          raw: b,
        })),
      };
    }
  }

  return null;
}

export function executeBuiltinToolCall(optimizer, call, trustedCtx = {}) {
  const name = String(call?.name || '').trim();
  const args = parseArgs(call?.args ?? call?.input ?? call?.arguments);

  if (RETRIEVE_ALIASES.has(name)) {
    if (!args.refId) {
      return { ok: false, error: 'missing_refId' };
    }
    return optimizer.retrieveToolResult(String(args.refId), {
      startLine: args.startLine,
      endLine: args.endLine,
      query: args.query,
      contextLines: args.contextLines,
      maxChars: args.maxChars,
    });
  }

  if (RECALL_ALIASES.has(name)) {
    return optimizer.recallMemory({
      query: args.query || '',
      sessionId: args.sessionId || null,
      limit: args.limit ?? 6,
      maxChars: args.maxChars ?? 3000,
      // Always pin identity/scope from trusted runtime context (Fail-Closed ACL)
      conversationKey: trustedCtx.conversationKey || trustedCtx.sessionId || 'default',
      scope: trustedCtx.scope || trustedCtx.conversationKey || trustedCtx.sessionId || 'default',
      tenantId: trustedCtx.tenantId || null,
      isAdmin: trustedCtx.isAdmin === true,
      isOwner: trustedCtx.isOwner === true,
      includeSensitive: trustedCtx.includeSensitive === true,
    });
  }

  return { ok: false, error: `unknown_builtin_tool:${name}` };
}

export function appendBuiltinToolResults({
  messages = [],
  extracted,
  results = [],
}) {
  const nextMessages = [...messages, extracted.assistantMessage];
  if (extracted.format === 'anthropic') {
    nextMessages.push({
      role: 'user',
      content: extracted.calls.map((call, idx) => ({
        type: 'tool_result',
        tool_use_id: call.id,
        content: JSON.stringify(results[idx]),
      })),
    });
    return nextMessages;
  }

  for (let i = 0; i < extracted.calls.length; i += 1) {
    nextMessages.push({
      role: 'tool',
      tool_call_id: extracted.calls[i].id,
      name: extracted.calls[i].name,
      content: JSON.stringify(results[i]),
    });
  }
  return nextMessages;
}

/**
 * Shared automatic tool-execution loop for pure UAO built-in retrieval/recall turns.
 * Never intercepts host application tool calls.
 */
export async function runBuiltinToolLoop({
  optimizer,
  initialPayload,
  meta = {},
  invokeUpstream,
  onResponse = null,
  maxRounds = 4,
}) {
  let currentPayload = {
    ...initialPayload,
    messages: Array.isArray(initialPayload?.messages) ? [...initialPayload.messages] : [],
  };
  let executedCalls = [];
  let rounds = 0;

  while (true) {
    const response = await invokeUpstream(currentPayload, rounds);
    if (typeof onResponse === 'function') {
      await onResponse(response, currentPayload, rounds);
    }

    const extracted = extractToolCalls(response);
    if (!extracted || rounds >= maxRounds) {
      return { response, rounds, executedCalls, finalPayload: currentPayload };
    }

    // Only auto-dispatch when ALL tool calls in this turn target built-in UAO tools
    const allBuiltin = extracted.calls.every((c) => isBuiltinToolName(c.name));
    if (!allBuiltin) {
      return { response, rounds, executedCalls, finalPayload: currentPayload };
    }

    const results = extracted.calls.map((call) => {
      const res = executeBuiltinToolCall(optimizer, call, meta);
      executedCalls.push({ name: call.name, args: call.args, result: res, round: rounds });
      return res;
    });

    currentPayload = {
      ...currentPayload,
      messages: appendBuiltinToolResults({
        messages: currentPayload.messages,
        extracted,
        results,
      }),
    };
    rounds += 1;
  }
}
