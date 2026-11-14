/**
 * 验证 Denia 情绪与记忆四项原生增强：
 *   1. energy（精力独立一维：初值70 / -3/h / +45 跨夜07:00重置 / 按字数扣减 / 只影响输出量、绝不写文本标签）
 *   2. recordAction（行动结果接入情绪：工具连败 / 任务派发与完成 / 长时独处仅降arousal绝不降valence）
 *   3. reconsolidation（记忆再巩固 0.15：微调感受指纹，绝不篡改原文）
 *   4. moodCongruenceScore（心境一致召回 0.18，且严格保留 visible() fail-closed 边界）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ENERGY_DEFAULTS,
  applyActionOutcome,
  createEmotionStateManager,
  decayedValues,
  emotionBias,
  emotionPromptLine,
  emptyEmotionState,
  energyMessageCap,
  energyOutputCost,
  settleEnergy,
  validateEmotionFile,
} from '../src/emotion-state.js';
import {
  MOOD_CONGRUENCE_WEIGHT,
  RECALL_COOLDOWN_MS,
  RECONSOLIDATION_RATE,
  applyReconsolidation,
  createReconsolidationStore,
  estimateRecordEmotion,
  moodCongruenceScore,
} from '../src/memory-reconsolidation.js';
import { selectContext } from '../src/context-selector.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('energy: 初值 70、每小时 -3、次日 UTC+8 >= 07:00 恢复 +45（每日一次）', () => {
  const empty = emptyEmotionState(Date.UTC(2026, 10, 11, 4, 0, 0)); // UTC+8 12:00
  assert.equal(empty.energy.level, 70);
  assert.equal(ENERGY_DEFAULTS.initial, 70);

  // 同天清醒 4 小时 -> 70 - 12 = 58
  const fourHoursLater = Date.UTC(2026, 10, 11, 8, 0, 0); // UTC+8 16:00
  const s1 = settleEnergy(empty.energy, { now: fourHoursLater });
  assert.equal(s1.level, 58);

  // 跨过 UTC+8 午夜但未到 07:00（UTC+8 06:30 = UTC 22:30）-> 不恢复睡眠，继续按 -3/h 衰减
  const beforeWake = Date.UTC(2026, 10, 11, 22, 30, 0);
  const s2 = settleEnergy(s1, { now: beforeWake });
  // 相距 14.5 小时 -> 58 - 43.5 = 14.5
  assert.equal(s2.level, 14.5);

  // 到 UTC+8 07:15（UTC 23:15）-> 触发 +45 跨夜恢复
  const afterWake = Date.UTC(2026, 10, 11, 23, 15, 0);
  const s3 = settleEnergy(s2, { now: afterWake });
  // 0.75h * 3 = 2.25 -> 14.5 - 2.25 = 12.25 + 45 = 57.25
  assert.equal(s3.level, 57.25);
  assert.equal(s3.lastSleepDay, '2026-11-12');

  // 同一天晚些时候（UTC+8 10:15 = UTC 12日 02:15）不再重复恢复
  const laterSameDay = Date.UTC(2026, 10, 12, 2, 15, 0);
  const s4 = settleEnergy(s3, { now: laterSameDay });
  assert.equal(s4.level, 57.25 - 9);
});

test('energy: 时钟回拨夹紧、按字符数扣费与分段上限、禁止在 prompt 写精力标签', () => {
  const base = emptyEmotionState(1_700_000_000_000);
  const rolled = settleEnergy(base.energy, { now: base.updatedAt - 60_000, clockSkewRollback: true });
  assert.equal(rolled.level, 70);

  assert.equal(energyOutputCost(0), 0);
  assert.equal(energyOutputCost(10), 0.25);
  assert.equal(energyOutputCost(80), 1);
  assert.equal(energyOutputCost(400), 4);

  assert.equal(energyMessageCap(70, 40), 40);
  assert.equal(energyMessageCap(35, 40), 40);
  assert.equal(energyMessageCap(34.9, 40), 3);
  assert.equal(energyMessageCap(19.9, 40), 2);
  assert.equal(energyMessageCap(10, 1), 1);

  // promptLine 不得出现精力标签，也不得含禁用词
  const line = emotionPromptLine({
    ...base,
    source: 'action',
    energy: { level: 12, updatedAt: base.updatedAt, lastSleepDay: '2026-11-11' },
  }, { now: base.updatedAt + 120_000 });
  assert.ok(line.includes('系统事件'), `expected 系统事件 in ${line}`);
  for (const forbidden of ['心情', '情绪', '应该', '不必', '尽量', '建议', '精力', '好累', '困了', 'energy']) {
    assert.ok(!line.includes(forbidden), `promptLine leaked forbidden token: ${forbidden} -> ${line}`);
  }

  // emotionBias 向后兼容：未传 energy 时保持原公式结果；低精力时略微下调
  const baseBias = emotionBias({ valence: 0.4, arousal: 0.5 }, { maxBias: 0.1 });
  assert.equal(baseBias, emotionBias({ valence: 0.4, arousal: 0.5, energy: 70 }, { maxBias: 0.1 }));
  const lowBias = emotionBias({ valence: 0.4, arousal: 0.5, energy: 10 }, { maxBias: 0.1 });
  assert.ok(lowBias < baseBias, `expected lowBias (${lowBias}) < baseBias (${baseBias})`);
});

test('action & manager: 工具失败连败 / 任务派发完成 / 独处只降 arousal 不降 valence + 自动建盘', () => {
  const dir = tmpDir('denia-emo-action-');
  let clock = Date.UTC(2026, 10, 11, 10, 0, 0);
  const mgr = createEmotionStateManager({
    stateDir: dir,
    config: { enabled: true },
    now: () => clock,
  });

  // 初始文件不存在，第一次 spendEnergy 自动建盘并从 70 扣费
  const sp1 = mgr.spendEnergy(160); // 160 / 80 = 2
  assert.equal(sp1.ok, true);
  assert.equal(sp1.energy, 68);
  assert.equal(mgr.values().energy, 68);
  assert.equal(mgr.energyBurstLimit(40), 40);

  // 工具连续失败 2 次 -> valence 降、arousal 微升
  clock += 10_000;
  const t1 = mgr.recordAction({ kind: 'tool', ok: false, tool: 'web_fetch' });
  assert.equal(t1.changed, true);
  assert.ok(t1.state.valence < 0);
  assert.ok(t1.state.arousal > 0.25);

  clock += 10_000;
  const t2 = mgr.recordAction({ kind: 'tool', ok: false, tool: 'web_fetch' });
  assert.ok(t2.state.valence < t1.state.valence);

  // 随后工具成功恢复
  clock += 10_000;
  const tOk = mgr.recordAction({ kind: 'tool', ok: true, tool: 'web_fetch' });
  assert.equal(tOk.changed, true);
  assert.ok(tOk.state.valence > t2.state.valence);

  // 再次普通工具成功（failStreak==0）不触发冗余写盘
  clock += 10_000;
  const tNoop = mgr.recordAction({ kind: 'tool', ok: true, tool: 'read_file' });
  assert.equal(tNoop.changed, false);

  // 任务派发 + 成功完成
  clock += 10_000;
  const d1 = mgr.recordAction({ kind: 'task', phase: 'dispatched' });
  assert.ok(d1.state.valence > tOk.state.valence);
  clock += 10_000;
  const c1 = mgr.recordAction({ kind: 'task', phase: 'completed', ok: true });
  assert.ok(c1.state.valence > d1.state.valence);

  // 长时间独处（>= 45m）：只降 arousal，绝不拉低 valence
  const beforeSolitude = applyActionOutcome(
    { ...emptyEmotionState(clock), valence: 0.22, arousal: 0.48 },
    { kind: 'solitude', idleMs: 50 * 60_000 },
    { now: clock },
  );
  assert.equal(beforeSolitude.changed, true);
  assert.equal(beforeSolitude.valence, 0.22);
  assert.ok(beforeSolitude.arousal < 0.48);

  // 独处不足 45m 不触发；30m 冷却期内也不重复触发
  const tooShort = applyActionOutcome(
    { ...emptyEmotionState(clock), valence: 0.22, arousal: 0.48 },
    { kind: 'solitude', idleMs: 20 * 60_000 },
    { now: clock },
  );
  assert.equal(tooShort.changed, false);

  // validateEmotionFile 校验 energy 范围
  const rawSaved = JSON.parse(fs.readFileSync(path.join(dir, 'emotion-state.json'), 'utf8'));
  assert.equal(validateEmotionFile(rawSaved).ok, true);
  assert.equal(validateEmotionFile({ ...rawSaved, energy: { level: 120 } }).ok, false);
});

test('reconsolidation: 系数 0.15 微调感受指纹，绝不改原文，且遵守 5 分钟冷却', () => {
  assert.equal(RECONSOLIDATION_RATE, 0.15);
  assert.equal(MOOD_CONGRUENCE_WEIGHT, 0.18);

  const dir = tmpDir('denia-recon-');
  let clock = 1_700_100_000_000;
  const file = path.join(dir, 'memory-reconsolidation.json');
  const store = createReconsolidationStore({ file, now: () => clock });

  const original = { id: 'mem_happy_1', title: '一起散步', text: '今天散步特别开心谢谢你' };
  const baseline = estimateRecordEmotion(original);
  assert.ok(baseline.valence > 0);

  // 第一次在低落情绪中被想起 -> 0.85 * baseline + 0.15 * (-0.6)
  const count1 = store.recordRecall([original], { valence: -0.6, arousal: 0.4 });
  assert.equal(count1, 1);
  const e1 = store.getEntry('mem_happy_1');
  assert.equal(e1.encodedValence, baseline.valence);
  assert.equal(e1.recallCount, 1);
  assert.equal(e1.lastRecalledEmotion.valence, -0.6);
  assert.ok(e1.valence < baseline.valence);
  // 原记录对象未被修改
  assert.equal(original.title, '一起散步');
  assert.equal(original.text, '今天散步特别开心谢谢你');

  // 冷却期内再次想起被跳过
  clock += 60_000;
  assert.equal(store.recordRecall([original], { valence: -0.8, arousal: 0.5 }), 0);

  // 过冷却期后持久化可重载
  clock += RECALL_COOLDOWN_MS + 1000;
  assert.equal(store.recordRecall([original], { valence: -0.6, arousal: 0.4 }), 1);
  const reloaded = createReconsolidationStore({ file });
  assert.equal(reloaded.getEntry('mem_happy_1').recallCount, 2);

  // 纯函数校验
  const step = applyReconsolidation(
    { encodedValence: 0.5, encodedArousal: 0.3, valence: 0.5, arousal: 0.3, recallCount: 1 },
    { valence: -0.5, arousal: 0.7 },
    { rate: RECONSOLIDATION_RATE, now: 12345 },
  );
  // 0.85 * 0.5 + 0.15 * (-0.5) = 0.35
  assert.equal(step.valence, 0.35);
  assert.equal(step.encodedValence, 0.5);
  assert.ok(moodCongruenceScore({ valence: 0.5 }, { valence: 0.6 }) > 0);
  assert.ok(moodCongruenceScore({ valence: -0.5 }, { valence: 0.6 }) < 0);
});

test('mood-congruent selectContext: 心境一致排序加权且不突破 visible() 隐私边界', () => {
  const dir = tmpDir('denia-sel-mood-');
  const cardPath = path.join(dir, 'memory-card.json');
  const card = {
    version: 3,
    records: [
      {
        id: 'rec_pos_public',
        category: 'milestone',
        kind: 'dynamic',
        audience: 'public',
        importance: 50,
        title: '群友夸赞',
        text: '群里大家都很开心谢谢',
        createdAt: '2026-11-10T10:00:00Z',
        deleted: false,
      },
      {
        id: 'rec_neg_public',
        category: 'milestone',
        kind: 'dynamic',
        audience: 'public',
        importance: 50,
        title: '报错卡住',
        text: '之前脚本报错失败好难过',
        createdAt: '2026-11-10T10:01:00Z',
        deleted: false,
      },
      {
        id: 'rec_owner_secret',
        category: 'owner',
        kind: 'dynamic',
        audience: 'owner',
        importance: 95,
        title: '主人私密好消息',
        text: '和主人非常开心特别暖心谢谢',
        createdAt: '2026-11-11T10:00:00Z',
        deleted: false,
      },
    ],
  };
  fs.writeFileSync(cardPath, JSON.stringify(card, null, 2), 'utf8');

  // 群聊场景 + 积极心境：rec_pos_public 排在 rec_neg_public 前面，但 owner 秘密绝不会进入群聊
  const posRes = selectContext({
    platform: 'qq',
    conversationKey: 'group:123456',
    isOwner: false,
    ownerQQ: '999999',
    audience: 'public',
    cardPath,
    currentEmotion: { valence: 0.75, arousal: 0.5 },
  }, 4000);
  assert.ok(posRes.usedIds.includes('rec_pos_public'));
  assert.ok(posRes.usedIds.includes('rec_neg_public'));
  assert.ok(!posRes.usedIds.includes('rec_owner_secret'), 'owner memory leaked into group context');
  const posIdx = posRes.blocks.indexOf('群友夸赞');
  const negIdx = posRes.blocks.indexOf('报错卡住');
  assert.ok(posIdx >= 0 && negIdx > posIdx, 'expected mood-congruent positive record ranked before negative one');

  // 同一批记录在消极心境下：rec_neg_public 排到前面
  const negRes = selectContext({
    platform: 'qq',
    conversationKey: 'group:123456',
    isOwner: false,
    ownerQQ: '999999',
    audience: 'public',
    cardPath,
    currentEmotion: { valence: -0.75, arousal: 0.5 },
  }, 4000);
  assert.ok(negRes.blocks.indexOf('报错卡住') < negRes.blocks.indexOf('群友夸赞'));
  assert.ok(Array.isArray(negRes.usedRecords) && negRes.usedRecords.length === 2);
});
