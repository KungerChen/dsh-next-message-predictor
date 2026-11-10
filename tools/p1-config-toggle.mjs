#!/usr/bin/env node
/**
 * P1 配置开关验证（对应验收矩阵“配置关闭/卸载”场景）。
 *
 * 流程：
 *   1. 加载隔离 Web GUI，确认插件运行时 ready 且 enabled=true（scratch profile 的 seed 配置）；
 *   2. 产生一个 mock 回合，确认 ghost 出现；
 *   3. 通过插件 RPC config.set 关闭 enabled（经 configEditor.edit 持久化并重启 Host 插件）；
 *   4. 轮询 status 直到 enabled=false，断言 ghost 消失、runtime 状态为 disabled/无 offer；
 *   5. 再产生一个回合，断言关闭状态下不会再出现 ghost；
 *   6. 恢复 enabled=true 并轮询确认。
 *
 * 用法：
 *   node tools/p1-config-toggle.mjs --url "<scratch URL>" [--out scratch/evidence]
 */
import { browserPath, loadChromium } from './lib/local-env.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const chromium = loadChromium()

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const url = argOf('--url', '')
const out = argOf('--out', path.join(repoRoot, 'scratch', 'evidence'))
const tag = argOf('--tag', 'config-toggle')
if (!url) throw new Error('--url is required')
await mkdir(out, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const report = { ok: false, url, startedAt: new Date().toISOString(), steps: {}, console: [], pageErrors: [] }

const browser = await chromium.launch({
  executablePath: browserPath(),
  headless: true,
  args: ['--disable-gpu', '--no-first-run'],
})
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.setDefaultTimeout(30000)
page.on('console', (m) => {
  if (report.console.length < 200) report.console.push({ type: m.type(), text: m.text().slice(0, 1000) })
})
page.on('pageerror', (e) => report.pageErrors.push(String(e).slice(0, 2000)))

const state = () =>
  page.evaluate(() => {
    try {
      const api = window.__nextMessagePredictor
      if (!api) return { present: false }
      const s = api.state()
      return {
        present: true,
        status: s.assist.status,
        reason: s.assist.reason,
        text: s.assist.text,
        env: s.env
          ? {
              turnId: s.env.turnId,
              running: s.env.running,
              hasFinalText: s.env.hasFinalText,
              draft: s.env.draft,
            }
          : null,
        config: {
          ready: s.config.ready,
          enabled: s.config.config ? s.config.config.enabled : null,
          revision: s.config.revision,
          hostError: s.config.hostError,
        },
      }
    } catch (error) {
      return { present: true, error: String(error) }
    }
  })

const dom = () =>
  page.evaluate(() => {
    const input = document.querySelector('[data-composer-input]')
    const ghost = document.querySelector('[data-nmp-ghost]')
    return {
      input: Boolean(input),
      editable: input ? input.isContentEditable : false,
      draft: input ? input.textContent : null,
      ghost: Boolean(ghost),
      ghostVisible: ghost ? ghost.getBoundingClientRect().width > 0 : false,
      ghostText: ghost ? ghost.textContent : null,
      activeIsInput: input ? document.activeElement === input : false,
      triggerMenuOpen: Boolean(document.querySelector('[data-trigger-menu]')),
    }
  })

const rpc = (body) =>
  page.evaluate(async (payload) => {
    try {
      const response = await fetch('/api/next-message-predictor/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const text = await response.text()
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        /* 非 JSON 响应 */
      }
      return { httpStatus: response.status, json, text: text.slice(0, 500) }
    } catch (error) {
      return { error: String(error) }
    }
  }, body)

async function dismissPreview() {
  const dialogs = page.locator('[role="dialog"]')
  for (let i = 0; i < (await dialogs.count()); i += 1) {
    const d = dialogs.nth(i)
    if (/预览版说明/.test(await d.innerText().catch(() => ''))) {
      const b = d.locator('button', { hasText: /继续/ }).first()
      if (await b.count()) {
        await b.click({ force: true })
        await sleep(600)
        return
      }
    }
  }
}

async function ensureComposer() {
  await dismissPreview()
  for (let i = 0; i < 12; i += 1) {
    const d = await dom()
    if (d.input && d.editable) return d
    const picker = page.locator('[role="textbox"][contenteditable="false"]').first()
    if (await picker.count()) {
      await picker.click({ force: true }).catch(() => {})
      await sleep(700)
      const options = page.locator('[role="presentation"] button')
      if (await options.count()) {
        await options.first().click({ force: true }).catch(() => {})
        await sleep(900)
      }
    }
    await sleep(300)
  }
  throw new Error('composer 未就绪')
}

async function sendTurn(text) {
  await ensureComposer()
  await page.locator('[data-composer-input]').first().click({ force: true })
  await sleep(150)
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await sleep(150)
  const before = await state()
  const turnBefore = before.env ? before.env.turnId : ''
  await page.keyboard.type(text, { delay: 8 })
  await page.keyboard.press('Enter')
  let started = false
  for (let i = 0; i < 100; i += 1) {
    const s = await state()
    if (s.env && s.env.running === true) {
      started = true
      break
    }
    await sleep(100)
  }
  if (!started) throw new Error('回合未开始')
  let finished = null
  for (let i = 0; i < 200; i += 1) {
    const s = await state()
    if (s.env && s.env.running === false && s.env.hasFinalText === true && s.env.turnId !== turnBefore) {
      finished = s
      break
    }
    await sleep(100)
  }
  if (finished === null) throw new Error('回合未完成')
  return finished
}

async function waitGhost(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const s = await state()
    const d = await dom()
    last = { s, d }
    if (s.status === 'offered' && s.text !== '' && d.ghost === true && d.ghostVisible === true) return last
    await sleep(100)
  }
  return last
}

