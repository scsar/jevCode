# JevCode System Design

**Version:** 0.3  
**Status:** 플랫폼·격리 방식을 확정한 설계 초안  
**Date:** 21 September 2026  
**Implementation:** TypeScript / Node.js, 단일 패키지 + Windows 런처 헬퍼  
**Initial platform:** Windows 11 네이티브 (WSL2 제외)  
**Previous version:** [v0.2](JevCode_System_Design_v0.2.md) · 변경 근거: [v0.3 changelog](JevCode_v0.3_changelog.md)

## 1. 제품 방향

JevCode는 기존 코딩 에이전트를 실행하고, 실행 기록과 검증 결과를 한곳에서 확인하는 개인용 로컬 CLI다. Jev를 통한 자동 라우팅은 필수 로드맵이 아니라 조건부 연구 트랙이다.

첫 버전의 성공 조건은 **기존 실행기를 직접 사용하는 것보다 작업 결과를 확인하고 실패를 추적하기 편리한가**이며, 이 가설은 런타임 본체를 만들기 전에 최소 래퍼로 먼저 측정한다(단계 A0).

기존 실행기의 읽기·수정·명령 실행·추론 루프는 유지한다. 런타임은 실행 전과 프로세스 종료 후에 개입한다.

### 1.1 v0.2에서 조정한 사항

| 항목 | v0.3 방향 |
|---|---|
| 플랫폼 | 네이티브 Windows 11로 확정. WSL2는 지원 범위 밖 |
| 첫 어댑터 | Codex elevated 샌드박스 + hermetic 실행. Claude Code는 `--restricted` 프로필로 두 번째 |
| 가치 검증 | 안전 스모크 게이트(A-gate) 통과 후 최소 래퍼(A0)로 먼저 측정, 통과해야 B 착수 |
| 작업 트리 | dirty tree 허용. 임시 index snapshot 대비 전체 delta 기록 |
| Git 메타데이터 | 실행기·검증 명령에 대해 불변 경계. 변화 시 정책 위반 |
| 제어 데이터 | DB·lock·증거는 workspace 밖 전용 디렉터리, 실행기 접근 거부 |
| 원시 기록 | provider 세션 저장 끄고 JevCode가 소유. 실패 실행만 보존 |
| 프로세스 | 런처 헬퍼가 suspended 생성 → Job 편입 → resume. KILL_ON_JOB_CLOSE |
| Jev | 단계 D/E를 조건부 연구 트랙으로 강등 |

### 1.2 설계 기본값

- 실행마다 프로세스 하나를 생성하고 자동 retry·continue·switch는 하지 않는다.
- SQLite에 정규화된 실행 기록을 저장한다. 드라이버는 단계 B 시작 시 선택한다.
- 비용은 관측 지표다. 최적화 목표는 결과 확인 시간과 실패 추적 시간 감소다.

## 2. 범위와 출시 단계

| 단계 | 포함 | 합격 조건 |
|---|---|---|
| A-gate: 안전 스모크 | 첫 프로필의 쓰기·`.git`·외부 도구면·세션 잔존 파일·Job containment 검사 | 12.A-gate 전 항목 통과 |
| A0: 가치 검증 | A-gate를 통과한 프로필로 최소 래퍼(실행 → snapshot diff → 검증 → JSON 한 줄 기록)를 1~2주 실사용 | 12.A0의 사전 정의 지표 충족 |
| A: 호환성 검증 | 이벤트·종료·Job·제어 디렉터리 등 나머지 실험, 두 번째 프로필 실험 | 프로필별 capability 보고서 확보 |
| B: 개인용 MVP | 한 실행기 수동 실행, 기록, 취소, 검증, inspect | 12.B의 필수 시나리오 통과 |
| C: 공통 계약 검증 | 두 번째 실행기(Claude Code) | 컨트롤러에 실행기 이름별 분기 없이 같은 계약 통과 |
| R: 조건부 연구 | Jev shadow, 보조 라우팅 | 10.0의 시작 조건 충족 시에만 착수 |
| F: 선택적 확장 | 세 번째 실행기, 세션 재개, worktree, 인계 | 각 기능의 필요성과 별도 안전성 검증 |

