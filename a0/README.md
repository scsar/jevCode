# A0: 가치 검증용 최소 래퍼

설계 v0.4 12.A0의 최소 래퍼입니다. Codex를 A-gate에서 검증한 격리 조건으로 실행하고, 실행마다 기록을 한 줄씩 남깁니다. Node 24만 있으면 되고, 외부 의존성은 없습니다. Windows 전용입니다.

## 실행 한 번에 하는 일

1. 저장소 잠금을 잡고, 시작 snapshot을 만듭니다. snapshot은 임시 index로 만들어서 사용자의 index와 파일을 건드리지 않습니다.
2. `JobLauncher` 아래에서 `codex exec`를 hermetic 옵션과 `jevcode-run` 권한 프로필로 실행하고, 진행 상황을 표시합니다.
3. 종료 snapshot과 비교해 변경분(delta)을 계산하고, Git 메타데이터가 바뀌었는지 확인합니다.
4. 설정된 검증 명령을 같은 샌드박스와 Job 아래에서 실행합니다.
5. 기록 한 줄을 `%LOCALAPPDATA%\JevCode\a0\runs.jsonl`에 추가합니다. 기록에는 실행 결과, 검증 결과, 정책 위반 여부, delta, 실행한 명령, 거부된 동작, 토큰 사용량, 소요 시간이 들어갑니다.

## 사용법

```powershell
# 저장소마다 한 번: 필수 검증 명령과 시간 제한
node C:\Github\jevcode\a0\jev.mjs init --verify "npm test" --timeout-min 30

# 작업 실행 (--tag로 실험 조건 표시)
node C:\Github\jevcode\a0\jev.mjs run "Fix the off-by-one in pagination"
node C:\Github\jevcode\a0\jev.mjs run --tag switch-brief --prompt-file brief.txt

# 조회와 판정
node C:\Github\jevcode\a0\jev.mjs log            # 최근 실행 목록
node C:\Github\jevcode\a0\jev.mjs show <id>      # 상세 (앞부분만 입력해도 됨)
node C:\Github\jevcode\a0\jev.mjs review <id> accept|reject [이유]
node C:\Github\jevcode\a0\jev.mjs stats          # A0 지표 요약

# 래퍼를 안 쓰고 실행기를 직접 썼을 때 (우회 비율 지표)
node C:\Github\jevcode\a0\jev.mjs bypass "긴 대화형 디버깅이라 직접 씀"
```

PowerShell 프로필에 `function jev { node C:\Github\jevcode\a0\jev.mjs @args }`를 넣어 두면 `jev run ...`으로 쓸 수 있습니다. 실행 중 Ctrl+C를 누르면 Job 전체가 종료되고, 결과는 `cancelled`로 기록됩니다.

## A0 기간에 할 일 (1~2주)

**평소 작업에 쓰기.** 쓸 만한 작업이면 `jev run`을 쓰고, 직접 실행기를 쓴 경우에는 `jev bypass`로 남깁니다. 실행이 끝나면 `review`로 수락이나 거절을 기록합니다.

**전환 비용 실험 (작업 3~5개)**

1. 실행기 X(예: Claude Code 직접)로 작업을 중간까지 진행하고 멈춥니다.
2. 작업 트리를 그 상태로 두고 두 번 이어갑니다. 두 번째 전에는 `git stash -u`나 복사본으로 같은 시작점을 맞춥니다.
   - `jev run --tag switch-cold "이 작업을 이어서 해: <목표>"`
   - `jev run --tag switch-brief --prompt-file brief.txt`: 목표, 한 일, 실패한 접근, 남은 일을 10~20줄로 적습니다.
3. `jev stats`에서 태그별 토큰을 비교하고, 실패 접근을 반복했는지와 추가 설명이 필요했는지를 메모합니다.

**합격 기준 (2026-09-21 고정, 기간 2026-09-22 ~ 2026-10-05).** 자세한 판정 규칙은 설계 v0.4 12.A0에 있습니다.

| 지표 | 기준 |
|---|---|
| 우회 비율 (`jev stats`) | 50% 이하 |
| 실패 원인 재구성 | 실패·타임아웃·거절한 실행의 70% 이상을 `jev show`만으로 설명 가능 |
| 확인 시간 | 직접 실행 대비 "빠름" 또는 "같음" |
| 전환 실험 | 브리프 조건에서 실패 접근 반복이나 추가 설명이 뚜렷이 적음. H 착수만 결정함 |

실패·거절한 실행은 그때그때 "`jev show`만으로 원인을 설명할 수 있었나"를 `review`의 이유 칸에 한 줄 남겨 두면, 종료 시 집계가 쉽습니다. 예: `jev review <id> reject "원인 파악 가능: 테스트 누락"`.

## 격리 조건과 알려진 빈틈

- **격리:** `codex-win-unelevated` + `jevcode-run` 프로필(A-gate 2차 PASS-WITH-GAPS)
- **hermetic 옵션:** web search, memories, apps, 하위 에이전트, 원격 플러그인, 훅을 끕니다. 사용자·시스템 스킬(`~/.agents/skills`, `~/.codex/skills`)은 `SKILL.md`마다 끕니다.
- **알려진 빈틈:**
  - 실행기가 제어 디렉터리(`%LOCALAPPDATA%\JevCode`)를 읽을 수 있습니다(G1.4, elevated 전용).
  - `request_plugin_install`, MCP 리소스 조회, `image_gen` 도구가 남아 있습니다.
- **`quota_exhausted`는 아직 판정하지 않습니다.** 한도 관련으로 보이는 문구는 `quotaSignalCandidates`에 모아 둡니다. 실제로 한도가 소진된 실행이 생기면 그 기록으로 신호 형식을 확정합니다.
- **원시 이벤트 보존:** 결과가 `completed`가 아닌 실행만 `runs/<id>/`에 남깁니다.

## 확인한 동작 (2026-09-21)

| 시나리오 | 결과 |
|---|---|
| 수정 작업 + 검증 | `completed`, `npm test` passed, delta 1파일. 기존 untracked 파일은 delta에 섞이지 않음 |
| 스킬 차단 | 모델이 보고한 스킬: NONE. 첫 턴 입력 토큰이 약 26k에서 8.8k로 감소 |
| 타임아웃 (30초, 300초 sleep 명령) | `timed_out`, 종료 뒤 관련 프로세스 0개 |
| review / bypass / log / stats | 동작 |

Ctrl+C 취소는 래퍼에서 직접 시험하지 않았습니다. 대신 A-gate G5b에서 같은 메커니즘(런처 강제 종료 → KILL_ON_JOB_CLOSE)을 검증했습니다.
