<div align="center">

[简体中文](README.md) · **English** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · [Português](README.pt.md)

</div>

<p align="center">
  <img src="icon.svg" width="88" alt="">
</p>

<h1 align="center">Next Message Prediction</h1>

<p align="center">
  <b>A composer plugin for DeepSeek Harness</b><br>
  When the assistant finishes, your likely next message is already waiting in the input box.<br>
  <kbd>Tab</kbd> fills it in, <kbd>Esc</kbd> ignores it, and it <b>never sends anything for you</b>.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.6.0-4d6bfe" alt="version 0.6.0">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.2--rc.1-1f2937" alt="DeepSeek Harness 0.2.2-rc.1">
  <img src="https://img.shields.io/badge/languages-9-8250df" alt="languages 9">
  <img src="https://img.shields.io/badge/third--party%20deps-0-2ea44f" alt="third-party deps 0">
  <a href="https://github.com/KungerChen/dsh-next-message-predictor/actions/workflows/ci.yml"><img src="https://github.com/KungerChen/dsh-next-message-predictor/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="license MIT">
</p>

<p align="center">
  <img src="docs/images/demo.png" width="760" alt="Demo: after the assistant answers, a grey suggestion appears in the input box; another one is requested; Tab fills it in">
</p>

<p align="center">
  <sub>A suggestion appears → ask for another if it does not fit → <kbd>Tab</kbd> fills it in, and you can still edit before sending</sub>
</p>

---

## Why use it

When you work with an assistant, many replies are short and easy to guess: “continue”, “run the tests”, “show me the changes”. This plugin writes that follow-up ahead of time and leaves it in the input box.

<table>
<tr>
<td width="33%" valign="top">

### ⌨️ Less typing

Common follow-ups are one key away. You can edit a suggestion after inserting it.

</td>
<td width="33%" valign="top">

### 🤫 No interruptions

The moment you start typing, the suggestion steps aside. It stays away during IME composition and while a menu is open. When the model is not confident, it offers nothing.

</td>
<td width="33%" valign="top">

### 🛡️ Never oversteps

It only puts text into the input box. There is no “send message” code anywhere in the plugin; sending is always your decision.

</td>
</tr>
<tr>
<td valign="top">

### 💰 Cost under control

A low-cost model by default, with daily limits on requests and tokens. Your own phrases (the short messages you repeat and the ones you pin) are one “Another” away, cost nothing and never leave your computer.

</td>
<td valign="top">

### 🔒 Privacy first

Likely keys, tokens, e-mail addresses and phone numbers are masked before sending. The browser never uploads your draft. Local statistics store numbers, not text.

</td>
<td valign="top">

### 📊 Transparent usage

Requests, acceptance rate, response time and token usage for the last 7 days are on the settings page, so you can see whether it is worth it.

</td>
</tr>
</table>

## Features

### The suggestion is right in the input box

After the assistant finishes, if the input box is empty, a grey suggestion appears exactly where you are about to type. No pop-up, no extra space taken. In the active window, suggestions appear even when the input is unfocused by default. You can turn on “Show predictions only when the input is focused” in settings. Click the input before accepting a suggestion.

<p align="center">
  <img src="docs/images/suggestion.png" width="720" alt="A grey suggestion in the input box, with “Tab accept” and “Another” on the right">
</p>

| Key | What it does |
|---|---|
| <kbd>Tab</kbd> or <kbd>→</kbd> | Inserts the suggestion when the input is focused. You can keep editing. |
| <kbd>Esc</kbd> | Hides the suggestion |
| <kbd>Alt</kbd>+<kbd>\\</kbd> (configurable) | Predicts right now; with a suggestion showing, switches to another one. One call brings back several alternatives, so switching is instant |
| Just type | The suggestion disappears at once; it comes back when you clear the input box |
| Click “Tab accept” | Inserts the suggestion while the input is focused |

Click the pause button in the composer toolbar to pause predictions for this conversation until you resume them or restart DSH. After resuming, predict manually or wait for the next reply. Refreshing the page or saving settings retains the pause.

### Three modes, one click

Do not want to study every option? Pick a mode. You can undo it or fine-tune it afterwards.

<p align="center">
  <img src="docs/images/modes.png" width="720" alt="The mode card: Balanced, Saver, Quality">
