#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

function sendCalls(h) {
  return h.calls.http.filter((c) => /\/(send_group_msg|send_private_msg)$/.test(c.url));
}

function sendTexts(h) {
  return sendCalls(h).map((c) => {
    const msg = c.body?.message;
    if (typeof msg === 'string') return msg;
    if (Array.isArray(msg)) {
      return msg
        .map((seg) => (seg?.type === 'text' ? seg.data?.text : `[${seg?.type}:${JSON.stringify(seg?.data || {})}]`))
        .join('');
    }
    return '';
  });
}

async function withServer(run, { config = {}, globals = {}, savedState, files } = {}) {
  const h = await bridgeHarness({
    config: {
      socialV2: {
        wake: { preSleepWaitEnabled: true, preSleepWaitMs: 300000 },
        proactive: { enabled: true, checkIntervalMinMs: 60000, checkIntervalMaxMs: 60000, idleThresholdMs: 60000, probability: 1 },
        sticker: { enabled: false },
        ...(config.socialV2 ?? {}),
      },
      ...config,
    },
    globals,
    savedState,
    files,
  });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  const post = (route, key, body, token) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: `/api/socialV2/${route}`,
      method: 'POST',
      headers: {
        'x-console-token': 'fixture-console-token',
        ...(token ? { 'x-agent-token': token } : {}),
        'content-type': 'application/json',
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('HTTP timeout')));
    req.end(JSON.stringify({ key, ...body }));
  });

  try {
    await run({ h, post });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

test('Opt-4/5 Integration: send-message Layer 2 coalesces causal & tech explanations while preserving daily banter & anti-examples', () => withServer(async ({ h, post }) => {
  const key = 'private:123';
  const st = h.getSocialV2State(key);

  // 1. Causal 3-bubble explanation -> coalesced into 1 bubble
  const r1 = await post('send-message', key, {
    messages: ['因为刚才那个超时配置太短了', '所以触发了连接中断', '否则其实可以一次跑完'],
    gapMode: 'fixed',
    gapMs: 100,
  }, st.agentToken);
  assert.equal(r1.status, 200);
  assert.equal(r1.data.ok, true);
  assert.equal(r1.data.sent, 1);
  assert.equal(r1.data.coalesced?.before, 3);
  assert.equal(r1.data.coalesced?.after, 1);
  assert.ok(r1.data.coalesced.reasons.includes('causal_chain'));

  // 2. Anti-example: short ack preserved + causal tail merged -> 2 bubbles
  h.calls.http.length = 0;
  const r2 = await post('send-message', key, {
    messages: ['嗯', '因为旧脚本里转义多了一层', '所以直接 scp 传上去更稳'],
    gapMode: 'fixed',
    gapMs: 100,
  }, st.agentToken);
  assert.equal(r2.status, 200);
  assert.equal(r2.data.sent, 2);
  const t2 = sendTexts(h);
  assert.equal(t2[0], '嗯');
  assert.match(t2[1], /因为旧脚本里转义多了一层\n所以直接 scp 传上去更稳/);

  // 3. Anti-example: media bubble isolated
  h.calls.http.length = 0;
  const r3 = await post('send-message', key, {
    messages: ['[表情:开心]', '因为测试全部过了', '所以我终于可以歇会儿了'],
    gapMode: 'fixed',
    gapMs: 100,
  }, st.agentToken);
  assert.equal(r3.status, 200);
  assert.equal(r3.data.sent, 2);
  const t3 = sendTexts(h);
  assert.equal(t3[0], '[表情:开心]');

  // 4. Casual daily banter NOT coalesced
  h.calls.http.length = 0;
  const r4 = await post('send-message', key, {
    messages: ['哈哈哈', '真的吗', '那也太离谱了吧'],
    gapMode: 'fixed',
    gapMs: 100,
  }, st.agentToken);
  assert.equal(r4.status, 200);
  assert.equal(r4.data.sent, 3);
  assert.equal(r4.data.coalesced, undefined);
  assert.equal(sendCalls(h).length, 3);
}));

test('Opt-4/5 Integration: group chat 220-char anti-wall cap & analyticalToolsUsedSessions trigger', () => withServer(async ({ h, post }) => {
  const key = 'group:456';
  const st = h.getSocialV2State(key);
  const sid = await h.ensureSession(key);
  h.analyticalToolsUsedSessions.add(sid);

  const a = '首先我查了日志文件第一段内容：'.padEnd(115, '甲');
  const b = '其次确认是配置项本身已经生效：'.padEnd(115, '乙');
  const c = '最后建议直接重启一次看日志状态：'.padEnd(90, '丙');

  const r = await post('send-message', key, {
    messages: [a, b, c],
    gapMode: 'fixed',
    gapMs: 100,
  }, st.agentToken);
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.ok(r.data.coalesced?.reasons.includes('tool_explanation'));
  assert.equal(r.data.sent, 2, 'b+c fit within 220 group cap while a stays separate');
  const texts = sendTexts(h);
  for (const line of texts) {
    assert.ok(line.length <= 220, `group bubble length ${line.length} exceeded 220 cap`);
  }
}));

test('Opt-4/5 Integration: send-message items supports distinct replyToMessageId & atUserId without merging across targets', () => withServer(async ({ h, post }) => {
  const key = 'group:456';
  const st = h.getSocialV2State(key);
  st.recentMessages.push(
    { seq: 1, messageId: '501', sender: '张三', userId: '777', text: 'A怎么配置', plain: 'A怎么配置', isSelf: false, time: Date.now() - 20000 },
    { seq: 2, messageId: '502', sender: '李四', userId: '888', text: 'B也要改吗', plain: 'B也要改吗', isSelf: false, time: Date.now() - 10000 },
  );

  const r = await post('send-message', key, {
    items: [
      { text: '因为 A 默认已经开了所以不用动', replyToMessageId: 1 },
      { text: '但是 B 需要手动加上配置参数', replyToMessageId: 2, atUserId: 888 },
    ],
    gapMode: 'fixed',
    gapMs: 100,
  }, st.agentToken);

  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.sent, 2);
  const reqs = sendCalls(h);
  assert.equal(reqs.length, 2);
  const seg0 = reqs[0].body.message;
  const seg1 = reqs[1].body.message;
  assert.ok(Array.isArray(seg0) && seg0.some((s) => s.type === 'reply' && String(s.data.id) === '501'));
  assert.ok(Array.isArray(seg1) && seg1.some((s) => s.type === 'reply' && String(s.data.id) === '502'));
  assert.ok(seg1.some((s) => s.type === 'at' && String(s.data.qq) === '888'));
}));

