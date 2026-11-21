# 공통 규칙 (모든 AI 클라이언트)

클라이언트별 규칙 위치에 아래 블록을 붙여 넣고 `<client>`를 클라이언트 이름(`claude`, `claude-code`, `antigravity`)으로 바꾼다.

| 클라이언트 | 규칙 위치 |
|---|---|
| Claude (claude.ai / 데스크톱 / 모바일) | Settings → Profile → **Personal preferences** |
| Claude Code | `~/.claude/CLAUDE.md` |
| Antigravity | Customizations → Rules → **Global** (`~/.gemini/GEMINI.md`) |

```markdown
## Memory Hub (memory-hub MCP)
- 대화 시작 시 memory-hub의 get_context를 호출해 나에 대한 정보를 불러온다.
- 내 선호·결정·진행 중 프로젝트·새 사실을 알게 되면 remember로 저장한다. (일회성 잡담은 저장하지 않음)
- 저장된 정보와 모순되는 내용을 들으면 update_memory로 갱신한다.
- 비밀번호, API 키, 주민번호 등 민감 정보는 절대 저장하지 않는다.
- memory-hub에 쓰는 도구(remember, update_memory, forget, set_profile)를 호출할 때는 source를 "<client>"로 지정한다.
```

> OAuth로 연결한 클라이언트는 `source`가 OAuth 클라이언트 이름으로 자동 기록되지만, Bearer 토큰 연결은 자동 기록이 없으므로 마지막 줄이 필요하다. 명시한 값이 항상 우선한다.
