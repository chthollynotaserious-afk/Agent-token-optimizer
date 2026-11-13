import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSourceRef,
  resolveRecordAudience,
  visible,
  selectContext,
} from '../src/context-selector.js';

test('0. sourceRef 数据结构完整性校验', () => {
  const ref = createSourceRef({
    id: 'mem_001',
    platform: 'qq',
    conversationKey: 'private:123456',
    speaker: '主人',
    isOwner: true,
    private: true,
    createdAt: '2026-11-11T10:00:00.000Z',
    text: '测试记忆内容',
  });
  assert.equal(ref.platform, 'qq');
  assert.equal(ref.conversationKey, 'private:123456');
  assert.equal(ref.speaker, '主人');
  assert.equal(ref.audience, 'owner');
  assert.equal(ref.originalTime, '2026-11-11T10:00:00.000Z');
  assert.equal(ref.recordId, 'mem_001');
});

test('1. 主人查私聊：合规访问应放行', () => {
  const record = {
    id: 'mem_owner_001',
    conversationKey: 'private:12345678',
    platform: 'qq',
    speaker: '主人',
    isOwner: true,
    audience: 'owner',
    text: '今天商量好晚上一起看电影',
  };
  const requestCtx = {
    platform: 'qq',
    conversationKey: 'private:12345678',
    isOwner: true,
    audience: 'owner',
  };
  assert.equal(visible(record, requestCtx), true, '主人在私聊中应当能够看到主人私密记忆');
});

test('2. 群友查群聊：同群公开记录应放行', () => {
  const record = {
    id: 'mem_group_001',
    conversationKey: 'group:999888',
    platform: 'qq',
    speaker: '群友A',
    audience: 'public',
    text: '明天下午有活动吗',
  };
  const requestCtx = {
    platform: 'qq',
    conversationKey: 'group:999888',
    isOwner: false,
    audience: 'public',
  };
  assert.equal(visible(record, requestCtx), true, '群友在对应群中应当能够看到本群公开记忆');
});

test('3. 群友查私聊（应拦截）：群聊环境下不可访问私聊记忆', () => {
  const record = {
    id: 'mem_priv_001',
    conversationKey: 'private:12345678',
    platform: 'qq',
    speaker: '某好友',
    audience: 'trusted',
    text: '这是我的电话号码13800000000',
  };
  const requestCtx = {
    platform: 'qq',
    conversationKey: 'group:999888',
    isOwner: false,
    audience: 'public',
  };
  assert.equal(visible(record, requestCtx), false, '群聊环境绝对禁止泄露私聊记忆');
});

test('4. B站查QQ（应拦截）：跨平台越权应拦截', () => {
  const record = {
    id: 'mem_qq_internal',
    conversationKey: 'group:999888',
    platform: 'qq',
    scope: 'qq',
    speaker: '群友B',
    audience: 'public',
    text: '内部群聊讨论',
  };
  const requestCtx = {
    platform: 'bili',
    conversationKey: '',
    audience: 'public',
  };
  assert.equal(visible(record, requestCtx), false, 'B站环境不可访问未共享的QQ记忆');
});

test('5. 好友私聊绝对隔离：好友A不可查好友B的私聊', () => {
  const record = {
    id: 'mem_friend_a',
    conversationKey: 'private:111111',
    platform: 'qq',
    speaker: '好友A',
    audience: 'trusted',
    text: '好友A的悄悄话',
  };
  const requestCtx = {
    platform: 'qq',
    conversationKey: 'private:222222',
    isOwner: false,
    audience: 'trusted',
  };
  assert.equal(visible(record, requestCtx), false, '好友A与好友B的私聊必须严格物理隔离');
});

test('6. 跨群绝对隔离：群1不可查群2的记忆', () => {
  const record = {
    id: 'mem_group_1',
    conversationKey: 'group:10001',
    platform: 'qq',
    speaker: '群友C',
    audience: 'public',
    text: '群1的内部讨论',
  };
  const requestCtx = {
    platform: 'qq',
    conversationKey: 'group:10002',
    isOwner: false,
    audience: 'public',
  };
  assert.equal(visible(record, requestCtx), false, '跨群不可泄漏未互通的记忆');
});

test('7. 主人私聊记忆防群聊泄漏：即使主人在群里发言，私密记忆也不可在群里被查到', () => {
  const record = {
    id: 'mem_owner_secret',
    conversationKey: 'private:12345678',
    platform: 'qq',
    speaker: '主人',
    audience: 'owner',
    text: '主人的家门钥匙放在门口地垫下',
  };
  const requestCtx = {
    platform: 'qq',
    conversationKey: 'group:999888',
    isOwner: true,
    audience: 'public',
  };
  assert.equal(visible(record, requestCtx), false, '主人私密记忆绝对不可泄漏在公开群聊中');
});

test('8. 桌宠私域与 Fail-Closed 兜底拦截', () => {
  const petSelfRecord = {
    id: 'mem_pet_self',
    platform: 'pet',
    scope: 'pet',
    conversationKey: 'pet',
    isSelf: true,
    text: '今天桌面上想黏着你',
  };
  assert.equal(
    visible(petSelfRecord, { platform: 'qq', conversationKey: 'private:999999', isOwner: false, audience: 'trusted' }),
    false,
    '好友私聊不可读取桌宠私域记录'
  );
  assert.equal(
    visible(petSelfRecord, { platform: 'qq', conversationKey: 'private:12345678', isOwner: true, audience: 'owner' }),
    true,
    '主人私聊允许读取桌宠记录'
  );
  assert.equal(visible(null, { platform: 'qq', conversationKey: 'private:123' }), false, '空记录默认返回 false');
  assert.equal(visible({}, {}), false, '空上下文默认返回 false');
});

