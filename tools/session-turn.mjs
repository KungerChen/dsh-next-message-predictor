#!/usr/bin/env node
/**
 * Deterministic one-turn driver for the predictor-scratch E2E instance.
 *
 * It opens the DSH Web UI, clears the first-run preview notice, enables the
 * composer, creates a fresh session by typing a fixed user message and pressing
 * Enter, waits for the mocked assistant reply, and then captures the P1 trigger
 * fixture state: session id heuristics, assistant DOM node, the plugin's ghost
 * suggestion, `[data-nmp-anchor]` placement inside `[data-composer-overlay]`,
 * `window.__nextMessagePredictor`, and the in-page Host status RPC.
 *
 * The model route is the local mock (`tools/mock-llm.mjs`, provider `mock`,
 * model `mock-1`) configured only in the scratch profile, so this script never
 * touches the user's DeepSeek account.
 *
 * Usage:
 *   node tools/session-turn.mjs --url "http://127.0.0.1:3090/?token=..." \
 *        [--out scratch/evidence] [--reply "收到（mock-1）"] [--text "请回复：收到"]
 *
 * Exit code 0 only when the mocked assistant reply appears AND the plugin
 * overlay/anchor/global are present after the turn.
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
    tag: '',
    text: '请回复：收到',
    reply: '收到（mock-1）',
    timeout: 120000,
    channel: 'chrome',
    headless: true,
    keepOpen: false,
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
      case '--tag': opts.tag = next(); break;
      case '--text': opts.text = next(); break;
      case '--reply': opts.reply = next(); break;
      case '--timeout': opts.timeout = Number(next()); break;
      case '--channel': opts.channel = next(); break;
      case '--headful': opts.headless = false; break;
      case '--keep-open': opts.keepOpen = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!opts.url) throw new Error('--url is required');
  if (!opts.tag) opts.tag = `turn-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  return opts;
}

const toJsonValue = (value) => {
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
};

async function dismissPreview(page) {
  const dialog = page.locator('[role="dialog"]', { hasText: '预览版说明' });
  if ((await dialog.count()) === 0) return false;
  const button = dialog.locator('button', { hasText: '继续' });
  if ((await button.count()) === 0) return false;
  await button.first().click({ force: true });
  await page.waitForTimeout(700);
  return true;
}

/**
 * Dismiss every stacked first-run dialog (the 预览版说明 gate can reappear once
 * when the user first interacts with a fresh composer). Returns how many were
 * dismissed. Uses force clicks because the gate renders its own mask.
 */
async function dismissAllModals(page) {
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

async function composerText(page) {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-composer-input]') ?? document.querySelector('[role="textbox"]');
    return (el?.textContent ?? '').replace(/\u200b/g, '');
  });
}

/** Composer input state: prefers the shell-owned `[data-composer-input]` editor. */
function composerState() {
  const el =
    document.querySelector('[data-composer-input]') ??
    document.querySelector('[role="textbox"]');
  if (!el) return { found: false };
  return {
    found: true,
    selector: el.hasAttribute('data-composer-input') ? '[data-composer-input]' : '[role="textbox"]',
    editable: el.getAttribute('contenteditable') === 'true',
    ariaLabel: el.getAttribute('aria-label'),
    text: (el.textContent ?? '').slice(0, 200),
  };
}

