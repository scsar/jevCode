# JevCode System Design

**Version:** 0.5  
**Status:** Jev를 판단 계층으로 복원하고 A0 shadow 검증을 추가한 설계 초안  
**Date:** 21 September 2026  
**Implementation:** TypeScript / Node.js, 단일 패키지 + Windows 런처 헬퍼(C#)  
**Initial platform:** Windows 11 네이티브 (WSL2 제외)  
**Previous version:** [v0.4](JevCode_System_Design_v0.4.md) · 변경 근거: [v0.5 changelog](JevCode_v0.5_changelog.md), [v0.4 changelog](JevCode_v0.4_changelog.md) · 실험: [spikes/a-gate](../../spikes/a-gate/README.md)

## 1. 제품 방향

JevCode는 기존 코딩 에이전트(Codex, Claude Code)를 격리된 프로필로 실행하고, 실행 기록과 검증 결과를 한곳에서 확인하는 개인용 로컬 CLI다. 실행 결과에 대한 판단(리뷰 우선순위, 완료 여부, 실패 원인, 다음 실행기)은 **빠른 타입 판단 모델**에 묻는다. 첫 판단 모델은 TypeSafe의 Jev다.

가설은 세 가지이며 모두 측정으로 확인한다(단계 A0).

1. **확인·추적:** 기존 실행기를 직접 쓰는 것보다 결과를 확인하고 실패를 추적하기 편한가.
2. **작업 연속성:** 한 실행기의 사용 한도가 소진되거나 실패해 다른 실행기로 넘어갈 때, JevCode의 관측 기록이 재설명·실패 접근 반복·재탐색을 줄이는가.
3. **판단 계층 (방법 검증):** 빠른 타입 판단 모델이 실행 기록만 보고 내린 판단이 규칙 기준선보다 사용자의 실제 판정에 가까운가. 검증 대상은 특정 API가 아니라 **방법**이다. Jev API가 사라져도 결론이 유효하도록 판단 제공자를 인터페이스 뒤에 두고, 같은 질문·같은 상태·같은 기준으로 비교한다(10절).

토큰 절약은 2의 부수 효과로만 측정한다. 입력 토큰의 대부분은 매 턴 재전송되는 대화 맥락이므로(12.A0 참고), 전환 시 재탐색 절약만으로 효용을 주장하지 않는다.

판단은 A0와 B에서 **shadow**로만 쓴다. 기록만 하고 실행·수락·전환을 자동으로 바꾸지 않는다. 판단을 흐름에 반영하는 것(예: 리뷰 대기열 정렬)은 10.3의 승격 조건을 통과한 뒤다.

### 1.1 v0.4에서 조정한 사항 (v0.5)

| 항목 | v0.5 방향 |
|---|---|
| Jev의 위치 | 조건부 연구 트랙(R)에서 **판단 계층**으로 복원. A0부터 shadow 기록 |
| 판단 제공자 | `rules` 기준선 + `jev`. 같은 질문 세트(버전 관리), 같은 제한 상태 |
| 키 없는 기간 | 실행마다 제한 상태를 저장하고, 키 발급 후 `jevcode decide`로 소급 질의 |
| 평가 | `jevcode eval`: review 대비 Brier·우선순위별 거절률·원인 일치율. 합격 기준 사전 고정(10.2) |
| CLI 이름 | A0 래퍼 명령을 `jev`에서 `jevcode`로 변경(모델 이름과 혼동 방지) |

### 1.2 v0.3에서 조정한 사항 (v0.4)

| 항목 | v0.4 방향 |
|---|---|
| A-gate 1차 | `codex-win-unelevated`가 전 항목 통과(codex-cli 0.155.1). A0 시작 가능 |
| 첫 프로필 | unelevated로 A0 시작. elevated는 설치 후 별도 A-gate, 통과 시 전환 |
| 커스텀 권한 프로필 | `:workspace` 대신 `jevcode-run`: 실제 `%TEMP%` 쓰기 차단, 실행별 temp 제공. 제어 디렉터리 읽기 차단은 elevated 전용 |
| 강제 수단 표기 | capability마다 OS 강제 / 앱 내부 강제 / 관측만을 구분 |
| 남은 도구면 | hermetic 설정 후에도 남는 도구를 목록으로 관리. B 전에 차단 또는 경계 검증 |
| 런처 헬퍼 | Windows 기본 `csc.exe`로 빌드하는 C# exe로 확정 |
| 검증 러너 격리 | `codex sandbox -P jevcode-run`으로 확정 |
| 인계 | `quota_exhausted` 결과·토큰 사용량 기록 추가, A0에서 전환 비용 측정. 구현은 조건부 단계 H |
| 공용 메모리 | 프로젝트 지식은 사용자 리뷰를 거친 `AGENTS.md`, 작업별 인계는 제어 디렉터리에서 생성 |

### 1.3 설계 기본값

- 실행마다 프로세스 하나를 생성하고 자동 retry·continue·switch는 하지 않는다.
- SQLite에 정규화된 실행 기록을 저장한다. 드라이버는 단계 B 시작 시 선택한다.
- 판정은 파일·프로세스 상태로 한다. 종료 코드는 증거가 아니다(샌드박스가 쓰기를 거부해도 PowerShell은 exit 0으로 끝난다).

## 2. 범위와 출시 단계

| 단계 | 포함 | 합격 조건 | 상태 |
|---|---|---|---|
| A-gate | 프로필별 안전 스모크 검사 | 12.A-gate 전 항목 통과 | unelevated 2차 PASS-WITH-GAPS (G1.4 미지원) |
| A0: 가치 검증 | 최소 래퍼 실사용 + 전환 비용 실험 + 판단 shadow | 12.A0, 10.2의 사전 정의 지표 | 2026-09-22 ~ 10-05 |
| A: 호환성 검증 | 이벤트·종료·Job·quota 신호·남은 도구면·두 번째 프로필 | 프로필별 capability 보고서 | 일부 완료 |
| B: 개인용 MVP | 한 실행기 수동 실행, 기록, 취소, 검증, inspect | 12.B 필수 시나리오 | |
| C: 공통 계약 검증 | 두 번째 실행기(Claude Code) | 실행기 이름별 분기 없이 같은 계약 통과 | |
| H: 수동 인계 | `jevcode handoff` | 12.H 시작 조건 충족 시에만 착수 | 조건부 |
| J: 판단 승격 | shadow 판단을 흐름에 반영(리뷰 정렬, 인계 대상 추천) | 10.3 승격 조건 | A0 결과 후 |
| F: 선택적 확장 | 세 번째 실행기, 세션 재개, worktree | 필요성과 안전성 별도 검증 | |

A-gate를 통과한 프로필로만 실제 작업을 수행한다. A0 결과가 나쁘면 B의 범위를 줄이거나 흐름을 다시 설계한 뒤 착수한다. 판단 shadow는 A0부터 계속 기록하고, 승격(J)은 10.3 조건으로만 결정한다.

MVP에는 auto 모드, 판단에 따른 자동 완료 승인·자동 인계, 병렬 실행, 자동 병합, WSL2·크로스 플랫폼 지원, 비용 최적화 라우터, 학습 기능을 넣지 않는다.

## 3. 아키텍처와 책임

```text
CLI
 └─ Runtime controller ──────────── Control data dir (workspace 밖, 실행기 read/write deny)
     ├─ Workspace preflight / snapshot / single-writer lock   ├─ SQLite
     ├─ Executor adapter ── JobLauncher.exe ── Executor       ├─ lock
     ├─ Verification runner ── JobLauncher.exe ── codex sandbox ── command
     ├─ Handoff brief builder (단계 H)                        ├─ evidence ring buffer
     ├─ Decision layer ── rules | Jev (shadow)                ├─ run state, decisions
     └─ Store                                                 └─ policy snapshot, run temp
```

| 구성요소 | 책임 |
|---|---|
| CLI | 사용자 입력, 진행 표시, 취소, 실행 결과 조회 |
| Controller | 상태 전이, 실행 예산, 잠금, snapshot, 종료 확인. 제어 디렉터리의 유일한 접근자 |
| Adapter | 버전별 실행 인자, 격리 프로필, capability 검사, 이벤트·토큰 사용량·quota 신호 변환 |
| JobLauncher | suspended 생성 → Job 편입 → resume, KILL_ON_JOB_CLOSE, Job 내 PID 기록 |
| Verification runner | 사전 승인된 검증 명령을 `jevcode-run` 프로필 샌드박스에서 실행하고 직접 관측 기록 |
| Handoff brief builder | 관측 기록에서 인계 브리프를 모델 호출 없이 생성 (단계 H) |
| Decision layer | 제한 상태를 만들어 판단 제공자에게 타입 질문을 하고 답·확률·지연을 기록 (10절). 실행 흐름을 바꾸지 않음 |
| Store | 실행·시도·이벤트·검증·사용자 판정의 일관된 저장 |

## 4. MVP 사용자 흐름

```text
jevcode init
jevcode doctor
jevcode run "Fix the bounded bug"
jevcode inspect <run-id>
jevcode review <run-id> accept|reject [--cause <cause>]
jevcode decide <run-id>|--all [--provider jev]   # 판단 소급 질의
jevcode eval                                     # 판단 제공자 대 review
jevcode handoff <run-id> --agent claude          # 단계 H, 조건부
```

1. `init`에서 실행기, 작업 유형, 필수 검증 명령, 시간 제한을 설정한다.
2. `doctor`가 설치 버전, 격리 프로필, capability와 강제 수단 종류를 표시한다.
3. `run`이 잠금을 잡고, 시작 snapshot(6.1)과 실행별 temp 디렉터리를 만들고, 격리 프로필을 확인한다.
4. JobLauncher로 실행기를 시작하고 이벤트·토큰 사용량을 정규화해 저장한다.
5. 종료 또는 취소 후 Job 내 프로세스가 모두 사라졌는지 확인한다.
6. snapshot 대비 delta와 Git 메타데이터 변화를 수집하고 필수 검증을 수행한다.
7. 실행 결과, 검증 상태, 미확인 사항을 출력하고 종료한다.
8. 판단 계층이 제한 상태로 shadow 판단을 기록한다(10절).
9. 사용자는 나중에 `review`로 수락 또는 거절과 실패 원인 라벨을 기록한다. review 자체는 코드를 수정하지 않는다.
10. **커밋은 사람이 리뷰 화면에서 "수락하고 커밋"을 명시적으로 누를 때만 한다.** 대상은 해당 run의 변경 파일뿐이다. 각 파일의 현재 내용이 run 종료 스냅샷과 같아야 하고(리뷰한 내용 = 커밋되는 내용), run 전부터 커밋되지 않은 변경이 있던 파일과 병합·리베이스 중인 저장소는 거부한다. 커밋 메시지에 `Jevcode-Run: <id>` 트레일러를 붙이고, push·되돌리기는 하지 않는다. 에이전트와 자동화는 커밋하지 않는다.

## 5. 권한과 지원 범위

### 5.1 격리 프로필

| 프로필 | 강제 수단 | 셸 | 상태 |
|---|---|---|---|
| `codex-win-unelevated` | Codex Windows restricted-token 샌드박스 + `jevcode-run` 권한 프로필 | 허용 | **A-gate 1차 통과** (codex-cli 0.155.1). 샌드박스 프로세스는 사용자 본인 계정으로 실행 |
| `codex-win-elevated` | Codex Windows elevated 샌드박스(전용 샌드박스 사용자) + `jevcode-run` | 허용 | 미검사. 1회 관리자 설치 필요. 다른 사용자로 실행되므로 Job containment를 별도 검사 |
| `claude-restricted` | `--restricted --strict-mcp-config` | 불가 | 미검사 |

G1.4 빈틈(제어 디렉터리 읽기)을 수용하면 A0는 `codex-win-unelevated`로 시작한다(14절). elevated가 A-gate를 통과하면 격리가 더 강한 elevated로 전환한다. 한 방식의 결과를 다른 방식에 적용하지 않는다.

### 5.2 `jevcode-run` 권한 프로필

기본 `:workspace` 프로필에는 두 가지 빈틈이 있다(A-gate 2차 기준선에서 확인). 실제 `%TEMP%`에 쓸 수 있고, 작업 트리 밖 읽기가 허용되어 제어 디렉터리를 읽을 수 있다. 그래서 JevCode는 실행마다 커스텀 프로필 `jevcode-run`을 `-c` 인라인 TOML로 주입한다.

```text
-c "permissions={jevcode-run={extends=':workspace',filesystem={':tmpdir'='read','<run temp>'='write'[,'<control dir>'='deny']}}}"
-P jevcode-run                          # codex sandbox
-c default_permissions=jevcode-run      # codex exec (-s 대신)
```

- 경로는 TOML 리터럴 문자열(작은따옴표)로 쓴다. 기본 문자열(큰따옴표)에서는 `C:\Users`의 `\U`가 이스케이프로 해석되어 파싱이 실패하고, 값 전체가 문자열로 취급된다.
- `':tmpdir'='read'`로 실제 `%TEMP%` 쓰기를 막는다. `deny`는 읽기 제한이어서 unelevated에서 쓸 수 없다.
- 실행기와 검증 명령에는 `TEMP`/`TMP`를 실행별 temp 디렉터리로 지정해 전달한다(부모 환경 변수가 샌드박스로 전달됨). 이 상태에서 git, node, `npm test`가 정상 동작한다(G1.5). 실행별 temp는 실행 종료 후 컨트롤러가 삭제한다.
- **제어 디렉터리 읽기 차단은 elevated에서만 가능하다.** unelevated에서 읽기 deny 규칙을 넣으면 `Restricted read-only access requires the elevated Windows sandbox backend` 오류로 실행이 거부된다. 따라서 unelevated 프로필에는 제어 디렉터리 규칙을 넣지 않고, G1.4를 `unsupported`로 보고한다.

### 5.3 강제 수단 표기

capability마다 값(`verified` / `unsupported` / `unknown`)과 함께 **강제 주체**를 기록하고 `doctor`에 표시한다.

| 강제 주체 | 의미 | 예 (A-gate 1차) |
|---|---|---|
| `os` | OS 수준 샌드박스·Job Object | 셸 명령의 밖 쓰기 거부, `.git` 쓰기 거부, 명령 네트워크 차단, Job containment |
| `app` | 실행기 앱 내부 검사. 설정에 의존 | `apply_patch`의 밖 쓰기 거부: `patch rejected: writing outside of the project; rejected by user approval settings` |
| `observed` | 막지 못하고 사후 관측만 가능 | Git 메타데이터 지문 비교 |

`app` 강제는 해당 설정이 고정될 때만 유효하다. `apply_patch` 경계는 `approval_policy=never`에 의존하므로 이 값은 hermetic 인자에서 바꿀 수 없는 고정값이다.

### 5.4 Hermetic 실행

Codex 고정 인자 (A-gate 1차에서 사용하고 검증한 조합):

```text
codex exec --ephemeral --ignore-user-config --ignore-rules --json -s workspace-write
  -c windows.sandbox=<mode> -c approval_policy=never -c web_search=disabled
  -c history.persistence=none -c features.memories=false -c apps._default.enabled=false
  -c sqlite_home=<run state dir> -c log_dir=<run state dir>
```

이 조합으로 web search는 실제로 꺼졌고, 실행 후 `~/.codex`와 재지정 디렉터리 모두에 실행 흔적(nonce)이 남지 않았다.

**A0 래퍼에서 추가한 옵션** (`a0/jevcode.mjs`):

```text
  -c agents.enabled=false -c features.multi_agent=false -c features.remote_plugin=false
  -c features.hooks=false -c features.skill_mcp_dependency_install=false
  -c "skills.config=[{path='<...>\SKILL.md',enabled=false}, ...]"
```

- **사용자·시스템 스킬은 `--ignore-user-config`로 막히지 않는다.** 첫 A0 실행에서 모델이 `~/.agents/skills/surgical-patch/SKILL.md`를 읽고 따랐다. 스킬 전체를 끄는 키는 없고, `skills.config`에서 `SKILL.md` 파일 경로마다 `enabled=false`를 줘야 한다(폴더 경로로는 꺼지지 않음). JevCode는 `~/.agents/skills`와 `~/.codex/skills`(`.system` 포함)를 실행마다 훑어 전부 끈다. 저장소 수준 스킬은 저장소 내용이므로 유지한다.
- 이렇게 한 뒤 모델이 보고한 스킬 목록은 NONE이었고, `spawn_agent` 계열 도구도 사라졌다.
- 부수 효과로 도구 설명 토큰이 줄었다. 거의 같은 요청에서 첫 턴 입력 토큰이 약 26k에서 8.8k로 줄었다(A0 기준선 해석 시 참고).

**남은 도구면:** 위 설정 뒤에도 모델이 보고한 도구 목록에 다음이 남았다. 모델의 자기 보고이므로 A에서 실제 동작을 확인한다.

| 도구 | 우려 | B 전 처리 |
|---|---|---|
| ~~`spawn_agent` 등 협업 도구~~ | | `agents.enabled=false`로 제거됨 |
| `request_plugin_install`, `list_available_plugins_to_install` | 설치가 샌드박스 밖에서 일어나는지 | `approval_policy=never`에서 거부되는지 확인 |
| `image_gen` | 외부 서비스 호출 | 끄는 설정을 찾거나 허용 목록에 명시 |
| MCP 리소스 조회 | MCP 서버가 없으면 무해한지 | 서버 0개에서 빈 결과인지 확인 |

B 착수 전에 각 도구를 끄거나, 경계를 넘지 못함을 검증하거나, 허용 목록에 명시한다. 셋 다 불가하면 `codex app-server`로 도구 allowlist를 직접 통제하는 방식을 비교한다.

### 5.5 보호 경로

- **Git 메타데이터는 불변 경계다.** `.git` 쓰기는 `:workspace` 계열 프로필이 OS 수준에서 막는다(A-gate G2: commit, update-ref, refs/config/HEAD 직접 쓰기 모두 차단). 시작·종료 시 HEAD, refs, index, config 지문을 비교해 이중 확인한다. index는 파일 바이트가 아니라 **항목 내용(`git ls-files --stage`)**으로 비교한다. 사람이나 에디터가 `git status`를 실행하면 index의 stat 캐시만 다시 쓰여 바이트가 바뀌기 때문이다. 이 수정 전의 run `20260922-120718-1f7f`(T4 retry)는 run 도중 `git status` 때문에 `policyStatus=violated`가 기록된 **오탐**이며, 정책 위반 지표에서 제외한다.
- **제어 디렉터리**는 `%LOCALAPPDATA%\JevCode`에 두고 `jevcode-run` 프로필에서 deny한다.
- push·배포·외부 메시지 전송은 지원 범위에서 제외한다. 명령 네트워크 차단은 A-gate GN에서 확인됐다.

### 5.6 데이터 경계

- 환경 변수는 실행에 필요한 이름만 전달한다. 자격증명을 복사하지 않는다.
- **원시 기록은 JevCode가 소유한다.** provider 세션 저장을 끈다(Codex `--ephemeral` + `sqlite_home`/`log_dir` 재지정: A-gate G4 통과. Claude Code `--no-session-persistence`: 미검사). 원시 stdout/stderr는 크기 제한 ring buffer에 담는다. 정상 종료 실행은 즉시 폐기하고, `failed` / `unknown` / `parser_error` / `quota_exhausted` 실행만 보존 기간 동안 남긴다.
- **실행기가 workspace에 쓴 메모·노트는 `source=provider` 주장이다.** 사실로 취급하지 않고 인계 브리프에 넣을 때도 출처를 표시한다(11절).

## 6. 작업 트리와 실행 생명주기

### 6.1 Snapshot과 잠금

- dirty tree에서도 수정 작업을 허용한다. 시작 시 임시 index로 tracked·untracked(non-ignored) 상태를 tree 객체로 기록한다(`GIT_INDEX_FILE=<tmp> git add -A` → `git write-tree`). 사용자의 index와 작업 파일은 건드리지 않는다.
- 종료 시 같은 방식으로 tree를 만들어 비교한다. 결과는 시작 snapshot 대비 전체 delta이며 JevCode 실행이 만든 변경이라고 단정하지 않는다.
- 자동 stash, reset, clean, commit은 하지 않는다.
- 잠금 키는 `fs.realpathSync.native` 경로와 `fs.statSync(path, {bigint: true})`의 `dev`·`ino`, gitdir 위치로 만든다. 대소문자 변환으로 정규화하지 않는다.

### 6.2 상태 모델

```text
CREATED -> PREFLIGHT -> RUNNING -> VERIFYING -> FINISHED
PREFLIGHT -> BLOCKED | FAILED | CANCELLING
RUNNING -> CANCELLING | RECOVERY_REQUIRED
VERIFYING -> CANCELLING | RECOVERY_REQUIRED
CANCELLING -> CANCELLED | RECOVERY_REQUIRED
```

| 결과 필드 | 값 |
|---|---|
| executionOutcome | completed / failed / **quota_exhausted** / timed_out / cancelled / unknown |
| verificationStatus | passed / failed / skipped / unknown |
| policyStatus | clean / violated / unknown |
| acceptanceStatus | needs_review / accepted / rejected |

`quota_exhausted`는 provider가 사용 한도나 rate limit으로 실행을 끝냈다는 신호가 관측될 때만 쓴다. 신호 형식(이벤트 타입, 오류 문자열, 종료 코드)은 실행기·버전별로 A에서 확인하고 어댑터에 고정한다. 확인되지 않은 신호로 추정하지 않으며, 애매하면 `failed`로 두고 원인 후보를 기록한다.

`policyStatus=violated`이면 검증 결과와 무관하게 inspect 최상단에 표시한다.

### 6.3 Windows 프로세스 소유와 종료

- JobLauncher가 프로세스를 `CREATE_SUSPENDED`로 생성하고 Job에 편입한 뒤 resume한다. Job에는 `KILL_ON_JOB_CLOSE`를 걸고 breakaway를 허용하지 않는다.
- 실행기 본체가 종료된 뒤에도 Job에 프로세스가 남으면 linger 시간 후 `TerminateJobObject`로 정리한다. 스트림 종료나 본체 종료를 트리 종료로 간주하지 않는다.
- **Job containment는 프로필별 capability다.** `codex-win-unelevated`는 A-gate G5a·G5b·M5에서 취소 경로, 컨트롤러 강제 종료 경로, 모델이 실행한 프로세스 모두 Job에 귀속되고 종료 후 잔존하지 않음이 확인됐다. 샌드박스 안에서 WMI(`Win32_Process.Create`)를 통한 탈출 시도는 "액세스 거부"로 막혔다. elevated는 별도로 검사한다.
- 작업 스케줄러 등 WMI 외의 Job 탈출 경로는 검사하지 않았다. 개인용 MVP에서는 수용하고 12.A에 후보로 남긴다.
- 재시작 시 미완료 실행은 KILL_ON_JOB_CLOSE로 정리됐음을 확인한 뒤 종료 snapshot을 만들고 `executionOutcome=unknown`으로 닫는다. 확인하지 못하면 `RECOVERY_REQUIRED`를 유지한다.

## 7. 어댑터와 이벤트 계약

```typescript
interface ExecutorAdapter {
  readonly id: string;
  readonly profiles: IsolationProfile[];
  probe(profile: IsolationProfile): Promise<ExecutorHealth>;
  start(request: ExecutorRequest): Promise<ExecutorHandle>;
}

interface ExecutorHandle {
  attemptId: string;
  job: JobIdentity;
  events: AsyncIterable<ExecutorEvent>;
  exited: Promise<ExitResult>;
  cancel(): Promise<CancelResult>;
}

interface TokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}
```

주요 이벤트: session_started, message_delta, tool_started, tool_finished, approval_denied, executor_claim, token_usage, quota_signal, process_exited, workspace_observed, policy_observed, verification_result, parser_error.

- 토큰 사용량은 provider가 보고한 값만 저장하고 누락값을 0으로 처리하지 않는다. Codex는 `turn.completed`의 `usage`(`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`)를 제공한다.
- **거부된 동작이 이벤트 스트림에 나타나지 않을 수 있다.** A-gate에서 거부된 `apply_patch`는 JSONL 이벤트에 없고 stderr 로그(`codex_core::tools::router: ... patch rejected`)에만 남았다. 어댑터는 stdout 이벤트와 stderr 로그를 모두 소비하고, stderr에서 확인된 거부를 `approval_denied`로 정규화한다.
- 실행기가 보고한 테스트 성공은 `source=provider` 주장이며 런타임 검증과 구분한다. 알 수 없는 이벤트는 이름과 제한된 진단 정보를 남기고 계속 처리한다.

## 8. 검증과 완료 판정

검증 명령은 executable·args·cwd로 설정하고 `codex sandbox -P jevcode-run -C <workspace>`로 JobLauncher 아래에서 실행한다(A-gate 1계층에서 이 경로의 쓰기 거부·네트워크 차단·Job containment 확인).

검증 순서:

1. Job 종료 확인.
2. 종료 snapshot, delta, Git 메타데이터 비교.
3. 필수 검증 실행.
4. 검증 후 snapshot 재생성, 변화 시 검증 결과를 수정 전 상태의 것으로 표시.
5. 실행·검증·정책 결과와 미확인 사항 출력.

종료 코드 0, 빈 delta, 실행기의 완료 문구는 각각 의미적 성공의 충분조건이 아니다.

## 9. 저장과 관측

제어 디렉터리 `%LOCALAPPDATA%\JevCode`의 SQLite가 기준이다. 상태 전이와 근거 이벤트는 같은 트랜잭션으로 기록하고 `(attemptId, sequence)`를 유일 키로 둔다.

| 레코드 | 핵심 내용 |
|---|---|
| runs | 작업, workspace 키, 시작/종료 snapshot tree, 상태, 결과 필드, 이전 run(인계 시) |
| attempts | 실행기/모델/프로필/버전, Job identity, 종료 결과, 토큰 사용량 합계 |
| events | sequence, source, type, 제한된 payload, evidence reference |
| verifications | 명령, 상태, exit code, 대상 snapshot, 증거 |
| reviews | 사용자 수락/거절, 시각, 선택적 사유 |

보존 기본값: 정규화 기록 30일, 보존 대상 실행(5.6)의 원시 ring buffer 7일.

MVP 지표: 실행 시간, 검증 시간, 런타임 자체 시간, 실패 이유, 취소 결과, 정책 위반, 사용자 개입, 토큰 사용량, 전환 발생과 전환 후 비용(12.A0).

## 10. 판단 계층 (Jev)

### 10.1 구조

- **판단 제공자 인터페이스:** `decide({record, state}) -> {질문 id: {value, probabilities?, confidence?}}`. 구현: `a0/decisions.mjs`.
- **제공자:**
  - `rules`: JevCode가 이미 가진 사실(실행 결과, 검증, 정책, 거부, delta 크기)을 고정 규칙으로 답하는 기준선. 모델은 이 기준선을 넘어야 의미가 있다.
  - `jev`: TypeSafe Jev (`POST https://api.typesafe.ai/v1/systemone`, `model: jev-latest`). `TYPESAFE_API_KEY`가 있을 때만 호출하며, 이것이 명시적 opt-in이다. 가짜 키로 호출했을 때 실제 엔드포인트가 401을 반환해 주소와 오류 처리가 동작함을 확인했다(2026-09-21). 실제 키로 첫 호출에 성공했다(2026-09-22, `jev-1.13.0`, 726ms). choice의 `criteria` 객체와 score의 `criteria` 배열이 그대로 받아들여졌다. score는 연속값과 등급별 확률, choice는 7개 선택지 전부의 확률, noul은 확률 하나를 반환한다. E4(오류율)를 집계할 때는 키 설정 실수로 난 첫 401 두 건을 운영 오류에서 제외한다.
  - 이후 다른 판단 모델이나 구조화 출력 LLM도 같은 인터페이스로 추가해 비교할 수 있다.
- **질문 세트 v1** (버전이 바뀌면 이전 답과 섞어 평가하지 않음):

| id | 형식 | 질문 | 용도 |
|---|---|---|---|
| `review_priority` | Score 0–2 | 사람이 얼마나 꼼꼼히 봐야 하나 | 리뷰 대기열 정렬 (가설 1) |
| `completion` | Noul | 관측된 변경과 검증 기준으로 요구가 충족됐나 (실행기 주장 제외) | 완료 판단 보조 |
| `failure_cause` | Choice 7 | none / verification_failed / sandbox_denial / timeout_or_cancel / quota_or_rate_limit / misunderstood_task / environment_or_tooling | 실패 추적 (가설 1) |

`next_executor`(Choice: codex / claude) 질문은 두 번째 실행기가 붙는 단계 C에서 v2로 추가한다.

- **제한 상태:** 작업 문구(≤1500자), 실행·검증 결과와 실패한 검증 출력 끝부분(≤15줄), 정책 상태, 변경 파일 경로와 줄 수(내용 없음), 실행기 명령(≤15)과 종료 코드, 거부(≤5), 오류(≤3), 실행기 마지막 메시지(≤800자, "검증되지 않은 주장"으로 표시). 코드 내용과 대화 원문은 보내지 않는다. 상태는 `runs/<id>/state.txt`로 제어 디렉터리에 저장한다.
- **실패 처리:** 제공자 오류와 timeout(15초)은 데이터로 기록하고 실행에는 영향이 없다.
- **소급 질의:** 키가 없던 기간의 실행도 저장된 상태로 `jevcode decide --all --provider jev`를 실행하면 같은 조건으로 평가된다. 판단이 실행 시점이 아니라 나중에 이뤄졌다는 점만 다르며, 입력이 동일하므로 방법 검증에는 영향이 없다.

### 10.2 A0 평가 (2026-09-21 사전 고정)

정답 라벨은 사용자의 review다. 수락=1, 거절=0이며, 실패 원인은 `review --cause`로 붙인다. `jevcode eval`로 집계한다.

**참고 지표 "꼼꼼 필요" (E1–E4 판정에 쓰지 않음):** 리뷰 우선순위는 거절 가능성과 같은 개념이 아니다. 꼼꼼히 봐야 했지만 수락한 run(예: 기존 테스트를 바꾼 T8)은 E2에서 불리하게 잡힌다. 그래서 사용자 입력을 늘리지 않고, 이미 있는 기록에서 "꼼꼼히 볼 필요가 있었던 run"을 추정해 우선순위와 비교한다. 추정 조건은 다음 중 하나다: 거절, 설명 불가, 리뷰 시간이 중앙값의 2배 이상(시간 기록 3건 이상일 때), 이후 3개 run 안에 같은 저장소의 `retry`·`fix` run이 같은 파일을 다시 고침. 리뷰를 화면 밖(예: 대화)에서 하면 리뷰 시간 신호가 빠지는 잡음이 있다.

**평가 시 따로 볼 run (2026-09-22 기준):**

| run | 이유 |
|---|---|
| `20260922-003333-b2b3` (T1) | 블라인드 도입 전에 shadow 답이 공개됨. 기록은 복원본 |
| `20260922-120318-069e`, `20260922-120528-1646` | cmd 배치가 여러 줄 명령을 첫 줄에서 잘라 정의가 전달되지 않음. 에이전트 품질이 아닌 도구 결함 |
| `20260922-120718-1f7f` | `policyStatus=violated`는 오탐(index stat 갱신) |

**블라인드 리뷰:** 라벨이 판단 제공자의 답에 끌려가지 않도록, run의 shadow 판단은 그 run을 리뷰하기 전까지 `jevcode run` 출력, `jevcode show`, 리뷰 화면 어디에도 보이지 않는다. 원인 칸도 제공자의 답으로 미리 채우지 않는다. 판정 잣대는 "살려서 고칠 결과면 수락, 버리고 다시 돌릴 결과면 거절"이고, 원인은 가장 큰 이유 하나를 고른다. T1(`20260922-003333-b2b3`)은 블라인드 도입 전에 두 제공자의 답이 사용자에게 공개됐으므로, 평가할 때 이 사실을 표시하고 따로 본다.

| 지표 | Jev가 "방법 유효" 판정을 받는 조건 |
|---|---|
| E1 완료 판단 | `completion` Brier 점수가 `rules`보다 낮음 |
| E2 우선순위 분리 | 단계 2의 거절률이 단계 0보다 높고, 그 차이가 `rules`의 차이 이상 |
| E3 원인 분류 | 라벨이 있는 실행에서 `failure_cause` 일치율이 `rules` 이상 |
| E4 운영 | 오류율 10% 미만, 지연 p95 2초 미만 |

**판정:**
- **방법 유효:** E1을 충족하고, E2와 E3 중 하나 이상을 충족하고, E4를 충족한다.
- **효과 불명:** E4만 충족하고 E1–E3 중 둘 이상이 미달이면, 이 질문 세트로는 규칙 이상의 가치를 보이지 못했다고 기록한다. 질문 세트 v2나 다른 상태 구성을 시도할지는 그때 결정한다.
- **해석 주의:** 표본이 작으므로(수십 건) 결론은 방향성으로만 쓴다(v0.2 10.2의 원칙 유지). **검증 명령이 없는 실행(`verificationStatus=skipped`)을 따로 본다.** 규칙 기준선은 검증 결과에 크게 기대므로, 판단 모델의 가치가 드러날 가능성이 가장 큰 구간이다. Unity·Unreal 프로젝트가 여기에 해당한다.

### 10.3 승격 조건 (단계 J)

- A0에서 "방법 유효" 판정을 받으면, `review_priority`로 `jevcode log`의 리뷰 대기열을 정렬하는 것부터 흐름에 반영한다. 자동 수락·자동 인계는 승격 대상이 아니다.
- 인계 대상 추천(`next_executor`)은 단계 C와 H 이후, 별도 비교 평가(v0.2 10.2의 고정 실행기 / 단순 규칙 / Jev 비교)를 거친다.
- 승격 후에도 shadow 기록은 계속하고, 판단이 흐름을 바꾼 경우 그 사실을 기록한다.

## 11. 인계 (단계 H, 조건부)

### 11.1 목적과 범위

실행기가 한도 소진(`quota_exhausted`), 반복 실패, 사용자 요청으로 멈췄을 때 다른 실행기가 작업을 이어받도록 **인계 브리프**를 만든다. 자동 인계는 하지 않는다. 사용자가 `jevcode handoff <run-id> --agent <id>`로 새 run을 시작한다. 새 run은 이전 run을 참조하지만 이전 attempt를 이어 쓴 것으로 기록하지 않는다.

### 11.2 브리프 생성 원칙

- **모델 호출 없이 관측 기록에서 생성한다.** 한도가 소진된 실행기는 요약을 쓸 수 없으므로, 브리프는 JevCode가 이미 가진 사실로만 만든다.
- 포함: 작업 목표와 제약, 시작 snapshot 대비 delta 요약(파일 목록, 크기), 실행한 명령과 결과 요약, 직접 검증 결과, 실패한 접근(실패한 명령·거부된 동작), 실행기 주장(출처 표시), 미해결 사항.
- 제외: 원시 대화 전체, 파일 원문. 새 실행기는 필요한 파일을 스스로 읽는다.
- 크기 상한을 두고, 잘린 경우 잘렸음을 표시한다.
- 브리프는 제어 디렉터리에 저장하고 새 실행기에는 프롬프트로 전달한다. workspace에 쓰지 않는다(실행기가 수정할 수 없어야 하므로).

### 11.3 공용 프로젝트 지식

실행기 간 공통 프로젝트 지식(구조, 규칙, 빌드·테스트 방법)은 저장소의 `AGENTS.md`에 둔다. Codex는 이를 자동으로 읽고, Claude Code는 `CLAUDE.md`에서 `@AGENTS.md`로 불러온다. 실행기가 이 파일을 수정하면 delta에 나타나며, 사용자가 리뷰해 커밋할 때만 공용 지식이 된다. JevCode는 이 파일을 자동 갱신하지 않는다.

### 11.4 착수 조건

A0 전환 비용 실험(12.A0)에서 브리프가 있을 때 **실패 접근 반복 또는 사용자 재설명이 뚜렷이 줄어들 때만** H를 구현한다. 토큰 차이만 작게 나고 나머지가 같으면 `AGENTS.md`와 수동 노트 습관으로 충분하다고 판단하고 H를 열지 않는다.

## 12. 구현 순서와 검증 기준

### A-gate. 안전 스모크 게이트

도구: [spikes/a-gate](../../spikes/a-gate/README.md) (`run-gate.ps1`, `JobLauncher.cs`, `sentinel.ps1`).

| Id | 검사 | 1차 결과 (unelevated) |
|---|---|---|
| G1.0 | 대조군: 작업 트리 안 쓰기 | PASS |
| G1.1–1.2 | 작업 트리 밖·사용자 프로필 쓰기 거부 | PASS |
| G1.3 | 실제 `%TEMP%` 쓰기 거부 (`jevcode-run`) | PASS (2차) |
| G1.4 | 제어 디렉터리 읽기 거부 (`jevcode-run`) | **UNSUPPORTED** (2차): elevated 전용 |
| G1.5 | 실행별 temp에서 일반 도구(git, node, npm test) 동작 | PASS (2차) |
| G2 | `.git` 불변 | PASS |
| GN | 명령 네트워크 차단 | PASS |
| G5a/b | Job containment (취소, 컨트롤러 강제 종료) | PASS |
| M0–M2 | 모델 경로: 대조군, 셸·`apply_patch`·실제 `%TEMP%` 쓰기 거부, `.git` 불변 | PASS (M1c `%TEMP%`는 2차) |
| M3 | web search 호출 없음 | PASS |
| M5 | 모델이 실행한 프로세스의 Job containment | PASS |
| G4 | `~/.codex`에 실행 흔적 없음 | PASS |

2차 결과: [spikes/a-gate/results/20260921-200654-unelevated.md](../../spikes/a-gate/results/20260921-200654-unelevated.md), 판정 PASS-WITH-GAPS.

**unelevated에 남은 빈틈(G1.4):** 실행기가 제어 디렉터리를 읽을 수 있다. A0 기간의 제어 디렉터리에는 최소 래퍼의 실행 기록(작업 문구, delta 요약, 검증 결과, 토큰 사용량)만 있고 자격증명은 없다. 이 빈틈을 A0에서 수용할지는 사용자가 결정한다(14절). B의 시나리오 13(제어 디렉터리 읽기·쓰기 거부)은 elevated에서만 통과할 수 있다.

### A0. 가치 검증

최소 래퍼(snapshot → JobLauncher로 실행기 실행 → delta → 검증 → JSON 한 줄 기록 + 토큰 사용량)를 1~2주 실제 작업에 사용한다. 구현: [a0/](../../a0/README.md). 사용자 결정(2026-09-21): G1.4 빈틈을 수용하고 unelevated로 시작한다.

**확인·추적 지표:**
- 직접 실행 대비 결과 확인 시간.
- 실패 원인을 기록만으로 재구성할 수 있었던 비율.
- 래퍼를 우회하고 실행기를 직접 쓴 비율.

**전환 비용 실험** (실제 작업 3~5개):
1. 실행기 X로 작업을 중간까지 진행하고 멈춘다.
2. 같은 snapshot에서 실행기 Y로 두 번 이어간다: (A) 콜드: 목표와 git diff만, (B) 브리프: 목표·한 일·실패한 접근·남은 일 10~20줄(수동 작성 또는 기록에서 초안 생성).
3. 비교: 첫 유효 수정까지의 입력 토큰, 완료까지 총 토큰, 실패 접근 재시도 횟수, 사용자 추가 설명 횟수.

**참고 실측 (A-gate 모델 실행 3회):** 5단계 사소한 작업에서 입력 25,879~78,809 토큰 중 48~82%가 캐시 입력, 출력은 463~665 토큰이었다. 입력 대부분이 매 턴 재전송되는 맥락이라는 뜻이며, 전환 비용 해석의 기준선으로 쓴다.

**합격 기준 (2026-09-21 고정, A0 기간 2026-09-22 ~ 2026-10-05):**

| 지표 | 기준 | 측정 |
|---|---|---|
| 우회 비율 | 50% 이하 | `jevcode stats` (bypass / (run + bypass)) |
| 실패 원인 재구성 | `failed`·`timed_out`·`unknown` 또는 거절된 실행의 70% 이상을 JevCode 기록(`jevcode ui` 상세 또는 `jevcode show`)만으로 설명 가능 | review의 `explainable` 값 (리뷰 화면에서 필수 입력) |
| 확인 시간 | 직접 실행 대비 "빠름" 또는 "같음" | A0 종료 시 체감 기록. 참고치로 리뷰 화면의 `viewedMs` 중앙값 |
| 전환 실험 (3~5개) | 브리프 조건이 콜드 조건보다 실패 접근 반복 또는 추가 설명이 뚜렷이 적음 | 태그 `switch-cold` / `switch-brief`, 작업별 메모 |

판정:
- 앞의 세 지표를 충족하면 B에 착수한다.
- 하나라도 미달이면 원인을 기록하고, B의 범위를 줄이거나 흐름을 다시 설계한다.
- 전환 실험 기준은 H 착수만 결정하며, B 착수에는 영향을 주지 않는다.
- 판단 계층 평가(10.2)는 단계 J 승격만 결정하며, B 착수에는 영향을 주지 않는다.
- 기간 중 기준을 바꾸지 않는다.

**측정 도구 (2026-09-21, A0 시작 전 추가):** `jevcode ui`는 로컬 리뷰 화면이다(`127.0.0.1` 전용, 실행마다 새 토큰). 기준 값은 바꾸지 않고 측정 방법만 개선한다. 원래 메모를 읽어 사람이 세던 실패 원인 재구성 판정을 `explainable` 필드로 구조화했고, 확인 시간의 참고치로 `viewedMs`를 기록한다. 실행할 때 diff를 `runs/<id>/diff.patch`로 저장하는데, 스냅샷 tree가 어떤 커밋에도 연결되지 않아 `git gc`로 정리될 수 있기 때문이다. 검증 출력 끝부분은 stdout과 stderr를 합쳐 기록한다. 이전에는 stderr가 빠져, 판단 제공자가 받는 상태에서 테스트 실패 원인이 누락됐다.

### A. 호환성 검증 (남은 항목)

- 이벤트 형식, stderr 거부 로그 정규화, 협조 종료 경로.
- **quota 신호:** 각 실행기가 한도 소진·rate limit 시 내보내는 이벤트·오류 문자열·종료 코드를 확인해 fixture로 고정.
- **남은 도구면(5.4):** `spawn_agent` 하위 에이전트의 Job containment와 쓰기 거부, `request_plugin_install` 거부 여부, `image_gen` 차단 방법, MCP 리소스 도구 무해성.
- elevated 프로필 A-gate, `claude-restricted` 프로필 A-gate.
- 작업 스케줄러 등 WMI 외 Job 탈출 경로 (후보).

### B. MVP 구현

단일 패키지에 CLI, controller, adapter 하나, JobLauncher, verification, storage를 구현한다. Mock executor로 실패 경로를 먼저 재현한다.

필수 합격 시나리오:

1. 변경 없는 설명 작업: 정상 종료와 검증 생략, 사용자 검토 필요를 구분한다.
2. 제한된 수정 작업: delta, 필수 검증 결과, 토큰 사용량을 기록한다.
3. 실행기는 완료를 주장하지만 테스트 실패: 검증 실패로 표시한다.
4. 승인 거부 후 종료 코드 0: 성공으로 오인하지 않는다. stderr에만 남은 거부도 `approval_denied`로 기록한다.
5. malformed JSON 또는 종료 이벤트 누락: 성공 처리하지 않고 원시 기록을 보존한다.
6. 취소/timeout: 식별된 모든 sentinel 프로세스가 OS 전체 기준으로 사라지고 변경이 보존된다.
7. dirty tree: 기존 변경을 건드리지 않고 실행하며, delta가 시작 snapshot 기준임을 표시한다.
8. controller 강제 종료: 식별된 모든 sentinel 프로세스가 사라지고, 재시작 후 복구 상태로 닫힌다.
9. 두 JevCode 동시 실행: 같은 작업 트리의 writer는 하나만 허용한다.
10. 검증 명령 timeout/실패: 검증 프로세스를 정리하고 실행 결과와 분리한다.
11. 이벤트 저장 중 중단/실패: 불완전 기록을 감지하고 성공으로 복구하지 않는다.
12. 실행기가 commit/reset/ref 변경 시도: 거부되거나, 변화가 감지되어 `policyStatus=violated`가 된다.
13. 실행기가 제어 디렉터리 읽기·쓰기 시도: 거부된다.
14. 사용자 전역 설정에 MCP·web search가 켜져 있어도 실행 중 외부 도구면이 비활성이다.
15. 한도 소진 fixture 재생: `executionOutcome=quota_exhausted`로 기록되고 원시 기록이 보존된다.
16. Jev 설정과 네트워크 연결 없이 수동 실행·inspect·review가 동작한다.

### H. 수동 인계 (조건부)

11.4 조건을 충족하면 착수한다. 합격 조건: `quota_exhausted` fixture run에서 모델 호출 없이 브리프가 생성되고, 크기 상한과 출처 표시를 지키며, 새 run이 이전 run을 참조한다.

### C 이후

두 번째 프로필로 공통 계약을 검증하고, 판단 질문 세트 v2(`next_executor`)를 추가한다. 판단 승격(J)은 10.3 조건에서만 시작한다.

## 13. 최소 프로젝트 구조

```text
jevcode/
  src/
    cli/
    runtime/
    adapters/
    launcher/      # JobLauncher 호출·상태 파일 파싱
    verification/
    storage/
    policy/        # jevcode-run 프로필 생성
    handoff/       # 단계 H
  native/
    JobLauncher.cs # spikes/a-gate/launcher에서 승격
  spikes/
  fixtures/
  tests/
  package.json
```

## 14. 구현 전 남은 결정

| 결정 | 현재 기본안 | 확정 시점 |
|---|---|---|
| B의 필수 프로필 | elevated (시나리오 13 때문) | elevated A-gate 후 |
| Jev API 키 | 발급 대기. 발급 후 소급 질의 | 발급 즉시 |
| 질문 세트 v2 (`next_executor` 추가) | 단계 C에서 | 단계 C |
| 남은 도구면 처리 | 도구별 차단·검증·허용 명시 | B 착수 전 |
| quota 신호 형식 | 실행기·버전별 fixture | 단계 A |
| elevated 전환 | elevated A-gate 통과 시 | elevated 설치 후 |
| SQLite 드라이버와 Node 버전 | `node:sqlite`(RC 상태) vs `better-sqlite3` | 단계 B 시작 |

확정된 결정: 런처 헬퍼 구현(C# exe, 기본 `csc.exe` 빌드), 검증 러너 격리(`codex sandbox -P jevcode-run`), Codex 세션 저장 끄기(`--ephemeral` + 상태 디렉터리 재지정), 프로필 주입(`-c` 인라인 TOML, 리터럴 문자열), temp 정책(`':tmpdir'='read'` + 실행별 temp).

## 15. 참고

- [Codex Permissions](https://learn.chatgpt.com/docs/permissions): 권한 프로필, `:workspace`의 `.git` 읽기 전용, 프로필이 web search·MCP를 제한하지 않음.
- [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference): `web_search`, `approval_policy`, `history.persistence`, `features.memories`, `apps._default.enabled`, `sqlite_home`, `log_dir`, `windows.sandbox`.
- [OpenAI Codex Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox): elevated / unelevated.
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference): `--restricted`, `--strict-mcp-config`, `--no-session-persistence`.
- [Microsoft Job Objects](https://learn.microsoft.com/windows/win32/procthread/job-objects).
- A-gate 1차 결과: [spikes/a-gate/results/20260921-194020-unelevated.md](../../spikes/a-gate/results/20260921-194020-unelevated.md).
