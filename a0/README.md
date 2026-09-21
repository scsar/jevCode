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

## 실행 한 번에 하는 일

1. 저장소 잠금을 잡고 시작 snapshot을 만듭니다. snapshot은 임시 index로 만들어서 사용자의 index와 파일을 건드리지 않습니다.
2. `JobLauncher` 아래에서 `codex exec`를 hermetic 옵션과 `jevcode-run` 권한 프로필로 실행하고, 진행 상황을 표시합니다.
3. 종료 snapshot과 비교해 변경분(delta)을 계산하고, Git 메타데이터가 바뀌었는지 확인합니다.
4. 설정된 검증 명령을 같은 샌드박스와 Job 아래에서 실행합니다.
5. 기록 한 줄을 `%LOCALAPPDATA%\JevCode\a0\runs.jsonl`에 추가합니다.
6. **Shadow 판단.** 제한된 실행 상태(`runs/<id>/state.txt`)를 만들어 판단 제공자에게 세 가지를 묻고, 답을 `decisions.jsonl`에 기록합니다. 실행 결과에는 영향이 없습니다.

## 사용법

```powershell
jevcode init --verify "npm test" --timeout-min 30   # 저장소마다 한 번. 검증이 없으면 --verify 생략
jevcode run --tag feature "점프 쿨다운 추가"          # 태그: scaffold / feature / fix / refactor / switch-cold / switch-brief
jevcode log                                          # 최근 실행
jevcode show <id>                                    # 상세 + shadow 판단 (id 앞부분만 입력해도 됨)
jevcode review <id> accept|reject [--cause <원인>] [메모]
jevcode bypass "긴 대화형 디버깅이라 직접 씀"          # 래퍼 없이 실행기를 직접 썼을 때
jevcode stats                                        # A0 지표
jevcode decide --all --provider jev                  # 저장된 상태로 Jev 소급 질의
jevcode eval                                         # 판단 제공자와 review 비교
```

실행 중 Ctrl+C를 누르면 Job 전체가 종료되고, 결과는 `cancelled`로 기록됩니다.

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

## 격리 조건과 알려진 빈틈

- **격리:** `codex-win-unelevated` + `jevcode-run` 프로필(A-gate 2차 PASS-WITH-GAPS)
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
