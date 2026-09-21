# JevCode

기존 코딩 에이전트(Codex, Claude Code)를 격리된 프로필로 실행하고, 실행 기록과 검증 결과를 한곳에서 확인하는 개인용 로컬 CLI.

- 현재 설계: [docs/design/JevCode_System_Design_v0.3.md](docs/design/JevCode_System_Design_v0.3.md)
- 변경 근거: [docs/design/JevCode_v0.3_changelog.md](docs/design/JevCode_v0.3_changelog.md)

## 현재 단계

**A-gate (안전 스모크 게이트)** — 설계 12절 참고. 통과 전에는 실제 작업에 실행기를 쓰지 않는다.

실험 대상 저장소는 이 저장소 안이 아니라 매번 새로 만드는 일회용 디렉터리를 쓴다.
