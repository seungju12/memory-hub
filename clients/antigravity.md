# Antigravity 연결 — P3

## MCP 서버

Antigravity → **Agent 패널 ⋯ → MCP Servers → Manage MCP Servers → View raw config**로 `mcp_config.json`을 연다.
(전역 설정: `~/.gemini/config/mcp_config.json`. Antigravity는 Windows 앱이라 WSL 원격으로 써도 **Windows 홈** 기준 → `%USERPROFILE%\.gemini\config\mcp_config.json`)

```json
{
  "mcpServers": {
    "memory-hub": {
      "url": "https://<PUBLIC_BASE_URL>/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

- 원격(Streamable HTTP) 서버는 `url` 키를 쓴다 (예전 키 `serverUrl`도 허용). `headers`로 Bearer 토큰 전달 가능.
- Bearer 토큰 방식이라 `source`가 자동 기록되지 않는다 → 아래 규칙에서 `source="antigravity"`를 지정한다.
- 저장 후 MCP Servers 화면에서 **Refresh** → 도구 8개가 보이면 연결 완료.

## 규칙

Antigravity → **Customizations → Rules → Global**(Windows 홈의 `%USERPROFILE%\.gemini\GEMINI.md`)에 [`rules.md`](rules.md) 내용을 붙여 넣고, `<client>`를 `antigravity`로 바꾼다.
