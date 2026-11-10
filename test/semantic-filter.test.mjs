// O03 语义过滤测试。
import test from 'node:test'
import assert from 'node:assert/strict'

import { bigramOverlap, semanticViolation } from '../src/host/semantic-filter.js'

test('rejects assistant voice openings', () => {
  assert.equal(semanticViolation('我来跑一下测试', ''), 'assistant-voice')
  assert.equal(semanticViolation('让我先检查一下', ''), 'assistant-voice')
  assert.equal(semanticViolation('需要我继续吗', ''), 'assistant-voice')
})

test('rejects praise/thanks and meta talk', () => {
  assert.equal(semanticViolation('谢谢，辛苦了', ''), 'praise-or-thanks')
  assert.equal(semanticViolation('没有建议', ''), 'meta-talk')
})

test('rejects error text and label prefixes', () => {
  assert.equal(semanticViolation('api error: rate limited', ''), 'error-text')
  assert.equal(semanticViolation('建议：先跑测试', ''), 'label-prefix')
  assert.equal(semanticViolation('User: 继续', ''), 'label-prefix')
})

test('rejects a suggestion that duplicates the final assistant message', () => {
  const assistant = '当前有两种改法：A 保守修复，B 重构相关模块。你倾向哪种？'
  assert.equal(semanticViolation('A 保守修复，B 重构相关模块。你倾向哪种？', assistant), 'duplicate-assistant')
  assert.equal(semanticViolation('B 的风险是什么？', assistant), null)
})

test('accepts normal short user follow-ups', () => {
  assert.equal(semanticViolation('继续第二项', ''), null)
  assert.equal(semanticViolation('先跑一下测试', ''), null)
  assert.equal(semanticViolation('按 B 方案来', ''), null)
  assert.equal(semanticViolation('失败原因是什么？', ''), null)
})

test('bigramOverlap is symmetric enough for duplicate detection', () => {
  assert.ok(bigramOverlap('继续第二项', '继续第二项') > 0.9)
  assert.ok(bigramOverlap('完全不同的一句话', '继续第二项') < 0.2)
})
