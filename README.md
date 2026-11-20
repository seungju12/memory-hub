# Memory Hub

여러 AI 어시스턴트(Claude, Claude Code, Antigravity, Gemini, Pickle)가 **나에 대한 정보를 하나의 저장소에서 공유**하도록 만든 개인용 원격 MCP 서버입니다. Cloudflare 무료 티어(Workers + D1 + Vectorize + Workers AI)에서 동작합니다.

- 설계 문서: [docs/architecture.md](docs/architecture.md)
- 현재 단계: **P2** — 하이브리드 검색(Workers AI `bge-m3` 의미 검색 + 한국어 trigram 키워드, RRF 병합), 의미 기반 중복 감지, OAuth 2.1 + GitHub 로그인, 8개 MCP 도구

## MCP 도구

| 도구 | 설명 |
|---|---|
| `get_context` | 대화 시작 시 프로필·중요 기억·최근 기억 로드 |
| `recall` | 하이브리드 검색 — 의미 유사도 + 키워드(한국어 부분 일치, 조사 제거)를 RRF로 병합 |
| `remember` | 기억 저장 — 완전 중복·의미 유사(≥0.7) 후보 반환, 민감 정보 거부 |
| `update_memory` / `forget` | 수정 / 소프트 삭제 (모든 변경은 audit log 기록) |
| `list_memories` | 최근·카테고리별 목록 |
| `get_profile` / `set_profile` | 핵심 프로필 key-value |

## 직접 배포하기

```bash
npm install
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler login
npx wrangler d1 create memory-hub          # 출력된 database_id를 wrangler.jsonc에 입력
npx wrangler kv namespace create OAUTH_KV  # 출력된 id를 wrangler.jsonc의 kv_namespaces에 입력
npx wrangler vectorize create memory-hub --dimensions=1024 --metric=cosine
npx wrangler vectorize create-metadata-index memory-hub --property-name=category --type=string
npm run db:migrate:remote
# wrangler.jsonc의 vars.PUBLIC_BASE_URL을 배포 주소로 수정
```

**GitHub OAuth App** 만들기: GitHub → Settings → Developer settings → OAuth Apps → New
- Homepage URL: `<PUBLIC_BASE_URL>`
- Authorization callback URL: `<PUBLIC_BASE_URL>/callback`

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
gh api user --jq .id | npx wrangler secret put ALLOWED_GITHUB_USER_ID   # 본인 GitHub 숫자 ID
openssl rand -base64 32 | npx wrangler secret put MCP_TOKEN            # 선택: CLI용 Bearer 토큰
npm run deploy
```

로컬 개발: `cp .dev.vars.example .dev.vars && npm run db:migrate:local && npm run dev`
테스트: `npm test` (Workers AI·Vectorize는 원격 전용이라 테스트에서는 메모리 내 가짜 구현을 사용)

클라이언트 연결 방법은 [clients/](clients/)를 참고하세요.

## 데이터와 보안

- 코드는 공개, **데이터는 각자의 Cloudflare 계정 D1에만 저장**됩니다.
- OAuth 2.1(PKCE, DCR/CIMD) — [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider). 클라이언트마다 승인 페이지(프레이밍 금지, 브라우저 바인딩 핸들)를 거친 뒤 GitHub 로그인, **허용된 GitHub 사용자 ID 1개만 통과**합니다.
- GitHub 토큰은 사용자 ID 확인에만 쓰고 저장하지 않습니다. 발급 토큰은 KV에 해시로만 저장됩니다.
- Bearer 토큰 비교는 상수 시간, 토큰 미설정 시 Bearer 경로는 닫힙니다(fail closed).
- API 키·카드번호·주민번호·비밀번호 패턴은 저장을 거부합니다.

## License

MIT
