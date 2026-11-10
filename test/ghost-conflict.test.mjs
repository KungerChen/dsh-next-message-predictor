// O07 运行时冲突检测测试（纯函数，无 DOM 运行时）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { detectGhostConflict, GHOST_MARKER } from '../src/client/dom.js'

function fakeDoc(values) {
  return {
    querySelectorAll: () => values.map((value) => ({ getAttribute: () => value })),
  }
}

test('another ghost namespace is treated as a conflict', () => {
  assert.deepEqual(detectGhostConflict(fakeDoc(['other-plugin']), {}, GHOST_MARKER), {
    source: 'composer-ghost:other-plugin',
  })
})

test('our own ghost element is not a conflict', () => {
  assert.equal(detectGhostConflict(fakeDoc([GHOST_MARKER]), {}, GHOST_MARKER), null)
  assert.equal(detectGhostConflict(fakeDoc([]), {}, GHOST_MARKER), null)
})

test('the legacy composer-predict global is treated as a conflict', () => {
  assert.deepEqual(detectGhostConflict(fakeDoc([]), { __composerPredict: {} }, GHOST_MARKER), {
    source: 'composer-predict-global',
  })
})

test('missing document or window does not throw', () => {
  assert.equal(detectGhostConflict(undefined, undefined, GHOST_MARKER), null)
})
