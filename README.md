# JevCode

기존 코딩 에이전트(Codex, Claude Code)를 격리된 프로필로 실행하고, 실행 기록과 검증 결과를 한곳에서 확인하는 개인용 로컬 CLI.

- 현재 설계: [docs/design/JevCode_System_Design_v0.4.md](docs/design/JevCode_System_Design_v0.4.md)
- 변경 근거: [v0.4 changelog](docs/design/JevCode_v0.4_changelog.md), [v0.3 changelog](docs/design/JevCode_v0.3_changelog.md)

## 현재 단계

**A-gate 2차 완료 (PASS-WITH-GAPS)** — `codex-win-unelevated` + `jevcode-run` 프로필이 제어 디렉터리 읽기 차단(G1.4, elevated 전용)을 제외하고 통과했다. 다음은 그 빈틈을 수용하고 A0를 시작할지, elevated를 설치해 검사할지 결정하는 것이다(설계 v0.4 14절). 실험 도구와 결과는 [spikes/a-gate](spikes/a-gate/README.md).

실험 대상 저장소는 이 저장소 안이 아니라 매번 새로 만드는 일회용 디렉터리를 쓴다.
