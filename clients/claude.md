# Claude (claude.ai / 데스크톱 / 모바일) 연결 — P1: OAuth

1. claude.ai → **Settings → Connectors → Add custom connector**
2. URL: `https://<PUBLIC_BASE_URL>/mcp` (예: `https://memory-hub.<subdomain>.workers.dev/mcp`)
3. **Connect** → Memory Hub 승인 페이지에서 앱 이름과 "권한을 받을 곳(claude.ai)"을 확인하고 **허용**
4. GitHub 로그인 → `ALLOWED_GITHUB_USER_ID` 계정만 통과
5. 데스크톱·모바일 앱은 같은 계정이면 커넥터가 자동으로 공유된다

규칙: 사용자 Preferences에 [`rules.md`](rules.md) 내용을 붙여 넣는다.

> 기억의 `source`는 OAuth 클라이언트 이름(예: `claude`)으로 자동 기록된다. 도구 호출에 `source`를 명시하면 그 값이 우선한다.