test('9. selectContext 去重验收：重复 ID 与 sharedContext 重复文本绝不重复出现', () => {
  const recordA1 = {
    id: 'rec_same_id',
    platform: 'qq',
    conversationKey: 'private:12345678',
    isOwner: true,
    audience: 'owner',
    text: '第一条相同ID的内容',
    importance: 50,
  };
  const recordA2 = {
    id: 'rec_same_id',
    platform: 'qq',
    conversationKey: 'private:12345678',
    isOwner: true,
    audience: 'owner',
    text: '第二条相同ID的内容（应该被去重）',
    importance: 40,
  };
  const recordB = {
    id: 'rec_unique_id',
    platform: 'qq',
    conversationKey: 'private:12345678',
    isOwner: true,
    audience: 'owner',
    text: '唯一ID的内容',
    importance: 30,
  };
  const dupSharedRecord = {
    id: 'shared_dup_content',
    platform: 'shared',
    scope: 'shared',
    audience: 'public',
    text: '唯一ID的内容',
    importance: 20,
  };

  const res = selectContext({
    platform: 'qq',
    conversationKey: 'private:12345678',
    isOwner: true,
    records: [recordA1, recordA2, recordB],
    sharedRecords: [dupSharedRecord],
  }, 2000);

  assert.equal(res.usedIds.length, 2, 'usedIds 应当恰好只有两个去重后的ID');
  assert.deepEqual(res.usedIds, ['rec_same_id', 'rec_unique_id']);
  const countSame = (res.blocks.match(/相同ID/g) || []).length;
  assert.equal(countSame, 1, '内容块中重复ID记录只渲染了一次');
});

test('10. selectContext 槽位优先与预算控制：优先保障 pinned 槽位', () => {
  const pinnedRecord = {
    id: 'rec_pinned_meet',
    platform: 'qq',
    conversationKey: 'private:12345678',
    isOwner: true,
    audience: 'owner',
    pinned: true,
    firstMet: true,
    text: '初次相遇：在风雨交加的雨夜相遇',
    importance: 100,
  };
  const dynamicRecord1 = {
    id: 'rec_dynamic_1',
    platform: 'qq',
    conversationKey: 'private:12345678',
    isOwner: true,
    audience: 'owner',
    text: '非常长的一段闲聊记忆A'.repeat(10),
    importance: 20,
  };
  const dynamicRecord2 = {
    id: 'rec_dynamic_2',
    platform: 'qq',
    conversationKey: 'private:12345678',
    isOwner: true,
    audience: 'owner',
    text: '非常长的一段闲聊记忆B'.repeat(10),
    importance: 10,
  };

  const res = selectContext({
    platform: 'qq',
    conversationKey: 'private:12345678',
    isOwner: true,
    records: [dynamicRecord1, pinnedRecord, dynamicRecord2],
  }, 180);

  assert.ok(res.usedIds.includes('rec_pinned_meet'), '无论预算多紧张，置顶记忆必须保留');
  assert.ok(!res.usedIds.includes('rec_dynamic_2'), '超出预算的低优先级动态记忆被裁剪');
  assert.match(res.blocks, /初次相遇/, '输出 blocks 中必须包含置顶记录');
});

test('11. RTM 证据槽位接入：验证外部证据可参与统一选择并受 visible 限制', () => {
  const evidenceA = {
    id: 'rtm_ev_001',
    platform: 'qq',
    conversationKey: 'private:12345678',
    audience: 'owner',
    text: 'RTM检索发现主人上周提到过想买红茶',
    importance: 60,
  };
  const leakedEvidence = {
    id: 'rtm_ev_leak',
    platform: 'qq',
    conversationKey: 'private:99999999', // 属于别的私聊
    audience: 'trusted',
    text: '来自别人的私聊证据',
    importance: 80,
  };

  const res = selectContext({
    platform: 'qq',
    conversationKey: 'private:12345678',
    isOwner: true,
    records: [],
    evidence: [evidenceA, leakedEvidence],
  }, 1000);

  assert.ok(res.usedIds.includes('rtm_ev_001'), '合规的 RTM 证据正常入选');
  assert.ok(!res.usedIds.includes('rtm_ev_leak'), '跨私聊的非法 RTM 证据被 visible 成功拦截');
});

test('12. 隐私脱敏回调尊重：formatRecord 返回空串时不得回退打印原文', () => {
  const res = selectContext({
    platform: 'qq',
    conversationKey: 'group:88888',
    isOwner: false,
    audience: 'public',
    records: [
      {
        id: 'mem_no_summary',
        platform: 'qq',
        conversationKey: 'group:88888',
        audience: 'public',
        text: '不应该被直接泄露出原文的群消息',
      },
    ],
    formatRecord: () => '', // 模拟因缺少摘要而被 v3/v4 规则抑制
  }, 1000);

  assert.equal(res.usedIds.length, 0);
  assert.equal(res.blocks, '');
});

