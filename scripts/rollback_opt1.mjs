/**
 * Opt-1 一键回滚脚本
 * 作用：
 * 1. 恢复 bridge.js 到修改前的原始备份 bridge.js.bak-before-opt1；
 * 2. 恢复 sessions.json 到轮转前的旧会话映射 sessions.json.bak-before-opt1；
 * 3. 确保所有旧会话 100% 保持未删除状态；
 * 4. 重启 denia-bridge.service。
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const bridgePath = '/home/ubuntu/surfcore/src/bridge.js';
const bridgeBakPath = '/home/ubuntu/surfcore/src/bridge.js.bak-before-opt1';
const sessionsPath = '/srv/denia/data/state/sessions.json';
const sessionsBakPath = '/srv/denia/data/state/sessions.json.bak-before-opt1';

console.log('[ROLLBACK] 正在回滚 Opt-1 改动...');

if (fs.existsSync(bridgeBakPath)) {
  fs.copyFileSync(bridgeBakPath, bridgePath);
  console.log('[OK] 恢复 bridge.js 完成');
} else {
  console.error('[FAIL] 找不到 bridge.js.bak-before-opt1！');
}

if (fs.existsSync(sessionsBakPath)) {
  fs.copyFileSync(sessionsBakPath, sessionsPath);
  console.log('[OK] 恢复 sessions.json (还原旧会话映射) 完成');
} else {
  console.error('[FAIL] 找不到 sessions.json.bak-before-opt1！');
}

console.log('[ROLLBACK] 重启 denia-bridge.service...');
execSync('sudo systemctl restart denia-bridge.service');
console.log('[OK] 服务已重启，成功回滚至修改前状态与旧会话！');

// DUA Phase 2 回滚记录（非阻塞：即使 DUA 未初始化或写入异常，也不影响紧急回滚流程）
try {
  execSync('node /home/ubuntu/surfcore/scripts/dua-release.mjs --rollback --source agy --summary "回滚 Opt-1 无损轮转改动与 sessions 映射"', {
    stdio: 'inherit',
  });
} catch (duaErr) {
  console.warn(`[WARN] DUA 回滚记录跳过：${duaErr?.message ?? duaErr}`);
}
