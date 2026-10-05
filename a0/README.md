# A0: 가치 검증용 최소 래퍼

설계 v0.5 12.A0의 최소 래퍼입니다. Codex를 A-gate에서 검증한 격리 조건으로 실행하고, 실행마다 기록을 한 줄씩 남깁니다. 그다음 판단 제공자(Jev와 규칙 기준선)에게 실행 결과를 묻고 답을 **기록만** 합니다. Node 24만 있으면 되고, 외부 의존성은 없습니다. Windows 전용입니다.

| 파일 | 역할 |
|---|---|
| `jevcode.mjs` | CLI: 실행, 기록, 조회, review, shadow 판단, 평가 |
| `decisions.mjs` | 판단 제공자(`rules`, `jev`), 질문 세트, 상태 생성, 평가 |

## 설치 (한 번)

`C:\Github\jevcode\bin`(`jevcode.cmd`가 있는 폴더)을 사용자 PATH에 추가합니다. 추가 후 새로 여는 터미널부터 PowerShell, cmd, Git Bash 어디서든 `jevcode`를 쓸 수 있습니다.

```powershell
$bin = 'C:\Github\jevcode\bin'
$user = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($user -split ';') -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path', "$($user.TrimEnd(';'));$bin", 'User') }
```

PowerShell 프로필 방식은 Windows 보안의 "제어된 폴더 액세스"가 켜져 있으면 `Documents` 쓰기가 막혀 동작하지 않습니다.

`bin`에는 `jevcode.ps1`과 `jevcode.cmd`가 함께 있습니다. PowerShell은 `.ps1`을 먼저 쓰고, 여러 줄짜리 작업 문구를 그대로 넘깁니다. **cmd.exe에서 `jevcode.cmd`를 쓰면 여러 줄 문구가 첫 줄바꿈에서 잘립니다.** cmd에서는 한 줄로 쓰거나 `--prompt-file`을 쓰세요. run을 시작할 때 받은 작업 문구의 길이와 끝부분이 출력되니, 잘렸는지 확인할 수 있습니다.

## 실행 한 번에 하는 일

1. 저장소 잠금을 잡고 시작 snapshot을 만듭니다. snapshot은 임시 index로 만들어서 사용자의 index와 파일을 건드리지 않습니다.
2. `JobLauncher` 아래에서 `codex exec`를 hermetic 옵션과 `jevcode-run` 권한 프로필로 실행하고, 진행 상황을 표시합니다.
3. 종료 snapshot과 비교해 변경분(delta)을 계산하고, Git 메타데이터가 바뀌었는지 확인합니다.
4. 설정된 검증 명령을 같은 샌드박스와 Job 아래에서 실행합니다.
5. 기록 한 줄을 `%LOCALAPPDATA%\JevCode\a0\runs.jsonl`에 추가합니다.
6. **Shadow 판단.** 제한된 실행 상태(`runs/<id>/state.txt`)를 만들어 판단 제공자에게 세 가지를 묻고, 답을 `decisions.jsonl`에 기록합니다. 실행 결과에는 영향이 없습니다.

## 리뷰 화면 (권장)

```powershell
jevcode ui
```

브라우저에 로컬 리뷰 화면이 열립니다. 서버를 계속 띄워 두고, 실행이 끝날 때마다 "새로고침" 후 리뷰하면 됩니다.

