# JevCode v0.3 → v0.4 변경 로그

**근거:** A-gate 1차 실험(`spikes/a-gate`, codex-cli 0.155.1, unelevated)과 인계 효용 검토.  
**Date:** 2026-09-21

## A-gate 발견에서 나온 변경

| # | 발견 | 변경 | 절 |
|---|---|---|---|
| 1 | unelevated가 A-gate 전 항목 통과 | A0를 unelevated로 시작. elevated는 설치 후 별도 검사, 통과 시 전환 | 1.1, 5.1 |
| 2 | `:workspace`가 실제 `%TEMP%` 쓰기 허용 | 커스텀 프로필 `jevcode-run`(`:tmpdir` deny + 실행별 temp) | 5.2 |
| 3 | `:workspace`가 작업 트리 밖 읽기를 넓게 허용(추정). 제어 디렉터리 읽기 거부가 강제되지 않음 | `jevcode-run`에서 제어 디렉터리 deny. A-gate G1.4 추가 | 5.2, 12 |
| 4 | `apply_patch` 밖 쓰기 거부는 Codex 앱 내부 검사 | capability마다 강제 주체(os / app / observed) 표기. `approval_policy=never` 고정 | 5.3 |
| 5 | hermetic 설정 뒤에도 `spawn_agent`, `request_plugin_install`, `image_gen`, MCP 리소스 도구가 남음 | 남은 도구면 목록과 B 전 처리 요구 | 5.4, 12.A |
| 6 | 거부된 `apply_patch`가 JSONL 이벤트에 없고 stderr에만 기록됨 | 어댑터가 stderr 거부 로그를 `approval_denied`로 정규화. 시나리오 4 강화 | 7, 12.B |
| 7 | 거부된 쓰기도 exit 0 | 판정은 파일·프로세스 상태로만 한다는 원칙 명시 | 1.2 |
| 8 | JobLauncher 프로토타입이 취소·강제 종료·모델 실행 경로 모두에서 containment 확보, WMI 탈출 차단 | 런처 헬퍼를 C# exe(기본 `csc.exe`)로 확정 | 6.3, 14 |
| 9 | `codex sandbox -P`로 임의 명령 격리 동작 확인 | 검증 러너 격리 방식 확정 | 8, 14 |
| 10 | `--ephemeral` + `sqlite_home`/`log_dir` 재지정 뒤 흔적 없음 | Codex hermetic 고정 인자 확정 | 5.4, 5.6 |
| 11 | unelevated 샌드박스 프로세스가 사용자 본인 계정으로 실행 | elevated는 Job containment 별도 검사 명시 | 5.1, 6.3 |

## 인계 검토에서 나온 변경

| # | 변경 | 절 |
|---|---|---|
| 12 | 가치 가설에 "작업 연속성" 추가. 토큰 절약은 부수 효과로만 측정 | 1 |
| 13 | `executionOutcome`에 `quota_exhausted` 추가. 검증된 신호로만 판정 | 6.2 |
| 14 | 토큰 사용량 기록(`token_usage` 이벤트, attempt 합계) | 7, 9 |
| 15 | `quota_exhausted` 실행의 원시 기록 보존 | 5.6 |
| 16 | A0에 전환 비용 실험(콜드 대 브리프) 추가, A-gate 실측 토큰을 기준선으로 기록 | 12.A0 |
| 17 | 인계를 F에서 조건부 단계 H로 이동. 브리프는 모델 호출 없이 관측 기록에서 생성, 제어 디렉터리에 저장 | 2, 11 |
| 18 | 공용 프로젝트 지식은 `AGENTS.md`(+ `CLAUDE.md`의 `@AGENTS.md`), 사용자 리뷰 후 커밋. 실행기 노트는 provider 주장 | 5.6, 11.3 |
| 19 | 시나리오 15(한도 소진 fixture) 추가 | 12.B |

## 보류

| 항목 | 이유 |
|---|---|
| `jevcode handoff` 구현 | A0 전환 비용 실험 결과를 보고 결정(11.4) |
| 작업 스케줄러 등 WMI 외 Job 탈출 경로 | 개인용 MVP에서 수용, A 후보로 유지 |
| `codex app-server` 비교 | 남은 도구면을 CLI로 처리하지 못할 때만 |
