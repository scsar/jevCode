# JevCode

기존 코딩 에이전트(Codex, Claude Code)를 격리된 프로필로 실행하고, 실행 기록과 검증 결과를 한곳에서 확인하는 개인용 로컬 CLI.

- 현재 설계: [docs/design/JevCode_System_Design_v0.4.md](docs/design/JevCode_System_Design_v0.4.md)
- 변경 근거: [v0.4 changelog](docs/design/JevCode_v0.4_changelog.md), [v0.3 changelog](docs/design/JevCode_v0.3_changelog.md)

## 현재 단계

**A-gate 2차 (안전 스모크 게이트)** — 설계 12절 참고. 1차에서 `codex-win-unelevated`가 통과했고, v0.4에서 추가한 `jevcode-run` 프로필 항목(G1.3–G1.5)을 통과하면 A0 실사용을 시작한다. 실험 도구와 결과는 [spikes/a-gate](spikes/a-gate/README.md).

실험 대상 저장소는 이 저장소 안이 아니라 매번 새로 만드는 일회용 디렉터리를 쓴다.
