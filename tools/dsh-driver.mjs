#!/usr/bin/env node
/**
 * Reusable browser driver for the DSH Web GUI (P0/P1 E2E harness).
 *
 * Uses playwright-core and drives an installed Google Chrome / Microsoft Edge
 * through executablePath; both are located by tools/lib/local-env.mjs.
 * The DSH Web UI URL carries a per-boot auth token, so it must be passed in.
 *
 * Modes:
 *   --inspect     Dump page metadata, DOM candidates, composer selectors, boot
 *                 manifest and screenshots, then exit.
 *   --smoke       (default) Prove driver capabilities: load page, clear first-run
 *                 gates, enable the composer, read the boot manifest, dispatch
 *                 Tab/Escape/Enter, type + clear text, open a CDP session and do
 *                 an Input.imeSetComposition round trip.
 *   --load-proof  smoke + hard assertions for the P0 load proof:
 *                   * __DSH_BOOT__.entries contains predictor-hello AND
 *                     dsh-next-message-predictor client modules
 *                   * window.__PREDICTOR_HELLO__ loaded
 *                   * [data-testid="predictor-hello-marker"] visible
 *                   * window.__nextMessagePredictor.version is a 0.x.y version string
 *                   * POST /api/next-message-predictor/rpc status -> ok:true
 *                   * [data-nmp-anchor] present (inside [data-composer-overlay])
 *                 Exits non-zero when an assertion fails.
 *
 * Usage:
 *   node tools/dsh-driver.mjs --url "http://127.0.0.1:3090/?token=..." \
 *        --out scratch/evidence --mode load-proof
 *
 * Options:
 *   --url <url>            DSH web URL incl. token (required)
 *   --out <dir>            output dir for screenshots/JSON (default: scratch/evidence)
 *   --mode <mode>          inspect | smoke | load-proof (default: smoke)
 *   --channel <chrome|edge> browser to use (default: chrome)
 *   --headful              run with a visible window (default: headless)
 *   --keep-open            leave the browser open when done (debugging)
 *   --timeout <ms>         per-step timeout (default: 30000)
 *   --tag <name>           evidence filename prefix (default: run-<timestamp>)
 */
import { browserPath, loadChromium, loadPlaywright } from './lib/local-env.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const opts = {
    url: '',
    out: path.join(__dirname, '..', 'scratch', 'evidence'),
    mode: 'smoke',
    channel: 'chrome',
    headless: true,
    keepOpen: false,
    timeout: 30000,
    tag: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    switch (a) {
      case '--url': opts.url = next(); break;
      case '--out': opts.out = next(); break;
      case '--mode': opts.mode = next(); break;
      case '--channel': opts.channel = next(); break;
      case '--headful': opts.headless = false; break;
      case '--headless': opts.headless = true; break;
      case '--keep-open': opts.keepOpen = true; break;
      case '--timeout': opts.timeout = Number(next()); break;
      case '--tag': opts.tag = next(); break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!opts.url) throw new Error('--url is required');
  if (!['inspect', 'smoke', 'load-proof'].includes(opts.mode)) throw new Error(`invalid --mode ${opts.mode}`);
  if (!opts.tag) opts.tag = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  return opts;
}

// ---------------------------------------------------------------------------
// Page-side helpers (serialized into page.evaluate).
// ---------------------------------------------------------------------------

function pageComposerState() {
  const el = document.querySelector('[data-composer-input]') ?? document.querySelector('[role="textbox"]');
  if (!el) return { found: false };
  const rect = el.getBoundingClientRect();
  return {
    found: true,
    selector: el.hasAttribute('data-composer-input') ? '[data-composer-input]' : '[role="textbox"]',
    editable: el.getAttribute('contenteditable') === 'true',
    ariaLabel: el.getAttribute('aria-label'),
    text: (el.textContent ?? '').slice(0, 200),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
  };
}

function pageBootState() {
  const out = {
    href: location.href,
    title: document.title,
    hasBoot: false,
    bootKeys: [],
    entries: [],
    moduleIds: [],
    predictorHello: null,
    nextMessagePredictor: null,
    authHints: null,
  };
  try {
    if (globalThis.__DSH_BOOT__ !== undefined) {
      out.hasBoot = true;
      const boot = globalThis.__DSH_BOOT__;
      out.bootKeys = boot && typeof boot === 'object' ? Object.keys(boot) : typeof boot;
      const entries = Array.isArray(boot?.entries) ? boot.entries : [];
      out.entries = entries.map((entry) => ({ id: entry?.id ?? null, rev: entry?.rev ?? null, immediately: entry?.immediately ?? null }));
      out.moduleIds = entries.map((entry) => entry?.id).filter((id) => typeof id === 'string');
    }
  } catch (err) {
    out.bootError = String(err);
  }
  try {
    out.predictorHello = globalThis.__PREDICTOR_HELLO__ ?? null;
  } catch (err) {
    out.predictorHelloError = String(err);
  }
  try {
    const g = globalThis.__nextMessagePredictor;
    out.nextMessagePredictor = g === undefined || g === null
      ? null
      : { version: g.version ?? null, viewId: g.viewId ?? null, keys: Object.keys(g).slice(0, 40) };
  } catch (err) {
    out.nextMessagePredictorError = String(err);
  }
  const bodyText = (document.body?.innerText ?? '').slice(0, 4000);
  if (/(sign in|log in|login|登录|sign-in|authorize|授权)/i.test(bodyText) && !document.querySelector('textarea, [contenteditable="true"]')) {
    out.authHints = bodyText.slice(0, 800);
  }
  return out;
}

