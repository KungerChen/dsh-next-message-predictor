# P0 load verification — isolated `predictor-scratch` harness

Status: **PASS (2026-11-09)** — isolated profile, hello bundle, real bundle, browser/
CDP driver, Host route and one deterministic mock-model turn are all verified.

Everything below was executed on this machine against DSH Desktop **0.2.2-rc.1**.
The `desktop`, `web` and `headless` profiles are not modified, and the desktop
app on `127.0.0.1:59158` and the web-profile server on `127.0.0.1:3080` are left alone.

| item | value |
|---|---|
| test profile | `predictor-scratch` (`<DSH_HOME>\profiles\predictor-scratch`) |
| web instance | `http://127.0.0.1:3090/?token=<per-boot token>` |
| web PID | 115872 (`scratch/logs/web-3090.pid`) |
| mock LLM | `http://127.0.0.1:3091` (provider `mock`, model `mock-1`, reply `收到（mock-1）`) |
| repo root | `<plugin dir>` |
| evidence | `scratch/evidence/` |

> The URL token is per-boot and must be re-read after every restart:
> `Get-Content scratch\logs\web-3090.url.txt`. Without the token the server answers
> **HTTP 401**; with it the page opens and reaches the composer with **no manual login**.

---

## 1. Exact commands

All PowerShell snippets run from the repo root
(`<plugin dir>`).
CLI launcher: `<DSH install dir>\resources\runtime\cli\bin\dsh.cmd`.

### 1.1 Create / refresh the isolated profile

```powershell
# Create predictor-scratch as a fresh copy of the shipped WEB template, no boot.
# `--dump-config` composes and exits, so this is safe to run while other servers live.
& '<DSH install dir>\resources\runtime\cli\bin\dsh.cmd' `
  --profile predictor-scratch --from-default-profile web --dump-config `
  *> scratch\logs\profile-create-dump.txt
```

Resulting files (verified): `package.json`, `cordis.patch.yml`, `cordis.yml`,
`pnpm-workspace.yaml`. The composed bundles start as only
`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`, i.e. **no user MCP/QQ/desktop
config**. Re-running the same command wipes local profile changes (plugins, patch
layer); reinstall below after a refresh.

This profile needs its own model route; see §4 for the mock provider patch that is
part of this harness.

### 1.2 Install the bundles

```powershell
# P0 hello fixture (disposable; copied from the shipped decoration template)
& '<DSH install dir>\resources\runtime\cli\bin\dsh.cmd' plugin --profile predictor-scratch add `
  '<plugin dir>\scratch\hello-bundle'

# The real product bundle
& '<DSH install dir>\resources\runtime\cli\bin\dsh.cmd' plugin --profile predictor-scratch add `
  '<plugin dir>'
```

Observed behaviour of `dsh plugin --profile <p> add <abs dir>` (pnpm 11.28.5):

* dependency is recorded as **`link:`** (a junction under the profile's
  `node_modules`), **not** `file:`/copied;
* the package name is **automatically appended to `dsh.profile.bundles`** in the
  profile's `package.json` (no manual edit needed);
* the plugin's own declared dependencies are **not** installed into the profile
  (and, because the package is a junction, Node resolves its imports from the real
  workspace path — see §6.3).

Verify the composed tree (this is the authoritative check, not logs):

```powershell
& '<DSH install dir>\resources\runtime\cli\bin\dsh.cmd' `
  --profile predictor-scratch --dump-config *> scratch\logs\profile-dump-real.txt
Select-String scratch\logs\profile-dump-real.txt -Pattern 'predictor-hello|next-message-predictor|provider: mock|baseURL: http://127.0.0.1:3091'
```

Observed rows: `scratch/evidence/profile-dump-rows.txt`
(`# == predictor-hello` / `- id: predictor-hello`, `# == dsh-next-message-predictor`
/ `- id: next-message-predictor`, and the patched `llm-pi-ai` / `agent-default-model`
rows).

### 1.3 Start / stop the web instance

```powershell
# Start (or restart) the managed instance. The script strips ANSI from the log,
# waits for an advertised URL, checks HTTP 200, writes scratch\logs\web-3090.pid,
# web-3090.url.txt and prints a JSON summary.
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\launch-scratch-web.ps1 -Port 3090

# Force a restart (stop a previous managed instance on that port first)
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\launch-scratch-web.ps1 -Port 3090 -ForceRestart

# Stop exactly the PID recorded by the launcher (verifies WMI command line first;
# never touches the desktop app / web profile / other DeepSeek Harness processes)
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\stop-scratch-web.ps1 -Port 3090
```