</p>

| Mode | Predicts | Model | Context | Daily limit | Good for |
|---|---|---|---|---|---|
| **Balanced** (Recommended) | Automatically after every reply | A specific low-cost model | 12 messages | 200 requests | Everyday use |
| **Saver** | Only when you click “Predict” or press the shortcut | A specific low-cost model | 6 messages | 60 requests | Strict cost control |
| **Quality** | Automatically after every reply | The session model | 20 messages | 200 requests | Closer-fitting suggestions |

A mode only changes the trigger, the model strategy, the context size and the limits. It never touches the master switch, the shortcut, the language or the privacy options, and it keeps the model you entered.

### Your own phrases, one step away

Add the lines you send again and again (“continue”, “run the tests”) under **Settings → Prediction → Suggestion sources → Pinned phrases**, put them in the order you like, and press “Save” once. They follow the model’s suggestion: “Another” (or <kbd>Alt</kbd>+<kbd>\\</kbd>) steps through the model’s suggestion, the short messages you have repeated in this conversation and then your pinned phrases, and asks the model again only after the last one. A small mark on the button shows that a phrase is your own. They cost nothing, never leave your computer, and when a manual prediction gets nothing from the model they are offered instead of “No suggestion this time”.

<p align="center">
  <img src="docs/images/phrases.png" width="720" alt="A pinned phrase as the grey suggestion; the “Another” button carries a pin mark and the position in the list">
</p>

### Nine interface languages

The settings page, the buttons in the input box and their tooltips are available in 简体中文, English, 日本語, 한국어, Español, Français, Deutsch, Русский, Português. By default the plugin follows the language DeepSeek Harness is set to; you can also pick one under **Settings → Prediction → Language**, and it applies at once. The suggestions themselves always follow the language of your conversation.

<p align="center">
  <img src="docs/images/languages.png" width="720" alt="The top of the settings page in English, Japanese, Spanish and Russian">
</p>

### One click away in the sidebar

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

### See how much you use

<details>
<summary><b>Show the whole settings page</b> (basics, modes, suggestion sources, model, last 7 days)</summary>
<br>
<p align="center">
  <img src="docs/images/settings.png" width="640" alt="The whole settings page">
</p>
</details>

> Most screenshots show the Chinese interface. They come from a demo conversation and are generated by a script in this repository against a local mock model, which is why the model is named Mock and the numbers are small. In real use the suggestions come from the model you configured in DSH.

## Installation

The DeepSeek Harness installation range is `>=0.2.2-rc.1 <0.3.0`. The plugin has no third-party dependencies and needs no build step. One command installs it:

```powershell
dsh plugin --profile desktop add github:KungerChen/dsh-next-message-predictor
```

The name after `--profile` is the profile you use every day: `desktop` for the desktop app, `web` for the web version. Afterwards **quit DSH completely and start it again**.

<details>
<summary>The <code>dsh</code> command is not found, or you want to install from a local folder</summary>

The `dsh` command line lives in the DeepSeek Harness installation folder and can be called by its full path. To change the code yourself, clone the repository and install from the local folder:

```powershell
git clone https://github.com/KungerChen/dsh-next-message-predictor.git
$dsh = '<DSH install folder>\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add '<plugin folder>'
```

`<DSH install folder>` is where DeepSeek Harness is installed; `<plugin folder>` is the folder you just cloned.

</details>

Then three steps to get going:

1. Open **Settings → Prediction** and switch on “Enable prediction”. It is off by default: until you enable it, no suggestion is shown and no model is called.
2. Pick one under “Mode”. The default is “Balanced”.
3. For quicker access, click “Add sidebar entry” in the top right corner.

<details>
<summary>Updating and uninstalling</summary>

**Update**: if you installed from GitHub, uninstall and run the install command again; if you installed from a local folder, run `git pull` there. Then restart DSH. Refreshing the page is not enough: the page would be new while the background half is still old, and the settings page would report a version mismatch.

**Uninstall**:

```powershell
dsh plugin --profile desktop remove dsh-next-message-predictor
```

Enable only one composer-prediction plugin per profile. When another one is detected, this plugin pauses itself and says why on the settings page.

</details>

## What it sends