test('Opt-4/5 Integration: protocol folding afterAction=close, sleep-allowed, sleep-preSleepBlocked, and pre-send static validation', () => withServer(async ({ h, post }) => {
  const key = 'private:123';
  const st = h.getSocialV2State(key);

  // Case A: afterAction='sleep' with empty infinite triggers fails BEFORE sending (400, 0 QQ sends)
  h.appendSocialV2Message(key, '主人', '今天先这样，晚安啦', '今天先这样，晚安啦', false, true, 'm1');
  st.modelSeenSeqs = new Set([1]);
  const badSleep = await post('send-message', key, {
    messages: '好的晚安',
    afterAction: 'sleep',
    wakeConfig: { mode: 'diving', infinite: true, triggers: { atMention: false, nameMention: false, question: false, poke: false, keywords: [], anyMessage: false, probability: 0 } },
  }, st.agentToken);
  assert.equal(badSleep.status, 400);
  assert.equal(sendCalls(h).length, 0);

  // Case B: afterAction='close' + throughSeq folds close into send, cancels replyCheck
  const rClose = await post('send-message', key, {
    messages: '晚安，明天见',
    throughSeq: 1,
    afterAction: 'close',
    closeReason: 'explicit-end',
    closeSummary: '互道晚安结束对话',
  }, st.agentToken);
  assert.equal(rClose.status, 200);
  assert.equal(rClose.data.ok, true);
  assert.equal(rClose.data.sent, 1);
  assert.equal(rClose.data.afterAction, 'close');
  assert.equal(rClose.data.afterActionApplied, true);
  assert.equal(rClose.data.markedCount, 1);
  assert.equal(st.unread.length, 0);
  assert.equal(st.closure?.reason, 'explicit-end');
  assert.equal(st.replyCheckTimer, null);

  // Case C: afterAction='sleep' on explicit-end succeeds and arms sleep/wakeConfig
  const rSleepOk = await post('send-message', key, {
    messages: '早点休息哈',
    afterAction: 'sleep',
    wakeConfig: { mode: 'diving', infinite: true, triggers: { atMention: true, nameMention: true } },
  }, st.agentToken);
  assert.equal(rSleepOk.status, 200);
  assert.equal(rSleepOk.data.ok, true);
  assert.equal(rSleepOk.data.sent, 1);
  assert.equal(rSleepOk.data.afterAction, 'sleep');
  assert.equal(rSleepOk.data.afterActionApplied, true);
  assert.equal(st.wakeConfig.mode, 'diving');
  assert.equal(st.wakeConfig.infinite, true);
  assert.equal(st.replyCheckTimer, null);

  // Case D: afterAction='sleep' on non-ended active chat sends message cleanly but refuses sleep with PRE_SLEEP_WAIT_REQUIRED
  h.calls.http.length = 0;
  h.appendSocialV2Message(key, '主人', '对了帮我看个问题呀', '对了帮我看个问题呀', false, true, 'm2');
  const rSleepBlocked = await post('send-message', key, {
    messages: '好呀你发过来',
    afterAction: 'sleep',
    wakeConfig: { mode: 'diving', infinite: true, triggers: { atMention: true } },
  }, st.agentToken);
  assert.equal(rSleepBlocked.status, 200);
  assert.equal(rSleepBlocked.data.ok, true);
  assert.equal(rSleepBlocked.data.sent, 1);
  assert.equal(sendCalls(h).length, 1);
  assert.equal(rSleepBlocked.data.afterAction, 'sleep');
  assert.equal(rSleepBlocked.data.afterActionApplied, false);
  assert.equal(rSleepBlocked.data.afterActionCode, 'PRE_SLEEP_WAIT_REQUIRED');
}));

