// Machine-specific locations for the verification scripts, resolved at run time.
//
// The scripts in tools/ and eval/ drive a real browser with playwright-core and
// (the PowerShell ones) start a real DeepSeek Harness install. Where those live
// differs per machine, so nothing here is a literal path. Each location is
// looked up in this order:
//
//   1. an environment variable;
//   2. tools/local.config.json (not tracked by git; copy
//      tools/local.config.example.json and fill it in);
//   3. the usual place on this operating system, when there is one.
//
// | What                      | Environment variable   | local.config.json |
// |---------------------------|------------------------|-------------------|
// | playwright-core package   | NMP_PLAYWRIGHT_PATH    | playwrightPath    |
// | Chrome / Edge executable  | NMP_BROWSER_PATH       | browserPath       |
// | DeepSeek Harness install  | DSH_INSTALL_DIR        | harnessRoot       |
//
// The plugin itself (src/, lib/) never reads any of this.

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Repository root (the plugin directory), from this file's own location. */
export const repoRoot = path.resolve(here, '..', '..')

const CONFIG_FILE = path.join(repoRoot, 'tools', 'local.config.json')
const SETUP_HINT = 'See tools/local.config.example.json and docs/DEVELOPMENT.md ("本机环境").'

let cachedConfig

/** tools/local.config.json as an object; {} when the file is absent. */
export function localConfig() {
  if (cachedConfig !== undefined) return cachedConfig
  cachedConfig = {}
  if (existsSync(CONFIG_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) cachedConfig = parsed
    } catch (error) {
      throw new Error(`tools/local.config.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return cachedConfig
}

/** First non-empty string among an environment variable and a config field. */
function setting(envName, configKey) {
  const fromEnv = process.env[envName]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const fromFile = localConfig()[configKey]
  return typeof fromFile === 'string' && fromFile.trim() !== '' ? fromFile.trim() : ''
}

let cachedPlaywright

/**
 * Load playwright-core (or playwright).
 * @returns {{module: object, version: string, from: string}}
 */
export function loadPlaywright() {
  if (cachedPlaywright !== undefined) return cachedPlaywright
  const configured = setting('NMP_PLAYWRIGHT_PATH', 'playwrightPath')
  const attempts = []
  if (configured !== '') attempts.push({ request: path.resolve(configured), from: configured })
  // Installed next to this repository (`npm install --no-save playwright-core`) or globally resolvable.
  attempts.push({ request: 'playwright-core', from: 'playwright-core' }, { request: 'playwright', from: 'playwright' })
  const require = createRequire(path.join(repoRoot, 'package.json'))
  const failures = []
  for (const attempt of attempts) {
    try {
      const module = require(attempt.request)
      let version = 'unknown'
      try {
        version = require(`${attempt.request}/package.json`).version
      } catch {
        /* version is informational only */
      }
      cachedPlaywright = { module, version, from: attempt.from }
      return cachedPlaywright
    } catch (error) {
      failures.push(`${attempt.from}: ${error instanceof Error ? error.code ?? error.message : String(error)}`)
    }
  }
  throw new Error(
    `playwright-core was not found (${failures.join('; ')}). Set NMP_PLAYWRIGHT_PATH or "playwrightPath" in tools/local.config.json ` +
      `to a playwright-core package directory, or run \`npm install --no-save playwright-core\` in this repository. ${SETUP_HINT}`,
  )
}

/** The usual install locations of a browser on this operating system. */
function usualBrowserPaths(channel) {
  const env = process.env
  const join = (base, ...parts) => (typeof base === 'string' && base !== '' ? [path.join(base, ...parts)] : [])
  if (process.platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]
    return channel === 'edge'
      ? roots.flatMap((root) => join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
      : roots.flatMap((root) => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  }
  if (process.platform === 'darwin') {
    return channel === 'edge'
      ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  }
  return channel === 'edge'
    ? ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
}

/**
 * Path of the browser executable to drive.
 * @param {'chrome' | 'edge'} [channel] - which browser to look for when none is configured.
 */
export function browserPath(channel = 'chrome') {
  const configured = setting('NMP_BROWSER_PATH', 'browserPath')
  if (configured !== '') {
    if (!existsSync(configured)) throw new Error(`The configured browser does not exist: ${configured}. ${SETUP_HINT}`)
    return configured
  }
  const wanted = channel === 'edge' ? 'edge' : 'chrome'
  // Fall back to the other browser rather than fail: both are Chromium.
  for (const candidate of [...usualBrowserPaths(wanted), ...usualBrowserPaths(wanted === 'edge' ? 'chrome' : 'edge')]) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`No Chrome or Edge install was found. Set NMP_BROWSER_PATH or "browserPath" in tools/local.config.json. ${SETUP_HINT}`)
}

/** `chromium` from playwright-core. Throws with setup instructions when it is not installed. */
export function loadChromium() {
  return loadPlaywright().module.chromium
}

/** Launch the configured browser. Extra options are passed through to playwright. */
export function launchBrowser(options) {
  const { channel, ...rest } = options ?? {}
  return loadChromium().launch({ headless: true, ...rest, executablePath: browserPath(channel) })
}
