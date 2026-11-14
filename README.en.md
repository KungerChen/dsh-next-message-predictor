<div align="center">

[简体中文](README.md) · **English** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · [Português](README.pt.md)

</div>

<p align="center">
  <img src="icon.svg" width="88" alt="">
</p>

<h1 align="center">Next Message Prediction</h1>

<p align="center">
  <b>A composer plugin for DeepSeek Harness</b><br>
  See a suggested follow-up in the composer after an eligible reply.<br>
  Focus the input and press <kbd>Tab</kbd> to fill your draft. You decide when to send it.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.6.0-4d6bfe" alt="version 0.6.0">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-%3E%3D0.2.2--rc.1%20%3C0.3.0-1f2937" alt="DeepSeek Harness &gt;=0.2.2-rc.1 &lt;0.3.0">
  <img src="https://img.shields.io/badge/languages-9-8250df" alt="languages 9">
  <img src="https://img.shields.io/badge/third--party%20deps-0-2ea44f" alt="third-party deps 0">
  <a href="https://github.com/KungerChen/dsh-next-message-predictor/actions/workflows/ci.yml"><img src="https://github.com/KungerChen/dsh-next-message-predictor/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="license MIT">
</p>

<div align="center">

[Quick start](#quick-start) · [Preview and adopt](#suggestions) · [Pause a conversation](#session-pause) · [Prediction modes](#modes) · [Privacy and model requests](#privacy) · [Documentation](#documentation)

</div>

<p align="center">
  <img src="docs/images/demo.png" width="760" alt="DSH composer preview with the input unfocused, cycling suggestions and inserting one into the draft after focusing">
</p>

<a name="quick-start"></a>

## Quick start

Installation requires DeepSeek Harness `>=0.2.2-rc.1 <0.3.0`. The GitHub package is ready to install without a build step.

```powershell
dsh plugin --profile desktop add github:KungerChen/dsh-next-message-predictor
```

Use the profile you open in DSH (`desktop` or `web` by default). Then **quit DSH completely and reopen it**.

1. Open **Settings → Prediction**. Prediction is off on a fresh install.
2. Choose a mode under “Mode”. In “Prediction model”, check that your DSH setup can use the proposed provider and model, or select “Follow the session model”. Save changes to the model fields.
3. Turn on “Enable prediction”. After the assistant replies, leave the input empty. To try it manually, click “Predict” or focus the empty input and press <kbd>Alt</kbd>+<kbd>\</kbd>.

Balanced and Saver default to `deepseek-official / deepseek-flash`. To use a different specific model, enter its DSH provider and model IDs. If DSH cannot resolve the configured model, a usable DSH default model may be used for that prediction.

<details>
<summary>The <code>dsh</code> command is not found, or you want to install from a local folder</summary>

The `dsh` command line lives in the DeepSeek Harness installation folder and can be called by its full path. To change the code yourself, clone the repository and install from the local folder:

```powershell
git clone https://github.com/KungerChen/dsh-next-message-predictor.git
$dsh = '<DSH install folder>\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add '<plugin folder>'
```

</details>

<details>
<summary>Updating and uninstalling</summary>

**Update**: if you installed from GitHub, uninstall and run the install command again; if you installed from a local folder, run `git pull` there. Then restart DSH. Refreshing the page is not enough: the page would be new while the background half is still old, and the settings page would report a version mismatch.

**Uninstall**:

```powershell
dsh plugin --profile desktop remove dsh-next-message-predictor
```

Enable only one composer-prediction plugin per profile. When another one is detected, this plugin pauses itself and says why on the settings page.

</details>

<a name="suggestions"></a>

## Preview and adopt

An available suggestion appears as grey text in the empty composer of the active window. By default it can appear while the input is unfocused. Turn on “Show predictions only when the input is focused” to display it only while the input is focused. This option controls how existing suggestions are displayed.

<p align="center">
  <img src="docs/images/suggestion.png" width="720" alt="A grey suggestion in the unfocused composer with a prompt to focus the input before pressing Tab">
</p>

| Action in the composer | What it does |
|---|---|
| <kbd>Tab</kbd>, <kbd>→</kbd> at the start, or click “Tab accept” | Focus the input first. This fills the draft so you can edit it before sending. |
| <kbd>Esc</kbd> | With focus in the input, hide the current suggestion. You can still ask for another manually. |
| <kbd>Alt</kbd>+<kbd>\</kbd> (configurable), “Predict” or “Another” | With the input empty, request a prediction or cycle through suggestions. The shortcut also requires input focus. |
| Just type | Writing a draft hides the preview. Clearing the draft can restore the same suggestion while it is still valid. |

After adopting, use <kbd>Ctrl</kbd>+<kbd>Z</kbd> to undo and <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> to redo. Version 0.6.0 fixes undo for the first adoption after sending on the editor tested with DSH Desktop `0.2.2-rc.3`. Other editor versions use DSH’s native history. [Validation report](docs/VALIDATION-DISPLAY-SESSION.md)

<a name="session-pause"></a>

## Pause a conversation

Use the pause control in the composer toolbar to stop automatic and manual prediction for this conversation and clear its current suggestion. Click ▶ to resume, then request a prediction manually or wait for a new reply.

<p align="center">
  <img src="docs/images/pause.png" width="720" alt="The composer of a paused conversation, with the control to resume predictions">
</p>

Windows connected to the same DSH host share the pause state. It survives page reloads and saving settings until you resume or restart DSH. Adopting or dismissing a suggestion also hides that turn’s suggestions in other views of the same conversation.

<a name="modes"></a>

## Prediction modes

<p align="center">
  <img src="docs/images/modes.png" width="720" alt="The mode card: Balanced, Saver, Quality">
</p>

| Mode | Predicts | Model | Max. context messages | Daily request limit |
|---|---|---|---|---|
| **Balanced** (Recommended) | Automatically after an eligible reply | Specific model | 12 | 200 |
| **Saver** | Manual only | Specific model | 6 | 60 |
| **Quality** | Automatically after an eligible reply | The session model | 20 | 200 |

Modes change when prediction runs, the model strategy, context and limits. They preserve the master switch, shortcut, language, privacy options and model IDs you entered.

### Model suggestions and your own phrases

A prediction can offer model suggestions, followed by short messages you repeated in this conversation and your pinned phrases. Add or reorder pinned phrases in **Settings → Prediction → Suggestion sources → Pinned phrases** and save. “Another” cycles through available choices without an additional model call. After the existing choices run out, asking for another may call the model, subject to the limits.

When the model has no usable result for a manual request, the plugin can offer your own phrases if available. Generating that fallback makes no additional model call.

<p align="center">
  <img src="docs/images/phrases.png" width="720" alt="A pinned phrase as the grey suggestion; the “Another” button carries a pin mark and the position in the list">
</p>

## Settings and usage

The plugin has nine interface languages. It follows DSH by default. To override it, use “Language” in the plugin settings. This setting controls the interface language.

Click “Add sidebar entry” to open Prediction from the DSH left sidebar. If you unpin the entry, you can open it or pin it again from More. The version next to the title shows which release is installed.

<table>
<tr>
<td width="30%" align="center" valign="middle">
  <img src="docs/images/sidebar-entry.png" width="230" alt="The “Prediction” entry in the left sidebar">
</td>
<td width="70%" align="center" valign="middle">
  <img src="docs/images/page-header.png" width="560" alt="The sidebar entry button next to the page title and version">
</td>
</tr>
</table>

The “Last 7 days” section shows requests, displayed and accepted suggestions, latency and token usage. Use it to check daily limits and how often suggestions are useful.

<details>
<summary><b>Show the whole settings page</b> (basics, modes, suggestion sources, model, last 7 days)</summary>

<p align="center">
  <img src="docs/images/settings.png" width="640" alt="The whole settings page">
</p>

<p align="center">
  <img src="docs/images/languages.png" width="720" alt="The top of the settings page in English, Japanese, Spanish and Russian">
</p>

</details>

> Screenshots use an isolated Web UI, a synthetic conversation and a local mock model. The settings show an example configuration. The usage and timing figures are for illustration.

<a name="privacy"></a>

## Privacy and model requests

A model prediction sends recent excerpts of **user messages and final assistant replies** from the active conversation branch to a model provider configured in DSH. The default input budget is 12 messages and about 2000 tokens, including the prediction instructions.

- A short summary of the previous turn’s activity counts is included by default. Tool arguments, tool output, reasoning and system prompts are excluded.
- Rule-based masking is enabled by default and replaces likely secrets and some personal identifiers. It can miss sensitive text.
- Prediction and session-state requests from the browser carry identifiers and metadata. The backend reads sent messages from DSH. Drafts, attachments and references are excluded. Local statistics store counts, timings and identifiers without conversation or suggestion text.
- Local candidates and the pinned-phrase list are not added to the model prompt. A phrase you already sent as a message can still appear as recent conversation context.

The full description, and how to delete the local data, is in [Privacy and data boundaries](docs/PRIVACY.md).

## FAQ

<details>
<summary><b>Why did no suggestion appear?</b></summary>

Check the current status in the settings. A paused conversation, an inactive window, a nonempty draft, a menu or active IME composition can block display. The model can also return no usable suggestion. Try manual prediction from the focused, empty input when the conversation is eligible.

</details>

<details>
<summary><b>When are requests charged?</b></summary>

Usage depends on the model provider and the tokens used in each dispatched request. Cycling through existing choices and building a local fallback add no model request. Use Saver mode to request predictions only when you need one.

</details>

<a name="documentation"></a>

## Documentation

The detailed documentation is written in Chinese.

| Document | Contents |
|---|---|
| [User guide](docs/USER-GUIDE.md) | Settings, keyboard controls, modes and troubleshooting |
| [Configuration reference](docs/CONFIGURATION.md) | Defaults and ranges of all options, the values of the three modes |
| [Privacy and data boundaries](docs/PRIVACY.md) | What is sent, local files, how to delete data |
| [Compatibility](docs/COMPATIBILITY.md) | Supported installation range, tested hosts and native editor behavior |
| [Changelog](CHANGELOG.md) | Changes in each version |
| [Documentation index](docs/README.md) | All documents, including earlier verification and optimisation notes |

## Contributing

```powershell
npm run build
npm test
npm run check
```

Development requires Node.js 22 or later. The repository has no runtime dependencies to install. `npm run check` checks the bundle, generated READMEs, tests and JavaScript syntax. [Development and verification](docs/DEVELOPMENT.md) · [Architecture](docs/ARCHITECTURE.md)

## License

Released under the [MIT License](LICENSE). The choice of extension points and the “grey suggestion + Tab to accept + Esc to hide” interaction were informed by `dsh-composer-prediction`, also MIT-licensed; none of its code was copied. See [NOTICE](NOTICE).
