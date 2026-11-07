import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyDecision, classifyExplicit } from '../lib/text.js';

test('取舍分类：定稿/否决口吻才记，临时微调不记', () => {
  assert.deepEqual(classifyDecision('改成侧栏入口'), { kind: 'fact', text: '改成侧栏入口' });
  assert.deepEqual(classifyDecision('就要这版，定稿'), { kind: 'fact', text: '就要这版，定稿' });
  assert.deepEqual(classifyDecision('不要用 PowerShell 回写文件'), { kind: 'constraint', text: '不要用 PowerShell 回写文件' });
  assert.deepEqual(classifyDecision('以后都别用玻璃拟态'), { kind: 'constraint', text: '以后都别用玻璃拟态' });
  // 临时微调不记
  assert.equal(classifyDecision('再大一点'), null);
  assert.equal(classifyDecision('先这样试试'), null);
  assert.equal(classifyDecision('今天天气不错'), null);
  // 太长的不记（防止把整段对话塞进来）
  assert.equal(classifyDecision('改'.repeat(100)), null);
  // 「记住…」走显式通道，不会重复
  assert.equal(classifyExplicit('记住：我不吃辣').explicit, true);
});