A-gate를 먼저 통과한 뒤 A0과 A를 병행한다. 실제 작업은 A-gate를 통과한 프로필로만 수행한다. A0이 실패하면 B의 범위(저장소·복구 체계)를 줄이거나 흐름을 다시 설계한 뒤 착수한다. R을 하지 않아도 제품은 성공일 수 있다.

MVP에는 auto 모드, 자동 완료 승인, 교차 실행기 인계, 병렬 실행, 자동 병합, WSL2·크로스 플랫폼 지원, 비용 최적화 라우터, 학습 기능을 넣지 않는다.

## 3. 아키텍처와 책임

```text
CLI
 └─ Runtime controller ──────────── Control data dir (workspace 밖)
     ├─ Workspace preflight / snapshot / single-writer lock   ├─ SQLite
     ├─ Executor adapter ── Launcher helper ── Executor       ├─ lock
     ├─ Verification runner ── Launcher helper ── command     ├─ evidence ring buffer
     └─ Store                                                 └─ policy snapshot
```

| 구성요소 | 책임 |
|---|---|
| CLI | 사용자 입력, 진행 표시, 취소, 실행 결과 조회 |
| Controller | 상태 전이, 실행 예산, 잠금, snapshot, 종료 확인. 제어 디렉터리의 유일한 접근자 |
| Adapter | 버전별 실행 인자, 격리 프로필, capability 검사, 이벤트 변환 |
| Launcher helper | Windows Job Object 생성·편입·종료. 작은 네이티브 exe 또는 FFI |
| Verification runner | 사전 승인된 검증 명령을 격리 프로필로 실행하고 직접 관측 기록 |
| Store | 실행·시도·이벤트·검증·사용자 판정의 일관된 저장 |

권한 경계는 실행기의 OS 수준 샌드박스 또는 도구 비활성화로 강제한다. 프롬프트에 적은 제한은 경계가 아니다. 종료 코드와 파일 상태 같은 사실은 모델에 질의하지 않는다.

## 4. MVP 사용자 흐름

```text
jevcode init
jevcode doctor
jevcode run "Fix the bounded bug"
jevcode inspect <run-id>
jevcode review <run-id> --accept | --reject
```

1. `init`에서 실행기, 작업 유형, 필수 검증 명령, 시간 제한을 설정한다.
2. `doctor`가 설치 버전, 격리 프로필, capability를 확인한다. 인증 여부를 부작용 없이 확인할 수 없으면 `unknown`으로 표시한다.
3. `run`이 잠금을 잡고, 시작 snapshot(6.1)을 만들고, 격리 프로필을 확인한다.
4. 런처 헬퍼로 실행기를 시작하고 stdout/stderr를 소비하며 정규화된 이벤트를 저장한다.
5. 종료 또는 취소 후 Job 내 프로세스가 모두 사라졌는지 확인한다.
6. snapshot 대비 delta와 Git 메타데이터 변화를 수집하고 필수 검증을 수행한다.
7. 실행 결과, 검증 상태, 미확인 사항을 출력하고 종료한다. 사용자 판정을 기다리며 프로세스를 유지하지 않는다.
8. 사용자는 나중에 `review`로 수락 또는 거절을 기록한다. 이 명령은 코드를 수정하거나 커밋하지 않는다.

## 5. 권한과 지원 범위

### 5.1 격리 프로필

어댑터는 실행기별로 하나 이상의 격리 프로필을 정의하고, 각 프로필의 capability를 `verified` / `unsupported` / `unknown`으로 보고한다.

| 프로필 | 강제 수단 | 셸 명령 | 비고 |
|---|---|---|---|
| `codex-win-elevated` | Codex Windows `elevated` 샌드박스, `workspace-write`, 승인 정책 never | 허용 | 첫 프로필. 1회 관리자 설치 필요 |
| `codex-win-unelevated` | Codex Windows `unelevated` restricted-token 샌드박스 | 허용 | 더 약한 방식. 별도 capability 통과 시에만 fallback |
| `claude-restricted` | `--restricted --strict-mcp-config`: Bash·PowerShell·REPL 등 실행 도구와 WebFetch 제거, 파일 도구를 작업 디렉터리로 제한, MCP 제외 | 불가 | 테스트·빌드는 JevCode 검증 러너가 실행 |

두 Codex 프로필은 별개로 검증한다. 한 방식의 결과를 다른 방식에 적용하지 않는다.