- **대기열:** 리뷰하지 않은 실행 목록
- **상세:** 작업, 실행기의 주장, 검증 출력(stdout+stderr), 변경 파일과 실제 diff, 실행한 명령, 거부 기록, shadow 판단
- **리뷰 입력:** 수락/거절, 원인, **"이 화면만으로 결과와 원인을 설명할 수 있었나"**, 메모. 저장하면 다음 대기 실행으로 넘어갑니다.
- **수락하고 커밋:** 수락과 동시에 커밋합니다. 안전 조건은 다음과 같습니다.
  - 이 실행이 바꾼 파일만 커밋하고, 작업 폴더의 다른 변경은 건드리지 않습니다.
  - 파일 내용이 실행 종료 시점과 같을 때만 커밋합니다. 리뷰한 내용이 그대로 커밋됩니다.
  - 실행 전부터 커밋되지 않은 변경이 있던 파일, 병합·리베이스 중인 저장소는 거부합니다.
  - 커밋 메시지는 실행기의 `Commit:` 제안으로 미리 채워지고, 끝에 `Jevcode-Run: <id>`가 붙습니다.
  - push는 하지 않습니다.
- **Unity `.meta` 자동 포함:** 수락하고 커밋할 때, 이 run이 추가한 파일과 새로 만든 폴더의 `.meta`(Unity가 만든 것, 아직 추적되지 않은 것)를 함께 커밋합니다.
- **거절하고 되돌리기:** 이 run이 바꾼 것만 run 전 상태로 되돌립니다.
  - 수정한 파일은 복원하되 **파일의 원래 줄바꿈(LF/CRLF)을 유지**합니다. 그래야 되돌린 뒤 "수정됨"이 남지 않습니다.
  - 삭제한 파일은 다시 만들고, 추가한 파일은 지우면서 그 `.meta`와 비게 된 새 폴더까지 정리합니다.
  - run 이후에 고친 파일은 건드리지 않습니다. index도 건드리지 않고, 아무것도 커밋하지 않습니다.
- **정리 안 된 run이 있으면 다음 run이 멈춥니다.** 리뷰하지 않은 run, 수락했지만 커밋하지 않은 run, 거절했지만 되돌리지 않은 run이 해당합니다(파일이 아직 HEAD와 다를 때만). 터미널에서 직접 정리해도 풀립니다. 그대로 진행하려면 `jevcode run --allow-pending`. 커밋이 막히면 그 원인이 된 이전 run 번호도 보여 줍니다.
- **거절된 run과 글자까지 같은 명령은 시작 전에 멈춥니다.** 예전 명령을 잘못 다시 붙여 넣는 실수를 막습니다(공백 차이는 무시). 거절 원인이 한도·시간 초과·샌드박스·환경(`quota_or_rate_limit`, `timeout_or_cancel`, `sandbox_denial`, `environment_or_tooling`)이면 같은 명령을 다시 돌리는 게 정상이라 멈추지 않습니다. 일부러 같은 명령을 다시 돌리려면 `jevcode run --allow-rejected`. 에이전트에게는 아무것도 전달하지 않습니다.
- **리뷰 화면에도 같은 표시가 뜹니다.** `--allow-rejected`로 돌렸거나 기능 추가 전의 run이라도, 앞서 같은 명령으로 거절된 run이 있으면 리뷰 요점 맨 위에 ⚠로 보여 줍니다. "작업" 칸은 잘린 기록 대신 `prompt.txt` 전문을 보여 줍니다. 마지막 메시지의 "의존한 기존 코드" 섹션(이번에 바꾸지 않았지만 결과를 좌우하는 코드)도 리뷰 요점에 뽑아 보여 줍니다. diff만으로는 원인을 알 수 없던 run을 기록만으로 설명할 수 있게 하려는 것입니다(설계 10.2 "실패 원인 재구성").
- **직접 사용 기록:** 버튼 하나로 `bypass`
- **지표:** 우회 비율, 원인 설명 가능 비율, 리뷰 소요 시간(중앙값), 판단 제공자 평가

화면으로 리뷰하면 CLI로는 남기기 어려운 두 값이 함께 기록됩니다.
- `explainable`: 실패 원인 재구성 지표를 자동 집계합니다.
- `viewedMs`: 상세 화면을 연 시각부터 저장까지의 시간입니다. 확인 시간 지표의 근거가 됩니다.

서버는 `127.0.0.1`에서만 열리고, 실행마다 새 토큰이 붙은 주소로만 접근할 수 있습니다.