function pageMarkerState() {
  const el = document.querySelector('[data-testid="predictor-hello-marker"]');
  const anchor = document.querySelector('[data-nmp-anchor]');
  const slots = [...document.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot'));
  return {
    helloMarker: el ? {
      present: true,
      visible: el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0,
      text: (el.textContent ?? '').trim(),
      outerHTML: el.outerHTML.slice(0, 1200),
      insideInputDock: el.closest('[data-slot="conversation.input.dock"]') !== null,
    } : { present: false },
    anchor: anchor ? {
      present: true,
      parentIsComposerOverlay: anchor.closest('[data-composer-overlay]') !== null,
      slotHostAttr: anchor.closest('[data-slot]')?.getAttribute('data-slot') ?? null,
      rect: (() => { const r = anchor.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
    } : { present: false },
    slots: slots.slice(0, 120),
  };
}

function pageComposerContent() {
  const el = document.querySelector('[data-composer-input]') ?? document.querySelector('[role="textbox"]');
  if (!el) return { found: false };
  return { found: true, textContent: (el.textContent ?? '').slice(0, 300), html: (el.innerHTML ?? '').slice(0, 500) };
}

function pageActiveElement() {
  const el = document.activeElement;
  if (!el) return null;
  return {
    tag: el.tagName,
    id: el.id || null,
    dataTestId: el.getAttribute?.('data-testid') ?? null,
    ariaLabel: el.getAttribute?.('aria-label') ?? null,
    contentEditable: el.getAttribute?.('contenteditable') ?? null,
  };
}

function pageTestIds() {
  const ids = new Map();
  for (const el of document.querySelectorAll('[data-testid]')) {
    const id = el.getAttribute('data-testid');
    ids.set(id, (ids.get(id) ?? 0) + 1);
  }
  return [...ids.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => a.id.localeCompare(b.id));
}

function pageInputCandidates() {
  const selectors = [
    '[data-composer-input]',
    '[role="textbox"]',
    'textarea',
    '[contenteditable="true"]',
  ];
  const result = [];
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      const rect = el.getBoundingClientRect();
      result.push({
        selector,
        tag: el.tagName,
        ariaLabel: el.getAttribute('aria-label'),
        contentEditable: el.getAttribute('contenteditable'),
        visible: rect.width > 20 && rect.height > 10,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      });
    }
  }
  return result.slice(0, 20);
}

// ---------------------------------------------------------------------------
// Playwright-side helpers.
// ---------------------------------------------------------------------------

async function dismissFirstRunGate(page) {
  let dismissed = 0;
  for (let i = 0; i < 6; i++) {
    const button = page.locator('[role="dialog"] button', { hasText: '继续' });
    if ((await button.count()) === 0) break;
    await button.first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(600);
    dismissed += 1;
  }
  return dismissed;
}

async function ensureComposer(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    const state = await page.evaluate(pageComposerState);
    if (state.found && state.editable) return { ...state, attempts };
    await dismissFirstRunGate(page);
    const pill = page.getByText('选择工作区', { exact: true }).first();
    if ((await pill.count()) > 0) {
      await pill.click({ force: true }).catch(() => {});
      await page.waitForTimeout(600);
    } else {
      const seat = page.locator('[class*="composerSeat"], [class*="composerHero"]').first();
      if ((await seat.count()) > 0) {
        await seat.click({ force: true, position: { x: 200, y: 30 } }).catch(() => {});
        await page.waitForTimeout(400);
      }
    }
    await dismissFirstRunGate(page);
    await page.waitForTimeout(500);
  }
  return { ...(await page.evaluate(pageComposerState)), attempts, timeout: true };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(opts.out);
  await mkdir(outDir, { recursive: true });
  const chromium = loadChromium();
  const executablePath = browserPath(opts.channel);
  const report = {
    driver: 'tools/dsh-driver.mjs',
    playwrightCore: loadPlaywright().version,
    channel: opts.channel,
    executablePath,
    headless: opts.headless,
    mode: opts.mode,
    url: opts.url,
    startedAt: new Date().toISOString(),
    ok: false,
    steps: {},
    console: [],
    pageErrors: [],
    requestFailures: [],
  };

  const browser = await chromium.launch({
    executablePath,
    headless: opts.headless,
    args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(opts.timeout);
  page.on('console', (msg) => {
    if (report.console.length < 400) report.console.push({ type: msg.type(), text: msg.text().slice(0, 1500) });
  });
  page.on('pageerror', (err) => report.pageErrors.push(String(err).slice(0, 3000)));
  page.on('requestfailed', (req) => {
    if (report.requestFailures.length < 100) {
      report.requestFailures.push({ url: req.url().slice(0, 400), error: req.failure()?.errorText ?? null });
    }
  });

  try {
    // 1. Load the Web UI (URL carries the per-boot auth token).
    const t0 = Date.now();
    const response = await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
    report.steps.goto = { status: response?.status() ?? null, url: page.url(), ms: Date.now() - t0 };
    await page.waitForTimeout(2600);
    report.steps.gateDismissedOnLoad = await dismissFirstRunGate(page);

    // 2. Enable the composer (first-run gate + workspace hero state).
    const composer = await ensureComposer(page, Math.max(opts.timeout, 30000));
    report.steps.composer = composer;
    await page.waitForTimeout(1000);
    report.steps.gateDismissedAfterEnable = await dismissFirstRunGate(page);
    if (opts.mode !== 'inspect') {
      await page.screenshot({ path: path.join(outDir, `${opts.tag}-01-ready.png`) });
    }

    // 3. Boot/global/marker state.
    report.steps.boot = await page.evaluate(pageBootState);
    report.steps.markers = await page.evaluate(pageMarkerState);

    if (opts.mode === 'inspect') {
      report.steps.inputs = await page.evaluate(pageInputCandidates);
      report.steps.testIds = await page.evaluate(pageTestIds);
      report.steps.bodyText = await page.evaluate(() => (document.body?.innerText ?? '').slice(0, 3000));
      report.steps.htmlHead = await page.evaluate(() => document.documentElement.outerHTML.slice(0, 4000));
      report.ok = true;
    } else {
      // 4. Keyboard events: Tab / Escape / Enter.
      await page.evaluate(() => document.body?.focus?.());
      const keyboard = { tab: null, escape: null, enter: null };
      await page.keyboard.press('Tab');
      keyboard.tab = { activeElement: await page.evaluate(pageActiveElement) };
      await page.keyboard.press('Escape');
      keyboard.escape = { activeElement: await page.evaluate(pageActiveElement) };
      await page.keyboard.press('Enter');
      keyboard.enter = { activeElement: await page.evaluate(pageActiveElement) };
      report.steps.keyboard = keyboard;

      // 5. Type into the composer and clear it again (no submit).
      const composerState = await page.evaluate(pageComposerState);
      const inputLocator = composerState.selector === '[data-composer-input]'
        ? page.locator('[data-composer-input]').first()
        : page.locator('[role="textbox"]').first();
      const typing = { attempted: false };
      if (composerState.found && composerState.editable) {
        await dismissFirstRunGate(page);
        await inputLocator.click({ force: true }).catch(() => {});
        await page.waitForTimeout(200);
        await dismissFirstRunGate(page);
        const typedText = 'E2E probe 123';
        await page.keyboard.type(typedText, { delay: 20 });
        await page.waitForTimeout(300);
        typing.attempted = true;
        typing.typedText = typedText;
        typing.content = await page.evaluate(pageComposerContent);
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await page.waitForTimeout(200);
        typing.clearedContent = await page.evaluate(pageComposerContent);
      } else {
        typing.reason = 'no editable composer';
      }
      report.steps.typing = typing;

      // 6. CDP session + Input.imeSetComposition round trip (for later IME tests).
      const cdp = await context.newCDPSession(page);
      const cdpChecks = { session: true };
      try {
        const evaluated = await cdp.send('Runtime.evaluate', { expression: '1 + 1', returnByValue: true });
        cdpChecks.runtimeEvaluate = evaluated.result.value;
      } catch (err) {
        cdpChecks.runtimeEvaluateError = String(err).slice(0, 500);
      }
      try {
        if (composerState.found && composerState.editable) {
          await inputLocator.click({ force: true }).catch(() => {});
        }
        await cdp.send('Input.imeSetComposition', {
          text: '预测测试',
          selectionStart: 4,
          selectionEnd: 4,
          replacementStart: 0,
          replacementEnd: 0,
        });
        cdpChecks.imeAfterCompose = await page.evaluate(pageComposerContent);
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await page.waitForTimeout(200);
        cdpChecks.imeAfterCancel = await page.evaluate(pageComposerContent);
        cdpChecks.imeSetComposition = 'ok';
      } catch (err) {
        cdpChecks.imeSetComposition = 'error';
        cdpChecks.imeError = String(err).slice(0, 1000);
      }
      report.steps.cdp = cdpChecks;

      // 7. In-page Host status RPC.
      report.steps.rpcStatus = await page.evaluate(async () => {
        try {
          const res = await fetch('/api/next-message-predictor/rpc', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ schemaVersion: 1, operation: 'status' }),
          });
          const text = await res.text();
          let json = null;
          try { json = JSON.parse(text); } catch { /* keep text */ }
          return { status: res.status, ok: res.ok, json, textHead: text.slice(0, 1500) };
        } catch (err) {
          return { error: String(err).slice(0, 800) };
        }
      });

      // 8. Re-read markers (anchor can appear only once the composer is live).
      report.steps.markers = await page.evaluate(pageMarkerState);
      const bootManifest = await page.evaluate(() => {
        try { return JSON.parse(JSON.stringify(globalThis.__DSH_BOOT__ ?? null)); } catch { return null; }
      });
      report.steps.bootManifest = bootManifest;
      await writeFile(path.join(outDir, `${opts.tag}-boot-manifest.json`), JSON.stringify(bootManifest, null, 2));
      const fullShot = path.join(outDir, `${opts.tag}-02-full.png`);
      await page.screenshot({ path: fullShot, fullPage: true });
      report.steps.screenshots = {
        ready: path.join(outDir, `${opts.tag}-01-ready.png`),
        fullPage: fullShot,
      };

      // 9. Verdict.
      const boot = report.steps.boot;
      const markers = report.steps.markers;
      const rpc = report.steps.rpcStatus;
      const moduleIds = boot.moduleIds ?? [];
      report.assertions = {
        pageLoaded: report.steps.goto.status === 200,
        composerFound: Boolean(report.steps.composer?.found),
        composerEditable: report.steps.composer?.editable === true,
        helloClientModuleListed: moduleIds.includes('predictor-hello'),
        nmpClientModuleListed: moduleIds.includes('dsh-next-message-predictor'),
        helloGlobalLoaded: boot.predictorHello?.loaded === true,
        helloMarkerVisible: markers.helloMarker?.present === true && markers.helloMarker?.visible === true,
        nmpGlobalVersion: typeof boot.nextMessagePredictor?.version === 'string' && /^0\.\d+\.\d+/.test(boot.nextMessagePredictor.version),
        rpcStatusOk: rpc?.json?.ok === true,
        rpcConnectionFetch: rpc?.json?.value?.capabilities?.connectionFetch === true,
        anchorPresent: markers.anchor?.present === true,
        anchorInsideComposerOverlay: markers.anchor?.parentIsComposerOverlay === true,
      };
      const required = [
        'pageLoaded', 'composerFound', 'composerEditable',
        'helloClientModuleListed', 'nmpClientModuleListed',
        'helloGlobalLoaded', 'helloMarkerVisible',
        'nmpGlobalVersion', 'rpcStatusOk', 'rpcConnectionFetch',
        'anchorPresent', 'anchorInsideComposerOverlay',
      ];
      report.ok = opts.mode === 'smoke'
        ? required.slice(0, 8).every((key) => report.assertions[key])
        : required.every((key) => report.assertions[key]);
    }
  } catch (err) {
    report.error = String(err?.stack ?? err).slice(0, 8000);
    report.ok = false;
    try {
      report.steps.failureScreenshot = path.join(outDir, `${opts.tag}-failure.png`);
      await page.screenshot({ path: report.steps.failureScreenshot });
    } catch { /* page may be gone */ }
  } finally {
    report.finishedAt = new Date().toISOString();
    const reportPath = path.join(outDir, `${opts.tag}-report.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2)).catch(() => {});
    if (!opts.keepOpen) await browser.close().catch(() => {});
    console.log(JSON.stringify({
      ok: report.ok,
      mode: report.mode,
      report: reportPath,
      assertions: report.assertions ?? null,
      moduleIds: (report.steps?.boot?.moduleIds ?? []).filter((id) => /predictor|predictor-hello/.test(id)),
      rpc: report.steps?.rpcStatus?.json ? {
        ok: report.steps.rpcStatus.json.ok,
        capabilities: report.steps.rpcStatus.json.value?.capabilities ?? null,
        enabled: report.steps.rpcStatus.json.value?.enabled ?? null,
      } : (report.steps?.rpcStatus?.error ?? null),
      marker: report.steps?.markers?.helloMarker ?? null,
      anchor: report.steps?.markers?.anchor ?? null,
      error: report.error ?? null,
    }, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, fatal: String(err?.stack ?? err) }, null, 2));
  process.exit(1);
});