**Hermetic 실행:** 모든 프로필은 사용자 설정에 의존하지 않는 고정 구성으로 실행한다. Codex는 `--ignore-user-config --ignore-rules`와 JevCode가 전달하는 고정 `-c` 값으로 web search·MCP·apps/connectors·browser 등 외부 도구면을 모두 끈다. 명령 네트워크 차단은 이 도구면에 적용되지 않으므로 별도로 꺼야 한다. CLI로 외부 도구면이 꺼졌음을 증명할 수 없으면 도구 allowlist를 직접 통제할 수 있는 `codex app-server`(experimental)를 단계 A에서 비교한다.

필수 capability:

- 비대화형 실행과 기계 판독 이벤트.
- 작업 트리 밖 쓰기 거부. `.git` 쓰기 거부, 제어 디렉터리 읽기·쓰기 거부(5.2).
- 외부 도구면(web search, MCP, connectors, browser 등) 비활성.
- 미승인 동작 거부와 거부 이벤트 관측.
- Job Object를 통한 프로세스 트리 종료 확인.
- provider 세션 저장 비활성화(5.3).

셸 명령이 허용되는 프로필에서 OS 수준 쓰기 제한을 `verified`로 확보하지 못하면 그 프로필로 수정 작업을 시작하지 않는다. 명령 문자열 규칙은 강제 수단으로 인정하지 않는다.

### 5.2 보호 경로

- **Git 메타데이터는 불변 경계다.** 실행기와 검증 명령은 `.git`(worktree의 경우 실제 gitdir 포함)에 쓸 수 없다. 시작·종료 시 HEAD, refs, index checksum을 비교하고 변화가 있으면 정책 위반으로 기록한다. snapshot 생성 같은 Git 객체 쓰기는 실행기 시작 전에 컨트롤러만 수행한다.
- **제어 디렉터리**(DB·lock·evidence·정책 snapshot)는 workspace 밖에 두고 실행기와 검증 명령에 읽기·쓰기 모두 거부한다. workspace에는 제어 데이터를 쓰지 않는다.
- push·배포·외부 메시지 전송은 초기 지원 범위에서 제외한다. `.git` 쓰기 거부로 커밋·ref 변경은 막히고, push는 네트워크 제한이 `verified`인 프로필이거나 셸이 없는 프로필에서만 차단된 것으로 본다.

### 5.3 데이터 경계

- 환경 변수는 실행에 필요한 이름만 전달한다. 자격증명을 복사하지 않는다.
- **원시 기록은 JevCode가 소유한다.** 실행기의 자체 세션 저장을 끈다(Claude Code `--no-session-persistence`, Codex `exec --ephemeral`). 옵션 존재가 아니라 실행 후 provider 디렉터리에 잔존 파일이 없는지로 검증한다. 원시 stdout/stderr는 크기 제한 ring buffer에 담고, 정상 종료 실행은 즉시 폐기하며 `failed` / `unknown` / `parser_error` 실행만 보존 기간 동안 남긴다.
- 기본 기록은 필요한 필드만 추출하고 알려진 민감값 패턴을 제거한다.

## 6. 작업 트리와 실행 생명주기

### 6.1 Snapshot과 잠금

- **dirty tree에서도 수정 작업을 허용한다.** 시작 시 임시 index로 tracked·untracked(non-ignored) 상태를 tree 객체로 기록한다(`GIT_INDEX_FILE=<tmp> git add -A` → `git write-tree`). 사용자의 index와 작업 파일은 건드리지 않는다.
- 종료 시 같은 방식으로 tree를 만들어 시작 tree와 비교한다. 결과는 **시작 snapshot 대비 전체 delta**이며 JevCode 실행이 만든 변경이라고 단정하지 않는다. ignored 파일은 delta에 포함되지 않는다.
- 자동 stash, reset, clean, commit은 하지 않는다.
- 잠금 키는 `fs.realpathSync.native`로 얻은 경로와 `fs.statSync(path, {bigint: true})`의 `dev`·`ino`로 만든다. 대소문자 변환으로 정규화하지 않는다(디렉터리별 case-sensitive 모드 때문). gitdir 위치도 함께 키에 포함한다.
- 잠금은 JevCode 실행끼리의 동시 쓰기만 막는다. 편집기나 외부 프로세스는 막지 못한다.

### 6.2 상태 모델

