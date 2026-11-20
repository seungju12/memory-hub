# Gemini → Memory Hub 초기 데이터 이전 (P2.5)

대화 원문은 서버에 올리지 않습니다. 로컬에서 사실만 뽑고, 사람이 검토한 항목만 저장합니다.
모든 입력·중간 산출물은 `data/`(gitignore)에 둡니다. 입력은 신뢰할 수 없는 데이터라 `python3 -I`로 실행합니다.

1. Takeout: `내 활동 → Gemini 앱`(활동 기록 형식 JSON) + `Gemini`(Gem 등) → `data/Takeout/`에 압축 해제
2. 대화 단위로 묶기
   ```bash
   python3 -I scripts/import-gemini/parse.py "data/Takeout/내 활동/Gemini 앱/내활동.json" data/work
   ```
3. 나에 대한 정보가 담겼을 만한 질문만 추리기 (1인칭·생활·업무 키워드, 로그·코드 붙여넣기 제외)
   ```bash
   python3 -I scripts/import-gemini/filter.py data/work/conversations.jsonl data/work/self-prompts.md
   ```
4. Claude Code가 `self-prompts.md` + Gemini "저장된 정보"를 읽고 후보 기억을 `data/review.md`로 작성
   (민감 정보·제3자 정보는 기본 체크 해제)
5. 사람이 `data/review.md`에서 체크·수정
6. import (기본은 dry run)
   ```bash
   python3 -I scripts/import-gemini/import_review.py data/review.md
   MCP_TOKEN=... python3 -I scripts/import-gemini/import_review.py data/review.md --apply --url https://<worker>/mcp
   ```
   `source=import:gemini-takeout`으로 저장되어 나중에 출처별로 찾거나 되돌릴 수 있습니다.
   의미상 비슷한 기억이 이미 있으면(`similar`) 강제로 저장하지 않고 목록으로 보여 줍니다.
