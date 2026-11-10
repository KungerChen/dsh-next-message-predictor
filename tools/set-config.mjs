#!/usr/bin/env node
/**
 * 通过插件 RPC 修改预测器配置并等待 Host 重启后重新读取（测试/运维小工具）。
 *
 * 用法：
 *   node tools/set-config.mjs --url "<scratch URL>" --patch '{"modelMode":"fixed","provider":"fixed-test"}'
 *   node tools/set-config.mjs --url "<scratch URL>" --print
 */
import { browserPath, loadChromium } from './lib/local-env.mjs'
import process from 'node:process'

const chromium = loadChromium()

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const url = argOf('--url', '')
const patchRaw = argOf('--patch', '')
const patchFile = argOf('--patch-file', '')
const printOnly = args.includes('--print')
if (!url) throw new Error('--url is required')
if (!printOnly && patchRaw === '' && patchFile === '') throw new Error('--patch, --patch-file or --print is required')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ executablePath: browserPath(), headless: true })
const page = await browser.newPage()
page.setDefaultTimeout(30000)
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(globalThis.__DSH_BOOT__) || Boolean(window.__nextMessagePredictor) || Boolean(document.querySelector('[data-composer-input]')), undefined, { timeout: 30000 })
  const rpc = (body) =>
    page.evaluate(async (payload) => {
      const response = await fetch('/api/next-message-predictor/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return { status: response.status, body: await response.json() }
    }, body)
  if (!printOnly) {
    const { readFile } = await import('node:fs/promises')
    const patch = patchFile !== '' ? JSON.parse(await readFile(patchFile, 'utf8')) : JSON.parse(patchRaw)
    const result = await rpc({ schemaVersion: 1, operation: 'config.set', patch })
    console.log(JSON.stringify({ step: 'config.set', result }, null, 2))
    await sleep(1500)
    await page.evaluate(() => window.__nextMessagePredictor?.reloadConfig?.()).catch(() => {})
    await sleep(1500)
  }
  const status = await rpc({ schemaVersion: 1, operation: 'status' })
  const value = status.body?.value ?? null
  console.log(JSON.stringify({
    mode: value?.mode,
    modelMode: value?.modelMode,
    route: value?.route,
    promptVersion: value?.promptVersion,
    enabled: value?.config?.enabled,
    config: value?.config,
    budget: value?.budget,
  }, null, 2))
} finally {
  await browser.close()
}
