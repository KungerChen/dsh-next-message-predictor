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
  <img src="https://img.shields.io/badge/version-0.4.0-4d6bfe" alt="version 0.4.0">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.2--rc.1-1f2937" alt="DeepSeek Harness 0.2.2-rc.1">
  <img src="https://img.shields.io/badge/languages-9-8250df" alt="languages 9">
  <img src="https://img.shields.io/badge/third--party%20deps-0-2ea44f" alt="third-party deps 0">
  <img src="https://img.shields.io/badge/tests-242%20passing-2ea44f" alt="tests 242 passing">
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

Common follow-ups are one key away. Once filled in, the text behaves like anything you typed: edit it, undo it.

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

A low-cost model by default, with daily limits on requests and tokens. Short phrases you keep repeating are offered directly, without calling the model.

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

After the assistant finishes, if the input box is empty, a grey suggestion appears exactly where you are about to type. No pop-up, no extra space taken.

<p align="center">
  <img src="docs/images/suggestion.png" width="720" alt="A grey suggestion in the input box, with “Tab accept” and “Another” on the right">
</p>

| Key | What it does |
|---|---|
| <kbd>Tab</kbd> or <kbd>→</kbd> | Fills the suggestion into the input box, where you can keep editing; <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes just that insertion |
| <kbd>Esc</kbd> | Hides the suggestion |
| <kbd>Alt</kbd>+<kbd>\\</kbd> (configurable) | Predicts right now; with a suggestion showing, switches to another one. One call brings back several alternatives, so switching is instant |
| Just type | The suggestion disappears at once; it comes back when you clear the input box |

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

### Nine interface languages

The settings page, the buttons in the input box and their tooltips are available in 简体中文, English, 日本語, 한국어, Español, Français, Deutsch, Русский, Português. By default the plugin follows the language DeepSeek Harness is set to; you can also pick one under **Settings → Prediction → Language**, and it applies at once. The suggestions themselves always follow the language of your conversation.

<p align="center">
  <img src="docs/images/languages.png" width="720" alt="The top of the settings page in English, Japanese, Spanish and Russian">
</p>

### One click away in the sidebar

Click “Add to sidebar” and an entry appears in the DSH left sidebar; after that, checking the status or switching modes no longer needs a trip to Settings. The version next to the title always tells you which release is installed.

<table>
<tr>
<td width="30%" align="center" valign="middle">
  <img src="docs/images/sidebar-entry.png" width="230" alt="The “Prediction” entry in the left sidebar">
</td>
<td width="70%" align="center" valign="middle">
  <img src="docs/images/page-header.png" width="560" alt="The version next to the page title and the “Remove from sidebar” button">
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

Requires DeepSeek Harness `0.2.2-rc.1` (`>=0.2.2-rc.1 <0.3.0`). The plugin has no third-party dependencies and needs no build step. One command installs it:

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
3. For quicker access, click “Add to sidebar” in the top right corner.

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
- “Prefer frequently used short messages” only compares the short messages you sent on this computer; no model is called.

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
| [Compatibility](docs/COMPATIBILITY.md) | The confirmed contract with DSH 0.2.2-rc.1 and the fallbacks |
| [Changelog](CHANGELOG.md) | Changes in each version |
| [Documentation index](docs/README.md) | All documents, including earlier verification and optimisation notes |

## Contributing

```powershell
npm run build   # generates lib/client.js from src/shared + src/client
npm test        # 242 unit and integration tests
npm run check   # build + test + syntax check
```

No `npm install` and no bundler; Node.js 22 or later is required. To add or correct a translation, edit `src/client/locales/<language>.js`; the tests check that every language has the same keys.

## Known limitations

- Verified on DSH `0.2.2-rc.1` only.
- Saving a setting makes the host restart the background half of the plugin; a prediction in progress is cancelled.
- Several windows share prediction results; hiding a suggestion in one window is not synchronised to the others in real time.
- The command palette and the feedback dialog are recognised by focus and modal traits; a wrong guess only means one suggestion less, never a stolen key press.

## License

Released under the [MIT License](LICENSE). The choice of extension points and the “grey suggestion + Tab to accept + Esc to hide” interaction were informed by `dsh-composer-prediction`, also MIT-licensed; none of its code was copied. See [NOTICE](NOTICE).
