# Memory Hub

여러 AI 어시스턴트(Claude, Claude Code, Antigravity, Gemini, Pickle)가 **나에 대한 정보를 하나의 저장소에서 공유**하도록 만든 개인용 원격 MCP 서버입니다. Cloudflare 무료 티어(Workers + D1)에서 동작합니다.

- 설계 문서: [docs/architecture.md](docs/architecture.md)
- 현재 단계: **P0** — Bearer 토큰 인증, 키워드 검색(한국어 trigram), 8개 MCP 도구

## MCP 도구

| 도구 | 설명 |
|---|---|
| `get_context` | 대화 시작 시 프로필·중요 기억·최근 기억 로드 |
| `recall` | 키워드 검색 (한국어 부분 일치, 조사 제거) |
| `remember` | 기억 저장 (중복 감지, 민감 정보 거부) |
| `update_memory` / `forget` | 수정 / 소프트 삭제 (모든 변경은 audit log 기록) |
| `list_memories` | 최근·카테고리별 목록 |
| `get_profile` / `set_profile` | 핵심 프로필 key-value |

## 직접 배포하기

```bash
npm install
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler login
npx wrangler d1 create memory-hub          # 출력된 database_id를 wrangler.jsonc에 입력
npm run db:migrate:remote
openssl rand -base64 32 | npx wrangler secret put MCP_TOKEN
npm run deploy
```

로컬 개발: `cp .dev.vars.example .dev.vars && npm run db:migrate:local && npm run dev`
테스트: `npm test`

클라이언트 연결 방법은 [clients/](clients/)를 참고하세요.

## 데이터와 보안

- 코드는 공개, **데이터는 각자의 Cloudflare 계정 D1에만 저장**됩니다.
- 토큰 비교는 상수 시간, 토큰 미설정 시 서버는 모든 요청을 거부합니다(fail closed).
- API 키·카드번호·주민번호·비밀번호 패턴은 저장을 거부합니다.

## License

MIT