test('Opt-4/5 Integration: send-burst also coalesces causal bursts', () => withServer(async ({ h, post }) => {
  const key = 'private:123';
  const st = h.getSocialV2State(key);
  const r = await post('send-burst', key, {
    messages: ['因为缓存已经刷新', '所以这一轮不用重发', '否则会多烧一次 token'],
  }, st.agentToken);
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.sent, 1);
  assert.equal(r.data.coalesced?.before, 3);
  assert.equal(r.data.coalesced?.after, 1);
  assert.equal(sendCalls(h).length, 1);
}));

test('Opt-4/5 Integration: proactiveCheck prompt removes web_search nudge, preSleep bypasses empty proactiveCheck, and gate locks -> unlocks on inbound', async () => {
  const scheduledCallbacks = [];
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;

  await withServer(async ({ h, post }) => {
    const key = 'group:456';
    const st = h.getSocialV2State(key);

    // 1. Prompt removes mcp__web-search-safe__web_search nudge & keeps static anchor compatible
    const proactivePrompt = h.buildWakePromptV2(key, 'proactiveCheck');
    assert.ok(proactivePrompt.includes('【主动机会】'));
    assert.equal(proactivePrompt.includes('web_search'), false, 'proactiveCheck prompt must NOT suggest web_search');
    assert.equal(proactivePrompt.includes('web-search-safe'), false, 'proactiveCheck prompt must NOT mention web-search-safe');

    // 2. Empty cold-idle history (idle 2m >= 1m threshold, yet < 5m preSleepWaitMs) -> 1 spontaneous check allowed -> sends message -> no-reply-lock -> peer inbound unlocks
    st.lastIncomingAt = Date.now() - 2 * 60_000;
    st.lastAiReplyAt = Date.now() - 40 * 60_000;
    st.proactiveSilentStreak = 0;
    st.lastProactiveWakeAt = 0;
    st.lastProactiveSentAt = 0;
    if (st.proactiveTimer) { origClearTimeout(st.proactiveTimer); st.proactiveTimer = null; }

    scheduledCallbacks.length = 0;
    h.scheduleProactiveCheckV2(key, { quiet: true });
    assert.equal(scheduledCallbacks.length, 1);
    // Simulate first proactive timer firing
    const firstCb = scheduledCallbacks.pop();
    firstCb();
    await new Promise((r) => origSetTimeout(r, 60));

    assert.equal(h.calls.prompts.length, 1, 'first cold-idle check should wake model once');
    assert.ok(st.lastProactiveWakeAt > 0, 'deliverPromptNow accepted must stamp lastProactiveWakeAt');
    assert.equal(st.lastWakeReason, 'proactiveCheck');

    // Verify preSleepWaitBlockedV2 is bypassed when woke by proactiveCheck with 0 unread & no AI reply yet
    assert.equal(h.preSleepWaitBlockedV2(st), false, 'empty proactiveCheck before reply must not trigger 5min pre-sleep lock');

    // Now simulate Denia sending a proactive message in this wake
    const sendRes = await post('send-message', key, { messages: '晚上好呀，群里好安静' }, st.agentToken);
    assert.equal(sendRes.status, 200);
    assert.ok(st.lastProactiveSentAt >= st.lastIncomingAt, 'recordSentMessagesV2 must stamp lastProactiveSentAt when replying to proactiveCheck');
    assert.equal(h.preSleepWaitBlockedV2(st), true, 'once AI replied, preSleepWaitBlockedV2 resumes normal wait window guard');
    // Simulate turn completion clearing pendingWakeKeys so subsequent gate tests check real lock/B-class (not busy).
    h.pendingWakeKeys.delete(key);

    // Re-arm scheduleProactiveCheckV2: must be backed off (8h max cap) and locked against second knock!
    if (st.proactiveTimer) { origClearTimeout(st.proactiveTimer); st.proactiveTimer = null; }
    scheduledCallbacks.length = 0;
    h.scheduleProactiveCheckV2(key, { quiet: true });
    assert.equal(st.proactiveTimerBackedOff, true);
    assert.equal(scheduledCallbacks.length, 1);

    // Firing timer while peer still hasn't replied must NOT send second proactive wake!
    h.calls.prompts.length = 0;
    const lockedCb = scheduledCallbacks.pop();
    lockedCb();
    await new Promise((r) => origSetTimeout(r, 40));
    assert.equal(h.calls.prompts.length, 0, 'no-reply-lock must prevent any further proactive wake until peer replies');

    // Peer replies! -> unlocks & resets proactiveSilentStreak & clears proactiveTimerBackedOff
    st.proactiveSilentStreak = 3;
    h.appendSocialV2Message(key, '群友甲', '刚下班回家', '刚下班回家', false, false, 'm-unlock');
    assert.equal(st.proactiveSilentStreak, 0);
    assert.equal(st.proactiveTimerBackedOff, false);

    // 3. B-class concrete topic/thought check marks followedUpAt / lastProactiveCheckedAt once accepted
    st.unread.length = 0;
    st.lastIncomingAt = Date.now() - 40 * 60_000;
    st.lastProactiveWakeAt = Date.now() - 2 * 3600_000;
    st.lastProactiveSentAt = 0;
    st.proactiveSilentStreak = 1;
    st.activeTopics = [{ text: '周末爬山', lastMentionAt: Date.now() - 45 * 60_000, followedUpAt: 0 }];
    st.pendingThoughts = [{ text: '记得问照片', lastProactiveCheckedAt: 0 }];
    if (st.proactiveTimer) { origClearTimeout(st.proactiveTimer); st.proactiveTimer = null; }
    scheduledCallbacks.length = 0;
    h.scheduleProactiveCheckV2(key, { quiet: true });
    h.calls.prompts.length = 0;
    scheduledCallbacks.pop()();
    await new Promise((r) => origSetTimeout(r, 60));
    assert.equal(h.calls.prompts.length, 1, 'B-class concrete topic/thought passes even when silentStreak > 0');
    assert.ok(st.activeTopics[0].followedUpAt > 0, 'accepted wake stamps activeTopic.followedUpAt');
    assert.ok(st.pendingThoughts[0].lastProactiveCheckedAt > 0, 'accepted wake stamps pendingThought.lastProactiveCheckedAt');
  }, {
    config: {
      socialV2: {
        wake: { preSleepWaitEnabled: true, preSleepWaitMs: 300000 },
        proactive: {
          enabled: true,
          checkIntervalMinMs: 60000,
          checkIntervalMaxMs: 60000,
          idleThresholdMs: 60000,
          probability: 1,
          gate: { enabled: true },
        },
        sticker: { enabled: false },
      },
    },
    globals: {
      mathRandom: () => 0.05,
      setTimeout: (fn, ms) => {
        if (ms >= 60000 && ms <= 8 * 3600_000) {
          scheduledCallbacks.push(fn);
          return { fakeTimer: true, unref() {} };
        }
        const t = origSetTimeout(fn, ms);
        t?.unref?.();
        return t;
      },
      clearTimeout: (t) => {
        if (t && !t.fakeTimer) origClearTimeout(t);
      },
    },
  });
});