## Unity 컴파일 확인 (`--unity`)

```powershell
jevcode init --verify "dotnet test tests/Core.Tests --no-restore -m:1" --unity
jevcode check-unity     # 지금 한 번만 확인
```

켜 두면 샌드박스 검증이 끝난 뒤 jevcode가 **샌드박스 밖에서** 정해진 Unity CLI 명령만 실행합니다: `recompile` → 완료 대기 → `console_status`의 컴파일 실패 여부로 판정 → 이번 컴파일에서 새로 나온 에러를 기록. 결과는 검증 목록에 `unity: recompile + console errors (host)`로 들어가고, 리뷰 화면과 판단 제공자가 받는 상태에도 반영됩니다.

- 필요한 것: Unity CLI, 프로젝트에 `com.unity.pipeline` 패키지, **run이 끝날 때 Unity 에디터가 열려 있을 것.** 에디터 창에 포커스가 없어도 동작합니다.
- 에디터가 꺼져 있으면 실패가 아니라 `unknown`(확인 불가)으로 기록합니다.
- `eval` 같은 명령은 쓰지 않습니다. Codex는 샌드박스 안에 있어서 이 확인을 부르거나 바꿀 수 없습니다.
- Unity가 이 확인 중에 새로 만든 `.meta`는 "수락하고 커밋"이 run의 파일과 함께 커밋합니다.

## 로컬 서버 경고

run을 시작할 때 `127.0.0.1:8080`(MCP for Unity)에서 서버가 돌고 있으면 경고를 띄우고 기록에 남깁니다. run을 막지는 않습니다. **샌드박스는 이 PC 안의 로컬 서버 접속을 막지 않기 때문에**, 샌드박스 안의 명령도 그 서버에 접속할 수 있습니다(2026-09-22 확인). jevcode run 중에는 꺼 두세요.

## 사용법 (CLI)

```powershell
jevcode init --verify "npm test" --timeout-min 30   # 저장소마다 한 번. 검증이 없으면 --verify 생략
jevcode run --tag feature "점프 쿨다운 추가"          # 태그: scaffold / feature / fix / refactor / switch-cold / switch-brief
jevcode run --tag feature --prompt-file docs/runs/T17.md   # 긴 명령은 파일로 (아래 "명령 파일")
jevcode log                                          # 최근 실행
jevcode show <id>                                    # 상세 + shadow 판단 (id 앞부분만 입력해도 됨)
jevcode review <id> accept|reject [--cause <원인>] [--explainable yes|no] [메모]
jevcode bypass "긴 대화형 디버깅이라 직접 씀"          # 래퍼 없이 실행기를 직접 썼을 때
jevcode stats                                        # A0 지표
jevcode decide --all --provider jev                  # 저장된 상태로 Jev 소급 질의
jevcode eval                                         # 판단 제공자와 review 비교
```

실행 중 Ctrl+C를 누르면 Job 전체가 종료되고, 결과는 `cancelled`로 기록됩니다.

### 회귀 테스트

```powershell
node --test --test-force-exit "a0/tests/*.test.mjs"
```

임시 git 저장소와 임시 `JEVCODE_HOME`에서만 돌기 때문에 실제 A0 기록은 건드리지 않습니다. 스냅숏(추적 중인 파일이 `.gitignore`에 걸려도 유지), 자동 되돌리기와 리뷰 화면 되돌리기의 백업(`runs/<id>/restore-backup`, `revert-backup`), 평가에서 자동 리뷰 제외, 리뷰 전 shadow 답 숨김(서버 API까지), 리뷰 포인트 분리를 고정합니다.

### 환경 변수

