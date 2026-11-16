<div align="center">

{{langbar}}

</div>

<p align="center">
  <img src="icon.svg" width="88" alt="">
</p>

<h1 align="center">{{title}}</h1>

<p align="center">
  <b>{{product}}</b><br>
  {{tagline1}}<br>
  {{tagline2}}
</p>

<p align="center">
{{badges}}
</p>

<div align="center">

[{{inst_h}}](#quick-start) · [{{f1_h}}](#suggestions) · [{{pause_h}}](#session-pause) · [{{f2_h}}](#modes) · [{{send_h}}](#privacy) · [{{docs_h}}](#documentation)

</div>

<p align="center">
  <img src="docs/images/demo.png" width="760" alt="{{demo_alt}}">
</p>

<a name="quick-start"></a>

## {{inst_h}}

{{inst_p}}

```powershell
dsh plugin --profile desktop add github:{fact:repo}
```

{{inst_profile}}

1. {{s1}}
2. {{s2}}
3. {{s3}}

{{route_note}}

<details>
<summary>{{inst_d_sum}}</summary>

{{inst_d_p}}

```powershell
git clone https://github.com/{fact:repo}.git
$dsh = '<{{ph_dsh}}>\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add '<{{ph_plugin}}>'
```

</details>

<details>
<summary>{{upd_sum}}</summary>

{{upd_p}}

{{upd_local}}

{{unin}}

```powershell
dsh plugin --profile desktop remove {fact:package}
```

{{conflict}}

</details>

<a name="suggestions"></a>

## {{f1_h}}

{{f1_p}}

<p align="center">
  <img src="docs/images/suggestion.png" width="720" alt="{{f1_alt}}">
</p>

| {{k_th1}} | {{k_th2}} |
|---|---|
| {{k1a}} | {{k1b}} |
| {{k2a}} | {{k2b}} |
| {{k3a}} | {{k3b}} |
| {{k4a}} | {{k4b}} |

{{undo}}

<a name="session-pause"></a>

## {{pause_h}}

{{f1_pause}}

<p align="center">
  <img src="docs/images/pause.png" width="720" alt="{{pause_alt}}">
</p>

{{f1_sync}}

<a name="modes"></a>

## {{f2_h}}

<p align="center">
  <img src="docs/images/modes.png" width="720" alt="{{f2_alt}}">
</p>

| {{m_th1}} | {{m_th2}} | {{m_th3}} | {{m_th4}} | {{m_th5}} |
|---|---|---|---|---|
| **{ui:preset.balanced.name}** ({ui:preset.recommended}) | {{m_auto}} | {{m_fixed}} | {fact:balanced_messages} | {fact:balanced_requests} |
| **{ui:preset.saver.name}** | {{m_manual}} | {{m_fixed}} | {fact:saver_messages} | {fact:saver_requests} |
| **{ui:preset.quality.name}** | {{m_auto}} | {{m_session}} | {fact:quality_messages} | {fact:quality_requests} |

{{f2_note}}

### {{fp_h}}

{{fp_p}}

{{fp_fallback}}

<p align="center">
  <img src="docs/images/phrases.png" width="720" alt="{{fp_alt}}">
</p>

## {{settings_h}}

{{fl_p}}

{{f3_p}}

<table>
<tr>
<td width="30%" align="center" valign="middle">
  <img src="docs/images/sidebar-entry.png" width="230" alt="{{f3_alt1}}">
</td>
<td width="70%" align="center" valign="middle">
  <img src="docs/images/page-header.png" width="560" alt="{{f3_alt2}}">
</td>
</tr>
</table>

{{usage}}

<details>
<summary>{{f4_sum}}</summary>

<p align="center">
  <img src="docs/images/settings.png" width="640" alt="{{f4_alt}}">
</p>

<p align="center">
  <img src="docs/images/languages.png" width="720" alt="{{fl_alt}}">
</p>

</details>

> {{shots}}

<a name="privacy"></a>

## {{send_h}}

{{send_p}}

- {{sb1}}
- {{sb2}}
- {{sb3}}
- {{sb4}}

{{send_more}}

## {{faq_h}}

<details>
<summary><b>{{q1}}</b></summary>

{{a1}}

</details>

<details>
<summary><b>{{q2}}</b></summary>

{{a2}}

</details>

<a name="documentation"></a>

## {{docs_h}}

{{docs_note}}

| {{d_th1}} | {{d_th2}} |
|---|---|
| [{{d1}}](docs/USER-GUIDE.md) | {{d1c}} |
| [{{d2}}](docs/CONFIGURATION.md) | {{d2c}} |
| [{{d3}}](docs/PRIVACY.md) | {{d3c}} |
| [{{d6}}](docs/COMPATIBILITY.md) | {{d6c}} |
| [{{d7}}](CHANGELOG.md) | {{d7c}} |
| [{{d8}}](docs/README.md) | {{d8c}} |

## {{dev_h}}

```powershell
npm run build
npm test
npm run check
```

{{dev_p}} [{{d5}}](docs/DEVELOPMENT.md) · [{{d4}}](docs/ARCHITECTURE.md)

## {{lic_h}}

{{lic_p}}
