# Claude Code 연결 (P0: Bearer 토큰)

```bash
claude mcp add --transport http --scope user memory-hub https://<worker>.workers.dev/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
```

`~/.claude/CLAUDE.md`에 공통 규칙(`clients/rules.md`)을 붙여 넣는다.