실행기와 검증 명령에는 **필요한 이름만** 넘깁니다(`a0/env.mjs`). Windows 시스템 변수(PATH, SystemRoot, USERPROFILE, APPDATA 등), 실행기 설정 위치(CODEX_HOME, CLAUDE_CONFIG_DIR), 프록시, `DOTNET_`·`NUGET_`·`MSBUILD`·`UNITY_`로 시작하는 도구 설정만 넘어가고, `TYPESAFE_API_KEY` 같은 자격증명은 넘기지 않습니다. 접두어로 넘기는 이름이라도 KEY·TOKEN·SECRET 등이 들어 있으면 뺍니다.

Codex와 Claude Code는 사용자 폴더의 파일로 로그인하므로 API 키가 필요 없습니다. API 키로 쓰는 경우처럼 일부러 넘길 이름이 있으면 `JEVCODE_ENV_PASS`에 쉼표로 적습니다(예: `$env:JEVCODE_ENV_PASS = "OPENAI_API_KEY"`). run 기록의 `envPassed`에 넘긴 이름(값은 아님)이 남습니다.

### 명령 파일 (`--prompt-file`)

여러 줄 명령은 붙여 넣는 대신 파일로 넘기는 것을 권장합니다. cmd의 줄 잘림, 따옴표가 닫히지 않아 PowerShell이 입력을 기다리는 문제, 예전 명령을 잘못 붙여 넣는 실수를 피할 수 있습니다.

파일에 **`리뷰 포인트`로 시작하는 줄**(`## 리뷰 포인트`, `**리뷰 포인트**`, `리뷰 포인트: ...` 모두 가능)이 있으면, 그 줄부터 끝까지는 **리뷰어용 체크리스트**로 떼어 냅니다.

- 실행기에는 그 위의 작업 본문만 보냅니다(`prompt.txt`에도 본문만 남습니다). shadow 판단의 상태도 본문으로만 만들므로, 판단 제공자가 받는 입력의 종류는 그대로입니다.
- 체크리스트 항목은 `-`, `*`, `1.`, `1)` 글머리표마다 하나이고, 글머리표 없는 문단은 문단 하나가 한 항목입니다. 최대 30개입니다.
- 항목은 run 기록(`reviewPoints`)에 남고, 리뷰 화면의 판정 위에 체크박스로 나옵니다. 항목이 `[어디서]`로 시작하면(예: `[시뮬레이터]`, `[Play]`, `[리뷰 화면]`, `[근거 표]`, `[터미널]`) 그 태그가 배지로 나오고, 항목 안의 `` `명령` ``(공백이 있는 것)에는 복사 버튼이 붙습니다. 페이지에서 명령을 실행하지는 않습니다. 체크한 항목은 리뷰와 함께 `checklist`로 저장됩니다(참고용, A0 라벨이 아님).
- 작업 본문 안에서 줄을 `리뷰 포인트`로 시작하면 거기서 잘리므로, 본문에서는 그렇게 쓰지 않습니다.

```markdown
docs/ai-design.md의 '...'를 src/Core에 구현한다. ...
테스트: ...

## 리뷰 포인트
- 무대 구성 선택 규칙이 diff에서 바뀌지 않았는지
- 테스트 (d)가 무대 구성이 바뀌는 여러 교전을 실제로 돌리는지
```

## Jev shadow

**목적:** 빠른 타입 판단 모델로 코딩 에이전트의 실행을 판정하는 **방법** 자체가 유효한지 검증합니다. 특정 API가 사라져도 결론이 남도록, 모든 제공자가 같은 질문과 같은 상태에 답하고 같은 기준으로 비교됩니다.

| 질문 | 형식 | 비교 대상 |
|---|---|---|
| `review_priority` | Score 0–2 (가볍게 / 보통 / 꼼꼼히) | 단계별 거절 비율 |
| `completion` | Noul (요구 충족 확률) | 수락·거절 기준 Brier 점수 |
| `failure_cause` | Choice (7개 원인) | `review --cause` 라벨과 일치율 |