async function waitConfigEnabled(expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const result = await rpc({ schemaVersion: 1, operation: 'status' })
    last = result
    const enabled = result.json && result.json.ok === true && result.json.value
      ? result.json.value.config.enabled
      : undefined
    if (enabled === expected) return { ok: true, result }
    await sleep(400)
  }
  return { ok: false, result: last }
}

const record = (name, value) => {
  report.steps[name] = value
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => Boolean(globalThis.__DSH_BOOT__) || Boolean(document.querySelector('[data-composer-input]')),
    undefined,
    { timeout: 30000 },
  )
  const ready = await ensureComposer()
  await page.waitForFunction(() => Boolean(window.__nextMessagePredictor), undefined, { timeout: 30000 })
  const initial = await state()
  record('initial', { ready, state: initial })
  if (!initial.present || !initial.config || initial.config.ready !== true) throw new Error('插件运行时未就绪')
  if (initial.config.enabled !== true) throw new Error('seed 配置未启用预测')

  // 1) enabled=true 时出现 ghost
  await sendTurn('请回复：收到')
  const ghostOn = await waitGhost(20000)
  record('ghost-when-enabled', { status: ghostOn.s.status, text: ghostOn.s.text, dom: ghostOn.d })
  if (ghostOn.s.status !== 'offered' || ghostOn.d.ghost !== true) throw new Error('启用状态下 ghost 未出现')
  await page.screenshot({ path: path.join(out, `${tag}-01-enabled-ghost.png`) })

  // 2) 关闭配置（configEditor.edit 会重启 Host 插件）
  const off = await rpc({ schemaVersion: 1, operation: 'config.set', patch: { enabled: false } })
  record('config-set-off', off)
  const offConfirmed = await waitConfigEnabled(false, 20000)
  record('config-off-confirmed', offConfirmed)
  if (!offConfirmed.ok) throw new Error('关闭配置后 status 未显示 enabled=false')
  await sleep(1000)
  await page.evaluate(() => window.__nextMessagePredictor?.reloadConfig?.()).catch(() => {})
  await sleep(1200)
  const afterOff = await state()
  const domOff = await dom()
  record('runtime-after-off', { state: afterOff, dom: domOff })
  if (domOff.ghost) throw new Error('关闭配置后 ghost 仍然存在')
  if (afterOff.config && afterOff.config.enabled === true) throw new Error('关闭后客户端配置仍为 enabled=true')
  await page.screenshot({ path: path.join(out, `${tag}-02-disabled.png`) })

  // 3) 关闭状态下完成一个回合，仍不得出现 ghost
  await sendTurn('请再回复：收到')
  const ghostOff = await waitGhost(6000)
  record('ghost-when-disabled', { status: ghostOff.s.status, text: ghostOff.s.text, dom: ghostOff.d })
  if (ghostOff.d.ghost === true) throw new Error('关闭配置后回合结束仍出现 ghost')

  // 4) 恢复 enabled=true
  const on = await rpc({ schemaVersion: 1, operation: 'config.set', patch: { enabled: true } })
  record('config-set-on', on)
  const onConfirmed = await waitConfigEnabled(true, 20000)
  record('config-on-confirmed', onConfirmed)
  if (!onConfirmed.ok) throw new Error('恢复配置后 status 未显示 enabled=true')
  await page.evaluate(() => window.__nextMessagePredictor?.reloadConfig?.()).catch(() => {})
  await sleep(1200)
  const finalState = await state()
  record('runtime-after-on', finalState)
  if (finalState.config && finalState.config.enabled !== true) throw new Error('恢复后客户端配置仍为 enabled=false')

  report.ok = true
} catch (error) {
  report.error = String(error?.stack ?? error)
  report.ok = false
  await page.screenshot({ path: path.join(out, `${tag}-99-failure.png`) }).catch(() => {})
} finally {
  report.finishedAt = new Date().toISOString()
  if (!process.argv.includes('--keep-open')) await browser.close().catch(() => {})
  const reportPath = path.join(out, `${tag}-report.json`)
  await writeFile(reportPath, JSON.stringify(report, null, 2)).catch(() => {})
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        out: reportPath,
        steps: Object.keys(report.steps),
        error: report.error ?? null,
        configSetOff: report.steps['config-set-off'],
        configSetOn: report.steps['config-set-on'],
      },
      null,
      2,
    ),
  )
  if (!report.ok) process.exitCode = 1
}
