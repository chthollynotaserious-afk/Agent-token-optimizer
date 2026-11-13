#!/usr/bin/env node
import fs from 'node:fs';

function patchFile(filePath, mutator) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let text = eol === '\r\n' ? raw.replace(/\r\n/g, '\n') : raw;
  text = mutator(text);
  const out = eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
  fs.writeFileSync(filePath, out, 'utf8');
  console.log(`Patched ${filePath} (eol=${eol === '\r\n' ? 'CRLF' : 'LF'})`);
}

function replaceExact(text, target, replacement, label) {
  const idx = text.indexOf(target);
  if (idx < 0) {
    throw new Error(`Anchor not found for [${label}]:\n${target.slice(0, 200)}`);
  }
  const second = text.indexOf(target, idx + target.length);
  if (second >= 0) {
    throw new Error(`Anchor not unique for [${label}]`);
  }
  return text.slice(0, idx) + replacement + text.slice(idx + target.length);
}

// 1. src/natural-style.js
patchFile('/home/ubuntu/surfcore/src/natural-style.js', (text) => {
  text = replaceExact(
    text,
    "  learning: `【聊天方式】这是学习/解释：概念、条件、例子和关键推理要讲清楚；标点正常用。不要为了像聊天而压成半句，也不要套用闲聊的短句规则。${COMMON}`,",
    "  learning: `【聊天方式】这是学习/解释：概念、条件、例子和关键推理要讲清楚；标点正常用。不要为了像聊天而压成半句，也不要套用闲聊的短句规则。尽量把完整的因果解释、例子和步骤放在 1~2 条结构清晰的消息里一次讲完，不要拆成十来条碎片连发。${COMMON}`,",
    'natural-style learning'
  );
  text = replaceExact(
    text,
    "  serious: `【聊天方式】这是正经事：准确、完整优先，关键条件、步骤、风险要写全；标点正常用。不要用梗、口头禅或单字判词代替信息。${COMMON}`,",
    "  serious: `【聊天方式】这是正经事：准确、完整优先，关键条件、步骤、风险要写全；标点正常用。不要用梗、口头禅或单字判词代替信息。同一件事的结论、条件与风险尽量合并在 1~2 条内写完，不要一句一条刷屏。${COMMON}`,",
    'natural-style serious'
  );
  text = replaceExact(
    text,
    "  dev: `【聊天方式】这是开发/技术任务：先给能用的答案，命令、代码、报错原文、步骤要完整准确；标点正常用；不要用梗或口头禅替代信息。${COMMON}`,",
    "  dev: `【聊天方式】这是开发/技术任务：先给能用的答案，命令、代码、报错原文、步骤要完整准确；标点正常用；不要用梗或口头禅替代信息。分析结果、排障步骤或代码说明尽量合并在 1~2 条完整消息里发出，不要拆成很多条；需要同时确认已读、自然收尾或设置唤醒时，可直接在 qq_send_message 传入 throughSeq / afterAction，避免多跑工具轮次。${COMMON}`,",
    'natural-style dev'
  );
  return text;
});

// 2. src/mcp-snowluma-safe.js
patchFile('/home/ubuntu/surfcore/src/mcp-snowluma-safe.js', (text) => {
  text = replaceExact(
    text,
    `server.tool(
  'qq_set_wake_config',
  '睡眠由你自主决定：主人说去睡吧或休息吧是建议，不是强制命令；可依据自己的状态决定休息，也可以继续交流或婉拒。你决定休息后，再设置指定会话的二代唤醒配置：mode/无限期或有限时间/提前唤醒条件（@、名字、关键词、提问、拍一拍、概率、anyMessage、指定成员）。triggers.speakerIds 是可选的“指定群友发言唤醒”：填一个或多个群友 QQ 号后，只要其中任意一位在群里发言就会唤醒你；不设置则不启用。适合在等某个人回复、或某人反应慢怕错过时使用。triggers.poke 开启后，群里有人拍一拍（包括拍你或拍别人）会唤醒你。注意：每次设置潜水/下一次唤醒前需先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可设置并沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与可直接设置并沉睡；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('可同时确认已读：使用已查看结果中的 readThroughSeq，省去额外 qq_mark_read；不传则只设置唤醒配置。若 markRead 工具被关闭，该水位会被忽略，本工具只设置唤醒配置'),
    config: z.object({
      mode: z.enum(['diving', 'active']).optional().describe('diving=潜水，active=活跃（anyMessage 开启）'),
      infinite: z.boolean().optional().describe('true=无限期，只有条件命中才唤醒；false=有限时间'),
      sleepMs: z.number().optional().describe('有限潜水毫秒数（从当前时间起算）'),
      sleepUntil: z.string().optional().describe('有限潜水截止时间 ISO 字符串，优先级高于 sleepMs'),
      triggers: z.object({
        atMention: z.boolean().optional().describe('被 @ 或引用自己时唤醒'),
        nameMention: z.boolean().optional().describe('被叫名字/昵称时唤醒'),
        speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('指定群友 QQ 号数组：这些群友中任意一位发言时唤醒（可选，最多 20 个，不设置则不启用；私聊不适用，设置会被桥接清除；可从 qq_get_active_members / qq_get_group_members / qq_get_message_detail 的 userId/user_id 获取）'),
        keywords: z.array(z.string()).optional().describe('出现任意关键词时唤醒'),
        question: z.boolean().optional().describe('被直接提问/点名挑战时唤醒'),
        poke: z.boolean().optional().describe('有人拍一拍时唤醒（群聊包括拍你和拍别人，私聊为对方拍你）'),
        anyMessage: z.boolean().optional().describe('任意新消息都唤醒（活跃模式）'),
        probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')
      }).optional(),
      batchWindowMs: z.number().optional().describe('多条消息合并唤醒窗口（毫秒，>=1000）')
    }).describe('要设置的唤醒配置，缺省字段保留原值')
  },`,
    `const wakeConfigSchema = z.object({
  mode: z.enum(['diving', 'active']).optional().describe('diving=潜水，active=活跃（anyMessage 开启）'),
  infinite: z.boolean().optional().describe('true=无限期，只有条件命中才唤醒；false=有限时间'),
  sleepMs: z.number().optional().describe('有限潜水毫秒数（从当前时间起算）'),
  sleepUntil: z.string().optional().describe('有限潜水截止时间 ISO 字符串，优先级高于 sleepMs'),
  triggers: z.object({
    atMention: z.boolean().optional().describe('被 @ 或引用自己时唤醒'),
    nameMention: z.boolean().optional().describe('被叫名字/昵称时唤醒'),
    speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('指定群友 QQ 号数组：这些群友中任意一位发言时唤醒（可选，最多 20 个，不设置则不启用；私聊不适用，设置会被桥接清除；可从 qq_get_active_members / qq_get_group_members / qq_get_message_detail 的 userId/user_id 获取）'),
    keywords: z.array(z.string()).optional().describe('出现任意关键词时唤醒'),
    question: z.boolean().optional().describe('被直接提问/点名挑战时唤醒'),
    poke: z.boolean().optional().describe('有人拍一拍时唤醒（群聊包括拍你和拍别人，私聊为对方拍你）'),
    anyMessage: z.boolean().optional().describe('任意新消息都唤醒（活跃模式）'),
    probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')
  }).optional(),
  batchWindowMs: z.number().optional().describe('多条消息合并唤醒窗口（毫秒，>=1000）')
});

server.tool(
  'qq_set_wake_config',
  '睡眠由你自主决定：主人说去睡吧或休息吧是建议，不是强制命令；可依据自己的状态决定休息，也可以继续交流或婉拒。你决定休息后，再设置指定会话的二代唤醒配置：mode/无限期或有限时间/提前唤醒条件（@、名字、关键词、提问、拍一拍、概率、anyMessage、指定成员）。triggers.speakerIds 是可选的“指定群友发言唤醒”：填一个或多个群友 QQ 号后，只要其中任意一位在群里发言就会唤醒你；不设置则不启用。适合在等某个人回复、或某人反应慢怕错过时使用。triggers.poke 开启后，群里有人拍一拍（包括拍你或拍别人）会唤醒你。注意：每次设置潜水/下一次唤醒前需先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可设置并沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与可直接设置并沉睡；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('可同时确认已读：使用已查看结果中的 readThroughSeq，省去额外 qq_mark_read；不传则只设置唤醒配置。若 markRead 工具被关闭，该水位会被忽略，本工具只设置唤醒配置'),
    config: wakeConfigSchema.describe('要设置的唤醒配置，缺省字段保留原值')
  },`,
    'mcp wakeConfigSchema'
  );

  text = replaceExact(
    text,
    `server.tool(
  'qq_send_message',
  '统一发送工具：可发一条或多条，可引用某条消息，可自定义/按字数计算条间时间差。二代仿真模式专用。注意：字符串=一条消息，数组=多条消息；每个字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。按内容自然分条；内容太长先总结/挑重点，不要拆成 20 条刷屏。只有以下情况才需要传 replyToMessageId 引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中用于点名某个人；与引用二选一即可，不要滥用）'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto=桥接随机；fixed=固定间隔；byLength=按字数计算'),
    gapMs: z.number().optional().describe('fixed 模式下的统一间隔（毫秒）'),
    gaps: z.array(z.number()).optional().describe('fixed 模式下逐条间隔（长度=条数-1）')
  },
  async ({ key, token, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps }) => {
    try {
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\\"你好\\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: \`发送失败：\${error?.message ?? error}\` }], isError: true };
    }
  }
);`,
    `server.tool(
  'qq_send_message',
  '统一发送工具：可发一条或多条，可引用某条消息，可自定义/按字数计算条间时间差；也支持一次传 items 为每条分别指定 replyToMessageId / atUserId，并可顺带传入 throughSeq / afterAction（confirmed/close/sleep）把发完后的已读/收尾/设定唤醒折叠进同一轮。二代仿真模式专用。注意：字符串=一条消息，数组=多条消息；每个字符串内部不要用空格分隔中文短句；正经/解释/技术回复请把完整的因果、步骤和条件放在 1~2 条里写完，不要拆成大量碎片。只有以下情况才需要传 replyToMessageId 引用：① 你这条消息指向的人或消息并非最新一条别人的消息；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况不要引用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).optional().describe('要发送的内容：字符串=一条；数组=分多条（与 items 二选一）'),
    items: z.array(z.object({
      text: z.string().min(1).describe('该条消息文本'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('仅针对这条消息引用的消息 id（非零整数）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('仅针对这条消息在群内 @ 的 QQ 号'),
    })).min(1).optional().describe('需要为多条消息分别指定不同 replyToMessageId / atUserId 时使用，一次发完不必拆成多次工具调用'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中用于点名某个人；与引用二选一即可，不要滥用）'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto=桥接随机；fixed=固定间隔；byLength=按字数计算'),
    gapMs: z.number().optional().describe('fixed 模式下的统一间隔（毫秒）'),
    gaps: z.array(z.number()).optional().describe('fixed 模式下逐条间隔（长度=条数-1）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('发完顺带确认已读的水位（使用最近读取结果的 readThroughSeq），可省去额外调用 qq_mark_read'),
    afterAction: z.enum(['none', 'close', 'sleep']).optional().describe('可选发送后折叠动作：none=仅发送/确认已读（默认）；close=发送并自然收尾；sleep=发送后按 wakeConfig 设定下一次唤醒'),
    closeReason: z.enum(['natural', 'topic-done', 'explicit-end', 'busy', 'tired', 'other']).optional().describe('afterAction="close" 时的收尾原因'),
    closeSummary: z.string().max(500).optional().describe('afterAction="close" 时的收尾摘要（一句话）'),
    closeNextOpening: z.string().max(300).optional().describe('afterAction="close" 时下次可自然接入的开场（可选）'),
    wakeConfig: wakeConfigSchema.optional().describe('afterAction="sleep" 时要设置的唤醒配置，字段同 qq_set_wake_config.config'),
  },
  async ({
    key, token, messages, items, replyToMessageId, atUserId, gapMode, gapMs, gaps,
    throughSeq, afterAction, closeReason, closeSummary, closeNextOpening, wakeConfig,
  }) => {
    try {
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\\"你好\\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const hasItems = Array.isArray(items) && items.length > 0;
      const hasMessages = typeof finalMessages === 'string'
        ? finalMessages.trim().length > 0
        : (Array.isArray(finalMessages) && finalMessages.some((m) => String(m ?? '').trim().length > 0));
      if (!hasItems && !hasMessages) {
        return { content: [{ type: 'text', text: '发送失败：messages 和 items 至少提供一项非空内容' }], isError: true };
      }
      const data = await agentApi('/api/socialV2/send-message', {
        method: 'POST',
        body: JSON.stringify({
          key,
          ...(finalMessages !== undefined ? { messages: finalMessages } : {}),
          ...(hasItems ? { items } : {}),
          replyToMessageId,
          atUserId: atUserId ?? null,
          gapMode,
          gapMs,
          gaps,
          ...(throughSeq !== undefined ? { throughSeq } : {}),
          ...(afterAction !== undefined ? { afterAction } : {}),
          ...(closeReason !== undefined ? { closeReason } : {}),
          ...(closeSummary !== undefined ? { closeSummary } : {}),
          ...(closeNextOpening !== undefined ? { closeNextOpening } : {}),
          ...(wakeConfig !== undefined ? { wakeConfig } : {}),
        }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: \`发送失败：\${error?.message ?? error}\` }], isError: true };
    }
  }
);`,
    'mcp qq_send_message'
  );
  return text;
});

