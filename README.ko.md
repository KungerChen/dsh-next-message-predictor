<div align="center">

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · **한국어** · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · [Português](README.pt.md)

</div>

<p align="center">
  <img src="icon.svg" width="88" alt="">
</p>

<h1 align="center">다음 메시지 예측</h1>

<p align="center">
  <b>DeepSeek Harness 입력창 플러그인</b><br>
  조건을 충족한 답변 뒤에 입력창에서 다음 메시지 제안을 미리 볼 수 있습니다.<br>
  입력창에 포커스를 두고 <kbd>Tab</kbd>을 누르면 기본적으로 초안에 들어갑니다.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/%EB%B2%84%EC%A0%84-0.7.0-4d6bfe" alt="버전 0.7.0">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-%3E%3D0.2.2--rc.1%20%3C0.3.0-1f2937" alt="DeepSeek Harness &gt;=0.2.2-rc.1 &lt;0.3.0">
  <img src="https://img.shields.io/badge/%EC%96%B8%EC%96%B4-9-8250df" alt="언어 9">
  <img src="https://img.shields.io/badge/%EC%99%B8%EB%B6%80%20%EC%9D%98%EC%A1%B4%EC%84%B1-0-2ea44f" alt="외부 의존성 0">
  <a href="https://github.com/KungerChen/dsh-next-message-predictor/actions/workflows/ci.yml"><img src="https://github.com/KungerChen/dsh-next-message-predictor/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/%EB%9D%BC%EC%9D%B4%EC%84%A0%EC%8A%A4-MIT-blue" alt="라이선스 MIT">
</p>

<div align="center">

