# JevCode v0.4 → v0.5 변경 로그

**Date:** 2026-09-21

## 배경

v0.2는 Jev를 MVP 의존성에서 빼고 후속 shadow 실험으로 두었다. v0.3과 v0.4의 교차 리뷰는 Jev를 다시 조건부 연구 트랙(R)으로 미뤘다. 착수 조건은 "C 이후 실행기 선택 손실이 관측될 때"였다. 그 결과 이름이 JevCode인 제품에서 Jev가 사실상 빠졌다.

사용자가 제품의 전제를 확인했다. 목적은 공개된 판단 모델(Jev)을 코딩 에이전트 운영에 쓰는 것이고, **API가 사라지더라도 방법 자체가 유효함을 검증**하는 것이다. v0.5는 이 전제에 맞춰 Jev를 판단 계층으로 되돌리되, 실행 흐름에는 영향을 주지 않는 shadow로 시작한다.

## 변경

| # | 변경 | 절 |
|---|---|---|
| 1 | 가설 3 "판단 계층(방법 검증)" 추가. 판단은 빠른 타입 판단 모델에 묻고, 첫 모델은 Jev | 1 |
| 2 | 단계 R(조건부 연구)을 폐지하고 A0부터 shadow 기록. 흐름 반영은 단계 J(승격)로 분리 | 2, 10.3 |
| 3 | 판단 제공자 인터페이스와 `rules` 기준선. 같은 질문 세트(v1)와 같은 제한 상태로 비교 | 10.1 |
| 4 | 질문 세트 v1: `review_priority`(Score), `completion`(Noul), `failure_cause`(Choice 7). `next_executor`는 단계 C에서 v2로 추가 | 10.1 |
| 5 | 제한 상태 정의와 저장. 키가 없는 기간에도 저장해 두고 `jevcode decide`로 소급 질의 | 10.1 |
| 6 | A0 평가 기준 E1–E4 사전 고정. 검증이 없는 실행(`skipped`)을 따로 분석 | 10.2 |
| 7 | `review --cause`로 실패 원인 정답 라벨 수집 | 4, 10.2 |
| 8 | A0 래퍼 명령 `jev` → `jevcode` (모델 이름과 혼동 방지) | 1.1, 5.4, 12.A0 |
| 9 | 판단 계층 평가는 J 승격만 결정하고 B 착수에는 영향 없음 | 12.A0 |

## 확인한 사실

- Jev API: `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer`, 요청은 `state` + `questions`(noul / choice / score), 응답은 질문별 답 + `probabilities` + `confidence` ([Quick start](https://docs.typesafe.ai/introduction/quickstart)).
- 가짜 키로 호출하면 실제 엔드포인트가 `401 authentication_error`를 반환한다. 이 오류는 `decisions.jsonl`에 기록되고 실행에는 영향이 없다.
- choice와 score의 `criteria` 형식(객체 / 배열)은 문서 예시에서 추정한 것이었다. 2026-09-22 실제 키로 첫 호출해 그대로 동작함을 확인했다(`jev-1.13.0`).
