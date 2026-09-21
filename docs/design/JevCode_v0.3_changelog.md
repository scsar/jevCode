# JevCode v0.2 → v0.3 변경 로그

**방식:** Claude(1차 비판) ↔ Codex CLI 0.155.1(`codex exec --sandbox read-only --ephemeral`) 3라운드 교차 리뷰. 반영 규칙은 "결정을 바꾸는 지적만"이었고, Codex가 인용한 CLI 사실은 모두 로컬 help로 재확인했다.  
**Date:** 2026-09-21

## 반영한 결정 변경

| # | 출처 | 변경 | 절 |
|---|---|---|---|
| 1 | Claude R0 → Codex R1 보정 | 플랫폼을 네이티브 Windows로 확정. Claude Code의 OS 샌드박스는 네이티브 Windows를 지원하지 않음 | 1.1, 5.1 |
| 2 | Codex R1 | 첫 어댑터를 Claude Code에서 Codex로 변경(네이티브 Windows 샌드박스 보유) | 1.1, 5.1, 14 |
| 3 | Codex R2 | Codex 프로필을 `elevated`와 `unelevated`로 분리하고 elevated를 첫 프로필로 지정 | 5.1 |
| 4 | Codex R2 (로컬 확인) | Claude 프로필을 "Bash 끄기"에서 `--restricted --strict-mcp-config`로 강화(PowerShell·REPL·WebFetch·MCP 제거, 파일 도구 경로 제한) | 5.1 |
| 5 | Codex R2 | hermetic 실행: 사용자 설정·rules를 무시하고 외부 도구면(web search, MCP, connectors, browser)을 끔. 명령 네트워크 차단은 이 도구면을 막지 못함 | 5.1 |
| 6 | Codex R1 | Git 메타데이터를 불변 경계로 지정하고 HEAD·refs·index checksum을 비교. `policyStatus` 결과 필드 추가 | 5.2, 6.2 |
| 7 | Codex R1 | 제어 디렉터리(DB·lock·증거)를 workspace 밖으로 옮기고 실행기 접근을 거부 | 3, 5.2, 9 |
| 8 | Codex R1·R2 | 원시 기록 소유자를 JevCode로 일원화: provider 세션 저장 끄기(`--no-session-persistence`, `--ephemeral`), 실패 실행만 보존. 잔존 파일로 검증 | 5.3 |
| 9 | Claude R0 | dirty tree 허용: 임시 index snapshot 대비 전체 delta 기록 | 6.1 |
| 10 | Claude R0 + Codex R1 보정 | Job Object 런처 헬퍼(suspended 생성 → 편입 → resume, KILL_ON_JOB_CLOSE). Windows SIGTERM 가정 제거 | 6.3 |
| 11 | Codex R3 (Claude 의심 제기) | Job containment를 프로필 capability로 지정. elevated 샌드박스 명령이 Job 밖으로 빠질 수 있으므로 sentinel 프로세스로 검증 | 6.3, 12 |
| 12 | Claude R0 + Codex R1 | 가치 검증 단계 A0 신설(최소 래퍼 1~2주, 사전 지표) | 2, 12 |
| 13 | Codex R2 | 안전 스모크 게이트 A-gate를 A0보다 앞에 둠: 검증 안 된 프로필로 실제 작업 금지 | 2, 12 |
| 14 | Claude R0 + Codex R1 | Jev D/E를 조건부 연구 트랙 R로 강등하고 시작 조건 명시 | 2, 10 |
| 15 | Codex R1 | 잠금 키를 대소문자 변환이 아닌 realpath + dev/ino로 생성 | 6.1 |
| 16 | 라운드 산출 | 합격 시나리오 추가: Git 메타데이터 변경(12), 제어 디렉터리 접근(13), 전역 설정의 외부 도구(14). 시나리오 6·8 기준을 sentinel 프로세스 부재로 변경 | 12.B |

## 철회·기각·보류

| 항목 | 처리 | 이유 |
|---|---|---|
| Claude R0: "permissions deny는 Read/Edit에만 적용" | 철회 | `disallowedTools`는 도구 자체를 거부할 수 있음(Codex 지적). 결론은 유지 |
| Claude R0: 잠금 경로 소문자 정규화 | 철회 | NTFS 디렉터리별 case-sensitive 모드에서 충돌 가능 |
| Claude R0: `node:sqlite` 즉시 채택 | 보류 | 아직 RC 상태이고 Node 최소 버전이 올라감. 단계 B 시작 시 결정 |
| Claude R0: Agent SDK 어댑터 | 보류 | OS 격리를 대신하지 못하고, 첫 어댑터가 Codex로 바뀌어 우선순위 하락 |
| `.git` 읽기 거부 (v0.3 초안) | 수정 | 실행기의 `git status`/`log`를 막음. 쓰기 거부로 축소 |
| `codex app-server` 첫 어댑터화 | 조건부 | CLI로 외부 도구면 차단을 증명하지 못할 때만 비교 |

## 수렴 판정

Codex R3의 최종 판정: Job containment 검사를 A-gate 필수 항목으로 넣으면 문서 리뷰를 멈추고 A-gate 실험으로 넘어가도 된다. 반영 완료.

**남은 미확인 사항은 모두 실험으로만 풀리는 것이다:** elevated 샌드박스의 Job 귀속, 외부 도구면 차단 가능 여부, 세션 잔존 파일, 명령 네트워크 차단 효과.
