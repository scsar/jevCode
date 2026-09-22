# Spike: Claude Code inside the Codex sandbox (2026-09-23)

**질문:** Claude run에 OS 격리와 셸(테스트 실행)을 함께 줄 수 있는가? `codex sandbox`(로컬 격리 도구, Codex 한도와 무관)로 `claude -p`를 감싸는 방식을 확인한다.

**결론: 안 된다.** 샌드박스 안에서 Claude는 실행되지만 **셸 도구가 동작하지 않는다.** Node가 자식 프로세스를 띄우지 못한다(EPERM). 얻는 것은 Claude 자신의 파일 쓰기에 대한 OS 수준 제한뿐이고, 그건 `--restricted`가 앱 수준에서 이미 한다. 그래서 A0 기간에는 지금 방식(파일 도구만, 검증은 run 뒤 Codex 샌드박스)을 유지한다.

## 환경

- Windows 11, codex-cli 0.155.1, Claude Code 2.1.280, 비관리자(unelevated) 샌드박스
- 프로필: `jevcode-run` = `:workspace` + `:tmpdir` 읽기 + run 임시 폴더 쓰기 (a0/jevcode.mjs와 동일)

## 결과

| # | 확인 | 결과 |
|---|---|---|
| C1 | 샌드박스 밖(`%USERPROFILE%`) 쓰기 | **차단** (기대대로) |
| C2 | 네트워크 (기본) | **차단.** 샌드박스가 `HTTP_PROXY`·`HTTPS_PROXY`·`ALL_PROXY` 등을 `http://127.0.0.1:9`로 주입한다. 방화벽이 아니라 환경 변수 방식이라, 변수를 무시하는 클라이언트는 나갈 수 있다 |
| C3 | 네트워크 (프록시 변수 제거 후) | **통함** |
| C4 | Windows TLS(`curl.exe`, schannel) | 실패: `SEC_E_NO_CREDENTIALS`. 제한 토큰이 자격 증명 저장소에 접근하지 못한다. Node(OpenSSL)는 영향 없음 |
| C5 | `~/.claude` 읽기 / 쓰기 | 읽기 가능 / **쓰기 차단** |
| C6 | 샌드박스 안에서 `claude -p` 실행 | **성공** (`claude-opus-5-5`, 결과 "OK", 약 0.013달러) |
| C7 | Claude의 Bash 도구 | **실패**: `EPERM: operation not permitted, uv_spawn ...bash.exe` |
| C8 | 원인 좁히기 | 샌드박스 안에서 `cmd`가 `cmd`를 띄우는 것은 됨. **Node에서 `cmd`·`bash`·`powershell`을 띄우면 모두 EPERM.** 즉 Node 프로세스의 자식 생성이 막힌다 |

## 함의

- Claude에게 테스트 실행을 주려면 이 경로로는 안 된다. Node가 자식 프로세스를 띄울 수 있는 격리가 필요하다(자체 격리 방식, v0.6 후보).
- 네트워크 차단이 환경 변수 방식이라는 점은 Codex run에도 해당한다. 샌드박스 안의 명령이 프록시 변수를 지우면 외부로 나갈 수 있다. A-gate가 남긴 "로컬 서버가 격리되지 않는다"는 빈틈과 같은 성격이며, 설계 5.5의 빈틈 목록에 함께 둔다.
- 대안은 검증 실패 내용을 다음 run에 넘기는 방식(설계 7장, 인계와 같은 성격이라 평가에서 따로 봐야 함)이다.

## 재현

```powershell
# C6: 샌드박스 안에서 Claude 실행 (프록시 변수를 비우고, 임시 폴더를 run 폴더로)
codex sandbox -c "permissions={jevcode-run={extends=':workspace',filesystem={':tmpdir'='read','<runtemp>'='write'}}}" `
  -c "windows.sandbox=unelevated" -P jevcode-run -C <repo> -- `
  cmd.exe /c "set HTTP_PROXY=&set HTTPS_PROXY=&set ALL_PROXY=&claude -p --output-format stream-json --verbose --restricted --tools Read --strict-mcp-config --no-session-persistence --disable-slash-commands < prompt.txt"

# C8: Node의 자식 프로세스 생성 (node t2.js에서 cmd/bash/powershell 실행 → 모두 EPERM)
codex sandbox -c "..." -P jevcode-run -C <repo> -- node t2.js
```
