# Claude Code 연결

## 방법 A — OAuth (권장, P1)

```bash
claude mcp add --transport http --scope user memory-hub https://<PUBLIC_BASE_URL>/mcp
```

Claude Code에서 `/mcp` → memory-hub → **Authenticate** 를 누르면 브라우저에서 승인 페이지 → GitHub 로그인이 진행된다.
(승인 페이지에 "내 컴퓨터의 앱으로 권한이 전달됩니다" 경고가 뜨는 것은 정상 — 리디렉트가 localhost이기 때문)

## 방법 B — Bearer 토큰 (CLI 대안, P0 호환)

```bash
claude mcp add --transport http --scope user memory-hub https://<PUBLIC_BASE_URL>/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
```

`MCP_TOKEN` secret을 지우면 이 경로는 닫힌다(OAuth만 허용).

`~/.claude/CLAUDE.md`에 공통 규칙(`clients/rules.md`)을 붙여 넣는다.