// 3. src/bridge.js
patchFile('/home/ubuntu/surfcore/src/bridge.js', (text) => {
  // Hunk 1: imports
  text = replaceExact(
    text,
    "import { proactiveProbability, proactiveDecision } from './proactive-policy.js';",
    `import { proactiveProbability, proactiveDecision } from './proactive-policy.js';
import { isAnalyticalToolName, coalesceSendItems } from './bubble-coalescer.js';
import { evaluateProactiveGate, computeProactiveDelayMs } from './proactive-gate.js';`,
    'bridge imports'
  );

  // Hunk 2: default send.coalesce + proactive.gate config
  text = replaceExact(
    text,
    `        gapBaseMs: 800,
        gapPerCharMs: 20,
        recommendedHint: '普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。'
      },`,
    `        gapBaseMs: 800,
        gapPerCharMs: 20,
        coalesce: {
          enabled: true,
          groupMaxMergedChars: 220,
          privateMaxMergedChars: 420,
          maxGroupRunItems: 3,
          maxPrivateRunItems: 5,
        },
        recommendedHint: '普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。'
      },`,
    'bridge send.coalesce defaults'
  );
  text = replaceExact(
    text,
    `      proactive: {
        enabled: true,
        checkIntervalMinMs: 30 * 60 * 1000,
        checkIntervalMaxMs: 90 * 60 * 1000,
        idleThresholdMs: 15 * 60 * 1000,
        probability: 0.3
      },`,
    `      proactive: {
        enabled: true,
        checkIntervalMinMs: 30 * 60 * 1000,
        checkIntervalMaxMs: 90 * 60 * 1000,
        idleThresholdMs: 15 * 60 * 1000,
        probability: 0.3,
        gate: {
          enabled: true,
          topicFollowupMinMs: 30 * 60 * 1000,
          topicFollowupMaxAgeMs: 24 * 60 * 60 * 1000,
          thoughtRecheckCooldownMs: 6 * 60 * 60 * 1000,
          awaitingMaxAgeMs: 24 * 60 * 60 * 1000,
          maxBackoffMs: 8 * 60 * 60 * 1000,
        },
      },`,
    'bridge proactive.gate defaults'
  );

  // Hunk 3: session/turn tracking sets
  text = replaceExact(
    text,
    `  const sendToolSucceededSessions = new Set(); // sessionId：当前 turn 内 MCP 发送类工具至少成功一次`,
    `  const sendToolSucceededSessions = new Set(); // sessionId：当前 turn 内 MCP 发送类工具至少成功一次
  const analyticalToolsUsedSessions = new Set(); // sessionId：当前 turn 内成功调用过搜索/读文件/查历史等分析型工具
  const pendingWakeMeta = new Map(); // sessionId -> { wakeReason, at, proactiveMeta }
  const turnWakeMeta = new Map(); // sessionId -> { wakeReason, at, proactiveMeta }`,
    'bridge session tracking sets'
  );

  // Hunk 4: prepareWakeConfigV2 + commitWakeConfigV2 + /api/socialV2/wake-config
  text = replaceExact(
    text,
    `        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake-config') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setWakeConfig')) { sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return; }
          const st = getSocialV2State(key);
          const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
          // Preserve the deployed behavior: with markRead disabled, update wake configuration only.
          const acknowledgeOnClose = throughSeq !== null && v2ToolEnabled('markRead');
          const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
          const current = st.wakeConfig;
          const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
          const normalizeTriggerBool = (name, fallback) => {
            if (name in inputTriggers) return inputTriggers[name] === true;
            return fallback;
          };
          const rawKeywords = inputTriggers.keywords;
          const nextKeywords = rawKeywords !== undefined
            ? (Array.isArray(rawKeywords)
                ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
                : [])
            : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
          const next = {
            ...current,
            mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
            infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
            sleepUntil: current.sleepUntil,
            triggers: {
              // 只带已知字段（见 WAKE_TRIGGER_KEYS 的说明）；未知键一律丢弃。
              ...pickWakeTriggersV2(inputTriggers, current.triggers),
              atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
              nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
              question: normalizeTriggerBool('question', current.triggers.question === true),
              anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
              poke: normalizeTriggerBool('poke', current.triggers.poke === true),
              keywords: nextKeywords
            },
            batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
              ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
              : current.batchWindowMs
          };
          // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
          if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
            next.triggers.anyMessage = false;
          }
          if (next.mode === 'active') {
            next.infinite = true;
            next.sleepUntil = null;
            next.triggers.anyMessage = true;
          }
          if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
          if (next.infinite) {
            next.sleepUntil = null;
          } else if (input.sleepUntil) {
            const d = new Date(String(input.sleepUntil));
            if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
          } else if (Number.isFinite(Number(input.sleepMs))) {
            let ms = Math.max(0, Math.round(Number(input.sleepMs)));
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            if (ms < minMs) ms = minMs;
            if (maxMs > 0 && ms > maxMs) ms = maxMs;
            next.sleepUntil = new Date(Date.now() + ms).toISOString();
          } else if (!next.sleepUntil && !next.infinite) {
            // 既没有无限也没有时间：使用推荐默认有限时长
            const recMin = Number(cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
            const recMax = Number(cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
            const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
            next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
          }
          // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
          if (!next.infinite && next.sleepUntil) {
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            let until = Date.parse(next.sleepUntil);
            if (Number.isFinite(until)) {
              if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
              if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
              next.sleepUntil = new Date(until).toISOString();
            }
          }
          // 归一化概率
          if (next.triggers.probability !== undefined) {
            next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
          }
          // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
          if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
            next.triggers.poke = input.triggers.poke === true;
          }
          // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
          // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
          next.triggers.speakerIds = normalizeSpeakerIdsV2(next.triggers.speakerIds);
          // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
          if (key.startsWith('private:')) {
            next.triggers.speakerIds = [];
          }
          // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
          if (next.infinite) {
            const tr = next.triggers ?? {};
            const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
            if (!hasTrigger) {
              sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
              return;
            }
          }
          // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
          if (isSleepingConfigV2(next) && preSleepWaitBlockedV2(st)) {
            const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: \`还不能立刻设置潜水/下一次唤醒：还需等待约 \${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=\${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。\`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          const markedCount = acknowledgeOnClose ? acknowledgeMessagesV2(st, throughSeq) : 0;
          st.wakeConfig = next;
          st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
          st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
          st.wakeConfig.noActionCount = 0;
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'set_wake_config';
          st.lastActionAt = Date.now();
          // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 5 分钟观察。
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          saveSocialV2State();
          wakeConfigUpdatedKeys.add(key);
          wakeConfigMissCount.delete(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
          setupSleepTimerV2(key);
          log(\`[reserved2] 更新唤醒配置 \${key}: mode=\${next.mode} infinite=\${next.infinite} sleepUntil=\${next.sleepUntil ?? 'null'}\`);
          sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: readThroughSeqV2(st), wakeConfig: next, wakeSafety: computeWakeSafetyV2(next) });
          return;
        }`,
    `        function prepareWakeConfigV2(key, st, rawInput, { checkPreSleepWait = true } = {}) {
          const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {};
          const current = st.wakeConfig;
          const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
          const normalizeTriggerBool = (name, fallback) => {
            if (name in inputTriggers) return inputTriggers[name] === true;
            return fallback;
          };
          const rawKeywords = inputTriggers.keywords;
          const nextKeywords = rawKeywords !== undefined
            ? (Array.isArray(rawKeywords)
                ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
                : [])
            : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
          const next = {
            ...current,
            mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
            infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
            sleepUntil: current.sleepUntil,
            triggers: {
              // 只带已知字段（见 WAKE_TRIGGER_KEYS 的说明）；未知键一律丢弃。
              ...pickWakeTriggersV2(inputTriggers, current.triggers),
              atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
              nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
              question: normalizeTriggerBool('question', current.triggers.question === true),
              anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
              poke: normalizeTriggerBool('poke', current.triggers.poke === true),
              keywords: nextKeywords
            },
            batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
              ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
              : current.batchWindowMs
          };
          // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
          if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
            next.triggers.anyMessage = false;
          }
          if (next.mode === 'active') {
            next.infinite = true;
            next.sleepUntil = null;
            next.triggers.anyMessage = true;
          }
          if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
          if (next.infinite) {
            next.sleepUntil = null;
          } else if (input.sleepUntil) {
            const d = new Date(String(input.sleepUntil));
            if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
          } else if (Number.isFinite(Number(input.sleepMs))) {
            let ms = Math.max(0, Math.round(Number(input.sleepMs)));
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            if (ms < minMs) ms = minMs;
            if (maxMs > 0 && ms > maxMs) ms = maxMs;
            next.sleepUntil = new Date(Date.now() + ms).toISOString();
          } else if (!next.sleepUntil && !next.infinite) {
            // 既没有无限也没有时间：使用推荐默认有限时长
            const recMin = Number(cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
            const recMax = Number(cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
            const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
            next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
          }
          // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
          if (!next.infinite && next.sleepUntil) {
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            let until = Date.parse(next.sleepUntil);
            if (Number.isFinite(until)) {
              if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
              if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
              next.sleepUntil = new Date(until).toISOString();
            }
          }
          // 归一化概率
          if (next.triggers.probability !== undefined) {
            next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
          }
          // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
          if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
            next.triggers.poke = input.triggers.poke === true;
          }
          // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
          // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
          next.triggers.speakerIds = normalizeSpeakerIdsV2(next.triggers.speakerIds);
          // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
          if (key.startsWith('private:')) {
            next.triggers.speakerIds = [];
          }
          // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
          if (next.infinite) {
            const tr = next.triggers ?? {};
            const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
            if (!hasTrigger) {
              return { ok: false, statusCode: 400, payload: { ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' } };
            }
          }
          // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
          if (checkPreSleepWait && isSleepingConfigV2(next) && preSleepWaitBlockedV2(st)) {
            const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            return {
              ok: false,
              statusCode: 400,
              payload: {
                ok: false,
                code: 'PRE_SLEEP_WAIT_REQUIRED',
                error: \`还不能立刻设置潜水/下一次唤醒：还需等待约 \${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=\${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。\`,
                preSleepWaitMs: preSleepMs,
                preSleepWaitRemainingMs: remaining,
              },
            };
          }
          return { ok: true, next };
        }
        function commitWakeConfigV2(key, st, next, { throughSeq = null, acknowledge = false } = {}) {
          const markedCount = acknowledge ? acknowledgeMessagesV2(st, throughSeq) : 0;
          st.wakeConfig = next;
          st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
          st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
          st.wakeConfig.noActionCount = 0;
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'set_wake_config';
          st.lastActionAt = Date.now();
          // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 5 分钟观察。
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          saveSocialV2State();
          wakeConfigUpdatedKeys.add(key);
          wakeConfigMissCount.delete(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
          setupSleepTimerV2(key);
          log(\`[reserved2] 更新唤醒配置 \${key}: mode=\${next.mode} infinite=\${next.infinite} sleepUntil=\${next.sleepUntil ?? 'null'}\`);
          return { ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: readThroughSeqV2(st), wakeConfig: next, wakeSafety: computeWakeSafetyV2(next) };
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake-config') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setWakeConfig')) { sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return; }
          const st = getSocialV2State(key);
          const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
          // Preserve the deployed behavior: with markRead disabled, update wake configuration only.
          const acknowledgeOnClose = throughSeq !== null && v2ToolEnabled('markRead');
          const prepared = prepareWakeConfigV2(key, st, body.config, { checkPreSleepWait: true });
          if (!prepared.ok) {
            sendJson(prepared.payload, prepared.statusCode);
            return;
          }
          const result = commitWakeConfigV2(key, st, prepared.next, { throughSeq, acknowledge: acknowledgeOnClose });
          sendJson(result);
          return;
        }`,
    'bridge wake-config helpers'
  );

  // Hunk 5: /api/socialV2/send-burst coalescing
  text = replaceExact(
    text,
    `          const st = getSocialV2State(key);
          const fishBlock = fishGuardSendBlock(key, st);
          if (fishBlock) { sendJson({ ok: false, ...fishBlock }, 403); return; }
          const tokenBlock = tokenGuardSendBlock(key, st, messages.length);
          if (tokenBlock) { sendJson({ ok: false, ...tokenBlock }, 429); return; }
          const now = Date.now();
          const sendCategory = sendCategoryV2(st);
          try {
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            const rateLimit = sendRateLimitInfo(key, st, sendCfg, messages.length, sendCategory);
            if (rateLimit) { reportLimitEvent(key, rateLimit); sendJson(rateLimit, 429); return; }
            // 先预占发送额度，避免并发绕过限频
            recordSendTimes(st, sendCategory, now, messages.length);
            const delays = computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
            const sentMessages = await sendMessagesV2(key, messages, delays);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(\`[reserved2] 工具分条发送 \${key}: 成功 \${sentMessages.length}/\${messages.length} 条\`);
            appendActivity(\`\${key} [reserved2] 工具分条发送：成功 \${sentMessages.length}/\${messages.length} 条\`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(\`[reserved2] 工具分条发送部分成功 \${error.sent.length}/\${messages.length} 条，已记录已发消息\`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            releaseSendTimes(st, sendCategory, now, failedCount);`,
    `          const coalCfg = sendCfg.coalesce ?? {};
          const sidBurst = state.sessions[key];
          const coalesceResult = coalesceSendItems(messages, {
            enabled: coalCfg.enabled !== false,
            scene: lastTurnScene.get(key) || 'daily',
            usedAnalyticalTool: Boolean(sidBurst && analyticalToolsUsedSessions.has(sidBurst)),
            isGroup: key.startsWith('group:'),
            maxMessageChars: maxChars,
            groupMaxMergedChars: coalCfg.groupMaxMergedChars,
            privateMaxMergedChars: coalCfg.privateMaxMergedChars,
            maxGroupRunItems: coalCfg.maxGroupRunItems,
            maxPrivateRunItems: coalCfg.maxPrivateRunItems,
            sharedFirstTarget: true,
          });
          const finalMessages = coalesceResult.items.map((it) => it.text);
          const st = getSocialV2State(key);
          const fishBlock = fishGuardSendBlock(key, st);
          if (fishBlock) { sendJson({ ok: false, ...fishBlock }, 403); return; }
          const tokenBlock = tokenGuardSendBlock(key, st, finalMessages.length);
          if (tokenBlock) { sendJson({ ok: false, ...tokenBlock }, 429); return; }
          const now = Date.now();
          const sendCategory = sendCategoryV2(st);
          try {
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            const rateLimit = sendRateLimitInfo(key, st, sendCfg, finalMessages.length, sendCategory);
            if (rateLimit) { reportLimitEvent(key, rateLimit); sendJson(rateLimit, 429); return; }
            // 先预占发送额度，避免并发绕过限频
            recordSendTimes(st, sendCategory, now, finalMessages.length);
            const delays = computeGapsV2(finalMessages, 'auto', undefined, undefined, sendCfg);
            const sentMessages = await sendMessagesV2(key, finalMessages, delays);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            if (coalesceResult.coalesced) {
              log(\`[reserved2] 气泡归并 \${key} (send-burst): \${coalesceResult.before} -> \${coalesceResult.after} 条 (\${coalesceResult.reasons.join(',')})\`);
            }
            log(\`[reserved2] 工具分条发送 \${key}: 成功 \${sentMessages.length}/\${finalMessages.length} 条\`);
            appendActivity(\`\${key} [reserved2] 工具分条发送：成功 \${sentMessages.length}/\${finalMessages.length} 条\`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            const burstHint = finalMessages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(finalMessages);
            const splitWarn = findSplitBoundaryWarning(finalMessages);
            sendJson({
              ok: true,
              key,
              sent: sentMessages.length,
              failed: finalMessages.length - sentMessages.length,
              ...(coalesceResult.coalesced ? { coalesced: { before: coalesceResult.before, after: coalesceResult.after, reasons: coalesceResult.reasons } } : {}),
              ...(burstHint ? { hint: burstHint } : {}),
              ...(spaceWarn ? { warn: spaceWarn } : {}),
              ...(splitWarn ? { splitWarn } : {}),
            });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(\`[reserved2] 工具分条发送部分成功 \${error.sent.length}/\${finalMessages.length} 条，已记录已发消息\`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, finalMessages.length - sentCount);
            releaseSendTimes(st, sendCategory, now, failedCount);`,
    'bridge send-burst coalescer'
  );

  // Hunk 6: /api/socialV2/send-message items + coalescer + protocol folding
  text = replaceExact(
    text,
    `        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\\"你好\\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const isRawString = typeof rawMessages === 'string';
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          // 二代不再按空格自动分条：字符串就是一条消息，数组模式原样使用调用方间隔。
          // 旧写法是 \`(isRawString && messages.length > 1) ? 'auto' : ...\` —— 上面 messages 的构造
          // 保证 isRawString 为真时 length 恒为 1，这个分支永远不可达，留着只会让人以为
          // "字符串多段时有特殊间隔策略"。
          const gapMode = (body.gapMode === 'fixed' || body.gapMode === 'byLength') ? body.gapMode : 'auto';
          const gapMs = Number(body.gapMs);
          const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMessage')) { sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) {
            sendJson({ ok: false, error: '私聊不需要 @' }, 400);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Number(sendCfg.burstMaxMessages) > 0 ? Math.round(Number(sendCfg.burstMaxMessages)) : Infinity;
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: \`最多发送 \${maxMsgs} 条\` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: \`单条消息不能超过 \${maxChars} 字；内容太长先总结/挑重点，不要拆成 20 条刷屏\` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              const block = sensitiveBlockInfo(msg, 'send-message');
              logSensitiveBlock(key, 'send-message', block.kind);
              sendJson({ ok: false, ...block }, 403);
              return;
            }
          }
          const delays = computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
          // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
          const st = getSocialV2State(key);
          const fishBlock = fishGuardSendBlock(key, st);
          if (fishBlock) { sendJson({ ok: false, ...fishBlock }, 403); return; }
          const tokenBlock = tokenGuardSendBlock(key, st, messages.length);
          if (tokenBlock) { sendJson({ ok: false, ...tokenBlock }, 429); return; }
          const now = Date.now();
          const sendCategory = sendCategoryV2(st);
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          const rateLimit = sendRateLimitInfo(key, st, sendCfg, messages.length, sendCategory);
          if (rateLimit) { reportLimitEvent(key, rateLimit); sendJson(rateLimit, 429); return; }
          // 先预占发送额度，避免并发绕过限频
          recordSendTimes(st, sendCategory, now, messages.length);
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const resolved = await resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              // 引用解析失败：回滚已预占的发送额度
              releaseSendTimes(st, sendCategory, now, messages.length);
              saveSocialV2State();
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          try {
            const sentMessages = await sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(\`[reserved2] 工具统一发送 \${key}: 成功 \${sentMessages.length}/\${messages.length} 条\`);
            appendActivity(\`\${key} [reserved2] 工具统一发送：成功 \${sentMessages.length}/\${messages.length} 条\`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(\`[reserved2] 工具统一发送部分成功 \${error.sent.length}/\${messages.length} 条，已记录已发消息\`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            releaseSendTimes(st, sendCategory, now, failedCount);`,
    `        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const hasRawItems = Array.isArray(body.items) && body.items.length > 0;
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\\"你好\\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const isRawString = typeof rawMessages === 'string';
          const legacyMessages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
          const topReplyToMessageId = body.replyToMessageId;
          const topAtUserId = body.atUserId ?? null;
          const inputItems = hasRawItems
            ? body.items
                .map((it) => {
                  if (!it || typeof it !== 'object') return null;
                  const text = String(it.text ?? '').trim();
                  if (!text) return null;
                  return {
                    text,
                    replyToMessageId: it.replyToMessageId ?? null,
                    atUserId: it.atUserId ?? null,
                  };
                })
                .filter(Boolean)
            : legacyMessages.map((text, idx) => ({
                text,
                replyToMessageId: idx === 0 ? (topReplyToMessageId ?? null) : null,
                atUserId: idx === 0 ? topAtUserId : null,
              }));
          // 二代不再按空格自动分条：字符串就是一条消息，数组/items 按元素分条。
          const gapMode = (body.gapMode === 'fixed' || body.gapMode === 'byLength') ? body.gapMode : 'auto';
          const gapMs = Number(body.gapMs);
          const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
          if (!key || !inputItems.length) {
            sendJson({ ok: false, error: 'key 和 messages/items 不能为空' }, 400);
            return;
          }
          const afterActionRaw = body.afterAction === undefined || body.afterAction === null
            ? 'none'
            : String(body.afterAction).trim();
          if (!['none', 'close', 'sleep'].includes(afterActionRaw)) {
            sendJson({ ok: false, error: 'afterAction 必须是 none、close 或 sleep' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && inputItems.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMessage')) { sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return; }
          if (req.headers['x-agent-token'] && afterActionRaw === 'close' && !v2ToolEnabled('closeConversation')) {
            sendJson({ ok: false, error: '工具未启用：qq_close_conversation' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && afterActionRaw === 'sleep' && !v2ToolEnabled('setWakeConfig')) {
            sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403);
            return;
          }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          for (const item of inputItems) {
            if (kind === 'private' && item.atUserId !== undefined && item.atUserId !== null && String(item.atUserId).trim() !== '') {
              sendJson({ ok: false, error: '私聊不需要 @' }, 400);
              return;
            }
            if (item.replyToMessageId !== undefined && item.replyToMessageId !== null && String(item.replyToMessageId).trim() !== '' && !/^-?[1-9]\\d*$/.test(String(item.replyToMessageId).trim())) {
              sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
              return;
            }
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Number(sendCfg.burstMaxMessages) > 0 ? Math.round(Number(sendCfg.burstMaxMessages)) : Infinity;
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (inputItems.length > maxMsgs) {
            sendJson({ ok: false, error: \`最多发送 \${maxMsgs} 条\` }, 400);
            return;
          }
          for (const item of inputItems) {
            const msg = item.text;
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: \`单条消息不能超过 \${maxChars} 字；内容太长先总结/挑重点，不要拆成 20 条刷屏\` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              const block = sensitiveBlockInfo(msg, 'send-message');
              logSensitiveBlock(key, 'send-message', block.kind);
              sendJson({ ok: false, ...block }, 403);
              return;
            }
          }
          const st = getSocialV2State(key);
          let validatedThroughSeq = null;
          if (body.throughSeq !== undefined && body.throughSeq !== null) {
            try {
              validatedThroughSeq = requestedReadThroughSeqV2(st, { throughSeq: body.throughSeq }, !!req.headers['x-agent-token']);
            } catch (seqErr) {
              sendJson({ ok: false, error: seqErr?.message ?? String(seqErr) }, Number(seqErr?.statusCode) || 400);
              return;
            }
          }
          let preparedWake = null;
          if (afterActionRaw === 'sleep') {
            if (!body.wakeConfig || typeof body.wakeConfig !== 'object' || Array.isArray(body.wakeConfig)) {
              sendJson({ ok: false, error: 'afterAction="sleep" 必须提供有效的 wakeConfig 对象' }, 400);
              return;
            }
            preparedWake = prepareWakeConfigV2(key, st, body.wakeConfig, { checkPreSleepWait: false });
            if (!preparedWake.ok) {
              sendJson(preparedWake.payload, preparedWake.statusCode);
              return;
            }
          }
          // Layer 2 气泡归并：在限流预占前合并因果/分析/正经场景的过度分泡，保留短应答、媒体标记和独立引用目标。
          const coalCfg = sendCfg.coalesce ?? {};
          const sidNow = state.sessions[key];
          const coalesceResult = coalesceSendItems(inputItems, {
            enabled: coalCfg.enabled !== false,
            scene: lastTurnScene.get(key) || 'daily',
            usedAnalyticalTool: Boolean(sidNow && analyticalToolsUsedSessions.has(sidNow)),
            isGroup: kind === 'group',
            maxMessageChars: maxChars,
            groupMaxMergedChars: coalCfg.groupMaxMergedChars,
            privateMaxMergedChars: coalCfg.privateMaxMergedChars,
            maxGroupRunItems: coalCfg.maxGroupRunItems,
            maxPrivateRunItems: coalCfg.maxPrivateRunItems,
            sharedFirstTarget: !hasRawItems,
          });
          const finalItems = coalesceResult.items;
          const finalMessages = finalItems.map((it) => it.text);
          const perItemTargets = finalItems.map((it) => ({
            replyToMessageId: it.replyToMessageId ?? null,
            atUserId: it.atUserId ?? null,
          }));
          const delays = computeGapsV2(finalMessages, gapMode, gapMs, gaps, sendCfg);
          // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
          const fishBlock = fishGuardSendBlock(key, st);
          if (fishBlock) { sendJson({ ok: false, ...fishBlock }, 403); return; }
          const tokenBlock = tokenGuardSendBlock(key, st, finalMessages.length);
          if (tokenBlock) { sendJson({ ok: false, ...tokenBlock }, 429); return; }
          const now = Date.now();
          const sendCategory = sendCategoryV2(st);
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          const rateLimit = sendRateLimitInfo(key, st, sendCfg, finalMessages.length, sendCategory);
          if (rateLimit) { reportLimitEvent(key, rateLimit); sendJson(rateLimit, 429); return; }
          // 先预占发送额度，避免并发绕过限频
          recordSendTimes(st, sendCategory, now, finalMessages.length);
          let quotedInfo = null;
          const resolvedReplyCache = new Map();
          for (const target of perItemTargets) {
            const rawReply = target.replyToMessageId;
            if (rawReply !== undefined && rawReply !== null && String(rawReply).trim() !== '') {
              const replyKey = String(rawReply).trim();
              let resolved = resolvedReplyCache.get(replyKey);
              if (!resolved) {
                resolved = await resolveReplyTargetV2(st, kind, id, replyKey);
                if (!resolved) {
                  // 引用解析失败：回滚已预占的发送额度
                  releaseSendTimes(st, sendCategory, now, finalMessages.length);
                  saveSocialV2State();
                  sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
                  return;
                }
                resolvedReplyCache.set(replyKey, resolved);
              }
              if (!quotedInfo) quotedInfo = resolved.info;
              target.replyToMessageId = resolved.messageId;
            } else {
              target.replyToMessageId = null;
            }
          }
          try {
            const sentMessages = await sendMessagesV2(
              key,
              finalMessages,
              delays,
              perItemTargets[0]?.replyToMessageId ?? null,
              perItemTargets[0]?.atUserId ?? null,
              { perItemTargets }
            );
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            if (coalesceResult.coalesced) {
              log(\`[reserved2] 气泡归并 \${key}: \${coalesceResult.before} -> \${coalesceResult.after} 条 (\${coalesceResult.reasons.join(',')})\`);
            }
            const afterMeta = { afterAction: afterActionRaw };
            let replyCheckSuppressed = false;
            let markReadMarkedCount;
            if (afterActionRaw === 'close') {
              try {
                const closeRes = closeConversationV2(key, {
                  ...(validatedThroughSeq !== null ? { throughSeq: validatedThroughSeq } : {}),
                  ...(body.closeReason !== undefined ? { reason: body.closeReason } : {}),
                  ...(body.closeSummary !== undefined ? { summary: body.closeSummary } : {}),
                  ...(body.closeNextOpening !== undefined ? { nextOpening: body.closeNextOpening } : {}),
                });
                if (closeRes?.blocked) {
                  afterMeta.afterActionApplied = false;
                  afterMeta.afterActionCode = String(closeRes.code || 'ALREADY_CLOSED');
                  afterMeta.afterActionError = String(closeRes.note || closeRes.error || '会话已处于收尾状态');
                } else {
                  afterMeta.afterActionApplied = true;
                  afterMeta.closedAt = closeRes.closedAt;
                  afterMeta.cooldownUntil = closeRes.cooldownUntil;
                  afterMeta.markedCount = closeRes.markedCount;
                  afterMeta.unreadCount = closeRes.unreadCount;
                  replyCheckSuppressed = true;
                }
              } catch (closeErr) {
                afterMeta.afterActionApplied = false;
                afterMeta.afterActionCode = String(closeErr?.code || 'CLOSE_REJECTED');
                afterMeta.afterActionError = String(closeErr?.message ?? closeErr);
              }
            } else if (afterActionRaw === 'sleep') {
              if (isSleepingConfigV2(preparedWake.next) && preSleepWaitBlockedV2(st)) {
                const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
                const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
                const remainMin = Math.ceil(remaining / 60000);
                afterMeta.afterActionApplied = false;
                afterMeta.afterActionCode = 'PRE_SLEEP_WAIT_REQUIRED';
                afterMeta.afterActionError = \`消息已发送，但暂不能设置潜水：还需等待约 \${remainMin} 分钟无新消息或调用 qq_wait_for_messages(timeoutMs=\${preSleepMs})\`;
                afterMeta.preSleepWaitMs = preSleepMs;
                afterMeta.preSleepWaitRemainingMs = remaining;
              } else {
                const wakeRes = commitWakeConfigV2(key, st, preparedWake.next, {
                  throughSeq: validatedThroughSeq,
                  acknowledge: validatedThroughSeq !== null && v2ToolEnabled('markRead'),
                });
                afterMeta.afterActionApplied = true;
                afterMeta.markedCount = wakeRes.markedCount;
                afterMeta.unreadCount = wakeRes.unreadCount;
                afterMeta.wakeConfig = wakeRes.wakeConfig;
                afterMeta.wakeSafety = wakeRes.wakeSafety;
                replyCheckSuppressed = true;
              }
            } else if (validatedThroughSeq !== null && v2ToolEnabled('markRead')) {
              markReadMarkedCount = acknowledgeMessagesV2(st, validatedThroughSeq);
              if (!isSleepingConfigV2(st.wakeConfig) || !preSleepWaitBlockedV2(st)) {
                if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) st.wakeConfig.infinite = true;
                ensureWakeableV2(st, { key });
                st.wakeConfig.confirmedAt = Date.now();
                st.wakeConfig.confirmedBy = 'mark_read';
                markReadCalledKeys.add(key);
              }
              afterMeta.afterActionApplied = true;
              afterMeta.markedCount = markReadMarkedCount;
              afterMeta.unreadCount = st.unread.length;
              afterMeta.readThroughSeq = readThroughSeqV2(st);
            }
            saveSocialV2State();
            log(\`[reserved2] 工具统一发送 \${key}: 成功 \${sentMessages.length}/\${finalMessages.length} 条\`);
            appendActivity(\`\${key} [reserved2] 工具统一发送：成功 \${sentMessages.length}/\${finalMessages.length} 条\`);
            if (sentMessages.length > 0 && !replyCheckSuppressed) scheduleReplyCheckV2(key);
            const burstHint = finalMessages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(finalMessages);
            const splitWarn = findSplitBoundaryWarning(finalMessages);
            sendJson({
              ok: true,
              key,
              sent: sentMessages.length,
              failed: finalMessages.length - sentMessages.length,
              delays,
              quoted: quotedInfo,
              ...(coalesceResult.coalesced ? { coalesced: { before: coalesceResult.before, after: coalesceResult.after, reasons: coalesceResult.reasons } } : {}),
              ...afterMeta,
              ...(burstHint ? { hint: burstHint } : {}),
              ...(spaceWarn ? { warn: spaceWarn } : {}),
              ...(splitWarn ? { splitWarn } : {}),
            });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(\`[reserved2] 工具统一发送部分成功 \${error.sent.length}/\${finalMessages.length} 条，已记录已发消息\`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, finalMessages.length - sentCount);
            releaseSendTimes(st, sendCategory, now, failedCount);`,
    'bridge send-message items/coalescer/afterAction'
  );

  // Hunk 7: sendMessagesV2 perItemTargets
  text = replaceExact(
    text,
    `      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;`,
    `      const perTarget = Array.isArray(options.perItemTargets) ? options.perItemTargets[i] : null;
      const useReply = perTarget
        ? (perTarget.replyToMessageId ?? null)
        : (i === 0 ? replyToMessageId : null);
      const useAt = perTarget
        ? (perTarget.atUserId ?? null)
        : (i === 0 ? atUserId : null);`,
    'bridge sendMessagesV2 perItemTargets'
  );

  // Hunk 8: preSleepWaitBlockedV2 proactiveCheck empty bypass
  text = replaceExact(
    text,
    `  function preSleepWaitBlockedV2(st) {
    if (!st) return false;
    const w = cfg.socialV2?.wake ?? {};
    if (w.preSleepWaitEnabled === false) return false;
    if (hasExplicitEndV2(st)) return false;`,
    `  function preSleepWaitBlockedV2(st) {
    if (!st) return false;
    const w = cfg.socialV2?.wake ?? {};
    if (w.preSleepWaitEnabled === false) return false;
    if (hasExplicitEndV2(st)) return false;
    // 无未读且未发言的主动机会（proactiveCheck）唤醒不应被 5 分钟睡眠观察窗口反锁。
    if (String(st.lastWakeReason || '').split(':')[0] === 'proactiveCheck'
        && (!Array.isArray(st.unread) || st.unread.length === 0)
        && Number(st.lastAiReplyAt || 0) < Number(st.wakeConfig?.lastWakeAt || 0)) {
      return false;
    }`,
    'bridge preSleepWaitBlockedV2 proactive bypass'
  );

  // Hunk 9: getSocialV2State / loadSocialV2State / saveSocialV2State proactive fields
  text = replaceExact(
    text,
    `        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,`,
    `        lastProactiveWakeAt: 0,
        lastProactiveSentAt: 0,
        lastProactiveSilentAt: 0,
        proactiveSilentStreak: 0,
        proactiveTimerBackedOff: false,
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,`,
    'bridge getSocialV2State proactive fields'
  );
  text = replaceExact(
    text,
    `            preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
            preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,`,
    `            lastProactiveWakeAt: Number(val.lastProactiveWakeAt) || 0,
            lastProactiveSentAt: Number(val.lastProactiveSentAt) || 0,
            lastProactiveSilentAt: Number(val.lastProactiveSilentAt) || 0,
            proactiveSilentStreak: Number(val.proactiveSilentStreak) || 0,
            proactiveTimerBackedOff: false,
            preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
            preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,`,
    'bridge loadSocialV2State proactive fields'
  );
  text = replaceExact(
    text,
    `          preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
          preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,`,
    `          lastProactiveWakeAt: st.lastProactiveWakeAt || 0,
          lastProactiveSentAt: st.lastProactiveSentAt || 0,
          lastProactiveSilentAt: st.lastProactiveSilentAt || 0,
          proactiveSilentStreak: st.proactiveSilentStreak || 0,
          preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
          preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,`,
    'bridge saveSocialV2State proactive fields'
  );

  // Hunk 10: deliverPromptNow wakeMeta + acceptance stamping
  text = replaceExact(
    text,
    `      telemetryWakeSeq += 1;
      const telemetryWakeId = \`w_\${Date.now()}_\${telemetryWakeSeq}\`;
      sessionWakeIds.set(sessionId, telemetryWakeId);
      sessionWakePendingAt.set(sessionId, Date.now());`,
    `      telemetryWakeSeq += 1;
      const telemetryWakeId = \`w_\${Date.now()}_\${telemetryWakeSeq}\`;
      sessionWakeIds.set(sessionId, telemetryWakeId);
      sessionWakePendingAt.set(sessionId, Date.now());
      pendingWakeMeta.set(sessionId, {
        wakeReason: String(opts.wakeReason),
        at: Date.now(),
        proactiveMeta: opts.proactiveMeta || null,
      });`,
    'bridge deliverPromptNow pendingWakeMeta'
  );
  text = replaceExact(
    text,
    `    // 版本升级提示同理：只有主人这次真的收到唤醒，才算“提过了”，不重复讲。
    if (opts.wakeReason) markShownVersionAnnounce(key);`,
    `    // 版本升级提示同理：只有主人这次真的收到唤醒，才算“提过了”，不重复讲。
    if (opts.wakeReason) markShownVersionAnnounce(key);
    if (String(opts.wakeReason || '').split(':')[0] === 'proactiveCheck') {
      try {
        const stPro = getSocialV2State(key);
        const ackNow = Date.now();
        stPro.lastProactiveWakeAt = ackNow;
        const pMeta = opts.proactiveMeta;
        if (pMeta && Array.isArray(pMeta.triggeredTopicIndices) && Array.isArray(stPro.activeTopics)) {
          for (const idx of pMeta.triggeredTopicIndices) {
            if (stPro.activeTopics[idx] && typeof stPro.activeTopics[idx] === 'object') {
              stPro.activeTopics[idx].followedUpAt = ackNow;
            }
          }
        }
        if (pMeta && Array.isArray(pMeta.triggeredThoughtIndices) && Array.isArray(stPro.pendingThoughts)) {
          for (const idx of pMeta.triggeredThoughtIndices) {
            if (stPro.pendingThoughts[idx] && typeof stPro.pendingThoughts[idx] === 'object') {
              stPro.pendingThoughts[idx].lastProactiveCheckedAt = ackNow;
            }
          }
        }
        saveSocialV2State();
      } catch {}
    }`,
    'bridge deliverPromptNow proactiveCheck accepted stamp'
  );

  // Inbound unlock + streak reset in appendSocialV2Message, appendSocialV2File, appendSocialV2Poke
  text = replaceExact(
    text,
    `    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0; // 有新消息进来，之前的“沉睡前已等待/已观察”作废`,
    `    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.proactiveSilentStreak = 0;
    if (st.proactiveTimerBackedOff) {
      st.proactiveTimerBackedOff = false;
      if (st.proactiveTimer) {
        clearTimeout(st.proactiveTimer);
        st.proactiveTimer = null;
      }
      scheduleProactiveCheckV2(key, { quiet: true });
    }
    st.preSleepWaitSatisfiedAt = 0; // 有新消息进来，之前的“沉睡前已等待/已观察”作废`,
    'bridge appendSocialV2Message proactive unlock'
  );
  text = replaceExact(
    text,
    `    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    recordMessageHistory({
      conversationKey: key,
      sessionId: state.sessions[key] || null,
      direction: 'in',
      status: 'received',
      messageId: null,
      seq: msg.seq,
      senderId: msg.userId,
      senderName: actor,
      isOwner: msg.isOwner,
      isSelf: false,
      messageKind: 'file',`,
    `    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.proactiveSilentStreak = 0;
    if (st.proactiveTimerBackedOff) {
      st.proactiveTimerBackedOff = false;
      if (st.proactiveTimer) {
        clearTimeout(st.proactiveTimer);
        st.proactiveTimer = null;
      }
      scheduleProactiveCheckV2(key, { quiet: true });
    }
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    recordMessageHistory({
      conversationKey: key,
      sessionId: state.sessions[key] || null,
      direction: 'in',
      status: 'received',
      messageId: null,
      seq: msg.seq,
      senderId: msg.userId,
      senderName: actor,
      isOwner: msg.isOwner,
      isSelf: false,
      messageKind: 'file',`,
    'bridge appendSocialV2File proactive unlock'
  );
  text = replaceExact(
    text,
    `    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    recordMessageHistory({
      conversationKey: key,
      sessionId: state.sessions[key] || null,
      direction: 'in',
      status: 'received',
      messageId: null,
      seq: msg.seq,
      senderId: msg.userId,
      senderName: actor,
      isOwner: msg.isOwner,
      isSelf: false,
      messageKind: 'poke',`,
    `    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.proactiveSilentStreak = 0;
    if (st.proactiveTimerBackedOff) {
      st.proactiveTimerBackedOff = false;
      if (st.proactiveTimer) {
        clearTimeout(st.proactiveTimer);
        st.proactiveTimer = null;
      }
      scheduleProactiveCheckV2(key, { quiet: true });
    }
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    recordMessageHistory({
      conversationKey: key,
      sessionId: state.sessions[key] || null,
      direction: 'in',
      status: 'received',
      messageId: null,
      seq: msg.seq,
      senderId: msg.userId,
      senderName: actor,
      isOwner: msg.isOwner,
      isSelf: false,
      messageKind: 'poke',`,
    'bridge appendSocialV2Poke proactive unlock'
  );

  // recordSentMessagesV2 proactive lock tracking
  text = replaceExact(
    text,
    `    // AI 实际发言/参与了，说明这轮选择“继续回复”，沉睡前观察状态作废；下次想睡需重新走 5 分钟等待。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    saveSocialV2State();`,
    `    // 若是在 proactiveCheck 主动唤醒且未收到对方新消息期间发出了消息，锁定直到对方回复（"对方没回就停敲"）。
    if (list.length > 0
        && String(st.lastWakeReason || '').split(':')[0] === 'proactiveCheck'
        && Number(st.lastProactiveWakeAt || 0) > 0
        && now - Number(st.lastProactiveWakeAt) <= 15 * 60 * 1000
        && Number(st.lastProactiveWakeAt) >= Number(st.lastIncomingAt || 0)) {
      st.lastProactiveSentAt = now;
      st.proactiveSilentStreak = 0;
    }
    // AI 实际发言/参与了，说明这轮选择“继续回复”，沉睡前观察状态作废；下次想睡需重新走 5 分钟等待。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    saveSocialV2State();`,
    'bridge recordSentMessagesV2 proactive lock'
  );

  // Hunk 11: buildWakePromptV2 proactiveCheck prompt + sendWakePromptV2 + scheduleProactiveCheckV2
  text = replaceExact(
    text,
    `    if (reason === 'proactiveCheck') {
      return \`\${base}【主动机会】\${key}\\n原因：群里已经安静了一段时间，这是一次你可以主动冒泡的机会。\\n优先主动开个话题、追问上次没聊完的事、分享一个刚想到的想法；如果一时想不到，可以用 mcp__web-search-safe__web_search 搜一下当前热点/时事/网络热梗，再结合记忆里的群友兴趣挑一个自然角度。只要内容自然，就大胆开口；如果实在没话想说，再安静收尾（qq_mark_read 或 qq_set_wake_config）。\`;
    }`,
    `    if (reason === 'proactiveCheck') {
      return \`\${base}【主动机会】\${key}\\n原因：触发了主动冒泡条件。\\n如果有待办承诺、悬而未决的话题，或对方刚才沉默前留下了线索，就顺着那条线自然接一句；如果是冷场后想随便聊一句，选一个你真正在意、贴合这段对话氛围的小角度直接开口。\\n不需要为了凑热闹而去搜索热点或强行寒暄；如果看了上下文觉得此刻确实没什么可说，保持沉默即可，不需要多余客套或强制收尾。\`;
    }`,
    'bridge buildWakePromptV2 proactiveCheck prompt'
  );

  text = replaceExact(
    text,
    `      const result = await deliverPrompt(key, promptText, {
        wakeReason: reason,
        ...(wakeOpts?.pacing ? { pacing: wakeOpts.pacing } : {}),
      });`,
    `      const result = await deliverPrompt(key, promptText, {
        wakeReason: reason,
        ...(wakeOpts?.pacing ? { pacing: wakeOpts.pacing } : {}),
        ...(wakeOpts?.proactiveMeta ? { proactiveMeta: wakeOpts.proactiveMeta } : {}),
      });`,
    'bridge sendWakePromptV2 forward proactiveMeta'
  );

  text = replaceExact(
    text,
    `  function scheduleProactiveCheckV2(key) {
    // Denia 2.4：先合并该群的覆盖配置（概率/冷却/空闲阈值/活跃时段/黑白名单）。
    const p = proactiveConfigFor(cfg, key);
    if (!p.enabled || !proactiveGroupAllowed(p, key)) return;
    if (cfg.socialV2?.proactive?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    // 2.2：配置为自主目标的会话由自主引擎统一决策，不再叠一层随机主动机会。
    // 否则两个定时器各自按概率唤醒，配额看起来没超，实际发言频率翻倍。
    {
      const ac = autonomousConfigLive();
      if (ac.suppressLegacyProactive && isAutonomousTarget(key, {
        cfg: ac, allow: autonomousAllow(), control: autonomousStore.control(),
      })) {
        log(\`[2.2] \${key} 由自主引擎接管，跳过旧的随机主动机会\`);
        return;
      }
    }
    const st = getSocialV2State(key);
    if (Number(st.wakeSuspendedUntil) > Date.now()) return;
    if (!qqSendChannelStatus().ok) return;
    if (st.proactiveTimer) return;
    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    const delay = Math.floor(min + Math.random() * (max - min));
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;
      ensureWakeableV2(st, { key });
      // 不在该群允许主动的时段：不唤醒，直接按原节奏重排。
      if (!inActiveHours(p.activeHours, new Date())) {
        log(\`[proactive] \${key} 不在活跃时段，跳过本次主动机会\`);
        scheduleProactiveCheckV2(key);
        return;
      }
      // 刚自然收尾：这一次主动机会先不发，等冷却过去再按原节奏重排。
      if (closureSuppressesWake(st.closure, 'proactiveCheck', Date.now())) {
        log(\`[收尾] \${key} 冷却中，跳过本次主动机会\`);
        scheduleProactiveCheckV2(key);
        return;
      }
      const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
      const idle = Date.now() - (st.lastIncomingAt || 0);
      if (st.lastIncomingAt > 0 && idle >= 45 * 60 * 1000) {
        try { emotionStore?.recordAction?.({ kind: 'solitude', idleMs: idle }); } catch {}
      }
      const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).length : 0;
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
      // 公式抽到 src/proactive-policy.js（纯函数：输入是标量 + 情绪值 + 配置，
      // 不读全局 / 不读时钟 / 不取随机）。抽取前后 20 组固定输入必须逐位相同。
      const { prob } = proactiveProbability({
        probBase: p.probability,
        pendingThoughts,
        aiRepliedWithin30Min: Boolean(st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000),
        hour: new Date().getHours(),
        aiCountLastHour: aiCount,
      }, emotionStore?.values?.() ?? null, cfg.emotionState ?? {});
      // 每群冷却：即使概率抽中也先看上次主动是否太近。
      const cooldown = Number(p.cooldownMs) || 0;
      const sinceProactive = st.lastProactiveWakeAt ? Date.now() - Number(st.lastProactiveWakeAt) : Infinity;
      const draw = Math.random();
      // 顺序保持抽取前一致：先判空闲/冷却，再抽签，最后才查会话忙。
      if (proactiveDecision({
        draw,
        prob,
        idleMs: idle,
        idleThresholdMs: idleThreshold,
        sinceProactiveMs: sinceProactive,
        cooldownMs: cooldown,
        busy: idle >= idleThreshold && sinceProactive >= cooldown ? isConversationBusyV2(key, st) : false,
      })) {
        st.lastProactiveWakeAt = Date.now();
        void sendWakePromptV2(key, 'proactiveCheck').catch((error) => log(\`[reserved2] proactive 唤醒异常 \${key}:\`, error?.message ?? error));
      }
      scheduleProactiveCheckV2(key);
    }, delay);
    st.proactiveTimer.unref?.();
    log(\`[reserved2] 已安排主动机会检查 \${key}，约 \${Math.round(delay / 60000)}min 后\`);
  }`,
    `  function scheduleProactiveCheckV2(key, { quiet = false } = {}) {
    // Denia 2.4：先合并该群的覆盖配置（概率/冷却/空闲阈值/活跃时段/黑白名单）。
    const p = proactiveConfigFor(cfg, key);
    if (!p.enabled || !proactiveGroupAllowed(p, key)) return;
    if (cfg.socialV2?.proactive?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    // 2.2：配置为自主目标的会话由自主引擎统一决策，不再叠一层随机主动机会。
    // 否则两个定时器各自按概率唤醒，配额看起来没超，实际发言频率翻倍。
    {
      const ac = autonomousConfigLive();
      if (ac.suppressLegacyProactive && isAutonomousTarget(key, {
        cfg: ac, allow: autonomousAllow(), control: autonomousStore.control(),
      })) {
        log(\`[2.2] \${key} 由自主引擎接管，跳过旧的随机主动机会\`);
        return;
      }
    }
    const st = getSocialV2State(key);
    if (Number(st.wakeSuspendedUntil) > Date.now()) return;
    if (!qqSendChannelStatus().ok) return;
    if (st.proactiveTimer) return;
    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    const gateCfg = cfg.socialV2?.proactive?.gate ?? {};
    const gateEnabled = gateCfg.enabled !== false;
    const noReplyLocked = Boolean((st.lastProactiveSentAt || 0) > 0 && st.lastProactiveSentAt >= (st.lastIncomingAt || 0));
    const silentStreak = Math.max(0, Number(st.proactiveSilentStreak) || 0);
    const delay = gateEnabled
      ? computeProactiveDelayMs({
          minMs: min,
          maxMs: max,
          silentStreak,
          noReplyLocked,
          maxBackoffMs: gateCfg.maxBackoffMs,
          rand: Math.random(),
        })
      : Math.floor(min + Math.random() * (max - min));
    st.proactiveTimerBackedOff = gateEnabled && (noReplyLocked || silentStreak > 0);
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;
      ensureWakeableV2(st, { key });
      const now = Date.now();
      const activeOk = inActiveHours(p.activeHours, new Date(now));
      // 不在该群允许主动的时段：不唤醒，直接重排。
      if (!activeOk) {
        if (!gateEnabled) log(\`[proactive] \${key} 不在活跃时段，跳过本次主动机会\`);
        scheduleProactiveCheckV2(key, { quiet: gateEnabled });
        return;
      }
      // 刚自然收尾：先看是否有未到期以外的具体触发；纯闲逛与重开前的冒泡静默重排。
      if (closureSuppressesWake(st.closure, 'proactiveCheck', now)) {
        if (!gateEnabled) log(\`[收尾] \${key} 冷却中，跳过本次主动机会\`);
        scheduleProactiveCheckV2(key, { quiet: gateEnabled });
        return;
      }
      const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
      const idle = st.lastIncomingAt > 0 ? now - st.lastIncomingAt : 0;
      if (st.lastIncomingAt > 0 && idle >= 45 * 60 * 1000) {
        try { emotionStore?.recordAction?.({ kind: 'solitude', idleMs: idle }); } catch {}
      }
      const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || now < Number(t.expiresAt))).length : 0;
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const aiCount = recent.filter((m) => m && m.isSelf && now - Number(m.time || 0) < 60 * 60 * 1000).length;
      // 公式抽到 src/proactive-policy.js（纯函数：输入是标量 + 情绪值 + 配置，
      // 不读全局 / 不读时钟 / 不取随机）。抽取前后 20 组固定输入必须逐位相同。
      const { prob } = proactiveProbability({
        probBase: p.probability,
        pendingThoughts,
        aiRepliedWithin30Min: Boolean(st.lastAiReplyAt && now - Number(st.lastAiReplyAt) < 30 * 60 * 1000),
        hour: new Date(now).getHours(),
        aiCountLastHour: aiCount,
      }, emotionStore?.values?.() ?? null, cfg.emotionState ?? {});
      const draw = Math.random();
      if (gateEnabled) {
        let activeCommitments = [];
        try { activeCommitments = commitmentLedger?.active?.(key) ?? []; } catch {}
        const gate = evaluateProactiveGate({
          st,
          now,
          commitments: activeCommitments,
          cfgProactive: p,
          gateCfg,
          activeHoursOk: activeOk,
          busy: isConversationBusyV2(key, st),
          prob,
          draw,
        });
        if (!gate.allow) {
          if (gate.kind === 'backoff') {
            st.lastProactiveSilentAt = now;
            st.proactiveSilentStreak = Math.min(6, Math.max(1, (Number(st.proactiveSilentStreak) || 0) + 1));
            saveSocialV2State();
          }
          // 跳过/停敲/退避静默重排（Zero log noise）
          scheduleProactiveCheckV2(key, { quiet: true });
          return;
        }
        void sendWakePromptV2(key, 'proactiveCheck', {
          proactiveMeta: {
            kind: gate.kind,
            reason: gate.reason,
            reasons: gate.reasons,
            triggeredTopicIndices: gate.triggeredTopicIndices,
            triggeredThoughtIndices: gate.triggeredThoughtIndices,
          },
        }).catch((error) => log(\`[reserved2] proactive 唤醒异常 \${key}:\`, error?.message ?? error));
        scheduleProactiveCheckV2(key, { quiet: true });
        return;
      }
      // 每群冷却：旧开关关闭 gate 时保留原行为。
      const cooldown = Number(p.cooldownMs) || 0;
      const sinceProactive = st.lastProactiveWakeAt ? now - Number(st.lastProactiveWakeAt) : Infinity;
      if (proactiveDecision({
        draw,
        prob,
        idleMs: st.lastIncomingAt > 0 ? idle : now,
        idleThresholdMs: idleThreshold,
        sinceProactiveMs: sinceProactive,
        cooldownMs: cooldown,
        busy: (st.lastIncomingAt > 0 ? idle : now) >= idleThreshold && sinceProactive >= cooldown ? isConversationBusyV2(key, st) : false,
      })) {
        st.lastProactiveWakeAt = now;
        void sendWakePromptV2(key, 'proactiveCheck').catch((error) => log(\`[reserved2] proactive 唤醒异常 \${key}:\`, error?.message ?? error));
      }
      scheduleProactiveCheckV2(key);
    }, delay);
    st.proactiveTimer.unref?.();
    if (!quiet && !st.proactiveTimerBackedOff) {
      log(\`[reserved2] 已安排主动机会检查 \${key}，约 \${Math.round(delay / 60000)}min 后\`);
    }
  }`,
    'bridge scheduleProactiveCheckV2 gate + backoff'
  );

  // Hunk 12: events loop (turn/start, tool/result analytical, turn/end silent proactive handling, finally cleanup)
  text = replaceExact(
    text,
    `            if (frame.event.type === 'turn/start') {
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              v2TurnStartAt.set(frame.sessionId, Date.now());
              turnLeaseNoted.delete(frame.sessionId);
            }`,
    `            if (frame.event.type === 'turn/start') {
              sendToolSucceededSessions.delete(frame.sessionId);
              analyticalToolsUsedSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              v2TurnStartAt.set(frame.sessionId, Date.now());
              turnLeaseNoted.delete(frame.sessionId);
              const pendingMeta = pendingWakeMeta.get(frame.sessionId);
              pendingWakeMeta.delete(frame.sessionId);
              if (pendingMeta && Date.now() - Number(pendingMeta.at || 0) <= 600_000) {
                turnWakeMeta.set(frame.sessionId, pendingMeta);
              } else {
                turnWakeMeta.delete(frame.sessionId);
              }
            }`,
    'bridge events turn/start tracking'
  );

  text = replaceExact(
    text,
    `                  if (!resultError) {
                    sendToolSucceededSessions.add(frame.sessionId);
                  }
                }
              }
            }`,
    `                  if (!resultError) {
                    sendToolSucceededSessions.add(frame.sessionId);
                  }
                }
              }
              if (toolName && !resultError && isAnalyticalToolName(toolName)) {
                analyticalToolsUsedSessions.add(frame.sessionId);
              }
            }`,
    'bridge events tool/result analytical tracking'
  );

  text = replaceExact(
    text,
    `            if (ended) {
              // reserved2 无行动兜底：普通唤醒回合若既没发消息、也没 mark_read / set_wake_config，
              // 则累计 noActionCount；达到阈值后自动重置 WakeConfig，避免 AI 卡死。
              const silentQueueNow = social.silentTurns.get(frame.sessionId) ?? [];
              const isSilentTurn = silentQueueNow.length > 0;
              if (currentMode === 'reserved2' && key && !isSilentTurn) {
                const st = getSocialV2State(key);
                const turnStart = v2TurnStartAt.get(frame.sessionId) ?? 0;
                const sendToolHit = sendToolSucceededSessions.has(frame.sessionId);
                // turn/start 丢了（重连后由快照补发的回合）就无从判断「这一轮有没有行动」：
                // 此时记 miss 会冤枉 AI，连续 3 次就把 AI 自己设的唤醒配置重置成默认值。
                if (turnStart > 0 || sendToolHit) {
                  const actionTaken = sendToolHit || (turnStart > 0 && st.lastActionAt >= turnStart);
                  if (actionTaken) {
                    st.wakeConfig.noActionCount = 0;
                  } else {
                    st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
                    const limit = Number(cfg.socialV2?.wake?.noActionLimit) || 3;
                    if (st.wakeConfig.noActionCount >= limit) {
                      log(\`[reserved2] \${key} 连续 \${st.wakeConfig.noActionCount} 次唤醒无行动，重置唤醒配置\`);
                      resetWakeConfigV2(st);
                      st.bootstrapSent = true;
                      st.wakeConfig.noActionCount = 0;
                    }
                  }
                  saveSocialV2State();
                } else {
                  log(\`[reserved2] \${key} 回合结束但缺少 turn/start（重连补发），跳过无行动计数\`);
                }
              }
              v2TurnStartAt.delete(frame.sessionId);
              collectors.delete(frame.sessionId);
              turnLeaseNoted.delete(frame.sessionId);
              const sendToolSucceeded = sendToolSucceededSessions.has(frame.sessionId);
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              toolCallNames.delete(frame.sessionId);
              // 目的机制：先把「这一枪到底发没发 / 她写了什么目的」记下来，再走正常收尾。
              try { notePurposeTurnEnded(frame.sessionId, ended, sendToolSucceeded); } catch (error) {
                log(\`[目的] 回合回执异常：\${error?.message ?? error}\`);
              }
              // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
              const isFarewell = social.exitingSessions.has(frame.sessionId);
              if (isFarewell) social.exitingSessions.delete(frame.sessionId);
              // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
              // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
              const silentQueue = social.silentTurns.get(frame.sessionId) ?? [];
              const silentNow = Date.now();
              while (silentQueue.length && silentNow - silentQueue[0].ts > SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
              if (silentQueue.length > 0) {
                silentQueue.shift();
                if (silentQueue.length > 0) social.silentTurns.set(frame.sessionId, silentQueue);
                else social.silentTurns.delete(frame.sessionId);
                log(\`摘要投喂 turn 结束，静默 (\${key})\`);
                continue;
              }
              // reserved2 防遗忘：每次唤醒回合结束时，若 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
              // 则发送提醒；连续未设置达到上限后重置为默认唤醒配置。静默/后台提醒回合已在上方 continue，不触发。
              if (pendingWakeKeys.has(key)) {
                pendingWakeKeys.delete(key);
                disarmPendingWakeLease(key);
                if (wakeConfigUpdatedKeys.has(key) || markReadCalledKeys.has(key)) {
                  ensureWakeableV2(getSocialV2State(key), { key });
                  wakeConfigUpdatedKeys.delete(key);
                  markReadCalledKeys.delete(key);
                  wakeConfigMissCount.delete(key);
                } else {
                  const currentMiss = (wakeConfigMissCount.get(key) ?? 0) + 1;
                  const maxReminders = Number(cfg.socialV2?.wake?.maxWakeConfigReminders) || 2;
                  if (currentMiss < maxReminders) {
                    wakeConfigMissCount.set(key, currentMiss);
                    pendingWakeKeys.add(key);
                    armPendingWakeLease(key);
                    deliverPrompt(key, buildWakeReminderPromptV2(key)).then((result) => {
                      if (result && result.ok === false) {
                        pendingWakeKeys.delete(key);
                        disarmPendingWakeLease(key);
                      }
                    }).catch((error) => {
                      pendingWakeKeys.delete(key);
                      disarmPendingWakeLease(key);
                      log(\`[reserved2] \${key} 唤醒提醒投递失败: \${error?.message ?? error}\`);
                    });
                    log(\`[reserved2] \${key} 未设置唤醒条件，发送提醒 (\${currentMiss}/\${maxReminders})\`);
                  } else {
                    const st = getSocialV2State(key);
                    resetWakeConfigV2(st);
                    saveSocialV2State();
                    log(\`[reserved2] \${key} 连续未设置唤醒条件，已重置为默认唤醒配置\`);
                  }
                }
              }`,
    `            if (ended) {
              // reserved2 无行动兜底：普通唤醒回合若既没发消息、也没 mark_read / set_wake_config，
              // 则累计 noActionCount；达到阈值后自动重置 WakeConfig，避免 AI 卡死。
              const silentQueueNow = social.silentTurns.get(frame.sessionId) ?? [];
              const isSilentTurn = silentQueueNow.length > 0;
              const turnStartForMeta = v2TurnStartAt.get(frame.sessionId) ?? 0;
              const rawWakeMeta = turnWakeMeta.get(frame.sessionId) ?? pendingWakeMeta.get(frame.sessionId) ?? null;
              turnWakeMeta.delete(frame.sessionId);
              pendingWakeMeta.delete(frame.sessionId);
              const wakeBaseReason = rawWakeMeta && Date.now() - Number(rawWakeMeta.at || 0) <= 600_000
                ? String(rawWakeMeta.wakeReason || '').split(':')[0]
                : (currentMode === 'reserved2' && key
                    ? (() => {
                        const stFallback = socialV2.conversations.get(canonicalV2Key(key));
                        if (!stFallback) return '';
                        const lastBase = String(stFallback.lastWakeReason || '').split(':')[0];
                        return (lastBase === 'proactiveCheck' && Number(stFallback.lastProactiveWakeAt || 0) >= Math.max(0, turnStartForMeta - 60_000))
                          ? 'proactiveCheck'
                          : '';
                      })()
                    : '');
              let silentEmptyProactive = false;
              if (currentMode === 'reserved2' && key && !isSilentTurn) {
                const st = getSocialV2State(key);
                const turnStart = turnStartForMeta;
                const sendToolHit = sendToolSucceededSessions.has(frame.sessionId);
                const aiRepliedInTurn = Boolean(sendToolHit || (turnStart > 0 && Number(st.lastAiReplyAt || 0) >= turnStart));
                const unreadEmpty = !Array.isArray(st.unread) || st.unread.length === 0;
                const isProactiveWake = wakeBaseReason === 'proactiveCheck';
                if (isProactiveWake && !aiRepliedInTurn) {
                  // 主动巡检本轮选择沉默：记录连静并立即按指数退避重排下一次定时器，不发多余提示。
                  st.lastProactiveSilentAt = Date.now();
                  st.proactiveSilentStreak = Math.min(6, Math.max(1, (Number(st.proactiveSilentStreak) || 0) + 1));
                  if (st.proactiveTimer) {
                    clearTimeout(st.proactiveTimer);
                    st.proactiveTimer = null;
                  }
                  if (unreadEmpty) {
                    silentEmptyProactive = true;
                    st.wakeConfig.noActionCount = 0;
                  }
                  saveSocialV2State();
                  scheduleProactiveCheckV2(key, { quiet: true });
                } else if (turnStart > 0 || sendToolHit) {
                  // turn/start 丢了（重连后由快照补发的回合）就无从判断「这一轮有没有行动」：
                  // 此时记 miss 会冤枉 AI，连续 3 次就把 AI 自己设的唤醒配置重置成默认值。
                  const actionTaken = sendToolHit || (turnStart > 0 && st.lastActionAt >= turnStart);
                  if (actionTaken) {
                    st.wakeConfig.noActionCount = 0;
                  } else {
                    st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
                    const limit = Number(cfg.socialV2?.wake?.noActionLimit) || 3;
                    if (st.wakeConfig.noActionCount >= limit) {
                      log(\`[reserved2] \${key} 连续 \${st.wakeConfig.noActionCount} 次唤醒无行动，重置唤醒配置\`);
                      resetWakeConfigV2(st);
                      st.bootstrapSent = true;
                      st.wakeConfig.noActionCount = 0;
                    }
                  }
                  saveSocialV2State();
                } else {
                  log(\`[reserved2] \${key} 回合结束但缺少 turn/start（重连补发），跳过无行动计数\`);
                }
              }
              v2TurnStartAt.delete(frame.sessionId);
              collectors.delete(frame.sessionId);
              turnLeaseNoted.delete(frame.sessionId);
              const sendToolSucceeded = sendToolSucceededSessions.has(frame.sessionId);
              sendToolSucceededSessions.delete(frame.sessionId);
              analyticalToolsUsedSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              toolCallNames.delete(frame.sessionId);
              // 目的机制：先把「这一枪到底发没发 / 她写了什么目的」记下来，再走正常收尾。
              try { notePurposeTurnEnded(frame.sessionId, ended, sendToolSucceeded); } catch (error) {
                log(\`[目的] 回合回执异常：\${error?.message ?? error}\`);
              }
              // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
              const isFarewell = social.exitingSessions.has(frame.sessionId);
              if (isFarewell) social.exitingSessions.delete(frame.sessionId);
              // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
              // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
              const silentQueue = social.silentTurns.get(frame.sessionId) ?? [];
              const silentNow = Date.now();
              while (silentQueue.length && silentNow - silentQueue[0].ts > SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
              if (silentQueue.length > 0) {
                silentQueue.shift();
                if (silentQueue.length > 0) social.silentTurns.set(frame.sessionId, silentQueue);
                else social.silentTurns.delete(frame.sessionId);
                log(\`摘要投喂 turn 结束，静默 (\${key})\`);
                continue;
              }
              // reserved2 防遗忘：每次唤醒回合结束时，若 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
              // 则发送提醒；连续未设置达到上限后重置为默认唤醒配置。静默/后台提醒/无未读静默 proactiveCheck 已赦免，不二次追问。
              if (pendingWakeKeys.has(key)) {
                pendingWakeKeys.delete(key);
                disarmPendingWakeLease(key);
                if (wakeConfigUpdatedKeys.has(key) || markReadCalledKeys.has(key)) {
                  ensureWakeableV2(getSocialV2State(key), { key });
                  wakeConfigUpdatedKeys.delete(key);
                  markReadCalledKeys.delete(key);
                  wakeConfigMissCount.delete(key);
                } else if (silentEmptyProactive) {
                  const stForWake = getSocialV2State(key);
                  if (!stForWake.wakeConfig.infinite && !stForWake.wakeConfig.sleepUntil) {
                    stForWake.wakeConfig.infinite = true;
                  }
                  ensureWakeableV2(stForWake, { key });
                  wakeConfigMissCount.delete(key);
                  saveSocialV2State();
                } else {
                  const currentMiss = (wakeConfigMissCount.get(key) ?? 0) + 1;
                  const maxReminders = Number(cfg.socialV2?.wake?.maxWakeConfigReminders) || 2;
                  if (currentMiss < maxReminders) {
                    wakeConfigMissCount.set(key, currentMiss);
                    pendingWakeKeys.add(key);
                    armPendingWakeLease(key);
                    deliverPrompt(key, buildWakeReminderPromptV2(key)).then((result) => {
                      if (result && result.ok === false) {
                        pendingWakeKeys.delete(key);
                        disarmPendingWakeLease(key);
                      }
                    }).catch((error) => {
                      pendingWakeKeys.delete(key);
                      disarmPendingWakeLease(key);
                      log(\`[reserved2] \${key} 唤醒提醒投递失败: \${error?.message ?? error}\`);
                    });
                    log(\`[reserved2] \${key} 未设置唤醒条件，发送提醒 (\${currentMiss}/\${maxReminders})\`);
                  } else {
                    const st = getSocialV2State(key);
                    resetWakeConfigV2(st);
                    saveSocialV2State();
                    log(\`[reserved2] \${key} 连续未设置唤醒条件，已重置为默认唤醒配置\`);
                  }
                }
              }`,
    'bridge events turn/end proactive silence handling'
  );

  text = replaceExact(
    text,
    `        sendToolSucceededSessions.clear();
        pendingSendToolCalls.clear();`,
    `        sendToolSucceededSessions.clear();
        analyticalToolsUsedSessions.clear();
        pendingWakeMeta.clear();
        turnWakeMeta.clear();
        pendingSendToolCalls.clear();`,
    'bridge finally cleanup'
  );

  return text;
});

// 4. scripts/audit-bridge-harness.mjs
patchFile('/home/ubuntu/surfcore/scripts/audit-bridge-harness.mjs', (text) => {
  text = replaceExact(
    text,
    "import * as sendLimits from '../src/send-limits.js';",
    `import * as sendLimits from '../src/send-limits.js';
import * as bubbleCoalescer from '../src/bubble-coalescer.js';
import * as proactiveGate from '../src/proactive-gate.js';`,
    'harness imports'
  );
  text = replaceExact(
    text,
    '    collectors, setupSleepTimerV2,',
    '    collectors, setupSleepTimerV2, scheduleProactiveCheckV2, preSleepWaitBlockedV2, analyticalToolsUsedSessions, v2ToolEnabled,',
    'harness return exports'
  );
  text = replaceExact(
    text,
    '    ...sendLimits,',
    `    ...sendLimits,
    ...bubbleCoalescer,
    ...proactiveGate,`,
    'harness context globals'
  );
  return text;
});

console.log('ALL OPT4/5 PATCHES APPLIED SUCCESSFULLY');
