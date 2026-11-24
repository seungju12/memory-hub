# Pickle 연결 (Notion 경유) — P3.5

Pickle은 MCP를 쓰지 않으므로 Notion을 거친다.

- **읽기**: Memory Hub가 5분마다 `About Me` 페이지를 D1 스냅샷으로 덮어쓴다. 내용이 바뀌지 않았으면 건너뛰고, 하루 1회는 무조건 다시 쓴다.
- **쓰기**: Pickle이 `Memory Inbox` 데이터베이스에 행을 추가하면, Memory Hub가 10분마다 한 번에 3행씩 가져와 `remember`와 같은 경로로 저장한다. 중복 검사와 민감정보 필터를 거치고 `source=pickle`로 기록한다.

## 1. Notion 준비

### 1-1. Integration 만들기
1. <https://www.notion.so/profile/integrations> → **New integration**
2. Type: **Internal**, 워크스페이스 선택
3. Capabilities: **Read content**, **Update content**, **Insert content**만 켠다. 사용자 정보와 댓글 권한은 끈다.
4. **Internal Integration Secret**(`ntn_…`)을 복사한다. 이 값이 `NOTION_TOKEN`이다.

### 1-2. `About Me` 페이지
1. 빈 페이지 `About Me`를 만든다. 내용은 Memory Hub가 채우므로 비워 둔다.
2. 페이지 우측 상단 **⋯ → Connections → 위 integration 추가**
3. 페이지 URL 끝의 32자리 hex가 `NOTION_ABOUT_PAGE_ID`이다.
   `https://www.notion.so/About-Me-0123456789abcdef0123456789abcdef` → `0123456789abcdef0123456789abcdef`

### 1-3. `Memory Inbox` 데이터베이스
전체 페이지 데이터베이스 `Memory Inbox`를 만들고 속성 이름을 **정확히** 아래와 같이 맞춘다.

| 속성 | 타입 | 값 | 누가 쓰나 |
|---|---|---|---|
| `내용` | 제목(Title) | 기억할 사실 한 문장 | Pickle |
| `카테고리` | 선택(Select) | 프로필 / 선호 / 프로젝트 / 결정 / 지식 / 할 일 (비우면 지식) | Pickle (선택) |
| `중요도` | 숫자(Number) | 1~5 (비우면 3) | Pickle (선택) |
| `상태` | 선택(Select) | 대기 / 처리됨 / 중복 / 확인 필요 / 거부 | 비워 두면 Memory Hub가 기록 |
| `처리 결과` | 텍스트(Text) | 저장된 ID나 거부 사유 | Memory Hub |

1. 데이터베이스 **⋯ → Connections → integration 추가**
2. 데이터베이스 **⋯ → Manage data sources → Copy data source ID**로 복사한 값이 `NOTION_INBOX_DATA_SOURCE_ID`이다. 데이터베이스 ID와는 다른 값이다.

`상태`가 비어 있거나 `대기`인 행만 처리한다.

| 결과 | 뜻 | 할 일 |
|---|---|---|
| 처리됨 | D1에 저장됨 | 없음 |
| 중복 | 같은 기억이 이미 있음 | 없음 |
| 확인 필요 | 의미가 비슷한 기억이 있어 저장을 보류함 | 다른 사실이면 Claude에서 저장 |
| 거부 | 비어 있거나 민감정보로 판단됨 | 민감정보라면 Notion에서 행을 직접 삭제 |

## 2. Worker에 secret 등록

```bash
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put NOTION_ABOUT_PAGE_ID
npx wrangler secret put NOTION_INBOX_DATA_SOURCE_ID
```

```bash
npm run db:migrate:remote && npm run deploy
```

5분 안에 `About Me` 페이지가 채워진다. 동기화 상태는 아래 명령으로 확인한다.

```bash
npx wrangler d1 execute memory-hub --remote --command "SELECT * FROM bridge_state"
```

## 3. Pickle 설정

Pickle → **Connections → Notion** 연결 시 `About Me` 페이지와 `Memory Inbox` 데이터베이스에 접근을 허용한다.

Pickle 지침(Custom instructions)에 붙여 넣을 규칙:

```markdown
## Memory Hub (Notion)
- 대화를 시작할 때 Notion의 "About Me" 페이지를 읽고 나에 대한 정보로 사용한다. 이 페이지는 직접 수정하지 않는다.
- 내 선호·결정·진행 중 프로젝트·새 사실을 알게 되면 Notion "Memory Inbox" 데이터베이스에 행을 추가한다.
  - 내용: 나를 3인칭으로 쓴 한 문장 (예: "주말마다 등산을 간다.")
  - 카테고리: 프로필 / 선호 / 프로젝트 / 결정 / 지식 / 할 일 중 하나
  - 중요도: 1~5 (기본 3)
  - 상태: 비워 둔다
- 일회성 잡담, 비밀번호·API 키·주민번호 같은 민감 정보는 기록하지 않는다.
```