test('Opt-4/5 Integration: source wiring sanity for events loop silent proactiveCheck exemption & harness parity', () => {
  const bridgeSrc = fs.readFileSync('/home/ubuntu/surfcore/src/bridge.js', 'utf8');
  const mcpSrc = fs.readFileSync('/home/ubuntu/surfcore/src/mcp-snowluma-safe.js', 'utf8');
  const styleSrc = fs.readFileSync('/home/ubuntu/surfcore/src/natural-style.js', 'utf8');

  assert.ok(bridgeSrc.includes('analyticalToolsUsedSessions.add(frame.sessionId)'));
  assert.ok(bridgeSrc.includes('silentEmptyProactive'));
  assert.ok(bridgeSrc.includes('evaluateProactiveGate'));
  assert.ok(bridgeSrc.includes('computeProactiveDelayMs'));
  assert.ok(bridgeSrc.includes('coalesceSendItems'));
  assert.equal(bridgeSrc.includes('用 mcp__web-search-safe__web_search 搜一下当前热点'), false);

  assert.ok(mcpSrc.includes('afterAction'));
  assert.ok(mcpSrc.includes('throughSeq'));
  assert.ok(mcpSrc.includes('wakeConfigSchema'));
  assert.ok(styleSrc.includes('1~2 条'));
});
