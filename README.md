# JevCode

기존 코딩 에이전트(Codex, Claude Code)를 격리된 프로필로 실행하고, 실행 기록과 검증 결과를 한곳에서 확인하는 개인용 로컬 CLI.

- 현재 설계: [docs/design/JevCode_System_Design_v0.4.md](docs/design/JevCode_System_Design_v0.4.md)
- 변경 근거: [v0.4 changelog](docs/design/JevCode_v0.4_changelog.md), [v0.3 changelog](docs/design/JevCode_v0.3_changelog.md)

## 현재 단계

**A0 (가치 검증) 진행 중** — A-gate 2차(PASS-WITH-GAPS) 뒤 G1.4 빈틈을 수용하고 `codex-win-unelevated`로 시작했다. 최소 래퍼와 사용법은 [a0/](a0/README.md), 격리 검증은 [spikes/a-gate](spikes/a-gate/README.md).

실험 대상 저장소는 이 저장소 안이 아니라 매번 새로 만드는 일회용 디렉터리를 쓴다.