The launcher invokes the same Electron-as-Node entry the `dsh.cmd` shim uses:

```
"<DSH install dir>\DeepSeek Harness.exe" --expose-internals
  "…\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js"
  --profile "predictor-scratch" --no-open --host "127.0.0.1" --port 3090
```

with `ELECTRON_RUN_AS_NODE=1`, `DSH_PROFILE=predictor-scratch`,
`DSH_PROFILE_DIR=…\profiles\predictor-scratch`, `MOCK_API_KEY=mock-local-e2e-key`
(placeholder for the mock route; see §4). `cli.js` lives inside `app.asar`, so the
launcher does **not** `Test-Path` it (only Electron can see it).

> Shell tip: agent/shell wrappers that track descendant processes keep the call open
> while the server lives. Start it as a **background job**
> (`run_in_background: true` in the agent tool, or just let a terminal stay attached).
> The launch JSON itself appears after ~7–9 s; boot time observed ~6.8 s.

Captured URL format: `http://127.0.0.1:3090/?token=<43-char base64url>`.
`GET /` without the token → HTTP 401. The token rotates on every boot.

### 1.4 Mock LLM (deterministic model route)

```powershell
# Start / stop / status (Node 24, no dependencies beyond node core)
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\mock-llm-control.ps1 -Action start -Port 3091 -Reply '收到（mock-1）'
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\mock-llm-control.ps1 -Action status
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\mock-llm-control.ps1 -Action stop
```

Endpoints: `POST /v1/chat/completions` (OpenAI-compatible SSE, `data: …` chunks +
`data: [DONE]`), `GET /v1/models`, `GET /health`. Every request is one
`[mock-llm] request …` line in `scratch/logs/mock-llm.out.log`.

### 1.5 Browser driver

```powershell
$u = (Get-Content scratch\logs\web-3090.url.txt -Raw).Trim()

# P0 hard proof: boot manifest module ids, hello marker, plugin globals,
# Host RPC status, anchor placement, keyboard + typing + CDP IME.
node tools\dsh-driver.mjs --url $u --out scratch\evidence --mode load-proof --tag load-proof-1

# Capability smoke only (no bundle assertions)
node tools\dsh-driver.mjs --url $u --out scratch\evidence --mode smoke --tag smoke-1

# DOM/boot inspection when selectors change
node tools\dsh-driver.mjs --url $u --out scratch\evidence --mode inspect --tag inspect-1
```