Each prediction is a single request to the model, with no automatic retry. It contains excerpts of the most recent **user messages and the assistant’s final text answers** in the current session: at most 12 messages and about 2,000 tokens by default.

- No tool-call arguments or output, no reasoning, no system prompt.
- Before sending, likely private keys, API keys, tokens, passwords, e-mail addresses, mobile and identity numbers, and the user name in home-folder paths are replaced with placeholders (rule-based; it cannot promise to catch everything).
- The browser page sends only session and turn identifiers, never the draft, attachments or any conversation text; the content for the model is read by the background half from DSH’s own session records.
- Your own phrases (the short messages you repeat in a session and your pinned phrases, “Pinned phrases”) stay on this computer: no model is called for them and they are never sent to the model.

The full description, and how to delete the local data, is in [Privacy and data boundaries](docs/PRIVACY.md).

## FAQ

<details>
<summary><b>Will it send a message for me?</b></summary>

No. Accepting a suggestion only puts text into the input box, through the input box’s own insertion interface; the plugin contains no call that submits or sends.

</details>

<details>
<summary><b>How much does it cost?</b></summary>

Each prediction is one very short model call (at most 96 output tokens by default). The default daily limits are 200 requests and 500,000 tokens; once reached, no more calls are made that day. To spend less, choose the “Saver” mode, which predicts only when you ask. Actual usage is shown under “Last 7 days” on the settings page.

</details>

<details>
<summary><b>Why is there sometimes no suggestion?</b></summary>

By design: when the model is not confident it offers nothing, and output that breaks the rules (too long, several lines, written in the assistant’s voice) is discarded. The state line on the settings page says why there is none right now. When you want one, press <kbd>Alt</kbd>+<kbd>\\</kbd>.

</details>

<details>
<summary><b>Are the suggestions accurate?</b></summary>

It is good at short, clear follow-ups: confirming, asking for verification, asking for details. It cannot guess what only you know, and in that case it should stay silent.

</details>

## Documentation

The detailed documentation is written in Chinese.

| Document | Contents |
|---|---|
| [User guide](docs/USER-GUIDE.md) | Keys, every item on the settings page, modes, the sidebar entry, FAQ |
| [Configuration reference](docs/CONFIGURATION.md) | Defaults and ranges of all options, the values of the three modes |
| [Privacy and data boundaries](docs/PRIVACY.md) | What is sent, local files, how to delete data |
| [Architecture](docs/ARCHITECTURE.md) | The Host and browser halves, the request flow, the protocol |
| [Development and verification](docs/DEVELOPMENT.md) | Build, tests, end-to-end verification, regenerating the screenshots |
| [Compatibility](docs/COMPATIBILITY.md) | DSH versions, test coverage and host interfaces |
| [Changelog](CHANGELOG.md) | Changes in each version |
| [Documentation index](docs/README.md) | All documents, including earlier verification and optimisation notes |

## Contributing

```powershell
npm run build   # generates lib/client.js from src/shared + src/client
npm test        # runs the unit and integration tests
npm run check   # build + test + syntax check
```

No `npm install` and no bundler; Node.js 22 or later is required. To add or correct a translation, edit `src/client/locales/<language>.js`; the tests check that every language has the same keys.

## Known limitations

- Verified in the Web UI of DSH `0.2.2-rc.1` and `0.2.2-rc.3`. Native desktop input methods and shortcuts need separate verification.
- Saving a setting makes the host restart the background half of the plugin; a prediction in progress is cancelled.
- Windows connected to the same DSH Host poll for pauses, adoption and dismissal every 800 ms when visible and every 5 seconds when hidden.
- The plugin detects pop-ups through DSH’s menu and dialog markers. Changes to these markers may affect when suggestions appear.
- The plugin restores Undo for the first accepted suggestion after sending on DSH Desktop `0.2.2-rc.3`. Other editor versions use DSH’s native Undo behavior. [Validation report](docs/VALIDATION-DISPLAY-SESSION.md)

## License

Released under the [MIT License](LICENSE). The choice of extension points and the “grey suggestion + Tab to accept + Esc to hide” interaction were informed by `dsh-composer-prediction`, also MIT-licensed; none of its code was copied. See [NOTICE](NOTICE).