- **`rules`:** JevCode가 이미 가진 사실을 고정 규칙으로 답하는 기준선입니다. 모델은 이 기준선을 넘어야 의미가 있습니다.
- **`jev`:** [TypeSafe Jev](https://docs.typesafe.ai). 환경 변수 `TYPESAFE_API_KEY`가 있을 때만 동작합니다.
- **전송 범위:** 작업 문구, 실행과 검증 결과, 변경 파일 경로와 줄 수(내용 없음), 실행한 명령, 거부 기록, 실행기의 마지막 메시지(검증되지 않은 주장으로 표시)입니다. 코드 내용과 대화 원문은 보내지 않습니다.

**키 발급 후:**

```powershell
$env:TYPESAFE_API_KEY = "<키>"               # 또는 사용자 환경 변수로 등록
jevcode decide --all --provider jev          # 키가 없던 기간의 실행을 소급 질의
```

키가 없는 동안에도 모든 실행의 상태가 저장되므로 데이터 손실은 없습니다.

**실패·거절 review에는 `--cause`를 붙여 주세요.** Jev의 원인 분류를 평가할 정답 라벨이 됩니다.

원인 값: `none`, `verification_failed`, `sandbox_denial`, `timeout_or_cancel`, `quota_or_rate_limit`, `misunderstood_task`, `environment_or_tooling`

## A0 기간에 할 일 (2026-09-22 ~ 10-05)

- **평소 작업에 쓰기:** 쓸 만한 작업이면 `jevcode run`, 직접 쓴 경우에는 `jevcode bypass`로 남깁니다.
- **실행마다 판정:** `review`로 수락이나 거절을 기록합니다. 실패나 거절이면 `--cause`와 함께 "`show`만으로 원인을 알 수 있었나"를 메모에 적습니다.
- **전환 실험 (작업 3~5개):** 실행기 X로 중간까지 진행한 뒤, 같은 시작점에서 `--tag switch-cold`와 `--tag switch-brief --prompt-file brief.txt`로 이어갑니다.

**합격 기준**은 설계 v0.5 12.A0에 고정돼 있습니다.

| 지표 | 기준 |
|---|---|
| 우회 비율 | 50% 이하 |
| 실패 원인 재구성 | 실패·타임아웃·거절한 실행의 70% 이상을 `show`만으로 설명 가능 |
| 확인 시간 | 직접 실행 대비 "빠름" 또는 "같음" |
| 전환 실험 | H 착수만 결정 |
| Jev 방법 검증 | 설계 v0.5 10.2 |

## Codex 한도 → Claude 자동 전환

Codex 사용 한도가 걸리면 같은 명령을 Claude Code(`claude -p`)로 실행합니다.

- **시작 전:** 마지막으로 기록된 Codex 한도가 아직 풀리지 않았으면(`quota.json`) 처음부터 Claude로 시작합니다. 출력에 `agent: claude ← Codex 한도 21:53까지`처럼 표시됩니다.
- **작업 도중:** Codex가 한도 메시지와 함께 멈추면 반쯤 된 변경을 run 전 상태로 자동으로 되돌리고, 같은 명령을 Claude로 이어서 실행합니다. 끊긴 run은 **자동 거절**(`quota_or_rate_limit`, `source: auto`)과 자동 되돌리기로 기록되고, 새 run에는 `fallbackFrom`이 붙습니다. 되돌린 뒤 작업 트리가 run 전과 다르면 넘기지 않고 멈춥니다.
- **한도가 풀리는 시각:** Codex 메시지의 "try again at 9:53 PM"을 읽습니다. 못 읽으면 1시간 뒤로 둡니다. Claude는 `rate_limit_event`의 `resetsAt`을 씁니다. 둘 다 한도 상태면 시작하지 않습니다.
- **Claude run의 격리는 Codex보다 약합니다.** Windows에서는 Claude에 OS 샌드박스가 없습니다. 그래서 **실행 도구를 전혀 주지 않습니다.** `--restricted --tools Read Edit Write Glob Grep`(셸·웹 없음, 사용자·프로젝트 설정 무시, 파일 도구는 작업 폴더로 제한), `--strict-mcp-config`, `--no-session-persistence`, `--disable-slash-commands`, 자동 메모리 끔. 에이전트가 작업 중에 테스트를 돌릴 수 없고, 검증은 run이 끝난 뒤 jevcode가 Codex 샌드박스(한도와 무관)에서 한 번 합니다.
- **옵션:** `--agent codex|claude`로 강제(강제하면 자동 전환 안 함), `--no-fallback`으로 도중 전환 끄기, `--claude-model <모델>` 또는 환경 변수 `JEVCODE_CLAUDE_MODEL`(없으면 Claude Code 기본 모델).
- **Codex CLI 의존:** 검증의 격리(`codex sandbox`)는 Codex 모델을 부르지 않아 한도와 무관하지만 Codex CLI 프로그램이 있어야 합니다. run마다 Codex CLI 버전을 기록하고, A-gate 검증 버전(0.155.1)과 다르면 시작할 때 경고합니다. Codex CLI가 없으면 Claude로 진행하되 검증은 격리 없이 돌리지 않고 `unknown`으로 남깁니다.
- **Claude run에 맞는 일:** 작업 중에 테스트를 돌릴 수 없으므로, 여러 파일을 한 번에 고치는 큰 작업은 Codex 한도가 풀릴 때까지 기다리는 편이 낫습니다. 컴파일되지 않는 결과가 나와도 에이전트가 알아차리지 못하고, 검증은 run이 끝난 뒤 한 번만 하기 때문입니다. 한도가 아깝다면 `--agent codex`로 미루거나 `--no-fallback`으로 자동 전환을 끄세요.
- **한도 경고와 한도 도달은 다릅니다.** Claude는 사용률이 높아지면 경고(`allowed_warning`)를 보냅니다. 경고는 기록만 하고(`rateLimitWarnings`), 실제 거부(`rejected`)나 한도 메시지일 때만 한도로 기록합니다.
- **평가:** 실행기가 다르고 격리도 다르므로 Claude run은 Codex run과 **따로 봅니다.** `jevcode stats`에 실행기별 개수가 나오고, 리뷰 화면에 실행기와 자동 전환 여부가 표시됩니다.

## 격리 조건과 알려진 빈틈

- **격리:** `codex-win-unelevated` + `jevcode-run` 프로필(A-gate 2차 PASS-WITH-GAPS). Claude 전환 run은 OS 샌드박스 없이 실행 도구를 빼는 방식이라 더 약합니다(위 섹션).
- **hermetic 옵션:** web search, memories, apps, 하위 에이전트, 원격 플러그인, 훅을 끄고, 사용자·시스템 스킬은 `SKILL.md`마다 끕니다.
- **알려진 빈틈:**
  - 실행기가 제어 디렉터리를 읽을 수 있습니다(G1.4, elevated 전용).
  - `request_plugin_install`, MCP 리소스 조회, `image_gen` 도구가 남아 있습니다.
- **`quota_exhausted`는 아직 판정하지 않습니다.** 한도 관련으로 보이는 문구는 `quotaSignalCandidates`에 모아 둡니다.

## 확인한 동작 (2026-09-21)

| 시나리오 | 결과 |
|---|---|
| 수정 작업 + 검증 | `completed`, 검증 passed, 기존 untracked 파일은 delta에 섞이지 않음 |
| 스킬 차단 | 모델이 보고한 스킬: NONE. 첫 턴 입력 토큰이 약 26k에서 8.8k로 감소 |
| 타임아웃 | `timed_out`, 관련 프로세스 0개 |
| shadow `rules` | 실행 직후 기록, `show`와 `eval`에 표시 |
| shadow `jev` (가짜 키) | 실제 엔드포인트가 401로 응답, 오류가 데이터로 기록되고 실행에는 영향 없음 |
| review `--cause` 검증, `eval` | 동작 |