Options: `--channel chrome|edge` (default chrome), `--headful`, `--keep-open`,
`--timeout <ms>`, `--tag <name>`. Outputs `<tag>-01-ready.png`, `<tag>-02-full.png`,
`<tag>-boot-manifest.json`, `<tag>-report.json`; exit code non-zero when an assertion
fails. In-page helpers use `[data-composer-input]` (the shell's Lexical editor) and
fall back to `[role="textbox"]`.

Compatibility result: **playwright-core 1.64.1 works with Chrome
157.0.8103.38** through `chromium.launch({ executablePath:
'<path to chrome.exe>', headless: true })`.
A raw CDP session via `context.newCDPSession(page)` works, and
`Input.imeSetComposition` round-trips through the Lexical editor
(`预测测试` inserted, then cancelled back to empty). Edge
156.0.4314.58 is available as `--channel edge` but was not exercised.

### 1.6 One real mock-model turn

```powershell
$u = (Get-Content scratch\logs\web-3090.url.txt -Raw).Trim()
node tools\session-turn.mjs --url $u --out scratch\evidence --tag mock-turn-3 --reply '收到（mock-1）'
```

What it does deterministically:

1. opens the token URL (no login), waits for boot;
2. dismisses the first-run `预览版说明` gate (click `继续`) — it can appear on the
   first composer interaction, so the script handles it before and after enabling;
3. enables the composer (hero "选择工作区" state → editable `[data-composer-input]`);
4. clicks the sidebar **新会话** button so every run gets a **fresh session**
   (the shell otherwise restores the last workspace session);
5. types `请回复：收到`, presses **Enter**, waits for the mocked reply text;
6. captures the P1 trigger fixture: `[data-nmp-anchor]` inside
   `[data-composer-overlay]`, `conversation.input.overlay` slot host,
   `window.__nextMessagePredictor`, session id attrs, boot manifest, Host RPC status,
   mock-request proof and screenshots.

Observed (mock-turn-3, evidence `scratch/evidence/mock-turn-3-*`):
reply appeared in **1279 ms**; session `session-df8260d8-0df5-476d-b62e-a91000953ddc`;
assistant stream recorded in the session log as `"收"` + `"到（mock-1）"` from
`provider: mock, model: mock-1`; title generated by the same mock route.

---

## 2. P0 load proof — observed evidence

### 2.1 Server stdout / stderr (`scratch/evidence/web-3090-boot-log.txt`)

```
[predictor-hello] HOST_APPLY_OK profile=predictor-scratch row=include:predictor-hello pid=115872 time=…
[predictor-hello] IMPORT_PROBE FAIL spec=@deepseek-ai/schemastery … ERR_MODULE_NOT_FOUND
[predictor-hello] IMPORT_PROBE FAIL spec=zod … ERR_MODULE_NOT_FOUND
[next-message-predictor] service-ready enabled=false configRevision=775679865 configErrors=0 provider=fixed-test-suggestion
[next-message-predictor] host ready: route=/api/next-message-predictor/rpc enabled=false provider=fixed-test-suggestion
dsh web: http://127.0.0.1:3090/?token=…
```

`scratch/evidence/web-3090-stderr-log.txt` contains only
`[deepseek-account] … 403` lines (shared account probe) — **no**
`route unavailable` line anymore. The bundle Host half loaded both rows.

### 2.2 Client boot manifest (`scratch/evidence/boot-manifest-entries.json`)

`window.__DSH_BOOT__.entries` (the client module list the page boots) contains:

```json
{ "id": "predictor-hello", "url": "plugins/??predictor-hello/client.js&rev=9fd78c26d711", "immediately": true },
{ "id": "dsh-next-message-predictor", "url": "plugins/??dsh-next-message-predictor/client.js&rev=88924846dcb0", "immediately": true }
```

### 2.3 Client DOM markers (`scratch/evidence/dom-markers.json`)

* hello fixture: `<div data-testid="predictor-hello-marker" role="status">predictor-hello</div>`
  is present, visible, inside `data-slot="conversation.input.dock"`.
* real plugin: `[data-nmp-anchor]` is present, `parentIsComposerOverlay: true`,
  slot host `data-slot="conversation.input.overlay"` (zero-height overlay anchor at
  the composer, as designed).
* globals: `window.__PREDICTOR_HELLO__ = { loaded: true, moduleId: "predictor-hello", … }`
  and `window.__nextMessagePredictor = { version: "0.1.0-p0p1", viewId: "nmp-view-…", … }`.
* client console: `[next-message-predictor] client ready (P0/P1 interaction build, …)`;
  no page errors.

### 2.4 In-page Host RPC (`scratch/evidence/load-proof-1-report.json`)

```
POST /api/next-message-predictor/rpc
{"schemaVersion":1,"operation":"status"}
→ HTTP 200
{"operation":"status","ok":true,"value":{
  "enabled": false,
  "provider": "fixed-test-suggestion (P0/P1 no-model build)",
  "capabilities": {"connectionFetch": true, "configEditor": true,
                   "sessionStore": true, "agentRegistry": true},
  "configRevision": 775679865, "configErrors": [] …}}
```

Full assertion set from `tools/dsh-driver.mjs --mode load-proof` (all true):
`pageLoaded, composerFound, composerEditable, helloClientModuleListed,
nmpClientModuleListed, helloGlobalLoaded, helloMarkerVisible, nmpGlobalVersion,
rpcStatusOk, rpcConnectionFetch, anchorPresent, anchorInsideComposerOverlay`.

### 2.5 Loader bug found and fixed during P0 (keep for history)

The real Host half first logged
`route unavailable (connection.fetch is unavailable)` because `apply()` raced the
carrier boot. Root cause: the Cordis loader unwraps a package's **default export**
before reading plugin fields (`cordis-plugin-loader/lib/index.js` L811-817,
`exports = exports.default ?? exports`); a named `export const inject` is ignored when
the package also exports a `default` object. Fix used by the bundle:
`export default { apply, inject }` (host-only; no client rebuild). Evidence copy of the
loader source: `scratch/asar-copy/cordis-plugin-loader__lib__index.js`.

Useful UI facts discovered while proving the client half:

* the new-session composer editor is `[data-composer-input]` (Lexical,
  `contenteditable="true"`, placeholder aria-label
  `描述你想要构建的内容, / 调用指令, @ 文件或对话`);
* `[data-composer-overlay]` hosts the session-scoped
  `conversation.input.overlay` slot; the plugin's `[data-nmp-anchor]` lives there;
* `conversation.composer.dock` only renders for an existing session conversation —
  in the new-session hero state the live dock is `conversation.input.dock` (this is
  why the hello fixture registers there);
* first-run gate `预览版说明` (button `继续`) can appear on the first composer
  interaction in a fresh browser profile; automation must dismiss it.

---

## 3. Model route: what a fresh scratch profile has

* The profile composes the shipped default `agent-default-model`
  (`provider: deepseek-official, model: deepseek-flash`) and the `llm-pi-ai` adapter,
  so the UI shows a DeepSeek model selector. That route is **not usable
  deterministically** here: the `deepseek-account` platform is desktop-only
  (`desktopPlatform` is null in a web profile), the scratch page logs
  `[deepseek-account] account read failed {field: profile}`, and the server logs
  `[deepseek-account] … /auth-api/v0/users/current status: 403`. No credential was
  added to the scratch profile; no account quota was consumed.
* Therefore the harness adds a **local mock route** in the scratch profile only:

```yaml
# <DSH_HOME>\profiles\predictor-scratch\cordis.patch.yml (scratch profile only)
- id: llm-pi-ai
  config:
    providers:
      mock:
        displayName: Mock LLM (local E2E)
        api: openai-completions
        apiKeyEnv: MOCK_API_KEY
        baseURL: http://127.0.0.1:3091/v1
        models:
          - id: mock-1
            name: Mock 1
            contextWindow: 131072
            maxTokens: 8192
            input: [text]
- id: agent-default-model
  config:
    provider: mock
    model: mock-1
```

`apiKeyEnv: MOCK_API_KEY` is required even for a keyless local server (pi-ai's
OpenAI-compatible transport wants an Authorization key); the launch script sets the
placeholder `MOCK_API_KEY=mock-local-e2e-key` in the server environment. Evidence:
`scratch/evidence/scratch-profile-cordis.patch.yml`,
`scratch/evidence/scratch-profile-package.json`, `scratch/evidence/mock-llm-requests.txt`.

---

## 4. Isolation boundaries and known limitations

1. **Profile isolation is complete for config**, but `$DSH_HOME` is shared:
   `sessions`, `storages`, `credentials` and the workspace registry under
   `<DSH_HOME>` are common to every profile. Consequences:
   * the scratch sidebar shows the existing sessions/workspaces;
   * E2E turns persist session files in
     `<DSH_HOME>\sessions\<project key>\session-*`, which also
     appear in the desktop app's session list.
   Sessions created by this P0 run:
   `session-091b9296-4bd2-4b28-a5c1-dae7cbb11a1e`,
   `session-ddc40a21-19bd-436c-834d-d1399753ffd5`,
   `session-df8260d8-0df5-476d-b62e-a91000953ddc`,
   `session-402203d1-ec6e-4c73-a50a-324ad6a2998a`.
   Cleanup (only after stopping the server, only these ids):

   ```powershell
   $s = "$env:USERPROFILE\.dsh\sessions\<project key>"
   'session-091b9296-4bd2-4b28-a5c1-dae7cbb11a1e','session-ddc40a21-19bd-436c-834d-d1399753ffd5',
   'session-df8260d8-0df5-476d-b62e-a91000953ddc','session-402203d1-ec6e-4c73-a50a-324ad6a2998a' |
     ForEach-Object { Remove-Item -LiteralPath (Join-Path $s $_) -Recurse -Force }
   ```

   (P1 runs will add more; an isolated `session-persistence-jsonl.root` override is
   the follow-up fix if full data isolation is wanted.)
2. **No `Config` schema in this build — deliberate.** A linked bundle cannot resolve
   bare imports: the hello probe logged `ERR_MODULE_NOT_FOUND` for both
   `@deepseek-ai/schemastery` and `zod`, and `dsh plugin add` does not install a
   linked plugin's declared dependencies. Keep using `configEditor.edit` + plugin
   restart for settings; do not import schemastery/zod unless they are bundled.
3. **Predictions are disabled by default** (`enabled=false` in the Host status).
   `ghostRendered` was therefore false in P0; P1 must enable it through the plugin's
   Settings section / config write before asserting a ghost.
4. `dsh web` **does** run concurrently with the desktop app and the everyday web
   profile on this machine: separate process, separate profile dir, port 3090, no
   interference observed. Do not touch `3080`/`59158`.
5. Token rotation: any restart invalidates the old URL. Re-read
   `scratch\logs\web-3090.url.txt` (or `scratch\evidence\instance.json` for the
   current snapshot).
6. Browser automation is headless Chrome via playwright-core; the first-run gate
   handling is part of the drivers (`dismissAllModals`/`dismissFirstRunGate`). If a
   future build changes that dialog, update the two helpers.

---

## 5. Evidence inventory (`scratch/evidence/`)

| file | contents |
|---|---|
| `instance.json` | current URL/PID/profile/mock/evidence snapshot |
| `current-url.txt`, `current-pid.txt` | last captured URL and web PID |
| `web-3090-boot-log.txt` | server stdout: hello + Host-ready markers, URL line |
| `web-3090-stderr-log.txt` | server stderr (account 403 only; no route errors) |
| `profile-dump-rows.txt` | `--dump-config` rows proving both bundle layers and mock config |
| `scratch-profile-package.json` | profile `package.json` (link deps + bundle list) |
| `scratch-profile-cordis.patch.yml` | scratch-only mock provider patch |
| `boot-manifest-entries.json` | `__DSH_BOOT__` client entries for both bundles |
| `dom-markers.json` | hello marker, `[data-nmp-anchor]` placement, RPC capabilities |
| `load-proof-1-report.json` | full P0 driver report (assertions, keyboard, IME, RPC) |
| `load-proof-1-01-ready.png`, `load-proof-1-02-full.png` | load-proof screenshots |
| `mock-turn-3-report.json` + `mock-turn-3-0*.png` | real mock turn: reply, session id, anchor |
| `session-turn-messages.json` | persisted user + assistant messages of the mock turn |
| `mock-llm-requests.txt` | mock server request lines (turn + title generation) |
| `scratch-sessions-summary.json` | summary of the scratch-created sessions |
| `session-<id>.jsonl`, `-excerpt.txt` | decompressed session logs for the mock turn |
| `inspect-1-*`, `probe*-*.png` | early DOM reconnaissance of the landing/composer flow |
| `scratch/asar-copy/` (outside evidence) | loader source proving the default-export/inject root cause |

---

## 6. Reset / uninstall / cleanup

```powershell
# 1. Stop the test instances (never touches the desktop app or the web profile)
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\stop-scratch-web.ps1 -Port 3090
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\mock-llm-control.ps1 -Action stop

# 2. Remove test bundles from the profile (pnpm remove). Verify package.json's
#    dsh.profile.bundles no longer lists them; if a name lingers, drop that entry or
#    recreate the clean template (step 3) — an unresolvable bundle name fails boot.
& '<DSH install dir>\resources\runtime\cli\bin\dsh.cmd' plugin --profile predictor-scratch remove dsh-next-message-predictor predictor-hello

# 3. Or restore the pristine web-template profile (wipes scratch-only changes):
& '<DSH install dir>\resources\runtime\cli\bin\dsh.cmd' `
  --profile predictor-scratch --from-default-profile web --dump-config *> scratch\logs\reset-dump.txt
```

P1 quick start against the running instance:

```powershell
$u = (Get-Content scratch\logs\web-3090.url.txt -Raw).Trim()
node tools\session-turn.mjs --url $u --out scratch\evidence --tag p1-turn
node tools\dsh-driver.mjs  --url $u --out scratch\evidence --mode load-proof --tag p1-load
```

> Follow-up (2026-11-09): the load evidence above was captured while the
> plugin row used its default `enabled=false`. For P1 E2E the same scratch
> profile (and only it) seeds the row as `enabled=true` plus a fixed test
> suggestion; the Host log then shows the same `host ready ... enabled=true`
> line. The P1 editor matrix, config on/off, uninstall cleanup and zero-send
> audit are recorded in `docs/VALIDATION.md`; the compatibility matrix is
> `docs/COMPATIBILITY.md`.