[빠른 시작](#quick-start) · [제안 미리보기와 적용](#suggestions) · [대화 예측 일시 중지](#session-pause) · [예측 모드](#modes) · [개인정보와 모델 요청](#privacy) · [문서](#documentation)

</div>

<p align="center">
  <img src="docs/images/demo.png" width="760" alt="DSH 입력창의 포커스 전 미리보기, 포커스 후 제안 변경과 초안 삽입">
</p>

<a name="quick-start"></a>

## 빠른 시작

DeepSeek Harness `>=0.2.2-rc.1 <0.3.0`에 설치할 수 있습니다. GitHub에서 설치하면 빌드 단계 없이 사용할 수 있습니다.

```powershell
dsh plugin --profile desktop add github:KungerChen/dsh-next-message-predictor
```

평소 사용하는 프로필을 지정합니다(기본값은 데스크톱 `desktop`, 웹 `web`). 설치 후 **DSH를 완전히 종료한 뒤 다시 실행하세요**.

1. **설정 → 메시지 예측**을 엽니다. 처음 설치할 때 예측은 꺼져 있습니다.
2. “예측 모드”를 고른 뒤 “예측 모델”에서 DSH에 설정된 제공업체와 모델을 확인하거나 “세션 모델 따르기”을 선택합니다. 모델 입력란을 바꾸면 저장하세요.
3. “예측 사용”을 켜고 답변 뒤에 입력창을 비워 두세요. 직접 예측하려면 “예측”을 누르거나 빈 입력창에 포커스를 두고 <kbd>Alt</kbd>+<kbd>\</kbd>를 누르세요.

균형 모드와 절약 모드의 기본 지정 모델은 `deepseek-official / deepseek-flash`입니다. 다른 지정 모델을 쓰려면 DSH의 제공업체 ID와 모델 ID를 입력하세요. 지정 모델을 찾을 수 없으면 해당 예측에 사용 가능한 DSH 기본 모델이 쓰일 수 있습니다.

<details>
<summary><code>dsh</code> 명령을 찾을 수 없거나, 로컬 폴더에서 설치하고 싶은 경우</summary>

`dsh` 명령줄 도구는 DeepSeek Harness 설치 폴더 안에 있으며, 전체 경로로 호출할 수 있습니다. 코드를 직접 고치고 싶다면 먼저 클론한 다음 로컬 폴더에서 설치하세요:

```powershell
git clone https://github.com/KungerChen/dsh-next-message-predictor.git
$dsh = '<DSH 설치 폴더>\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add '<플러그인 폴더>'
```

</details>

<details>
<summary>업데이트와 제거</summary>

**GitHub 설치 업데이트**. 플러그인을 제거하고 설치 명령을 다시 실행한 다음 DSH를 완전히 종료하고 다시 여세요.

**로컬 업데이트 적용**. 먼저 로컬 플러그인 폴더의 파일을 업데이트하고 빌드합니다. 플러그인 설정에서 아직 로드하지 않은 로컬 빌드를 감지하면 “로컬 업데이트 적용”을 선택할 수 있습니다. 같은 프로필의 다른 변경된 플러그인도 다시 로드될 수 있습니다. 처음 사용하거나 적용할 수 없으면 DSH를 완전히 종료하고 다시 여세요.

**제거**:

```powershell
dsh plugin --profile desktop remove dsh-next-message-predictor
```

한 프로필에서는 입력창 예측 플러그인을 하나만 사용하세요. 같은 종류의 다른 플러그인이 감지되면 이 플러그인은 스스로 일시 중지하고 설정 페이지에 이유를 표시합니다.

</details>

<a name="suggestions"></a>

## 제안 미리보기와 적용

사용 가능한 제안은 활성 창의 빈 입력창에 회색으로 표시됩니다. 기본으로 포커스가 없어도 볼 수 있습니다. “입력창에 포커스가 있을 때만 예측 표시”를 켜면 입력창에 포커스가 있을 때만 표시됩니다. 이 옵션은 기존 제안이 표시되는 조건을 제어합니다.

<p align="center">
  <img src="docs/images/suggestion.png" width="720" alt="포커스 없는 입력창의 회색 제안과 Tab을 누르기 전에 입력창에 포커스를 두라는 안내">
</p>

| 입력창에서 할 일 | 동작 |
|---|---|
| <kbd>Tab</kbd>, 해당 버튼, 또는 커서가 처음에 있을 때 <kbd>→</kbd> | 먼저 입력창에 포커스를 둡니다. 기본적으로 제안이 초안에 들어갑니다. “Tab으로 전송”을 켜면 Tab과 해당 버튼으로 현재 제안을 전송합니다. 오른쪽 화살표는 항상 초안에만 넣습니다. 현재 제안이 유효하고 전송 조건을 충족해야 합니다. 켜기 전에 실수로 전송할 수 있다는 점을 확인하세요. |
| <kbd>Esc</kbd> | 입력창에 포커스가 있을 때 현재 제안을 숨깁니다. 이후 직접 새 예측을 요청할 수 있습니다. |
| <kbd>Alt</kbd>+<kbd>\</kbd>(변경 가능), “예측” 또는 “다른 제안” | 입력창이 비어 있을 때 예측하거나 다른 제안을 표시합니다. 단축키를 쓰려면 입력창에 포커스도 필요합니다. |
| 그냥 입력하기 | 입력을 시작하면 미리보기가 사라집니다. 초안을 지울 때 제안이 아직 유효하면 다시 표시될 수 있습니다. |

적용 후 <kbd>Ctrl</kbd>+<kbd>Z</kbd>로 실행 취소하고 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd>로 다시 실행할 수 있습니다. 0.6.0에서는 확인한 DSH Desktop `0.2.2-rc.3` 편집기에서 전송 후 첫 제안 적용의 실행 취소를 수정했습니다. 다른 편집기 버전은 DSH 자체 기록을 사용합니다. [검증 보고서](docs/VALIDATION-DISPLAY-SESSION.md)

<a name="session-pause"></a>

## 대화 예측 일시 중지

입력창 도구 모음에서 일시 중지하면 이 대화의 자동·수동 예측이 멈추고 현재 제안이 사라집니다. ▶로 재개한 뒤 직접 예측하거나 다음 답변을 기다릴 수 있습니다.

<p align="center">
  <img src="docs/images/pause.png" width="720" alt="예측이 일시 중지된 대화와 입력창 도구 모음의 재개 버튼">
</p>

같은 DSH 호스트에 연결된 창은 일시 중지 상태를 공유합니다. 페이지를 새로 고치거나 설정을 저장해도 재개하거나 DSH를 다시 시작할 때까지 유지됩니다. 제안을 적용하거나 숨기면 같은 대화의 다른 화면에서도 그 응답의 제안이 사라집니다.

<a name="modes"></a>

## 예측 모드

<p align="center">
  <img src="docs/images/modes.png" width="720" alt="모드 카드: 균형, 절약, 고품질">
</p>

| 모드 | 예측 시점 | 모델 | 최대 문맥 메시지 | 일일 요청 한도 |
|---|---|---|---|---|
| **균형** (권장) | 조건을 충족한 답변 뒤 자동 | 지정 모델 | 12 | 200 |
| **절약** | 수동으로만 | 지정 모델 | 6 | 60 |
| **고품질** | 조건을 충족한 답변 뒤 자동 | 세션 모델 | 20 | 200 |

모드는 실행 조건, 모델 선택 방식, 문맥과 한도를 바꿉니다. 전체 스위치, 단축키, 언어, 개인정보 설정과 입력한 모델 ID는 유지합니다.

### 모델 제안과 내 문구

모델 제안 뒤에 이 대화에서 반복 전송한 짧은 메시지와 고정 문구가 이어질 수 있습니다. **설정 → 메시지 예측 → 제안 출처 → 고정 문구**에서 추가하거나 순서를 바꾼 뒤 저장하세요. “다른 제안”로 기존 후보를 바꿀 때는 모델을 추가 호출하지 않습니다. 기존 후보를 다 쓰면 한도 내에서 모델에 새 요청을 보낼 수 있습니다.

수동 예측에서 쓸 수 있는 모델 결과가 없으면 저장된 문구 등을 대신 표시할 수 있습니다. 이 대체 후보를 만들 때 추가 모델 호출은 없습니다.

<p align="center">
  <img src="docs/images/phrases.png" width="720" alt="회색 제안으로 표시된 고정 문구. “다른 제안” 버튼에 핀 표시와 목록 안의 순서가 보인다">
</p>

## 설정과 사용량

플러그인은 9개 인터페이스 언어를 지원하며 기본으로 DSH를 따릅니다. 플러그인 설정의 “표시 언어”에서 화면 언어를 따로 고를 수 있습니다.

“사이드바 항목 추가”를 누르면 DSH 왼쪽 사이드바에서 메시지 예측을 열 수 있습니다. 고정을 해제한 항목은 “더 보기”에서 열거나 다시 고정할 수 있습니다. 제목 옆에는 설치된 버전이 표시됩니다.

<table>
<tr>
<td width="30%" align="center" valign="middle">
  <img src="docs/images/sidebar-entry.png" width="230" alt="왼쪽 사이드바의 “메시지 예측” 항목">
</td>
<td width="70%" align="center" valign="middle">
  <img src="docs/images/page-header.png" width="560" alt="페이지 제목과 버전 옆에 있는 사이드바 항목 버튼">
</td>
</tr>
</table>

“최근 7일”에서 요청, 표시한 제안과 적용한 제안, 응답 시간, 토큰 사용량을 확인할 수 있습니다.

<details>
<summary><b>설정 페이지 전체 보기</b> (기본, 모드, 제안 출처, 모델, 최근 7일)</summary>

<p align="center">
  <img src="docs/images/settings.png" width="640" alt="설정 페이지 전체">
</p>

<p align="center">
  <img src="docs/images/languages.png" width="720" alt="영어, 일본어, 스페인어, 러시아어로 표시한 설정 페이지 윗부분">
</p>

</details>

> 스크린샷은 격리된 웹 화면에서 합성 대화와 로컬 모의 모델로 촬영했습니다. 설정은 예시입니다. 사용량과 응답 시간은 데모 수치입니다.

<a name="privacy"></a>

## 개인정보와 모델 요청

모델 예측 시 현재 대화 분기의 최근 **사용자 메시지와 어시스턴트의 최종 답변** 일부를 DSH에 설정된 제공업체로 보냅니다. 기본 상한은 메시지 12개, 예측 지시문을 포함해 약 2000토큰입니다.

- 기본으로 직전 턴의 짧은 활동 횟수 요약을 포함합니다. 도구 인수와 출력, 추론, 시스템 프롬프트는 제외합니다.
- 규칙 기반 가리기는 기본으로 켜져 있습니다. 비밀 정보로 보이는 문자열과 일부 개인 식별자를 바꾸며 민감한 텍스트가 누락될 수 있습니다.
- 브라우저의 예측·대화 상태 요청에는 식별자와 메타데이터가 들어갑니다. 백엔드는 DSH에서 이미 전송된 메시지를 읽습니다. 초안, 첨부, 인용은 제외합니다. 로컬 통계에는 횟수, 시간, 식별자가 들어가며 대화나 제안 본문은 저장하지 않습니다.
- 로컬 제안과 고정 문구 목록은 모델 프롬프트에 추가하지 않습니다. 이미 메시지로 보낸 문구는 최근 대화 일부로 포함될 수 있습니다.

자세한 설명과 로컬 데이터를 삭제하는 방법은 [개인정보와 데이터 경계](docs/PRIVACY.md)에 있습니다.

## 자주 묻는 질문

<details>
<summary><b>왜 제안이 안 보이나요?</b></summary>

설정의 현재 상태를 확인하세요. 대화 일시 중지, 비활성 창, 초안, 열린 메뉴, IME 조합 등이 표시를 막을 수 있습니다. 모델이 쓸 만한 제안을 반환하지 않을 수도 있습니다. 대화가 조건에 맞으면 빈 입력창에 포커스를 두고 직접 예측할 수 있습니다.

</details>

<details>
<summary><b>언제 비용이 드나요?</b></summary>

실제로 호출한 제공업체와 토큰 사용량에 따라 달라집니다. 기존 후보를 바꾸거나 로컬 대체 후보를 생성할 때 모델 요청이 추가되지 않습니다. 필요한 경우에만 예측하려면 절약 모드를 쓰세요.

</details>

<a name="documentation"></a>

## 문서

0.7.0의 호환성과 검증 범위는 [릴리스와 설정](docs/RELEASE.md#release-validation-070)을 참조하세요. 자세한 문서는 중국어로 작성되어 있습니다.

| 문서 | 내용 |
|---|---|
| [사용 안내](docs/USER-GUIDE.md) | 키 조작, 설정 페이지의 모든 항목, 모드, 사이드바 항목, 자주 묻는 질문 |
| [설정 참조](docs/CONFIGURATION.md) | 모든 설정 항목의 기본값과 범위, 세 가지 모드의 값 |
| [개인정보와 데이터 경계](docs/PRIVACY.md) | 전송 범위, 로컬 파일, 데이터 삭제 방법 |
| [호환성](docs/COMPATIBILITY.md) | DSH 버전, 검증 범위 및 호스트 인터페이스 |
| [변경 기록](CHANGELOG.md) | 버전별 변경 사항 |
| [문서 색인](docs/README.md) | 이전의 검증·최적화 기록을 포함한 모든 문서 |

## 개발에 참여하기

```powershell
npm run build
npm test
npm run check
```

개발에는 Node.js 22 이상이 필요합니다. 실행 의존 패키지를 별도로 설치할 필요는 없습니다. `npm run check`로 번들, 생성된 README, 테스트 및 JavaScript 문법을 확인합니다. [개발과 검증](docs/DEVELOPMENT.md) · [아키텍처](docs/ARCHITECTURE.md)

## 라이선스

[MIT 라이선스](LICENSE)로 배포합니다. 확장 지점의 선택과 “회색 제안 + Tab으로 수락 + Esc로 숨김” 방식은 같은 MIT 라이선스의 `dsh-composer-prediction`을 참고했으며, 코드는 복사하지 않았습니다. 출처는 [NOTICE](NOTICE)를 참고하세요.