```text
CREATED -> PREFLIGHT -> RUNNING -> VERIFYING -> FINISHED
PREFLIGHT -> BLOCKED | FAILED | CANCELLING
RUNNING -> CANCELLING | RECOVERY_REQUIRED
VERIFYING -> CANCELLING | RECOVERY_REQUIRED
CANCELLING -> CANCELLED | RECOVERY_REQUIRED
```

실행기 실패도 종료가 확인되면 `VERIFYING`에서 변경 상태를 수집하고 `FINISHED`로 끝낸다. 허용 전이는 코드의 단일 전이표로 관리한다.

| 결과 필드 | 값 |
|---|---|
| executionOutcome | completed / failed / timed_out / cancelled / unknown |
| verificationStatus | passed / failed / skipped / unknown |
| policyStatus | clean / violated / unknown |
| acceptanceStatus | needs_review / accepted / rejected |

`policyStatus=violated`(예: Git 메타데이터 변화)이면 검증 결과와 무관하게 inspect에서 최상단에 표시한다. 의미적 수락은 사용자가 기록한다.

### 6.3 Windows 프로세스 소유와 종료

- 런처 헬퍼가 프로세스를 `CREATE_SUSPENDED`로 생성하고 Job Object에 편입한 뒤 resume한다. 편입 전 자식 생성 경쟁을 없애기 위함이다.
- Job에는 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`를 건다. 컨트롤러가 비정상 종료하면 OS가 트리를 정리한다. breakaway는 허용하지 않는다.
- 취소: 실행기별로 검증된 협조 종료 경로(stdin 종료, 콘솔 이벤트 등)가 있으면 먼저 쓰고, 유예 후 `TerminateJobObject`로 강제 종료한다. 검증된 경로가 없으면 바로 강제 종료한다. Node의 `kill()`을 정상 종료 요청으로 취급하지 않는다.
- **Job containment는 프로필별 capability다.** Codex elevated 샌드박스는 전용 샌드박스 사용자로 명령을 실행하므로, 모델 명령 프로세스가 JevCode Job에 귀속된다는 보장이 없다. A-gate에서 `jobContainment=verified`를 얻은 프로필에서만 "Job 활성 프로세스 수 0"을 종료 확인으로 인정한다. 미확인·실패 프로필은 `unsupported`로 처리하고 수정 작업에 쓰지 않는다.
- 재시작 시 미완료 실행은 복구 대상으로 분류한다. KILL_ON_JOB_CLOSE로 프로세스가 사라졌음을 확인한 뒤 종료 snapshot을 만들고 `executionOutcome=unknown`으로 닫는다. 확인하지 못하면 `RECOVERY_REQUIRED`를 유지하고 새 writer를 허용하지 않는다.
- 살아 있는 실행기에 재접속하거나 작업을 자동 재실행하지 않는다.

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

interface EventEnvelope {
  schemaVersion: number;
  runId: string;
  attemptId: string;
  sequence: number;
  at: string;
  source: "runtime" | "provider" | "user";
  type: string;
  payload: unknown;
  evidenceRef?: string;
}
```

`start` 실패 시 어댑터는 Job을 종료해 부분 생성된 프로세스를 정리한다. 컨트롤러는 스트림 종료를 프로세스 종료로 간주하지 않는다. 이벤트 큐는 크기를 제한하고 프로세스 출력이 막히지 않도록 지속적으로 소비한다.

주요 이벤트: session_started, message_delta, tool_started, tool_finished, approval_denied, executor_claim, process_exited, workspace_observed, policy_observed, verification_result, parser_error.

실행기가 보고한 테스트 성공은 `source=provider` 주장이며 런타임 검증과 구분한다. 알 수 없는 이벤트는 이름과 제한된 진단 정보를 남기고 계속 처리한다. 스트림 손상으로 결과를 신뢰할 수 없으면 `unknown`으로 남기고 원시 ring buffer를 보존한다.

## 8. 검증과 완료 판정

각 프로젝트는 필수 검증 명령을 executable·args·cwd로 설정한다. 사용자 작업 문자열을 셸 코드로 연결하지 않는다. 검증 명령은 실행기와 같은 쓰기·보호 경로 제한을 받는다. 단계 A에서 `codex sandbox`로 임의 명령을 감싸는 방식을 검증 러너 격리 후보로 시험한다.

검증 순서:

1. Job 종료 확인.
2. 종료 snapshot, delta, Git 메타데이터 비교.
3. 필수 검증 실행.
4. 검증 후 snapshot 재생성, 변화 시 검증 결과를 수정 전 상태의 것으로 표시.
5. 실행·검증·정책 결과와 미확인 사항 출력.

종료 코드 0, 빈 delta, 실행기의 완료 문구는 각각 의미적 성공의 충분조건이 아니다. MVP는 종료 후 필수 검증을 한 번 수행하며 검증 재사용은 도입하지 않는다.

## 9. 저장과 관측

제어 디렉터리(기본 `%LOCALAPPDATA%\JevCode`)의 SQLite가 실행 기록의 기준이다. 상태 전이와 근거 이벤트는 같은 트랜잭션으로 기록하고 `(attemptId, sequence)`를 유일 키로 둔다.

| 레코드 | 핵심 내용 |
|---|---|
| runs | 작업, workspace 키, 시작/종료 snapshot tree, 상태, 결과 필드 |
| attempts | 실행기/모델/프로필/버전, Job identity, 종료 결과 |
| events | sequence, source, type, 제한된 payload, evidence reference |
| verifications | 명령, 상태, exit code, 대상 snapshot, 증거 |
| reviews | 사용자 수락/거절, 시각, 선택적 사유 |

보존 기본값: 정규화 기록 30일, 실패 실행의 원시 ring buffer 7일. 진행 중이거나 복구가 필요한 실행은 정리하지 않는다. 필수 기록 쓰기에 실패하면 실행 중인 경우 취소하고 결과를 `unknown`으로 둔다.

MVP 지표: 실행 시간, 검증 시간, 런타임 자체 시간, 실패 이유, 취소 결과, 정책 위반, 사용자 개입. 토큰/비용은 제공될 때만 저장하고 누락값을 0으로 처리하지 않는다.

## 10. Jev 조건부 연구 트랙

### 10.0 시작 조건

단계 C 통과 후, 축적된 실행 기록에서 **실행기 선택을 잘못해 생긴 손실**(재실행, 거절, 수동 전환)이 관측될 때만 착수한다. 관측되지 않으면 고정 실행기 + 단순 규칙을 유지하고 이 트랙은 열지 않는다.

### 10.1 역할과 평가

v0.2의 10.1~10.3(호출 예산 제한, shadow 방식, 사전 고정한 평가 계획, 승격·중단 기준)을 그대로 유지한다. 착수 시 별도 문서로 분리한다.

## 11. 후속 인계와 세션 재개

v0.2의 11절을 유지한다. 단 세션 재개는 provider 세션 저장을 끄는 5.3 정책과 충돌하므로, 착수 시 세션 저장 범위를 재결정한다.

## 12. 구현 순서와 검증 기준

### A-gate. 안전 스모크 게이트 (가장 먼저, 1~2일)

첫 프로필로 작은 테스트 저장소에서 다음만 확인한다:

1. 작업 트리 밖 쓰기 거부.
2. `.git` 쓰기 거부(commit, reset, ref 변경 시도).
3. 외부 도구면 비활성(web search·MCP 호출 시도가 불가능하거나 거부됨).
4. 실행 후 provider 세션 잔존 파일 없음.
5. **Job containment:** 모델이 실행한 sentinel helper가 자기 PID·생성 시각을 보고하고 장수 자식 프로세스를 만든다. (a) 실행기 본체·helper·자식이 모두 JevCode Job에 속하는지, (b) 취소/timeout과 controller 강제 종료 각각에서 OS 전체 기준으로 sentinel 프로세스가 남지 않는지 확인한다. (셸이 없는 `claude-restricted`는 실행기 본체와 그 자식에 대해 같은 검사를 한다.)

전부 통과해야 A0 실사용을 시작한다. A0도 같은 런처 헬퍼 프로토타입을 사용한다.

### A0. 가치 검증 (A-gate 통과 후, A와 병행)

최소 래퍼: 잠금 없음, snapshot → 실행기 실행 → delta → 검증 명령 → JSON 한 줄 기록 + 간단한 조회. 1~2주 실제 작업에 사용한다.

사전 고정 지표:
- 직접 실행 대비 결과 확인 시간.
- 실패 원인을 기록만으로 재구성할 수 있었던 비율.
- 래퍼를 우회하고 실행기를 직접 쓴 비율.