async function ensureComposer(page, report) {
  report.steps.enable = { attempts: [] };
  for (let attempt = 1; attempt <= 8; attempt++) {
    const state = await page.evaluate(composerState);
    report.steps.enable.attempts.push({ attempt, state });
    if (state.found && state.editable) return state;
    await dismissPreview(page);
    const pill = page.getByText('选择工作区', { exact: true }).first();
    if ((await pill.count()) > 0) {
      await pill.click({ force: true }).catch(() => {});
      await page.waitForTimeout(700);
    } else {
      // Nudge the composer area so the first-run gate can surface.
      const seat = page.locator('[class*="composerSeat"], [class*="composerHero"]').first();
      if ((await seat.count()) > 0) {
        await seat.click({ force: true, position: { x: 200, y: 30 } }).catch(() => {});
        await page.waitForTimeout(500);
      }
    }
    await dismissPreview(page);
    await page.waitForTimeout(600);
  }
  return await page.evaluate(composerState);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(opts.out);
  await mkdir(outDir, { recursive: true });
  const chromium = loadChromium();
  const report = {
    driver: 'tools/session-turn.mjs',
    playwrightCore: loadPlaywright().version,
    url: opts.url,
    userText: opts.text,
    expectedReply: opts.reply,
    startedAt: new Date().toISOString(),
    ok: false,
    steps: {},
    console: [],
    pageErrors: [],
    requestFailures: [],
  };
  const browser = await chromium.launch({
    executablePath: browserPath(opts.channel),
    headless: opts.headless,
    args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on('console', (m) => {
    if (report.console.length < 400) report.console.push({ type: m.type(), text: m.text().slice(0, 1500) });
  });
  page.on('pageerror', (e) => report.pageErrors.push(String(e).slice(0, 3000)));
  page.on('requestfailed', (req) => {
    if (report.requestFailures.length < 100) {
      report.requestFailures.push({ url: req.url().slice(0, 400), error: req.failure()?.errorText ?? null });
    }
  });

  try {
    // 1. Load the Web UI (URL carries the auth token).
    const gotoStart = Date.now();
    const response = await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
    report.steps.goto = { status: response?.status() ?? null, url: page.url(), ms: Date.now() - gotoStart };
    await page.waitForTimeout(2600);
    // The first-run 预览版说明 gate can surface only after the app has booted its
    // onboarding state; clear it before and after enabling the composer.
    report.steps.gateDismissedOnLoad = await dismissAllModals(page);

    // 2. Clear first-run gate and enable the composer.
    const composer = await ensureComposer(page, report);
    await page.waitForTimeout(1200);
    report.steps.gateDismissedAfterEnable = await dismissAllModals(page);

    // 2b. Force a brand-new session so repeated E2E runs never continue the
    // previous draft session (the shell restores the last workspace session).
    const newSessionButton = page.locator('button', { hasText: '新会话' }).first();
    if ((await newSessionButton.count()) > 0) {
      await newSessionButton.click({ force: true }).catch(() => {});
      await page.waitForTimeout(900);
      await dismissAllModals(page);
      report.steps.newSessionClicked = true;
    } else {
      report.steps.newSessionClicked = false;
    }
    report.steps.composer = composer;
    report.steps.composerEnabled = Boolean(composer.found && composer.editable);
    await page.screenshot({ path: path.join(outDir, `${opts.tag}-01-composer.png`) });

    // 3. Type the user message and submit it with Enter (creates the session).
    // The onboarding gate may steal the first click/keystroke, so retry until the
    // composer really holds the text.
    if (!report.steps.composerEnabled) throw new Error('composer never became editable');
    report.steps.typingAttempts = [];
    let typedOk = false;
    for (let attempt = 1; attempt <= 4 && !typedOk; attempt++) {
      await dismissAllModals(page);
      const input = page.locator('[data-composer-input]').first();
      const inputLocator = (await input.count()) > 0 ? input : page.locator('[role="textbox"]').first();
      await inputLocator.click({ force: true }).catch(() => {});
      await page.waitForTimeout(250);
      const gateOnClick = await dismissAllModals(page);
      if (gateOnClick > 0) {
        // Gate consumed the click; retry with a fresh focus.
        await inputLocator.click({ force: true }).catch(() => {});
        await page.waitForTimeout(250);
      }
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.keyboard.type(opts.text, { delay: 25 });
      await page.waitForTimeout(400);
      const gateOnType = await dismissAllModals(page);
      const current = await composerText(page);
      report.steps.typingAttempts.push({ attempt, gateOnClick, gateOnType, current: current.slice(0, 300) });
      typedOk = current.includes(opts.text.slice(0, Math.min(4, opts.text.length)));
    }
    report.steps.typed = await page.evaluate(() => {
      const el = document.querySelector('[data-composer-input]') ?? document.querySelector('[role="textbox"]');
      return { text: (el?.textContent ?? '').slice(0, 300), html: (el?.innerHTML ?? '').slice(0, 500) };
    });
    report.steps.typedOk = typedOk;
    await page.screenshot({ path: path.join(outDir, `${opts.tag}-02-typed.png`) });
    if (!typedOk) throw new Error(`typing never reached the composer (state=${JSON.stringify(report.steps.typed)})`);
    const submitStart = Date.now();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    const gateOnSubmit = await dismissAllModals(page);
    if (gateOnSubmit > 0) {
      // If the gate swallowed the submit, submit again now that it is gone.
      const stillThere = await composerText(page);
      if (stillThere.trim().length > 0) {
        await page.locator('[data-composer-input]').first().click({ force: true }).catch(() => {});
        await page.keyboard.press('Enter');
      }
    }
    report.steps.submit = { pressed: 'Enter', gateOnSubmit, sentAt: new Date().toISOString() };

    // 4. Wait for the mocked assistant reply text (distinct from the user text).
    try {
      await page.waitForFunction(
        (needle) => (document.body?.innerText ?? '').includes(needle),
        opts.reply,
        { timeout: opts.timeout, polling: 200 },
      );
      report.steps.reply = { appeared: true, ms: Date.now() - submitStart };
    } catch (err) {
      report.steps.reply = { appeared: false, error: String(err).slice(0, 500) };
    }
    // Give the turn-end trigger + 250 ms quiet period + prediction round trip time.
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(outDir, `${opts.tag}-03-after-turn.png`) });

    // 5. Collect the P1 trigger fixture state.
    report.steps.fixture = await page.evaluate((reply) => {
      const anchor = document.querySelector('[data-nmp-anchor]');
      const overlayParent = anchor?.closest('[data-composer-overlay]') ?? null;
      const slotHost = anchor?.closest('[data-slot]') ?? null;
      const ghosts = [...document.querySelectorAll('[data-nmp-ghost], [data-composer-ghost]')].map((el) => ({
        attrs: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])),
        text: (el.textContent ?? '').slice(0, 300),
        rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
      }));
      const leafMatches = [...document.querySelectorAll('body *')]
        .filter((el) => el.children.length === 0 && (el.textContent ?? '').includes(reply))
        .slice(0, 10)
        .map((el) => ({
          tag: el.tagName,
          className: typeof el.className === 'string' ? el.className.slice(0, 160) : null,
          parentClassName: typeof el.parentElement?.className === 'string' ? el.parentElement.className.slice(0, 160) : null,
          text: (el.textContent ?? '').slice(0, 120),
        }));
      const sessionAttrs = [];
      for (const el of document.querySelectorAll('body *')) {
        for (const attr of el.attributes ?? []) {
          if (/session/i.test(attr.name) && sessionAttrs.length < 40) {
            sessionAttrs.push({ tag: el.tagName, name: attr.name, value: String(attr.value).slice(0, 120) });
          }
        }
      }
      const apiUrls = performance.getEntriesByType('resource')
        .map((e) => e.name)
        .filter((u) => /\/api\/|session/i.test(u))
        .slice(-40);
      const draftInput = document.querySelector('[data-composer-input]');
      return {
        anchor: anchor ? {
          text: (anchor.textContent ?? '').slice(0, 300),
          parentIsComposerOverlay: overlayParent !== null,
          slotHostAttr: slotHost?.getAttribute('data-slot') ?? null,
          rect: (() => { const r = anchor.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
        } : null,
        ghosts,
        replyLeafNodes: leafMatches,
        sessionAttrs,
        apiUrls,
        composerDraft: (draftInput?.textContent ?? '').slice(0, 300),
        predictorGlobal: (() => {
          try {
            const g = globalThis.__nextMessagePredictor;
            if (!g) return null;
            return { version: g.version ?? null, viewId: g.viewId ?? null, keys: Object.keys(g).slice(0, 40) };
          } catch { return null; }
        })(),
      };
    }, opts.reply);

    // 6. In-page Host status RPC.
    report.steps.rpcStatus = await page.evaluate(async () => {
      try {
        const response = await fetch('/api/next-message-predictor/rpc', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ schemaVersion: 1, operation: 'status' }),
        });
        const text = await response.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* keep text */ }
        return { status: response.status, ok: response.ok, json, textHead: text.slice(0, 1200) };
      } catch (err) {
        return { error: String(err).slice(0, 800) };
      }
    });

    // 7. Boot manifest / client module evidence.
    report.steps.boot = await page.evaluate(() => {
      const boot = globalThis.__DSH_BOOT__;
      return {
        hasBoot: boot !== undefined,
        bootKeys: boot && typeof boot === 'object' ? Object.keys(boot) : typeof boot,
        bootJsonHead: (() => { try { return JSON.stringify(boot).slice(0, 2000); } catch { return null; } })(),
        dshUrl: globalThis.__DSH_URL__ ?? null,
      };
    });
    report.steps.bootManifest = toJsonValue(await page.evaluate(() => globalThis.__DSH_BOOT__ ?? null));
    await writeFile(path.join(outDir, `${opts.tag}-boot-manifest.json`), JSON.stringify(report.steps.bootManifest, null, 2));
    const fullShot = path.join(outDir, `${opts.tag}-04-full.png`);
    await page.screenshot({ path: fullShot, fullPage: true });
    report.steps.screenshots = {
      composer: path.join(outDir, `${opts.tag}-01-composer.png`),
      typed: path.join(outDir, `${opts.tag}-02-typed.png`),
      afterTurn: path.join(outDir, `${opts.tag}-03-after-turn.png`),
      fullPage: fullShot,
    };

    // 8. Verdict for the P1 trigger fixture.
    const fixture = report.steps.fixture;
    const rpc = report.steps.rpcStatus;
    report.assertions = {
      replyAppeared: report.steps.reply.appeared === true,
      rpcOk: rpc?.json?.ok === true,
      anchorPresent: Boolean(fixture?.anchor),
      anchorInsideComposerOverlay: fixture?.anchor?.parentIsComposerOverlay === true,
      globalPresent: Boolean(fixture?.predictorGlobal),
      ghostRendered: (fixture?.ghosts?.length ?? 0) > 0,
    };
    report.ok = report.assertions.replyAppeared && report.assertions.rpcOk &&
      report.assertions.anchorPresent && report.assertions.globalPresent;
  } catch (err) {
    report.error = String(err?.stack ?? err).slice(0, 8000);
    report.ok = false;
    try {
      report.steps.failureScreenshot = path.join(outDir, `${opts.tag}-failure.png`);
      await page.screenshot({ path: report.steps.failureScreenshot });
    } catch { /* ignore */ }
  } finally {
    report.finishedAt = new Date().toISOString();
    const reportPath = path.join(outDir, `${opts.tag}-report.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2)).catch(() => {});
    if (!opts.keepOpen) await browser.close().catch(() => {});
    console.log(JSON.stringify({
      ok: report.ok,
      report: reportPath,
      assertions: report.assertions ?? null,
      replyAppeared: report.steps?.reply?.appeared ?? null,
      rpc: report.steps?.rpcStatus?.json ?? report.steps?.rpcStatus?.error ?? null,
      anchor: report.steps?.fixture?.anchor ?? null,
      ghosts: report.steps?.fixture?.ghosts?.length ?? 0,
      sessionAttrs: report.steps?.fixture?.sessionAttrs?.slice(0, 6) ?? null,
      error: report.error ?? null,
    }, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, fatal: String(err?.stack ?? err) }, null, 2));
  process.exit(1);
});
