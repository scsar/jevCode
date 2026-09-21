# JevCode

기존 코딩 에이전트(Codex, Claude Code)를 격리된 프로필로 실행하고, 실행 기록과 검증 결과를 한곳에서 확인하며, 실행 결과에 대한 판단을 빠른 타입 판단 모델(TypeSafe Jev)에 묻는 개인용 로컬 CLI.

- 현재 설계: [docs/design/JevCode_System_Design_v0.5.md](docs/design/JevCode_System_Design_v0.5.md)
- 변경 근거: [v0.5 changelog](docs/design/JevCode_v0.5_changelog.md), [v0.4 changelog](docs/design/JevCode_v0.4_changelog.md), [v0.3 changelog](docs/design/JevCode_v0.3_changelog.md)

## 현재 단계

**A0 (가치 검증, 2026-09-22 ~ 10-05)** — `codex-win-unelevated`로 실행하고 `jevcode` 래퍼로 기록한다. 실행마다 판단 계층(규칙 기준선, Jev)이 shadow 판단을 남긴다. Jev API 키는 발급 대기 중이며, 발급 후 `jevcode decide --all --provider jev`로 소급 질의한다. 사용법은 [a0/](a0/README.md), 격리 검증은 [spikes/a-gate](spikes/a-gate/README.md).

실험 대상 저장소는 이 저장소 안이 아니라 매번 새로 만드는 일회용 디렉터리를 쓴다.