우회 비율이 높거나 확인 시간이 줄지 않으면 B 착수 전에 흐름을 다시 설계한다.

### A. 호환성 검증

Codex와 Claude Code의 후보 버전을 고정하고 작은 테스트 저장소에서 다음을 확인한다: 읽기 작업, 제한된 수정, 제어 디렉터리 접근 거부, 명령 네트워크 제한, 승인 거부 이벤트, stream 이벤트 형식, 런처 헬퍼 Job 편입과 트리 종료, 협조 종료 경로. 결과를 fixture와 프로필별 capability 보고서로 남긴다.

`codex-win-elevated`가 A-gate를 통과하지 못하면 `claude-restricted`를 첫 프로필로 승격한다(A-gate를 같은 기준으로 통과해야 함). 둘 다 실패하면 A0 실사용과 B를 시작하지 않는다.

### B. MVP 구현

단일 패키지에 CLI, controller, adapter 하나, launcher helper, verification, storage를 구현한다. Mock executor로 실패 경로를 먼저 재현한다.

필수 합격 시나리오:

1. 변경 없는 설명 작업: 정상 종료와 검증 생략, 사용자 검토 필요를 구분한다.
2. 제한된 수정 작업: delta와 필수 검증 결과를 기록한다.
3. 실행기는 완료를 주장하지만 테스트 실패: 검증 실패로 표시한다.
4. 승인 거부 후 종료 코드 0: 작업 성공으로 오인하지 않는다.
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
15. Jev 설정과 네트워크 연결 없이 수동 실행·inspect·review가 동작한다.

### C 이후

두 번째 프로필(`claude-restricted` 또는 A에서 밀린 쪽)로 공통 계약을 검증한다. 연구 트랙 R은 10.0 조건에서만 시작한다.

## 13. 최소 프로젝트 구조

```text
jevcode/
  src/
    cli/
    runtime/
    adapters/
    launcher/      # Job Object 헬퍼 바인딩
    verification/
    storage/
    policy/
  native/          # 런처 헬퍼 (FFI를 쓰지 않을 경우)
  fixtures/
  tests/
  package.json
```

## 14. 구현 전 남은 결정

| 결정 | 현재 기본안 | 확정 시점 |
|---|---|---|
| 첫 프로필 | `codex-win-elevated`, 실패 시 `claude-restricted` | A-gate |
| Codex 외부 도구면 차단 방식 | `exec` + 고정 `-c` 값, 불가 시 `app-server` | A-gate |
| 런처 헬퍼 구현 | 작은 네이티브 exe vs koffi FFI (A-gate에 프로토타입 필요) | A-gate |
| Codex elevated의 Job containment | 미확인. 실패 시 unelevated 또는 `claude-restricted` | A-gate |
| 검증 러너 격리 | `codex sandbox` 래핑 후보 | 단계 A |
| A0 지표의 합격 수치 | A0 시작 전 고정 | A0 시작 |
| SQLite 드라이버와 Node 버전 | `node:sqlite`(RC 상태) vs `better-sqlite3` | 단계 B 시작 |

일정은 A0·A 결과 이후 산정한다.

## 15. 참고

- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing): OS 수준 샌드박스 지원 플랫폼(macOS·Linux·WSL2), 보호 경로.
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference): `--disallowedTools`, `--no-session-persistence`, stream-json.
- [OpenAI Codex Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox): 네이티브 Windows restricted token 샌드박스.
- [Microsoft Job Objects](https://learn.microsoft.com/windows/win32/procthread/job-objects).
- [Node child_process](https://nodejs.org/api/child_process.html): Windows에서의 signal 동작.

- [OpenAI Codex agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security): 명령 네트워크 차단이 외부 도구면에 적용되지 않음.
- [Codex non-interactive mode](https://developers.openai.com/codex/non-interactive-mode): `--ephemeral`.

로컬 확인(2026-09-21): codex-cli 0.155.1에 `codex sandbox`(Windows restricted token), `exec --sandbox`, `exec --ephemeral`, `--ignore-user-config`, `--ignore-rules`, 전역 `-a/--ask-for-approval`, `app-server`(experimental)가 존재하며 `exec --sandbox read-only`가 동작함. Claude Code 2.1.278에 `--restricted`, `--strict-mcp-config`, `--no-session-persistence`, `--disallowedTools`가 존재함. 실제 강제 효과는 A-gate에서 검증한다.
